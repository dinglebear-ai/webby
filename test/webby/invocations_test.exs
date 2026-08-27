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
end
