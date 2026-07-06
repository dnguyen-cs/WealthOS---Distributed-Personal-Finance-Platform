'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { formatCurrencyCompact, formatDate } from '@/lib/format';
import type { JobStatusPayload } from '@/lib/wealthsim/jobs';
import type { SimulationRequest } from '@/lib/wealthsim/types';
import { ResultsChart } from '@/components/wealthsim/ResultsChart';
import { RunSimulationForm } from '@/components/wealthsim/RunSimulationForm';

export interface RecentJob {
  id: string;
  status: string;
  pathCount: number;
  years: number;
  createdAt: string;
  medianAtHorizon: number | null;
}

interface Props {
  defaultInitialValue: number;
  recentJobs: RecentJob[];
}

export function SimulationsPanel({ defaultInitialValue, recentJobs }: Props) {
  const router = useRouter();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [payload, setPayload] = useState<JobStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const response = await fetch(`/api/wealthsim/jobs/${activeJobId}`);
        if (!response.ok) throw new Error(`status ${response.status}`);
        const data: JobStatusPayload = await response.json();
        if (cancelled) return;
        setPayload(data);
        if (data.status === 'completed') {
          // refresh the server-rendered recent-runs list
          router.refresh();
        } else if (data.status === 'failed') {
          setError(data.error ?? 'Simulation failed.');
        } else {
          timer = setTimeout(tick, 1000);
        }
      } catch {
        if (!cancelled) setError('Failed to fetch simulation status.');
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeJobId, router]);

  async function submit(request: SimulationRequest) {
    setError(null);
    setPayload(null);
    setSubmitting(true);
    try {
      const response = await fetch('/api/wealthsim/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const data = await response.json();
      if (response.status !== 202) {
        setError(data.error ?? 'Failed to start simulation.');
        return;
      }
      setActiveJobId(data.jobId);
    } catch {
      setError('Failed to start simulation.');
    } finally {
      setSubmitting(false);
    }
  }

  const inFlight =
    submitting || (payload !== null && (payload.status === 'queued' || payload.status === 'running'));
  const result = payload?.status === 'completed' ? payload.result : null;
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
          />
        </div>
        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {payload && payload.status !== 'completed' && payload.status !== 'failed' && (
          <div className="mt-4">
            <p className="text-sm opacity-60">
              Computing… {payload.chunksCompleted} of {payload.chunkCount} chunks done
            </p>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
              <div
                className="h-full rounded-full bg-[#1c5cab] transition-[width] duration-500 dark:bg-[#3987e5]"
                style={{ width: `${(payload.chunksCompleted / payload.chunkCount) * 100}%` }}
              />
            </div>
          </div>
        )}
      </section>

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
            paths/s effective) across {payload?.chunkCount} chunks.
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
                    setActiveJobId(job.id);
                  }}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span>
                    {formatDate(new Date(job.createdAt))} ·{' '}
                    {job.pathCount.toLocaleString('en-US')} paths · {job.years}y
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
