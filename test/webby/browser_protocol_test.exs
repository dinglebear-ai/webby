defmodule Webby.BrowserProtocolTest do
  use ExUnit.Case, async: true

  alias Webby.BrowserProtocol

  test "accepts a version-one known message" do
    assert {:ok, %{type: "heartbeat", payload: %{}}} =
             BrowserProtocol.validate(%{
               "protocol_version" => 1,
               "type" => "heartbeat",
               "payload" => %{}
             })
  end

  test "rejects unsupported versions and unknown types with stable errors" do
    assert {:error,
            %{"kind" => "unsupported_protocol_version", "supported" => %{"min" => 1, "max" => 1}}} =
             BrowserProtocol.validate(%{
               "protocol_version" => 2,
               "type" => "heartbeat",
               "payload" => %{}
             })

    assert {:error, %{"kind" => "unknown_message_type", "type" => "evil.execute"}} =
             BrowserProtocol.validate(%{
               "protocol_version" => 1,
               "type" => "evil.execute",
               "payload" => %{}
             })
  end

  test "rejects missing, oversized, and wrongly typed authentication fields" do
    for payload <- [
          %{"challenge_id" => "challenge"},
          %{"challenge_id" => "challenge", "signature" => 42},
          %{"challenge_id" => "challenge", "signature" => String.duplicate("a", 257)}
        ] do
      assert {:error, %{"kind" => "invalid_payload", "type" => "auth.respond"}} =
               BrowserProtocol.validate(%{
                 "protocol_version" => 1,
                 "type" => "auth.respond",
                 "payload" => payload
               })
    end
  end

  test "classifies an envelope missing its protocol version as invalid" do
    assert {:error, %{"kind" => "invalid_envelope"}} =
             BrowserProtocol.validate(%{"type" => "heartbeat", "payload" => %{}})
  end

  test "requires complete document identities and validates session closure" do
    observation = %{
      "url" => "https://example.com/tools",
      "title" => "Tools",
      "tools" => [%{"name" => "search"}],
      "tab_id" => 7
    }

    assert {:error, %{"kind" => "invalid_payload"}} =
             BrowserProtocol.validate(%{
               "protocol_version" => 1,
               "type" => "discovery.observed",
               "payload" => %{"observations" => [observation]}
             })

    assert {:ok, %{type: "session.closed"}} =
             BrowserProtocol.validate(%{
               "protocol_version" => 1,
               "type" => "session.closed",
               "payload" => %{"tab_id" => 7, "document_id" => "document-1"}
             })
  end

  test "bounds browser tool results and requires stable error kinds" do
    assert {:ok, %{type: "tool.result"}} =
             BrowserProtocol.validate(%{
               "protocol_version" => 1,
               "type" => "tool.result",
               "payload" => %{"call_id" => "call-1", "result" => %{"answer" => 42}}
             })

    assert {:error, %{"kind" => "invalid_payload"}} =
             BrowserProtocol.validate(%{
               "protocol_version" => 1,
               "type" => "tool.result",
               "payload" => %{"call_id" => "call-1", "result" => String.duplicate("x", 131_073)}
             })

    assert {:error, %{"kind" => "invalid_payload"}} =
             BrowserProtocol.validate(%{
               "protocol_version" => 1,
               "type" => "tool.error",
               "payload" => %{"call_id" => "call-1", "error" => %{}}
             })
  end
end
