defmodule Webby.PrivateFile do
  @moduledoc false

  def read_or_create(path, generator) when is_function(generator, 0) do
    with :ok <- ensure_private_directory(Path.dirname(path)) do
      read_or_create_file(path, generator)
    end
  end

  defp read_or_create_file(path, generator) do
    case File.read(path) do
      {:ok, value} ->
        with :ok <- File.chmod(path, 0o600), do: {:ok, String.trim(value)}

      {:error, :enoent} ->
        value = generator.()
        temporary = path <> ".tmp." <> random_token()

        with :ok <- File.write(temporary, value <> "\n", [:exclusive]),
             :ok <- File.chmod(temporary, 0o600) do
          install_private_file(temporary, path, generator, value)
        end

      error ->
        error
    end
  end

  defp install_private_file(temporary, path, generator, value) do
    result =
      case File.ln(temporary, path) do
        :ok -> {:ok, value}
        {:error, :eexist} -> read_or_create_file(path, generator)
        error -> error
      end

    case File.rm(temporary) do
      :ok -> result
      {:error, :enoent} -> result
      cleanup_error -> {:error, {:temporary_cleanup_failed, result, cleanup_error}}
    end
  end

  defp ensure_private_directory(directory) do
    with :ok <- File.mkdir_p(directory), do: File.chmod(directory, 0o700)
  end

  defp random_token, do: :crypto.strong_rand_bytes(16) |> Base.url_encode64(padding: false)
end
