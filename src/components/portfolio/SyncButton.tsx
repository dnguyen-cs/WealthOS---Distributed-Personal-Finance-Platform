'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function SyncButton({ itemId }: { itemId?: string }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);

  async function handleClick() {
    setSyncing(true);
    await fetch('/api/plaid/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(itemId ? { itemId } : {}),
    }).catch(() => null);
    setSyncing(false);
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={syncing}
      className="rounded-md border border-black/15 px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-70 disabled:opacity-50 dark:border-white/20"
    >
      {syncing ? 'Syncing…' : 'Sync'}
    </button>
  );
}
