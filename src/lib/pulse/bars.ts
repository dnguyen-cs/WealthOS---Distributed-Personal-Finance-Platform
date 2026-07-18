import type { PulseBar, PulseEvent, PulseQuote } from '@/lib/pulse/types';

// Pure fold/merge for OHLCV bars and latest quotes. Bars form a
// commutative monoid: open/close are decided by exchange timestamps, high
// and low by max/min, volume and count by addition - so partials merge to
// the same bar in any order (WealthSim's mergeable-histogram discipline
// applied to streaming). That property is what makes producer retries and
// shard redeliveries harmless to prices; only volume/count depend on the
// consumer-side dedupe (the sequence checkpoint).

export function minuteOf(ts: number): number {
  return Math.floor(ts / 60_000) * 60_000;
}

export function barFromEvent(event: PulseEvent): PulseBar {
  return {
    symbol: event.symbol,
    minuteTs: minuteOf(event.exchangeTs),
    open: event.price,
    openTs: event.exchangeTs,
    high: event.price,
    low: event.price,
    close: event.price,
    closeTs: event.exchangeTs,
    volume: event.size,
    count: 1,
  };
}

export function mergeBars(a: PulseBar, b: PulseBar): PulseBar {
  const openSide = a.openTs <= b.openTs ? a : b;
  const closeSide = a.closeTs >= b.closeTs ? a : b;
  return {
    symbol: a.symbol,
    minuteTs: a.minuteTs,
    open: openSide.open,
    openTs: openSide.openTs,
    high: Math.max(a.high, b.high),
    low: Math.min(a.low, b.low),
    close: closeSide.close,
    closeTs: closeSide.closeTs,
    volume: a.volume + b.volume,
    count: a.count + b.count,
  };
}

export interface FoldResult {
  /** bar partials keyed `${symbol}|${minuteTs}` */
  bars: Map<string, PulseBar>;
  /** freshest quote per symbol (max exchangeTs) */
  quotes: Map<string, PulseQuote>;
}

export function foldEvents(events: PulseEvent[], now: number): FoldResult {
  const bars = new Map<string, PulseBar>();
  const quotes = new Map<string, PulseQuote>();
  for (const event of events) {
    const key = `${event.symbol}|${minuteOf(event.exchangeTs)}`;
    const partial = barFromEvent(event);
    const existing = bars.get(key);
    bars.set(key, existing ? mergeBars(existing, partial) : partial);

    const quote = quotes.get(event.symbol);
    if (!quote || event.exchangeTs >= quote.exchangeTs) {
      quotes.set(event.symbol, {
        symbol: event.symbol,
        price: event.price,
        exchangeTs: event.exchangeTs,
        ingestTs: event.ingestTs,
        updatedAt: now,
      });
    }
  }
  return { bars, quotes };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}
