import Link from 'next/link';
import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db/prisma';
import { computeNetWorth } from '@/lib/networth';
import type { YearlyStat } from '@/lib/wealthsim/types';
import { SimulationsPanel, type RecentJob } from '@/components/wealthsim/SimulationsPanel';
import { SignOutButton } from '@/components/ui/SignOutButton';

export default async function SimulationsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');

  const [accounts, jobs] = await Promise.all([
    prisma.account.findMany({
      where: { item: { userId: session.user.id } },
      select: { type: true, currentBalance: true },
    }),
    prisma.simulationJob.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { result: { select: { yearlyStats: true } } },
    }),
  ]);

  const netWorth = computeNetWorth(
    accounts.map((account) => ({
      type: account.type,
      currentBalance: Number(account.currentBalance),
    })),
  );

  const recentJobs: RecentJob[] = jobs.map((job) => {
    const params = job.params as { years?: number };
    const yearlyStats = job.result?.yearlyStats as YearlyStat[] | undefined;
    return {
      id: job.id,
      status: job.status,
      engine: job.engine,
      pathCount: job.pathCount,
      years: params.years ?? 0,
      createdAt: job.createdAt.toISOString(),
      medianAtHorizon:
        yearlyStats && yearlyStats.length > 0 ? yearlyStats[yearlyStats.length - 1].p50 : null,
    };
  });

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 p-6 sm:p-10">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Simulations</h1>
          <p className="text-sm opacity-60">
            <Link href="/dashboard" className="underline underline-offset-4">
              Back to dashboard
            </Link>
          </p>
        </div>
        <SignOutButton />
      </header>

      <SimulationsPanel
        defaultInitialValue={netWorth > 0 ? Math.round(netWorth) : 100_000}
        recentJobs={recentJobs}
      />
    </div>
  );
}
