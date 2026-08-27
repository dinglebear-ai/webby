defmodule Webby.RetentionWorkerTest do
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  test "a failed maintenance run is contained and the worker runs again" do
    counter = start_supervised!({Agent, fn -> 0 end})

    log =
      capture_log(fn ->
        worker =
          start_supervised!(
            {Webby.RetentionWorker,
             maintenance_module: Webby.RetentionMaintenanceStub,
             test_pid: self(),
             run_counter: counter,
             interval_ms: 10}
          )

        assert_receive {:maintenance_run, 1}
        assert_receive {:maintenance_run, 2}, 100
        assert is_pid(worker)
      end)

    assert log =~ "retention maintenance crashed"
    assert log =~ "simulated maintenance failure"
  end
end
