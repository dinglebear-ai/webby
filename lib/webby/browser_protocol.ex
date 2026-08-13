defmodule Webby.BrowserProtocol do
  @moduledoc "Transport-neutral validation for Webby Browser Protocol version 1."

  @version 1
  @types ~w(pairing.request pairing.status auth.respond browser.hello browser.resync heartbeat)

  def version, do: @version

  def validate(%{"protocol_version" => @version, "type" => type, "payload" => payload} = envelope)
      when type in @types and is_map(payload) do
    with :ok <- validate_payload(type, payload),
         :ok <- validate_optional_string(envelope["request_id"], 128),
         :ok <- validate_optional_string(envelope["browser_id"], 128),
         :ok <- validate_optional_string(envelope["sent_at"], 64) do
      {:ok,
       %{
         protocol_version: @version,
         type: type,
         request_id: envelope["request_id"],
         browser_id: envelope["browser_id"],
         sent_at: envelope["sent_at"],
         payload: payload
       }}
    end
  end

  def validate(%{"protocol_version" => version}) when version != @version do
    {:error, error("unsupported_protocol_version", %{"supported" => %{"min" => 1, "max" => 1}})}
  end

  def validate(%{"protocol_version" => @version, "type" => type}) when is_binary(type) do
    {:error, error("unknown_message_type", %{"type" => type})}
  end

  def validate(_envelope), do: {:error, error("invalid_envelope")}

  def envelope(type, payload, attrs \\ %{}) do
    %{
      "protocol_version" => @version,
      "type" => type,
      "request_id" => attrs[:request_id],
      "browser_id" => attrs[:browser_id],
      "sent_at" => DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601(),
      "payload" => payload
    }
  end

  defp error(kind, details \\ %{}),
    do: Map.merge(%{"kind" => kind, "retryable" => false}, details)

  defp validate_payload("pairing.request", payload) do
    with :ok <- required_string(payload, "display_name", 80),
         :ok <- required_string(payload, "public_key", 128),
         mode when mode in ["granted_sites", "all_tabs"] <- payload["scanning_mode"] do
      :ok
    else
      _invalid -> {:error, error("invalid_payload", %{"type" => "pairing.request"})}
    end
  end

  defp validate_payload("auth.respond", payload) do
    with :ok <- required_string(payload, "challenge_id", 128),
         :ok <- required_string(payload, "signature", 256) do
      :ok
    else
      _invalid -> {:error, error("invalid_payload", %{"type" => "auth.respond"})}
    end
  end

  defp validate_payload("pairing.status", payload) do
    case required_string(payload, "pairing_id", 128) do
      :ok -> :ok
      :error -> {:error, error("invalid_payload", %{"type" => "pairing.status"})}
    end
  end

  defp validate_payload(_type, _payload), do: :ok

  defp required_string(payload, key, max_length) do
    case payload[key] do
      value when is_binary(value) and byte_size(value) > 0 and byte_size(value) <= max_length ->
        :ok

      _value ->
        :error
    end
  end

  defp validate_optional_string(nil, _max_length), do: :ok

  defp validate_optional_string(value, max_length)
       when is_binary(value) and byte_size(value) <= max_length,
       do: :ok

  defp validate_optional_string(_value, _max_length),
    do: {:error, error("invalid_envelope")}
end
