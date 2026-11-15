/**
 * Reads configuration OUT OF THE SQL SEED by parsing it with libpg-query.
 *
 * Why this exists
 * ---------------
 * The MikroTik script has to render the rate profiles and walled-garden rules
 * that live in the database. The obvious implementations are both wrong:
 *
 *   1. Require a live database. There isn't one at authoring time, the router
 *      script must be reviewable as a plain file, and "run psql against
 *      production to generate the config" is how a typo reaches 80 customers.
 *   2. Keep a second JSON/YAML copy of the same numbers. Two sources of truth
 *      drift. Someone changes a plan in the admin UI, regenerates nothing, and
 *      the router keeps shaping traffic at last month's rate.
 *
 * So we parse the seed. The seed is the single source of truth and the rendered
 * script is a pure function of it. Change a plan, re-run the generator, diff the
 * output, paste it into the router. Nothing to remember.
 *
 * The parser is the real PostgreSQL grammar (libpg-query is the PG parser
 * compiled to WASM), not a regex, so comments, line wrapping and quoting in the
 * seed are handled correctly.
 *
 * ---------------------------------------------------------------------------
 * FOREIGN KEYS RESOLVE TO NATURAL KEYS, NEVER TO INVENTED UUIDs
 * ---------------------------------------------------------------------------
 * The seed writes `(select id from rate_profiles where name = 'p-12-6')`. That
 * `id` is `gen_random_uuid()` — it does not exist until the row is inserted, so
 * no static tool can know its value. Fabricating one would be a lie that type
 * checks. Instead each such subquery becomes a {$ref} descriptor carrying the
 * table and the matched natural key, and callers resolve by name. See `refKey`.
 */

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);

let pg = null;
async function boot() {
  if (pg) return pg;
  pg = require('libpg-query');
  await pg.loadModule();
  return pg;
}

/**
 * libpg-query omits zero-valued fields, so `{ival:{}}` means 0, `{boolval:{}}`
 * means false and `{sval:{}}` means ''. Every accessor must respect that.
 */
function constValue(ac) {
  if (ac.isnull === true) return null;
  if ('sval' in ac) return ac.sval?.sval ?? '';
  if ('ival' in ac) return ac.ival?.ival ?? 0;
  if ('boolval' in ac) return ac.boolval?.boolval ?? false;
  if ('bsval' in ac) return ac.bsval?.bsval ?? '';
  // Numeric literals with a decimal point arrive as a STRING (fval), because a
  // JSON number could not represent e.g. 6.749000 exactly.
  if ('fval' in ac) return Number(ac.fval?.fval ?? 0);
  throw new Error(`constValue: unrecognised A_Const shape ${JSON.stringify(ac)}`);
}

/** Shape of a resolved foreign-key reference. */
const REF = Symbol.for('wavly.fkref');

/**
 * Reduce a parse-tree node to a plain JS value. Anything that cannot be
 * represented exactly THROWS rather than silently rendering as null — a config
 * generator that guesses is worse than one that refuses.
 */
function value(node, ctx = '') {
  if (node.A_Const) return constValue(node.A_Const);

  // 'x'::text, 5::int, '80000'::jsonb — take the inner literal.
  if (node.TypeCast) {
    const inner = value(node.TypeCast.arg, ctx);
    const typeName = node.TypeCast.typeName?.names?.map((n) => n.String?.sval).join('.');
    if ((typeName === 'jsonb' || typeName === 'json') && typeof inner === 'string') {
      try { return JSON.parse(inner); }
      catch { throw new Error(`seed: value at ${ctx} is not valid JSON: ${JSON.stringify(inner)}`); }
    }
    return inner;
  }

  // Negative numbers parse as 0 - n (an A_Expr), not as a negative A_Const.
  if (node.A_Expr) {
    const e = node.A_Expr;
    // `kind` is an enum serialised as a STRING here ("AEXPR_OP"); older/newer
    // builds emit the numeric value and the encoder omits zero, so accept both.
    const kind = e.kind ?? 0;
    const isPlainOp = kind === 'AEXPR_OP' || kind === 0;
    const op = e.name?.map((n) => n.String?.sval).join('');
    if (!isPlainOp) {
      throw new Error(`seed: cannot evaluate A_Expr kind '${kind}' at ${ctx}`);
    }
    // Unary minus arrives as the same operator with a NULL left operand, which is
    // how PostgreSQL represents a negative numeric literal.
    if (op === '-' && (e.lexpr === null || e.lexpr === undefined)) return -value(e.rexpr, ctx);
    if (op === '-') return value(e.lexpr, ctx) - value(e.rexpr, ctx);
    if (op === '+') return value(e.lexpr, ctx) + value(e.rexpr, ctx);
    if (op === '||') return String(value(e.lexpr, ctx)) + String(value(e.rexpr, ctx));
    throw new Error(`seed: cannot evaluate operator '${op}' at ${ctx}`);
  }

  // (select id from rate_profiles where name = 'p-12-6')
  if (node.SubLink) return sublinkRef(node.SubLink, ctx);

  if (node.FuncCall) {
    const fn = node.FuncCall.funcname?.map((n) => n.String?.sval).join('.');
    throw new Error(
      `seed: cannot evaluate function call ${fn}() at ${ctx}. The router config ` +
      `generator must be deterministic, so computed values (now(), ` +
      `gen_random_uuid(), …) cannot appear in the columns it reads.`
    );
  }

  throw new Error(`seed: unrecognised node at ${ctx}: ${JSON.stringify(node).slice(0, 240)}`);
}

const colName = (n) => n?.ColumnRef?.fields?.map((f) => f.String?.sval).join('.');

/**
 * Turn `(select <col> from <table> where <w> = <literal>)` into a descriptor.
 * Only the simple equality form is supported; anything else throws.
 */
function sublinkRef(sl, ctx) {
  if (sl.subLinkType !== 'EXPR_SUBLINK') {
    throw new Error(`seed: unsupported sublink type ${sl.subLinkType} at ${ctx}`);
  }
  const sel = sl.subselect?.SelectStmt;
  if (!sel) throw new Error(`seed: sublink has no subselect at ${ctx}`);
  if (sel.fromClause?.length !== 1 || !sel.fromClause[0].RangeVar) {
    throw new Error(`seed: sublink must select from exactly one table (${ctx})`);
  }
  const targets = sel.targetList || [];
  if (targets.length !== 1) {
    throw new Error(`seed: sublink must select exactly one column (${ctx})`);
  }
  const table = sel.fromClause[0].RangeVar.relname;
  const selectColumn = colName(targets[0].ResTarget?.val);
  if (!selectColumn) throw new Error(`seed: sublink target is not a plain column (${ctx})`);

  const w = sel.whereClause;
  if (!w?.A_Expr) throw new Error(`seed: sublink needs a simple WHERE <col> = <literal> (${ctx})`);
  const op = w.A_Expr.name?.map((n) => n.String?.sval).join('');
  const wkind = w.A_Expr.kind ?? 0;
  if ((wkind !== 'AEXPR_OP' && wkind !== 0) || op !== '=') {
    throw new Error(`seed: sublink WHERE must be a plain equality, got '${op}' (${ctx})`);
  }
  const matchColumn = colName(w.A_Expr.lexpr);
  if (!matchColumn) throw new Error(`seed: sublink WHERE left side is not a plain column (${ctx})`);
  const matchValue = value(w.A_Expr.rexpr, `${ctx} (sublink)`);

  return { [REF]: true, table, selectColumn, matchColumn, matchValue };
}

/** True when `x` came from a scalar FK subquery. */
export const isRef = (x) => Boolean(x && typeof x === 'object' && x[REF]);

/**
 * The natural key of a {$ref} — e.g. 'p-12-6'. Throws if the reference was not
 * matched on a natural key column (name/code), because then it cannot be
 * resolved without a database.
 */
export function refKey(x, ctx = '') {
  if (!isRef(x)) throw new Error(`refKey: not a reference at ${ctx}`);
  if (!['name', 'code', 'key'].includes(x.matchColumn)) {
    throw new Error(
      `refKey: ${x.table}.${x.matchColumn} is not a natural key, so it cannot be ` +
      `resolved without a live database (${ctx}). The seed must reference rows by ` +
      `name or code.`
    );
  }
  return x.matchValue;
}

/** Like refKey but returns undefined for null/absent values. */
export function maybeRefKey(x) {
  if (x === null || x === undefined) return undefined;
  if (!isRef(x)) return x;
  return ['name', 'code', 'key'].includes(x.matchColumn) ? x.matchValue : undefined;
}

/**
 * Turn one INSERT statement into an array of row objects.
 */
function rowsFromInsert(ins) {
  const rel = ins.relation?.relname;
  if (!rel) return [];
  const cols = (ins.cols || []).map((c) => c.ResTarget?.name);
  const lists = ins.selectStmt?.SelectStmt?.valuesLists || [];
  if (!lists.length) return []; // `insert into t select …`

  return lists.map((rowNode, ri) => {
    const items = rowNode.List?.items || [];
    const out = {};
    items.forEach((item, ci) => {
      const col = cols[ci];
      if (!col) throw new Error(`seed: ${rel} row ${ri} has more values than columns`);
      out[col] = value(item, `${rel}[${ri}].${col}`);
    });
    return out;
  });
}

/**
 * Tables the router config actually reads. Restricting to these matters: the
 * seed legitimately contains non-literal values (now(), gen_random_uuid()) in
 * columns we never touch, and refusing to guess is correct — we just should not
 * refuse on rows that are irrelevant to the router.
 */
export const SEED_TABLES_FOR_ROUTER = [
  'sites', 'plans', 'rate_profiles', 'network_rules', 'settings', 'nas_devices',
];

/**
 * Parse a SQL file and return every INSERT's rows, grouped by target table.
 * Later inserts into the same table are appended.
 *
 * @param {string} path
 * @param {{tables?: string[]|null}} [opts] pass null to extract every table.
 */
export async function parseSeedInserts(path, opts = {}) {
  const q = await boot();
  const sql = await readFile(path, 'utf8');
  const tree = q.parseSync(sql);
  const wanted = opts.tables === null ? null : (opts.tables ?? SEED_TABLES_FOR_ROUTER);
  /** @type {Record<string, object[]>} */
  const out = {};
  for (const s of tree.stmts || []) {
    const ins = s.stmt?.InsertStmt;
    if (!ins) continue;
    const rel = ins.relation?.relname;
    if (!rel || (wanted && !wanted.includes(rel))) continue;
    (out[rel] ||= []).push(...rowsFromInsert(ins));
  }
  return out;
}

/**
 * The subset of the seed the router config needs, with plans already joined to
 * their rate profiles BY NAME.
 *
 * @param {string} [seedPath] defaults to db/seed/0001_core_defaults.sql
 */
export async function loadSeed(seedPath) {
  const { fileURLToPath } = await import('node:url');
  const p = seedPath
    ? (typeof seedPath === 'string' ? seedPath : fileURLToPath(seedPath))
    : fileURLToPath(new URL('../../../db/seed/0001_core_defaults.sql', import.meta.url));

  const raw = await parseSeedInserts(p);

  const rateProfiles = (raw.rate_profiles || []).filter((r) => r.is_active !== false);
  const byName = new Map(rateProfiles.map((r) => [r.name, r]));

  const settings = {};
  for (const s of raw.settings || []) {
    if (s.is_secret) continue; // never render a secret into a config file
    // The column is jsonb; the seed stores it as a JSON-encoded string.
    let v = s.value;
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch { /* leave as-is: a plain string value */ }
    }
    settings[s.key] = v;
  }

  const plans = (raw.plans || [])
    .filter((pl) => pl.is_active !== false)
    .map((pl) => ({
      ...pl,
      rate_profile_name: refKey(pl.rate_profile_id, `plan ${pl.code}`),
      fup_rate_profile_name: maybeRefKey(pl.fup_rate_profile_id),
    }));

  return {
    sites: raw.sites || [],
    plans,
    rateProfiles,
    allRateProfiles: raw.rate_profiles || [],
    networkRules: (raw.network_rules || []).filter((r) => r.is_active !== false),
    settings,
    nasDevices: raw.nas_devices || [],
    /** Look up a rate profile by name; throws if missing (a dangling FK). */
    profileFor(name) {
      const r = byName.get(name);
      if (!r) throw new Error(`seed: rate profile '${name}' is referenced but not defined`);
      return r;
    },
    raw,
  };
}
