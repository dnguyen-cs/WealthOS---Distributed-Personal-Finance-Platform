'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePlaidLink } from 'react-plaid-link';

export function PlaidLinkButton() {
  const router = useRouter();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/plaid/link', { method: 'POST' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`link token request failed (${response.status})`);
        const data = await response.json();
        if (!cancelled) setLinkToken(data.link_token);
      })
      .catch(() => {
        if (!cancelled) {
          setError('Could not reach Plaid. Are PLAID_CLIENT_ID and PLAID_SECRET set in .env?');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSuccess = useCallback(
    async (publicToken: string, metadata: { institution?: { name?: string } | null }) => {
      setBusy(true);
      setError(null);
      const response = await fetch('/api/plaid/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          public_token: publicToken,
          institution_name: metadata.institution?.name,
        }),
      });
      if (!response.ok) {
        setError('Connecting the bank failed. Please try again.');
        setBusy(false);
        return;
      }
      await fetch('/api/plaid/sync', { method: 'POST' });
      setBusy(false);
      router.refresh();
    },
    [router],
  );

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess });

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => open()}
        disabled={!ready || busy}
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-50"
      >
        {busy ? 'Connecting…' : 'Connect a bank'}
      </button>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
