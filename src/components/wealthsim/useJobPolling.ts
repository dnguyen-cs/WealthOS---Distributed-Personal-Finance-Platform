'use client';

import { useEffect, useState } from 'react';

import type { JobStatusPayload } from '@/lib/wealthsim/jobs';

interface PollState {
  jobId: string;
  payload: JobStatusPayload | null;
  error: string | null;
}

// Polls one job's status endpoint until it settles. Instantiated once for
// a single run and twice for race mode (one poller per engine's job).
// State is keyed by jobId and filtered on read, so switching jobs never
// shows a stale payload and needs no reset-inside-effect.
export function useJobPolling(jobId: string | null): {
  payload: JobStatusPayload | null;
  error: string | null;
} {
  const [state, setState] = useState<PollState | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const response = await fetch(`/api/wealthsim/jobs/${jobId}`);
        if (!response.ok) throw new Error(`status ${response.status}`);
        const data: JobStatusPayload = await response.json();
        if (cancelled) return;
        setState({ jobId: jobId as string, payload: data, error: null });
        if (data.status !== 'completed' && data.status !== 'failed') {
          timer = setTimeout(tick, 1000);
        }
      } catch {
        if (cancelled) return;
        setState((previous) => ({
          jobId: jobId as string,
          payload: previous?.jobId === jobId ? previous.payload : null,
          error: 'Failed to fetch simulation status.',
        }));
      }
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  if (!jobId || state?.jobId !== jobId) return { payload: null, error: null };
  return { payload: state.payload, error: state.error };
}
