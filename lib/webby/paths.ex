defmodule Webby.Paths do
  @moduledoc "Platform-aware locations for Webby's local configuration and state."

  def config_dir(platform \\ :os.type()), do: Path.join(config_root(platform), app_dir(platform))
  def data_dir(platform \\ :os.type()), do: Path.join(data_root(platform), app_dir(platform))
  def state_dir(platform \\ :os.type()), do: Path.join(state_root(platform), app_dir(platform))
  def runtime_file(platform \\ :os.type()), do: Path.join(config_dir(platform), "runtime.json")
  def instance_file(platform \\ :os.type()), do: Path.join(config_dir(platform), "instance-id")
  def secret_file(platform \\ :os.type()), do: Path.join(config_dir(platform), "secret-key-base")

  defp app_dir(platform) do
    case platform do
      {:unix, :darwin} -> "Webby"
      _ -> "webby"
    end
  end

  defp config_root(platform) do
    case platform do
      {:win32, _} -> env!("LOCALAPPDATA")
      {:unix, :darwin} -> Path.join(home!(), "Library/Application Support")
      _ -> System.get_env("XDG_CONFIG_HOME") || Path.join(home!(), ".config")
    end
  end

  defp data_root(platform) do
    case platform do
      {:win32, _} -> env!("LOCALAPPDATA")
      {:unix, :darwin} -> Path.join(home!(), "Library/Application Support")
      _ -> System.get_env("XDG_DATA_HOME") || Path.join(home!(), ".local/share")
    end
  end

  defp state_root(platform) do
    case platform do
      {:win32, _} -> env!("LOCALAPPDATA")
      {:unix, :darwin} -> Path.join(home!(), "Library/Logs")
      _ -> System.get_env("XDG_STATE_HOME") || Path.join(home!(), ".local/state")
    end
  end

  defp home!, do: System.user_home() || raise("cannot resolve the current user's home directory")
  defp env!(name), do: System.get_env(name) || raise("#{name} is required on this platform")
end
