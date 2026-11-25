// @vitest-environment node
/**
 * Route protection, checked against the policy in src/lib/auth/api-access.ts.
 *
 * 1. Every API route handler in src/app/api is classified, with exactly the
 *    HTTP methods it exports. Adding a route without classifying it fails here.
 * 2. The edge middleware rejects a request without a session for every route
 *    the policy marks as middleware-protected, and its matcher covers them.
 * 3. Routes the policy marks as public are not blocked by the middleware.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { API_ACCESS, SESSION_ACCESS, type Method } from '../api-access';
import { middleware, config } from '../../../middleware';

const API_DIR = path.resolve(__dirname, '../../../app/api');
const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...findRouteFiles(full));
    else if (/^route\.(ts|tsx|js)$/.test(name)) out.push(full);
  }
  return out;
}

function exportedMethods(source: string): Method[] {
  return METHODS.filter((m) =>
    new RegExp(
      `export\\s+(async\\s+)?function\\s+${m}\\b|export\\s+const\\s+${m}\\b|export\\s*\\{[^}]*\\b${m}\\b[^}]*\\}`
    ).test(source)
  );
}

const discovered = Object.fromEntries(
  findRouteFiles(API_DIR).map((file) => {
    const route = '/api/' + path.relative(API_DIR, path.dirname(file)).split(path.sep).join('/');
    return [route, exportedMethods(readFileSync(file, 'utf8')).sort()];
  })
) as Record<string, Method[]>;

/** A concrete URL path for a route pattern such as /api/admin/users/[id]/role. */
const concrete = (route: string) => route.replace(/\[[^\]]+\]/g, 'sample');

describe('API route classification', () => {
  it('finds the route handlers', () => {
    expect(Object.keys(discovered).length).toBeGreaterThan(20);
  });

  it.each(Object.keys(discovered))('%s is classified in API_ACCESS', (route) => {
    expect(
      API_ACCESS[route],
      `${route} has no entry in src/lib/auth/api-access.ts. Classify it as public or protected.`
    ).toBeDefined();
  });

  it.each(Object.keys(discovered))('%s: every exported method is classified', (route) => {
    const classified = Object.keys(API_ACCESS[route]?.methods ?? {}).sort();
    expect(classified).toEqual(discovered[route]);
  });

  it.each(Object.keys(API_ACCESS))('%s in API_ACCESS still exists', (route) => {
    expect(discovered[route], `${route} is classified but has no route handler`).toBeDefined();
  });

  it('a route with session-level methods is middleware-protected unless listed here', () => {
    // These check the session in the handler only (they sit outside the
    // middleware's prefixes for historical reasons and are covered by the
    // handler tests in route-protection.test.ts).
    const handlerOnly = new Set(['/api/auth/me', '/api/auth/profile', '/api/invitations/[token]']);
    for (const [route, policy] of Object.entries(API_ACCESS)) {
      const needsSession = Object.values(policy.methods).some((a) => a && SESSION_ACCESS.has(a));
      if (needsSession && !handlerOnly.has(route)) {
        expect(policy.middleware, `${route} needs a session but is not middleware-protected`).toBe(true);
      }
    }
  });
});

const matcherBases = config.matcher.map((m) => m.replace(/\/:path\*$/, ''));
const matches = (pathname: string) =>
  matcherBases.some((base) => pathname === base || pathname.startsWith(base + '/'));

const middlewareCases = Object.entries(API_ACCESS).flatMap(([route, policy]) =>
  Object.entries(policy.methods).map(([method, access]) => ({ route, method, access, policy }))
);

describe('edge middleware', () => {
  const protectedCases = middlewareCases.filter(
    (c) => c.policy.middleware && c.access && SESSION_ACCESS.has(c.access)
  );

  it.each(protectedCases)('$method $route: 401 without a session', async ({ route, method }) => {
    const pathname = concrete(route);
    expect(matches(pathname), `middleware matcher does not cover ${pathname}`).toBe(true);
    const res = await middleware(new NextRequest(`http://localhost${pathname}`, { method }));
    expect(res.status).toBe(401);
  });

  it.each(middlewareCases.filter((c) => !c.policy.middleware))(
    '$method $route: not blocked by the middleware',
    async ({ route, method }) => {
      const res = await middleware(new NextRequest(`http://localhost${concrete(route)}`, { method }));
      expect(res.status).not.toBe(401);
    }
  );
});
