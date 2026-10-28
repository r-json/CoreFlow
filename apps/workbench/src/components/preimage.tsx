import { PREIMAGE_LAYOUT, type PreimageFieldName } from '@coreflow/sdk';
import { groupHex } from '../lib/format';
import type { FieldRow } from '../lib/inspect';
import type { VerificationStep } from '../lib/verification';
import { Status } from './ui';

type Group = 'header' | 'binding' | 'identity' | 'flags' | 'replay' | 'time';

const GROUP_OF: Record<PreimageFieldName, Group> = {
  magic: 'header',
  version: 'header',
  network_id: 'binding',
  contract: 'binding',
  issuer: 'identity',
  claim_type: 'identity',
  subject: 'identity',
  payload_hash: 'identity',
  payload_encoding: 'flags',
  replay_mode: 'flags',
  nonce: 'replay',
  claim_id: 'replay',
  issued_at: 'time',
  expires_at: 'time',
};

const GROUP_LABEL: Record<Group, string> = {
  header: 'Header',
  binding: 'Network and contract binding',
  identity: 'Issuer and claim',
  flags: 'Encoding and replay mode',
  replay: 'Replay value',
  time: 'Validity window',
};

const FIELD_FOR_BYTE: PreimageFieldName[] = [];
for (const f of PREIMAGE_LAYOUT) for (let i = 0; i < f.size; i++) FIELD_FOR_BYTE[f.offset + i] = f.name;

/**
 * The 256 bytes as a grid coloured by field group. Purely visual: the field
 * table next to it carries the same information as text.
 */
export function ByteMap({ diff }: { diff?: ReadonlySet<PreimageFieldName> }) {
  return (
    <figure className="stack" style={{ margin: 0, gap: 8 }}>
      <div className="bytemap" aria-hidden="true">
        {FIELD_FOR_BYTE.map((name, i) => (
          <span
            key={i}
            className={`g-${GROUP_OF[name]}${diff?.has(name) ? ' diff' : ''}`}
            title={`byte ${i}: ${name}`}
          />
        ))}
      </div>
      <figcaption className="legend">
        <span className="visually-hidden">Byte layout of the 256-byte preimage, coloured by field group:</span>
        {(Object.keys(GROUP_LABEL) as Group[]).map((g) => (
          <span key={g}>
            <i className={`field-swatch g-${g}`} aria-hidden="true" />
            {GROUP_LABEL[g]}
          </span>
        ))}
        {diff?.size ? (
          <span>
            <i
              className="field-swatch"
              style={{ outline: '2px solid var(--bad)', outlineOffset: -2 }}
              aria-hidden="true"
            />
            Differs
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/** Every field with its offset, raw hex and plain-language meaning. */
export function FieldTable({
  rows,
  diff,
  caption,
}: {
  rows: FieldRow[];
  diff?: ReadonlySet<PreimageFieldName>;
  caption: string;
}) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Bytes</th>
            <th scope="col">Hex</th>
            <th scope="col">Meaning</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const differs = diff?.has(r.name);
            return (
              <tr key={r.name} className={differs ? 'row-diff' : r.tone === 'warn' ? 'row-warn' : undefined}>
                <th scope="row" className="field-name">
                  <i className={`field-swatch g-${GROUP_OF[r.name]}`} aria-hidden="true" />
                  <code>{r.name}</code>
                  {differs ? <span className="visually-hidden"> (differs)</span> : null}
                </th>
                <td className="mono small" style={{ whiteSpace: 'nowrap' }}>
                  {r.offset}–{r.offset + r.size - 1}
                </td>
                <td className="hex-cell">
                  <span className="hex">{groupHex(r.hex)}</span>
                </td>
                <td>
                  {r.tone === 'warn' ? (
                    <Status kind="warn">{r.meaning || 'Check this field'}</Status>
                  ) : r.tone === 'ok' ? (
                    <Status kind="pass">{r.meaning}</Status>
                  ) : (
                    r.meaning
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_TEXT: Record<VerificationStep['status'], [kind: 'pass' | 'fail' | 'skip', text: string]> = {
  pass: ['pass', 'Passed'],
  fail: ['fail', 'Failed'],
  'not-reached': ['skip', 'Not reached'],
  'contract-only': ['skip', 'Contract only'],
};

export function StepList({ steps }: { steps: VerificationStep[] }) {
  return (
    <ol className="steps" aria-label="Verification order from the claim format specification">
      {steps.map((s) => {
        const [kind, text] = STATUS_TEXT[s.status];
        return (
          <li key={s.id} className="step" data-status={s.status}>
            <span className="step-n" aria-hidden="true">
              {s.n}
            </span>
            <span className="step-title">
              <span className="visually-hidden">Step {s.n}: </span>
              {s.title}
            </span>
            <Status kind={kind}>{text}</Status>
            <span className="step-rule">
              {s.rule}
              {s.note ? ` ${s.note}` : ''}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
