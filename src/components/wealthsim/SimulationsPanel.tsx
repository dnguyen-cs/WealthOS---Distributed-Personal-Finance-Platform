'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { formatCurrencyCompact, formatDate } from '@/lib/format';
import type { JobStatusPayload } from '@/lib/wealthsim/jobs';
import { CROSS_ENGINE_TOLERANCE, maxRelativeDivergence } from '@/lib/wealthsim/compare';
import type { Engine, SimulationRequest } from '@/lib/wealthsim/types';
import { ResultsChart } from '@/components/wealthsim/ResultsChart';
import { RunSimulationForm } from '@/components/wealthsim/RunSimulationForm';
import { useJobPolling } from '@/components/wealthsim/useJobPolling';

export interface RecentJob {
  id: string;
  status: string;
  engine: string;
  pathCount: number;
  years: number;
  createdAt: string;
  medianAtHorizon: number | null;
}

interface Props {
  defaultInitialValue: number;
  recentJobs: RecentJob[];
}

interface RaceIds {
  seed: number;
  node: string;
  go: string;
}

const ENGINE_LABEL: Record<Engine, string> = { node: 'Node.js', go: 'Go' };

function settled(payload: JobStatusPayload | null): boolean {
  return payload?.status === 'completed' || payload?.status === 'failed';
}

function RaceLane({
  engine,
  payload,
  error,
}: {
  engine: Engine;
  payload: JobStatusPayload | null;
  error: string | null;
}) {
  const result = payload?.status === 'completed' ? payload.result : null;
  const progress = payload ? payload.chunksCompleted / payload.chunkCount : 0;
  return (
    <div className="rounded-xl border border-black/10 p-4 dark:border-white/15">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{ENGINE_LABEL[engine]}</p>
        <p className="text-sm tabular-nums opacity-70">
          {result
            ? `${(result.wallMs / 1000).toFixed(1)}s`
            : payload?.status === 'failed'
              ? 'failed'
              : payload
                ? `${payload.chunksCompleted}/${payload.chunkCount} chunks`
                : 'starting…'}
        </p>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            payload?.status === 'failed'
              ? 'bg-red-500'
              : 'bg-[#1c5cab] dark:bg-[#3987e5]'
          }`}
          style={{ width: `${(result ? 1 : progress) * 100}%` }}
        />
      </div>
      {(error || payload?.status === 'failed') && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          {payload?.error ?? error ?? 'Run failed.'}
        </p>
      )}
    </div>
  );
}

export function SimulationsPanel({ defaultInitialValue, recentJobs }: Props) {
  const router = useRouter();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [raceIds, setRaceIds] = useState<RaceIds | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const single = useJobPolling(activeJobId);
  const raceNode = useJobPolling(raceIds?.node ?? null);
  const raceGo = useJobPolling(raceIds?.go ?? null);

  // Refresh the server-rendered recent-runs list once runs settle.
  const settledKey = [single.payload?.status, raceNode.payload?.status, raceGo.payload?.status]
    .map((status) => (status === 'completed' ? 'done' : ''))
    .join('|');
  useEffect(() => {
    if (settledKey.includes('done')) router.refresh();
  }, [settledKey, router]);

  async function submitOne(request: SimulationRequest): Promise<string> {
    const response = await fetch('/api/wealthsim/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const data = await response.json();
    if (response.status !== 202) {
      throw new Error(data.error ?? 'Failed to start simulation.');
    }
    return data.jobId as string;
  }

  async function submit(request: SimulationRequest) {
    setError(null);
    setActiveJobId(null);
    setRaceIds(null);
    setSubmitting(true);
    try {
      setActiveJobId(await submitOne(request));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to start simulation.');
    } finally {
      setSubmitting(false);
    }
  }

  async function race(request: Omit<SimulationRequest, 'engine'>) {
    setError(null);
    setActiveJobId(null);
    setRaceIds(null);
    setSubmitting(true);
    // One seed, two engines: the whole point is that identical seeds must
    // produce matching results from two independent implementations.
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
    try {
      const nodeJob = await submitOne({ ...request, seed, engine: 'node' });
      const goJob = await submitOne({ ...request, seed, engine: 'go' });
      setRaceIds({ seed, node: nodeJob, go: goJob });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to start race.');
    } finally {
      setSubmitting(false);
    }
  }

  const raceSettled = raceIds !== null && settled(raceNode.payload) && settled(raceGo.payload);
  const raceNodeResult = raceNode.payload?.status === 'completed' ? raceNode.payload.result : null;
  const raceGoResult = raceGo.payload?.status === 'completed' ? raceGo.payload.result : null;
  const divergence =
    raceNodeResult && raceGoResult
      ? maxRelativeDivergence(raceNodeResult.yearlyStats, raceGoResult.yearlyStats)
      : null;
  const resultsMatch = divergence !== null && divergence <= CROSS_ENGINE_TOLERANCE;
  const winner: Engine | null =
    raceNodeResult && raceGoResult
      ? raceGoResult.wallMs <= raceNodeResult.wallMs
        ? 'go'
        : 'node'
      : null;

  const inFlight =
    submitting ||
    (single.payload !== null && !settled(single.payload)) ||
    (raceIds !== null && !raceSettled);

  // The chart shows the winner's result; in single mode, the run's own.
  // If only one racer completed (the other failed), show that one.
  const displayPayload =
    raceIds !== null
      ? winner === 'node' || (winner === null && raceNodeResult)
        ? raceNode.payload
        : raceGoResult || winner === 'go'
          ? raceGo.payload
          : null
      : single.payload;
  const result = displayPayload?.status === 'completed' ? displayPayload.result : null;
  const horizon = result ? result.yearlyStats[result.yearlyStats.length - 1] : null;

  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-xl border border-black/10 p-5 dark:border-white/15">
        <h2 className="text-lg font-medium">Run a simulation</h2>
        <p className="mt-1 text-sm opacity-60">
          Monte Carlo projection of portfolio value, fanned out across distributed workers.
        </p>
        <div className="mt-4">
          <RunSimulationForm
            defaultInitialValue={defaultInitialValue}
            disabled={inFlight}
            onSubmit={submit}
            onRace={race}
          />
        </div>
        {(error || single.error) && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error ?? single.error}</p>
        )}
        {single.payload && !settled(single.payload) && (
          <div className="mt-4">
            <p className="text-sm opacity-60">
              Computing… {single.payload.chunksCompleted} of {single.payload.chunkCount} chunks done
            </p>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
              <div
                className="h-full rounded-full bg-[#1c5cab] transition-[width] duration-500 dark:bg-[#3987e5]"
                style={{
                  width: `${(single.payload.chunksCompleted / single.payload.chunkCount) * 100}%`,
                }}
              />
            </div>
          </div>
        )}
        {single.payload?.status === 'failed' && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">
            {single.payload.error ?? 'Simulation failed.'}
          </p>
        )}
      </section>

      {raceIds && (
        <section className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-lg font-medium">Engine race</h2>
            <p className="text-xs opacity-60 tabular-nums">seed {raceIds.seed}</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <RaceLane engine="node" payload={raceNode.payload} error={raceNode.error} />
            <RaceLane engine="go" payload={raceGo.payload} error={raceGo.error} />
          </div>
          {raceNodeResult && raceGoResult && winner && (
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                <span className="font-medium">{ENGINE_LABEL[winner]}</span> finished first:{' '}
                <span className="tabular-nums">
                  {(Math.min(raceNodeResult.wallMs, raceGoResult.wallMs) / 1000).toFixed(1)}s vs{' '}
                  {(Math.max(raceNodeResult.wallMs, raceGoResult.wallMs) / 1000).toFixed(1)}s
                </span>
              </p>
              {resultsMatch ? (
                <p className="w-fit rounded-full border border-emerald-600/40 bg-emerald-600/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  Results verified: two independent implementations, max divergence{' '}
                  {divergence === 0 ? '0' : divergence?.toExponential(2)} (floating-point ulps)
                </p>
              ) : (
                <p className="w-fit rounded-full border border-red-600/40 bg-red-600/10 px-3 py-1 text-xs font-medium text-red-700 dark:text-red-400">
                  Results diverge beyond tolerance
                  {divergence !== null ? ` (${divergence.toExponential(2)})` : ' (shape mismatch)'}
                  {' '}- this indicates a kernel bug, not rounding
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {result && horizon && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Projected outcomes</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-xl border border-black/10 p-4 dark:border-white/15">
              <p className="text-sm opacity-60">Median</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {formatCurrencyCompact(horizon.p50)}
              </p>
            </div>
            <div className="rounded-xl border border-black/10 p-4 dark:border-white/15">
              <p className="text-sm opacity-60">Pessimistic (p10)</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {formatCurrencyCompact(horizon.p10)}
              </p>
            </div>
            <div className="rounded-xl border border-black/10 p-4 dark:border-white/15">
              <p className="text-sm opacity-60">Optimistic (p90)</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {formatCurrencyCompact(horizon.p90)}
              </p>
            </div>
            <div className="rounded-xl border border-black/10 p-4 dark:border-white/15">
              <p className="text-sm opacity-60">Mean</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {formatCurrencyCompact(horizon.mean)}
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-black/10 p-5 dark:border-white/15">
            <ResultsChart yearlyStats={result.yearlyStats} />
          </div>

          <p className="text-xs opacity-60 tabular-nums">
            {result.pathsCompleted.toLocaleString('en-US')} paths in {(result.wallMs / 1000).toFixed(1)}s
            wall time ({Math.round(result.pathsCompleted / (result.wallMs / 1000)).toLocaleString('en-US')}{' '}
            paths/s effective) across {displayPayload?.chunkCount} chunks on the{' '}
            {displayPayload?.engine === 'go' ? 'Go' : 'Node.js'} engine.
          </p>
        </section>
      )}

      {recentJobs.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Recent runs</h2>
          <ul className="flex flex-col divide-y divide-black/5 rounded-xl border border-black/10 dark:divide-white/10 dark:border-white/15">
            {recentJobs.map((job) => (
              <li key={job.id}>
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setRaceIds(null);
                    setActiveJobId(job.id);
                  }}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span>
                    {formatDate(new Date(job.createdAt))} ·{' '}
                    {job.pathCount.toLocaleString('en-US')} paths · {job.years}y ·{' '}
                    {job.engine === 'go' ? 'Go' : 'Node.js'}
                  </span>
                  <span className="tabular-nums opacity-70">
                    {job.status === 'completed' && job.medianAtHorizon !== null
                      ? `median ${formatCurrencyCompact(job.medianAtHorizon)}`
                      : job.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
