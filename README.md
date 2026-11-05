# WealthOS

[![ci](https://github.com/dnguyen-cs/WealthOS---Distributed-Personal-Finance-Platform/actions/workflows/ci.yml/badge.svg)](https://github.com/dnguyen-cs/WealthOS---Distributed-Personal-Finance-Platform/actions/workflows/ci.yml)

Personal finance platform built on Next.js 16, PostgreSQL, and AWS.
The simulation and streaming compute scales to zero when idle, but the hosted deployment as a whole does not: measured AWS spend for the live demo was $8.86 in September 2026 and $11.35 in October (which included a few days of real use).
Most of that is Aurora, which pauses at 0 ACU yet still wakes roughly every two hours for its own background work and bills each wake for the full five-minute auto-pause window, plus the public IPv4 address the database endpoint needs; the Route 53 zone adds about $0.50.
**Live demo: [wealthos.danieln.cloud](https://wealthos.danieln.cloud)** - connect a fake bank with Plaid Sandbox (`user_good` / `pass_good`) and race the two Monte Carlo engines; the first visit after idle waits out the database's ~14s scale-from-zero resume.
Phase 2 delivered the local core: credentials auth, Plaid Sandbox bank connections, and a dashboard showing accounts, transactions, and net worth.
WealthSim is the flagship module: a distributed Monte Carlo simulation engine that fans work out over a queue to stateless compute workers, built to run identically against local emulators and AWS (SQS + S3 + Batch on Fargate), with two interchangeable kernel implementations - Node.js and Go - selectable per run and parity-tested against each other down to the bit level of the RNG stream.
PortfolioPulse is the second module: a real-time market data pipeline (Coinbase websocket -> Kinesis -> Lambda -> DynamoDB -> live dashboard tile) built around on-demand streaming sessions that scale to zero when nobody is watching.

## Stack

- Next.js 16 (App Router) + TypeScript + Tailwind v4; API route handlers are the backend
- PostgreSQL via Prisma 7 (driver adapter, generated client in `src/generated/prisma`)
- DynamoDB for coordination state: rate-limit windows, daily budgets, per-item sync locks (conditional writes; no Redis anywhere)
- Auth.js v5 with email/password credentials and JWT sessions
- Plaid (Link + `transactions/sync`) for bank data
- SQS + S3 (ElasticMQ + MinIO locally) and AWS Batch/Fargate (Terraform in `infra/`) for WealthSim compute
- Two WealthSim worker implementations: Node 22 (`src/workers/wealthsim`) and Go 1.26 (`go-worker/`), one SQS queue per engine

## Local setup

Prerequisites: Node 22, pnpm 10, Docker Desktop, a free [Plaid dashboard](https://dashboard.plaid.com) account for Sandbox keys.

```bash
cp .env.example .env
# fill in: AUTH_SECRET (openssl rand -base64 32), PLAID_TOKEN_ENC_KEY (openssl rand -hex 32),
#          PLAID_CLIENT_ID and PLAID_SECRET from the Plaid dashboard (Sandbox)

pnpm install
docker compose up -d db queue objectstore stream table   # Postgres 5434, ElasticMQ 9324, MinIO 9000, kinesis-mock 4568, dynamodb-local 8000
docker compose up -d worker worker-go             # both compute engines (scale with --scale worker=4 etc.)
pnpm prisma migrate dev                           # create tables
pnpm dev                                          # app on http://localhost:3000
```

Postgres is published on host port 5434 (not 5432) to avoid clashing with natively installed Postgres instances.
Alternatively run everything in containers: `docker compose up` also builds and starts the app service.
Note for Docker-on-Windows: file change events do not propagate into the bind mount, so the containerized app needs `docker compose restart app` to pick up host edits; `pnpm dev` on the host is the primary dev loop.

## Trying it out

1. Register at `/register`, which signs you in and lands on `/dashboard`.
2. Click "Connect a bank" to open Plaid Link in Sandbox mode.
3. Pick any institution and log in with the Sandbox test credentials `user_good` / `pass_good`.
4. Accounts and transactions sync into Postgres and render on the dashboard; "Sync" re-runs an incremental `transactions/sync`.
5. Open "Simulations", set your assumptions, pick a compute engine (Node.js or Go - same results, parity-tested), and run a 1M-path Monte Carlo projection; the fan chart shows median and percentile bands per year.
6. Or click "Race both engines": the identical seed runs on Node.js and Go simultaneously with side-by-side progress, and a verification badge reports the measured divergence between the two results (floating-point ulps, ~1e-15).

## WealthSim architecture

```
POST /api/wealthsim/run  (engine: node | go)
  -> SimulationJob row (Postgres)
  -> one SQS message per 50K-path chunk        (standard queue, not FIFO; one queue per engine)
       -> N stateless workers (Node or Go GBM kernel)
            -> one summary object per chunk (S3: histogram + moments per year, identical contract)
GET /api/wealthsim/jobs/[id]
  -> all chunk objects present? aggregate -> SimulationResult row -> fan chart
```

Design decisions, and why:

- **Standard queue instead of the originally planned SQS FIFO.** FIFO locks a message group while one message is in flight, so grouping a job's chunks would serialize them and defeat the fan-out. At-least-once delivery is safe here because processing is idempotent.
- **Idempotency by determinism, not locks.** A chunk spec carries a seed; the kernel's PRNG (sfc32) is deterministic, and the result goes to a deterministic S3 key. A redelivered message reproduces identical statistics at the same key (only the timing/worker-id metadata fields differ; the job's final aggregated results are byte-identical), so retries and duplicates are harmless by construction. (Contrast with the Plaid sync, which uses a DynamoDB conditional-write lease because its external effects are not replayable.)
- **Workers are fully stateless** - no database, no Redis; everything a chunk needs rides in the message, results land in object storage. That is what lets the same container image run under docker compose and AWS Batch, and lets a benchmark fleet scale to N workers with zero coordination.
- **Mergeable statistics.** Workers cannot ship raw paths (1M paths x 30 years is gigabytes) and percentiles do not average across workers. Each chunk records per-year log-binned histograms plus exact moments (count/sum/sumSq/min/max); histograms with identical bounds merge by element-wise addition, and percentiles read off the merged bins to within ~1.4% bin width.
- **No coordinator process.** Completion is detected lazily on status reads: when a read finds every chunk object present, it aggregates and finalizes. A concurrent double-finalize resolves via the unique constraint on `SimulationResult.jobId`.
- **Local/cloud parity via endpoint overrides.** The same `@aws-sdk` clients talk to ElasticMQ/MinIO locally (`SQS_ENDPOINT`/`S3_ENDPOINT` set) or real AWS (unset). No code forks.
- **Variance reduction as cost engineering.** Paths are generated as antithetic +Z/-Z pairs (toggleable per request). Marginal distributions are unchanged, but estimator variance drops sharply where the estimator is smooth in the shocks: measured VRF at 30y is ~29x for the median (97% fewer paths for the same confidence interval), ~2.2x for the mean, and ~1x in the tails - reported per-statistic because pairing does nothing for extreme quantiles. Sharing each draw across the pair also made the kernel ~1.6x faster at equal path count.
- **Reproducible runs.** The run API accepts an optional seed; the same seed reproduces byte-identical results, which is also what the chaos test exploits.
- **Two engines, one contract.** The Go worker (`go-worker/`) is a bit-faithful port of the kernel: sfc32/splitmix32 are pure 32-bit integer math, so the raw random streams are bit-identical across languages (asserted against Node-generated test vectors, including all sampled normal draws). PCG64 was rejected as the shared PRNG because its 128-bit multiplies have no fast JavaScript path - it would have benchmarked a BigInt workaround instead of the runtimes.
- **Where cross-language determinism ends.** IEEE 754 guarantees correctly rounded add/sub/mul/div/sqrt but not exp/log, so float accumulators drift a few ulps between runtimes in the GBM compounding loop: measured 2.4-4.5e-16 relative on golden chunks (histogram bins exactly equal) and 2.5e-15 end to end. Per-engine reruns are byte-identical; cross-engine equality is asserted numerically, not byte-wise.
- **Idempotency proven, not just claimed.** `scripts/chaos-test.ts` (local) and `scripts/chaos-test-aws.ts` (real Fargate task termination) run a control job and a chaos job with the same seed, kill a worker mid-run, wait for SQS redelivery, and assert the disrupted job's results are byte-identical to the control's. All four runs pass (local and AWS, once per engine); the two AWS runs happened to land on opposite sides of the termination race - the Node task stranded an in-flight chunk (recovered via 300s SQS redelivery), while the Go task's SIGTERM handler finished and deleted its chunk before exiting - byte-identical either way.
- **A rule the chaos test discovered:** worker idle-exit must exceed the queue's visibility timeout. The first AWS chaos run stalled at 39/40 chunks because the surviving worker idle-exited (60s) before the killed worker's in-flight chunk became visible again (300s) - durability held (nothing lost), but liveness broke (no consumer left). Idle-exit is now 360s.
- **Two lanes, selected by environment.** The hosted demo runs on a separate queue pair (`wealthsim-demo-*`) consumed by scale-to-zero Lambdas (one per engine, x86_64, 1769 MB = 1 full vCPU, batch size 1), while the `wealthsim-jobs*` queues stay reserved for Batch benchmark fleets. The app picks a lane purely via `WEALTHSIM_QUEUE_URL`/`WEALTHSIM_QUEUE_URL_GO`, so demo users and benchmark fleets can never contend. Handlers reuse the worker kernel/storage modules unchanged (`src/workers/wealthsim/lambda.ts`, `go-worker/cmd/lambda`); `pnpm build:lambdas` produces both artifacts.
- **Abuse guards that fail closed.** The public run endpoint enforces a per-deployment path cap, a per-user runs-per-minute window (429 + Retry-After), and a global daily path budget with atomic consume-or-rollback (DynamoDB conditional writes); registration and login are metered per IP. If the backing store is unreachable the guarded endpoints refuse rather than open - they spend real compute when unguarded.

### Benchmarks

`pnpm bench` (Node) and `go run ./cmd/bench` in `go-worker/` (Go) measure the kernel locally (control groups for the distributed scaling curve).
On a Ryzen 7 9800X3D (8C/16T), 30-year horizon, monthly steps, antithetic pairing on:

| Setup | Node | Go |
|---|---|---|
| 1 thread/goroutine | ~166K paths/s (~60M GBM steps/s) | ~175K paths/s (+5%) |
| 8 threads/goroutines | ~865K paths/s (x5.36) | ~1.00M paths/s (+16%) |
| 16 threads/goroutines | ~861K paths/s (no SMT gain) | ~1.24M paths/s (+44%) |

The honest surprise: V8's JIT lands within 5% of compiled Go on this FP-bound loop single-threaded; Go's wins are scaling through SMT and a 12.5 MB worker image vs Node's 1.2 GB (image pull dominates Fargate cold start).
Near-linear scaling to the 8 physical cores either way (independent sampling measured ~105K paths/s per thread before pairing).
Through the full local pipeline (queue + containerized workers + object store), a 2M-path job went from 18.8s wall at 1 worker to 7.0s at 4 workers on the same machine (pre-antithetic kernel); a 1M-path job runs 7.3s on one Node worker vs 6.2s on one Go worker.

Cross-engine parity (`pnpm exec tsx scripts/parity-test.ts`, same seed through the full pipeline): a rerun on the Go engine is byte-identical, and node-vs-go results diverge by at most 2.53e-15 relative; `go test ./...` additionally proves the RNG streams bit-exact against vectors generated from the Node kernel (`scripts/gen-parity-vectors.ts`).

Variance study (`pnpm exec tsx scripts/variance-test.ts`, 100 seeded replications x 10K paths, 30y):

| Estimator | VRF (antithetic vs independent) | Equal-CI path savings |
|---|---|---|
| median | ~29x | ~97% |
| mean | ~2.2x | ~55% |
| p90 | ~1.2x | ~17% |
| p10 | ~0.9x | none (slight regression, within estimation noise) |

AWS Batch scaling curve (Fargate, 1 vCPU / 2GB per Node worker, 10M-path jobs, mean of 3 seeded runs, hot fleet - cold start excluded and measured separately at 48s to 16 RUNNING / 100s to 64 RUNNING):

| Workers | Wall time | Throughput | Speedup | Cost per 1M paths |
|---|---|---|---|---|
| 1 | 157.6s | ~63K paths/s | x1.00 | ~$0.00022 |
| 2 | 65.6s | ~152K paths/s | x2.40 | ~$0.00018 |
| 4 | 43.3s | ~231K paths/s | x3.64 | ~$0.00024 |
| 8 | 24.1s | ~414K paths/s | x6.53 | ~$0.00027 |
| 16 | 19.7s | ~519K paths/s | x8.0 | ~$0.0004 |
| 64 | 8.2s | ~1.21M paths/s | x19.1 | ~$0.0007 |

10M paths saturates around 16 workers (200 chunks across 64 workers leaves fixed submit/enqueue/aggregate costs dominating); scaling the workload 10x restores the curve:

| Workers | 100M-path wall | Throughput | Efficiency | Cost per 1M paths |
|---|---|---|---|---|
| 16 | 104.4s | ~959K paths/s | 95% | ~$0.0002 |
| 64 | 31.8s | ~3.14M paths/s | 78% | ~$0.0003 |

Same harness, same seeds, Go engine (1 vCPU / 2GB per worker, hot fleet; Go fleet cold start is 19-25s for 1-16 workers vs Node's 48s thanks to the 4.7 MB compressed image, but 64 workers took 136s - at that size Fargate capacity scheduling dominates image pull):

| Workers | 10M-path wall | Throughput | Speedup | vs Node wall |
|---|---|---|---|---|
| 1 | 145.0s | ~69K paths/s | x1.00 | -8% |
| 2 | 72.1s | ~139K paths/s | x2.01 | +10% |
| 4 | 34.9s | ~287K paths/s | x4.16 | -19% |
| 8 | 20.8s | ~480K paths/s | x6.96 | -14% |
| 16 | 12.5s | ~797K paths/s | x11.6 | -37% |
| 64 | 7.2s | ~1.40M paths/s | x20.3 | -12% |

| Workers | 100M-path wall | Throughput | Cost per 1M paths |
|---|---|---|---|
| 16 | 74.5s | ~1.34M paths/s | ~$0.00016 |
| 64 | 25.6s | ~3.91M paths/s | ~$0.00022 |

**100 million Monte Carlo paths in 25.6 seconds at 64 Go workers (~3.91M paths/s) for ~$0.0225 of compute** (~$0.035 all-in once S3/SQS request pricing is counted) - 19% faster and 20% cheaper than the Node engine's 31.8s, and roughly x57 a single worker's throughput.
Honest caveats, from the data: the superlinear x2.40 at 2 Node workers and the per-row vs-Node swings (-37% to +10%) are Fargate hardware heterogeneity (per-worker throughput ranged +/-20% across fleet placements; within-fleet repeats are +/-2%); on summed kernel compute time, which cancels placement luck, Go is ~21% faster per Fargate vCPU than Node (~95K vs ~78K paths/s per compute-second) - a larger gap than the +5% single-thread desktop result.
Short 1M-path jobs scale worse (x4.9 at 8 workers) because submit/aggregation fixed costs stop amortizing, and the 100M finalize step queues ~1200-1500 S3 GETs behind the SDK's 50-socket pool - the documented next bottleneck.
Every benchmark run doubled as a determinism check: identical seeds produced byte-identical results across all worker counts and repeats.
Raw per-run data: `bench-results/aws.jsonl`; harness: `scripts/bench-aws.ts` (env: `ENGINE=node|go`, `WORKERS`, `PATHS_LIST`, `REPEATS`, plus `VCPUS`/`CONCURRENCY` for multi-vCPU Go tasks).

### The compute plane on AWS (deployed)

Terraform in `infra/` provisions the full compute plane: public subnets + IGW (no NAT by design), one standard SQS queue + DLQ per engine, S3 results bucket (30-day lifecycle), two ECR repos, Batch Fargate compute environment/queue and one job definition per engine, least-privilege IAM (workers can only consume their queues and put objects under `jobs/`), an account-level budget alarm, and CloudWatch alarms that email via SNS the moment anything lands in a DLQ.
It also provisions the scale-to-zero demo lane: per-engine demo queues + DLQs + alarms, the two Lambda consumers capped at 16 concurrent executions per engine via ESM `maximum_concurrency` (reserved concurrency deliberately unused - one cap mechanism is enough), and a minimal-privilege IAM user for the hosted app (send to demo queues, read results - nothing else).
Measured on the demo lane: the 2M-path public-cap job runs 10.9s (node) / 8.9s (go) warm, and a 10M-path burst 19.5s - within 7s of a pre-provisioned 16-worker Fargate fleet, from zero standing infrastructure; short bursts are limited by Lambda's gradual SQS poller ramp (effective parallelism ~3 at 40 chunks, ~6.6 at 200), not by the cap.
State lives in a versioned S3 backend with native locking.
Workers on Batch set `WORKER_IDLE_EXIT_SECONDS=360` - above the 300s visibility timeout, the liveness invariant the chaos test discovered - so a benchmark fleet drains the queue and self-terminates instead of billing Fargate time.
Steady-state idle compute cost of the demo plane: $0; the hosted deployment's Aurora and public-IPv4 floor (measured at the top of this README) is separate.

```bash
cd infra && terraform plan -out=tfplan && terraform apply tfplan
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker build --platform linux/amd64 -f docker/Dockerfile.worker    -t <ecr-url>:latest    . && docker push <ecr-url>:latest
docker build --platform linux/amd64 -f docker/Dockerfile.worker-go -t <ecr-url-go>:latest . && docker push <ecr-url-go>:latest
aws batch submit-job --job-queue wealthsim --job-definition wealthsim-worker ...     # Node fleet
aws batch submit-job --job-queue wealthsim --job-definition wealthsim-worker-go ...  # Go fleet
```

The app then points `WEALTHSIM_QUEUE_URL`/`WEALTHSIM_QUEUE_URL_GO`/`WEALTHSIM_BUCKET` at the Terraform outputs (drop the local `*_ENDPOINT` overrides); `scripts/run-aws-job.ts` and `scripts/bench-aws.ts` drive jobs against the real queues.

## PortfolioPulse architecture

```
Coinbase WS (matches: BTC/ETH/SOL-USD)
  -> pulse-ingest Lambda    one session at a time (DynamoDB conditional-write lease),
     |                      started by "Go live", exits when viewers stop polling
     |  PutRecords, partition key = symbol, N events packed per record
  -> Kinesis pulse-events   1 shard; created lazily, deleted by a daily janitor after idle hours
  -> pulse-consumer Lambda  (event source mapping; parallelization 1 = one writer per shard)
     |  per-shard sequence checkpoint committed atomically WITH the data (TransactWriteItems)
  -> DynamoDB pulse table   latest quotes + 1-min OHLCV bars + session state (TTL'd)
  -> GET /api/pulse         dashboard tile polls 1-2s; polling doubles as the viewer keepalive
```

Design decisions, and why:

- **Sessions, not servers.** The one component a streaming pipeline can't scale to zero is the thing holding the websocket - so it runs as an on-demand Lambda session (up to ~15 min, renewed interest = new session) guarded by a DynamoDB lease: N users clicking "Go live" resolve to exactly one ingest, and a crashed session's lease expires by TTL. Idle days cost $0 because the janitor also deletes the Kinesis stream and event source mapping (both bill hourly whether or not events flow).
- **Bars merge in any order.** Open/close are chosen by exchange timestamps (not arrival order), high/low by max/min, volume by addition - OHLCV bars form a commutative monoid, the same mergeable-statistics discipline as WealthSim's histograms. Replays and reorderings cannot scramble a price.
- **Exactly-once on top of at-least-once.** The consumer keeps a per-shard sequence-number checkpoint and commits it in the same DynamoDB transaction as the bars it covers: a replayed batch is filtered before it can double-count volume. (The residual hole - a producer retry whose reported failure actually landed - is bounded and documented, not hidden.)
- **Two latency segments, reported separately.** exchange->ingest includes the exchange's pipeline and clock skew; ingest->DynamoDB-write is the segment this system controls and the p50/p99 the tile displays.
- **Local/cloud parity again.** kinesis-mock and dynamodb-local in compose behind the same endpoint-override pattern as ElasticMQ/MinIO; `scripts/pulse-ingest-local.ts` and `scripts/pulse-consumer-local.ts` are the local dev loop (a synthetic source generates load without touching the internet).

Measured on the live plane (`scripts/bench-pulse.ts`; raw runs in `bench-results/pulse.jsonl`):

| What | Number |
|---|---|
| Per-shard ceiling, naive (1 event/record) | ~1,386 events/s (records/s-bound) |
| Per-shard ceiling, packed (10-100 events/record) | ~10,000 events/s (byte-bound) - x7.2 from record aggregation |
| Pipeline p50, 100 -> 5,000 ev/s synthetic load | 806ms -> 889ms (50x load, +10% latency: batching-dominated) |
| Live Coinbase session (single clock domain) | p50 694ms / p99 991ms |
| 100K-event backlog after an outage | drained in 1.5s (~67K ev/s - intake-bound recovery, 6.7x the shard ceiling) |
| Cold "Go live" -> first data | 72s (lazy stream + first ESM creation) vs 3s warm |
| Cost | ~$0.001 per million events sustained; ~$0.10 per live demo-hour; streaming plane $0 idle after janitor teardown (separate from the hosted deployment's Aurora and public-IPv4 floor noted above) |

## Design notes (Phase 2)

- Plaid access tokens are encrypted at rest with AES-256-GCM (`src/lib/crypto.ts`).
- Transaction sync (`src/lib/plaid/sync.ts`) is idempotent: a DynamoDB conditional-write lock (token-guarded release, TTL takeover) serializes syncs per bank item, each `transactions/sync` page commits together with its cursor in one DB transaction, and upserts are keyed on Plaid's transaction id - so crashes resume cleanly and re-runs are no-ops.
- `src/proxy.ts` redirects unauthenticated `/dashboard` requests; the dashboard page re-checks the session server-side.

## Tests and verification scripts

```bash
pnpm test                                    # vitest (local-only): kernel determinism, GBM closed forms,
                                             # histogram accuracy, merge exactness, variance reduction
pnpm bench                                   # local Node throughput baseline
(cd go-worker && go test ./... && go run ./cmd/bench)  # Go suite (RNG bit-parity, golden summaries,
                                             # closed forms) + Go throughput baseline
pnpm exec tsx scripts/gen-parity-vectors.ts  # regenerate cross-engine vectors after kernel changes
pnpm exec tsx scripts/parity-test.ts         # E2E cross-engine parity (needs worker + worker-go up)
pnpm exec tsx scripts/variance-test.ts       # antithetic vs independent variance study
pnpm exec tsx scripts/chaos-test.ts          # kill-a-worker idempotency proof (needs 2 workers up;
                                             # ENGINE=go targets the Go fleet)
```
