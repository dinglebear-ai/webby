defmodule Webby.PathsTest do
  use ExUnit.Case, async: false

  test "Linux paths follow XDG overrides" do
    with_env(
      %{
        "XDG_CONFIG_HOME" => "/tmp/webby-config",
        "XDG_DATA_HOME" => "/tmp/webby-data",
        "XDG_STATE_HOME" => "/tmp/webby-state"
      },
      fn ->
        platform = {:unix, :linux}

        assert Webby.Paths.config_dir(platform) == "/tmp/webby-config/webby"
        assert Webby.Paths.data_dir(platform) == "/tmp/webby-data/webby"
        assert Webby.Paths.state_dir(platform) == "/tmp/webby-state/webby"
        assert Webby.Paths.runtime_file(platform) == "/tmp/webby-config/webby/runtime.json"
        assert Webby.Paths.secret_file(platform) == "/tmp/webby-config/webby/secret-key-base"
      end
    )
  end

  test "macOS paths use the application support and logs conventions" do
    home = System.user_home!()
    platform = {:unix, :darwin}

    assert Webby.Paths.config_dir(platform) ==
             Path.join(home, "Library/Application Support/Webby")

    assert Webby.Paths.data_dir(platform) == Path.join(home, "Library/Application Support/Webby")
    assert Webby.Paths.state_dir(platform) == Path.join(home, "Library/Logs/Webby")
  end

  defp with_env(values, fun) do
    previous = Map.new(values, fn {name, _value} -> {name, System.get_env(name)} end)
    Enum.each(values, fn {name, value} -> System.put_env(name, value) end)

    try do
      fun.()
    after
      Enum.each(previous, fn
        {name, nil} -> System.delete_env(name)
        {name, value} -> System.put_env(name, value)
      end)
    end
  end
end
