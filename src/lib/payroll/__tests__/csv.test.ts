import { describe, it, expect } from 'vitest';
import {
  parsePayrollCsv,
  parseCsvText,
  sanitizeForSpreadsheet,
  summarizeParse,
  MAX_ROWS,
  MAX_CSV_BYTES,
  MAX_FIELD_LENGTH,
  type CsvIssueCode,
} from '../csv';

/**
 * Build a syntactically valid Stellar address (56 chars, base32 alphabet) with a
 * recognizable tag, so a failing assertion names which recipient it meant.
 */
function addr(tag: string): string {
  const body = tag.toUpperCase().replace(/[^A-Z2-7]/g, '');
  return ('G' + body).padEnd(56, 'A');
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Distinct address for bulk fixtures. Fixed-width base32 so two indices can never
 * encode to the same padded address - addr() alone collides, because it strips the
 * digits 0, 1, 8 and 9 that are absent from the base32 alphabet.
 */
function addrN(n: number): string {
  const body = BASE32[Math.floor(n / 32) % 32] + BASE32[n % 32];
  return ('G' + body).padEnd(56, 'A');
}

const HEADER = 'recipient,amount,asset,hours,rate';

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

/** Issue codes present, for concise assertions. */
function codes(issues: { code: CsvIssueCode }[]): CsvIssueCode[] {
  return issues.map((i) => i.code);
}

describe('parseCsvText', () => {
  it('parses quoted fields containing commas, quotes and newlines', () => {
    const table = parseCsvText('a,b\n"x,1","he said ""hi"""\n"multi\nline",2');
    expect(table).toEqual([
      ['a', 'b'],
      ['x,1', 'he said "hi"'],
      ['multi\nline', '2'],
    ]);
  });

  it('accepts CRLF and a trailing newline without inventing a row', () => {
    expect(parseCsvText('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips a UTF-8 BOM so the first header name stays usable', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(parseCsvText(bom + 'recipient,amount\nx,1')[0][0]).toBe('recipient');
  });

  it('preserves empty trailing fields', () => {
    expect(parseCsvText('a,b,c\n1,,')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
    ]);
  });
});

describe('sanitizeForSpreadsheet', () => {
  it.each(['=SUM(A1:A9)', '+1+1', '-2+3', '@SUM(1)'])(
    'neutralizes the formula trigger in %s',
    (value) => {
      expect(sanitizeForSpreadsheet(value)).toBe(`'${value}`);
    },
  );

  it('neutralizes tab- and CR-prefixed payloads', () => {
    const tab = String.fromCharCode(9);
    const cr = String.fromCharCode(13);
    expect(sanitizeForSpreadsheet(tab + '=cmd')).toBe("'" + tab + '=cmd');
    expect(sanitizeForSpreadsheet(cr + '=cmd')).toBe("'" + cr + '=cmd');
  });

  it('leaves ordinary text and the empty string untouched', () => {
    expect(sanitizeForSpreadsheet('March sprint')).toBe('March sprint');
    expect(sanitizeForSpreadsheet('')).toBe('');
  });
});

describe('parsePayrollCsv - golden path', () => {
  it('produces one exact row per CSV line', () => {
    const result = parsePayrollCsv(
      csv(
        `${addr('alice')},1000.0000000,USDC,40,25`,
        `${addr('bob')},1600,USDC,80,20`,
        `${addr('carol')},260,USDC,20,13`,
      ),
    );

    expect(result.issues).toEqual([]);
    expect(result.rowCount).toBe(3);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r) => r.line)).toEqual([2, 3, 4]);
    expect(result.rows[0].amountBaseUnits).toBe(10_000_000_000n);
    expect(result.rows[0].rateBaseUnits).toBe(250_000_000n);
    expect(result.rows[0].hours).toBe(40n);
    expect(result.totalsByAsset).toEqual({ USDC: 28_600_000_000n });
  });

  it('keeps the smallest representable unit exactly', () => {
    const result = parsePayrollCsv(
      csv(`${addr('dust')},0.0000001,USDC,1,0.0000001`),
    );
    expect(result.issues).toEqual([]);
    expect(result.rows[0].amountBaseUnits).toBe(1n);
  });

  it('accepts spreadsheet presentation: thousands separators, currency, asset suffix', () => {
    const result = parsePayrollCsv(
      csv(`${addr('pres')},"$1,250.00 USDC",USDC,50,25`),
    );
    expect(result.issues).toEqual([]);
    expect(result.rows[0].amountBaseUnits).toBe(12_500_000_000n);
  });

  it('reads optional columns and parses ISO periods as UTC', () => {
    const result = parsePayrollCsv(
      'recipient,amount,asset,hours,rate,period_start,period_end,reference\n' +
        `${addr('opt')},400,USDC,20,20,2026-09-01,2026-09-15,Sprint 14`,
    );
    expect(result.issues).toEqual([]);
    expect(result.rows[0].periodStart?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(result.rows[0].periodEnd?.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(result.rows[0].reference).toBe('Sprint 14');
  });

  it('is case-insensitive about headers and asset codes', () => {
    const result = parsePayrollCsv(
      'Recipient,Amount,ASSET,Hours,Rate\n' + `${addr('case')},100,usdc,10,10`,
    );
    expect(result.issues).toEqual([]);
    expect(result.rows[0].asset).toBe('USDC');
  });
});

describe('parsePayrollCsv - file-level limits', () => {
  it('rejects an empty file', () => {
    expect(codes(parsePayrollCsv('').issues)).toEqual(['FILE_EMPTY']);
    expect(codes(parsePayrollCsv('\n\n  \n').issues)).toEqual(['FILE_EMPTY']);
  });

  it('rejects a header with no payroll rows', () => {
    expect(codes(parsePayrollCsv(HEADER).issues)).toEqual(['NO_ROWS']);
  });

  it('rejects an oversized file before parsing it', () => {
    const big = HEADER + '\n' + 'x'.repeat(MAX_CSV_BYTES + 1);
    const result = parsePayrollCsv(big);
    expect(codes(result.issues)).toEqual(['FILE_TOO_LARGE']);
    expect(result.rows).toEqual([]);
  });

  it('rejects more rows than one batch can settle', () => {
    const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) =>
      `${addrN(i)},100,USDC,10,10`,
    );
    const result = parsePayrollCsv(csv(...rows));
    expect(codes(result.issues)).toEqual(['TOO_MANY_ROWS']);
    expect(result.rowCount).toBe(MAX_ROWS + 1);
    expect(result.rows).toEqual([]);
  });

  it('accepts exactly the row limit', () => {
    const rows = Array.from({ length: MAX_ROWS }, (_, i) =>
      `${addrN(i)},100,USDC,10,10`,
    );
    const result = parsePayrollCsv(csv(...rows));
    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(MAX_ROWS);
  });

  it('rejects an over-long field', () => {
    const result = parsePayrollCsv(
      'recipient,amount,asset,hours,rate,reference\n' +
        `${addr('long')},100,USDC,10,10,${'a'.repeat(MAX_FIELD_LENGTH + 1)}`,
    );
    expect(codes(result.issues)).toContain('FIELD_TOO_LONG');
    expect(result.rows).toEqual([]);
  });
});

describe('parsePayrollCsv - header validation', () => {
  it('names every missing required column and stops before row errors', () => {
    const result = parsePayrollCsv('recipient,amount\nGXXX,nonsense');
    expect(codes(result.issues).sort()).toEqual([
      'MISSING_COLUMN',
      'MISSING_COLUMN',
      'MISSING_COLUMN',
    ]);
    expect(result.issues.every((i) => i.line === 1)).toBe(true);
    expect(result.rows).toEqual([]);
  });

  it('flags a duplicated column instead of silently picking one', () => {
    const result = parsePayrollCsv(
      'recipient,amount,asset,hours,rate,amount\n' + `${addr('dup')},100,USDC,10,10,999`,
    );
    expect(codes(result.issues)).toContain('DUPLICATE_COLUMN');
  });

  it('warns when a row has a different field count than the header', () => {
    const result = parsePayrollCsv(csv(`${addr('short')},100,USDC,10`));
    expect(codes(result.warnings)).toContain('WRONG_FIELD_COUNT');
  });
});

describe('parsePayrollCsv - recipient validation', () => {
  it.each([
    ['empty', ''],
    ['too short', 'GABC'],
    ['wrong prefix', 'S'.padEnd(56, 'A')],
    ['lowercase', addr('alice').toLowerCase()],
    ['invalid base32 digits (0, 1, 8, 9)', 'G' + '0189'.padEnd(55, 'A')],
    ['57 characters', addr('alice') + 'A'],
  ])('rejects an address that is %s', (_label, recipient) => {
    const result = parsePayrollCsv(csv(`${recipient},100,USDC,10,10`));
    expect(codes(result.issues)).toContain('INVALID_ADDRESS');
    expect(result.rows).toEqual([]);
  });

  it('rejects a duplicate recipient and points at the first occurrence', () => {
    const a = addr('alice');
    const result = parsePayrollCsv(
      csv(`${a},100,USDC,10,10`, `${addr('bob')},100,USDC,10,10`, `${a},200,USDC,20,10`),
    );
    const dup = result.issues.find((i) => i.code === 'DUPLICATE_RECIPIENT');
    expect(dup?.line).toBe(4);
    expect(dup?.message).toContain('line 2');
    // The first two rows are still usable; only the duplicate is dropped.
    expect(result.rows).toHaveLength(2);
  });

  it('allows a repeated recipient when the caller opts in', () => {
    const a = addr('alice');
    const result = parsePayrollCsv(csv(`${a},100,USDC,10,10`, `${a},200,USDC,20,10`), {
      rejectDuplicateRecipients: false,
    });
    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.totalsByAsset.USDC).toBe(3_000_000_000n);
  });
});

describe('parsePayrollCsv - money validation', () => {
  it.each(['1e3', '1E3', '2.5e-2'])('rejects scientific notation %s rather than guessing', (amount) => {
    const result = parsePayrollCsv(csv(`${addr('sci')},${amount},USDC,10,10`));
    expect(codes(result.issues)).toContain('AMBIGUOUS_NUMBER');
    expect(result.rows).toEqual([]);
  });

  it.each(['0', '0.0000000'])('rejects a zero amount (%s)', (amount) => {
    const result = parsePayrollCsv(csv(`${addr('zero')},${amount},USDC,10,10`));
    expect(codes(result.issues)).toContain('AMOUNT_NOT_POSITIVE');
  });

  it('rejects a negative amount', () => {
    const result = parsePayrollCsv(csv(`${addr('neg')},-100,USDC,10,10`));
    expect(codes(result.issues)).toContain('AMOUNT_NOT_POSITIVE');
  });

  it('rejects an accounting-style negative', () => {
    const result = parsePayrollCsv(csv(`${addr('acct')},(100),USDC,10,10`));
    expect(codes(result.issues)).toContain('AMOUNT_NOT_POSITIVE');
  });

  it('rejects more precision than the asset can hold, instead of truncating', () => {
    const result = parsePayrollCsv(csv(`${addr('prec')},1.00000001,USDC,1,1`));
    expect(codes(result.issues)).toContain('AMOUNT_PRECISION');
    expect(result.rows).toEqual([]);
  });

  it.each(['abc', '1.2.3', '--5', '1/2', ''])('rejects the malformed amount "%s"', (amount) => {
    const result = parsePayrollCsv(csv(`${addr('bad')},${amount},USDC,10,10`));
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.rows).toEqual([]);
  });

  it('validates the rate with the same rules as the amount', () => {
    const result = parsePayrollCsv(csv(`${addr('rate')},100,USDC,10,1e1`));
    const issue = result.issues.find((i) => i.code === 'AMBIGUOUS_NUMBER');
    expect(issue?.column).toBe('rate');
  });
});

describe('parsePayrollCsv - hours and the on-chain invariant', () => {
  it('rejects fractional hours and explains why, rather than rounding', () => {
    const result = parsePayrollCsv(csv(`${addr('frac')},100,USDC,7.5,13.3333333`));
    const issue = result.issues.find((i) => i.code === 'FRACTIONAL_HOURS');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('will not round');
    expect(result.rows).toEqual([]);
  });

  it.each(['0', '-5', 'forty', ''])('rejects the hours value "%s"', (hours) => {
    const result = parsePayrollCsv(csv(`${addr('h')},100,USDC,${hours},10`));
    expect(codes(result.issues)).toContain('INVALID_HOURS');
  });

  it('rejects a row where amount does not equal hours x rate', () => {
    const result = parsePayrollCsv(csv(`${addr('mix')},1000,USDC,40,20`));
    const issue = result.issues.find((i) => i.code === 'HOURS_RATE_MISMATCH');
    expect(issue).toBeDefined();
    // The message must show the arithmetic the contract will perform.
    expect(issue?.message).toContain('800');
    expect(result.rows).toEqual([]);
  });

  it('accepts a row where the invariant holds exactly at 7 decimals', () => {
    const result = parsePayrollCsv(csv(`${addr('exact')},0.0000030,USDC,3,0.0000010`));
    expect(result.issues).toEqual([]);
    expect(result.rows[0].amountBaseUnits).toBe(30n);
  });
});

describe('parsePayrollCsv - asset validation', () => {
  it.each(['BTC', 'EURC', '', 'USD'])('rejects the unsupported asset "%s"', (asset) => {
    const result = parsePayrollCsv(csv(`${addr('asset')},100,${asset},10,10`));
    expect(codes(result.issues)).toContain('UNSUPPORTED_ASSET');
    expect(result.rows).toEqual([]);
  });

  it('honours a narrowed asset list, so an unsettleable code is refused', () => {
    const result = parsePayrollCsv(csv(`${addr('x')},100,XLM,10,10`), {
      supportedAssets: ['USDC'],
    });
    expect(codes(result.issues)).toContain('UNSUPPORTED_ASSET');
    expect(result.issues[0].message).toContain('settles: USDC');
  });

  it('warns, but does not block, when one batch mixes supported assets', () => {
    const result = parsePayrollCsv(
      csv(`${addr('a')},100,USDC,10,10`, `${addr('b')},50,XLM,5,10`),
    );
    expect(result.issues).toEqual([]);
    expect(codes(result.warnings)).toContain('MIXED_ASSETS');
    expect(result.totalsByAsset).toEqual({ USDC: 1_000_000_000n, XLM: 500_000_000n });
  });
});

describe('parsePayrollCsv - period validation', () => {
  it.each(['03/04/2026', '2026/09/01', 'Sept 1 2026', '2026-9-1'])(
    'rejects the ambiguous or non-ISO date "%s"',
    (date) => {
      const result = parsePayrollCsv(
        'recipient,amount,asset,hours,rate,period_start\n' +
          `${addr('d')},100,USDC,10,10,${date}`,
      );
      expect(codes(result.issues)).toContain('INVALID_PERIOD');
    },
  );

  it('rejects a date that is well-formed but not real', () => {
    const result = parsePayrollCsv(
      'recipient,amount,asset,hours,rate,period_start\n' +
        `${addr('d')},100,USDC,10,10,2026-02-30`,
    );
    expect(codes(result.issues)).toContain('INVALID_PERIOD');
  });

  it('rejects a period that ends before it starts', () => {
    const result = parsePayrollCsv(
      'recipient,amount,asset,hours,rate,period_start,period_end\n' +
        `${addr('d')},100,USDC,10,10,2026-09-15,2026-09-01`,
    );
    expect(codes(result.issues)).toContain('INVALID_PERIOD');
    expect(result.rows).toEqual([]);
  });

  it('treats absent periods as absent, not as an error', () => {
    const result = parsePayrollCsv(
      'recipient,amount,asset,hours,rate,period_start,period_end\n' +
        `${addr('d')},100,USDC,10,10,,`,
    );
    expect(result.issues).toEqual([]);
    expect(result.rows[0].periodStart).toBeNull();
    expect(result.rows[0].periodEnd).toBeNull();
  });
});

describe('parsePayrollCsv - hostile input', () => {
  it('neutralizes a formula in a reference before it is ever stored', () => {
    const result = parsePayrollCsv(
      'recipient,amount,asset,hours,rate,reference\n' +
        `${addr('inj')},100,USDC,10,10,"=HYPERLINK(""http://evil"",""click"")"`,
    );
    expect(result.issues).toEqual([]);
    expect(result.rows[0].reference?.startsWith("'=")).toBe(true);
  });

  it('strips control characters from fields', () => {
    const nul = String.fromCharCode(0);
    const bell = String.fromCharCode(7);
    const esc = String.fromCharCode(27);
    const result = parsePayrollCsv(
      'recipient,amount,asset,hours,rate,reference\n' +
        `${addr('ctrl')},100,USDC,10,10,"Sprint${nul}${bell}${esc}14"`,
    );
    expect(result.issues).toEqual([]);
    expect(result.rows[0].reference).toBe('Sprint14');
  });

  it('strips control characters from a header name so the column still resolves', () => {
    const bell = String.fromCharCode(7);
    const result = parsePayrollCsv(
      `recipient${bell},amount,asset,hours,rate\n` + `${addr('hdr')},100,USDC,10,10`,
    );
    expect(codes(result.issues)).not.toContain('MISSING_COLUMN');
  });

  it('does not let an injected field smuggle a valid address past validation', () => {
    const result = parsePayrollCsv(csv(`"=cmd|' /C calc'!A0",100,USDC,10,10`));
    expect(codes(result.issues)).toContain('INVALID_ADDRESS');
    expect(result.rows).toEqual([]);
  });
});

describe('parsePayrollCsv - reporting', () => {
  it('reports every bad row in one pass, not just the first', () => {
    const result = parsePayrollCsv(
      csv(
        `${addr('ok')},100,USDC,10,10`,
        'BADADDRESS,100,USDC,10,10',
        `${addr('b')},1e3,USDC,10,10`,
        `${addr('c')},100,BTC,10,10`,
        `${addr('d')},100,USDC,7.5,10`,
      ),
    );
    expect(codes(result.issues).sort()).toEqual([
      'AMBIGUOUS_NUMBER',
      'FRACTIONAL_HOURS',
      'INVALID_ADDRESS',
      'UNSUPPORTED_ASSET',
    ]);
    // Valid rows survive so the uploader can see what did parse.
    expect(result.rows).toHaveLength(1);
    expect(result.rowCount).toBe(5);
  });

  it('anchors every issue to the line the uploader sees', () => {
    const result = parsePayrollCsv(csv(`${addr('ok')},100,USDC,10,10`, 'BAD,100,USDC,10,10'));
    expect(result.issues[0].line).toBe(3);
  });

  it('summarizes a clean batch without using floating point', () => {
    const summary = summarizeParse(
      parsePayrollCsv(
        csv(`${addr('a')},1000,USDC,40,25`, `${addr('b')},1600,USDC,80,20`),
      ),
    );
    expect(summary.recipientCount).toBe(2);
    expect(summary.totalHours).toBe(120n);
    expect(summary.totals).toEqual([{ asset: 'USDC', amount: '2600.00' }]);
    expect(summary.hasBlockingIssues).toBe(false);
  });

  it('flags blocking issues in the summary', () => {
    const summary = summarizeParse(parsePayrollCsv(csv('BAD,100,USDC,10,10')));
    expect(summary.hasBlockingIssues).toBe(true);
    expect(summary.recipientCount).toBe(0);
  });
});
