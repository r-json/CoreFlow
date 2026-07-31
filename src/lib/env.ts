import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid connection URL'),
  NEXT_PUBLIC_STELLAR_NETWORK: z.enum(['testnet', 'public', 'futurenet', 'local']).default('testnet'),
  NEXT_PUBLIC_STELLAR_CONTRACT_ID: z.string().min(1, 'NEXT_PUBLIC_STELLAR_CONTRACT_ID is required'),
  ADMIN_WALLETS: z.string().optional().default(''),
  NEXT_PUBLIC_COMPANY_NAME: z.string().default('CoreFlow'),
  AUTH_SECRET: z.string().min(16, 'AUTH_SECRET must be at least 16 characters').optional().default('default_super_secret_coreflow_jwt_key_32bytes'),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional().default(''),
});

const parseEnv = () => {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables configuration:');
    console.error(JSON.stringify(result.error.format(), null, 2));
    throw new Error('Invalid environment variables. Fix the errors above and restart.');
  }
  return result.data;
};

export const env = parseEnv();
