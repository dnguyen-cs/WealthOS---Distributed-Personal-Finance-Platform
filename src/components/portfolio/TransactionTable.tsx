import { formatCurrency, formatDate } from '@/lib/format';

export interface TransactionRow {
  id: string;
  date: Date;
  name: string;
  merchantName: string | null;
  category: string | null;
  pending: boolean;
  // Plaid convention: positive = money out, negative = money in
  amount: number;
  isoCurrencyCode: string;
  accountName: string;
}

function formatCategory(category: string | null): string {
  if (!category) return '—';
  return category.replaceAll('_', ' ').toLowerCase();
}

export function TransactionTable({ transactions }: { transactions: TransactionRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-black/10 dark:border-white/15">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left dark:border-white/15">
            <th className="px-4 py-3 font-medium opacity-60">Date</th>
            <th className="px-4 py-3 font-medium opacity-60">Description</th>
            <th className="px-4 py-3 font-medium opacity-60">Account</th>
            <th className="px-4 py-3 font-medium opacity-60">Category</th>
            <th className="px-4 py-3 text-right font-medium opacity-60">Amount</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((t) => {
            const inflow = t.amount < 0;
            return (
              <tr
                key={t.id}
                className="border-b border-black/5 last:border-b-0 dark:border-white/10"
              >
                <td className="whitespace-nowrap px-4 py-3 opacity-70">{formatDate(t.date)}</td>
                <td className="max-w-64 truncate px-4 py-3">
                  {t.merchantName ?? t.name}
                  {t.pending && <span className="ml-2 text-xs opacity-50">pending</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 opacity-70">{t.accountName}</td>
                <td className="whitespace-nowrap px-4 py-3 capitalize opacity-70">
                  {formatCategory(t.category)}
                </td>
                <td
                  className={`whitespace-nowrap px-4 py-3 text-right tabular-nums ${
                    inflow ? 'text-emerald-600 dark:text-emerald-400' : ''
                  }`}
                >
                  {formatCurrency(-t.amount, t.isoCurrencyCode)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
