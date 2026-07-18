import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { touchViewers } from '@/lib/pulse/lease';
import { readPulseSnapshot } from '@/lib/pulse/read';
import { ensureLocalPulseTable } from '@/lib/pulse/table';

// The dashboard tile's poll endpoint. Polling doubles as the viewer
// keepalive: the ingest session watches this heartbeat and exits when
// nobody has polled for a couple of minutes, which is what makes a
// session cost nothing once its audience leaves.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await ensureLocalPulseTable(); // no-op on AWS
    const snapshot = await readPulseSnapshot();
    if (snapshot.session) await touchViewers();
    return NextResponse.json(snapshot);
  } catch (error) {
    console.error('pulse snapshot failed', error);
    return NextResponse.json({ error: 'Pulse data unavailable' }, { status: 502 });
  }
}
