import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db/prisma';
import { SyncLockedError, syncPlaidItem } from '@/lib/plaid/sync';

const bodySchema = z.object({
  // sync one item, or every item of the current user when omitted
  itemId: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const items = await prisma.plaidItem.findMany({
    where: {
      userId: session.user.id,
      ...(parsed.data.itemId ? { id: parsed.data.itemId } : {}),
    },
    select: { id: true, institutionName: true },
  });
  if (items.length === 0) {
    return NextResponse.json({ error: 'No connected bank found' }, { status: 404 });
  }

  const results = [];
  for (const item of items) {
    try {
      const totals = await syncPlaidItem(item.id);
      results.push({ itemId: item.id, status: 'ok' as const, ...totals });
    } catch (error) {
      if (error instanceof SyncLockedError) {
        results.push({ itemId: item.id, status: 'locked' as const });
      } else {
        console.error(`plaid sync failed for item ${item.id}`, error);
        results.push({ itemId: item.id, status: 'error' as const });
      }
    }
  }

  const failed = results.some((r) => r.status === 'error');
  return NextResponse.json({ results }, { status: failed ? 502 : 200 });
}
