defmodule Webby.RetentionMaintenanceStub do
  @moduledoc false

  def maintain(state) do
    test_pid = Keyword.fetch!(state, :test_pid)

    run =
      Agent.get_and_update(Keyword.fetch!(state, :run_counter), fn count ->
        {count + 1, count + 1}
      end)

    send(test_pid, {:maintenance_run, run})

    case Keyword.get(state, :behavior, :fail_first) do
      :fail_first ->
        if run == 1, do: raise("simulated maintenance failure"), else: {:ok, %{}}

      responses when is_list(responses) ->
        Enum.at(responses, run - 1, List.last(responses))
    end
  end
end
