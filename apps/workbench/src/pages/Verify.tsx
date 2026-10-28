import { ClaimError, claimFromJSON, contractDigest, type Claim } from '@coreflow/sdk';
import { useState, type FormEvent } from 'react';
import { StepList } from '../components/preimage';
import { Icon } from '../components/Icon';
import { Badge, Callout, Field, PageHeader } from '../components/ui';
import {
  NETWORK_OPTIONS,
  choiceFor,
  passphraseFor,
  prettyJSON,
  vectorClaimJSON,
  type NetworkChoice,
} from '../lib/claims';
import { VECTORS, type Vector } from '../lib/data';
import { nowSeconds, parseHex, parseU64, unixToIso } from '../lib/format';
import { runVerification, type VerificationReport } from '../lib/verification';
import { useHandoff, type VerifyDraft } from '../state';

type TimeMode = 'now' | 'issued' | 'custom';

interface Inputs {
  claimText: string;
  signatureHex: string;
  network: NetworkChoice;
  customPassphrase: string;
  contractId: string;
  timeMode: TimeMode;
  customTime: string;
  source: string;
}

const ALL_VECTORS: Vector[] = [...VECTORS.valid, ...VECTORS.invalid];

function fromVector(v: Vector): Inputs {
  const passphrase = v.context.network_passphrase;
  return {
    claimText: prettyJSON(vectorClaimJSON(v.claim)),
    signatureHex: v.signature_hex,
    network: choiceFor(passphrase),
    customPassphrase: choiceFor(passphrase) === 'custom' ? passphrase : '',
    contractId: v.context.contract_id,
    timeMode: 'custom',
    customTime: v.now,
    source: `test vector "${v.name}"`,
  };
}

function fromDraft(d: VerifyDraft): Inputs {
  const choice = choiceFor(d.passphrase);
  return {
    claimText: d.claimJSON,
    signatureHex: d.signatureHex,
    network: choice,
    customPassphrase: choice === 'custom' ? d.passphrase : '',
    contractId: d.contractId,
    timeMode: d.at ? 'custom' : 'now',
    customTime: d.at ?? '',
    source: d.source,
  };
}

interface Outcome {
  fieldErrors: Partial<Record<'claimText' | 'signatureHex' | 'contractId' | 'customPassphrase' | 'customTime', string>>;
  report?: VerificationReport;
  claim?: Claim;
  passphrase: string;
}

function evaluate(i: Inputs): Outcome {
  const fieldErrors: Outcome['fieldErrors'] = {};
  const passphrase = passphraseFor(i.network, i.customPassphrase);
  if (i.network === 'custom' && passphrase.trim() === '')
    fieldErrors.customPassphrase = 'Enter the network passphrase.';

  let claim: Claim | undefined;
  try {
    claim = claimFromJSON(i.claimText);
  } catch (e) {
    fieldErrors.claimText = e instanceof ClaimError ? e.message : String(e);
  }
  const sig = parseHex(i.signatureHex, 'The signature', 64);
  if (!sig.ok) fieldErrors.signatureHex = sig.error;
  try {
    contractDigest(i.contractId.trim());
  } catch {
    fieldErrors.contractId = 'Enter a valid contract address: 56 characters starting with C.';
  }

  let now = nowSeconds();
  if (i.timeMode === 'custom') {
    const t = parseU64(i.customTime, 'The time');
    if (t.ok) now = t.value;
    else fieldErrors.customTime = t.error;
  } else if (i.timeMode === 'issued' && claim) now = claim.issuedAt;

  if (Object.keys(fieldErrors).length || !claim || !sig.ok) return { fieldErrors, passphrase };
  return {
    fieldErrors,
    claim,
    passphrase,
    report: runVerification(claim, { networkPassphrase: passphrase, contractId: i.contractId.trim() }, sig.value, now),
  };
}

export function Verify() {
  const { verifyDraft, openInInspect } = useHandoff();
  const [inputs, setInputs] = useState<Inputs>(() =>
    verifyDraft
      ? fromDraft(verifyDraft)
      : fromVector(VECTORS.valid.find((v) => v.name === 'unique-id') ?? VECTORS.valid[0]!),
  );
  const [outcome, setOutcome] = useState<Outcome>(() => evaluate(inputs));
  const [stale, setStale] = useState(false);
  const [example, setExample] = useState('');
  const set = <K extends keyof Inputs>(key: K, value: Inputs[K]) => {
    setInputs((cur) => ({ ...cur, [key]: value }));
    setStale(true);
  };

  function run(e?: FormEvent) {
    e?.preventDefault();
    setOutcome(evaluate(inputs));
    setStale(false);
  }

  function load(name: string) {
    const v = ALL_VECTORS.find((x) => x.name === name);
    if (!v) return;
    const next = fromVector(v);
    setInputs(next);
    setOutcome(evaluate(next));
    setStale(false);
  }

  const { report, fieldErrors } = outcome;
  const failedStep = report?.steps.find((s) => s.status === 'fail');

  return (
    <div className="page">
      <PageHeader
        title="Verify"
        lede="Run every check that can run off-chain, in the contract's order, and see where a claim fails and what to do about it."
      >
        <Badge kind="local" />
        <span className="muted small">Loaded from {inputs.source}</span>
      </PageHeader>

      <div className="split">
        <form className="stack" onSubmit={run} aria-label="Claim to verify" noValidate>
          <section className="card">
            <Field label="Load an example" hint="Each test vector comes with the time it should be checked at.">
              {({ id, describedBy }) => (
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <select
                    id={id}
                    aria-describedby={describedBy}
                    value={example}
                    onChange={(e) => setExample(e.target.value)}
                  >
                    <option value="">Choose a test vector…</option>
                    <optgroup label="Valid">
                      {VECTORS.valid.map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Invalid">
                      {VECTORS.invalid.map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name} (expects {v.expected_error})
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <button type="button" className="btn" disabled={!example} onClick={() => load(example)}>
                    Load
                  </button>
                </div>
              )}
            </Field>
            <Field
              label="Claim JSON"
              hint="The on-chain Claim struct's field names. u64 values as strings or numbers."
              error={fieldErrors.claimText}
            >
              {({ id, describedBy, invalid }) => (
                <textarea
                  id={id}
                  rows={13}
                  spellCheck={false}
                  value={inputs.claimText}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  onChange={(e) => set('claimText', e.target.value)}
                />
              )}
            </Field>
            <Field label="Signature" hint="64 bytes as 128 hex digits." error={fieldErrors.signatureHex}>
              {({ id, describedBy, invalid }) => (
                <textarea
                  id={id}
                  rows={3}
                  spellCheck={false}
                  value={inputs.signatureHex}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  onChange={(e) => set('signatureHex', e.target.value)}
                />
              )}
            </Field>
          </section>
          <section className="card">
            <fieldset>
              <legend>Verifier context</legend>
              <div className="fields-2">
                <Field label="Network">
                  {({ id }) => (
                    <select
                      id={id}
                      value={inputs.network}
                      onChange={(e) => set('network', e.target.value as NetworkChoice)}
                    >
                      {NETWORK_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {inputs.network === 'custom' ? (
                  <Field label="Network passphrase" error={fieldErrors.customPassphrase}>
                    {({ id, describedBy, invalid }) => (
                      <input
                        id={id}
                        type="text"
                        value={inputs.customPassphrase}
                        aria-invalid={invalid}
                        aria-describedby={describedBy}
                        onChange={(e) => set('customPassphrase', e.target.value)}
                      />
                    )}
                  </Field>
                ) : null}
              </div>
              <Field label="Verifying contract ID" error={fieldErrors.contractId}>
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    type="text"
                    className="mono"
                    spellCheck={false}
                    autoComplete="off"
                    value={inputs.contractId}
                    aria-invalid={invalid}
                    aria-describedby={describedBy}
                    onChange={(e) => set('contractId', e.target.value)}
                  />
                )}
              </Field>
              <Field label="Check at" hint="The contract uses the ledger's close time.">
                {({ id }) => (
                  <select id={id} value={inputs.timeMode} onChange={(e) => set('timeMode', e.target.value as TimeMode)}>
                    <option value="now">The current time</option>
                    <option value="issued">The claim's issued_at</option>
                    <option value="custom">A Unix time I enter</option>
                  </select>
                )}
              </Field>
              {inputs.timeMode === 'custom' ? (
                <Field
                  label="Unix time (seconds)"
                  hint={/^\d+$/.test(inputs.customTime) ? unixToIso(BigInt(inputs.customTime)) : undefined}
                  error={fieldErrors.customTime}
                >
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      type="text"
                      inputMode="numeric"
                      className="mono"
                      value={inputs.customTime}
                      aria-invalid={invalid}
                      aria-describedby={describedBy}
                      onChange={(e) => set('customTime', e.target.value)}
                    />
                  )}
                </Field>
              ) : null}
            </fieldset>
            <div className="row">
              <button type="submit" className="btn btn-primary">
                <Icon name="verify" />
                Verify
              </button>
              {stale ? <span className="small muted">Inputs changed. Verify again to update the result.</span> : null}
            </div>
          </section>
        </form>

        <section className="stack" aria-labelledby="verdict-title">
          <h2 id="verdict-title" className="visually-hidden">
            Result
          </h2>
          <div aria-live="polite">
            {Object.keys(fieldErrors).length ? (
              <Callout tone="warn" title="Fix the input before it can be verified">
                <ul>
                  {Object.values(fieldErrors).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </Callout>
            ) : report?.ok ? (
              <Callout tone="ok" title="Passes every check that can run off-chain">
                <p className="small">
                  The contract can still refuse it with 1101 IssuerNotRegistered, 1105 NonceMismatch or 1106
                  ClaimAlreadyUsed: that state lives on-chain.
                </p>
              </Callout>
            ) : report?.failure ? (
              <Callout tone="bad" title={`Fails at step ${failedStep?.n ?? '?'}: ${report.failure.code}`}>
                <p className="small">
                  {report.failure.onChainCode
                    ? `On-chain this is error ${report.failure.onChainCode}.`
                    : 'On-chain there is no error number: the host aborts the whole transaction.'}{' '}
                  {report.failure.message}.
                </p>
                <p className="small">
                  <strong>Next step:</strong> {report.failure.nextStep}
                </p>
              </Callout>
            ) : report?.inputError ? (
              <Callout tone="warn" title={`Input problem: ${report.inputError.code}`}>
                <p className="small">{report.inputError.message}</p>
              </Callout>
            ) : null}
          </div>
          {report ? (
            <section className="card">
              <div className="card-title">
                <h3>Verification order</h3>
                <span className="small muted">
                  Checked at {report.now.toString()} {unixToIso(report.now) ? `(${unixToIso(report.now)})` : ''}
                </span>
              </div>
              <StepList steps={report.steps} />
              {report.preimageHex ? (
                <div className="row">
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      openInInspect({
                        preimageHex: report.preimageHex!,
                        signatureHex: inputs.signatureHex,
                        passphrase: outcome.passphrase,
                        contractId: inputs.contractId.trim(),
                        source: 'Verify',
                      })
                    }
                  >
                    <Icon name="inspect" />
                    Inspect the checked bytes
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
        </section>
      </div>
    </div>
  );
}
