defmodule Webby.MCP.Broker do
  @moduledoc "Actions exposed through Webby's stable broker tool."

  alias Webby.{Browsers, Discovery, Pages}

  @actions ~w(status browser.list discovery.list discovery.get page.list page.get page.tools page.call)

  def tool do
    %{
      "name" => "webby",
      "title" => "Webby browser tool broker",
      "description" =>
        "Inspect explicitly registered browser-native WebMCP pages and their live tools.",
      "inputSchema" => %{
        "type" => "object",
        "additionalProperties" => false,
        "properties" => %{
          "action" => %{"type" => "string", "enum" => @actions},
          "params" => %{"type" => "object"}
        },
        "required" => ["action"],
        "oneOf" => Enum.map(@actions, &action_schema/1)
      }
    }
  end

  def call(arguments, context \\ %{})

  def call(%{"action" => action} = arguments, context) when action in @actions do
    dispatch(action, Map.get(arguments, "params", %{}), context)
  end

  def call(_arguments, _context),
    do: {:error, "invalid_arguments", "A supported action is required"}

  defp dispatch("status", _params, _context) do
    {_result, snapshot} = Webby.RuntimeStatus.snapshot()
    {:ok, snapshot}
  end

  defp dispatch("browser.list", _params, _context) do
    {:ok, Enum.map(Browsers.list_browsers(), &browser_view/1)}
  end

  defp dispatch("discovery.list", _params, _context) do
    {:ok, Enum.map(Discovery.list_discoveries(), &discovery_view/1)}
  end

  defp dispatch("discovery.get", %{"id" => id}, _context) do
    case Discovery.get_discovery(id) do
      nil -> {:error, "not_found", "Discovery not found"}
      discovery -> {:ok, discovery_view(discovery)}
    end
  end

  defp dispatch("page.list", _params, _context) do
    {:ok,
     Enum.map(Pages.list_registrations_with_session_counts(), fn {registration, count} ->
       registration_view(registration, count)
     end)}
  end

  defp dispatch(action, %{"page" => identifier}, _context)
       when action in ["page.get", "page.tools"] do
    case Pages.get_registration(identifier) do
      nil -> {:error, "not_found", "Page registration not found"}
      registration -> page_result(action, registration)
    end
  end

  defp dispatch(
         "page.call",
         %{"page" => identifier, "tool" => tool_name, "catalog_revision" => revision} = params,
         context
       )
       when is_binary(identifier) and is_binary(tool_name) and is_integer(revision) do
    arguments = Map.get(params, "arguments", %{})

    with :ok <- validate_arguments(arguments),
         registration when not is_nil(registration) <- Pages.get_registration(identifier),
         :ok <- validate_enabled(registration),
         {:ok, session} <- Pages.select_session(registration, params),
         :ok <- validate_revision(session, revision),
         :ok <- validate_tool(session, tool_name) do
      Webby.Invocations.call(registration, session, tool_name, arguments, context)
    else
      nil -> {:error, "not_found", "Page registration not found"}
      {:error, _kind, _message} = error -> error
    end
  end

  defp dispatch(_action, _params, _context),
    do: {:error, "invalid_arguments", "Required parameters are missing"}

  defp page_result("page.get", registration) do
    sessions = Pages.sessions_for(registration.id)

    {:ok,
     Map.put(registration_view(registration), "sessions", Enum.map(sessions, &session_view/1))}
  end

  defp page_result("page.tools", registration) do
    {:ok,
     %{
       "page" => registration.slug,
       "sessions" => registration.id |> Pages.sessions_for() |> Enum.map(&session_tools_view/1)
     }}
  end

  defp browser_view(browser) do
    %{
      "id" => browser.id,
      "display_name" => browser.display_name,
      "scanning_mode" => browser.scanning_mode,
      "scanning_paused" => browser.scanning_paused,
      "available" => is_nil(browser.revoked_at),
      "last_seen_at" => iso8601(browser.last_seen_at)
    }
  end

  defp discovery_view(discovery) do
    %{
      "id" => discovery.id,
      "origin" => discovery.origin,
      "path" => discovery.sanitized_path,
      "page_title" => discovery.page_title,
      "tool_count" => discovery.tool_count,
      "catalog" => discovery.catalog_summary,
      "last_seen_at" => iso8601(discovery.last_seen_at)
    }
  end

  defp registration_view(registration) do
    sessions = Pages.sessions_for(registration.id)

    registration_view(registration, length(sessions))
  end

  defp registration_view(registration, active_session_count) do
    %{
      "id" => registration.id,
      "slug" => registration.slug,
      "display_name" => registration.display_name,
      "origin" => registration.origin,
      "url_pattern" => registration.url_pattern,
      "enabled" => registration.enabled,
      "exposure_mode" => registration.exposure_mode,
      "available" => active_session_count > 0,
      "active_session_count" => active_session_count
    }
  end

  defp session_view(session) do
    %{
      "id" => session.id,
      "browser_id" => session.browser_id,
      "page_title" => session.page_title,
      "catalog_revision" => session.catalog_revision,
      "last_seen_at" => iso8601(session.last_seen_at)
    }
  end

  defp session_tools_view(session) do
    Map.put(session_view(session), "tools", session.catalog_summary["tools"] || [])
  end

  defp iso8601(nil), do: nil
  defp iso8601(value), do: DateTime.to_iso8601(value)

  defp encoded_size(value), do: value |> Jason.encode!() |> byte_size()

  defp validate_arguments(arguments) do
    if is_map(arguments) and encoded_size(arguments) <= 65_536,
      do: :ok,
      else:
        {:error, "invalid_arguments", "Tool arguments must be an object no larger than 64 KiB"}
  end

  defp validate_enabled(%{enabled: true}), do: :ok

  defp validate_enabled(_registration),
    do: {:error, "page_disabled", "The page registration is disabled"}

  defp validate_revision(%{catalog_revision: revision}, revision), do: :ok

  defp validate_revision(_session, _revision),
    do: {:error, "stale_catalog", "Refresh page.tools before invoking this tool"}

  defp validate_tool(session, tool_name) do
    if Enum.any?(session.catalog_summary["tools"] || [], &(&1["name"] == tool_name)),
      do: :ok,
      else: {:error, "tool_not_found", "The tool is absent from the selected catalog"}
  end

  defp action_schema(action) when action in ~w(status browser.list discovery.list page.list) do
    %{
      "properties" => %{
        "action" => %{"const" => action},
        "params" => empty_params_schema()
      }
    }
  end

  defp action_schema("discovery.get"),
    do: action_with_params("discovery.get", %{"id" => string_schema()}, ["id"])

  defp action_schema(action) when action in ~w(page.get page.tools),
    do: action_with_params(action, %{"page" => string_schema()}, ["page"])

  defp action_schema("page.call") do
    action_with_params(
      "page.call",
      %{
        "page" => string_schema(),
        "tool" => string_schema(),
        "catalog_revision" => %{"type" => "integer", "minimum" => 1},
        "session" => string_schema(),
        "arguments" => %{"type" => "object"}
      },
      ["page", "tool", "catalog_revision"]
    )
  end

  defp action_with_params(action, properties, required) do
    %{
      "properties" => %{
        "action" => %{"const" => action},
        "params" => %{
          "type" => "object",
          "additionalProperties" => false,
          "properties" => properties,
          "required" => required
        }
      },
      "required" => ["params"]
    }
  end

  defp empty_params_schema do
    %{"type" => "object", "additionalProperties" => false, "maxProperties" => 0}
  end

  defp string_schema, do: %{"type" => "string", "minLength" => 1}
end
