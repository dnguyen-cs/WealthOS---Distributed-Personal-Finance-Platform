import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { getJobStatus } from '@/lib/wealthsim/jobs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { jobId } = await context.params;
  try {
    const payload = await getJobStatus(session.user.id, jobId);
    if (!payload) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }
    return NextResponse.json(payload);
  } catch (error) {
    console.error(`wealthsim status failed for job ${jobId}`, error);
    return NextResponse.json({ error: 'Failed to read job status' }, { status: 502 });
  }
}
