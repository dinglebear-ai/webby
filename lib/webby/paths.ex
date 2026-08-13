defmodule Webby.Paths do
  @moduledoc "Platform-aware locations for Webby's local configuration and state."

  def config_dir, do: Path.join(config_root(), app_dir())
  def data_dir, do: Path.join(data_root(), app_dir())
  def state_dir, do: Path.join(state_root(), app_dir())
  def runtime_file, do: Path.join(config_dir(), "runtime.json")
  def instance_file, do: Path.join(config_dir(), "instance-id")
  def secret_file, do: Path.join(config_dir(), "secret-key-base")

  defp app_dir do
    case :os.type() do
      {:unix, :darwin} -> "Webby"
      _ -> "webby"
    end
  end

  defp config_root do
    case :os.type() do
      {:win32, _} -> env!("LOCALAPPDATA")
      {:unix, :darwin} -> Path.join(home!(), "Library/Application Support")
      _ -> System.get_env("XDG_CONFIG_HOME") || Path.join(home!(), ".config")
    end
  end

  defp data_root do
    case :os.type() do
      {:win32, _} -> env!("LOCALAPPDATA")
      {:unix, :darwin} -> Path.join(home!(), "Library/Application Support")
      _ -> System.get_env("XDG_DATA_HOME") || Path.join(home!(), ".local/share")
    end
  end

  defp state_root do
    case :os.type() do
      {:win32, _} -> env!("LOCALAPPDATA")
      {:unix, :darwin} -> Path.join(home!(), "Library/Logs")
      _ -> System.get_env("XDG_STATE_HOME") || Path.join(home!(), ".local/state")
    end
  end

  defp home!, do: System.user_home() || raise("cannot resolve the current user's home directory")
  defp env!(name), do: System.get_env(name) || raise("#{name} is required on this platform")
end
