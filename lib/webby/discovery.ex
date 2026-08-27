defmodule Webby.Discovery do
  @moduledoc "Sanitized, local observations of unregistered WebMCP catalogs."

  import Ecto.Query
  alias Webby.Discovery.Discovery
  alias Webby.{Pages, Repo}

  @max_tools 64
  @max_description_bytes 1_000
  @max_title_bytes 200
  @max_schema_bytes 32_768
  @max_schema_depth 16
  @max_schema_nodes 2_048

  def list_discoveries do
    Repo.all(
      from d in Discovery, where: d.state == "discovered", order_by: [desc: d.last_seen_at]
    )
  end

  def get_discovery(id), do: Repo.get(Discovery, id)

  def list_ignored_origins(browser_id) do
    Repo.all(
      from d in Discovery,
        where: d.browser_id == ^browser_id and d.state == "ignored",
        group_by: d.origin,
        select: d.origin,
        order_by: d.origin
    )
  end

  def ignore(id) do
    case Repo.get(Discovery, id) do
      %Discovery{state: "discovered"} = discovery ->
        now = DateTime.utc_now() |> DateTime.truncate(:second)

        Repo.update_all(
          from(d in Discovery,
            where:
              d.browser_id == ^discovery.browser_id and d.origin == ^discovery.origin and
                d.state == "discovered"
          ),
          set: [state: "ignored", updated_at: now]
        )

        {:ok, %{browser_id: discovery.browser_id, origin: discovery.origin}}

      nil ->
        {:error, :not_found}

      _discovery ->
        {:error, :invalid_state}
    end
  end

  def observe(browser_id, attrs) do
    with {:ok, prepared} <- prepare_observation(attrs) do
      persist_observation(browser_id, prepared)
    end
  end

  def observe_many(browser_id, observations)
      when is_list(observations) and length(observations) <= 128 do
    with {:ok, prepared} <- prepare_many(observations) do
      transaction_with_cancellations(fn ->
        observed = Enum.map(prepared, &persist_or_rollback(browser_id, &1, :deferred))
        {Enum.map(observed, &elem(&1, 0)), Enum.flat_map(observed, &elem(&1, 1))}
      end)
    end
  end

  def observe_many(_browser_id, _observations), do: {:error, :invalid_observations}

  def resync(browser_id, observations) when is_list(observations) do
    with {:ok, prepared} <- prepare_many(observations) do
      transaction_with_cancellations(fn ->
        observed = Enum.map(prepared, &persist_or_rollback(browser_id, &1, :deferred))
        records = Enum.map(observed, &elem(&1, 0))
        cancellations = Enum.flat_map(observed, &elem(&1, 1))

        {:ok, {_closed_count, reconcile_cancellations}} =
          Pages.reconcile_deferred(browser_id, records)

        {records, cancellations ++ reconcile_cancellations}
      end)
    end
  end

  def resync(_browser_id, _observations), do: {:error, :invalid_observations}

  def sanitize_url(url) when is_binary(url) do
    with %URI{scheme: scheme, host: host} = uri
         when scheme in ["http", "https"] and is_binary(host) <-
           URI.parse(url),
         {:ok, host} <- normalize_host(host),
         {:ok, port} <- normalized_port(scheme, uri.port) do
      authority = host <> port
      path = normalize_path(uri.path)

      if byte_size(path) <= 2_048 and not String.contains?(path, ["\n", "\r", "\\"]) do
        {:ok, %{origin: scheme <> "://" <> authority, sanitized_path: path}}
      else
        {:error, :invalid_page_url}
      end
    else
      _ -> {:error, :invalid_page_url}
    end
  end

  def sanitize_url(_url), do: {:error, :invalid_page_url}

  def fingerprint(catalog) when is_list(catalog) do
    {:ok,
     catalog
     |> canonicalize()
     |> :erlang.term_to_binary()
     |> then(&:crypto.hash(:sha256, &1))
     |> Base.encode16(case: :lower)}
  end

  defp sanitize_page(%{"url" => url} = attrs) do
    with {:ok, identity} <- sanitize_url(url) do
      title = attrs |> Map.get("title", "Untitled page") |> sanitize_string(200)
      {:ok, Map.put(identity, :page_title, title)}
    end
  end

  defp sanitize_page(_attrs), do: {:error, :invalid_page_url}

  defp prepare_observation(attrs) do
    with {:ok, page} <- sanitize_page(attrs),
         {:ok, catalog} <- sanitize_catalog(attrs["tools"]),
         {:ok, fingerprint} <- fingerprint(catalog) do
      {:ok, %{attrs: attrs, page: page, catalog: catalog, fingerprint: fingerprint}}
    end
  end

  defp prepare_many(observations) when length(observations) <= 128 do
    Enum.reduce_while(observations, {:ok, []}, fn attrs, {:ok, prepared} ->
      case prepare_observation(attrs) do
        {:ok, observation} -> {:cont, {:ok, [observation | prepared]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, prepared} -> {:ok, Enum.reverse(prepared)}
      error -> error
    end
  end

  defp prepare_many(_observations), do: {:error, :invalid_observations}

  defp transaction_with_cancellations(callback) do
    case Repo.transaction(callback) do
      {:ok, {records, cancellations}} ->
        Pages.run_cancellations(cancellations)
        {:ok, records}

      error ->
        error
    end
  end

  defp persist_or_rollback(browser_id, prepared, cancellation_mode) do
    case persist_observation(browser_id, prepared, cancellation_mode) do
      {:ok, record} -> record
      {:error, reason} -> Repo.rollback(reason)
    end
  end

  defp persist_observation(browser_id, prepared, cancellation_mode \\ :immediate) do
    route_observation(
      browser_id,
      prepared.attrs,
      prepared.page,
      prepared.catalog,
      prepared.fingerprint,
      cancellation_mode
    )
  end

  defp route_observation(browser_id, attrs, page, catalog, fingerprint, cancellation_mode) do
    case Pages.match(page.origin, page.sanitized_path) do
      {:ok, registration} ->
        attach_session(
          browser_id,
          registration,
          attrs,
          page,
          catalog,
          fingerprint,
          cancellation_mode
        )

      :none ->
        result =
          if ignored_origin?(browser_id, page.origin),
            do: {:ok, :ignored},
            else: persist_discovery(browser_id, page, catalog, fingerprint)

        maybe_defer(result, cancellation_mode)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp attach_session(
         browser_id,
         registration,
         attrs,
         page,
         catalog,
         fingerprint,
         cancellation_mode
       ) do
    with tab_id when is_integer(tab_id) and tab_id >= 0 <- attrs["tab_id"],
         document_id when is_binary(document_id) and byte_size(document_id) in 1..128 <-
           attrs["document_id"] do
      attach_page(cancellation_mode, browser_id, registration, %{
        tab_id: tab_id,
        document_id: document_id,
        current_origin: page.origin,
        sanitized_path: page.sanitized_path,
        page_title: page.page_title,
        catalog_fingerprint: fingerprint,
        catalog_summary: %{"tools" => catalog}
      })
    else
      _invalid -> {:error, :invalid_document_identity}
    end
  end

  defp maybe_defer({:ok, record}, :deferred), do: {:ok, {record, []}}
  defp maybe_defer(result, _cancellation_mode), do: result

  defp attach_page(:deferred, browser_id, registration, attrs),
    do: Pages.attach_deferred(browser_id, registration, attrs)

  defp attach_page(_cancellation_mode, browser_id, registration, attrs),
    do: Pages.attach(browser_id, registration, attrs)

  defp persist_discovery(browser_id, page, catalog, fingerprint) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    values =
      Map.merge(page, %{
        browser_id: browser_id,
        tool_count: length(catalog),
        catalog_fingerprint: fingerprint,
        catalog_summary: %{"tools" => catalog},
        first_seen_at: now,
        last_seen_at: now,
        detection_count: 1
      })

    %Discovery{}
    |> Discovery.changeset(values)
    |> Repo.insert(
      on_conflict: [
        set: [
          page_title: page.page_title,
          state: "discovered",
          last_seen_at: now,
          updated_at: now
        ],
        inc: [detection_count: 1]
      ],
      conflict_target: [:browser_id, :origin, :sanitized_path, :catalog_fingerprint],
      returning: true
    )
  end

  defp sanitize_catalog(tools) when is_list(tools) and length(tools) in 1..@max_tools do
    tools
    |> Enum.reduce_while({:ok, []}, fn tool, {:ok, acc} ->
      case sanitize_tool(tool) do
        {:ok, sanitized} -> {:cont, {:ok, [sanitized | acc]}}
        error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, sanitized} -> {:ok, sanitized |> Enum.reverse() |> Enum.sort_by(& &1["name"])}
      error -> error
    end
  end

  defp sanitize_catalog(_tools), do: {:error, :invalid_catalog}

  defp sanitize_tool(%{"name" => name} = tool)
       when is_binary(name) and byte_size(name) in 1..128 do
    schema = Map.get(tool, "input_schema", %{})

    if json_size(schema) <= @max_schema_bytes and valid_json_shape?(schema) do
      {:ok,
       %{
         "name" => sanitize_string(name, 128),
         "title" => sanitize_string(Map.get(tool, "title", ""), @max_title_bytes),
         "description" =>
           sanitize_string(Map.get(tool, "description", ""), @max_description_bytes),
         "input_schema" => schema,
         "origin" => sanitize_origin(Map.get(tool, "origin")),
         "annotations" => sanitize_annotations(Map.get(tool, "annotations"))
       }}
    else
      {:error, :catalog_too_large}
    end
  end

  defp sanitize_tool(_tool), do: {:error, :invalid_catalog}

  # `RegisteredTool.origin` is the origin of the document that *registered* the
  # tool. The specification notes it is only meaningful when the tool is
  # cross-origin -- a frame can expose tools into a page via `exposedTo`, and
  # without this a third party's tool reaches an MCP client attributed to the
  # page that merely embedded it.
  #
  # Only a well-formed http/https origin is stored. Anything else becomes "",
  # which reads as "same origin as the page" rather than as a claim Webby
  # cannot substantiate.
  defp sanitize_origin(origin) when is_binary(origin) and byte_size(origin) in 1..256 do
    case URI.new(origin) do
      {:ok, %URI{scheme: scheme, host: host, path: path, query: nil, fragment: nil}}
      when scheme in ["http", "https"] and is_binary(host) and host != "" and
             path in [nil, "", "/"] ->
        origin

      _other ->
        ""
    end
  end

  defp sanitize_origin(_origin), do: ""

  # WebMCP `ToolAnnotations`, carried through so an MCP client can weigh them.
  # `untrustedContentHint` is the page declaring that a tool returns content it
  # does not vouch for; dropping it would quietly strip a safety signal.
  #
  # These arrive from a web page and are never trusted: anything that is not
  # literally `true` is recorded as `false`, and the shape is fixed so that a
  # page cannot smuggle extra keys into a stored catalog.
  defp sanitize_annotations(annotations) when is_map(annotations) do
    %{
      "read_only_hint" => hint(annotations, "read_only_hint", "readOnlyHint"),
      "untrusted_content_hint" =>
        hint(annotations, "untrusted_content_hint", "untrustedContentHint")
    }
  end

  defp sanitize_annotations(_annotations),
    do: %{"read_only_hint" => false, "untrusted_content_hint" => false}

  defp hint(annotations, key, spec_key) do
    Map.get(annotations, key, Map.get(annotations, spec_key)) == true
  end

  defp json_size(value) do
    case Jason.encode(value) do
      {:ok, encoded} -> byte_size(encoded)
      {:error, _reason} -> @max_schema_bytes + 1
    end
  end

  defp ignored_origin?(browser_id, origin) do
    Repo.exists?(
      from d in Discovery,
        where: d.browser_id == ^browser_id and d.origin == ^origin and d.state == "ignored"
    )
  end

  defp valid_json_shape?(value) do
    case walk_json([{value, 0}], 0) do
      {:ok, _nodes} -> true
      :error -> false
    end
  end

  defp walk_json([], nodes), do: {:ok, nodes}
  defp walk_json(_pending, nodes) when nodes > @max_schema_nodes, do: :error
  defp walk_json([{_value, depth} | _pending], _nodes) when depth > @max_schema_depth, do: :error

  defp walk_json([{value, depth} | pending], nodes) when is_map(value) do
    children =
      Enum.flat_map(value, fn {key, nested} -> [{key, depth + 1}, {nested, depth + 1}] end)

    walk_json(children ++ pending, nodes + 1)
  end

  defp walk_json([{value, depth} | pending], nodes) when is_list(value) do
    children = Enum.map(value, &{&1, depth + 1})
    walk_json(children ++ pending, nodes + 1)
  end

  defp walk_json([{value, _depth} | pending], nodes)
       when is_binary(value) or is_number(value) or is_boolean(value) or is_nil(value),
       do: walk_json(pending, nodes + 1)

  defp walk_json(_pending, _nodes), do: :error

  defp sanitize_string(value, max_bytes) when is_binary(value),
    do: value |> String.replace(~r/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u, "") |> truncate(max_bytes)

  defp sanitize_string(_value, _max_bytes), do: ""

  defp truncate(value, max_bytes) when byte_size(value) <= max_bytes, do: value

  defp truncate(value, max_bytes) do
    candidate = binary_part(value, 0, max_bytes)
    if String.valid?(candidate), do: candidate, else: truncate(value, max_bytes - 1)
  end

  defp normalize_host(host) do
    host = String.downcase(host)

    cond do
      Regex.match?(~r/\A[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\z/, host) -> {:ok, host}
      match?({:ok, _address}, :inet.parse_address(String.to_charlist(host))) -> {:ok, "[#{host}]"}
      true -> {:error, :invalid_page_url}
    end
  end

  defp normalized_port("http", port) when port in [nil, 80], do: {:ok, ""}
  defp normalized_port("https", port) when port in [nil, 443], do: {:ok, ""}

  defp normalized_port(_scheme, port) when is_integer(port) and port in 1..65_535,
    do: {:ok, ":#{port}"}

  defp normalized_port(_scheme, _port), do: {:error, :invalid_page_url}

  defp normalize_path(nil), do: "/"
  defp normalize_path(""), do: "/"
  defp normalize_path(path), do: path

  defp canonicalize(value) when is_map(value) do
    {:map,
     value
     |> Enum.map(fn {key, nested} -> {to_string(key), canonicalize(nested)} end)
     |> Enum.sort_by(&elem(&1, 0))}
  end

  defp canonicalize(value) when is_list(value), do: {:list, Enum.map(value, &canonicalize/1)}
  defp canonicalize(value), do: value
end
