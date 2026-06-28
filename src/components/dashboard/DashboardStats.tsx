interface DashboardStatsProps {
  stats: {
    total: number;
    pending: number;
    approved: number;
    released: number;
  };
}

export function DashboardStats({ stats }: DashboardStatsProps) {
  const statCards = [
    { label: 'Total Escrows', value: stats.total, color: 'from-violet-500', bgColor: 'from-violet-950/20 to-slate-900/10' },
    { label: 'Active Escrows', value: stats.pending, color: 'from-purple-500', bgColor: 'from-purple-950/20 to-slate-900/10' },
    { label: 'Ready to Release', value: stats.approved, color: 'from-indigo-500', bgColor: 'from-indigo-950/20 to-slate-900/10' },
    { label: 'Completed Payouts', value: stats.released, color: 'from-emerald-500', bgColor: 'from-emerald-950/15 to-slate-900/10' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {statCards.map((stat, i) => (
        <div
          key={i}
          className={`p-4 rounded-2xl border border-white/5 bg-gradient-to-br ${stat.bgColor} backdrop-blur-md shadow-sm`}
        >
          <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 font-semibold">{stat.label}</p>
          <p className={`text-2xl font-black bg-gradient-to-r ${stat.color} to-slate-300 bg-clip-text text-transparent`}>
            {stat.value}
          </p>
        </div>
      ))}
    </div>
  );
}
