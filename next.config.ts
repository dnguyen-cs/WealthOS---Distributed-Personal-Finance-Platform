import type { NextConfig } from "next";

// Baseline security headers for the hosted deployment. A Content-Security-
// Policy is deliberately absent here: Next's inline bootstrap scripts and
// Plaid Link's injected script need nonce plumbing to do CSP properly, and
// a half-strict policy is worse than none. CSP lands with the Phase 10
// hardening gate, before any real bank credential is stored.
const securityHeaders = [
  // 2 years, preload-eligible; harmless on localhost (browsers ignore HSTS
  // over plain http) and Vercel terminates TLS in front of the app.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
