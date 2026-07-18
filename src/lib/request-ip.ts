// Client IP for rate-limit keys. On Vercel the platform overwrites
// x-forwarded-for with the real client IP (incoming spoofed values are
// dropped at the edge), so the first entry is trustworthy there. Behind
// no proxy (local dev) the header is absent and everything shares one
// bucket, which is fine for development.
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip') ?? 'local';
}
