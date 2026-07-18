import { z } from 'zod';

// PortfolioPulse shared contracts: the normalized market event on the
// stream, the OHLCV bar and quote the consumer materializes, the session
// state machine, and the pipeline stats the dashboard reads. Producers
// (ingest), the consumer, the API routes, and the UI all import from here
// so the wire format has one source of truth (same discipline as
// wealthsim/types.ts).

// The demo symbol set. Coinbase product ids double as display symbols;
// a future stock source maps its tickers into the same namespace.
export const PULSE_SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const;

export const pulseEventSchema = z.object({
  symbol: z.string().min(1).max(20),
  price: z.number().positive(),
  size: z.number().nonnegative(),
  /** ms epoch as reported by the source exchange (their clock). */
  exchangeTs: z.number().int().nonnegative(),
  /** ms epoch stamped when the ingest saw the event (our clock). */
  ingestTs: z.number().int().nonnegative(),
});

export type PulseEvent = z.infer<typeof pulseEventSchema>;

// One Kinesis record carries a batch of events in a single JSON envelope.
// Packing N events per record is the per-shard throughput lever: Kinesis
// caps a shard at 1,000 records/s but 1 MB/s, so small events ride ~50x
// cheaper aggregated (measured in the Phase 8 benchmarks).
export const pulseRecordSchema = z.object({
  events: z.array(pulseEventSchema).min(1),
});

export type PulseRecord = z.infer<typeof pulseRecordSchema>;

// Bars are an order-insensitive merge (a commutative monoid, like
// WealthSim's histograms): open/close are defined by exchange timestamps
// (openTs/closeTs), not arrival order, so producer retries and shard
// redeliveries can never scramble a bar - merging partials in any order
// yields the same OHLC.
export const pulseBarSchema = z.object({
  symbol: z.string().min(1),
  /** ms epoch floored to the minute. */
  minuteTs: z.number().int().nonnegative(),
  open: z.number().positive(),
  /** exchangeTs of the event whose price is `open`. */
  openTs: z.number().int().nonnegative(),
  high: z.number().positive(),
  low: z.number().positive(),
  close: z.number().positive(),
  /** exchangeTs of the event whose price is `close`. */
  closeTs: z.number().int().nonnegative(),
  volume: z.number().nonnegative(),
  /** trade count folded into this bar. */
  count: z.number().int().positive(),
});

export type PulseBar = z.infer<typeof pulseBarSchema>;

export const pulseQuoteSchema = z.object({
  symbol: z.string().min(1),
  price: z.number().positive(),
  exchangeTs: z.number().int().nonnegative(),
  ingestTs: z.number().int().nonnegative(),
  /** ms epoch when the consumer wrote this quote. */
  updatedAt: z.number().int().nonnegative(),
});

export type PulseQuote = z.infer<typeof pulseQuoteSchema>;

// Session lifecycle: idle (no stream infra or nobody watching) ->
// starting (lease taken, stream/ESM warming) -> live (events flowing).
export const sessionStatusSchema = z.enum(['idle', 'starting', 'live']);

export const sessionStateSchema = z.object({
  status: sessionStatusSchema,
  sessionId: z.string().min(1),
  /** ms epoch; the ingest lease is dead past this point. */
  leaseUntil: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
});

export type SessionState = z.infer<typeof sessionStateSchema>;

// Pipeline stats the consumer maintains per batch window. The two latency
// segments are reported separately on purpose: source latency (exchange
// clock -> ingest clock) includes the exchange's pipeline and clock skew,
// while pipeline latency (ingest -> DynamoDB write) is the segment this
// system controls and the p50/p99 that the benchmarks quote.
export const pulseStatsSchema = z.object({
  /** ms epoch of the window this sample summarizes. */
  windowEndTs: z.number().int().nonnegative(),
  eventsPerSec: z.number().nonnegative(),
  pipelineP50Ms: z.number().nonnegative(),
  pipelineP99Ms: z.number().nonnegative(),
  sourceP50Ms: z.number(),
  sampleCount: z.number().int().nonnegative(),
});

export type PulseStats = z.infer<typeof pulseStatsSchema>;
