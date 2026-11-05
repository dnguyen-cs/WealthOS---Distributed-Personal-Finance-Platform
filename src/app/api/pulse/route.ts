import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { touchViewer } from '@/lib/pulse/lease';
import { readPulseSnapshot } from '@/lib/pulse/read';
import { ensureLocalPulseTable } from '@/lib/pulse/table';

// The dashboard tile's poll endpoint. Polling doubles as the viewer
// keepalive: the ingest session watches this heartbeat and exits when
// nobody has polled for a couple of minutes, which is what makes a
// session cost nothing once its audience leaves. A tile whose viewer
// pressed Stop keeps polling with ?keepalive=0, so it can still show the
// state without holding the session open.
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const keepalive = new URL(request.url).searchParams.get('keepalive') !== '0';

  try {
    await ensureLocalPulseTable(); // no-op on AWS
    const snapshot = await readPulseSnapshot();
    if (snapshot.session && keepalive) await touchViewer(session.user.id);
    return NextResponse.json(snapshot);
  } catch (error) {
    console.error('pulse snapshot failed', error);
    return NextResponse.json({ error: 'Pulse data unavailable' }, { status: 502 });
  }
}
