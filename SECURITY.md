# Security policy

## Supported versions

| Version | Status |
|---|---|
| 0.1.0-alpha | Supported for Testnet use. **Not audited.** Do not use it to protect real value. |

The CoreFlow Kit packages (`packages/attest`, `packages/sdk`,
`packages/test-vectors`) and `examples/marketplace-hold` are in scope, as are
the claim format specification and the security model in `docs/kit/`.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability
reporting: open the repository's **Security** tab and choose **Report a
vulnerability**. Do not open a public issue, pull request or discussion for a
suspected vulnerability.

A useful report includes:

- the affected package and version (or commit);
- what an attacker can do, and under which assumptions (for example, which keys they hold);
- steps or a test that reproduces it — a failing `cargo test` or Vitest case is ideal.

You will get an acknowledgement on the report, a fix or mitigation plan once
the issue is confirmed, and credit in the release notes if you want it.

## Scope notes

- The kit verifies that a claim was signed by a registered issuer and has not
  been replayed or expired. It does not vouch for the truth of a claim, and it
  does not authorize issuer-registry changes on its own — the host contract
  does. See [docs/kit/security-model.md](docs/kit/security-model.md) for the
  full threat model before reporting a design limitation as a vulnerability.
- Test keys in `packages/test-vectors` and the `testutils` feature are public
  by design and are not a vulnerability.
