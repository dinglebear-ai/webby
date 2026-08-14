defmodule Webby.Discovery do
  @moduledoc "Sanitized, local observations of unregistered WebMCP catalogs."

  import Ecto.Query
  alias Webby.Discovery.Discovery
  alias Webby.Repo

  @max_tools 64
  @max_description_bytes 1_000
  @max_schema_bytes 32_768
  @max_schema_depth 16
  @max_schema_nodes 2_048

  def list_discoveries do
    Repo.all(
      from d in Discovery, where: d.state == "discovered", order_by: [desc: d.last_seen_at]
    )
  end

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
    with {:ok, page} <- sanitize_page(attrs),
         false <- ignored_origin?(browser_id, page.origin),
         {:ok, catalog} <- sanitize_catalog(attrs["tools"]),
         {:ok, fingerprint} <- fingerprint(catalog) do
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
          set: [page_title: page.page_title, last_seen_at: now, updated_at: now],
          inc: [detection_count: 1]
        ],
        conflict_target: [:browser_id, :origin, :sanitized_path, :catalog_fingerprint],
        returning: true
      )
    else
      true -> {:ok, :ignored}
      error -> error
    end
  end

  def observe_many(browser_id, observations)
      when is_list(observations) and length(observations) <= 128 do
    Repo.transaction(fn ->
      Enum.map(observations, &observe_or_rollback(browser_id, &1))
    end)
  end

  def observe_many(_browser_id, _observations), do: {:error, :invalid_observations}

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

  defp observe_or_rollback(browser_id, attrs) do
    case observe(browser_id, attrs) do
      {:ok, discovery} -> discovery
      {:error, reason} -> Repo.rollback(reason)
    end
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
         "description" =>
           sanitize_string(Map.get(tool, "description", ""), @max_description_bytes),
         "input_schema" => schema
       }}
    else
      {:error, :catalog_too_large}
    end
  end

  defp sanitize_tool(_tool), do: {:error, :invalid_catalog}

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
