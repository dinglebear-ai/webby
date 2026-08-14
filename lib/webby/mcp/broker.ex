defmodule Webby.MCP.Broker do
  @moduledoc "Read-only actions exposed through Webby's stable broker tool."

  alias Webby.{Browsers, Discovery, Pages}

  @actions ~w(status browser.list discovery.list discovery.get page.list page.get page.tools)

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
        "required" => ["action"]
      }
    }
  end

  def call(%{"action" => action} = arguments) when action in @actions do
    dispatch(action, Map.get(arguments, "params", %{}))
  end

  def call(_arguments), do: {:error, "invalid_arguments", "A supported read action is required"}

  defp dispatch("status", _params) do
    {_result, snapshot} = Webby.RuntimeStatus.snapshot()
    {:ok, snapshot}
  end

  defp dispatch("browser.list", _params) do
    {:ok, Enum.map(Browsers.list_browsers(), &browser_view/1)}
  end

  defp dispatch("discovery.list", _params) do
    {:ok, Enum.map(Discovery.list_discoveries(), &discovery_view/1)}
  end

  defp dispatch("discovery.get", %{"id" => id}) do
    case Discovery.get_discovery(id) do
      nil -> {:error, "not_found", "Discovery not found"}
      discovery -> {:ok, discovery_view(discovery)}
    end
  end

  defp dispatch("page.list", _params) do
    {:ok, Enum.map(Pages.list_registrations(), &registration_view/1)}
  end

  defp dispatch(action, %{"page" => identifier}) when action in ["page.get", "page.tools"] do
    case Pages.get_registration(identifier) do
      nil -> {:error, "not_found", "Page registration not found"}
      registration -> page_result(action, registration)
    end
  end

  defp dispatch(_action, _params),
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

    %{
      "id" => registration.id,
      "slug" => registration.slug,
      "display_name" => registration.display_name,
      "origin" => registration.origin,
      "url_pattern" => registration.url_pattern,
      "enabled" => registration.enabled,
      "exposure_mode" => registration.exposure_mode,
      "available" => sessions != [],
      "active_session_count" => length(sessions)
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
end
