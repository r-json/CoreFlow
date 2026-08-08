'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Home } from 'lucide-react';

const ROUTE_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  admin: 'Admin',
  employee: 'Employee',
  escrows: 'Escrows',
  users: 'Users',
  invitations: 'Invitations',
  'audit-logs': 'Audit Logs',
  settings: 'Settings',
  hours: 'Hours',
  payments: 'Payments',
  profile: 'Profile',
};

export function Breadcrumbs() {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);

  if (segments.length <= 1) return null;

  const crumbs = segments.map((segment, index) => {
    const href = '/' + segments.slice(0, index + 1).join('/');
    const label = ROUTE_LABELS[segment] || segment.charAt(0).toUpperCase() + segment.slice(1);
    const isLast = index === segments.length - 1;

    return { href, label, isLast };
  });

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[11px] font-medium mb-6">
      <Link
        href="/"
        className="text-slate-500 hover:text-slate-300 transition-colors p-1 rounded-md hover:bg-slate-900/60"
        title="Home"
      >
        <Home className="w-3.5 h-3.5" />
      </Link>

      {crumbs.map((crumb) => (
        <span key={crumb.href} className="flex items-center gap-1.5">
          <ChevronRight className="w-3 h-3 text-slate-600" />
          {crumb.isLast ? (
            <span className="text-slate-300 font-bold">{crumb.label}</span>
          ) : (
            <Link
              href={crumb.href}
              className="text-slate-500 hover:text-slate-300 transition-colors"
            >
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
