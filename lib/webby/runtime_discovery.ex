defmodule Webby.RuntimeDiscovery do
  @moduledoc "Publishes versioned, non-secret metadata for the running Webby instance."

  use GenServer
  require Logger

  @listen_host "127.0.0.1"

  def start_link(opts),
    do: GenServer.start_link(__MODULE__, opts, name: opts[:name] || __MODULE__)

  def snapshot(server \\ __MODULE__), do: GenServer.call(server, :snapshot)
  def cleanup(server \\ __MODULE__), do: GenServer.call(server, :cleanup)

  def instance_id(path \\ Webby.Paths.instance_file()) do
    case Webby.PrivateFile.read_or_create(path, &Ecto.UUID.generate/0) do
      {:ok, id} -> id
      {:error, reason} -> raise File.Error, reason: reason, action: "provision", path: path
    end
  end

  @impl true
  def init(opts) do
    path = Keyword.get(opts, :path, Webby.Paths.runtime_file())
    metadata_provider = Keyword.get(opts, :metadata, &default_metadata/0)
    authority_port = Keyword.get(opts, :authority_port, authority_port())

    with {:ok, authority_socket} <- acquire_authority(authority_port),
         :ok <- ensure_private_directory(Path.dirname(path)) do
      metadata = Map.put(metadata_provider.(), :publication_id, random_token())

      case publish(path, metadata) do
        :ok ->
          Logger.info("runtime discovery published",
            event: "runtime_discovery.publish",
            publication_id: metadata.publication_id,
            path: path
          )

          {:ok,
           %{
             path: path,
             metadata: metadata,
             authority_socket: authority_socket,
             released: false
           }}

        {:error, reason} ->
          {:stop, reason}
      end
    else
      {:error, :eaddrinuse} -> {:stop, {:already_running, authority_port}}
      {:error, reason} -> {:stop, reason}
    end
  end

  @impl true
  def handle_call(:snapshot, _from, state), do: {:reply, state.metadata, state}

  def handle_call(:cleanup, _from, state) do
    result = cleanup_owned(state)
    {:reply, result, %{state | released: result == :ok}}
  end

  @impl true
  def terminate(_reason, %{released: true}), do: :ok

  def terminate(_reason, state) do
    cleanup_owned(state) |> log_cleanup_error(state.path)
    :ok
  end

  defp default_metadata do
    port = Application.fetch_env!(:webby, :listen_port)
    base_url = "http://#{@listen_host}:#{port}"

    %{
      schema_version: 1,
      product_version: Application.spec(:webby, :vsn) |> to_string(),
      instance_id: instance_id(),
      base_url: base_url,
      capabilities: %{
        health: %{status: "available", url: base_url <> "/health", transport: "http-json"},
        mcp: %{
          status: "available",
          url: base_url <> "/mcp",
          transport: "streamable-http",
          protocol_versions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]
        }
      },
      pid: System.pid()
    }
  end

  defp authority_port do
    Application.get_env(:webby, :authority_port, 6476)
  end

  defp acquire_authority(port) do
    :gen_tcp.listen(port, [:binary, ip: {127, 0, 0, 1}, active: false, reuseaddr: false])
  end

  defp ensure_private_directory(directory) do
    with :ok <- File.mkdir_p(directory), do: File.chmod(directory, 0o700)
  end

  defp publish(path, metadata) do
    temporary = path <> ".tmp." <> random_token()

    with :ok <- File.write(temporary, Jason.encode!(metadata), [:exclusive]),
         :ok <- File.chmod(temporary, 0o600),
         :ok <- File.rename(temporary, path) do
      :ok
    else
      error ->
        cleanup_error = remove_if_present(temporary)

        if cleanup_error == :ok do
          error
        else
          {:error, {:publish_failed, error, cleanup_error}}
        end
    end
  end

  defp cleanup_owned(%{released: true}), do: :ok

  defp cleanup_owned(%{path: path, metadata: metadata}) do
    with {:ok, bytes} <- File.read(path),
         {:ok, on_disk} <- Jason.decode(bytes),
         true <- on_disk["publication_id"] == metadata.publication_id do
      remove_if_present(path)
    else
      {:error, :enoent} -> :ok
      false -> :ok
      error -> error
    end
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

  defp random_token, do: :crypto.strong_rand_bytes(16) |> Base.url_encode64(padding: false)
end
