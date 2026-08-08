'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
  Crown,
  Users,
  ShieldCheck,
  ScrollText,

  Clock,
  CheckCircle2,

  AlertTriangle,
  PlusCircle,
  ArrowUpRight,
  RefreshCw,
  Activity,
  Mail,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';

interface OverviewStats {
  totalUsers: number;
  adminCount: number;
  employeeCount: number;
  totalEscrows: number;
  pendingEscrows: number;
  readyEscrows: number;
  paidEscrows: number;
  rejectedEscrows: number;
  cancelledEscrows: number;
  pendingInvitations: number;
  totalAuditLogs: number;
}

interface RecentAuditLog {
  id: string;
  action: string;
  actor: string | null;
  target: string | null;
  createdAt: string;
}

const ACTION_COLORS: Record<string, string> = {
  'role.grant': 'text-amber-400',
  'role.update': 'text-amber-400',
  'invitation.create': 'text-sky-400',
  'invitation.accept': 'text-emerald-400',
  'invitation.revoke': 'text-rose-400',
  'escrow.create': 'text-indigo-400',
  'escrow.status_update': 'text-purple-400',
  'escrow.reject': 'text-rose-400',
  'auth.logout': 'text-slate-400',
  'hours.submit': 'text-cyan-400',
  'contract.pause': 'text-rose-400',
};

export default function AdminOverviewPage() {
  const auth = useAuth();
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [recentLogs, setRecentLogs] = useState<RecentAuditLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchOverview = async () => {
    setIsLoading(true);
    try {
      const [usersRes, escrowsRes, invitationsRes, logsRes] = await Promise.all([
        fetch('/api/admin/users'),
        fetch('/api/escrows?limit=50'),
        fetch('/api/admin/invitations'),
        fetch('/api/admin/audit-logs?limit=10'),
      ]);

      const users = usersRes.ok ? (await usersRes.json()).users || [] : [];
      const escrows = escrowsRes.ok ? (await escrowsRes.json()).escrows || [] : [];
      const invitations = invitationsRes.ok ? (await invitationsRes.json()).invitations || [] : [];
      const logs = logsRes.ok ? (await logsRes.json()).logs || [] : [];

      setStats({
        totalUsers: users.length,
        adminCount: users.filter((u: any) => u.role === 'ADMIN').length,
        employeeCount: users.filter((u: any) => u.role === 'EMPLOYEE').length,
        totalEscrows: escrows.length,
        pendingEscrows: escrows.filter(
          (e: any) => e.status === 'pending_manager' || e.status === 'pending_finance'
        ).length,
        readyEscrows: escrows.filter((e: any) => e.status === 'ready').length,
        paidEscrows: escrows.filter((e: any) => e.status === 'paid').length,
        rejectedEscrows: escrows.filter((e: any) => e.status === 'rejected').length,
        cancelledEscrows: escrows.filter((e: any) => e.status === 'cancelled').length,
        pendingInvitations: invitations.filter(
          (inv: any) => !inv.usedAt && new Date(inv.expiresAt) > new Date()
        ).length,
        totalAuditLogs: logs.length,
      });
      setRecentLogs(logs.slice(0, 8));
    } catch (err) {
      console.error('Failed to load overview:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (auth.isAuthenticated && auth.isAdmin) {
      fetchOverview();
    }
  }, [auth.isAuthenticated, auth.isAdmin]);

  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="max-w-7xl mx-auto px-8 py-8">
      {/* Page header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
              <Crown className="w-5 h-5 text-amber-400" />
            </div>
            Admin Overview
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Operational dashboard — real-time system health & activity
          </p>
        </div>
        <button
          onClick={fetchOverview}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-slate-300 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-32 rounded-2xl bg-slate-900/40 animate-pulse border border-white/5"
            />
          ))}
        </div>
      ) : stats ? (
        <>
          {/* KPI Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <StatCard
              label="Total Users"
              value={stats.totalUsers}
              subtitle={`${stats.adminCount} admins · ${stats.employeeCount} employees`}
              icon={<Users className="w-4 h-4" />}
              gradient="from-sky-400 to-blue-300"
              bgGradient="from-sky-950/30 via-slate-900/60 to-slate-950"
              borderColor="border-sky-500/20"
            />
            <StatCard
              label="Active Escrows"
              value={stats.totalEscrows}
              subtitle={`${stats.pendingEscrows} pending · ${stats.readyEscrows} ready`}
              icon={<ShieldCheck className="w-4 h-4" />}
              gradient="from-violet-400 to-indigo-300"
              bgGradient="from-violet-950/30 via-slate-900/60 to-slate-950"
              borderColor="border-violet-500/20"
            />
            <StatCard
              label="Completed Payouts"
              value={stats.paidEscrows}
              subtitle="Finalized & settled on-chain"
              icon={<CheckCircle2 className="w-4 h-4" />}
              gradient="from-emerald-400 to-teal-300"
              bgGradient="from-emerald-950/30 via-slate-900/60 to-slate-950"
              borderColor="border-emerald-500/20"
            />
            <StatCard
              label="Pending Invitations"
              value={stats.pendingInvitations}
              subtitle="Awaiting team onboarding"
              icon={<Mail className="w-4 h-4" />}
              gradient="from-amber-400 to-orange-300"
              bgGradient="from-amber-950/30 via-slate-900/60 to-slate-950"
              borderColor="border-amber-500/20"
            />
          </div>

          {/* Secondary Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            <MiniStatCard
              label="Pending Approvals"
              value={stats.pendingEscrows}
              icon={<Clock className="w-4 h-4 text-purple-400" />}
              color="text-purple-300"
            />
            <MiniStatCard
              label="Rejected Escrows"
              value={stats.rejectedEscrows}
              icon={<XCircle className="w-4 h-4 text-rose-400" />}
              color="text-rose-300"
            />
            <MiniStatCard
              label="Cancelled Escrows"
              value={stats.cancelledEscrows}
              icon={<AlertTriangle className="w-4 h-4 text-amber-400" />}
              color="text-amber-300"
            />
          </div>

          {/* Quick Actions + Recent Activity */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Quick Actions */}
            <div className="lg:col-span-1 space-y-4">
              <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-400 mb-3">
                Quick Actions
              </h2>
              <QuickActionCard
                label="Create Escrow"
                description="Initialize a new escrow for a worker"
                icon={<PlusCircle className="w-5 h-5 text-violet-400" />}
                href="/dashboard/admin/escrows"
                color="violet"
              />
              <QuickActionCard
                label="Invite Team Member"
                description="Generate a secure onboarding link"
                icon={<Mail className="w-5 h-5 text-sky-400" />}
                href="/dashboard/admin/invitations"
                color="sky"
              />
              <QuickActionCard
                label="Manage Roles"
                description="Promote or demote user permissions"
                icon={<Crown className="w-5 h-5 text-amber-400" />}
                href="/dashboard/admin/users"
                color="amber"
              />
              <QuickActionCard
                label="View Audit Trail"
                description="Review security-sensitive actions"
                icon={<ScrollText className="w-5 h-5 text-slate-400" />}
                href="/dashboard/admin/audit-logs"
                color="slate"
              />
            </div>

            {/* Recent Activity */}
            <div className="lg:col-span-2">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-extrabold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                  <Activity className="w-3.5 h-3.5 text-violet-400" />
                  Recent Activity
                </h2>
                <Link
                  href="/dashboard/admin/audit-logs"
                  className="text-[10px] font-bold text-violet-400 hover:text-violet-300 transition-colors flex items-center gap-1"
                >
                  View All
                  <ArrowUpRight className="w-3 h-3" />
                </Link>
              </div>

              <div className="rounded-2xl border border-white/10 bg-slate-900/40 backdrop-blur-xl overflow-hidden shadow-2xl">
                {recentLogs.length === 0 ? (
                  <div className="p-12 text-center text-slate-500">
                    <ScrollText className="w-8 h-8 mx-auto mb-2 text-slate-600" />
                    <p className="text-sm font-semibold">No recent activity</p>
                  </div>
                ) : (
                  <div className="divide-y divide-white/5">
                    {recentLogs.map((log) => (
                      <div
                        key={log.id}
                        className="px-5 py-3.5 flex items-center justify-between hover:bg-slate-900/30 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-2 h-2 rounded-full bg-violet-500/60" />
                          <div>
                            <span
                              className={`text-xs font-bold ${
                                ACTION_COLORS[log.action] || 'text-slate-400'
                              }`}
                            >
                              {log.action}
                            </span>
                            {log.actor && (
                              <span className="text-[10px] text-slate-500 ml-2 font-mono">
                                by{' '}
                                {log.actor.length > 12
                                  ? `${log.actor.slice(0, 6)}...${log.actor.slice(-4)}`
                                  : log.actor}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="text-[10px] text-slate-500 font-mono shrink-0">
                          {formatTime(log.createdAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="text-center py-16 text-slate-500">
          <AlertTriangle className="w-8 h-8 mx-auto mb-2" />
          <p className="text-sm font-semibold">Failed to load overview data</p>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  subtitle,
  icon,
  gradient,
  bgGradient,
  borderColor,
}: {
  label: string;
  value: number | string;
  subtitle: string;
  icon: React.ReactNode;
  gradient: string;
  bgGradient: string;
  borderColor: string;
}) {
  return (
    <div
      className={`p-5 rounded-2xl border ${borderColor} bg-gradient-to-br ${bgGradient} backdrop-blur-xl shadow-xl shadow-black/20 hover:border-white/20 transition-all duration-300 group`}
    >
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] text-slate-400 uppercase tracking-wider font-extrabold">
          {label}
        </p>
        <div className="p-1.5 rounded-lg bg-slate-900/80 border border-white/5 text-slate-300 group-hover:scale-110 transition-transform">
          {icon}
        </div>
      </div>
      <p
        className={`text-3xl font-black tracking-tight bg-gradient-to-r ${gradient} bg-clip-text text-transparent`}
      >
        {value}
      </p>
      <p className="text-[10px] text-slate-500 mt-1 font-mono">{subtitle}</p>
    </div>
  );
}

function MiniStatCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div className="p-4 rounded-xl border border-white/5 bg-slate-900/30 flex items-center gap-3 hover:border-white/10 transition-colors">
      <div className="p-2 rounded-lg bg-slate-900/80 border border-white/5">
        {icon}
      </div>
      <div>
        <p className={`text-lg font-black ${color}`}>{value}</p>
        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
          {label}
        </p>
      </div>
    </div>
  );
}

function QuickActionCard({
  label,
  description,
  icon,
  href,
  color,
}: {
  label: string;
  description: string;
  icon: React.ReactNode;
  href: string;
  color: string;
}) {
  return (
    <Link
      href={href}
      className={`group flex items-center gap-4 p-4 rounded-xl border border-white/5 bg-slate-900/30 hover:bg-slate-900/60 hover:border-${color}-500/20 transition-all duration-200`}
    >
      <div className={`p-2.5 rounded-xl bg-${color}-500/10 border border-${color}-500/20 shrink-0 group-hover:scale-110 transition-transform`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-bold text-white group-hover:text-slate-100 flex items-center gap-1.5">
          {label}
          <ArrowUpRight className="w-3 h-3 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" />
        </p>
        <p className="text-[10px] text-slate-500 truncate">{description}</p>
      </div>
    </Link>
  );
}
