'use client';

import { useState } from 'react';

import type { Engine, SimulationRequest } from '@/lib/wealthsim/types';

const PATH_COUNT_OPTIONS = [
  { value: 100_000, label: '100K paths' },
  { value: 500_000, label: '500K paths' },
  { value: 1_000_000, label: '1M paths' },
  { value: 2_000_000, label: '2M paths' },
  { value: 5_000_000, label: '5M paths' },
];

// Same kernel contract, two implementations; results are parity-tested
// interchangeable, so this is a routing choice, not a math choice.
const ENGINE_OPTIONS: Array<{ value: Engine; label: string }> = [
  { value: 'node', label: 'Node.js workers' },
  { value: 'go', label: 'Go workers' },
];

const inputClassName =
  'rounded-md border border-black/15 bg-transparent px-3 py-2 outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50';

interface Props {
  defaultInitialValue: number;
  disabled: boolean;
  onSubmit: (request: SimulationRequest) => void;
  /** Race mode: run the same request (same seed) on both engines at once. */
  onRace: (request: Omit<SimulationRequest, 'engine'>) => void;
}

export function RunSimulationForm({ defaultInitialValue, disabled, onSubmit, onRace }: Props) {
  const [initialValue, setInitialValue] = useState(String(defaultInitialValue));
  const [annualContribution, setAnnualContribution] = useState('12000');
  const [meanReturnPct, setMeanReturnPct] = useState('7');
  const [volatilityPct, setVolatilityPct] = useState('15');
  const [years, setYears] = useState('30');
  const [pathCount, setPathCount] = useState(1_000_000);
  const [engine, setEngine] = useState<Engine>('node');

  function baseRequest(): Omit<SimulationRequest, 'engine'> {
    return {
      initialValue: Number(initialValue),
      annualContribution: Number(annualContribution),
      meanReturn: Number(meanReturnPct) / 100,
      volatility: Number(volatilityPct) / 100,
      years: Number(years),
      pathCount,
      antithetic: true,
    };
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({ ...baseRequest(), engine });
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      <label className="flex flex-col gap-1 text-sm">
        Starting value ($)
        <input
          type="number"
          required
          min={1}
          max={1e12}
          step="any"
          value={initialValue}
          onChange={(e) => setInitialValue(e.target.value)}
          className={inputClassName}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Yearly contribution ($)
        <input
          type="number"
          required
          min={0}
          max={1e9}
          step="any"
          value={annualContribution}
          onChange={(e) => setAnnualContribution(e.target.value)}
          className={inputClassName}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Expected return (%/yr)
        <input
          type="number"
          required
          min={-50}
          max={50}
          step="0.1"
          value={meanReturnPct}
          onChange={(e) => setMeanReturnPct(e.target.value)}
          className={inputClassName}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Volatility (%/yr)
        <input
          type="number"
          required
          min={0}
          max={100}
          step="0.1"
          value={volatilityPct}
          onChange={(e) => setVolatilityPct(e.target.value)}
          className={inputClassName}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Horizon (years)
        <input
          type="number"
          required
          min={1}
          max={60}
          value={years}
          onChange={(e) => setYears(e.target.value)}
          className={inputClassName}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Simulation size
        <select
          value={pathCount}
          onChange={(e) => setPathCount(Number(e.target.value))}
          className={inputClassName}
        >
          {PATH_COUNT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Compute engine
        <select
          value={engine}
          onChange={(e) => setEngine(e.target.value as Engine)}
          className={inputClassName}
        >
          {ENGINE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="col-span-2 flex flex-wrap items-center gap-3 sm:col-span-3">
        <button
          type="submit"
          disabled={disabled}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-50"
        >
          {disabled ? 'Running…' : 'Run simulation'}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onRace(baseRequest())}
          className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/5"
        >
          Race both engines
        </button>
        <span className="text-xs opacity-60">
          Race mode runs the identical seed on Node.js and Go simultaneously, then verifies the
          results match.
        </span>
      </div>
    </form>
  );
}
