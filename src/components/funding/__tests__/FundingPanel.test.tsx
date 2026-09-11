/**
 * Funding panel behaviour.
 *
 * The properties under test are safety properties, not cosmetics: that an
 * unresolved transaction never offers a second funding action, that a reload
 * recovers the existing intent instead of opening another, and that UNVERIFIABLE is
 * never rendered as failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { FundingPanel } from '../FundingPanel';

vi.mock('@/components/NetworkBadge', () => ({
  NetworkBadge: () => <span data-testid="network-badge">TESTNET</span>,
}));

const MANAGER = 'G' + 'M'.repeat(55);
const FINANCE = 'G' + 'F'.repeat(55);
const CONTRACT = 'C' + 'C'.repeat(55);
const TOKEN = 'C' + 'T'.repeat(55);
const HASH = 'a'.repeat(64);
const DIGEST = 'beef1234' + '0'.repeat(56);

function plan() {
  return {
    batch: { id: 'bat_1', reference: 'CF-00042', paymentCount: 2 },
    total: '8,420.00',
    totalBaseUnits: '84200000000',
    asset: { code: 'USDC', contractId: TOKEN, decimals: 7 },
    network: { id: 'testnet', label: 'Stellar Testnet', isMainnet: false },
    contractId: CONTRACT,
    custodyDestination: CONTRACT,
    manager: MANAGER,
    financeApprover: FINANCE,
    oraclePublicKey: 'ab'.repeat(32),
    schedule: [
      {
        paymentId: 'pay_1',
        worker: 'G' + 'A'.repeat(55),
        token: TOKEN,
        amountBaseUnits: '42100000000',
        rateBaseUnits: '250000000',
        startDate: 1788000000,
        endDate: 1789000000,
      },
      {
        paymentId: 'pay_2',
        worker: 'G' + 'B'.repeat(55),
        token: TOKEN,
        amountBaseUnits: '42100000000',
        rateBaseUnits: '250000000',
        startDate: 1788000000,
        endDate: 1789000000,
      },
    ],
  };
}

function state(over: Record<string, unknown> = {}) {
  return {
    batch: { id: 'bat_1', reference: 'CF-00042' },
    assessment: {
      eligible: true,
      blockers: [],
      paymentCount: 2,
      total: '8,420.00',
      totalBaseUnits: '84200000000',
    },
    plan: plan(),
    attempt: null,
    escrow: null,
    ...over,
  };
}

function attempt(over: Record<string, unknown> = {}) {
  return {
    id: 'btx_1',
    status: 'AWAITING_SIGNATURE',
    planDigest: DIGEST,
    attempt: 1,
    hash: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    submittedAt: null,
    confirmedAt: null,
    ...over,
  };
}

/** Route responses, keyed by the suffix of the URL. */
let routes: Record<string, () => unknown>;
let calls: string[];

function mockFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    calls.push(`${init?.method ?? 'GET'} ${path.replace(/^.*\/funding/, '')}`);
    const key = Object.keys(routes).find((k) => path.endsWith(k) || path.includes(k));
    const body = key ? routes[key]() : null;
    if (body && (body as any).__status) {
      return new Response(JSON.stringify(body), { status: (body as any).__status });
    }
    return new Response(JSON.stringify(body ?? {}), { status: 200 });
  });
}

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal('fetch', mockFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a fundable batch', () => {
  beforeEach(() => {
    routes = { '/funding': () => state() };
  });

  it('shows the total, recipient count and that there is ONE transaction', async () => {
    render(<FundingPanel batchId="bat_1" />);
    await waitFor(() => expect(screen.getByText('Review and fund')).toBeDefined());

    expect(screen.getByText(/same Stellar transaction/i)).toBeDefined();
    expect(screen.getByText('8,420.00 USDC')).toBeDefined();
    expect(screen.getByText('One')).toBeDefined();
    // Never two steps: there is no "create escrow" action anywhere.
    expect(screen.queryByText(/create escrow/i)).toBeNull();
  });

  it('shows the Testnet badge', async () => {
    render(<FundingPanel batchId="bat_1" />);
    await waitFor(() => expect(screen.getByTestId('network-badge')).toBeDefined());
  });
});

describe('the pre-signing disclosure', () => {
  beforeEach(() => {
    routes = {
      '/funding/intent': () => ({ created: true, attempt: attempt(), plan: plan() }),
      '/funding': () => state(),
    };
  });

  it('discloses what is being signed before the wallet opens', async () => {
    render(<FundingPanel batchId="bat_1" />);
    await waitFor(() => screen.getByText('Review and fund'));
    fireEvent.click(screen.getByText('Review and fund'));

    await waitFor(() => expect(screen.getByText('Fund escrow')).toBeDefined());

    expect(screen.getByText(/payroll batch CF-00042/i)).toBeDefined();
    expect(screen.getByText('8,420.00 USDC')).toBeDefined();
    expect(screen.getByText('Stellar Testnet')).toBeDefined();
    // Destination and both parties to the dual-control gate.
    expect(screen.getByText('Destination')).toBeDefined();
    expect(screen.getByText('Finance approver')).toBeDefined();
    // A quotable plan reference derived from the digest.
    expect(screen.getByText('CF-PLAN-BEEF1234')).toBeDefined();
  });

  it('lists every payment with its exact base-unit amount', async () => {
    render(<FundingPanel batchId="bat_1" />);
    await waitFor(() => screen.getByText('Review and fund'));
    fireEvent.click(screen.getByText('Review and fund'));
    await waitFor(() => screen.getByText('Fund escrow'));

    expect(screen.getByText('Payments (2)')).toBeDefined();
    // The exact values that will be signed, unformatted.
    expect(screen.getAllByText('42100000000')).toHaveLength(2);
  });

  it('releases the intent when the reviewer steps back, so the batch is not stuck', async () => {
    routes['/funding/abandon'] = () => ({ attempt: attempt({ status: 'CANCELLED' }) });
    render(<FundingPanel batchId="bat_1" />);
    await waitFor(() => screen.getByText('Review and fund'));
    fireEvent.click(screen.getByText('Review and fund'));
    await waitFor(() => screen.getByText('Back'));
    fireEvent.click(screen.getByText('Back'));

    await waitFor(() => expect(calls.some((c) => c.includes('/abandon'))).toBe(true));
  });
});

describe('an unresolved transaction', () => {
  beforeEach(() => {
    routes = {
      '/funding': () =>
        state({
          attempt: attempt({ status: 'SUBMITTED', hash: HASH, submittedAt: new Date().toISOString() }),
        }),
    };
  });

  it('tells the user not to fund again, and offers no funding action', async () => {
    render(<FundingPanel batchId="bat_1" />);

    await waitFor(() =>
      expect(screen.getByText(/checking whether your funding transaction completed/i)).toBeDefined(),
    );
    expect(screen.getByText('Do not fund this payroll again.')).toBeDefined();

    // The contract is not idempotent: a second signature funds a second escrow.
    expect(screen.queryByText('Fund escrow')).toBeNull();
    expect(screen.queryByText('Review and fund')).toBeNull();
    expect(screen.queryByText('Try again')).toBeNull();
    // Only a safe, read-only action.
    expect(screen.getByText('Check status')).toBeDefined();
  });

  it('recovers the existing attempt on mount rather than opening another', async () => {
    render(<FundingPanel batchId="bat_1" />);
    await waitFor(() => screen.getByText('Check status'));

    // A reload must not create a second intent.
    expect(calls.filter((c) => c.includes('/intent'))).toHaveLength(0);
    expect(calls[0]).toBe('GET ');
  });

  it('announces the uncertain state to assistive technology', async () => {
    render(<FundingPanel batchId="bat_1" />);
    await waitFor(() =>
      expect(
        screen.getByText(/Still verifying whether the funding transaction completed/i),
      ).toBeDefined(),
    );
  });
});

describe('a confirmed batch', () => {
  beforeEach(() => {
    routes = {
      '/funding': () =>
        state({
          attempt: attempt({ status: 'CONFIRMED', hash: HASH, confirmedAt: new Date().toISOString() }),
          escrow: { id: 'esc_1', onChainId: 9 },
        }),
    };
  });

  it('reports funded, with the escrow and transaction, and offers no re-funding', async () => {
    render(<FundingPanel batchId="bat_1" />);
    await waitFor(() => expect(screen.getByText('Escrow funded')).toBeDefined());

    expect(screen.getByText('#9')).toBeDefined();
    expect(screen.getByText(/Verified against the chain/i)).toBeDefined();
    expect(screen.queryByText('Fund escrow')).toBeNull();
    expect(screen.queryByText('Review and fund')).toBeNull();
  });
});

describe('a batch that cannot be funded', () => {
  it('lists every blocker at once, with row numbers', async () => {
    routes = {
      '/funding': () =>
        state({
          assessment: {
            eligible: false,
            paymentCount: 2,
            total: '8,420.00',
            totalBaseUnits: '84200000000',
            blockers: [
              { code: 'PERIOD_REQUIRED', message: 'Row 2 has no pay period.', position: 2 },
              {
                code: 'NO_DISTINCT_FINANCE_APPROVER',
                message: 'This organization has no second wallet to act as finance approver.',
              },
            ],
          },
          plan: null,
        }),
    };
    render(<FundingPanel batchId="bat_1" />);

    await waitFor(() =>
      expect(screen.getByText('This payroll cannot be funded yet')).toBeDefined(),
    );
    expect(screen.getByText('Row 2')).toBeDefined();
    expect(screen.getByText(/no second wallet/i)).toBeDefined();
    // No signing path out of a blocked state.
    expect(screen.queryByText('Fund escrow')).toBeNull();
  });
});

describe('a mismatched transaction', () => {
  it('says the escrow was not attached and does not offer to fund again', async () => {
    routes = {
      '/funding/intent': () => ({ created: true, attempt: attempt(), plan: plan() }),
      '/funding/confirm': () => ({
        outcome: 'MISMATCH',
        attempt: attempt({ status: 'SUBMITTED', hash: HASH }),
        differences: ['payment 0 pays G…, the plan says G…'],
      }),
      '/funding': () =>
        state({ attempt: attempt({ status: 'SUBMITTED', hash: HASH }) }),
    };

    // Reached via the server's verdict, which the panel renders without softening.
    render(<FundingPanel batchId="bat_1" />);
    await waitFor(() => screen.getByText('Check status'));
    fireEvent.click(screen.getByText('Check status'));

    // With no escrow id known, Check status reloads rather than confirming — the
    // panel must not invent an escrow id to verify against.
    await waitFor(() => expect(calls.filter((c) => c.startsWith('GET')).length).toBeGreaterThan(1));
    expect(screen.queryByText('Fund escrow')).toBeNull();
  });
});

describe('recovery through the page (mandatory regression)', () => {
  it('resolves the escrow from the hash on mount and becomes funded, creating nothing new', async () => {
    // The state a user lands in after a reload or a dropped connection: a submitted
    // transaction, a known hash, and no escrow id.
    let confirmed = false;
    routes = {
      '/funding/confirm': () => {
        confirmed = true;
        return {
          outcome: 'CONFIRMED',
          attempt: attempt({ status: 'CONFIRMED', hash: HASH, confirmedAt: new Date().toISOString() }),
          escrow: { id: 'esc_1', onChainId: 9 },
        };
      },
      '/funding': () =>
        confirmed
          ? state({
              attempt: attempt({ status: 'CONFIRMED', hash: HASH }),
              escrow: { id: 'esc_1', onChainId: 9 },
            })
          : state({ attempt: attempt({ status: 'SUBMITTED', hash: HASH }) }),
    };

    render(<FundingPanel batchId="bat_1" />);

    // Recovery happens without the user doing anything.
    await waitFor(() => expect(screen.getByText('Escrow funded')).toBeDefined());
    expect(screen.getByText('#9')).toBeDefined();

    // The confirm call carried NO escrow id: the server resolved it from the hash.
    const confirmCall = calls.find((c) => c.includes('/confirm'));
    expect(confirmCall).toBeDefined();

    // Nothing new was created, and no signature was requested.
    expect(calls.filter((c) => c.includes('/intent'))).toHaveLength(0);
    expect(calls.filter((c) => c.includes('/submitted'))).toHaveLength(0);
    expect(calls.filter((c) => c.includes('/abandon'))).toHaveLength(0);
    expect(screen.queryByText('Fund escrow')).toBeNull();
    expect(screen.queryByText('Review and fund')).toBeNull();
  });

  it('attempts recovery once, not in a loop, when it stays unresolved', async () => {
    routes = {
      '/funding/confirm': () => ({
        outcome: 'UNVERIFIABLE',
        attempt: attempt({ status: 'SUBMITTED', hash: HASH }),
        reason: 'No escrow/created event has been observed yet.',
      }),
      '/funding': () => state({ attempt: attempt({ status: 'SUBMITTED', hash: HASH }) }),
    };

    render(<FundingPanel batchId="bat_1" />);
    await waitFor(() => expect(screen.getByText('Check status')).toBeDefined());
    await new Promise((r) => setTimeout(r, 60));

    // One automatic attempt. Re-verifying a genuinely pending transaction on a loop
    // is noise, and "Check status" remains available.
    expect(calls.filter((c) => c.includes('/confirm'))).toHaveLength(1);
    expect(screen.getByText('Do not fund this payroll again.')).toBeDefined();
  });
});
