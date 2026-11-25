/**
 * Access policy for every API route handler, by path and HTTP method.
 *
 * This is the single list the tests check the code against:
 *   - every `src/app/api/** /route.ts` handler must appear here (a new route
 *     cannot ship without being classified as public or protected), and
 *   - every non-public entry must be rejected without a session, both by the
 *     edge middleware (when `middleware: true`) and by the handler itself.
 *
 * Access levels:
 *   public          no session required, by design
 *   session         any signed-in user (ADMIN or EMPLOYEE)
 *   admin           platform ADMIN only
 *   tenant          signed-in user with an ACTIVE organization membership and
 *                   the org role permission required by the route
 *   escrow-manager  signed-in tenant member with `oracle:attest:request` who is
 *                   also the escrow's on-chain manager
 *   bootstrap-secret / cron-secret
 *                   no session; a server-side shared secret instead
 */

export type Access =
  | 'public'
  | 'session'
  | 'admin'
  | 'tenant'
  | 'escrow-manager'
  | 'bootstrap-secret'
  | 'cron-secret';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RoutePolicy {
  methods: Partial<Record<Method, Access>>;
  /** True when src/middleware.ts must reject a request without a session. */
  middleware: boolean;
}

export const SESSION_ACCESS: ReadonlySet<Access> = new Set([
  'session',
  'admin',
  'tenant',
  'escrow-manager',
]);

export const API_ACCESS: Record<string, RoutePolicy> = {
  '/api/admin/audit-logs': { methods: { GET: 'tenant' }, middleware: true },
  '/api/admin/bootstrap': { methods: { POST: 'bootstrap-secret' }, middleware: false },
  // GET only reports whether the contract is paused; the middleware still
  // requires a session for it because it sits under /api/admin.
  '/api/admin/contract/pause': { methods: { GET: 'session', POST: 'admin' }, middleware: true },
  '/api/admin/roles': { methods: { GET: 'admin', POST: 'admin' }, middleware: true },
  '/api/admin/users': { methods: { GET: 'admin' }, middleware: true },
  '/api/admin/users/[id]/role': { methods: { PATCH: 'admin' }, middleware: true },

  '/api/auth/challenge': { methods: { POST: 'public' }, middleware: false },
  '/api/auth/verify': { methods: { POST: 'public' }, middleware: false },
  '/api/auth/logout': { methods: { POST: 'public' }, middleware: false },
  '/api/auth/me': { methods: { GET: 'session' }, middleware: false },
  '/api/auth/profile': { methods: { GET: 'session' }, middleware: false },

  '/api/escrows': { methods: { GET: 'session', POST: 'admin' }, middleware: true },
  '/api/hours': { methods: { POST: 'session' }, middleware: true },

  '/api/oracle/attest': { methods: { POST: 'escrow-manager' }, middleware: true },
  '/api/oracle/pubkey': { methods: { GET: 'public' }, middleware: false },
  '/api/submit-batch': { methods: { POST: 'escrow-manager' }, middleware: true },

  '/api/organizations': { methods: { GET: 'session', POST: 'session' }, middleware: true },
  '/api/organizations/[id]/escrows/claim': { methods: { POST: 'tenant' }, middleware: true },
  '/api/organizations/[id]/findings': { methods: { GET: 'tenant' }, middleware: true },
  '/api/organizations/[id]/findings/[findingId]': { methods: { PATCH: 'tenant' }, middleware: true },
  '/api/organizations/[id]/invitations': {
    methods: { GET: 'tenant', POST: 'tenant' },
    middleware: true,
  },
  '/api/organizations/[id]/invitations/[invitationId]': {
    methods: { DELETE: 'tenant' },
    middleware: true,
  },
  '/api/organizations/[id]/members': { methods: { GET: 'tenant' }, middleware: true },
  '/api/organizations/[id]/members/[memberId]': {
    methods: { PATCH: 'tenant', DELETE: 'tenant' },
    middleware: true,
  },
  '/api/organizations/[id]/reconciliation': {
    methods: { GET: 'tenant', POST: 'tenant' },
    middleware: true,
  },

  '/api/payments': { methods: { GET: 'tenant' }, middleware: true },
  '/api/payments/[id]': { methods: { GET: 'tenant' }, middleware: true },
  '/api/payments/[id]/approve': { methods: { POST: 'tenant' }, middleware: true },
  '/api/payments/[id]/cancel': { methods: { POST: 'tenant' }, middleware: true },
  '/api/payments/[id]/reconcile': { methods: { POST: 'tenant' }, middleware: true },
  '/api/payments/[id]/reject': { methods: { POST: 'tenant' }, middleware: true },
  '/api/payments/[id]/retry': { methods: { POST: 'tenant' }, middleware: true },
  '/api/payments/[id]/submit': { methods: { POST: 'tenant' }, middleware: true },

  '/api/payroll/batches': { methods: { GET: 'tenant', POST: 'tenant' }, middleware: true },
  '/api/payroll/batches/validate': { methods: { POST: 'tenant' }, middleware: true },
  '/api/payroll/batches/[id]': { methods: { GET: 'tenant' }, middleware: true },
  '/api/payroll/batches/[id]/approve': { methods: { POST: 'tenant' }, middleware: true },
  '/api/payroll/batches/[id]/validate': { methods: { POST: 'tenant' }, middleware: true },
  '/api/payroll/batches/[id]/funding': { methods: { GET: 'tenant' }, middleware: true },
  '/api/payroll/batches/[id]/funding/intent': { methods: { POST: 'tenant' }, middleware: true },
  '/api/payroll/batches/[id]/funding/submitted': { methods: { POST: 'tenant' }, middleware: true },
  '/api/payroll/batches/[id]/funding/confirm': { methods: { POST: 'tenant' }, middleware: true },
  '/api/payroll/batches/[id]/funding/abandon': { methods: { POST: 'tenant' }, middleware: true },

  // GET looks up an invitation by its unguessable token (the invite page);
  // POST accepts it and needs the signed-in wallet.
  '/api/invitations/[token]': { methods: { GET: 'public', POST: 'session' }, middleware: false },

  '/api/indexer/run': { methods: { GET: 'cron-secret' }, middleware: false },
  '/api/reconciliation/run': { methods: { POST: 'cron-secret' }, middleware: false },
  '/api/health': { methods: { GET: 'public' }, middleware: false },
  '/api/health/ready': { methods: { GET: 'public' }, middleware: false },
  '/api/openapi.json': { methods: { GET: 'public' }, middleware: false },
  '/api/observability/report': { methods: { POST: 'public' }, middleware: false },
};
