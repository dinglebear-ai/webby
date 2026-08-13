defmodule Webby.RuntimeDiscovery do
  @moduledoc "Publishes non-secret metadata for the running local Webby instance."

  use GenServer
  require Logger

  @listen_host "127.0.0.1"

  def start_link(opts),
    do: GenServer.start_link(__MODULE__, opts, name: opts[:name] || __MODULE__)

  def snapshot(server \\ __MODULE__), do: GenServer.call(server, :snapshot)

  def cleanup(server \\ __MODULE__), do: GenServer.call(server, :cleanup)

  @impl true
  def init(opts) do
    path = Keyword.get(opts, :path, Webby.Paths.runtime_file())
    lock_path = path <> ".lock"
    metadata = Keyword.get(opts, :metadata, &default_metadata/0).()

    with :ok <- ensure_private_directory(Path.dirname(path)),
         :ok <- acquire_lock(lock_path) do
      case publish(path, metadata) do
        :ok ->
          {:ok, %{path: path, lock_path: lock_path, metadata: metadata}}

        error ->
          File.rm(lock_path)
          error
      end
    end
  end

  @impl true
  def handle_call(:snapshot, _from, state), do: {:reply, state.metadata, state}

  def handle_call(:cleanup, _from, state), do: {:reply, cleanup_owned(state), state}

  @impl true
  def terminate(_reason, state) do
    cleanup_owned(state) |> log_cleanup_error(state.path)
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

  defp acquire_lock(lock_path) do
    case File.write(lock_path, System.pid(), [:exclusive]) do
      :ok -> File.chmod(lock_path, 0o600)
      {:error, :eexist} -> {:stop, {:already_running, lock_path}}
      error -> error
    end
  end

  defp cleanup_owned(%{path: path, lock_path: lock_path}) do
    with :ok <- remove_if_present(path), do: remove_if_present(lock_path)
  end

  defp remove_if_present(path) do
    case File.rm(path) do
      :ok -> :ok
      {:error, :enoent} -> :ok
      error -> error
    end
  end

  defp log_cleanup_error(:ok, _path), do: nil

  defp log_cleanup_error(error, path) do
    Logger.error("runtime discovery cleanup failed", path: path, reason: inspect(error))
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
