'use client';

import { useEffect } from 'react';

/**
 * Root error boundary — catches errors thrown in the root layout itself.
 * Must render its own <html>/<body>.
 */
export default function GlobalError({
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
    <html lang="en">
      <body style={{ background: '#020617', color: '#f1f5f9', fontFamily: 'sans-serif' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Application error</h1>
            <p style={{ fontSize: 14, color: '#94a3b8', marginBottom: 24 }}>
              A critical error occurred. Please reload the page.
            </p>
            <button
              onClick={reset}
              style={{ padding: '8px 16px', borderRadius: 8, background: '#7c3aed', color: '#fff', border: 'none', cursor: 'pointer' }}
            >
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
