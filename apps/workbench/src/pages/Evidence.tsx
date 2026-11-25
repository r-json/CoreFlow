import { useMemo } from 'react';
import { Icon } from '../components/Icon';
import { Badge, Callout, PageHeader, Status } from '../components/ui';
import { prettyJSON } from '../lib/claims';
import { EVIDENCE_RUNS, repoLink, type EvidenceRun } from '../lib/data';
import { contractOf, reverifyRun, stepNamed } from '../lib/evidence';
import { middleTruncate, unixToIso } from '../lib/format';
import { useHandoff } from '../state';

const EXPLORER = 'https://stellar.expert/explorer/testnet';

const STEP_LABEL: Record<string, string> = {
  deploy: 'Deploy the contract',
  'open-hold': 'Buyer opens hold #1',
  release: 'Seller relays the claim: release',
  'open-second-hold': 'Buyer opens hold #2 for the same order',
};

function RunCard({ run }: { run: EvidenceRun }) {
  const check = useMemo(() => reverifyRun(run), [run]);
  const { openInVerify, openInInspect } = useHandoff();
  const contractId = contractOf(run);
  const replay = stepNamed(run, 'replay');
  const sign = stepNamed(run, 'sign-claim');
  const txSteps = run.steps.filter((s) => typeof s.txHash === 'string');

  return (
    <section className="card" aria-labelledby={`run-${run.runId}`}>
      <div className="card-title">
        <h2 id={`run-${run.runId}`}>Run {run.runId}</h2>
        {run.outcome === 'passed' ? (
          <Status kind="pass">Run passed</Status>
        ) : (
          <Status kind="warn">{run.outcome ?? 'unknown'}</Status>
        )}
      </div>
      <dl className="kv">
        <dt>Recorded</dt>
        <dd>
          {run.startedAt} by <code>e2e-testnet.mjs</code> {run.scriptVersion}
        </dd>
        <dt>Network</dt>
        <dd>Testnet ({run.networkPassphrase})</dd>
        <dt>Contract</dt>
        <dd>
          {contractId ? (
            <a href={`${EXPLORER}/contract/${contractId}`} target="_blank" rel="noreferrer">
              <span className="hex">{contractId}</span>
            </a>
          ) : (
            'not recorded'
          )}
        </dd>
        <dt>Evidence file</dt>
        <dd>
          <a href={repoLink(`examples/marketplace-hold/evidence/${run.file}`)} target="_blank" rel="noreferrer">
            {run.file}
          </a>
        </dd>
      </dl>

      <div className="table-wrap">
        <table>
          <caption className="visually-hidden">Transactions in run {run.runId}</caption>
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Transaction</th>
              <th scope="col">Ledger</th>
            </tr>
          </thead>
          <tbody>
            {txSteps.map((s) => (
              <tr key={s.name}>
                <th scope="row">{STEP_LABEL[s.name] ?? s.name}</th>
                <td>
                  <a href={`${EXPLORER}/tx/${s.txHash}`} target="_blank" rel="noreferrer" className="mono">
                    {middleTruncate(String(s.txHash), 8)}
                    <span className="visually-hidden"> (opens Stellar Expert)</span>
                  </a>
                </td>
                <td className="mono">{s.ledger ?? ''}</td>
              </tr>
            ))}
            {replay ? (
              <tr>
                <th scope="row">Replay the same claim on hold #2</th>
                <td colSpan={2}>
                  {replay.observed === replay.expected ? (
                    <Status kind="pass">Refused with {String(replay.observed)} ClaimAlreadyUsed</Status>
                  ) : (
                    <Status kind="fail">Observed {String(replay.observed)}</Status>
                  )}
                  <div className="small muted">Simulated only, never submitted, so it has no transaction hash.</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="stack" style={{ gap: 10 }}>
        <h3>Re-verified here, offline</h3>
        <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}>
          <li>
            {check.preimageMatches ? (
              <Status kind="pass">Rebuilt preimage is byte-identical to the recorded one</Status>
            ) : (
              <Status kind="fail">Rebuilt preimage differs from the recorded one</Status>
            )}
          </li>
          <li>
            {check.signatureOk ? (
              <Status kind="pass">
                Signature verifies for this contract on Testnet at issued_at
                {check.issuedAt !== undefined ? ` (${unixToIso(check.issuedAt)})` : ''}
              </Status>
            ) : (
              <Status kind="fail">Signature check failed{check.error ? `: ${check.error}` : ''}</Status>
            )}
          </li>
        </ul>
        {sign?.payloadUtf8 ? (
          <p className="small muted">
            Payload: <code>{sign.payloadUtf8}</code>
          </p>
        ) : null}
        {check.claimJSON && check.signatureHex && contractId ? (
          <div className="row">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                openInVerify({
                  claimJSON: prettyJSON(check.claimJSON),
                  signatureHex: check.signatureHex!,
                  passphrase: run.networkPassphrase,
                  contractId,
                  at: check.issuedAt?.toString(),
                  source: `Testnet run ${run.runId}`,
                })
              }
            >
              <Icon name="verify" />
              Open in Verify
            </button>
            {sign?.preimageHex ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  openInInspect({
                    preimageHex: sign.preimageHex!,
                    signatureHex: check.signatureHex,
                    passphrase: run.networkPassphrase,
                    contractId,
                    source: `Testnet run ${run.runId}`,
                  })
                }
              >
                <Icon name="inspect" />
                Open in Inspect
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function Evidence() {
  return (
    <div className="page">
      <PageHeader
        title="Testnet evidence"
        lede="Each run below deployed marketplace-hold, released a hold with a signed delivery claim, and had the same claim refused on a second hold. The script wrote these records as it ran."
      >
        <Badge kind="recorded" />
        <Badge kind="local">Re-verified locally</Badge>
      </PageHeader>
      <Callout tone="info" title="Recorded, not live">
        <p className="small">
          This page reads the committed evidence files and does not contact the network. Testnet is reset from time to
          time, after which the explorer links stop resolving. The raw Horizon responses for these transactions are
          archived with a SHA-256 per file in{' '}
          <a href={repoLink('docs/evidence/testnet-archive/kit-e2e/manifest.json')} target="_blank" rel="noreferrer">
            docs/evidence/testnet-archive/kit-e2e
          </a>
          . Earlier attempts that aborted are recorded in{' '}
          <a href={repoLink('examples/marketplace-hold/evidence/aborted-runs.json')} target="_blank" rel="noreferrer">
            aborted-runs.json
          </a>
          .
        </p>
      </Callout>
      {EVIDENCE_RUNS.length === 0 ? (
        <Callout tone="warn" title="No evidence files found" />
      ) : (
        [...EVIDENCE_RUNS].reverse().map((run) => <RunCard key={run.runId} run={run} />)
      )}
      <p className="small muted">
        Reproduce a run yourself with <code>npm run e2e</code> in{' '}
        <a href={repoLink('examples/marketplace-hold')} target="_blank" rel="noreferrer">
          examples/marketplace-hold
        </a>{' '}
        (Testnet only, throwaway keys, needs stellar-cli and Rust).
      </p>
    </div>
  );
}
