defmodule Mix.Tasks.Webby.Contracts.Check do
  @shortdoc "Reports drift between Webby and its pinned upstream specifications"

  @moduledoc """
  Compares the upstream contracts recorded in `priv/contracts/upstream.lock.json`
  against their live sources, and reports what has moved.

      mix webby.contracts.check
      mix webby.contracts.check --format markdown
      mix webby.contracts.check --format markdown --output report.md
      mix webby.contracts.check --update

  ## Options

    * `--format` - `human` (default) or `markdown`. Markdown is what CI posts
      into the tracking issue.
    * `--output` - write the report to a path instead of stdout, and print
      nothing but a confirmation. Anything consuming the report verbatim
      should use this: Mix writes dependency-compilation progress to stdout,
      so capturing stdout can splice build noise into the report.
    * `--update` - rewrite the lock file to the observed state. Use this when
      adopting upstream changes, after reviewing them.
    * `--exit-code` - exit 1 when drift is found. Off by default so that a
      scheduled check reports without failing the run.

  Network failures are reported and exit 2 regardless of `--exit-code`: an
  unreachable upstream is an unknown, not a clean result.
  """

  use Mix.Task

  alias Webby.UpstreamContracts

  @requirements ["app.config"]

  @impl Mix.Task
  def run(argv) do
    {opts, _argv} =
      OptionParser.parse!(argv,
        strict: [format: :string, output: :string, update: :boolean, exit_code: :boolean]
      )

    Application.ensure_all_started(:req)

    case UpstreamContracts.load_lock() do
      {:ok, lock} -> check(lock, opts)
      {:error, reason} -> abort("could not read lock file: #{reason}")
    end
  end

  defp check(lock, opts) do
    {observed, errors} = UpstreamContracts.observe(lock)
    drift = lock |> UpstreamContracts.diff(observed) |> UpstreamContracts.explain()
    alignment = alignment(lock, observed)

    if opts[:update], do: update_lock(lock, observed, errors)

    case opts[:output] do
      nil -> report(drift, alignment, errors, opts[:format] || "human")
      path -> write_report(path, drift, alignment, errors)
    end

    cond do
      errors != [] -> exit({:shutdown, 2})
      drift != [] and opts[:exit_code] -> exit({:shutdown, 1})
      true -> :ok
    end
  end

  defp alignment(lock, observed) do
    tags = get_in(observed, ["mcp-spec", "tags"]) || []
    _ = lock
    UpstreamContracts.protocol_alignment(tags)
  end

  defp update_lock(_lock, _observed, errors) when errors != [] do
    Mix.shell().error("refusing to --update: some contracts could not be observed")
  end

  defp update_lock(lock, observed, _errors) do
    path = UpstreamContracts.lock_path()
    today = Date.utc_today() |> Date.to_iso8601()
    File.write!(path, UpstreamContracts.apply_observations(lock, observed, today))
    Mix.shell().info("updated #{path}")
  end

  # The report is the whole payload for anything consuming it, so it is written
  # straight to the path rather than teed off stdout, which Mix shares with
  # dependency-compilation progress.
  defp write_report(path, drift, alignment, errors) do
    File.write!(path, UpstreamContracts.render(drift, alignment, errors))
    Mix.shell().info("wrote #{path}")
  end

  defp report(drift, alignment, errors, "markdown") do
    case UpstreamContracts.render(drift, alignment, errors) do
      "" -> Mix.shell().info("All upstream contracts match their pinned state.")
      report -> Mix.shell().info(report)
    end
  end

  defp report(drift, alignment, errors, _human) do
    Enum.each(errors, fn {id, reason} ->
      Mix.shell().error("unreachable  #{id}: #{reason}")
    end)

    if alignment.behind? do
      Mix.shell().info(
        "mcp version  webby advertises #{alignment.webby_latest}, " <>
          "upstream latest is #{alignment.upstream_latest}"
      )
    end

    Enum.each(alignment.unknown_versions, fn version ->
      Mix.shell().error("mcp version  #{version} is not a published upstream release")
    end)

    Enum.each(drift, fn entry ->
      Mix.shell().info("drift        #{entry.id} #{entry.key}: #{entry.locked} -> #{entry.live}")
    end)

    if drift == [] and errors == [] and not alignment.behind? do
      Mix.shell().info("All upstream contracts match their pinned state.")
    end
  end

  defp abort(message) do
    Mix.shell().error(message)
    exit({:shutdown, 2})
  end
end
