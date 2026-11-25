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
 *   admin           ADMIN only
 *   escrow-worker   ADMIN, or the wallet that is the on-chain worker of the
 *                   escrow payment in the request
 *   escrow-manager  ADMIN, or the wallet that is the on-chain manager of the
 *                   escrow in the request
 *   bootstrap-secret / cron-secret
 *                   no session; a server-side shared secret instead
 */

export type Access =
  | 'public'
  | 'session'
  | 'admin'
  | 'escrow-worker'
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
  'escrow-worker',
  'escrow-manager',
]);

export const API_ACCESS: Record<string, RoutePolicy> = {
  '/api/admin/audit-logs': { methods: { GET: 'admin' }, middleware: true },
  '/api/admin/bootstrap': { methods: { POST: 'bootstrap-secret' }, middleware: false },
  // GET only reports whether the contract is paused; the middleware still
  // requires a session for it because it sits under /api/admin.
  '/api/admin/contract/pause': { methods: { GET: 'session', POST: 'admin' }, middleware: true },
  '/api/admin/invitations': { methods: { GET: 'admin', POST: 'admin' }, middleware: true },
  '/api/admin/invitations/[token]': { methods: { DELETE: 'admin' }, middleware: true },
  '/api/admin/roles': { methods: { GET: 'admin', POST: 'admin' }, middleware: true },
  '/api/admin/users': { methods: { GET: 'admin' }, middleware: true },
  '/api/admin/users/[id]/role': { methods: { PATCH: 'admin' }, middleware: true },

  '/api/auth/challenge': { methods: { POST: 'public' }, middleware: false },
  '/api/auth/verify': { methods: { POST: 'public' }, middleware: false },
  '/api/auth/logout': { methods: { POST: 'public' }, middleware: false },
  '/api/auth/me': { methods: { GET: 'session' }, middleware: false },
  '/api/auth/profile': { methods: { GET: 'session' }, middleware: false },

  '/api/escrows': { methods: { GET: 'session', POST: 'admin' }, middleware: true },
  '/api/escrows/[id]/status': { methods: { PATCH: 'admin' }, middleware: true },
  '/api/hours': { methods: { POST: 'session' }, middleware: true },

  '/api/oracle/attest': { methods: { POST: 'escrow-worker' }, middleware: true },
  '/api/oracle/pubkey': { methods: { GET: 'public' }, middleware: false },
  '/api/submit-batch': { methods: { POST: 'escrow-manager' }, middleware: true },

  // GET looks up an invitation by its unguessable token (the invite page);
  // POST accepts it and needs the signed-in wallet.
  '/api/invitations/[token]': { methods: { GET: 'public', POST: 'session' }, middleware: false },

  '/api/indexer/run': { methods: { GET: 'cron-secret' }, middleware: false },
  '/api/health': { methods: { GET: 'public' }, middleware: false },
  '/api/health/ready': { methods: { GET: 'public' }, middleware: false },
  '/api/openapi.json': { methods: { GET: 'public' }, middleware: false },
  '/api/observability/report': { methods: { POST: 'public' }, middleware: false },
};
