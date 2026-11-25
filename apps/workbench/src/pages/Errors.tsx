import { useState } from 'react';
import { Badge, Callout, Field, PageHeader } from '../components/ui';
import { EXAMPLE_ERRORS, HOST_ERRORS, KIT_ERRORS, SDK_ERRORS, lookupError, type ErrorEntry } from '../lib/errorCatalog';
import { repoLink } from '../lib/data';

const EXAMPLES = ['Error(Contract, #1106)', '1103', 'Error(Crypto, InvalidInput)', 'NonceMismatch'];

function ErrorTable({
  entries,
  caption,
  showCode = true,
}: {
  entries: ErrorEntry[];
  caption: string;
  showCode?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {showCode ? <th scope="col">Code</th> : null}
            <th scope="col">Name</th>
            <th scope="col">Meaning</th>
            <th scope="col">Next step</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={`${e.scope}-${e.name}`}>
              {showCode ? <td className="mono">{e.code ?? 'none'}</td> : null}
              <th scope="row">
                <code>{e.name}</code>
                {e.step ? (
                  <div className="small muted" style={{ fontWeight: 400 }}>
                    Step {e.step}
                  </div>
                ) : null}
              </th>
              <td>{e.meaning}</td>
              <td>{e.nextStep}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Errors() {
  const [query, setQuery] = useState('');
  const result = lookupError(query);

  return (
    <div className="page">
      <PageHeader
        title="Error codes"
        lede="Paste what stellar-cli, an RPC response or a failing test printed. The Workbench finds the error and tells you what to do next."
      >
        <Badge kind="local" />
        <a className="small" href={repoLink('docs/kit/claim-format.md#6-error-codes')} target="_blank" rel="noreferrer">
          Spec section 6
        </a>
      </PageHeader>

      <section className="card" aria-labelledby="lookup-title">
        <h2 id="lookup-title">Look up an error</h2>
        <Field
          label="Error text or code"
          hint="For example a line containing Error(Contract, #1106), a bare number, or an error name."
        >
          {({ id, describedBy }) => (
            <textarea
              id={id}
              rows={3}
              spellCheck={false}
              aria-describedby={describedBy}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
        </Field>
        <div className="row">
          <span className="small muted">Try:</span>
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="btn btn-sm" onClick={() => setQuery(ex)}>
              {ex}
            </button>
          ))}
        </div>
        <div aria-live="polite">
          {query.trim() === '' ? null : result ? (
            <div className="stack" style={{ gap: 10 }}>
              <p className="small">
                Recognised <code>{result.matched}</code>.
              </p>
              {result.caveat ? <Callout tone="warn">{result.caveat}</Callout> : null}
              {result.entries.map((e) => (
                <Callout
                  key={`${e.scope}-${e.name}`}
                  tone={e.scope === 'example' ? 'info' : 'bad'}
                  title={`${e.code ? `${e.code} ` : ''}${e.name}`}
                >
                  <p className="small">{e.meaning}</p>
                  <p className="small">
                    <strong>Next step:</strong> {e.nextStep}
                  </p>
                </Callout>
              ))}
            </div>
          ) : (
            <Callout tone="warn" title="No known error found">
              <p className="small">
                Look for <code>Error(Contract, #N)</code> in the output. Host errors other than a bad signature come
                from Soroban itself, not from the kit.
              </p>
            </Callout>
          )}
        </div>
      </section>

      <section className="card" aria-labelledby="kit-title">
        <h2 id="kit-title">coreflow-attest contract errors (1101–1109)</h2>
        <p className="card-sub">A reserved range, so they do not collide with your contract's own codes.</p>
        <ErrorTable entries={KIT_ERRORS} caption="coreflow-attest error codes" />
      </section>

      <section className="card" aria-labelledby="sdk-title">
        <h2 id="sdk-title">Off-chain only and host errors</h2>
        <p className="card-sub">
          Reported by @coreflow/sdk before you submit, or by the Soroban host when a signature is bad.
        </p>
        <ErrorTable entries={[...SDK_ERRORS, ...HOST_ERRORS]} caption="Off-chain and host errors" showCode={false} />
      </section>

      <section className="card" aria-labelledby="example-title">
        <h2 id="example-title">marketplace-hold example errors (1–7)</h2>
        <p className="card-sub">
          These belong to the example contract. In your contract, numbers below 1101 mean whatever you define.
        </p>
        <ErrorTable entries={EXAMPLE_ERRORS} caption="marketplace-hold error codes" />
      </section>
    </div>
  );
}
