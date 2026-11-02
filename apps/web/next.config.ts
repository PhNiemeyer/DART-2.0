import type { NextConfig } from 'next';

const security = [
  { key: 'Cache-Control', value: 'private, no-store' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  },
];

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: require('node:path').join(__dirname, '../..'),
  poweredByHeader: false,
  reactStrictMode: true,
  // Keine Gesundheitsdaten im gemeinsamen Cache: alle Antworten privat/no-store
  async headers() {
    return [{ source: '/:path*', headers: security }];
  },
};

export default config;
