'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useState, useEffect } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Crown,
  Users,
  LogOut,
  Home,
  Menu,
  X,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
  badge?: string | number;
  badgeColor?: string;
}

interface SidebarProps {
  title: string;
  subtitle: string;
  navItems: NavItem[];
  accentColor: 'amber' | 'sky';
  roleIcon?: ReactNode;
  walletAddress?: string;
  role?: string;
  onSignOut?: () => void;
}

const ACCENT_MAP = {
  amber: {
    text: 'text-amber-400',
    activeBg: 'bg-amber-500/15',
    activeBorder: 'border-amber-500/30',
    activeText: 'text-amber-300',
    iconBg: 'bg-amber-500/10',
    iconBorder: 'border-amber-500/30',
    shadow: 'shadow-amber-500/10',
    mobileBg: 'bg-amber-500/10',
    mobileText: 'text-amber-400',
  },
  sky: {
    text: 'text-sky-400',
    activeBg: 'bg-sky-500/15',
    activeBorder: 'border-sky-500/30',
    activeText: 'text-sky-300',
    iconBg: 'bg-sky-500/10',
    iconBorder: 'border-sky-500/30',
    shadow: 'shadow-sky-500/10',
    mobileBg: 'bg-sky-500/10',
    mobileText: 'text-sky-400',
  },
};

export function Sidebar({
  title,
  subtitle,
  navItems,
  accentColor,
  roleIcon,
  walletAddress,
  role,
  onSignOut,
}: SidebarProps) {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const accent = ACCENT_MAP[accentColor];

  const truncatedAddress = walletAddress
    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
    : '';

  // Close mobile menu on route change
  useEffect(() => {
    setIsMobileOpen(false);
  }, [pathname]);

  // Close on escape key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMobileOpen(false);
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, []);

  const navContent = (
    <>
      {/* Logo / Brand */}
      <div className="px-4 py-5 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div
            className={`w-9 h-9 rounded-xl ${accent.iconBg} ${accent.iconBorder} border flex items-center justify-center shrink-0`}
          >
            {roleIcon || (accentColor === 'amber' ? (
              <Crown className={`w-4 h-4 ${accent.text}`} />
            ) : (
              <Users className={`w-4 h-4 ${accent.text}`} />
            ))}
          </div>
          {(!isCollapsed || isMobileOpen) && (
            <div className="overflow-hidden">
              <h2 className="text-sm font-extrabold text-white tracking-tight truncate">
                {title}
              </h2>
              <p className="text-[10px] text-slate-500 truncate">{subtitle}</p>
            </div>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto custom-scrollbar">
        {/* Dashboard Home link */}
        <Link
          href="/"
          className="flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-semibold transition-all duration-200 text-slate-500 hover:text-slate-300 hover:bg-slate-900/60"
          title="Back to Landing"
        >
          <Home className="w-4 h-4 shrink-0" />
          {(!isCollapsed || isMobileOpen) && <span>Landing Page</span>}
        </Link>

        <div className="h-px bg-white/5 my-2" />

        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== '/dashboard/admin' &&
              item.href !== '/dashboard/employee' &&
              pathname.startsWith(item.href));

          return (
            <Link
              key={item.href}
              href={item.href}
              title={isCollapsed && !isMobileOpen ? item.label : undefined}
              className={`group flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all duration-200
                ${
                  isActive
                    ? `${accent.activeBg} ${accent.activeBorder} border ${accent.activeText} ${accent.shadow} shadow-md`
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
                }`}
            >
              <span className={`shrink-0 ${isActive ? accent.text : 'text-slate-500 group-hover:text-slate-300'}`}>
                {item.icon}
              </span>
              {(!isCollapsed || isMobileOpen) && (
                <span className="flex-1 truncate">{item.label}</span>
              )}
              {(!isCollapsed || isMobileOpen) && item.badge !== undefined && (
                <span
                  className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                    item.badgeColor || 'bg-violet-500/20 text-violet-300'
                  }`}
                >
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* User section */}
      <div className="px-3 py-4 border-t border-white/5 space-y-2">
        {walletAddress && (!isCollapsed || isMobileOpen) && (
          <div className="px-3 py-2 rounded-xl bg-slate-900/60 border border-white/5">
            <p className="text-[9px] text-slate-500 uppercase font-bold tracking-wider mb-1">
              Connected Wallet
            </p>
            <p className="text-[11px] font-mono text-slate-300">{truncatedAddress}</p>
            {role && (
              <span
                className={`inline-block mt-1 text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                  role === 'ADMIN'
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                    : 'bg-sky-500/10 border-sky-500/30 text-sky-400'
                }`}
              >
                {role}
              </span>
            )}
          </div>
        )}

        {onSignOut && (
          <button
            onClick={onSignOut}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-rose-400 hover:bg-rose-950/20 border border-transparent hover:border-rose-500/20 transition-all"
            title="Sign Out"
          >
            <LogOut className="w-3.5 h-3.5" />
            {(!isCollapsed || isMobileOpen) && <span>Sign Out</span>}
          </button>
        )}
      </div>
    </>
  );

  return (
    <>
      {/* Mobile Hamburger Button */}
      <button
        onClick={() => setIsMobileOpen(true)}
        className={`lg:hidden fixed top-4 left-4 z-50 p-2.5 rounded-xl ${accent.mobileBg} border ${accent.iconBorder} ${accent.mobileText} shadow-lg backdrop-blur-xl`}
        aria-label="Open navigation menu"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Mobile Overlay */}
      {isMobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-sm animate-fade-in"
          onClick={() => setIsMobileOpen(false)}
        >
          <aside
            className="w-[280px] h-full flex flex-col bg-slate-950/95 backdrop-blur-2xl border-r border-white/5 animate-slide-in-right shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Mobile close button */}
            <div className="absolute top-4 right-4">
              <button
                onClick={() => setIsMobileOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {navContent}
          </aside>
        </div>
      )}

      {/* Desktop Sidebar */}
      <aside
        className={`hidden lg:flex sticky top-0 h-screen flex-col border-r border-white/5 bg-slate-950/90 backdrop-blur-2xl transition-all duration-300 ${
          isCollapsed ? 'w-[72px]' : 'w-[260px]'
        }`}
      >
        {navContent}

        {/* Collapse Toggle (desktop only) */}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-700 transition-all z-50 shadow-lg"
        >
          {isCollapsed ? (
            <ChevronRight className="w-3 h-3" />
          ) : (
            <ChevronLeft className="w-3 h-3" />
          )}
        </button>
      </aside>
    </>
  );
}
