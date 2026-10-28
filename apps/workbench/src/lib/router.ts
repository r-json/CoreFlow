import { useEffect, useState } from 'react';

export const ROUTES = ['overview', 'compose', 'verify', 'inspect', 'vectors', 'errors', 'evidence'] as const;
export type Route = (typeof ROUTES)[number];

/** Hash routing keeps the build a set of static files that work from any folder. */
export function routeFromHash(hash: string): Route {
  const name = hash.replace(/^#\/?/, '').split(/[?/]/)[0] ?? '';
  return (ROUTES as readonly string[]).includes(name) ? (name as Route) : 'overview';
}

export function hrefFor(route: Route): string {
  return route === 'overview' ? '#/' : `#/${route}`;
}

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
