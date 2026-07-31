import { Code2, ExternalLink } from 'lucide-react';
import Link from 'next/link';

export const metadata = {
  title: 'API Documentation — CoreFlow OpenAPI 3.0',
};

export default function ApiDocsPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12">
      <div className="max-w-5xl mx-auto space-y-8">
        {/* Header */}
        <div className="border-b border-violet-500/20 pb-6 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase bg-violet-500/10 border border-violet-500/20 text-violet-400">
                OpenAPI 3.0 Specification
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                v1.0 Launch Ready
              </span>
            </div>
            <h1 className="text-3xl font-extrabold text-white tracking-tight">CoreFlow API Documentation</h1>
            <p className="text-xs text-slate-400 mt-1">
              Production-grade RESTful API reference for multi-sig payroll escrows, Ed25519 auth, and Soroban integration.
            </p>
          </div>
          <Link
            href="/dashboard"
            className="px-4 py-2 rounded-xl text-xs font-bold bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 transition-colors"
          >
            ← Dashboard
          </Link>
        </div>

        {/* JSON Spec Download Banner */}
        <div className="p-4 rounded-2xl border border-violet-500/20 bg-violet-950/20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Code2 className="w-5 h-5 text-violet-400" />
            <div>
              <p className="text-xs font-bold text-white">Raw OpenAPI JSON Endpoint</p>
              <p className="text-[10px] text-slate-400">Import directly into Postman, Insomnia, or Swagger UI</p>
            </div>
          </div>
          <a
            href="/api/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold flex items-center gap-1.5 transition-colors shadow-md shadow-violet-500/20"
          >
            View OpenAPI JSON
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        {/* Core Endpoints List */}
        <div className="space-y-4">
          <h2 className="text-sm font-extrabold uppercase tracking-wider text-slate-400">Core Endpoints Overview</h2>

          {/* Endpoint 1 */}
          <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 space-y-2">
            <div className="flex items-center gap-3">
              <span className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                POST
              </span>
              <code className="text-xs font-mono font-bold text-white">/api/auth/challenge</code>
            </div>
            <p className="text-xs text-slate-400">
              Generates a 5-minute single-use Ed25519 signing challenge for Freighter wallet verification (SEP-53).
            </p>
          </div>

          {/* Endpoint 2 */}
          <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 space-y-2">
            <div className="flex items-center gap-3">
              <span className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                POST
              </span>
              <code className="text-xs font-mono font-bold text-white">/api/auth/verify</code>
            </div>
            <p className="text-xs text-slate-400">
              Verifies Freighter SEP-53 challenge signature, upserts user record, and sets secure HttpOnly cookie.
            </p>
          </div>

          {/* Endpoint 3 */}
          <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 space-y-2">
            <div className="flex items-center gap-3">
              <span className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-sky-500/20 text-sky-400 border border-sky-500/30">
                GET
              </span>
              <code className="text-xs font-mono font-bold text-white">/api/escrows</code>
              <span className="text-[10px] font-mono text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                Cursor Paginated
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Fetches paginated escrow records using <code className="text-violet-400">?limit=10&amp;cursor=ID</code>. EMPLOYEES see only their own escrows; ADMINS see all.
            </p>
          </div>

          {/* Endpoint 4 */}
          <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 space-y-2">
            <div className="flex items-center gap-3">
              <span className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-purple-500/20 text-purple-400 border border-purple-500/30">
                POST
              </span>
              <code className="text-xs font-mono font-bold text-white">/api/admin/invitations</code>
              <span className="text-[10px] font-mono text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
                Admin Only
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Creates a time-limited invitation token for employee onboarding and records an <code className="text-violet-400">AuditLog</code>.
            </p>
          </div>

          {/* Endpoint 5 */}
          <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 space-y-2">
            <div className="flex items-center gap-3">
              <span className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">
                POST
              </span>
              <code className="text-xs font-mono font-bold text-white">/api/admin/contract/pause</code>
              <span className="text-[10px] font-mono text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
                Circuit Breaker
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Toggles the Soroban smart contract emergency stop circuit breaker.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
