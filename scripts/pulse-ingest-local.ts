// Runs one PortfolioPulse ingest session from the host against the local
// emulators (compose services `stream` + `table`), the pulse counterpart
// of `pnpm worker`:
//
//   DYNAMODB_ENDPOINT=http://localhost:8000 KINESIS_ENDPOINT=http://localhost:4568 \
//   AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
//   PULSE_SOURCE=synthetic PULSE_IGNORE_VIEWERS=1 \
//   pnpm exec tsx scripts/pulse-ingest-local.ts
//
// PULSE_SOURCE=coinbase streams the real feed instead; without
// PULSE_IGNORE_VIEWERS the session ends unless something (the dashboard)
// keeps touching the viewer keepalive.
import { runIngestSession } from '@/workers/pulse/ingest';

runIngestSession()
  .then((outcome) => {
    console.log(`outcome: ${outcome}`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
