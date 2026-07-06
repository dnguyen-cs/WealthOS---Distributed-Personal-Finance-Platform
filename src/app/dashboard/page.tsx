import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db/prisma';
import { formatCurrency } from '@/lib/format';
import { computeNetWorth } from '@/lib/networth';
import { AccountList, type BankItem } from '@/components/portfolio/AccountList';
import { PlaidLinkButton } from '@/components/portfolio/PlaidLinkButton';
import { TransactionTable, type TransactionRow } from '@/components/portfolio/TransactionTable';
import { SignOutButton } from '@/components/ui/SignOutButton';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');

  const [plaidItems, transactions] = await Promise.all([
    prisma.plaidItem.findMany({
      where: { userId: session.user.id },
      include: { accounts: { orderBy: { name: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.transaction.findMany({
      where: { account: { item: { userId: session.user.id } } },
      orderBy: [{ date: 'desc' }, { id: 'asc' }],
      take: 50,
      include: { account: { select: { name: true } } },
    }),
  ]);

  const items: BankItem[] = plaidItems.map((item) => ({
    id: item.id,
    institutionName: item.institutionName,
    accounts: item.accounts.map((account) => ({
      id: account.id,
      name: account.name,
      mask: account.mask,
      type: account.type,
      subtype: account.subtype,
      currentBalance: Number(account.currentBalance),
      isoCurrencyCode: account.isoCurrencyCode,
    })),
  }));

  const rows: TransactionRow[] = transactions.map((t) => ({
    id: t.id,
    date: t.date,
    name: t.name,
    merchantName: t.merchantName,
    category: t.category,
    pending: t.pending,
    amount: Number(t.amount),
    isoCurrencyCode: t.isoCurrencyCode,
    accountName: t.account.name,
  }));

  const netWorth = computeNetWorth(items.flatMap((item) => item.accounts));

  const hasBanks = items.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 p-6 sm:p-10">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm opacity-60">{session.user.email}</p>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/dashboard/simulations"
            className="text-sm underline underline-offset-4 opacity-80 hover:opacity-100"
          >
            Simulations
          </Link>
          <SignOutButton />
        </div>
      </header>

      {hasBanks ? (
        <>
          <section className="rounded-xl border border-black/10 p-5 dark:border-white/15">
            <p className="text-sm opacity-60">Net worth</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{formatCurrency(netWorth)}</p>
          </section>

          <section className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-medium">Accounts</h2>
              <PlaidLinkButton />
            </div>
            <AccountList items={items} />
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">Recent transactions</h2>
            {rows.length > 0 ? (
              <TransactionTable transactions={rows} />
            ) : (
              <p className="text-sm opacity-60">
                No transactions yet. Hit Sync on a bank above to pull them in.
              </p>
            )}
          </section>
        </>
      ) : (
        <section className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-black/15 p-10 text-center dark:border-white/20">
          <h2 className="text-lg font-medium">No banks connected yet</h2>
          <p className="max-w-sm text-sm opacity-60">
            Connect a bank through Plaid to pull in your accounts and transactions. In sandbox
            mode, use the credentials user_good / pass_good.
          </p>
          <PlaidLinkButton />
        </section>
      )}
    </div>
  );
}
