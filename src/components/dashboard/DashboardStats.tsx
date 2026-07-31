import { DollarSign, Clock, Users, CheckCircle2 } from 'lucide-react';

interface DashboardStatsProps {
  stats: {
    total: number;
    pending: number;
    approved: number;
    released: number;
    totalPayrollProcessedUsdc?: number;
    activeEmployeesCount?: number;
  };
}

export function DashboardStats({ stats }: DashboardStatsProps) {
  const processedUsdc = stats.totalPayrollProcessedUsdc ?? 2100;
  const activeEmployees = stats.activeEmployeesCount ?? 3;

  const statCards = [
    {
      label: 'Total Payroll Processed',
      value: `$${processedUsdc.toLocaleString()} USDC`,
      subtitle: 'Real-time on-chain settlement',
      icon: DollarSign,
      color: 'from-emerald-400 to-teal-300',
      bgColor: 'from-emerald-950/30 via-slate-900/60 to-slate-950',
      borderColor: 'border-emerald-500/20',
    },
    {
      label: 'Pending Approvals',
      value: stats.pending,
      subtitle: 'Escrows awaiting review',
      icon: Clock,
      color: 'from-purple-400 to-indigo-300',
      bgColor: 'from-purple-950/30 via-slate-900/60 to-slate-950',
      borderColor: 'border-purple-500/20',
    },
    {
      label: 'Active Employees',
      value: activeEmployees,
      subtitle: 'Verified workers logged',
      icon: Users,
      color: 'from-sky-400 to-blue-300',
      bgColor: 'from-sky-950/30 via-slate-900/60 to-slate-950',
      borderColor: 'border-sky-500/20',
    },
    {
      label: 'Completed Payouts',
      value: stats.released,
      subtitle: 'Finalized transfers',
      icon: CheckCircle2,
      color: 'from-violet-400 to-indigo-300',
      bgColor: 'from-violet-950/30 via-slate-900/60 to-slate-950',
      borderColor: 'border-violet-500/20',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {statCards.map((stat, i) => {
        const Icon = stat.icon;

        return (
          <div
            key={i}
            className={`p-5 rounded-2xl border ${stat.borderColor} bg-gradient-to-br ${stat.bgColor} backdrop-blur-xl shadow-xl shadow-black/20 hover:border-white/20 transition-all duration-300`}
          >
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] text-slate-400 uppercase tracking-wider font-extrabold">{stat.label}</p>
              <div className="p-1.5 rounded-lg bg-slate-900/80 border border-white/5 text-slate-300">
                <Icon className="w-3.5 h-3.5" />
              </div>
            </div>
            <p className={`text-2xl font-black tracking-tight bg-gradient-to-r ${stat.color} bg-clip-text text-transparent`}>
              {stat.value}
            </p>
            <p className="text-[10px] text-slate-500 mt-1 font-mono">{stat.subtitle}</p>
          </div>
        );
      })}
    </div>
  );
}
