/**
 * In-memory stand-in for the Prisma client, covering the subset the payment
 * domain uses.
 *
 * Why a fake rather than mocks: the properties under test are about CONSTRAINTS
 * and SEQUENCE — that replaying an event cannot create a second payment, that a
 * compare-and-swap loses a race safely. `vi.fn()` returning canned values proves
 * none of that. This fake enforces the unique constraints that carry the
 * idempotency guarantees, so a test can actually observe them being relied upon.
 *
 * It is deliberately small and explicit. Anything it does not implement throws,
 * so a call site that starts depending on new behaviour fails loudly here instead
 * of passing against a silently permissive double.
 */

interface Row {
  [k: string]: any;
}

class Table {
  rows: Row[] = [];
  private seq = 0;

  constructor(
    readonly name: string,
    /** Unique constraints, each a list of column names. */
    readonly uniques: readonly (readonly string[])[] = [],
    /**
     * Columns Prisma requires on create (no default, not nullable).
     *
     * Without this the fake accepted a row missing a required scalar and the
     * test passed, while the same call failed against real Postgres. That is
     * exactly how `approval.create` shipped without its `orgId` — the tenant
     * half of a composite foreign key — and went unnoticed.
     */
    readonly required: readonly string[] = []
  ) {}

  /** Throws a Prisma-shaped missing-argument error, as the real client does. */
  assertRequired(row: Row): void {
    for (const col of this.required) {
      if (row[col] === undefined || row[col] === null) {
        throw new Error(
          `fake-db: ${this.name}.create is missing required argument \`${col}\`. ` +
            `Prisma would reject this against a real database.`
        );
      }
    }
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  private matches(row: Row, where: Row): boolean {
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      // An unset column and an explicit NULL are the same thing in SQL, so a
      // `where: { resolvedAt: null }` must match a row that never set it.
      // Without this the fake misses existing rows and every dedup check fails.
      const actual = row[k] === undefined ? null : row[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        if ('not' in v) {
          if (v.not === null ? actual === null : actual === v.not) return false;
          continue;
        }
        if ('in' in v) {
          if (!v.in.includes(actual)) return false;
          continue;
        }
        if ('lt' in v) {
          if (!(actual < v.lt)) return false;
          continue;
        }
        if ('lte' in v) {
          if (!(actual <= v.lte)) return false;
          continue;
        }
        if ('gt' in v) {
          if (!(actual > v.gt)) return false;
          continue;
        }
        if ('gte' in v) {
          if (!(actual >= v.gte)) return false;
          continue;
        }
        if ('some' in v) {
          // Relation filter: handled by callers that need it.
          continue;
        }
        throw new Error(`fake-db: unsupported filter on ${this.name}.${k}: ${JSON.stringify(v)}`);
      }
      if (actual !== v) return false;
    }
    return true;
  }

  find(where: Row): Row | undefined {
    return this.rows.find((r) => this.matches(r, where));
  }

  findMany(where: Row = {}): Row[] {
    return this.rows.filter((r) => this.matches(r, where));
  }

  /** Throws a Prisma-shaped P2002 so callers can exercise their duplicate paths. */
  assertUnique(row: Row): void {
    for (const cols of this.uniques) {
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      const clash = this.rows.find((r) => cols.every((c) => r[c] === row[c]));
      if (clash) {
        const err: any = new Error(
          `Unique constraint failed on ${this.name}(${cols.join(',')})`
        );
        err.code = 'P2002';
        err.meta = { target: cols };
        throw err;
      }
    }
  }
}

/**
 * Columns declared `@default(now())` in the schema.
 *
 * The fake must populate these, because Prisma/PostgreSQL would. Leaving them
 * undefined silently breaks any comparison against them — a `heartbeatAt` of
 * undefined made every freshly-started reconciliation run look abandoned, which
 * looked like a locking bug rather than a test-double gap.
 */
const NOW_DEFAULT_COLUMNS = [
  'createdAt', 'updatedAt', 'startedAt', 'heartbeatAt',
  'detectedAt', 'lastObservedAt', 'processedAt', 'stateUpdatedAt',
];

function applyNowDefaults(data: Row): Row {
  const out = { ...data };
  for (const col of NOW_DEFAULT_COLUMNS) {
    if (out[col] === undefined) out[col] = new Date();
  }
  return out;
}

/**
 * Apply an update payload, honouring Prisma's atomic `{ increment: n }` form.
 * Assigning it verbatim would store the operator object as the column value.
 */
function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'increment' in v) {
      row[k] = (row[k] ?? 0) + (v as any).increment;
    } else if (v && typeof v === 'object' && !Array.isArray(v) && 'decrement' in v) {
      row[k] = (row[k] ?? 0) - (v as any).decrement;
    } else {
      row[k] = v;
    }
  }
}

/** Resolve a Prisma compound-unique `where` into a flat filter. */
function flattenWhere(where: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && k.includes('_')) {
      Object.assign(out, v); // e.g. { orgId_userId: { orgId, userId } }
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface FakeDb {
  [model: string]: any;
  $transaction: (fn: (tx: any) => Promise<any>) => Promise<any>;
  __tables: Record<string, Table>;
  /** Forces the next matching write to throw, to simulate a mid-batch crash. */
  __failOn: (model: string, op: string, times?: number) => void;
}

export function createFakeDb(): FakeDb {
  const tables: Record<string, Table> = {
    organization: new Table('organization', [['slug']]),
    orgMember: new Table('orgMember', [['orgId', 'userId']], ['orgId', 'userId']),
    invitation: new Table('invitation', [['tokenHash'], ['orgId', 'email']], ['orgId']),
    user: new Table('user', [['walletAddress']]),
    worker: new Table('worker', [['orgId', 'walletAddress']], ['orgId']),
    project: new Table('project', [['orgId', 'code']], ['orgId']),
    escrow: new Table('escrow', [['onChainId']], ['orgId']),
    payrollBatch: new Table(
      'payrollBatch',
      [['orgId', 'reference'], ['orgId', 'idempotencyKey']],
      ['orgId', 'reference']
    ),
    payment: new Table('payment', [['escrowId', 'onChainPaymentIndex']], ['orgId', 'batchId']),
    approval: new Table('approval', [['paymentId', 'role']], ['orgId', 'paymentId']),
    oracleAttestation: new Table('oracleAttestation', [
      ['escrowOnChainId', 'onChainPaymentIndex', 'nonce'],
    ]),
    blockchainTransaction: new Table(
      'blockchainTransaction',
      [['idempotencyKey'], ['hash']],
      ['orgId']
    ),
    auditEvent: new Table('auditEvent', [], ['orgId']),
    reconciliationFinding: new Table('reconciliationFinding', [], ['orgId']),
    reconciliationRun: new Table('reconciliationRun', [['correlationId']], ['orgId']),
    chainEvent: new Table('chainEvent', [['id']]),
    indexerCursor: new Table('indexerCursor', [['contractId', 'network']]),
  };

  const failures: { model: string; op: string; times: number }[] = [];

  function maybeFail(model: string, op: string) {
    const f = failures.find((x) => x.model === model && x.op === op && x.times > 0);
    if (f) {
      f.times -= 1;
      throw new Error(`fake-db: injected failure on ${model}.${op}`);
    }
  }

  const prefixes: Record<string, string> = {
    organization: 'org', orgMember: 'ogm', user: 'usr', worker: 'wrk',
    escrow: 'esc', payrollBatch: 'bat', payment: 'pay', approval: 'apr',
    oracleAttestation: 'att', blockchainTransaction: 'btx', auditEvent: 'aud',
    invitation: 'inv', reconciliationRun: 'run',
    reconciliationFinding: 'fnd', chainEvent: 'cev', indexerCursor: 'cur',
    project: 'prj',
  };

    /**
   * Relations the code under test includes, as (parent model) -> (relation name)
   * -> how to resolve it. Declared explicitly rather than inferred: an include
   * this fake does not know about should fail loudly, not return undefined and
   * surface as a confusing TypeError deep in the code under test.
   */
  const RELATIONS: Record<string, Record<string, { table: string; fk: string; many: boolean; orderBy?: string; belongsTo?: boolean }>> = {
    escrow: { payments: { table: 'payment', fk: 'escrowId', many: true, orderBy: 'onChainPaymentIndex' } },
    orgMember: {
      org:  { table: 'organization', fk: 'id', many: false, belongsTo: true },
      user: { table: 'user', fk: 'id', many: false, belongsTo: true },
    },
    payrollBatch: { payments: { table: 'payment', fk: 'batchId', many: true } },
    payment: {
      approvals: { table: 'approval', fk: 'paymentId', many: true },
      attestations: { table: 'oracleAttestation', fk: 'paymentId', many: true },
      transactions: { table: 'blockchainTransaction', fk: 'paymentId', many: true },
      auditEvents: { table: 'auditEvent', fk: 'paymentId', many: true },
      findings: { table: 'reconciliationFinding', fk: 'paymentId', many: true },
    },
  };

  /** Order rows per a Prisma `orderBy`. Shared so findFirst and findMany agree. */
  function sortRows(rows: Row[], orderBy: any): Row[] {
    if (!orderBy) return rows;
    const spec = Array.isArray(orderBy) ? orderBy[0] : orderBy;
    const [key, dir] = Object.entries(spec)[0] as [string, string];
    return [...rows].sort((a, b) =>
      a[key] === b[key] ? 0 : (a[key] < b[key] ? -1 : 1) * (dir === 'desc' ? -1 : 1)
    );
  }

  function hydrate(name: string, row: Row, include?: Row): Row {
    if (!include) return { ...row };
    const out: Row = { ...row };
    for (const [rel, spec] of Object.entries(include)) {
      if (spec === false || spec === undefined) continue;
      const def = RELATIONS[name]?.[rel];
      if (!def) throw new Error(`fake-db: unsupported include ${name}.${rel}`);
      if (def.belongsTo) {
        // Parent side: the FK lives on THIS row, pointing at the parent's id.
        const parentId = row[`${rel}Id`];
        const parent = tables[def.table].rows.find((r) => r[def.fk] === parentId);
        out[rel] = parent ? { ...parent } : null;
        continue;
      }
      let rows = tables[def.table].rows.filter((r) => r[def.fk] === row.id);

      // A relation can be included as `true` or as a spec carrying its own
      // orderBy / include. Honouring the spec matters: ignoring a nested include
      // returns rows whose relations are undefined, and the code under test then
      // silently takes its `?? []` fallback — so a test asserting on nested data
      // would pass without ever exercising it.
      const spec_ = spec as any;
      const nestedOrderBy = spec_ && typeof spec_ === 'object' ? spec_.orderBy : undefined;
      if (nestedOrderBy) {
        rows = sortRows(rows, nestedOrderBy);
      } else if (def.orderBy) {
        rows = [...rows].sort((a, b) =>
          a[def.orderBy!] === b[def.orderBy!] ? 0 : a[def.orderBy!] < b[def.orderBy!] ? -1 : 1
        );
      }

      const nestedInclude = spec_ && typeof spec_ === 'object' ? spec_.include : undefined;
      out[rel] = rows.map((r) => hydrate(def.table, r, nestedInclude));
    }
    return out;
  }


function model(name: string) {
    const t = tables[name];
    if (!t) throw new Error(`fake-db: unknown model ${name}`);
    return {
      // Reads return COPIES, as Prisma does. Returning the live row would let a
      // caller's captured snapshot mutate underneath it — which silently breaks
      // any code that compares previous state against new, and would make this
      // fake disagree with production in exactly the place that matters.
      findUnique: async ({ where, include }: any) => {
        const row = t.find(flattenWhere(where));
        return row ? hydrate(name, row, include) : null;
      },
      findFirst: async ({ where, orderBy, include }: any = {}) => {
        const rows = sortRows(t.findMany(flattenWhere(where ?? {})), orderBy);
        return rows[0] ? hydrate(name, rows[0], include) : null;
      },
      findMany: async ({ where, take, orderBy, include, distinct, cursor, skip }: any = {}) => {
        let rows = sortRows(t.findMany(flattenWhere(where ?? {})), orderBy);
        if (cursor) {
          const [[key, value]] = Object.entries(cursor) as [string, any][];
          const at = rows.findIndex((r) => r[key] === value);
          if (at < 0) {
            const err: any = new Error(`${name}: cursor row not found`);
            err.code = 'P2025';
            throw err;
          }
          rows = rows.slice(at);
        }
        if (typeof skip === 'number') rows = rows.slice(skip);
        if (distinct) {
          const keys = Array.isArray(distinct) ? distinct : [distinct];
          const seen = new Set<string>();
          rows = rows.filter((r) => {
            const k = keys.map((c: string) => String(r[c])).join('|');
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
        const out = typeof take === 'number' ? rows.slice(0, take) : rows;
        return out.map((r) => hydrate(name, r, include));
      },
      count: async ({ where }: any = {}) => t.findMany(flattenWhere(where ?? {})).length,
      create: async ({ data }: any) => {
        maybeFail(name, 'create');
        const row = {
          id: data.id ?? t.nextId(prefixes[name] ?? name),
          ...applyNowDefaults(data),
        };
        t.assertRequired(row);
        t.assertUnique(row);
        t.rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        maybeFail(name, 'update');
        const row = t.find(flattenWhere(where));
        if (!row) {
          const err: any = new Error(`${name} not found`);
          err.code = 'P2025';
          throw err;
        }
        applyData(row, data);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        maybeFail(name, 'updateMany');
        const rows = t.findMany(flattenWhere(where ?? {}));
        for (const r of rows) applyData(r, data);
        return { count: rows.length };
      },
      upsert: async ({ where, create, update }: any) => {
        const row = t.find(flattenWhere(where));
        if (row) {
          Object.assign(row, update);
          return row;
        }
        const created = { id: create.id ?? t.nextId(prefixes[name] ?? name), ...create };
        t.assertRequired(created);
        t.assertUnique(created);
        t.rows.push(created);
        return created;
      },
      deleteMany: async ({ where }: any = {}) => {
        const rows = t.findMany(flattenWhere(where ?? {}));
        t.rows = t.rows.filter((r) => !rows.includes(r));
        return { count: rows.length };
      },
    };
  }

  const db: any = { __tables: tables };
  for (const name of Object.keys(tables)) db[name] = model(name);

  /**
   * Transactions roll back on throw by snapshotting and restoring. Crude, but it
   * reproduces the property the indexer depends on: a failed event leaves NO
   * partial effect, so resuming is unambiguous.
   */
  /**
   * Interactive transaction with PER-TRANSACTION rollback.
   *
   * This used to snapshot every table and restore the whole snapshot on failure.
   * That is wrong under concurrency, and wrong in the direction that matters: when
   * two transactions interleave at an await point and the second fails, restoring
   * its snapshot also discards the FIRST one's committed writes. A test for
   * concurrent idempotent creates then saw one batch with one payment instead of
   * one batch with three, and would have been "fixed" by weakening the assertion
   * — hiding the fact that the fake, not the code, was at fault.
   *
   * Real Postgres isolates transactions per connection, so each rolls back only
   * its own work. This records an undo entry per write and replays it in reverse.
   */
  db.$transaction = async (fn: (tx: any) => Promise<any>) => {
    const undo: (() => void)[] = [];

    const tx: any = {};
    for (const name of Object.keys(tables)) {
      const base = db[name];
      const table = tables[name];
      tx[name] = {
        ...base,
        create: async (args: any) => {
          const row = await base.create(args);
          undo.push(() => {
            const i = table.rows.findIndex((r) => r.id === row.id);
            if (i >= 0) table.rows.splice(i, 1);
          });
          return row;
        },
        upsert: async (args: any) => {
          const before = await base.findFirst({ where: args.where });
          const row = await base.upsert(args);
          if (before) {
            undo.push(() => {
              const live = table.rows.find((r) => r.id === before.id);
              if (live) {
                for (const k of Object.keys(live)) delete live[k];
                Object.assign(live, before);
              }
            });
          } else {
            undo.push(() => {
              const i = table.rows.findIndex((r) => r.id === row.id);
              if (i >= 0) table.rows.splice(i, 1);
            });
          }
          return row;
        },
        update: async (args: any) => {
          const before = await base.findFirst({ where: args.where });
          const row = await base.update(args);
          if (before) {
            undo.push(() => {
              const live = table.rows.find((r) => r.id === before.id);
              if (live) {
                for (const k of Object.keys(live)) delete live[k];
                Object.assign(live, before);
              }
            });
          }
          return row;
        },
        updateMany: async (args: any) => {
          const before = await base.findMany({ where: args.where });
          const result = await base.updateMany(args);
          undo.push(() => {
            for (const prior of before) {
              const live = table.rows.find((r) => r.id === prior.id);
              if (live) {
                for (const k of Object.keys(live)) delete live[k];
                Object.assign(live, prior);
              }
            }
          });
          return result;
        },
        deleteMany: async (args: any = {}) => {
          const before = await base.findMany({ where: args.where });
          const result = await base.deleteMany(args);
          undo.push(() => {
            for (const prior of before) table.rows.push(prior);
          });
          return result;
        },
      };
    }

    // The transaction client deliberately OMITS `$transaction`, exactly as
    // Prisma's interactive client does. Passing `db` itself would let nested
    // transaction code pass here and fail only against a real database — which is
    // precisely what happened before this was tightened.
    for (const k of Object.keys(db)) {
      if (k === '$transaction' || k in tx) continue;
      tx[k] = (db as any)[k];
    }

    try {
      return await fn(tx);
    } catch (e) {
      for (const u of undo.reverse()) u();
      throw e;
    }
  };

  db.__failOn = (m: string, op: string, times = 1) => failures.push({ model: m, op, times });

  return db as FakeDb;
}

/** Seed an organization and return its id. */
export function seedOrg(db: FakeDb, id = 'org_test'): string {
  db.__tables.organization.rows.push({ id, name: 'Test Org', slug: 'test-org' });
  return id;
}

export function seedMember(
  db: FakeDb,
  orgId: string,
  userId: string,
  role: string,
  walletAddress: string
): void {
  if (!db.__tables.user.rows.some((u) => u.id === userId)) {
    db.__tables.user.rows.push({ id: userId, walletAddress, role: 'EMPLOYEE' });
  }
  if (!db.__tables.organization.rows.some((o) => o.id === orgId)) {
    db.__tables.organization.rows.push({ id: orgId, name: orgId, slug: orgId });
  }
  db.__tables.orgMember.rows.push({
    id: `ogm_${orgId}_${userId}`,
    orgId,
    userId,
    role,
    // ACTIVE by default. resolveTenant treats anything else as non-membership,
    // so a seeded member without a status would look suspended.
    status: 'ACTIVE',
    createdAt: new Date(),
  });
}
