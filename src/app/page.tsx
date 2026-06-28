import Link from 'next/link';
import { ShieldCheck, Coins, FileCheck2, ArrowRight } from 'lucide-react';

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
          <p className="max-w-2xl mx-auto text-base md:text-lg text-slate-400 mb-8">
            CoreFlow settles work payments on-chain with multi-signature approvals and
            oracle-verified hours — stronger transparency, auditability, and predictable
            cost than traditional cross-border payouts.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl font-semibold bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white transition-colors shadow-lg shadow-violet-500/20"
            >
              Launch the app
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </Link>
            <a
              href="https://stellar.expert/explorer/public/contract/CCTF5WBOQR7JP2KPLQT372X7JCGCINHDFRSAPF4YTYRKZXZ3J2XPRFFW"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl font-semibold border border-white/10 bg-slate-900/60 hover:bg-slate-800 text-slate-200 transition-colors"
            >
              View contract
            </a>
          </div>
          <p className="mt-4 text-xs text-slate-500">
            The dashboard opens in interactive <strong>demo mode</strong> — no wallet required to explore.
          </p>
        </section>

        {/* Features */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-20" aria-label="Key features">
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
