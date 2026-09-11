'use client';

/**
 * Batch detail page.
 *
 * A thin shell: fetch, then render. Authorization is the server's — the request
 * carries the session, `withTenant` resolves membership, and a batch in another
 * organization returns the same 404 as one that does not exist. No organization id
 * is read from the URL or from storage and treated as permission.
 */

import { useCallback, useEffect, useState } from 'react';
import { BatchDetail, type BatchDetailData } from '@/components/payroll/BatchDetail';

export default function BatchDetailPage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<BatchDetailData | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/payroll/batches/${encodeURIComponent(params.id)}`);
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError({
          status: response.status,
          message: body?.error ?? 'This payroll batch could not be loaded.',
        });
        return;
      }
      setData(body as BatchDetailData);
    } catch {
      setError({ status: 0, message: 'The payroll batch could not be loaded.' });
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16">
        <h1 className="text-xl font-semibold text-slate-100">
          {/* A cross-tenant batch and a non-existent one are the same answer. */}
          {error.status === 404 ? 'Payroll batch not found' : 'Could not load this payroll'}
        </h1>
        <p className="mt-2 text-sm text-slate-400">{error.message}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-6 text-sm text-emerald-300 underline hover:text-emerald-200"
        >
          Try again
        </button>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-16">
        <p role="status" className="text-sm text-slate-400">
          Loading payroll batch…
        </p>
      </main>
    );
  }

  return (
    <main>
      <BatchDetail data={data} onChanged={() => void load()} />
    </main>
  );
}
