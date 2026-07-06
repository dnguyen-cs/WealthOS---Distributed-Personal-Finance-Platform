import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
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

  try {
    const job = await createSimulationJob(session.user.id, parsed.data);
    return NextResponse.json(
      { jobId: job.id, chunkCount: job.chunkCount, chunkSize: job.chunkSize },
      { status: 202 },
    );
  } catch (error) {
    console.error('wealthsim run failed to enqueue', error);
    return NextResponse.json({ error: 'Failed to enqueue simulation' }, { status: 502 });
  }
}
