import { SyncButton } from '@/components/portfolio/SyncButton';
import { formatCurrency } from '@/lib/format';

export interface AccountItem {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  currentBalance: number;
  isoCurrencyCode: string;
}

export interface BankItem {
  id: string;
  institutionName: string | null;
  accounts: AccountItem[];
}

export function AccountList({ items }: { items: BankItem[] }) {
  return (
    <div className="flex flex-col gap-6">
      {items.map((item) => (
        <section key={item.id} className="rounded-xl border border-black/10 p-5 dark:border-white/15">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-medium">{item.institutionName ?? 'Bank'}</h3>
            <SyncButton itemId={item.id} />
          </div>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {item.accounts.map((account) => (
              <li
                key={account.id}
                className="flex items-baseline justify-between gap-3 rounded-lg border border-black/10 px-4 py-3 dark:border-white/10"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {account.name}
                    {account.mask && <span className="opacity-50"> ••{account.mask}</span>}
                  </p>
                  <p className="text-xs capitalize opacity-60">
                    {account.subtype ?? account.type}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-medium tabular-nums">
                  {formatCurrency(account.currentBalance, account.isoCurrencyCode)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
