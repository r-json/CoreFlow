'use client';

import { useEffect } from 'react';

/**
 * Route-segment error boundary. Renders a recoverable fallback and reports the
 * error to the observability sink so client crashes are visible in prod.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    fetch('/api/observability/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: error.message,
        digest: error.digest,
        url: typeof window !== 'undefined' ? window.location.href : undefined,
      }),
    }).catch(() => {});
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
        <p className="text-sm text-slate-400 mb-6">
          An unexpected error occurred. The team has been notified.
        </p>
        <button
          onClick={reset}
          className="px-4 py-2 rounded-lg font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
