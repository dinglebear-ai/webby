defmodule Webby.RuntimeDiscovery do
  @moduledoc "Publishes non-secret metadata for the running local Webby instance."

  use GenServer

  @listen_host "127.0.0.1"

  def start_link(opts),
    do: GenServer.start_link(__MODULE__, opts, name: opts[:name] || __MODULE__)

  def snapshot(server \\ __MODULE__), do: GenServer.call(server, :snapshot)

  def cleanup(server \\ __MODULE__), do: GenServer.call(server, :cleanup)

  @impl true
  def init(opts) do
    path = Keyword.get(opts, :path, Webby.Paths.runtime_file())
    metadata = Keyword.get(opts, :metadata, &default_metadata/0).()

    with :ok <- ensure_private_directory(Path.dirname(path)),
         :ok <- publish(path, metadata) do
      {:ok, %{path: path, metadata: metadata, bytes: Jason.encode!(metadata)}}
    end
  end

  @impl true
  def handle_call(:snapshot, _from, state), do: {:reply, state.metadata, state}

  def handle_call(:cleanup, _from, state), do: {:reply, cleanup_owned(state), state}

  @impl true
  def terminate(_reason, state) do
    cleanup_owned(state)
    :ok
  end

  defp default_metadata do
    port = Application.fetch_env!(:webby, :listen_port)

    %{
      instance_id: load_or_create_instance_id(),
      base_url: "http://#{@listen_host}:#{port}",
      mcp_url: "http://#{@listen_host}:#{port}/mcp",
      pid: System.pid()
    }
  end

  defp load_or_create_instance_id do
    path = Webby.Paths.instance_file()

    case File.read(path) do
      {:ok, id} -> String.trim(id)
      {:error, :enoent} -> create_instance_id(path)
      {:error, reason} -> raise File.Error, reason: reason, action: "read", path: path
    end
  end

  defp create_instance_id(path) do
    id = Ecto.UUID.generate()
    :ok = ensure_private_directory(Path.dirname(path))
    :ok = publish_bytes(path, id <> "\n")
    id
  end

  defp ensure_private_directory(directory) do
    with :ok <- File.mkdir_p(directory), do: File.chmod(directory, 0o700)
  end

  defp publish(path, metadata), do: publish_bytes(path, Jason.encode!(metadata))

  defp cleanup_owned(%{path: path, bytes: bytes}) do
    case File.read(path) do
      {:ok, ^bytes} -> File.rm(path)
      {:ok, _replacement} -> :ok
      {:error, :enoent} -> :ok
      error -> error
    end
  end

  defp publish_bytes(path, bytes) do
    temporary = path <> ".tmp.#{System.unique_integer([:positive, :monotonic])}"

    with :ok <- File.write(temporary, bytes, [:exclusive]),
         :ok <- File.chmod(temporary, 0o600),
         :ok <- File.rename(temporary, path) do
      :ok
    else
      error ->
        File.rm(temporary)
        error
    end
  end
end
