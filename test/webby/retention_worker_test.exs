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
        assert_receive {:maintenance_run, 2}, 1_000
        assert is_pid(worker)
      end)

    assert log =~ "retention maintenance crashed"
    assert log =~ "simulated maintenance failure"
  end

  test "continues immediately while a full batch indicates a retention backlog" do
    counter = start_supervised!({Agent, fn -> 0 end})

    worker =
      start_supervised!(
        {Webby.RetentionWorker,
         maintenance_module: Webby.RetentionMaintenanceStub,
         behavior: [
           {:ok, %{discoveries: 2}},
           {:ok, %{discoveries: 2}},
           {:ok, %{discoveries: 1}}
         ],
         test_pid: self(),
         run_counter: counter,
         batch_size: 2,
         interval_ms: 60_000}
      )

    assert_receive {:maintenance_run, 1}
    assert_receive {:maintenance_run, 2}
    assert_receive {:maintenance_run, 3}
    refute_receive {:maintenance_run, 4}, 50
    assert is_pid(worker)
  end

  test "yields after its batch budget and resumes draining the backlog" do
    counter = start_supervised!({Agent, fn -> 0 end})

    worker =
      start_supervised!(
        {Webby.RetentionWorker,
         maintenance_module: Webby.RetentionMaintenanceStub,
         behavior: [{:ok, %{discoveries: 1}}],
         test_pid: self(),
         run_counter: counter,
         batch_size: 1,
         interval_ms: 60_000}
      )

    for run <- 1..11 do
      assert_receive {:maintenance_run, ^run}, 1_000
    end

    assert is_pid(worker)
  end
end
