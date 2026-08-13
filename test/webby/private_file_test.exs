defmodule Webby.PrivateFileTest do
  use ExUnit.Case, async: true

  import Bitwise

  test "creates an owner-only value and reuses it" do
    root = temporary_root()
    path = Path.join(root, "private-value")

    assert {:ok, "first"} = Webby.PrivateFile.read_or_create(path, fn -> "first" end)
    assert {:ok, "first"} = Webby.PrivateFile.read_or_create(path, fn -> "second" end)
    assert band(File.stat!(path).mode, 0o777) == 0o600
    assert band(File.stat!(root).mode, 0o777) == 0o700

    File.rm_rf!(root)
  end

  test "concurrent creators all return the winner" do
    root = temporary_root()
    path = Path.join(root, "private-value")

    values =
      1..20
      |> Task.async_stream(
        fn candidate ->
          Webby.PrivateFile.read_or_create(path, fn -> Integer.to_string(candidate) end)
        end,
        max_concurrency: 20
      )
      |> Enum.map(fn {:ok, {:ok, value}} -> value end)

    assert Enum.uniq(values) == [File.read!(path) |> String.trim()]
    File.rm_rf!(root)
  end

  test "returns filesystem errors" do
    root = temporary_root()
    path = Path.join(root, "directory")
    File.mkdir_p!(path)

    assert {:error, :eisdir} = Webby.PrivateFile.read_or_create(path, fn -> "unused" end)
    File.rm_rf!(root)
  end

  defp temporary_root do
    Path.join(System.tmp_dir!(), "webby-private-#{System.unique_integer([:positive])}")
  end
end
