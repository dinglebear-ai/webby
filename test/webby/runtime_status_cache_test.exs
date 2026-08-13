defmodule Webby.RuntimeStatusCacheTest do
  use ExUnit.Case, async: true

  test "serves concurrent readers from one cached probe" do
    counter = :counters.new(1, [])

    refresh = fn ->
      :counters.add(counter, 1, 1)
      {:ok, %{status: "ok"}}
    end

    cache =
      start_supervised!({Webby.RuntimeStatusCache, name: :test_status_cache, refresh: refresh})

    results =
      1..100
      |> Task.async_stream(fn _ -> Webby.RuntimeStatusCache.snapshot(cache) end)
      |> Enum.to_list()

    assert Enum.all?(results, &match?({:ok, {:ok, %{status: "ok"}}}, &1))
    assert :counters.get(counter, 1) == 1
  end
end
