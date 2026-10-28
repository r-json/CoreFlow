import {
  claimToJSON,
  claimType,
  contractDigest,
  encodeClaim,
  issuerFromStrkey,
  issuerPublicKey,
  issuerToStrkey,
  randomClaimId,
  sha256,
  signClaim,
  toHex,
  type Claim,
  type ClaimContext,
  type ClaimJSON,
} from '@coreflow/sdk';
import { useMemo, useState } from 'react';
import { ByteMap } from '../components/preimage';
import { Icon } from '../components/Icon';
import { Badge, Callout, CodeBlock, Field, PageHeader, Status } from '../components/ui';
import { NETWORK_OPTIONS, REFERENCE_CONTRACT_ID, passphraseFor, prettyJSON, type NetworkChoice } from '../lib/claims';
import { VECTORS, repoLink } from '../lib/data';
import { issuerSnippet, releaseCommand } from '../lib/exports';
import { groupHex, nowSeconds, parseHex, parseU64, unixToIso } from '../lib/format';
import { runVerification, type VerificationReport } from '../lib/verification';
import { useHandoff } from '../state';

type IssuerSource = 'throwaway' | 'test-0' | 'test-1' | 'external';

interface Form {
  network: NetworkChoice;
  customPassphrase: string;
  contractId: string;
  issuerSource: IssuerSource;
  externalIssuer: string;
  externalSignature: string;
  claimTypeName: string;
  subjectMode: 'text' | 'hex';
  subject: string;
  payloadMode: 'text' | 'hex';
  payload: string;
  payloadEncoding: 'raw' | 'xdr';
  replayMode: 'unique-id' | 'sequence';
  claimIdHex: string;
  nonce: string;
  issuedAt: string;
  lifetime: string;
}

const initialForm = (): Form => ({
  network: 'testnet',
  customPassphrase: '',
  contractId: REFERENCE_CONTRACT_ID,
  issuerSource: 'throwaway',
  externalIssuer: '',
  externalSignature: '',
  claimTypeName: 'marketplace.delivery.v1',
  subjectMode: 'text',
  subject: 'order:42',
  payloadMode: 'text',
  payload: '{"order":42,"status":"delivered"}',
  payloadEncoding: 'raw',
  replayMode: 'unique-id',
  claimIdHex: toHex(randomClaimId()),
  nonce: '0',
  issuedAt: String(nowSeconds()),
  lifetime: '900',
});

type Errors = Partial<Record<keyof Form, string>>;

interface Built {
  errors: Errors;
  issuer?: Uint8Array;
  claim?: Claim;
  ctx?: ClaimContext;
  json?: ClaimJSON;
  preimageHex?: string;
  signatureHex?: string;
  report?: VerificationReport;
  expiresAt?: bigint;
}

function build(form: Form, seed: Uint8Array): Built {
  const errors: Errors = {};

  const passphrase = passphraseFor(form.network, form.customPassphrase);
  if (form.network === 'custom' && passphrase.trim() === '') errors.customPassphrase = 'Enter the network passphrase.';
  try {
    contractDigest(form.contractId.trim());
  } catch {
    errors.contractId = 'Enter a valid contract address: 56 characters starting with C.';
  }

  let issuer: Uint8Array | undefined;
  const testIssuer =
    form.issuerSource === 'test-0'
      ? VECTORS.issuers[0]
      : form.issuerSource === 'test-1'
        ? VECTORS.issuers[1]
        : undefined;
  const signingSeed =
    form.issuerSource === 'throwaway' ? seed : testIssuer ? parseHex(testIssuer.seed_hex, 'seed', 32) : undefined;
  if (form.issuerSource === 'external') {
    const text = form.externalIssuer.trim();
    if (text.startsWith('G')) {
      try {
        issuer = issuerFromStrkey(text);
      } catch {
        errors.externalIssuer = 'Not a valid G... public key.';
      }
    } else {
      const parsed = parseHex(text, 'The issuer key', 32);
      if (parsed.ok) issuer = parsed.value;
      else errors.externalIssuer = text ? parsed.error : 'Enter the issuer public key (G... or 64 hex digits).';
    }
  } else if (signingSeed instanceof Uint8Array) {
    issuer = issuerPublicKey(signingSeed);
  } else if (signingSeed?.ok) {
    issuer = issuerPublicKey(signingSeed.value);
  }

  if (form.claimTypeName.trim() === '') errors.claimTypeName = 'Enter a claim type name, e.g. marketplace.delivery.v1.';

  let subject: Uint8Array | undefined;
  if (form.subjectMode === 'text') {
    if (form.subject === '') errors.subject = 'Enter the subject, e.g. order:42.';
    else subject = sha256(form.subject);
  } else {
    const parsed = parseHex(form.subject, 'The subject', 32);
    if (parsed.ok) subject = parsed.value;
    else errors.subject = parsed.error;
  }

  let payloadHash: Uint8Array | undefined;
  if (form.payloadMode === 'text') payloadHash = sha256(form.payload);
  else {
    const parsed = parseHex(form.payload, 'The payload');
    if (parsed.ok) payloadHash = sha256(parsed.value);
    else errors.payload = parsed.error;
  }

  let replay: Claim['replay'] | undefined;
  if (form.replayMode === 'unique-id') {
    const parsed = parseHex(form.claimIdHex, 'The claim id', 32);
    if (parsed.ok) replay = { mode: 'unique-id', claimId: parsed.value };
    else errors.claimIdHex = parsed.error;
  } else {
    const parsed = parseU64(form.nonce, 'The nonce');
    if (parsed.ok) replay = { mode: 'sequence', nonce: parsed.value };
    else errors.nonce = parsed.error;
  }

  const issuedAt = parseU64(form.issuedAt, 'issued_at');
  const lifetime = parseU64(form.lifetime, 'The lifetime');
  if (!issuedAt.ok) errors.issuedAt = issuedAt.error;
  if (!lifetime.ok) errors.lifetime = lifetime.error;
  let expiresAt: bigint | undefined;
  if (issuedAt.ok && lifetime.ok) {
    expiresAt = issuedAt.value + lifetime.value;
    if (expiresAt > 0xffffffffffffffffn) {
      errors.lifetime = 'issued_at plus the lifetime does not fit in a u64.';
      expiresAt = undefined;
    }
  }

  let signature: Uint8Array | undefined;
  if (form.issuerSource === 'external' && form.externalSignature.trim() !== '') {
    const parsed = parseHex(form.externalSignature, 'The signature', 64);
    if (parsed.ok) signature = parsed.value;
    else errors.externalSignature = parsed.error;
  }

  if (
    Object.keys(errors).length ||
    !issuer ||
    !subject ||
    !payloadHash ||
    !replay ||
    expiresAt === undefined ||
    !issuedAt.ok
  ) {
    return { errors, issuer };
  }

  const claim: Claim = {
    issuer,
    claimType: claimType(form.claimTypeName),
    subject,
    payloadHash,
    payloadEncoding: form.payloadEncoding,
    replay,
    issuedAt: issuedAt.value,
    expiresAt,
  };
  const ctx: ClaimContext = { networkPassphrase: passphrase, contractId: form.contractId.trim() };
  const preimageHex = toHex(encodeClaim(claim, ctx));
  if (!signature && form.issuerSource !== 'external') {
    const key = signingSeed instanceof Uint8Array ? signingSeed : signingSeed?.ok ? signingSeed.value : undefined;
    if (key) signature = signClaim(claim, ctx, key).signature;
  }
  return {
    errors,
    issuer,
    claim,
    ctx,
    json: claimToJSON(claim),
    preimageHex,
    signatureHex: signature ? toHex(signature) : undefined,
    report: signature ? runVerification(claim, ctx, signature, nowSeconds()) : undefined,
    expiresAt,
  };
}

function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  legend,
}: {
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  legend: string;
}) {
  return (
    <div className="field">
      <span className="field-label" id={`${name}-legend`}>
        {legend}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={`${name}-legend`}>
        {options.map((o) => (
          <label key={o.value}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  );
}

export function Compose() {
  const [form, setForm] = useState<Form>(initialForm);
  const [seed, setSeed] = useState<Uint8Array>(() => crypto.getRandomValues(new Uint8Array(32)));
  const { openInVerify, openInInspect } = useHandoff();
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const built = useMemo(() => build(form, seed), [form, seed]);
  const { errors } = built;
  const passphrase = passphraseFor(form.network, form.customPassphrase);

  const issuerLabel = built.issuer ? issuerToStrkey(built.issuer) : undefined;
  const snippet =
    built.json && built.expiresAt !== undefined
      ? issuerSnippet({
          network: form.network,
          passphrase,
          contractId: form.contractId.trim(),
          claimTypeName: form.claimTypeName,
          subject: { mode: form.subjectMode, value: form.subject },
          payload: { mode: form.payloadMode, value: form.payload },
          payloadEncoding: form.payloadEncoding,
          replay:
            form.replayMode === 'unique-id'
              ? { mode: 'unique-id', claimIdHex: built.json.claim_id }
              : { mode: 'sequence', nonce: built.json.nonce },
          issuedAt: built.json.issued_at,
          expiresAt: built.json.expires_at,
        })
      : undefined;

  return (
    <div className="page">
      <PageHeader
        title="Compose & sign"
        lede="Describe a claim, sign it with a test key, and take the exact bytes, JSON and commands to your issuer, relayer or contract tests."
      >
        <Badge kind="local" />
      </PageHeader>

      <div className="split">
        <form className="stack" onSubmit={(e) => e.preventDefault()} aria-label="Claim">
          <section className="card">
            <fieldset>
              <legend>Where the claim will be verified</legend>
              <p className="hint">
                The signature covers both values, so a claim only verifies on this network and in this contract.
              </p>
              <div className="fields-2">
                <Field label="Network">
                  {({ id }) => (
                    <select
                      id={id}
                      value={form.network}
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
                {form.network === 'custom' ? (
                  <Field label="Network passphrase" error={errors.customPassphrase}>
                    {({ id, describedBy, invalid }) => (
                      <input
                        id={id}
                        type="text"
                        value={form.customPassphrase}
                        aria-invalid={invalid}
                        aria-describedby={describedBy}
                        onChange={(e) => set('customPassphrase', e.target.value)}
                      />
                    )}
                  </Field>
                ) : null}
              </div>
              {form.network === 'mainnet' ? (
                <Callout tone="warn" title="Mainnet is not supported by 0.1.0-alpha">
                  <p>
                    The kit has not been audited. You can encode and inspect a Mainnet-bound claim here, but do not use
                    the kit to protect real value.
                  </p>
                </Callout>
              ) : null}
              <Field
                label="Verifying contract ID"
                hint="Defaults to the marketplace-hold contract from the reference Testnet run. Use your own contract's address."
                error={errors.contractId}
              >
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    type="text"
                    className="mono"
                    spellCheck={false}
                    autoComplete="off"
                    value={form.contractId}
                    aria-invalid={invalid}
                    aria-describedby={describedBy}
                    onChange={(e) => set('contractId', e.target.value)}
                  />
                )}
              </Field>
            </fieldset>
          </section>

          <section className="card">
            <fieldset>
              <legend>Issuer key</legend>
              <div className="radio-list">
                <label className="radio-card">
                  <input
                    type="radio"
                    name="issuer"
                    checked={form.issuerSource === 'throwaway'}
                    onChange={() => set('issuerSource', 'throwaway')}
                  />
                  <span className="title">Throwaway key in this tab</span>
                  <span className="hint">
                    Random, kept only in memory, never shown or saved. Gone when you close the tab.
                  </span>
                </label>
                <label className="radio-card">
                  <input
                    type="radio"
                    name="issuer"
                    checked={form.issuerSource === 'test-0'}
                    onChange={() => set('issuerSource', 'test-0')}
                  />
                  <span className="title">Public test issuer 0</span>
                  <span className="hint">
                    The seed is SHA-256("coreflow-test-issuer-0"). Anyone can sign as this key; tests only.
                  </span>
                </label>
                <label className="radio-card">
                  <input
                    type="radio"
                    name="issuer"
                    checked={form.issuerSource === 'test-1'}
                    onChange={() => set('issuerSource', 'test-1')}
                  />
                  <span className="title">Public test issuer 1</span>
                  <span className="hint">Same rule with index 1. Useful for rotation and wrong-issuer cases.</span>
                </label>
                <label className="radio-card">
                  <input
                    type="radio"
                    name="issuer"
                    checked={form.issuerSource === 'external'}
                    onChange={() => set('issuerSource', 'external')}
                  />
                  <span className="title">My own issuer (sign elsewhere)</span>
                  <span className="hint">
                    Enter the public key, sign the preimage on your backend, and paste the signature back to check it.
                  </span>
                </label>
              </div>
              {form.issuerSource === 'throwaway' ? (
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setSeed(crypto.getRandomValues(new Uint8Array(32)))}
                  >
                    New throwaway key
                  </button>
                </div>
              ) : null}
              {form.issuerSource === 'external' ? (
                <>
                  <Field
                    label="Issuer public key"
                    hint="G... address or 64 hex digits. The Workbench never asks for a secret key."
                    error={errors.externalIssuer}
                  >
                    {({ id, describedBy, invalid }) => (
                      <input
                        id={id}
                        type="text"
                        className="mono"
                        spellCheck={false}
                        autoComplete="off"
                        value={form.externalIssuer}
                        aria-invalid={invalid}
                        aria-describedby={describedBy}
                        onChange={(e) => set('externalIssuer', e.target.value)}
                      />
                    )}
                  </Field>
                  <Field
                    label="Signature from your backend (optional)"
                    hint="128 hex digits: Ed25519 over the preimage shown on the right."
                    error={errors.externalSignature}
                  >
                    {({ id, describedBy, invalid }) => (
                      <textarea
                        id={id}
                        rows={3}
                        spellCheck={false}
                        value={form.externalSignature}
                        aria-invalid={invalid}
                        aria-describedby={describedBy}
                        onChange={(e) => set('externalSignature', e.target.value)}
                      />
                    )}
                  </Field>
                </>
              ) : null}
              {issuerLabel ? (
                <p className="small">
                  <span className="muted">Issuer: </span>
                  <span className="hex">{issuerLabel}</span>
                </p>
              ) : null}
            </fieldset>
          </section>

          <section className="card">
            <fieldset>
              <legend>The claim</legend>
              <Field
                label="Claim type name"
                hint="Hashed with SHA-256. Your contract compares the hash with the type its entry point handles."
                error={errors.claimTypeName}
              >
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    type="text"
                    className="mono"
                    spellCheck={false}
                    value={form.claimTypeName}
                    aria-invalid={invalid}
                    aria-describedby={describedBy}
                    onChange={(e) => set('claimTypeName', e.target.value)}
                  />
                )}
              </Field>
              <Segmented
                name="subject-mode"
                legend="Subject given as"
                value={form.subjectMode}
                options={[
                  { value: 'text', label: 'Text (hashed)' },
                  { value: 'hex', label: '32-byte hex' },
                ]}
                onChange={(v) => set('subjectMode', v)}
              />
              <Field
                label="Subject"
                hint={
                  form.subjectMode === 'text'
                    ? 'What the claim is about. Hashed with SHA-256; marketplace-hold expects the order string.'
                    : 'Exactly 32 bytes.'
                }
                error={errors.subject}
              >
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    type="text"
                    className="mono"
                    spellCheck={false}
                    value={form.subject}
                    aria-invalid={invalid}
                    aria-describedby={describedBy}
                    onChange={(e) => set('subject', e.target.value)}
                  />
                )}
              </Field>
              <Segmented
                name="payload-mode"
                legend="Payload given as"
                value={form.payloadMode}
                options={[
                  { value: 'text', label: 'UTF-8 text' },
                  { value: 'hex', label: 'Hex bytes' },
                ]}
                onChange={(v) => set('payloadMode', v)}
              />
              <Field
                label="Payload"
                hint="Travels off-chain. Only its SHA-256 is signed, so consumers must hash what they act on and compare."
                error={errors.payload}
              >
                {({ id, describedBy, invalid }) => (
                  <textarea
                    id={id}
                    rows={3}
                    spellCheck={false}
                    value={form.payload}
                    aria-invalid={invalid}
                    aria-describedby={describedBy}
                    onChange={(e) => set('payload', e.target.value)}
                  />
                )}
              </Field>
              <Segmented
                name="payload-encoding"
                legend="payload_encoding"
                value={form.payloadEncoding}
                options={[
                  { value: 'raw', label: '0 · raw' },
                  { value: 'xdr', label: '1 · XDR ScVal' },
                ]}
                onChange={(v) => set('payloadEncoding', v)}
              />
            </fieldset>
          </section>

          <section className="card">
            <fieldset>
              <legend>Replay protection and lifetime</legend>
              <Segmented
                name="replay-mode"
                legend="Replay mode"
                value={form.replayMode}
                options={[
                  { value: 'unique-id', label: 'Unique id' },
                  { value: 'sequence', label: 'Sequence' },
                ]}
                onChange={(v) => set('replayMode', v)}
              />
              {form.replayMode === 'unique-id' ? (
                <Field
                  label="claim_id"
                  hint="Accepted once per issuer. Use a random id when several relayers submit concurrently."
                  error={errors.claimIdHex}
                >
                  {({ id, describedBy, invalid }) => (
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <input
                        id={id}
                        type="text"
                        className="mono"
                        spellCheck={false}
                        value={form.claimIdHex}
                        aria-invalid={invalid}
                        aria-describedby={describedBy}
                        onChange={(e) => set('claimIdHex', e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => set('claimIdHex', toHex(randomClaimId()))}
                      >
                        Random
                      </button>
                    </div>
                  )}
                </Field>
              ) : (
                <Field
                  label="nonce"
                  hint="Must equal the contract's next expected value for (issuer, claim type, subject); it starts at 0."
                  error={errors.nonce}
                >
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      type="text"
                      inputMode="numeric"
                      className="mono"
                      value={form.nonce}
                      aria-invalid={invalid}
                      aria-describedby={describedBy}
                      onChange={(e) => set('nonce', e.target.value)}
                    />
                  )}
                </Field>
              )}
              <div className="fields-2">
                <Field
                  label="issued_at (Unix seconds)"
                  hint={unixToIso(BigInt(/^\d+$/.test(form.issuedAt) ? form.issuedAt : '0')) ?? ''}
                  error={errors.issuedAt}
                >
                  {({ id, describedBy, invalid }) => (
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <input
                        id={id}
                        type="text"
                        inputMode="numeric"
                        className="mono"
                        value={form.issuedAt}
                        aria-invalid={invalid}
                        aria-describedby={describedBy}
                        onChange={(e) => set('issuedAt', e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => set('issuedAt', String(nowSeconds()))}
                      >
                        Now
                      </button>
                    </div>
                  )}
                </Field>
                <Field
                  label="Valid for (seconds)"
                  hint={
                    built.expiresAt !== undefined
                      ? `expires_at = ${built.expiresAt} (${unixToIso(built.expiresAt) ?? 'beyond any date'})`
                      : undefined
                  }
                  error={errors.lifetime}
                >
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      type="text"
                      inputMode="numeric"
                      className="mono"
                      value={form.lifetime}
                      aria-invalid={invalid}
                      aria-describedby={describedBy}
                      onChange={(e) => set('lifetime', e.target.value)}
                    />
                  )}
                </Field>
              </div>
            </fieldset>
          </section>
          <div className="row">
            <button type="button" className="btn" onClick={() => setForm(initialForm())}>
              Reset to the example
            </button>
          </div>
        </form>

        <div className="stack">
          <p className="visually-hidden" aria-live="polite">
            {!built.claim
              ? 'Claim incomplete. Fix the highlighted fields.'
              : built.report?.ok
                ? 'Claim built and signed. It passes the off-chain checks.'
                : built.report
                  ? `Claim built. It fails ${built.report.failure?.code ?? built.report.inputError?.code}.`
                  : 'Claim built. Not signed yet.'}
          </p>
          {!built.claim ? (
            <Callout tone="warn" title="Fix the highlighted fields to build the claim">
              <ul>
                {Object.values(errors).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Callout>
          ) : (
            <>
              <section className="card" aria-labelledby="result-title">
                <div className="card-title">
                  <h2 id="result-title">Claim</h2>
                  {built.report ? (
                    built.report.ok ? (
                      <Status kind="pass">Passes the off-chain checks now</Status>
                    ) : (
                      <Status kind="fail">Fails {built.report.failure?.code ?? built.report.inputError?.code}</Status>
                    )
                  ) : (
                    <Status kind="skip">Not signed yet</Status>
                  )}
                </div>
                {built.report && !built.report.ok ? (
                  <p className="small">
                    {built.report.failure?.message ?? built.report.inputError?.message}.{' '}
                    {built.report.failure?.nextStep}
                  </p>
                ) : null}
                {!built.signatureHex ? (
                  <Callout title="Sign this preimage on your backend">
                    <p className="small">
                      Ed25519-sign the 256 bytes below with the issuer's secret key (no prefix, no prehash), then paste
                      the 64-byte signature into the form.
                    </p>
                  </Callout>
                ) : null}
                <CodeBlock
                  title="Claim JSON"
                  code={prettyJSON(built.json)}
                  download="claim.json"
                  copyLabel="Copy claim JSON"
                />
                {built.signatureHex ? (
                  <CodeBlock title="Signature (64 bytes)" code={built.signatureHex} wrap copyLabel="Copy signature" />
                ) : null}
                <CodeBlock
                  title="Preimage (256 bytes)"
                  code={groupHex(built.preimageHex!, 8)}
                  wrap
                  copyLabel="Copy preimage"
                />
                <ByteMap />
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!built.signatureHex}
                    onClick={() =>
                      openInVerify({
                        claimJSON: prettyJSON(built.json),
                        signatureHex: built.signatureHex!,
                        passphrase,
                        contractId: form.contractId.trim(),
                        source: 'Compose & sign',
                      })
                    }
                  >
                    <Icon name="verify" />
                    Open in Verify
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      openInInspect({
                        preimageHex: built.preimageHex!,
                        signatureHex: built.signatureHex,
                        passphrase,
                        contractId: form.contractId.trim(),
                        source: 'Compose & sign',
                      })
                    }
                  >
                    <Icon name="inspect" />
                    Open in Inspect
                  </button>
                </div>
              </section>

              <section className="card" aria-labelledby="use-title">
                <h2 id="use-title">Use it</h2>
                <CodeBlock
                  title="stellar-cli: submit to marketplace-hold"
                  code={releaseCommand({
                    json: built.json!,
                    contractId: form.contractId.trim(),
                    network: form.network,
                    signatureHex: built.signatureHex,
                  })}
                  copyLabel="Copy command"
                />
                <p className="hint">
                  For the{' '}
                  <a href={repoLink('examples/marketplace-hold')} target="_blank" rel="noreferrer">
                    marketplace-hold example
                  </a>
                  . Your own contract takes the same claim and signature arguments in its own entry point. Running it
                  submits a transaction; the Workbench does not.
                </p>
                {snippet ? (
                  <CodeBlock title="TypeScript issuer (Node)" code={snippet} copyLabel="Copy TypeScript" />
                ) : null}
                <p className="hint">
                  The backend signs with its own key, so only the issuer field and the signature will differ.
                </p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
