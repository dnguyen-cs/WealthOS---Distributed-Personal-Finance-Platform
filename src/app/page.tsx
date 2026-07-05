import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export default async function Home() {
  const session = await auth();
  if (session?.user) redirect('/dashboard');

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">WealthOS</h1>
      <p className="max-w-md text-balance opacity-70">
        Connect your bank accounts, track transactions and net worth, and simulate your financial
        future.
      </p>
      <div className="flex gap-3">
        <Link
          href="/register"
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85"
        >
          Get started
        </Link>
        <Link
          href="/login"
          className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
