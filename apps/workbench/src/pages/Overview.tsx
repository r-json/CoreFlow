import { Icon, type IconName } from '../components/Icon';
import { Badge, PageHeader } from '../components/ui';
import { EVIDENCE_RUNS, REPO_URL, VECTORS, repoLink } from '../lib/data';
import { hrefFor, type Route } from '../lib/router';

const TOOLS: { route: Route; icon: IconName; title: string; body: string; mode: 'local' | 'recorded' }[] = [
  {
    route: 'compose',
    icon: 'compose',
    title: 'Compose & sign',
    body: 'Fill in a claim, sign it with a throwaway test key, and get the claim JSON, the stellar-cli command and issuer code for it.',
    mode: 'local',
  },
  {
    route: 'verify',
    icon: 'verify',
    title: 'Verify',
    body: 'Run the off-chain checks in the same order as the contract and see which step fails, its error code and what to do next.',
    mode: 'local',
  },
  {
    route: 'inspect',
    icon: 'inspect',
    title: 'Inspect & diff',
    body: 'Decode the 256 signed bytes field by field, and compare two preimages to find exactly where a signer and a contract disagree.',
    mode: 'local',
  },
  {
    route: 'vectors',
    icon: 'vectors',
    title: 'Test vectors',
    body: `Run the ${VECTORS.valid.length + VECTORS.invalid.length} shared vectors through @coreflow/sdk here, and check another implementation's output against them.`,
    mode: 'local',
  },
  {
    route: 'errors',
    icon: 'errors',
    title: 'Error codes',
    body: 'Paste an error from stellar-cli or an RPC response and get its meaning and the next step.',
    mode: 'local',
  },
  {
    route: 'evidence',
    icon: 'evidence',
    title: 'Testnet evidence',
    body: `Re-verify the claims from ${EVIDENCE_RUNS.length} recorded Testnet runs of the marketplace example, offline.`,
    mode: 'recorded',
  },
];

export function Overview() {
  return (
    <div className="page">
      <PageHeader
        title="CoreFlow Kit Workbench"
        lede="Build, sign, inspect and verify the signed claims that coreflow-attest checks inside Soroban contracts, without installing Rust or deploying anything."
      >
        <Badge kind="local" />
        <Badge kind="alpha" />
      </PageHeader>

      <section className="card" aria-labelledby="flow-title">
        <div className="card-title">
          <h2 id="flow-title">How a signed claim reaches a contract</h2>
          <a href={repoLink('docs/kit/claim-format.md')} target="_blank" rel="noreferrer" className="small">
            Claim format spec
          </a>
        </div>
        <ol className="flow" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          <li className="flow-step">
            <span className="k">1 · Issuer signs</span>
            <span>
              A backend or device with an Ed25519 key signs a 256-byte claim: <em>order 42 was delivered</em>. It does
              not need a Stellar account.
            </span>
          </li>
          <li className="flow-step">
            <span className="k">2 · Anyone relays</span>
            <span>A relayer, the beneficiary or the issuer submits the claim and signature to your contract.</span>
          </li>
          <li className="flow-step">
            <span className="k">3 · Contract verifies</span>
            <span>
              <code>coreflow-attest</code> checks the issuer registry, the validity window, expiry, replay state and the
              signature, bound to this network and this contract.
            </span>
          </li>
          <li className="flow-step">
            <span className="k">4 · Contract acts</span>
            <span>
              Your code acts on the fact, for example releasing a held payment, and the claim cannot be used again.
            </span>
          </li>
        </ol>
      </section>

      <section aria-labelledby="tools-title" className="stack">
        <h2 id="tools-title">Tools</h2>
        <div className="tool-grid">
          {TOOLS.map((t) => (
            <a key={t.route} className="tool" href={hrefFor(t.route)}>
              <h3>
                <Icon name={t.icon} className="nav-icon" />
                {t.title}
              </h3>
              <p>{t.body}</p>
              <span>
                <Badge kind={t.mode}>{t.mode === 'local' ? 'Local' : 'Recorded Testnet'}</Badge>
              </span>
            </a>
          ))}
        </div>
      </section>

      <div className="split split-even">
        <section className="card" aria-labelledby="where-title">
          <h2 id="where-title">What runs where</h2>
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">Where each part of claim verification happens</caption>
              <thead>
                <tr>
                  <th scope="col">Where</th>
                  <th scope="col">What</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">
                    <Badge kind="local">This tab</Badge>
                  </th>
                  <td>
                    Encoding, signing with test keys, decoding, and the off-chain checks: window, expiry, replay fields
                    and signature. No network requests.
                  </td>
                </tr>
                <tr>
                  <th scope="row">
                    <Badge kind="contract">Contract only</Badge>
                  </th>
                  <td>
                    Whether the issuer is registered (1101) and whether the nonce or claim id was already used (1105,
                    1106). That state lives on-chain.
                  </td>
                </tr>
                <tr>
                  <th scope="row">
                    <Badge kind="recorded">Recorded</Badge>
                  </th>
                  <td>Testnet runs made earlier by the example's end-to-end script. Shown as recorded, not re-run.</td>
                </tr>
                <tr>
                  <th scope="row">
                    <Badge kind="alpha">Not supported</Badge>
                  </th>
                  <td>Mainnet. 0.1.0-alpha has not been audited; do not use it to protect real value.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" aria-labelledby="start-title">
          <h2 id="start-title">A five-minute tour</h2>
          <ol className="stack" style={{ margin: 0, paddingLeft: '1.2em', gap: 10 }}>
            <li>
              <a href={hrefFor('compose')}>Compose</a> a delivery claim. A throwaway key signs it in this tab.
            </li>
            <li>
              Open it in <a href={hrefFor('verify')}>Verify</a>, set the time past <code>expires_at</code>, and watch
              step 3 fail with <code>ClaimExpired</code> (1103).
            </li>
            <li>
              Open it in <a href={hrefFor('inspect')}>Inspect</a>, flip one byte, and see the signature stop matching
              and the diff point at the field you changed.
            </li>
            <li>
              Run the <a href={hrefFor('vectors')}>test vectors</a>, then re-verify a real{' '}
              <a href={hrefFor('evidence')}>Testnet claim</a>.
            </li>
          </ol>
          <p className="muted small">
            When you are ready to build, the{' '}
            <a href={`${REPO_URL}#quickstart`} target="_blank" rel="noreferrer">
              quickstart
            </a>{' '}
            deploys the marketplace example to Testnet with throwaway keys.
          </p>
        </section>
      </div>
    </div>
  );
}
