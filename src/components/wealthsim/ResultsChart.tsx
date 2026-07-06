'use client';

import { useRef, useState } from 'react';

import { formatCurrency, formatCurrencyCompact } from '@/lib/format';
import type { YearlyStat } from '@/lib/wealthsim/types';

// Fan chart: one subject (the portfolio) over time, so a single blue ramp
// carries everything - outer p10-p90 band, inner p25-p75 band, median
// line. Ramp steps validated against both app surfaces (white / #0a0a0a):
// light 250/350/550, dark 600/500/400.

const WIDTH = 720;
const HEIGHT = 340;
const MARGIN = { left: 64, right: 56, top: 14, bottom: 30 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;

function niceTicks(max: number, targetCount = 5): number[] {
  const magnitude = 10 ** Math.floor(Math.log10(max / targetCount));
  let best: number[] = [0, max];
  let bestDistance = Infinity;
  for (const base of [1, 2, 2.5, 5, 10]) {
    const step = base * magnitude;
    const count = Math.floor(max / step) + 1;
    const distance = Math.abs(count - targetCount);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = Array.from({ length: count }, (_, index) => index * step);
    }
  }
  return best;
}

export function ResultsChart({ yearlyStats }: { yearlyStats: YearlyStat[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverYear, setHoverYear] = useState<number | null>(null);

  const maxYear = yearlyStats[yearlyStats.length - 1].year;
  const domainMax = Math.max(...yearlyStats.map((s) => s.p90)) * 1.05;

  const x = (year: number) => MARGIN.left + (year / maxYear) * PLOT_W;
  const y = (value: number) => MARGIN.top + (1 - value / domainMax) * PLOT_H;

  const bandPath = (upper: keyof YearlyStat, lower: keyof YearlyStat) => {
    const up = yearlyStats.map((s) => `${x(s.year)},${y(s[upper])}`).join('L');
    const down = [...yearlyStats]
      .reverse()
      .map((s) => `${x(s.year)},${y(s[lower])}`)
      .join('L');
    return `M${up}L${down}Z`;
  };

  const medianPath = `M${yearlyStats.map((s) => `${x(s.year)},${y(s.p50)}`).join('L')}`;

  const yTicks = niceTicks(domainMax).filter((tick) => tick <= domainMax);
  const xStep = maxYear <= 12 ? 2 : 5;
  const xTicks = yearlyStats.map((s) => s.year).filter((year) => year % xStep === 0);

  const last = yearlyStats[yearlyStats.length - 1];
  // Keep the three edge labels from colliding when bands are narrow
  const labelY = { p90: y(last.p90), p50: y(last.p50), p10: y(last.p10) };
  if (labelY.p50 - labelY.p90 < 14) labelY.p50 = labelY.p90 + 14;
  if (labelY.p10 - labelY.p50 < 14) labelY.p10 = labelY.p50 + 14;

  const hovered = hoverYear === null ? null : yearlyStats[hoverYear];

  function handlePointerMove(event: React.PointerEvent<SVGRectElement>) {
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const plotX = ((event.clientX - rect.left) / rect.width) * WIDTH - MARGIN.left;
    const year = Math.round((plotX / PLOT_W) * maxYear);
    setHoverYear(Math.min(Math.max(year, 0), maxYear));
  }

  return (
    <div ref={containerRef} className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Projected portfolio value over ${maxYear} years: median, 25th-75th and 10th-90th percentile bands`}
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={y(tick)}
              y2={y(tick)}
              className={
                tick === 0 ? 'stroke-[#c3c2b7] dark:stroke-[#383835]' : 'stroke-[#e1e0d9] dark:stroke-[#2c2c2a]'
              }
              strokeWidth={1}
            />
            <text
              x={MARGIN.left - 8}
              y={y(tick) + 4}
              textAnchor="end"
              className="fill-[#898781] text-[11px] tabular-nums"
            >
              {formatCurrencyCompact(tick)}
            </text>
          </g>
        ))}
        {xTicks.map((year) => (
          <text
            key={year}
            x={x(year)}
            y={HEIGHT - MARGIN.bottom + 18}
            textAnchor="middle"
            className="fill-[#898781] text-[11px] tabular-nums"
          >
            {year === 0 ? 'now' : `${year}y`}
          </text>
        ))}

        <path d={bandPath('p90', 'p10')} className="fill-[#86b6ef] dark:fill-[#184f95]" />
        <path d={bandPath('p75', 'p25')} className="fill-[#5598e7] dark:fill-[#256abf]" />
        <path
          d={medianPath}
          fill="none"
          strokeWidth={2}
          className="stroke-[#1c5cab] dark:stroke-[#3987e5]"
        />

        <text x={WIDTH - MARGIN.right + 6} y={labelY.p90 + 4} className="fill-[#898781] text-[11px]">
          p90
        </text>
        <text x={WIDTH - MARGIN.right + 6} y={labelY.p50 + 4} className="fill-[#898781] text-[11px]">
          median
        </text>
        <text x={WIDTH - MARGIN.right + 6} y={labelY.p10 + 4} className="fill-[#898781] text-[11px]">
          p10
        </text>

        {hovered && (
          <g>
            <line
              x1={x(hovered.year)}
              x2={x(hovered.year)}
              y1={MARGIN.top}
              y2={HEIGHT - MARGIN.bottom}
              strokeWidth={1}
              className="stroke-[#c3c2b7] dark:stroke-[#383835]"
            />
            <circle
              cx={x(hovered.year)}
              cy={y(hovered.p50)}
              r={4}
              strokeWidth={2}
              className="fill-[#1c5cab] stroke-white dark:fill-[#3987e5] dark:stroke-[#0a0a0a]"
            />
          </g>
        )}

        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={PLOT_W}
          height={PLOT_H}
          fill="transparent"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverYear(null)}
        />
      </svg>

      {hovered && (
        <div
          className="pointer-events-none absolute top-2 z-10 rounded-lg border border-black/10 bg-white px-3 py-2 text-xs shadow-sm dark:border-white/15 dark:bg-zinc-900"
          style={{
            left: `${(x(hovered.year) / WIDTH) * 100}%`,
            transform: hovered.year > maxYear * 0.6 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
          }}
        >
          <p className="font-medium">{hovered.year === 0 ? 'Now' : `Year ${hovered.year}`}</p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
            <dt className="opacity-60">p90</dt>
            <dd className="text-right">{formatCurrency(hovered.p90)}</dd>
            <dt className="opacity-60">p75</dt>
            <dd className="text-right">{formatCurrency(hovered.p75)}</dd>
            <dt className="opacity-60">median</dt>
            <dd className="text-right font-medium">{formatCurrency(hovered.p50)}</dd>
            <dt className="opacity-60">p25</dt>
            <dd className="text-right">{formatCurrency(hovered.p25)}</dd>
            <dt className="opacity-60">p10</dt>
            <dd className="text-right">{formatCurrency(hovered.p10)}</dd>
            <dt className="opacity-60">mean</dt>
            <dd className="text-right">{formatCurrency(hovered.mean)}</dd>
          </dl>
        </div>
      )}

      <p className="mt-2 text-xs opacity-60">
        Shaded bands: 10th-90th (outer) and 25th-75th (inner) percentiles. Line: median outcome.
      </p>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer opacity-70">View as table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs tabular-nums">
            <thead>
              <tr className="border-b border-black/10 opacity-60 dark:border-white/15">
                <th className="py-1.5 pr-3 font-medium">Year</th>
                <th className="py-1.5 pr-3 font-medium">p10</th>
                <th className="py-1.5 pr-3 font-medium">p25</th>
                <th className="py-1.5 pr-3 font-medium">Median</th>
                <th className="py-1.5 pr-3 font-medium">p75</th>
                <th className="py-1.5 pr-3 font-medium">p90</th>
                <th className="py-1.5 font-medium">Mean</th>
              </tr>
            </thead>
            <tbody>
              {yearlyStats.map((s) => (
                <tr key={s.year} className="border-b border-black/5 dark:border-white/10">
                  <td className="py-1.5 pr-3">{s.year}</td>
                  <td className="py-1.5 pr-3">{formatCurrency(s.p10)}</td>
                  <td className="py-1.5 pr-3">{formatCurrency(s.p25)}</td>
                  <td className="py-1.5 pr-3 font-medium">{formatCurrency(s.p50)}</td>
                  <td className="py-1.5 pr-3">{formatCurrency(s.p75)}</td>
                  <td className="py-1.5 pr-3">{formatCurrency(s.p90)}</td>
                  <td className="py-1.5">{formatCurrency(s.mean)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
