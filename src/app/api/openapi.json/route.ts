import { NextResponse } from 'next/server';

export async function GET() {
  const openApiSpec = {
    openapi: '3.0.3',
    info: {
      title: 'CoreFlow Enterprise Payroll API',
      version: '1.0.0',
      description:
        'Production API specification for CoreFlow trustless accounts payable, Ed25519 authentication, and Soroban contract escrow management.',
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Local Development Server',
      },
      {
        url: 'https://coreflow.vercel.app',
        description: 'Production Launch Environment',
      },
    ],
    paths: {
      '/api/auth/challenge': {
        post: {
          summary: 'Request Authentication Challenge Nonce',
          description: 'Generates a 5-minute single-use Ed25519 signing challenge for Freighter wallet verification.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    walletAddress: { type: 'string', example: 'GBPLBGLHRDLWGA4XXIQOHCQXP23EN4IPJBCOTZ7KRDJXM5Y7YKPIL3SG' },
                  },
                  required: ['walletAddress'],
                },
              },
            },
          },
          responses: {
            200: { description: 'Challenge created successfully' },
            400: { description: 'Invalid wallet address format' },
          },
        },
      },
      '/api/auth/verify': {
        post: {
          summary: 'Verify Ed25519 Signature & Issue HttpOnly Cookie',
          description: 'Verifies Freighter SEP-53 challenge signature, upserts user record, and sets secure HttpOnly cookie.',
          responses: {
            200: { description: 'Authenticated successfully' },
            401: { description: 'Invalid signature or expired challenge' },
          },
        },
      },
      '/api/escrows': {
        get: {
          summary: 'List Escrows with Cursor Pagination',
          description: 'Fetches paginated escrow contracts for authenticated admins (all) or employees (own records).',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'Array of escrows with pagination metadata' },
            401: { description: 'Unauthorized' },
          },
        },
        post: {
          summary: 'Create On-Chain Escrow Record',
          description: 'Registers a new Soroban escrow allocation. Requires ADMIN role.',
          responses: {
            201: { description: 'Escrow created successfully' },
            403: { description: 'Forbidden: ADMIN role required' },
          },
        },
      },
      '/api/hours': {
        post: {
          summary: 'Submit Work Log & Request Attestation',
          description: 'Submits hours worked against an active escrow contract for oracle verification.',
          responses: {
            200: { description: 'Work hours submitted' },
            400: { description: 'Validation failed' },
          },
        },
      },
      '/api/admin/invitations': {
        post: {
          summary: 'Generate Employee Onboarding Invitation Link',
          description: 'Creates a time-limited invitation token for self-service employee onboarding. Requires ADMIN role.',
          responses: {
            201: { description: 'Invitation token created' },
            403: { description: 'Forbidden' },
          },
        },
      },
      '/api/admin/contract/pause': {
        post: {
          summary: 'Emergency Stop Contract Halting',
          description: 'Circuit breaker endpoint to instantly pause or resume all Soroban smart contract operations.',
          responses: {
            200: { description: 'Pause state toggled successfully' },
            403: { description: 'Forbidden' },
          },
        },
      },
    },
  };

  return NextResponse.json(openApiSpec, { status: 200 });
}
