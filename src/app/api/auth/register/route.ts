import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@/lib/db/prisma';
import { fixedWindowLimit } from '@/lib/rate-limit';
import { clientIp } from '@/lib/request-ip';

const bodySchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(72),
  name: z.string().trim().min(1).max(100).optional(),
});

export async function POST(request: Request) {
  // Fail closed: unmetered registration is the cheapest way to farm
  // accounts that then each get their own run-endpoint rate window.
  try {
    const limit = await fixedWindowLimit(`rl:register:${clientIp(request)}`, 10, 60 * 60);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'Too many registrations from this address; try again later.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
      );
    }
  } catch (error) {
    console.error('register rate limiter unavailable', error);
    return NextResponse.json(
      { error: 'Service temporarily unavailable; try again shortly.' },
      { status: 503 },
    );
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Enter a valid email and a password of at least 8 characters.' },
      { status: 400 },
    );
  }

  const email = parsed.data.email.toLowerCase();
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);

  try {
    const user = await prisma.user.create({
      data: { email, passwordHash, name: parsed.data.name },
    });
    return NextResponse.json({ id: user.id, email: user.email }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    ) {
      return NextResponse.json({ error: 'Email is already registered.' }, { status: 409 });
    }
    throw error;
  }
}
