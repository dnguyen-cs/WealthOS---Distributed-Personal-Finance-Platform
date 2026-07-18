import { NextResponse } from 'next/server';

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

import { auth } from '@/lib/auth';
import { readSessionState, touchViewers } from '@/lib/pulse/lease';
import { ensureLocalPulseTable } from '@/lib/pulse/table';
import { fixedWindowLimit } from '@/lib/rate-limit';

// "Go live": start (or join) an ingest session. On AWS this async-invokes
// the pulse-ingest Lambda, which then wins or loses the DynamoDB lease -
// so N users clicking at once still yield exactly one session, and this
// route never needs its own coordination. Locally (no PULSE_INGEST_FUNCTION
// configured) the ingest runs by hand via scripts/pulse-ingest-local.ts
// and this route only records the viewer and reports state.

const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Fail closed, same stance as the run endpoint: each start can spin up
  // real streaming infrastructure.
  try {
    const limit = await fixedWindowLimit(`rl:pulse:session:${session.user.id}`, 4, 60);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'Too many session starts; wait a moment' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
      );
    }
  } catch (error) {
    console.error('pulse session rate limiter unavailable', error);
    return NextResponse.json(
      { error: 'Service temporarily unavailable; try again shortly' },
      { status: 503 },
    );
  }

  try {
    await ensureLocalPulseTable(); // no-op on AWS
    await touchViewers();

    const current = await readSessionState();
    const ingestFunction = process.env.PULSE_INGEST_FUNCTION;
    if (!current && ingestFunction) {
      await lambdaClient.send(
        new InvokeCommand({ FunctionName: ingestFunction, InvocationType: 'Event' }),
      );
    }

    return NextResponse.json({
      session: current ?? { status: 'starting' },
      managed: Boolean(ingestFunction),
    });
  } catch (error) {
    console.error('pulse session start failed', error);
    return NextResponse.json({ error: 'Failed to start session' }, { status: 502 });
  }
}
