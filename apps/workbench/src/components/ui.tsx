import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/** Copy text to the clipboard and say so in a live region. */
export function CopyButton({
  text,
  label = 'Copy',
  className = 'btn btn-sm',
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1800);
  }
  return (
    <button
      type="button"
      className={className}
      onClick={copy}
      aria-label={`${label}${state === 'copied' ? ' (copied)' : ''}`}
    >
      <Icon name={state === 'copied' ? 'check' : 'copy'} />
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy blocked' : label}</span>
    </button>
  );
}

/** Offer a text file to save. Nothing leaves the browser. */
export function DownloadButton({
  text,
  filename,
  label = 'Download',
}: {
  text: string;
  filename: string;
  label?: string;
}) {
  function save() {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <button type="button" className="btn btn-sm" onClick={save}>
      <Icon name="download" />
      {label}
    </button>
  );
}

export function CodeBlock({
  title,
  code,
  wrap = false,
  download,
  copyLabel,
}: {
  title: string;
  code: string;
  wrap?: boolean;
  download?: string;
  copyLabel?: string;
}) {
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{title}</span>
        <span className="row">
          {download ? <DownloadButton text={code} filename={download} /> : null}
          <CopyButton text={code} label={copyLabel ?? `Copy ${title.toLowerCase()}`} />
        </span>
      </div>
      <pre className={wrap ? 'wrap' : undefined} tabIndex={0} aria-label={title}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Label, hint and error wired to one control by id. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export type BadgeKind = 'local' | 'recorded' | 'contract' | 'alpha';
const BADGE_TEXT: Record<BadgeKind, string> = {
  local: 'Runs locally · no network',
  recorded: 'Recorded Testnet evidence',
  contract: 'Contract-only check',
  alpha: '0.1.0-alpha · Testnet only · unaudited',
};
export function Badge({ kind, children }: { kind: BadgeKind; children?: ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children ?? BADGE_TEXT[kind]}</span>;
}

export function Callout({
  tone = 'info',
  title,
  children,
  role,
}: {
  tone?: 'info' | 'warn' | 'bad' | 'ok';
  title?: ReactNode;
  children?: ReactNode;
  role?: 'status' | 'alert';
}) {
  return (
    <div className={`callout callout-${tone}`} role={role}>
      {title ? <p className="callout-title">{title}</p> : null}
      {children}
    </div>
  );
}

export function Status({ kind, children }: { kind: 'pass' | 'fail' | 'warn' | 'skip'; children: ReactNode }) {
  const icon = kind === 'pass' ? 'check' : kind === 'fail' ? 'cross' : kind === 'warn' ? 'errors' : 'dash';
  return (
    <span className={`status status-${kind}`}>
      <Icon name={icon} />
      {children}
    </span>
  );
}

export function PageHeader({ title, lede, children }: { title: string; lede: ReactNode; children?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  // Move focus to the page title on navigation so screen readers announce the new page.
  useEffect(() => {
    if (document.activeElement && document.activeElement !== document.body && !document.activeElement.closest('.nav'))
      return;
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <header className="page-header">
      <h1 ref={ref} tabIndex={-1}>
        {title}
      </h1>
      <p className="lede">{lede}</p>
      {children ? <div className="header-meta">{children}</div> : null}
    </header>
  );
}
