/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  compiler: {
    // Strip console.* in production but keep error/warn so server-side
    // logging in API routes and auth survives for incident debugging.
    removeConsole:
      process.env.NODE_ENV === "production"
        ? { exclude: ["error", "warn"] }
        : false,
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
