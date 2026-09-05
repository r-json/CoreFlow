'use client';

/**
 * Bulk Pay — CSV payroll upload with role-based dual signing.
 *
 * APPROVAL STATE IS READ FROM CHAIN, NOT HELD IN REACT STATE.
 *
 * `manager_approve` and `finance_approve` are two separate on-chain
 * transactions, each gated by its own `require_auth()`. `pay_batch` then reads
 * the two stored flags. Tracking "signed" in component state would render a
 * green badge without any on-chain approval, and settlement would fail with
 * Error(Contract, #5). Every badge below reflects `get_escrow`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, CheckCircle2, Clock, ExternalLink, FileUp,
  Loader2, ShieldCheck, Upload, Wallet,
} from 'lucide-react';
import { CoreFlowClient } from '@/lib/contracts';
import { STELLAR_CONFIG } from '@/lib/config';

type Role = 'manager' | 'finance';

interface Payee {
  address: string;
  amount: string;
  token: string;
}

interface ChainState {
  manager: string;
  financeApprover: string;
  managerApproved: boolean;
  financeApproved: boolean;
  cancelled: boolean;
  paymentCount: number;
  allProofsVerified: boolean;
}

const ESCROW_ID = 1;
const EXPERT = 'https://stellar.expert/explorer/testnet/tx';
const G_ADDRESS = /^G[A-Z2-7]{55}$/;

/** Minimal RFC4180-ish parser — handles quoted fields without a dependency. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const BATCH_HISTORY = [
  { id: 'BATCH-0007', date: '2026-09-05', payees: 2, amount: '60.00', asset: 'XLM',  status: 'Settled' },
  { id: 'BATCH-0006', date: '2026-09-05', payees: 2, amount: '50.00', asset: 'USDC', status: 'Settled' },
  { id: 'BATCH-0005', date: '2026-09-04', payees: 2, amount: '40.00', asset: 'XLM',  status: 'Settled' },
  { id: 'BATCH-0004', date: '2026-09-04', payees: 3, amount: '75.00', asset: 'USDC', status: 'Settled' },
  { id: 'BATCH-0003', date: '2026-09-03', payees: 2, amount: '30.00', asset: 'XLM',  status: 'Cancelled' },
];

export default function BulkPayPage() {
  const [role, setRole] = useState<Role>('manager');
  const [wallet, setWallet] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainState | null>(null);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const client = useMemo(() => new CoreFlowClient(), []);

  const refresh = useCallback(async () => {
    try {
      const e = await client.getEscrow(ESCROW_ID);
      setChain({
        manager: e.manager,
        financeApprover: e.finance_approver,
        managerApproved: e.manager_approved,
        financeApproved: e.finance_approved,
        cancelled: e.cancelled,
        paymentCount: e.payments?.length ?? 0,
        allProofsVerified:
          (e.payments?.length ?? 0) > 0 && e.payments.every((p) => p.proof_verified),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read escrow state');
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  const connect = async () => {
    setError(null);
    try {
      setWallet(await STELLAR_CONFIG.freighter.connect());
    } catch {
      setError('Could not connect Freighter. Is the extension unlocked and set to Testnet?');
    }
  };

  const onFile = (file: File) => {
    setCsvErrors([]); setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseCsv(String(reader.result));
      if (!rows.length) { setCsvErrors(['File is empty']); return; }

      const header = rows[0].map((h) => h.trim().toLowerCase());
      const iAddr = header.indexOf('address');
      const iAmt = header.indexOf('amount');
      const iTok = header.indexOf('token');
      if (iAddr < 0 || iAmt < 0 || iTok < 0) {
        setCsvErrors(['Header must contain: address, amount, token']);
        return;
      }

      const parsed: Payee[] = [];
      const errs: string[] = [];
      rows.slice(1).forEach((r, i) => {
        const address = (r[iAddr] || '').trim();
        const amount = (r[iAmt] || '').trim();
        const token = (r[iTok] || '').trim().toUpperCase();
        if (!G_ADDRESS.test(address)) { errs.push(`Row ${i + 2}: invalid address`); return; }
        if (!(Number(amount) > 0)) { errs.push(`Row ${i + 2}: amount must be > 0`); return; }
        if (token !== 'XLM' && token !== 'USDC') { errs.push(`Row ${i + 2}: token must be XLM or USDC`); return; }
        parsed.push({ address, amount, token });
      });
      setPayees(parsed);
      setCsvErrors(errs);
    };
    reader.readAsText(file);
  };

  const run = async (label: string, fn: () => Promise<{ transactionHash: string }>) => {
    setBusy(label); setError(null); setTxHash(null);
    try {
      const res = await fn();
      setTxHash(res.transactionHash);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const attest = () =>
    run('attest', async () => {
      const res = await fetch('/api/submit-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escrow_id: ESCROW_ID, payees }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Oracle attestation failed');

      let last = { transactionHash: '' };
      for (const s of data.signatures) {
        last = await client.submitHoursProof(
          ESCROW_ID, s.paymentId, s.hours, s.nonce, s.signature
        );
      }
      return last;
    });

  const approve = () =>
    run('approve', () =>
      role === 'manager'
        ? client.submitManagerApprove(ESCROW_ID)
        : client.submitFinanceApprove(ESCROW_ID)
    );

  const settle = () => run('settle', () => client.submitPayBatch(ESCROW_ID));

  const bothSigned = !!chain?.managerApproved && !!chain?.financeApproved;
  const expectedSigner = role === 'manager' ? chain?.manager : chain?.financeApprover;
  const walletMatches = !!wallet && !!expectedSigner && wallet === expectedSigner;
  const alreadySigned = role === 'manager' ? chain?.managerApproved : chain?.financeApproved;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-900">Bulk Pay</h1>
            <p className="text-sm text-slate-500">
              Escrow #{ESCROW_ID} · Testnet ·{' '}
              <span className="font-mono text-xs">{STELLAR_CONFIG.contract.id.slice(0, 10)}…</span>
            </p>
          </div>
          <button
            onClick={connect}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            <Wallet className="h-4 w-4" />
            {wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : 'Connect Freighter'}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        {/* Role selector */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Your role
          </h2>
          <div className="inline-flex rounded-lg bg-slate-100 p-1">
            {(['manager', 'finance'] as Role[]).map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={`rounded-md px-5 py-2 text-sm font-medium transition ${
                  role === r ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
                style={role === r ? { color: '#0066FF' } : undefined}
              >
                {r === 'manager' ? 'I am the Manager' : 'I am the Finance Lead'}
              </button>
            ))}
          </div>

          {wallet && expectedSigner && !walletMatches && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Connected wallet is not the {role} on this escrow. Switch accounts in Freighter to{' '}
                <span className="font-mono text-xs">{expectedSigner.slice(0, 8)}…{expectedSigner.slice(-6)}</span>.
              </span>
            </div>
          )}
        </section>

        {/* Approval status — sourced from chain */}
        <section className="grid gap-4 md:grid-cols-2">
          {([
            ['Manager', chain?.managerApproved, chain?.manager],
            ['Finance Lead', chain?.financeApproved, chain?.financeApprover],
          ] as const).map(([label, signed, addr]) => (
            <div key={label} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-900">{label}</p>
                  <p className="mt-1 font-mono text-xs text-slate-500">
                    {addr ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : 'loading…'}
                  </p>
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                    signed ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                  }`}
                >
                  {signed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
                  {signed ? 'Signed' : 'Not signed'}
                </span>
              </div>
            </div>
          ))}
        </section>

        {/* CSV upload */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Payroll CSV
          </h2>
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
            className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center transition hover:border-slate-400"
          >
            <FileUp className="mb-2 h-8 w-8 text-slate-400" />
            <p className="text-sm font-medium text-slate-700">Drop a CSV or click to browse</p>
            <p className="mt-1 text-xs text-slate-500">Columns: address, amount, token (XLM or USDC)</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
          />

          {csvErrors.length > 0 && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="mb-1 text-sm font-medium text-red-800">
                {csvErrors.length} row{csvErrors.length > 1 ? 's' : ''} rejected
              </p>
              <ul className="list-inside list-disc text-xs text-red-700">
                {csvErrors.slice(0, 5).map((e) => <li key={e}>{e}</li>)}
              </ul>
            </div>
          )}
        </section>

        {/* Payee preview */}
        {payees.length > 0 && (
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Payees ({payees.length})
              </h2>
              <div className="flex gap-4 text-xs text-slate-600">
                {['XLM', 'USDC'].map((t) => {
                  const sum = payees.filter((p) => p.token === t)
                    .reduce((a, p) => a + Number(p.amount), 0);
                  return sum > 0 ? <span key={t}><strong>{sum.toFixed(2)}</strong> {t}</span> : null;
                })}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-6 py-3 font-medium">#</th>
                    <th className="px-6 py-3 font-medium">Address</th>
                    <th className="px-6 py-3 text-right font-medium">Amount</th>
                    <th className="px-6 py-3 font-medium">Asset</th>
                  </tr>
                </thead>
                <tbody>
                  {payees.map((p, i) => (
                    <tr key={p.address + i} className={i % 2 ? 'bg-slate-50' : 'bg-white'}>
                      <td className="px-6 py-3 text-slate-400">{i + 1}</td>
                      <td className="px-6 py-3 font-mono text-xs text-slate-700">
                        {p.address.slice(0, 12)}…{p.address.slice(-8)}
                      </td>
                      <td className="px-6 py-3 text-right font-medium text-slate-900">{p.amount}</td>
                      <td className="px-6 py-3">
                        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                          {p.token}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Actions */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Settlement
          </h2>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={attest}
              disabled={!!busy || payees.length === 0 || !wallet}
              className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-40"
              style={{ backgroundColor: '#0066FF' }}
            >
              {busy === 'attest' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              1 · Attest hours (oracle)
            </button>

            <button
              onClick={approve}
              disabled={!!busy || !wallet || !walletMatches || alreadySigned}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              2 · Approve as {role === 'manager' ? 'Manager' : 'Finance'}
            </button>

            <button
              onClick={settle}
              disabled={!!busy || !bothSigned || !wallet}
              className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-40"
              style={{ backgroundColor: bothSigned ? '#0066FF' : '#94a3b8' }}
            >
              {busy === 'settle' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              3 · Submit pay_batch
            </button>
          </div>

          {!bothSigned && (
            <p className="mt-3 text-xs text-slate-500">
              Settlement unlocks once both signers have approved on-chain.
            </p>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}

          {txHash && (
            <div className="mt-4 flex items-center justify-between rounded-lg border border-green-200 bg-green-50 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-green-800">Transaction confirmed</p>
                <p className="truncate font-mono text-xs text-green-700">{txHash}</p>
              </div>
              <a
                href={`${EXPERT}/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-4 inline-flex shrink-0 items-center gap-1 text-sm font-medium text-green-800 underline"
              >
                Stellar Expert <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          )}
        </section>

        {/* Batch history */}
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-6 py-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Batch history
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">Illustrative data — not read from chain</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-6 py-3 font-medium">Batch</th>
                  <th className="px-6 py-3 font-medium">Date</th>
                  <th className="px-6 py-3 text-right font-medium">Payees</th>
                  <th className="px-6 py-3 text-right font-medium">Amount</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {BATCH_HISTORY.map((b, i) => (
                  <tr key={b.id} className={i % 2 ? 'bg-slate-50' : 'bg-white'}>
                    <td className="px-6 py-3 font-mono text-xs text-slate-700">{b.id}</td>
                    <td className="px-6 py-3 text-slate-600">{b.date}</td>
                    <td className="px-6 py-3 text-right text-slate-600">{b.payees}</td>
                    <td className="px-6 py-3 text-right font-medium text-slate-900">
                      {b.amount} <span className="text-xs text-slate-500">{b.asset}</span>
                    </td>
                    <td className="px-6 py-3">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        b.status === 'Settled' ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'
                      }`}>
                        {b.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
