import { z } from 'zod';

// Shared contracts between the Next.js API (producer), the queue message
// payload, the worker (consumer), and the aggregation step. The queue
// message is a self-contained ChunkSpec so workers need no database access.

export const modelParamsSchema = z.object({
  initialValue: z.number().positive().max(1e12),
  annualContribution: z.number().min(0).max(1e9),
  meanReturn: z.number().min(-0.5).max(0.5),
  volatility: z.number().min(0).max(1),
  years: z.number().int().min(1).max(60),
  // Antithetic variates: paths are generated in +Z/-Z pairs, which leaves
  // every marginal distribution unchanged but sharply reduces the
  // variance of mean-type estimators at the same path count. Defaulted on;
  // the toggle exists so benchmarks can quantify the reduction.
  antithetic: z.boolean().default(true),
});

export type ModelParams = z.infer<typeof modelParamsSchema>;

// Two implementations of the same kernel contract (Node and Go) consume
// engine-specific queues. Their results are interchangeable - the Go port
// is parity-tested against Node-generated vectors (bit-exact RNG streams,
// summaries within ulps) - but a job's chunks are never mixed across
// engines: redelivery must stay within an engine so per-engine reruns are
// byte-identical.
export const engineSchema = z.enum(['node', 'go']);

export type Engine = z.infer<typeof engineSchema>;

export const simulationRequestSchema = modelParamsSchema.extend({
  pathCount: z
    .number()
    .int()
    .min(1_000)
    .max(10_000_000),
  // Optional fixed seed for reproducible runs (identical results across
  // submissions); omitted means a random seed per job. Also what the
  // chaos test uses to compare a disrupted run against a control run.
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1)
    .optional(),
  engine: engineSchema.default('node'),
});

export type SimulationRequest = z.infer<typeof simulationRequestSchema>;

export const chunkSpecSchema = z.object({
  jobId: z.string().min(1),
  chunkIndex: z.number().int().min(0),
  pathCount: z.number().int().positive(),
  seed: z.number().int().nonnegative(),
  params: modelParamsSchema,
});

export type ChunkSpec = z.infer<typeof chunkSpecSchema>;

const histogramConfigSchema = z.object({
  lo: z.number().positive(),
  hi: z.number().positive(),
  binCount: z.number().int().positive(),
});

export const yearSummarySchema = z.object({
  year: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  sum: z.number(),
  sumSq: z.number(),
  min: z.number(),
  max: z.number(),
  bins: z.array(z.number().int().nonnegative()),
});

export type YearSummary = z.infer<typeof yearSummarySchema>;

export const chunkSummarySchema = z.object({
  jobId: z.string().min(1),
  chunkIndex: z.number().int().min(0),
  pathCount: z.number().int().positive(),
  seed: z.number().int().nonnegative(),
  computeMs: z.number().nonnegative(),
  workerId: z.string(),
  histogram: histogramConfigSchema,
  years: z.array(yearSummarySchema),
});

export type ChunkSummary = z.infer<typeof chunkSummarySchema>;

export interface YearlyStat {
  year: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
  p05: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}
