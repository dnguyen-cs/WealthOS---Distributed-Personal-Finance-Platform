import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { encrypt } from '@/lib/crypto';
import { prisma } from '@/lib/db/prisma';
import { plaidClient } from '@/lib/plaid/client';
import { upsertAccounts } from '@/lib/plaid/accounts';

const bodySchema = z.object({
  public_token: z.string().min(1),
  institution_name: z.string().trim().min(1).max(200).optional(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'public_token is required' }, { status: 400 });
  }

  const exchange = await plaidClient.itemPublicTokenExchange({
    public_token: parsed.data.public_token,
  });
  const accessToken = exchange.data.access_token;
  const plaidItemId = exchange.data.item_id;

  const existing = await prisma.plaidItem.findUnique({ where: { plaidItemId } });
  if (existing && existing.userId !== session.user.id) {
    return NextResponse.json(
      { error: 'This bank connection belongs to another user.' },
      { status: 409 },
    );
  }

  const accountsResponse = await plaidClient.accountsGet({ access_token: accessToken });

  const item = await prisma.$transaction(async (tx) => {
    const upserted = await tx.plaidItem.upsert({
      where: { plaidItemId },
      create: {
        userId: session.user.id,
        plaidItemId,
        encryptedAccessToken: encrypt(accessToken),
        institutionName: parsed.data.institution_name,
      },
      update: {
        encryptedAccessToken: encrypt(accessToken),
        institutionName: parsed.data.institution_name,
      },
    });
    await upsertAccounts(tx, upserted.id, accountsResponse.data.accounts);
    return upserted;
  });

  return NextResponse.json(
    { itemId: item.id, accountCount: accountsResponse.data.accounts.length },
    { status: 201 },
  );
}
