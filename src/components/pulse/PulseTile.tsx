'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { PulseSnapshot } from '@/lib/pulse/read';
import type { PulseBar } from '@/lib/pulse/types';

// PortfolioPulse dashboard tile: live crypto quotes with 1-minute
// sparklines, session controls, and the pipeline latency readout.
// Polling doubles as the viewer keepalive (the API touches the VIEWERS
// item), so an open dashboard is what keeps a session alive.

const LIVE_POLL_MS = 1_500;
const IDLE_POLL_MS = 8_000;

function formatPrice(price: number): string {
  return price.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

interface SparkPoint {
  ts: number;
  value: number;
}

function Sparkline({ points }: { points: SparkPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const width = 120;
  const height = 34;
  const pad = 3;

  if (points.length < 2) {
    return (
      <div className="flex h-[34px] items-center text-xs opacity-40">collecting data…</div>
    );
  }

  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index: number) => pad + (index / (points.length - 1)) * (width - 2 * pad);
  const y = (value: number) => height - pad - ((value - min) / span) * (height - 2 * pad);
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`)
    .join(' ');

  function onMove(event: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relative = ((event.clientX - rect.left) / rect.width) * width;
    const index = Math.round(((relative - pad) / (width - 2 * pad)) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, index)));
  }

  const hovered = hover !== null ? points[hover] : null;

  return (
    <div className="relative text-[#1c5cab] dark:text-[#3987e5]">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="h-[34px] w-full cursor-crosshair"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="price sparkline"
      >
        <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        {hover !== null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={0}
              y2={height}
              stroke="currentColor"
              strokeWidth="1"
              opacity="0.35"
            />
            <circle cx={x(hover)} cy={y(points[hover].value)} r="3" fill="currentColor" />
          </>
        )}
      </svg>
      {hovered && (
        <div className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-black/10 bg-background px-1.5 py-0.5 text-[10px] tabular-nums shadow-sm dark:border-white/15">
          {formatPrice(hovered.value)} ·{' '}
          {new Date(hovered.ts).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
      )}
    </div>
  );
}

function symbolPoints(bars: PulseBar[], latestPrice: number | null, latestTs: number | null) {
  const chronological = [...bars].sort((a, b) => a.minuteTs - b.minuteTs);
  const points: SparkPoint[] = chronological.map((bar) => ({ ts: bar.closeTs, value: bar.close }));
  if (latestPrice !== null && latestTs !== null) {
    const last = points[points.length - 1];
    if (!last || latestTs > last.ts) points.push({ ts: latestTs, value: latestPrice });
  }
  return points;
}

export function PulseTile() {
  const [snapshot, setSnapshot] = useState<PulseSnapshot | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = snapshot?.session?.status === 'live';
  const sessionStatus = snapshot?.session?.status ?? 'idle';

  const poll = useCallback(async () => {
    try {
      const response = await fetch('/api/pulse');
      if (!response.ok) throw new Error(`status ${response.status}`);
      setSnapshot((await response.json()) as PulseSnapshot);
      setSnapshotAt(Date.now());
      setError(null);
    } catch {
      setError('Pulse data unavailable.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      await poll();
      if (!cancelled) {
        timer = setTimeout(tick, live || starting ? LIVE_POLL_MS : IDLE_POLL_MS);
      }
    }
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [poll, live, starting]);

  async function goLive() {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch('/api/pulse/session', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Failed to start session.');
      if (!data.managed) {
        setError(
          'Local mode: start the ingest with scripts/pulse-ingest-local.ts to go live.',
        );
      }
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Failed to start session.');
    } finally {
      // stay in "starting" polling cadence; the snapshot flips us to live
      setTimeout(() => setStarting(false), 15_000);
    }
  }

  // Elapsed is derived from the poll timestamp, not a render-time clock:
  // it advances with each poll, which is exactly the tile's refresh rate.
  const elapsedSeconds =
    live && snapshot?.session?.startedAt && snapshotAt !== null
      ? Math.max(0, Math.round((snapshotAt - snapshot.session.startedAt) / 1000))
      : null;

  return (
    <section className="rounded-xl border border-black/10 p-5 dark:border-white/15">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-medium">PortfolioPulse</h2>
          {live ? (
            <span className="flex items-center gap-1.5 rounded-full border border-emerald-600/40 bg-emerald-600/10 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              LIVE{elapsedSeconds !== null ? ` · ${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}` : ''}
            </span>
          ) : sessionStatus === 'starting' || starting ? (
            <span className="text-xs opacity-60">starting session…</span>
          ) : null}
        </div>
        {!live && sessionStatus !== 'starting' && (
          <button
            type="button"
            onClick={goLive}
            disabled={starting}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-50"
          >
            {starting ? 'Starting…' : 'Go live'}
          </button>
        )}
      </div>
      <p className="mt-1 text-sm opacity-60">
        Live crypto trades streamed through Kinesis into 1-minute bars; sessions scale to zero
        when nobody is watching.
      </p>

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {snapshot && snapshot.quotes.length > 0 && (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {snapshot.quotes.map((quote) => {
            const bars = snapshot.bars[quote.symbol] ?? [];
            const points = symbolPoints(bars, quote.price, quote.exchangeTs);
            const first = points[0]?.value ?? quote.price;
            const deltaPct = ((quote.price - first) / first) * 100;
            const deltaUp = deltaPct >= 0;
            return (
              <div
                key={quote.symbol}
                className="rounded-lg border border-black/10 p-3 dark:border-white/15"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">{quote.symbol}</p>
                  <p
                    className={`text-xs tabular-nums ${
                      deltaUp
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-red-700 dark:text-red-400'
                    }`}
                  >
                    {deltaUp ? '+' : ''}
                    {deltaPct.toFixed(2)}%
                  </p>
                </div>
                <p className="mt-1 text-xl font-semibold tabular-nums">
                  {formatPrice(quote.price)}
                </p>
                <div className="mt-2">
                  <Sparkline points={points} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {snapshot && snapshot.quotes.length === 0 && !live && (
        <p className="mt-4 text-sm opacity-60">
          No market data yet - go live to start streaming.
        </p>
      )}

      {snapshot?.stats && live && (
        <p className="mt-3 text-xs opacity-60 tabular-nums">
          pipeline p50 {Math.round(snapshot.stats.pipelineP50Ms)} ms · p99{' '}
          {Math.round(snapshot.stats.pipelineP99Ms)} ms · {Math.round(snapshot.stats.eventsPerSec)}{' '}
          events/s · last batch {snapshot.stats.sampleCount} trades
        </p>
      )}
    </section>
  );
}
