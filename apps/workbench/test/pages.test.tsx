import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { HandoffProvider } from '../src/state';

async function openAt(route: string) {
  window.location.hash = route;
  const user = userEvent.setup();
  render(
    <HandoffProvider>
      <App />
    </HandoffProvider>,
  );
  return user;
}

/** Wait until the page whose title is `title` is shown. */
const page = (title: string) => screen.findByRole('heading', { level: 1, name: title });

describe('navigation', () => {
  it('marks the current page and moves between pages', async () => {
    const user = await openAt('#/');
    await page('CoreFlow Kit Workbench');
    const nav = screen.getByRole('navigation', { name: 'Workbench' });
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(nav).getByRole('link', { name: 'Error codes' }));
    await page('Error codes');
    expect(within(nav).getByRole('link', { name: 'Error codes' })).toHaveAttribute('aria-current', 'page');
  });

  it('falls back to the overview for an unknown route', async () => {
    await openAt('#/nope');
    await page('CoreFlow Kit Workbench');
  });
});

describe('Compose & sign', () => {
  it('signs the default claim with a throwaway key and passes the off-chain checks', async () => {
    await openAt('#/compose');
    await page('Compose & sign');
    expect(screen.getByText('Passes the off-chain checks now')).toBeInTheDocument();
    expect(screen.getByLabelText('Preimage (256 bytes)').textContent).toMatch(/^4346434c0001cee0 /);
    expect(screen.getByLabelText('Claim JSON').textContent).toContain('"claim_type": "461dc67f');
  });

  it('shows the contract error a zero lifetime would cause', async () => {
    const user = await openAt('#/compose');
    await page('Compose & sign');
    const lifetime = screen.getByLabelText('Valid for (seconds)');
    await user.clear(lifetime);
    await user.type(lifetime, '0');
    expect(await screen.findByText('Fails InvalidWindow')).toBeInTheDocument();
  });

  it('validates fields inline and never asks for a secret key', async () => {
    const user = await openAt('#/compose');
    await page('Compose & sign');
    const contract = screen.getByLabelText('Verifying contract ID');
    await user.clear(contract);
    await user.type(contract, 'CNOTACONTRACT');
    expect(contract).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByText(/Enter a valid contract address/).length).toBeGreaterThan(0);
    await user.click(screen.getByLabelText(/My own issuer/));
    expect(screen.getByLabelText('Issuer public key')).toBeInTheDocument();
    expect(screen.queryByLabelText(/secret/i)).toBeNull();
  });

  it('hands the signed claim to Verify, which passes it', async () => {
    const user = await openAt('#/compose');
    await page('Compose & sign');
    await user.click(screen.getByRole('button', { name: 'Open in Verify' }));
    await page('Verify');
    expect(screen.getByText('Loaded from Compose & sign')).toBeInTheDocument();
    expect(screen.getByText('Passes every check that can run off-chain')).toBeInTheDocument();
  });
});

describe('Verify', () => {
  it('stops an expired vector at step 3 with contract error 1103', async () => {
    const user = await openAt('#/verify');
    await page('Verify');
    await user.selectOptions(screen.getByLabelText('Load an example'), 'expired');
    await user.click(screen.getByRole('button', { name: 'Load' }));
    expect(await screen.findByText('Fails at step 3: ClaimExpired')).toBeInTheDocument();
    expect(screen.getByText(/On-chain this is error 1103/)).toBeInTheDocument();
  });

  it('reports a bad signature as an aborted transaction once re-run', async () => {
    const user = await openAt('#/verify');
    await page('Verify');
    const sig = screen.getByLabelText('Signature');
    const original = (sig as HTMLTextAreaElement).value;
    await user.clear(sig);
    await user.type(sig, `${original.slice(0, -2)}${original.endsWith('00') ? 'ff' : '00'}`);
    expect(screen.getByText(/Inputs changed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Fails at step 6: InvalidSignature')).toBeInTheDocument();
    expect(screen.getByText(/no error number: the host aborts the whole transaction/)).toBeInTheDocument();
  });

  it('points at the field when the claim JSON is malformed', async () => {
    const user = await openAt('#/verify');
    await page('Verify');
    const box = screen.getByLabelText('Claim JSON');
    await user.clear(box);
    await user.type(box, '{{"claimType": 1}');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Fix the input before it can be verified')).toBeInTheDocument();
    expect(box).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Inspect & diff', () => {
  it('shows a matching signature, then pinpoints a flipped bit', async () => {
    const user = await openAt('#/inspect');
    await page('Inspect & diff');
    expect(screen.getByText('The signature matches these bytes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Flip one bit in the subject' }));
    expect(await screen.findByText('The signature does not match these bytes')).toBeInTheDocument();
    expect(screen.getByText('1 field differ')).toBeInTheDocument();
    const differences = screen.getByRole('table', { name: 'Fields that differ between the two preimages' });
    expect(within(differences).getByText('subject')).toBeInTheDocument();
  });

  it('rejects input that is not 256 bytes', async () => {
    const user = await openAt('#/inspect');
    await page('Inspect & diff');
    const box = screen.getByLabelText('Preimage (hex)');
    await user.clear(box);
    await user.type(box, 'abcd');
    expect(screen.getByText(/must be 256 bytes/)).toBeInTheDocument();
  });
});

describe('reference pages', () => {
  it('runs all test vectors in the browser', async () => {
    await openAt('#/vectors');
    await page('Test vectors');
    expect(screen.getByRole('heading', { name: '16 of 16 vectors pass' })).toBeInTheDocument();
  });

  it('checks another implementation against a vector', async () => {
    const user = await openAt('#/vectors');
    await page('Test vectors');
    const theirs = screen.getByLabelText('Your preimage (hex)');
    await user.click(theirs);
    await user.paste('00'.repeat(256));
    expect(await screen.findByText(/Your preimage differs in \d+ fields/)).toBeInTheDocument();
  });

  it('looks up an error pasted from stellar-cli', async () => {
    const user = await openAt('#/errors');
    await page('Error codes');
    await user.click(screen.getByLabelText('Error text or code'));
    await user.paste('error: transaction simulation failed: HostError: Error(Contract, #1106)');
    expect(await screen.findByText('1106 ClaimAlreadyUsed')).toBeInTheDocument();
  });

  it('re-verifies each recorded Testnet run offline', async () => {
    await openAt('#/evidence');
    await page('Testnet evidence');
    expect(screen.getAllByText('Rebuilt preimage is byte-identical to the recorded one')).toHaveLength(3);
    expect(screen.getAllByText(/Signature verifies for this contract on Testnet/)).toHaveLength(3);
    expect(screen.getAllByText(/Refused with 1106 ClaimAlreadyUsed/)).toHaveLength(3);
  });
});

describe('theme', () => {
  it('applies and clears an explicit theme', async () => {
    const user = await openAt('#/');
    await page('CoreFlow Kit Workbench');
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(screen.getByRole('button', { name: 'System' }));
    await act(async () => {});
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
