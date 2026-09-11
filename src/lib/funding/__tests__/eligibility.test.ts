import { describe, it, expect } from 'vitest';
import { OrgRole, PaymentState } from '@prisma/client';
import {
  assessFundingEligibility,
  MAX_FUNDABLE_PAYMENTS,
  type EligibilityInput,
  type FundingPayment,
} from '../eligibility';

const ASSET = { code: 'USDC', contractId: 'CUSDC', decimals: 7 };

function wallet(tag: string): string {
  return ('G' + tag.toUpperCase().replace(/[^A-Z2-7]/g, '')).padEnd(56, 'A');
}

function payment(over: Partial<FundingPayment> = {}): FundingPayment {
  return {
    id: 'pay_1',
    recipientAddress: wallet('alice'),
    assetCode: 'USDC',
    assetContractId: 'CUSDC',
    assetDecimals: 7,
    amountBaseUnits: 10_000_000_000n,
    rateBaseUnits: 250_000_000n,
    hours: 40n,
    periodStart: new Date('2026-09-01T00:00:00Z'),
    periodEnd: new Date('2026-09-15T00:00:00Z'),
    state: PaymentState.DRAFT,
    escrowId: null,
    onChainPaymentIndex: null,
    ...over,
  };
}

function input(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    payments: [payment()],
    asset: ASSET,
    funder: { walletAddress: wallet('manager'), role: OrgRole.MANAGER },
    financeApproverAddress: wallet('finance'),
    attempt: null,
    oraclePublicKey: 'ab'.repeat(32),
    ...over,
  };
}

const codes = (r: ReturnType<typeof assessFundingEligibility>) => r.blockers.map((b) => b.code);

describe('a fundable batch', () => {
  it('is eligible and reports the exact total', () => {
    const result = assessFundingEligibility(
      input({ payments: [payment({ id: 'a' }), payment({ id: 'b', amountBaseUnits: 2_600_000_000n, rateBaseUnits: 130_000_000n, hours: 20n })] }),
    );
    expect(result.eligible).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.totalBaseUnits).toBe(12_600_000_000n);
    expect(result.paymentCount).toBe(2);
  });

  it('accepts a payment already moved to VALIDATING by an earlier attempt', () => {
    const result = assessFundingEligibility(
      input({ payments: [payment({ state: PaymentState.VALIDATING })] }),
    );
    expect(result.eligible).toBe(true);
  });

  it.each([[OrgRole.OWNER], [OrgRole.ADMIN], [OrgRole.MANAGER]])(
    'allows %s to fund',
    (role) => {
      const result = assessFundingEligibility(input({ funder: { walletAddress: wallet('m'), role } }));
      expect(result.eligible).toBe(true);
    },
  );
});

describe('who may fund', () => {
  it.each([[OrgRole.FINANCE], [OrgRole.WORKER], [OrgRole.VIEWER]])(
    'refuses %s',
    (role) => {
      const result = assessFundingEligibility(input({ funder: { walletAddress: wallet('x'), role } }));
      expect(codes(result)).toContain('ROLE_NOT_PERMITTED');
    },
  );
});

describe('double-funding', () => {
  it('refuses a batch already funded', () => {
    const result = assessFundingEligibility(
      input({
        attempt: { id: 't1', status: 'CONFIRMED', hash: 'f'.repeat(64), createdAt: new Date() },
      }),
    );
    expect(codes(result)).toContain('ALREADY_FUNDED');
    // The reason matters: a second escrow would move the money a second time.
    expect(result.blockers[0].message).toContain('second time');
  });

  it.each([['PREPARING'], ['SIMULATING'], ['AWAITING_SIGNATURE'], ['SUBMITTED']] as const)(
    'refuses while an attempt is %s',
    (status) => {
      const result = assessFundingEligibility(
        input({ attempt: { id: 't1', status, hash: null, createdAt: new Date() } }),
      );
      expect(codes(result)).toContain('FUNDING_IN_FLIGHT');
    },
  );

  it.each([['FAILED'], ['CANCELLED'], ['EXPIRED']] as const)(
    'allows a retry after a %s attempt',
    (status) => {
      const result = assessFundingEligibility(
        input({ attempt: { id: 't1', status, hash: null, createdAt: new Date() } }),
      );
      expect(result.eligible).toBe(true);
    },
  );

  it('refuses a payment already attached to an escrow', () => {
    const result = assessFundingEligibility(
      input({ payments: [payment({ escrowId: 'esc_1', onChainPaymentIndex: 0 })] }),
    );
    expect(codes(result)).toContain('PAYMENT_ALREADY_ON_CHAIN');
  });
});

describe('the contract preconditions', () => {
  it('refuses a payment with no pay period, and will not invent one', () => {
    const result = assessFundingEligibility(
      input({ payments: [payment({ periodStart: null, periodEnd: null })] }),
    );
    const blocker = result.blockers.find((b) => b.code === 'PERIOD_REQUIRED');
    expect(blocker).toBeDefined();
    // The period is a signed field of the oracle proof, so assuming it would mean
    // attesting to a pay period nobody stated.
    expect(blocker!.message).toContain('part of what the oracle signs');
  });

  it('refuses a period that does not end after it starts', () => {
    const result = assessFundingEligibility(
      input({
        payments: [
          payment({
            periodStart: new Date('2026-09-15T00:00:00Z'),
            periodEnd: new Date('2026-09-01T00:00:00Z'),
          }),
        ],
      }),
    );
    expect(codes(result)).toContain('PERIOD_INVALID');
  });

  it('refuses amount that is not hours x rate', () => {
    const result = assessFundingEligibility(
      input({ payments: [payment({ amountBaseUnits: 9_999_999_999n })] }),
    );
    const blocker = result.blockers.find((b) => b.code === 'HOURS_RATE_MISMATCH');
    expect(blocker).toBeDefined();
    expect(blocker!.position).toBe(1);
  });

  it.each([
    ['zero amount', { amountBaseUnits: 0n }],
    ['zero hours', { hours: 0n }],
    ['zero rate', { rateBaseUnits: 0n }],
  ])('refuses %s', (_label, over) => {
    const result = assessFundingEligibility(input({ payments: [payment(over)] }));
    expect(codes(result)).toContain('AMOUNT_NOT_POSITIVE');
  });

  it('refuses more payments than the contract accepts in one escrow', () => {
    const payments = Array.from({ length: MAX_FUNDABLE_PAYMENTS + 1 }, (_, i) =>
      payment({ id: `p${i}` }),
    );
    const result = assessFundingEligibility(input({ payments }));
    expect(codes(result)).toContain('TOO_MANY_PAYMENTS');
  });

  it('accepts exactly the contract limit', () => {
    const payments = Array.from({ length: MAX_FUNDABLE_PAYMENTS }, (_, i) => payment({ id: `p${i}` }));
    expect(assessFundingEligibility(input({ payments })).eligible).toBe(true);
  });
});

describe('dual control, checked before a wallet opens', () => {
  it('refuses when the organization has no second approver', () => {
    const result = assessFundingEligibility(input({ financeApproverAddress: null }));
    expect(codes(result)).toContain('NO_DISTINCT_FINANCE_APPROVER');
  });

  it('refuses when the funder would also be the finance approver', () => {
    const same = wallet('manager');
    const result = assessFundingEligibility(
      input({ funder: { walletAddress: same, role: OrgRole.MANAGER }, financeApproverAddress: same }),
    );
    const blocker = result.blockers.find((b) => b.code === 'NO_DISTINCT_FINANCE_APPROVER');
    // The contract refuses this too; catching it here gives a readable reason
    // instead of a trapped transaction after the money has been committed.
    expect(blocker!.message).toContain('SignersNotDistinct');
  });
});

describe('the settlement asset', () => {
  it('refuses when no SAC is configured', () => {
    const result = assessFundingEligibility(input({ asset: { ...ASSET, contractId: null } }));
    const blocker = result.blockers.find((b) => b.code === 'SETTLEMENT_ASSET_UNCONFIGURED');
    expect(blocker!.message).toContain('will not infer');
  });

  it('refuses a payment denominated in another asset', () => {
    const result = assessFundingEligibility(
      input({ payments: [payment({ assetCode: 'EURC' })] }),
    );
    expect(codes(result)).toContain('ASSET_MISMATCH');
  });

  it('refuses a batch mixing assets, because one escrow holds one asset', () => {
    const result = assessFundingEligibility(
      input({ payments: [payment({ id: 'a' }), payment({ id: 'b', assetCode: 'XLM' })] }),
    );
    expect(codes(result)).toContain('MIXED_ASSETS');
  });
});

describe('the oracle', () => {
  it('refuses when no oracle key is available', () => {
    const result = assessFundingEligibility(input({ oraclePublicKey: null }));
    const blocker = result.blockers.find((b) => b.code === 'ORACLE_KEY_UNAVAILABLE');
    // Funding an escrow whose work can never be verified creates custody that can
    // never be released.
    expect(blocker!.message).toContain('never settle');
  });
});

describe('reporting', () => {
  it('reports every blocker at once, not just the first', () => {
    const result = assessFundingEligibility(
      input({
        payments: [
          payment({ id: 'a', periodStart: null, periodEnd: null }),
          payment({ id: 'b', amountBaseUnits: 1n }),
          payment({ id: 'c', state: PaymentState.PAID }),
        ],
        financeApproverAddress: null,
        oraclePublicKey: null,
      }),
    );
    expect(result.eligible).toBe(false);
    const found = new Set(codes(result));
    for (const expected of [
      'PERIOD_REQUIRED',
      'HOURS_RATE_MISMATCH',
      'PAYMENT_NOT_FUNDABLE',
      'NO_DISTINCT_FINANCE_APPROVER',
      'ORACLE_KEY_UNAVAILABLE',
    ]) {
      expect(found).toContain(expected);
    }
  });

  it('names the row a payment blocker came from', () => {
    const result = assessFundingEligibility(
      input({ payments: [payment({ id: 'a' }), payment({ id: 'b', hours: 0n })] }),
    );
    const blocker = result.blockers.find((b) => b.code === 'AMOUNT_NOT_POSITIVE');
    expect(blocker!.position).toBe(2);
    expect(blocker!.paymentId).toBe('b');
  });

  it('refuses an empty batch', () => {
    expect(codes(assessFundingEligibility(input({ payments: [] })))).toContain('NO_PAYMENTS');
  });
});
