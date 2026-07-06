// account types where the balance is money owed rather than money held
export const LIABILITY_TYPES = new Set(['credit', 'loan']);

export interface BalanceAccount {
  type: string;
  currentBalance: number;
}

export function computeNetWorth(accounts: BalanceAccount[]): number {
  return accounts.reduce(
    (sum, account) =>
      LIABILITY_TYPES.has(account.type)
        ? sum - account.currentBalance
        : sum + account.currentBalance,
    0,
  );
}
