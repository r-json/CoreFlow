import { ClaimError, comparePreimages, toHex, verifyPreimage, type PreimageFieldName } from '@coreflow/sdk';
import { useMemo, useState } from 'react';
import { ByteMap, FieldTable } from '../components/preimage';
import { Badge, Callout, Field, PageHeader, Status } from '../components/ui';
import { NETWORK_OPTIONS, passphraseFor, type NetworkChoice } from '../lib/claims';
import { VECTORS } from '../lib/data';
import { cleanHex, groupHex, nowSeconds, parseHex } from '../lib/format';
import { inspectPreimage } from '../lib/inspect';
import { useHandoff, type InspectDraft } from '../state';

type Expect = 'none' | NetworkChoice;

interface Inputs {
  preimage: string;
  signature: string;
  expectNetwork: Expect;
  customPassphrase: string;
  contractId: string;
  claimTypeName: string;
  compare: string;
  source: string;
}

function initial(draft?: InspectDraft): Inputs {
  if (draft) {
    const network = NETWORK_OPTIONS.find(
      (o) => o.value !== 'custom' && passphraseFor(o.value, '') === draft.passphrase,
    )?.value;
    return {
      preimage: draft.preimageHex,
      signature: draft.signatureHex ?? '',
      expectNetwork: draft.passphrase ? (network ?? 'custom') : 'none',
      customPassphrase: network ? '' : (draft.passphrase ?? ''),
      contractId: draft.contractId ?? '',
      claimTypeName: '',
      compare: draft.compareHex ?? '',
      source: draft.source,
    };
  }
  const v = VECTORS.valid[0]!;
  return {
    preimage: v.preimage_hex!,
    signature: v.signature_hex,
    expectNetwork: 'testnet',
    customPassphrase: '',
    contractId: v.context.contract_id,
    claimTypeName: '',
    compare: '',
    source: `test vector "${v.name}"`,
  };
}

export function Inspect() {
  const { inspectDraft } = useHandoff();
  const [inputs, setInputs] = useState<Inputs>(() => initial(inspectDraft));
  const set = <K extends keyof Inputs>(key: K, value: Inputs[K]) => setInputs((cur) => ({ ...cur, [key]: value }));

  const result = useMemo(() => {
    const parsed = parseHex(inputs.preimage, 'The preimage', 256);
    if (!parsed.ok) return { preimageError: parsed.error } as const;
    const passphrase =
      inputs.expectNetwork === 'none' ? undefined : passphraseFor(inputs.expectNetwork, inputs.customPassphrase);
    const inspection = inspectPreimage(parsed.value, {
      now: nowSeconds(),
      expectedPassphrase: passphrase,
      expectedContractId: inputs.contractId.trim() || undefined,
      claimTypeNames: inputs.claimTypeName.trim() ? [inputs.claimTypeName.trim()] : [],
    });

    let signature:
      { state: 'none' } | { state: 'error'; message: string } | { state: 'match' } | { state: 'mismatch' } = {
      state: 'none',
    };
    if (inputs.signature.trim()) {
      const sig = parseHex(inputs.signature, 'The signature', 64);
      if (!sig.ok) signature = { state: 'error', message: sig.error };
      else if (!inspection.decoded)
        signature = {
          state: 'error',
          message: 'The bytes are not a wire-version-1 preimage, so there is no issuer to check against.',
        };
      else {
        try {
          verifyPreimage(parsed.value, sig.value);
          signature = { state: 'match' };
        } catch (e) {
          signature =
            e instanceof ClaimError && e.code === 'InvalidSignature'
              ? { state: 'mismatch' }
              : { state: 'error', message: String(e) };
        }
      }
    }

    let diff: { error?: string; fields?: ReturnType<typeof comparePreimages> } | undefined;
    if (inputs.compare.trim()) {
      const other = parseHex(inputs.compare, 'The second preimage', 256);
      diff = other.ok ? { fields: comparePreimages(parsed.value, other.value) } : { error: other.error };
    }
    return { bytes: parsed.value, inspection, signature, diff } as const;
  }, [inputs]);

  const signatureError =
    'signature' in result && result.signature?.state === 'error' ? result.signature.message : undefined;
  const diffSet = new Set<PreimageFieldName>(
    'diff' in result && result.diff?.fields ? result.diff.fields.map((d) => d.name) : [],
  );

  /** Flip one bit in the subject and keep the original as the comparison: the signature must stop matching. */
  function tamper() {
    if (!('bytes' in result) || !result.bytes) return;
    const changed = result.bytes.slice();
    changed[150] = changed[150]! ^ 0x01;
    setInputs((cur) => ({
      ...cur,
      preimage: toHex(changed),
      compare: cleanHex(cur.preimage),
      source: 'a tampered copy (one bit flipped in subject)',
    }));
  }

  return (
    <div className="page">
      <PageHeader
        title="Inspect & diff"
        lede="Read a 256-byte preimage field by field, check a signature against exactly those bytes, and compare two preimages to see where a signer and a verifier disagree."
      >
        <Badge kind="local" />
        <span className="muted small">Loaded from {inputs.source}</span>
      </PageHeader>

      <form className="split split-even" onSubmit={(e) => e.preventDefault()} aria-label="Preimage to inspect">
        <div className="stack">
          <section className="card">
            <Field
              label="Preimage (hex)"
              hint="512 hex digits. Spaces, line breaks and a 0x prefix are ignored, so you can paste output from a test log."
              error={'preimageError' in result ? result.preimageError : undefined}
            >
              {({ id, describedBy, invalid }) => (
                <textarea
                  id={id}
                  rows={7}
                  spellCheck={false}
                  value={inputs.preimage}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  onChange={(e) => set('preimage', e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Signature (optional)"
              hint="Checked against these exact bytes and the issuer inside them."
              error={signatureError}
            >
              {({ id, describedBy, invalid }) => (
                <textarea
                  id={id}
                  rows={2}
                  spellCheck={false}
                  value={inputs.signature}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  onChange={(e) => set('signature', e.target.value)}
                />
              )}
            </Field>
            <div className="row">
              <button type="button" className="btn" onClick={tamper} disabled={!('bytes' in result)}>
                Flip one bit in the subject
              </button>
              <span className="hint">Shows what a single changed byte does to the signature and the diff.</span>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <fieldset>
              <legend>Compare with what you expect (optional)</legend>
              <div className="fields-2">
                <Field label="Expected network">
                  {({ id }) => (
                    <select
                      id={id}
                      value={inputs.expectNetwork}
                      onChange={(e) => set('expectNetwork', e.target.value as Expect)}
                    >
                      <option value="none">Don't compare</option>
                      {NETWORK_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {inputs.expectNetwork === 'custom' ? (
                  <Field label="Network passphrase">
                    {({ id }) => (
                      <input
                        id={id}
                        type="text"
                        value={inputs.customPassphrase}
                        onChange={(e) => set('customPassphrase', e.target.value)}
                      />
                    )}
                  </Field>
                ) : null}
              </div>
              <Field label="Expected contract ID">
                {({ id }) => (
                  <input
                    id={id}
                    type="text"
                    className="mono"
                    spellCheck={false}
                    autoComplete="off"
                    value={inputs.contractId}
                    onChange={(e) => set('contractId', e.target.value)}
                  />
                )}
              </Field>
              <Field
                label="Claim type name to recognise"
                hint="Hashes are one-way: enter a name to test whether it is the claim type."
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    type="text"
                    className="mono"
                    spellCheck={false}
                    aria-describedby={describedBy}
                    value={inputs.claimTypeName}
                    onChange={(e) => set('claimTypeName', e.target.value)}
                  />
                )}
              </Field>
            </fieldset>
          </section>

          <section className="card">
            <Field
              label="Second preimage to compare (optional)"
              hint="For example, the bytes your contract test printed next to the bytes your signer produced."
              error={'diff' in result ? result.diff?.error : undefined}
            >
              {({ id, describedBy, invalid }) => (
                <textarea
                  id={id}
                  rows={5}
                  spellCheck={false}
                  value={inputs.compare}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  onChange={(e) => set('compare', e.target.value)}
                />
              )}
            </Field>
          </section>
        </div>
      </form>

      <div className="stack">
        {'inspection' in result && result.inspection ? (
          <>
            <div aria-live="polite" className="stack" style={{ gap: 12 }}>
              {result.signature.state === 'match' ? (
                <Callout tone="ok" title="The signature matches these bytes">
                  <p className="small">
                    It is the embedded issuer's Ed25519 signature over exactly these 256 bytes. This says nothing about
                    expiry or replay; use Verify for those.
                  </p>
                </Callout>
              ) : result.signature.state === 'mismatch' ? (
                <Callout tone="bad" title="The signature does not match these bytes">
                  <p className="small">
                    At least one byte differs from what the issuer signed, or another key signed it. A contract would
                    abort the transaction.
                  </p>
                </Callout>
              ) : null}
              {result.diff?.fields ? (
                result.diff.fields.length === 0 ? (
                  <Callout tone="ok" title="The two preimages are byte-identical" />
                ) : (
                  <Callout
                    tone="warn"
                    title={`${result.diff.fields.length} field${result.diff.fields.length > 1 ? 's' : ''} differ`}
                  >
                    <ul>
                      {result.diff.fields.map((d) => (
                        <li key={d.name}>
                          <code>{d.name}</code> (bytes {d.offset}–{d.offset + d.size - 1})
                        </li>
                      ))}
                    </ul>
                  </Callout>
                )
              ) : null}
              {result.inspection.warnings.length ? (
                <Callout tone="warn" title="Warnings">
                  <ul>
                    {result.inspection.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </Callout>
              ) : (
                <Callout tone="ok" title="No problems found in the structure" />
              )}
            </div>

            <section className="card" aria-labelledby="fields-title">
              <div className="card-title">
                <h2 id="fields-title">Fields</h2>
                {result.inspection.decoded ? (
                  <Status kind="pass">Wire version 1</Status>
                ) : (
                  <Status kind="fail">Not a v1 preimage</Status>
                )}
              </div>
              <ByteMap diff={diffSet} />
              <FieldTable
                rows={result.inspection.rows}
                diff={diffSet}
                caption="Preimage fields with offsets, hex values and meanings"
              />
            </section>

            {result.diff?.fields?.length ? (
              <section className="card" aria-labelledby="diff-title">
                <h2 id="diff-title">Differences</h2>
                <div className="table-wrap">
                  <table>
                    <caption className="visually-hidden">Fields that differ between the two preimages</caption>
                    <thead>
                      <tr>
                        <th scope="col">Field</th>
                        <th scope="col">This preimage</th>
                        <th scope="col">Second preimage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.diff.fields.map((d) => (
                        <tr key={d.name}>
                          <th scope="row">
                            <code>{d.name}</code>
                          </th>
                          <td className="hex-cell">
                            <span className="hex">{groupHex(toHex(d.a))}</span>
                          </td>
                          <td className="hex-cell">
                            <span className="hex">{groupHex(toHex(d.b))}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </>
        ) : (
          <Callout tone="info" title="Paste a preimage to inspect it">
            <p className="small">Compose & sign, Verify and the test vectors can all open their bytes here.</p>
          </Callout>
        )}
      </div>
    </div>
  );
}
