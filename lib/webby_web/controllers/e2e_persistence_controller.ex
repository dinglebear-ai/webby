defmodule WebbyWeb.E2EPersistenceController do
  @moduledoc false
  use WebbyWeb, :controller

  def create(conn, params) do
    case authorize(conn) do
      :ok ->
        execute(conn, params)

      {:error, :unauthorized} ->
        conn |> put_status(:not_found) |> json(%{error: "not_found"})
    end
  end

  defp execute(conn, %{
         "op" => "browser.erase",
         "browser_id" => browser_id,
         "audits" => audits
       })
       when audits in ["anonymize", "delete"] do
    case Webby.DataRetention.erase_browser(browser_id, audits: audit_policy(audits)) do
      {:ok, result} ->
        json(conn, %{status: "ok", result: result})

      {:error, reason} ->
        conn |> put_status(:unprocessable_entity) |> json(%{error: inspect(reason)})
    end
  end

  defp execute(conn, _params),
    do: conn |> put_status(:bad_request) |> json(%{error: "invalid_operation"})

  defp authorize(conn) do
    supplied = get_req_header(conn, "x-webby-e2e-capability") |> List.first()
    expected_hash = System.get_env("WEBBY_E2E_TELEMETRY_CAPABILITY_HASH")

    if System.get_env("WEBBY_ENVIRONMENT_MARKER") == "isolated-e2e" and
         is_binary(supplied) and is_binary(expected_hash) and
         secure_equal?(hash(supplied), expected_hash),
       do: :ok,
       else: {:error, :unauthorized}
  end

  defp hash(value), do: :crypto.hash(:sha256, value) |> Base.encode16(case: :lower)
  defp audit_policy("anonymize"), do: :anonymize
  defp audit_policy("delete"), do: :delete

  defp secure_equal?(left, right) when byte_size(left) == byte_size(right),
    do: Plug.Crypto.secure_compare(left, right)

  defp secure_equal?(_left, _right), do: false
end
