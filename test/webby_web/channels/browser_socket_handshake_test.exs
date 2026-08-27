defmodule WebbyWeb.BrowserSocketHandshakeTest do
  use ExUnit.Case, async: false

  @matching_extension_id "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  @other_extension_id "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

  setup_all do
    port = unused_port()

    start_supervised!(
      {Bandit, plug: WebbyWeb.Endpoint, ip: {127, 0, 0, 1}, port: port, startup_log: false}
    )

    %{port: port}
  end

  test "the endpoint accepts a matching Chrome extension Origin", %{port: port} do
    assert websocket_status(port, @matching_extension_id, origin(@matching_extension_id)) == 101
  end

  test "the endpoint rejects an Origin that differs from the claimed extension", %{port: port} do
    assert websocket_status(port, @matching_extension_id, origin(@other_extension_id)) == 403
  end

  test "the endpoint rejects a missing Origin", %{port: port} do
    assert websocket_status(port, @matching_extension_id, nil) == 403
  end

  defp websocket_status(port, extension_id, origin) do
    {:ok, socket} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false])

    request = [
      "GET /browser/websocket?extension_id=",
      extension_id,
      "&vsn=2.0.0 HTTP/1.1\r\n",
      "Host: 127.0.0.1:",
      Integer.to_string(port),
      "\r\n",
      "Connection: Upgrade\r\n",
      "Upgrade: websocket\r\n",
      "Sec-WebSocket-Version: 13\r\n",
      "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==\r\n",
      if(origin, do: ["Origin: ", origin, "\r\n"], else: []),
      "\r\n"
    ]

    :ok = :gen_tcp.send(socket, request)
    {:ok, response} = :gen_tcp.recv(socket, 0, 2_000)
    :ok = :gen_tcp.close(socket)

    [_, status | _] = Regex.run(~r/\AHTTP\/1\.1 (\d{3})/, response)
    String.to_integer(status)
  end

  defp origin(extension_id), do: "chrome-extension://#{extension_id}"

  defp unused_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, ip: {127, 0, 0, 1}, active: false])
    {:ok, port} = :inet.port(socket)
    :ok = :gen_tcp.close(socket)
    port
  end
end
