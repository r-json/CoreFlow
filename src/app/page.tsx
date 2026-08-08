import Link from 'next/link';
import { ShieldCheck, Coins, FileCheck2, Crown, Users, ArrowRight, Lock } from 'lucide-react';

const FEATURES = [
  {
    icon: ShieldCheck,
    title: 'Multi-sig approvals',
    body: 'Manager and finance authorities both approve on-chain before any payment is released from escrow.',
  },
  {
    icon: FileCheck2,
    title: 'Oracle-verified hours',
    body: 'Work proofs are signed by an oracle and verified by the contract, preventing false or duplicate claims.',
  },
  {
    icon: Coins,
    title: 'USDC custody & settlement',
    body: 'Funds are held in the contract on creation and released to workers on finalize — trustless, auditable, low-fee.',
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950/50 to-slate-950 text-slate-100">
      <div className="max-w-5xl mx-auto px-6 py-20">
        {/* Hero */}
        <section className="text-center">
          <span className="inline-block text-xs font-semibold uppercase tracking-wider text-violet-300 border border-violet-500/30 bg-violet-500/10 rounded-full px-3 py-1 mb-6">
            On Stellar Soroban
          </span>
          <h1 className="text-4xl md:text-6xl font-black tracking-tight mb-5">
            Trustless payroll & B2B escrow
            <span className="block bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent">
              for distributed teams
            </span>
          </h1>
          <p className="max-w-2xl mx-auto text-base md:text-lg text-slate-400 mb-12">
            CoreFlow settles work payments on-chain with multi-signature approvals and
            oracle-verified hours — stronger transparency, auditability, and predictable
            cost than traditional cross-border payouts.
          </p>
        </section>

        {/* Role Access Cards */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl mx-auto mb-16" aria-label="Access portal">
          {/* Employee Access Card */}
          <Link
            href="/dashboard/employee"
            id="employee-access-btn"
            className="group relative rounded-2xl border border-sky-500/20 bg-slate-900/60 backdrop-blur-xl p-8 transition-all duration-300 hover:border-sky-400/40 hover:bg-slate-900/80 hover:shadow-2xl hover:shadow-sky-500/10 hover:-translate-y-1"
          >
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-sky-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            <div className="relative z-10">
              <div className="w-14 h-14 rounded-2xl bg-sky-500/10 border border-sky-500/30 text-sky-400 flex items-center justify-center mb-5 group-hover:scale-110 transition-transform duration-300">
                <Users className="w-7 h-7" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-extrabold text-white mb-2 flex items-center gap-2">
                Employee Access
                <ArrowRight className="w-4 h-4 text-sky-400 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300" />
              </h2>
              <p className="text-sm text-slate-400 leading-relaxed mb-4">
                View your assigned escrows, submit oracle-verified work hours, and track payment status in real-time.
              </p>
              <div className="flex flex-wrap gap-2">
                <span className="text-[10px] font-bold px-2 py-1 rounded-lg border bg-sky-500/10 border-sky-500/20 text-sky-400">
                  View Escrows
                </span>
                <span className="text-[10px] font-bold px-2 py-1 rounded-lg border bg-sky-500/10 border-sky-500/20 text-sky-400">
                  Submit Hours
                </span>
                <span className="text-[10px] font-bold px-2 py-1 rounded-lg border bg-sky-500/10 border-sky-500/20 text-sky-400">
                  Track Payments
                </span>
              </div>
            </div>
          </Link>

          {/* Admin Access Card */}
          <Link
            href="/dashboard/admin"
            id="admin-access-btn"
            className="group relative rounded-2xl border border-amber-500/20 bg-slate-900/60 backdrop-blur-xl p-8 transition-all duration-300 hover:border-amber-400/40 hover:bg-slate-900/80 hover:shadow-2xl hover:shadow-amber-500/10 hover:-translate-y-1"
          >
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-amber-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            <div className="relative z-10">
              <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center mb-5 group-hover:scale-110 transition-transform duration-300">
                <Crown className="w-7 h-7" aria-hidden="true" />
              </div>
              <h2 className="text-xl font-extrabold text-white mb-2 flex items-center gap-2">
                Admin Access
                <Lock className="w-3.5 h-3.5 text-amber-400/60" />
                <ArrowRight className="w-4 h-4 text-amber-400 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300" />
              </h2>
              <p className="text-sm text-slate-400 leading-relaxed mb-4">
                Full operational control — create escrows, manage approvals, assign roles, oversee payouts, and monitor the team.
              </p>
              <div className="flex flex-wrap gap-2">
                <span className="text-[10px] font-bold px-2 py-1 rounded-lg border bg-amber-500/10 border-amber-500/20 text-amber-400">
                  Create Escrows
                </span>
                <span className="text-[10px] font-bold px-2 py-1 rounded-lg border bg-amber-500/10 border-amber-500/20 text-amber-400">
                  Manage Roles
                </span>
                <span className="text-[10px] font-bold px-2 py-1 rounded-lg border bg-amber-500/10 border-amber-500/20 text-amber-400">
                  Approve Payments
                </span>
              </div>
            </div>
          </Link>
        </section>

        {/* Contract Link */}
        <div className="text-center mb-16">
          <a
            href="https://stellar.expert/explorer/public/contract/CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl font-semibold border border-white/10 bg-slate-900/60 hover:bg-slate-800 text-slate-200 transition-colors text-sm"
          >
            View Smart Contract on Stellar Expert
          </a>
        </div>

        {/* Features */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-5" aria-label="Key features">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-2xl border border-white/5 bg-slate-900/40 p-6 backdrop-blur-sm"
            >
              <div className="w-10 h-10 rounded-lg bg-violet-500/10 text-violet-400 flex items-center justify-center mb-4">
                <Icon className="w-5 h-5" aria-hidden="true" />
              </div>
              <h2 className="text-base font-bold text-white mb-1.5">{title}</h2>
              <p className="text-sm text-slate-400 leading-relaxed">{body}</p>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
