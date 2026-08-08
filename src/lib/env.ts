import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid connection URL'),
  DIRECT_URL: z.string().optional(),
  NEXT_PUBLIC_STELLAR_NETWORK: z.enum(['testnet', 'public', 'futurenet', 'local']).default('testnet'),
  NEXT_PUBLIC_STELLAR_CONTRACT_ID: z.string().min(1, 'NEXT_PUBLIC_STELLAR_CONTRACT_ID is required'),
  ADMIN_WALLETS: z.string().optional().default(''),
  ADMIN_WALLET_ADDRESS: z.string().optional().default(''),
  BOOTSTRAP_SECRET: z.string().optional().default(''),
  NEXT_PUBLIC_COMPANY_NAME: z.string().default('CoreFlow'),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters').optional().default('default_super_secret_coreflow_jwt_key_32bytes'),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional().default(''),
});

const parseEnv = () => {
  // Guarantee DIRECT_URL defaults to DATABASE_URL if unset for Prisma compatibility
  if (!process.env.DIRECT_URL && process.env.DATABASE_URL) {
    process.env.DIRECT_URL = process.env.DATABASE_URL;
  }

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables configuration:');
    console.error(JSON.stringify(result.error.format(), null, 2));
    throw new Error('Invalid environment variables. Fix the errors above and restart.');
  }
  return result.data;
};

export const env = parseEnv();
