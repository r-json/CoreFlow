/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  compiler: {
    // Strip console.* in production but keep error/warn so server-side
    // logging in API routes and auth survives for incident debugging.
    removeConsole:
      process.env.NODE_ENV === "production"
        ? { exclude: ["error", "warn"] }
        : false,
  },
  async headers() {
    // Stellar RPC endpoints the client connects to.
    const connectSrc = [
      "'self'",
      'https://soroban-testnet.stellar.org',
      'https://mainnet.sorobanrpc.com',
      'https://horizon-testnet.stellar.org',
      'https://horizon.stellar.org',
    ].join(' ');

    // CSP is shipped Report-Only first so it cannot break the app; promote to
    // enforcing `Content-Security-Policy` after validating reports in prod.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      `connect-src ${connectSrc}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'Content-Security-Policy-Report-Only', value: csp },
        ],
      },
    ];
  },
  webpack: (config, { isServer }) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      "js-stellar-sdk": false,
    };
    
    // Mark js-stellar-sdk as external to prevent build errors
    if (!isServer) {
      config.externals = {
        ...config.externals,
        "js-stellar-sdk": "js-stellar-sdk",
      };
    }
    
    return config;
  },
};

module.exports = nextConfig;
