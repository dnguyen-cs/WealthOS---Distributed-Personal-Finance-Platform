import { randomUUID } from 'node:crypto';
import type { Transaction as PlaidTransaction } from 'plaid';
import { acquireLock, releaseLock } from '@/lib/app-state';
import { decrypt } from '@/lib/crypto';
import { prisma } from '@/lib/db/prisma';
import { plaidClient } from '@/lib/plaid/client';
import { upsertAccounts } from '@/lib/plaid/accounts';

// Lock semantics live in lib/app-state.ts: a DynamoDB conditional-write
// lease with a holder token, so an expired lock taken over by another
// sync is never released from under it (same invariant the old Redis
// token-guarded Lua release enforced).
const LOCK_TTL_SECONDS = 300;

export class SyncLockedError extends Error {
  constructor() {
    super('A sync for this item is already running');
  }
}

export interface SyncResult {
  added: number;
  modified: number;
  removed: number;
}

function transactionData(t: PlaidTransaction, accountId: string) {
  return {
    accountId,
    amount: t.amount,
    date: new Date(t.date),
    name: t.name,
    merchantName: t.merchant_name ?? null,
    category: t.personal_finance_category?.primary ?? null,
    pending: t.pending,
    isoCurrencyCode: t.iso_currency_code ?? 'USD',
  };
}

/**
 * Idempotent transaction sync for one PlaidItem.
 *
 * - A per-item lock (DynamoDB conditional write) prevents concurrent syncs from interleaving.
 * - Each transactionsSync page is applied together with its cursor in one DB
 *   transaction, so a crash mid-sync resumes from the last committed page and
 *   re-running a completed sync is a no-op (upserts keyed on plaidTransactionId).
 */
export async function syncPlaidItem(plaidItemDbId: string): Promise<SyncResult> {
  const lockKey = `plaid:sync:${plaidItemDbId}`;
  const lockToken = randomUUID();
  const acquired = await acquireLock(lockKey, lockToken, LOCK_TTL_SECONDS);
  if (!acquired) throw new SyncLockedError();

  try {
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: plaidItemDbId } });
    const accessToken = decrypt(item.encryptedAccessToken);

    // refresh accounts and balances; also captures accounts added since linking
    const accountsResponse = await plaidClient.accountsGet({ access_token: accessToken });
    await prisma.$transaction((tx) => upsertAccounts(tx, item.id, accountsResponse.data.accounts));

    const accounts = await prisma.account.findMany({
      where: { plaidItemId: item.id },
      select: { id: true, plaidAccountId: true },
    });
    const accountIdByPlaidId = new Map(accounts.map((a) => [a.plaidAccountId, a.id]));

    const totals: SyncResult = { added: 0, modified: 0, removed: 0 };
    let cursor = item.syncCursor ?? undefined;
    let hasMore = true;

    while (hasMore) {
      const { data } = await plaidClient.transactionsSync({
        access_token: accessToken,
        cursor,
        count: 500,
      });

      await prisma.$transaction(async (tx) => {
        for (const t of [...data.added, ...data.modified]) {
          const accountId = accountIdByPlaidId.get(t.account_id);
          if (!accountId) continue;
          await tx.transaction.upsert({
            where: { plaidTransactionId: t.transaction_id },
            create: { plaidTransactionId: t.transaction_id, ...transactionData(t, accountId) },
            update: transactionData(t, accountId),
          });
        }

        const removedIds = data.removed
          .map((r) => r.transaction_id)
          .filter((id): id is string => Boolean(id));
        if (removedIds.length > 0) {
          await tx.transaction.deleteMany({ where: { plaidTransactionId: { in: removedIds } } });
        }

        await tx.plaidItem.update({
          where: { id: item.id },
          data: { syncCursor: data.next_cursor },
        });
      });

      totals.added += data.added.length;
      totals.modified += data.modified.length;
      totals.removed += data.removed.length;
      cursor = data.next_cursor;
      hasMore = data.has_more;
    }

    return totals;
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}
