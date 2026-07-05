'use client';

import { useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';

export function SignOutButton() {
  const router = useRouter();

  async function handleClick() {
    await signOut({ redirect: false });
    router.push('/');
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded-md border border-black/15 px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-70 dark:border-white/20"
    >
      Sign out
    </button>
  );
}
