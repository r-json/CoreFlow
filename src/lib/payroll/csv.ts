/**
 * Payroll CSV parsing and validation.
 *
 * Design rules:
 * 1. NEVER silently mutate input. A row that does not say what the uploader meant
 *    is an error they must see, not something to round, coerce or guess. Quietly
 *    "fixing" a payroll figure is the worst possible kind of helpfulness.
 * 2. Money is parsed from its decimal STRING into `bigint` base units. A JS
 *    `number` anywhere in this path reintroduces the stroops class of bug.
 * 3. Every rejection names the line and says what to do about it.
 * 4. Text that will ever be re-displayed or re-exported is treated as hostile
 *    input, not as data that happens to live in a file.
 */

import {
  parseAmount,
  formatAmount,
  hoursForAmount,
  MoneyParseError,
  SAC_DECIMALS,
} from '@/lib/money';

/** Hard limits. A payroll file is small; anything large is a mistake or an attack. */
export const MAX_CSV_BYTES = 1_000_000; // 1 MB
/** Matches the contract's MAX_BATCH_SIZE, so a file that validates is always settleable. */
export const MAX_ROWS = 100;
export const MAX_FIELD_LENGTH = 256;

export const REQUIRED_COLUMNS = ['recipient', 'amount', 'asset', 'hours', 'rate'] as const;
export const OPTIONAL_COLUMNS = ['period_start', 'period_end', 'reference'] as const;

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

/** Assets this deployment can settle. Anything else is refused, never assumed. */
export const SUPPORTED_ASSETS = ['USDC', 'XLM'] as const;
export type SupportedAsset = (typeof SUPPORTED_ASSETS)[number];

export type CsvIssueCode =
  | 'FILE_EMPTY'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'MISSING_COLUMN'
  | 'DUPLICATE_COLUMN'
  | 'FIELD_TOO_LONG'
  | 'WRONG_FIELD_COUNT'
  | 'INVALID_ADDRESS'
  | 'INVALID_AMOUNT'
  | 'AMOUNT_NOT_POSITIVE'
  | 'AMOUNT_PRECISION'
  | 'AMBIGUOUS_NUMBER'
  | 'INVALID_HOURS'
  | 'HOURS_RATE_MISMATCH'
  | 'FRACTIONAL_HOURS'
  | 'UNSUPPORTED_ASSET'
  | 'MIXED_ASSETS'
  | 'DUPLICATE_RECIPIENT'
  | 'INVALID_PERIOD'
  | 'NO_ROWS';

export interface CsvIssue {
  /** 1-based line number in the uploaded file, as the user sees it. 0 = whole file. */
  line: number;
  column?: string;
  /** What is wrong, in the uploader's terms. */
  message: string;
  /** Machine code, for tests and for grouping in the UI. */
  code: CsvIssueCode;
}

export interface ParsedPayrollRow {
  line: number;
  recipient: string;
  asset: SupportedAsset;
  /** Base units. Exact. */
  amountBaseUnits: bigint;
  rateBaseUnits: bigint;
  hours: bigint;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Free text from the uploader, already neutralized for re-display and re-export. */
  reference: string | null;
}

export interface CsvParseResult {
  rows: ParsedPayrollRow[];
  /** Blocking. Nothing is created while any of these stand. */
  issues: CsvIssue[];
  /** Non-blocking observations the uploader should still read. */
  warnings: CsvIssue[];
  totalsByAsset: Record<string, bigint>;
  /** Data rows seen in the file, including rejected ones. */
  rowCount: number;
}

// --- Sanitization -----------------------------------------------------------

/**
 * Neutralize spreadsheet formula injection.
 *
 * A field beginning `=`, `+`, `-`, `@`, tab or CR is executed as a formula when a
 * CSV is reopened in Excel, Sheets or Numbers. CoreFlow re-displays and can
 * re-export uploader-supplied text, so a crafted cell becomes code running inside
 * a finance team's spreadsheet. Prefixing an apostrophe is the standard
 * neutralization and preserves the visible value.
 *
 * Applied where text is STORED, so every later render and export inherits it
 * rather than each one having to remember.
 */
export function sanitizeForSpreadsheet(value: string): string {
  if (value.length === 0) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * Control characters that have no place in payroll text: everything below 0x20
 * except tab, newline and carriage return, plus DEL.
 *
 * Defined once, here, and reused by the request schemas. Two copies of a
 * character class eventually disagree, and the one that matters is whichever is
 * checked last.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** True when a value carries a control character. */
export function containsControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

/** Strip control characters that would corrupt logs, terminals or CSV exports. */
function stripControlChars(value: string): string {
  return value.replace(new RegExp(CONTROL_CHARS.source, 'g'), '');
}

// --- Parsing ----------------------------------------------------------------

/**
 * RFC 4180-ish CSV reader: quoted fields, escaped quotes, CRLF or LF.
 *
 * Hand-written rather than a dependency because the grammar is small, and a CSV
 * parser is the one place a supply-chain compromise would see every payroll file.
 */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let sawField = false;

  const endField = () => {
    row.push(field);
    field = '';
    sawField = false;
  };
  const endRow = () => {
    if (sawField || field.length > 0 || row.length > 0) {
      row.push(field);
      field = '';
    }
    if (row.length > 0) rows.push(row);
    row = [];
    sawField = false;
  };

  // Strip a UTF-8 BOM: Excel writes one, and it would corrupt the first header name.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      sawField = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\n') {
      endRow();
    } else if (c === '\r') {
      if (source[i + 1] === '\n') i++;
      endRow();
    } else {
      field += c;
      sawField = true;
    }
  }
  if (sawField || field.length > 0 || row.length > 0) endRow();

  // Drop wholly blank lines: trailing newlines are normal in hand-edited files.
  return rows.filter((r) => r.some((f) => f.trim().length > 0));
}

/**
 * Parse an amount string into base units, refusing anything ambiguous.
 *
 * Scientific notation is rejected rather than interpreted: `1e3` means 1000 to a
 * developer and is a typo to everybody else, and a payroll system must not pick.
 * Thousands separators ARE accepted, because spreadsheets emit them.
 */
function parseMoneyField(
  raw: string,
  line: number,
  column: string,
  issues: CsvIssue[],
): bigint | null {
  const value = raw.trim();
  if (value.length === 0) {
    issues.push({ line, column, code: 'INVALID_AMOUNT', message: `${column} is required.` });
    return null;
  }
  if (/[eE]/.test(value)) {
    issues.push({
      line,
      column,
      code: 'AMBIGUOUS_NUMBER',
      message:
        `${column} "${value}" uses scientific notation, which is ambiguous. ` +
        'Write the number out in full.',
    });
    return null;
  }
  if (value.startsWith('(') || value.endsWith(')')) {
    // Accounting-style negative, e.g. (500).
    issues.push({
      line,
      column,
      code: 'AMOUNT_NOT_POSITIVE',
      message: `${column} "${value}" reads as a negative amount. Payroll amounts must be positive.`,
    });
    return null;
  }

  // Strip presentation only: currency marks, spaces and an asset suffix.
  // Digits, the decimal point and the sign are left exactly as written.
  const cleaned = value.replace(/[$\s]|USDC|XLM/gi, '');
  try {
    const units = parseAmount(cleaned, SAC_DECIMALS);
    if (units <= 0n) {
      issues.push({
        line,
        column,
        code: 'AMOUNT_NOT_POSITIVE',
        message: `${column} must be greater than zero.`,
      });
      return null;
    }
    return units;
  } catch (e) {
    const precision = e instanceof MoneyParseError && /decimal place/i.test(e.message);
    issues.push({
      line,
      column,
      code: precision ? 'AMOUNT_PRECISION' : 'INVALID_AMOUNT',
      message:
        e instanceof MoneyParseError
          ? `${column}: ${e.message}`
          : `${column} "${value}" is not a valid amount.`,
    });
    return null;
  }
}

function parseDateField(
  raw: string,
  line: number,
  column: string,
  issues: CsvIssue[],
): Date | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  // ISO only. Locale forms like 03/04/2026 are genuinely ambiguous between March
  // and April, and guessing which pay period was meant is not acceptable.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    issues.push({
      line,
      column,
      code: 'INVALID_PERIOD',
      message: `${column} "${value}" must be a date in YYYY-MM-DD form.`,
    });
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || !date.toISOString().startsWith(value)) {
    issues.push({
      line,
      column,
      code: 'INVALID_PERIOD',
      message: `${column} "${value}" is not a real date.`,
    });
    return null;
  }
  return date;
}

export interface ParseOptions {
  /** Reject a recipient appearing twice. Default true: it is usually a paste slip. */
  rejectDuplicateRecipients?: boolean;
  /**
   * Asset codes this caller can actually settle, narrowing SUPPORTED_ASSETS.
   *
   * An escrow holds ONE Stellar Asset Contract, so a deployment configured for
   * USDC cannot pay an XLM row. Accepting such a row here would let it validate
   * and then fail at funding time, which is exactly the kind of late surprise
   * this layer exists to prevent. Defaults to every recognized code so the pure
   * parser stays testable without configuration.
   */
  supportedAssets?: readonly string[];
}

/**
 * Parse and validate a payroll CSV.
 *
 * Reports every issue found, not just the first: a finance user fixing a 40-row
 * file one error per upload is an unusable product.
 */
export function parsePayrollCsv(text: string, opts: ParseOptions = {}): CsvParseResult {
  const rejectDuplicates = opts.rejectDuplicateRecipients ?? true;
  const allowedAssets = (opts.supportedAssets ?? SUPPORTED_ASSETS).map((a) => a.toUpperCase());
  const issues: CsvIssue[] = [];
  const warnings: CsvIssue[] = [];
  const rows: ParsedPayrollRow[] = [];
  const totalsByAsset: Record<string, bigint> = {};

  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_CSV_BYTES) {
    return {
      rows: [],
      warnings,
      totalsByAsset,
      rowCount: 0,
      issues: [
        {
          line: 0,
          code: 'FILE_TOO_LARGE',
          message: `File is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_CSV_BYTES / 1024} KB.`,
        },
      ],
    };
  }

  const table = parseCsvText(text);
  if (table.length === 0) {
    return {
      rows: [],
      warnings,
      totalsByAsset,
      rowCount: 0,
      issues: [{ line: 0, code: 'FILE_EMPTY', message: 'The file is empty.' }],
    };
  }

  // --- Header ---
  const header = table[0].map((h) => stripControlChars(h).trim().toLowerCase());
  const seen = new Set<string>();
  for (const [i, col] of header.entries()) {
    if (col.length > 0 && seen.has(col)) {
      issues.push({
        line: 1,
        column: col,
        code: 'DUPLICATE_COLUMN',
        message: `Column "${col}" appears more than once (position ${i + 1}).`,
      });
    }
    seen.add(col);
  }

  const index: Record<string, number> = {};
  for (const col of [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]) {
    index[col] = header.indexOf(col);
  }
  for (const col of REQUIRED_COLUMNS) {
    if (index[col] < 0) {
      issues.push({
        line: 1,
        column: col,
        code: 'MISSING_COLUMN',
        message: `Required column "${col}" is missing. Expected: ${REQUIRED_COLUMNS.join(', ')}.`,
      });
    }
  }
  // Without the required columns there is nothing to validate against. Stop here so
  // the uploader fixes the structure instead of reading 40 derived row errors.
  if (issues.some((i) => i.code === 'MISSING_COLUMN')) {
    return { rows: [], issues, warnings, totalsByAsset, rowCount: 0 };
  }

  const dataRows = table.slice(1);
  if (dataRows.length === 0) {
    issues.push({
      line: 1,
      code: 'NO_ROWS',
      message: 'The file has a header but no payroll rows.',
    });
    return { rows: [], issues, warnings, totalsByAsset, rowCount: 0 };
  }
  if (dataRows.length > MAX_ROWS) {
    issues.push({
      line: 0,
      code: 'TOO_MANY_ROWS',
      message:
        `${dataRows.length} rows exceeds the ${MAX_ROWS}-row limit for one batch. ` +
        'Split the payroll into smaller batches.',
    });
    return { rows: [], issues, warnings, totalsByAsset, rowCount: dataRows.length };
  }

  const recipientLines = new Map<string, number>();

  for (const [n, raw] of dataRows.entries()) {
    const line = n + 2; // 1-based, accounting for the header row
    const cell = (col: string): string => {
      const i = index[col];
      const value = i >= 0 && i < raw.length ? raw[i] : '';
      return stripControlChars(value ?? '');
    };

    if (raw.length !== header.length) {
      warnings.push({
        line,
        code: 'WRONG_FIELD_COUNT',
        message:
          `Row has ${raw.length} fields but the header has ${header.length}. ` +
          'Any missing fields were read as empty.',
      });
    }

    let rowOk = true;
    const fail = () => {
      rowOk = false;
    };

    for (const col of [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]) {
      if (cell(col).length > MAX_FIELD_LENGTH) {
        issues.push({
          line,
          column: col,
          code: 'FIELD_TOO_LONG',
          message: `${col} is longer than ${MAX_FIELD_LENGTH} characters.`,
        });
        fail();
      }
    }

    // --- Recipient ---
    const recipient = cell('recipient').trim();
    if (!STELLAR_ADDRESS.test(recipient)) {
      issues.push({
        line,
        column: 'recipient',
        code: 'INVALID_ADDRESS',
        message:
          `"${recipient || '(empty)'}" is not a valid Stellar address. ` +
          'Expected 56 characters beginning with G.',
      });
      fail();
    } else if (rejectDuplicates && recipientLines.has(recipient)) {
      issues.push({
        line,
        column: 'recipient',
        code: 'DUPLICATE_RECIPIENT',
        message:
          `This recipient already appears on line ${recipientLines.get(recipient)}. ` +
          'Combine the rows, or remove the duplicate.',
      });
      fail();
    } else {
      recipientLines.set(recipient, line);
    }

    // --- Asset ---
    const assetRaw = cell('asset').trim().toUpperCase();
    const asset = allowedAssets.includes(assetRaw) ? (assetRaw as SupportedAsset) : null;
    if (asset === null) {
      issues.push({
        line,
        column: 'asset',
        code: 'UNSUPPORTED_ASSET',
        message:
          `Asset "${assetRaw || '(empty)'}" cannot be settled here. ` +
          `This deployment settles: ${allowedAssets.join(', ')}.`,
      });
      fail();
    }

    // --- Money ---
    const amount = parseMoneyField(cell('amount'), line, 'amount', issues);
    if (amount === null) fail();
    const rate = parseMoneyField(cell('rate'), line, 'rate', issues);
    if (rate === null) fail();

    // --- Hours ---
    const hoursRaw = cell('hours').trim();
    let hours: bigint | null = null;
    if (hoursRaw.length === 0) {
      issues.push({ line, column: 'hours', code: 'INVALID_HOURS', message: 'hours is required.' });
      fail();
    } else if (/[.,]/.test(hoursRaw)) {
      // v2 attests whole hours. Rounding here would change what the oracle signs
      // and what the contract checks, so it is refused with the reason stated.
      issues.push({
        line,
        column: 'hours',
        code: 'FRACTIONAL_HOURS',
        message:
          `hours "${hoursRaw}" is fractional. CoreFlow v2 records whole hours and ` +
          'will not round a payroll figure. Use whole hours, or split the row.',
      });
      fail();
    } else if (!/^\d+$/.test(hoursRaw)) {
      issues.push({
        line,
        column: 'hours',
        code: 'INVALID_HOURS',
        message: `hours "${hoursRaw}" is not a whole number.`,
      });
      fail();
    } else {
      hours = BigInt(hoursRaw);
      if (hours <= 0n) {
        issues.push({
          line,
          column: 'hours',
          code: 'INVALID_HOURS',
          message: 'hours must be greater than zero.',
        });
        fail();
      }
    }

    // --- The contract's invariant, checked before anything is funded ---
    // submit_hours_proof enforces hours * rate == amount on-chain (error #17).
    // Catching it here means a batch never reaches a wallet only to revert.
    if (amount !== null && rate !== null && hours !== null) {
      if (hours * rate !== amount) {
        const expected = formatAmount(hours * rate, SAC_DECIMALS);
        issues.push({
          line,
          code: 'HOURS_RATE_MISMATCH',
          message:
            `amount (${formatAmount(amount, SAC_DECIMALS)}) does not equal hours x rate ` +
            `(${hours} x ${formatAmount(rate, SAC_DECIMALS)} = ${expected}). ` +
            'CoreFlow settles only what the verified hours justify.',
        });
        fail();
      } else if (hoursForAmount(amount, rate) === null) {
        issues.push({
          line,
          code: 'HOURS_RATE_MISMATCH',
          message: 'amount is not a whole multiple of rate.',
        });
        fail();
      }
    }

    // --- Period ---
    const periodStart = parseDateField(cell('period_start'), line, 'period_start', issues);
    const periodEnd = parseDateField(cell('period_end'), line, 'period_end', issues);
    if (periodStart && periodEnd && periodEnd.getTime() <= periodStart.getTime()) {
      issues.push({
        line,
        code: 'INVALID_PERIOD',
        message: 'period_end must be after period_start.',
      });
      fail();
    }

    const reference = cell('reference').trim();

    if (!rowOk) continue;

    rows.push({
      line,
      recipient,
      asset: asset as SupportedAsset,
      amountBaseUnits: amount as bigint,
      rateBaseUnits: rate as bigint,
      hours: hours as bigint,
      periodStart,
      periodEnd,
      // Neutralized at the boundary, so every later render and export inherits it.
      reference: reference.length > 0 ? sanitizeForSpreadsheet(reference) : null,
    });

    const key = asset as SupportedAsset;
    totalsByAsset[key] = (totalsByAsset[key] ?? 0n) + (amount as bigint);
  }

  // A mixed-asset batch settles correctly but is usually an accident in a
  // hand-edited file, so it is surfaced rather than blocked.
  if (Object.keys(totalsByAsset).length > 1) {
    warnings.push({
      line: 0,
      code: 'MIXED_ASSETS',
      message:
        `This batch pays in ${Object.keys(totalsByAsset).join(' and ')}. ` +
        'That is supported, but confirm it is intended.',
    });
  }

  return { rows, issues, warnings, totalsByAsset, rowCount: dataRows.length };
}

/** Human-facing summary for the preview step. */
export function summarizeParse(result: CsvParseResult): {
  recipientCount: number;
  totalHours: bigint;
  totals: { asset: string; amount: string }[];
  hasBlockingIssues: boolean;
} {
  return {
    recipientCount: result.rows.length,
    totalHours: result.rows.reduce((sum, r) => sum + r.hours, 0n),
    totals: Object.entries(result.totalsByAsset).map(([asset, units]) => ({
      asset,
      amount: formatAmount(units, SAC_DECIMALS),
    })),
    hasBlockingIssues: result.issues.length > 0,
  };
}
