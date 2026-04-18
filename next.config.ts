import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production',
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

export default nextConfig;
