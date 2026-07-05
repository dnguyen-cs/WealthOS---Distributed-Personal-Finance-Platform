import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

// First line of defense; the dashboard page re-checks the session server-side.
export default auth((request) => {
  if (!request.auth) {
    const loginUrl = new URL('/login', request.nextUrl);
    return NextResponse.redirect(loginUrl);
  }
});

export const config = {
  matcher: ['/dashboard/:path*'],
};
