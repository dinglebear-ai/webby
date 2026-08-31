defmodule Webby.InvocationsTest do
  use ExUnit.Case, async: true

  alias Webby.Invocations

  test "audit completion retries SQLite lock failures and then succeeds" do
    attempts = start_supervised!({Agent, fn -> 0 end})

    update_fun = fn _id, _outcome, _error_kind, _duration ->
      attempt = Agent.get_and_update(attempts, fn count -> {count + 1, count + 1} end)

      if attempt < 3,
        do: raise(Exqlite.Error, message: "database is locked"),
        else: {1, nil}
    end

    assert {:ok, :completed} =
             Invocations.complete_audit("audit-id", "succeeded", nil, 12,
               attempts: 3,
               update_fun: update_fun
             )

    assert Agent.get(attempts, & &1) == 3
  end

  test "audit completion returns exhausted transient failure with its stacktrace" do
    update_fun = fn _id, _outcome, _error_kind, _duration ->
      raise Exqlite.Error, message: "database is busy"
    end

    assert {:error, {%Exqlite.Error{message: "database is busy"}, stacktrace}} =
             Invocations.complete_audit("audit-id", "failed", "timeout", 12,
               attempts: 2,
               update_fun: update_fun
             )

    assert is_list(stacktrace)
    assert stacktrace != []
  end

  test "audit completion does not retry unexpected failures" do
    attempts = start_supervised!({Agent, fn -> 0 end})

    update_fun = fn _id, _outcome, _error_kind, _duration ->
      Agent.update(attempts, &(&1 + 1))
      raise ArgumentError, "unexpected completion defect"
    end

    assert_raise ArgumentError, "unexpected completion defect", fn ->
      Invocations.complete_audit("audit-id", "failed", "internal", 12,
        attempts: 3,
        update_fun: update_fun
      )
    end

    assert Agent.get(attempts, & &1) == 1
  end

  test "independent audit completions are not globally serialized" do
    parent = self()

    update_fun = fn id, _outcome, _error_kind, _duration ->
      send(parent, {:entered, id})
      assert_receive :release
      {1, nil}
    end

    tasks =
      for id <- ["first", "second"] do
        Task.async(fn ->
          Invocations.complete_audit(id, "failed", "caller_down", 0, update_fun: update_fun)
        end)
      end

    assert MapSet.new(receive_entered(2)) == MapSet.new(["first", "second"])
    Enum.each(tasks, &send(&1.pid, :release))
    Enum.each(tasks, &assert({:ok, :completed} = Task.await(&1)))
  end

  defp receive_entered(0), do: []

  defp receive_entered(remaining) do
    receive do
      {:entered, id} -> [id | receive_entered(remaining - 1)]
    end
  end
end
