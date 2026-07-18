import { describe, expect, it } from 'vitest';

import { barFromEvent, foldEvents, mergeBars, minuteOf, percentile } from '@/lib/pulse/bars';
import type { PulseBar, PulseEvent } from '@/lib/pulse/types';

function syntheticEvents(count: number, seed = 42): PulseEvent[] {
  // Small deterministic LCG so failures reproduce.
  let state = seed >>> 0;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const base = 1_784_300_000_000;
  return Array.from({ length: count }, () => ({
    symbol: 'BTC-USD',
    price: 100 + rand() * 10,
    size: rand(),
    exchangeTs: base + Math.floor(rand() * 120_000),
    ingestTs: base + 130_000,
  }));
}

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function foldSequential(events: PulseEvent[]): Map<string, PulseBar> {
  const bars = new Map<string, PulseBar>();
  for (const event of events) {
    const key = `${event.symbol}|${minuteOf(event.exchangeTs)}`;
    const partial = barFromEvent(event);
    const existing = bars.get(key);
    bars.set(key, existing ? mergeBars(existing, partial) : partial);
  }
  return bars;
}

describe('pulse bar merges', () => {
  it('is order-insensitive: any shuffle and any partition merge to the same bars', () => {
    const events = syntheticEvents(500);
    const reference = foldSequential(events);

    for (const seed of [1, 7, 99]) {
      const order = shuffled(events, seed);
      // random partition into three chunks folded separately, then merged
      const cut1 = 100 + (seed * 37) % 200;
      const cut2 = cut1 + 50 + (seed * 61) % 150;
      const parts = [order.slice(0, cut1), order.slice(cut1, cut2), order.slice(cut2)];
      const merged = new Map<string, PulseBar>();
      for (const part of parts) {
        for (const [key, bar] of foldSequential(part)) {
          const existing = merged.get(key);
          merged.set(key, existing ? mergeBars(existing, bar) : bar);
        }
      }
      expect(Object.fromEntries(merged)).toEqual(Object.fromEntries(reference));
    }
  });

  it('takes open from the earliest exchangeTs and close from the latest', () => {
    const early: PulseEvent = {
      symbol: 'X', price: 10, size: 1, exchangeTs: 60_000, ingestTs: 70_000,
    };
    const late: PulseEvent = {
      symbol: 'X', price: 20, size: 1, exchangeTs: 90_000, ingestTs: 95_000,
    };
    const forward = mergeBars(barFromEvent(early), barFromEvent(late));
    const backward = mergeBars(barFromEvent(late), barFromEvent(early));
    for (const bar of [forward, backward]) {
      expect(bar.open).toBe(10);
      expect(bar.close).toBe(20);
      expect(bar.volume).toBe(2);
      expect(bar.count).toBe(2);
    }
  });

  it('foldEvents keeps the freshest quote per symbol', () => {
    const events = syntheticEvents(200);
    const { quotes } = foldEvents(events, 0);
    const freshest = events.reduce((a, b) => (b.exchangeTs >= a.exchangeTs ? b : a));
    expect(quotes.get('BTC-USD')?.price).toBe(freshest.price);
  });

  it('percentile handles edges', () => {
    expect(percentile([], 99)).toBe(0);
    expect(percentile([5], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
  });
});
