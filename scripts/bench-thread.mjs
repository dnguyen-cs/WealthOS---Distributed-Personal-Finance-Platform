// Worker-thread entry for the local benchmark. Plain .mjs bootstrap:
// worker threads do not inherit the parent's tsx loader (and execArgv
// --import does not reliably register it on Node 22), so the TS kernel is
// loaded through tsx's programmatic API instead.
import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

const { simulateChunk } = await tsImport('../src/lib/wealthsim/simulate.ts', import.meta.url);

const started = performance.now();
simulateChunk(workerData);
parentPort.postMessage({ computeMs: performance.now() - started });
