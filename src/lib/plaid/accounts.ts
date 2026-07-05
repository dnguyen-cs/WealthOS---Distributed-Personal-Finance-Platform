import type { AccountBase } from 'plaid';
import type { Prisma } from '@/generated/prisma/client';

export async function upsertAccounts(
  tx: Prisma.TransactionClient,
  plaidItemDbId: string,
  accounts: AccountBase[],
) {
  for (const account of accounts) {
    const data = {
      name: account.name,
      officialName: account.official_name ?? null,
      type: account.type,
      subtype: account.subtype ?? null,
      mask: account.mask ?? null,
      currentBalance: account.balances.current ?? 0,
      availableBalance: account.balances.available,
      isoCurrencyCode: account.balances.iso_currency_code ?? 'USD',
    };
    await tx.account.upsert({
      where: { plaidAccountId: account.account_id },
      create: { plaidAccountId: account.account_id, plaidItemId: plaidItemDbId, ...data },
      update: data,
    });
  }
}
