import { comparePreimages, fromHex } from '@coreflow/sdk';
import { useMemo, useState } from 'react';
import { Badge, Callout, CodeBlock, Field, PageHeader, Status } from '../components/ui';
import { prettyJSON, vectorClaimJSON } from '../lib/claims';
import { VECTORS, repoLink } from '../lib/data';
import { cleanHex, parseHex } from '../lib/format';
import { runAllVectors, type VectorResult } from '../lib/vectorRunner';
import { useHandoff } from '../state';

function ConformanceHelper() {
  const [name, setName] = useState(VECTORS.valid[0]!.name);
  const [theirs, setTheirs] = useState('');
  const [theirSig, setTheirSig] = useState('');
  const vector = VECTORS.valid.find((v) => v.name === name)!;
  const issuer = VECTORS.issuers.find((i) => i.public_key_hex === vector.claim.issuer_hex);

  const preimageResult = useMemo(() => {
    if (!theirs.trim()) return undefined;
    const parsed = parseHex(theirs, 'Your preimage', 256);
    if (!parsed.ok) return { error: parsed.error };
    return { diffs: comparePreimages(fromHex(vector.preimage_hex!), parsed.value) };
  }, [theirs, vector]);

  const sigResult = useMemo(() => {
    if (!theirSig.trim()) return undefined;
    const parsed = parseHex(theirSig, 'Your signature', 64);
    if (!parsed.ok) return { error: parsed.error };
    return { match: cleanHex(theirSig) === vector.signature_hex };
  }, [theirSig, vector]);

  return (
    <section className="card" aria-labelledby="conformance-title">
      <h2 id="conformance-title">Check another implementation</h2>
      <p className="card-sub">
        Writing a signer in Go, Python or Rust? Feed it a vector's inputs, paste its preimage and signature here, and
        see which fields disagree. Ed25519 signatures are deterministic, so with the public test seed they must match
        byte for byte.
      </p>
      <Field label="Valid vector">
        {({ id }) => (
          <select id={id} value={name} onChange={(e) => setName(e.target.value)}>
            {VECTORS.valid.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}: {v.description}
              </option>
            ))}
          </select>
        )}
      </Field>
      <CodeBlock
        title="Inputs for your implementation"
        code={prettyJSON({
          network_passphrase: vector.context.network_passphrase,
          contract_id: vector.context.contract_id,
          issuer_seed_hex: issuer?.seed_hex,
          claim: vector.claim,
        })}
        copyLabel="Copy inputs"
      />
      <Field
        label="Your preimage (hex)"
        error={preimageResult && 'error' in preimageResult ? preimageResult.error : undefined}
      >
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            rows={4}
            spellCheck={false}
            value={theirs}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => setTheirs(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Your signature (hex, optional)"
        error={sigResult && 'error' in sigResult ? sigResult.error : undefined}
      >
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            rows={2}
            spellCheck={false}
            value={theirSig}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => setTheirSig(e.target.value)}
          />
        )}
      </Field>
      <div aria-live="polite" className="stack" style={{ gap: 10 }}>
        {preimageResult && 'diffs' in preimageResult ? (
          preimageResult.diffs!.length === 0 ? (
            <Callout tone="ok" title="Your preimage is byte-identical to the vector" />
          ) : (
            <Callout
              tone="bad"
              title={`Your preimage differs in ${preimageResult.diffs!.length} field${preimageResult.diffs!.length > 1 ? 's' : ''}`}
            >
              <ul>
                {preimageResult.diffs!.map((d) => (
                  <li key={d.name}>
                    <code>{d.name}</code> (bytes {d.offset}–{d.offset + d.size - 1})
                  </li>
                ))}
              </ul>
            </Callout>
          )
        ) : null}
        {sigResult && 'match' in sigResult ? (
          sigResult.match ? (
            <Callout tone="ok" title="Your signature equals the vector's signature" />
          ) : (
            <Callout tone="bad" title="Your signature differs from the vector's signature">
              <p className="small">
                If the preimage matches, check that you sign the raw 256 bytes with no prefix or prehash.
              </p>
            </Callout>
          )
        ) : null}
      </div>
    </section>
  );
}

export function Vectors() {
  const [results, setResults] = useState<VectorResult[]>(() => runAllVectors());
  const [ranAt, setRanAt] = useState(() => new Date());
  const { openInInspect, openInVerify } = useHandoff();
  const passed = results.filter((r) => r.ok).length;

  return (
    <div className="page">
      <PageHeader
        title="Test vectors"
        lede="The shared vectors come from an independent implementation that shares no code with the SDK or the Rust crate. They are run here, in your browser, through @coreflow/sdk."
      >
        <Badge kind="local" />
        <a
          className="small"
          href={repoLink('packages/test-vectors/vectors/claim-v1.json')}
          target="_blank"
          rel="noreferrer"
        >
          claim-v1.json
        </a>
      </PageHeader>

      <section className="card" aria-labelledby="run-title">
        <div className="row-between">
          <div aria-live="polite">
            <h2 id="run-title">
              {passed} of {results.length} vectors pass
            </h2>
            <p className="small muted">Run at {ranAt.toLocaleTimeString()} with @coreflow/sdk 0.1.0-alpha.</p>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setResults(runAllVectors());
              setRanAt(new Date());
            }}
          >
            Run again
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <caption className="visually-hidden">Result of each test vector</caption>
            <thead>
              <tr>
                <th scope="col">Vector</th>
                <th scope="col">Expectation</th>
                <th scope="col">Result</th>
                <th scope="col">Open</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={`${r.kind}-${r.vector.name}`}>
                  <th scope="row">
                    <code>{r.vector.name}</code>
                    <div className="small muted" style={{ fontWeight: 400 }}>
                      {r.kind === 'valid' ? r.vector.description : r.vector.reason}
                    </div>
                  </th>
                  <td>{r.expectation}</td>
                  <td>
                    {r.ok ? <Status kind="pass">Pass</Status> : <Status kind="fail">Fail</Status>}
                    <ul className="small muted" style={{ margin: '4px 0 0', paddingLeft: '1.1em' }}>
                      {r.checks.map((c) => (
                        <li key={c.label}>
                          <span className="visually-hidden">{c.ok ? 'passed: ' : 'failed: '}</span>
                          {c.label}
                          {c.detail ? ` (${c.detail})` : ''}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`Verify ${r.vector.name}`}
                        onClick={() =>
                          openInVerify({
                            claimJSON: prettyJSON(vectorClaimJSON(r.vector.claim)),
                            signatureHex: r.vector.signature_hex,
                            passphrase: r.vector.context.network_passphrase,
                            contractId: r.vector.context.contract_id,
                            at: r.vector.now,
                            source: `test vector "${r.vector.name}"`,
                          })
                        }
                      >
                        Verify
                      </button>
                      {r.preimageHex ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          aria-label={`Inspect ${r.vector.name}`}
                          onClick={() =>
                            openInInspect({
                              preimageHex: r.preimageHex!,
                              signatureHex: r.vector.signature_hex,
                              passphrase: r.vector.context.network_passphrase,
                              contractId: r.vector.context.contract_id,
                              source: `test vector "${r.vector.name}"`,
                            })
                          }
                        >
                          Inspect
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          For invalid vectors, Inspect opens the preimage the verifier would build. Signature vectors fail there because
          the issuer signed different bytes.
        </p>
      </section>

      <ConformanceHelper />
    </div>
  );
}
