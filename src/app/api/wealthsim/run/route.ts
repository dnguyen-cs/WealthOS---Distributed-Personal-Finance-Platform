import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { checkRunGuards, refundRunBudget } from '@/lib/wealthsim/guards';
import { createSimulationJob } from '@/lib/wealthsim/jobs';
import { simulationRequestSchema } from '@/lib/wealthsim/types';

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = simulationRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid simulation parameters', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Fail closed: this endpoint spends real compute per request, so if the
  // rate limiter is unreachable the request is refused, not waved through.
  let verdict;
  try {
    verdict = await checkRunGuards(session.user.id, parsed.data.pathCount);
  } catch (error) {
    console.error('wealthsim run guards unavailable', error);
    return NextResponse.json(
      { error: 'Service temporarily unavailable; try again shortly' },
      { status: 503 },
    );
  }
  if (!verdict.ok) {
    return NextResponse.json(
      { error: verdict.error },
      {
        status: verdict.status,
        headers: verdict.retryAfterSeconds
          ? { 'Retry-After': String(verdict.retryAfterSeconds) }
          : undefined,
      },
    );
  }

  try {
    const job = await createSimulationJob(session.user.id, parsed.data);
    return NextResponse.json(
      { jobId: job.id, chunkCount: job.chunkCount, chunkSize: job.chunkSize },
      { status: 202 },
    );
  } catch (error) {
    console.error('wealthsim run failed to enqueue', error);
    await refundRunBudget(parsed.data.pathCount).catch(() => {
      // refund is best-effort; losing it costs budget, never correctness
    });
    return NextResponse.json({ error: 'Failed to enqueue simulation' }, { status: 502 });
  }
}
