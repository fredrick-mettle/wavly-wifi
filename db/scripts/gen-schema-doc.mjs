#!/usr/bin/env node
/**
 * Generates docs/schema-reference.md from the actual SQL parse trees.
 *
 *   node db/scripts/gen-schema-doc.mjs
 *
 * Hand-written column inventories drift. This one cannot: it reads the same
 * parse trees that db/scripts/check-schema.mjs validates, so if a column is
 * missing from the doc, it is missing from the schema.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadModule, parseSync } = require('libpg-query');
await loadModule();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Migration files are discovered, not listed.
 *
 * This was a hardcoded pair of filenames with hardcoded table counts in the prose
 * ("42 tables", "15 tables"). Both went stale the moment a third migration
 * appeared: the generated reference silently omitted the new view and functions
 * while still claiming to document the schema, and the counts were already wrong
 * after Phase 3 added nasreload. A generated document that quietly stops covering
 * part of the schema is worse than no document, because it is the one people
 * trust.
 */
const MIGRATIONS = readdirSync(resolve(ROOT, 'db/migrations'))
  .filter((n) => n.endsWith('.sql'))
  .sort()
  .map((n) => `db/migrations/${n}`);

if (!MIGRATIONS.length) {
  process.stderr.write('gen-schema-doc: no .sql files found in db/migrations\n');
  process.exit(1);
}

/**
 * Which database each migration belongs to, by filename convention: migrations
 * whose name contains `_edge_` are applied on the edge node, everything else in
 * the cloud. Table counts in the prose are computed from the parse tree, never
 * stated by hand.
 */
const GROUPS = [
  {
    title: 'Cloud database (Supabase) — authoritative',
    intro: 'The single source of truth for customers, money and entitlements.',
    include: (f) => !/_edge_/.test(f),
  },
  {
    title: 'Edge node database (on-site) — RADIUS projection',
    intro: 'Stock FreeRADIUS rlm_sql tables plus Wavly sync machinery. Never holds prices, payments or the authoritative subscription.',
    include: (f) => /_edge_/.test(f),
  },
];

// Every migration must land in exactly one group. The predicates above are
// mutually exclusive by construction, but this assertion is what stops a third
// group with an overlapping or missing predicate from silently dropping a file.
for (const f of MIGRATIONS) {
  const hits = GROUPS.filter((g) => g.include(f));
  if (hits.length !== 1) {
    process.stderr.write(
      `gen-schema-doc: ${f} matches ${hits.length} groups; it must match exactly one.\n`
    );
    process.exit(1);
  }
}
for (const g of GROUPS) g.files = MIGRATIONS.filter(g.include);
for (const g of GROUPS) {
  if (!g.files.length) {
    process.stderr.write(`gen-schema-doc: group "${g.title}" matched no migration files.\n`);
    process.exit(1);
  }
}

const str = (n) => (n && n.String ? n.String.sval : undefined);
const names = (arr) => (arr || []).map(str).filter(Boolean);

const TYPE_ALIASES = {
  bpchar: 'char', int4: 'integer', int2: 'smallint', int8: 'bigint',
  bool: 'boolean', float4: 'real', float8: 'double precision',
  varchar: 'varchar', text: 'text', numeric: 'numeric', decimal: 'numeric',
  uuid: 'uuid', inet: 'inet', cidr: 'cidr', jsonb: 'jsonb', json: 'json',
  date: 'date', timestamp: 'timestamp', timestamptz: 'timestamptz',
  timetz: 'timetz', citext: 'citext', macaddr: 'macaddr', bytea: 'bytea',
  name: 'name', oid: 'oid',
};

function typeName(tn) {
  if (!tn) return '';
  let parts = names(tn.names);
  if (parts[0] === 'pg_catalog') parts = parts.slice(1);
  let base = parts.join('.') || '?';
  base = TYPE_ALIASES[base] || base;
  const setof = tn.setof ? 'setof ' : '';
  let mods = '';
  if (tn.typmods && tn.typmods.length) {
    const rendered = tn.typmods.map((m) => scalarText(m)).filter((x) => x !== '?');
    if (rendered.length) mods = `(${rendered.join(', ')})`;
  }
  const arr = tn.arrayBounds && tn.arrayBounds.length ? '[]'.repeat(tn.arrayBounds.length) : '';
  return `${setof}${base}${mods}${arr}`;
}

/** Render a bare scalar node (A_Const and friends) as source-like text. */
function scalarText(node) {
  if (!node) return '?';
  const c = node.A_Const || node;
  if (c.isnull === true) return 'NULL';
  if (c.ival !== undefined && c.ival !== null) {
    // libpg-query's JSON encoder OMITS zero-valued fields, so {ival:{}} means 0
    // and {ival:{ival:3}} means 3. Reading .ival naively yields "[object Object]"
    // for every `default 0` in the schema.
    const v = c.ival && typeof c.ival === 'object' ? c.ival.ival : c.ival;
    return String(v === undefined ? 0 : v);
  }
  if (c.boolval !== undefined && c.boolval !== null) {
    // Same rule: {boolval:{}} means false.
    const b = c.boolval && typeof c.boolval === 'object' ? c.boolval.boolval : c.boolval;
    return String(b === undefined ? false : b);
  }
  if (c.sval !== undefined && c.sval !== null) {
    // {sval:{sval:'x'}} normally; {sval:{}} means the empty string.
    const v = c.sval;
    const raw = v && typeof v === 'object'
      ? (v.sval !== undefined ? v.sval : (v.String ? v.String.sval : ''))
      : v;
    return `'${raw}'`;
  }
  if (c.bsval !== undefined && c.bsval !== null) {
    const v = c.bsval;
    const raw = v && typeof v === 'object' ? (v.bsval !== undefined ? v.bsval : '') : v;
    return String(raw);
  }
  return '?';
}

function constText(node) {
  if (!node) return '';
  if (node.A_Const) return scalarText(node.A_Const);
  if (node.TypeCast) {
    const t = typeName(node.TypeCast.typeName);
    const inner = constText(node.TypeCast.arg);
    return `${inner}::${t}`;
  }
  if (node.FuncCall) {
    const fn = names(node.FuncCall.funcname).join('.');
    const args = (node.FuncCall.args || []).map((a) => constText(a)).filter(Boolean);
    return `${fn}(${args.join(', ')})`;
  }
  if (node.SQLValueFunction) {
    const map = {
      SVFOP_CURRENT_TIMESTAMP: 'now()', SVFOP_CURRENT_TIMESTAMP_E: 'now()',
      SVFOP_CURRENT_USER: 'current_user', SVFOP_LOCALTIMESTAMP: 'now()',
      SVFOP_SESSION_USER: 'session_user', SVFOP_CURRENT_SCHEMA: 'current_schema',
    };
    return map[node.SQLValueFunction.op] || node.SQLValueFunction.op;
  }
  if (node.A_Expr) {
    // e.g. `default -1`, `default 'x'::text || 'y'`
    const l = constText(node.A_Expr.lexpr), r = constText(node.A_Expr.rexpr);
    const op = (node.A_Expr.name || []).map(str).join('');
    return `${l} ${op} ${r}`.trim();
  }
  if (node.CaseExpr) return 'CASE ... END';
  if (node.SubLink) return '(subquery)';
  if (node.ColumnRef) return names(node.ColumnRef.fields).join('.');
  return '(expression)';
}

function collectColumnRefs(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => collectColumnRefs(n, out)); return out; }
  if (node.ColumnRef) {
    const f = (node.ColumnRef.fields || []).map(str).filter(Boolean);
    if (f.length) out.push(f[f.length - 1]);
  }
  for (const v of Object.values(node)) collectColumnRefs(v, out);
  return out;
}

function collectRangeVars(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => collectRangeVars(n, out)); return out; }
  if (node.RangeVar && node.RangeVar.relname) out.add(node.RangeVar.relname);
  for (const v of Object.values(node)) collectRangeVars(v, out);
  return out;
}

// ---------------------------------------------------------------------------
function analyse(files) {
  const stmts = [];
  for (const file of files) {
    stmts.push(...parseSync(readFileSync(resolve(ROOT, file), 'utf8')).stmts);
  }
  const tables = new Map();
  const views = [];
  const functions = [];
  const indexes = [];
  const triggers = [];
  const comments = new Map();   // 'table:x' or 'col:x.y' -> text

  const ensure = (n) => {
    if (!tables.has(n)) tables.set(n, { name: n, columns: [], checks: [], fks: [], uniques: [], pk: [], comment: null });
    return tables.get(n);
  };

  for (const s of stmts) {
    const st = s.stmt;

    if (st.CreateStmt) {
      const cs = st.CreateStmt;
      const t = ensure(cs.relation.relname);
      for (const elt of cs.tableElts || []) {
        if (elt.ColumnDef) {
          const cd = elt.ColumnDef;
          const col = {
            name: cd.colname, type: typeName(cd.typeName), notnull: false,
            def: null, pk: false, unique: false, generated: null, checks: [], fk: null,
          };
          for (const c of cd.constraints || []) {
            const k = c.Constraint;
            if (k.contype === 'CONSTR_NOTNULL') col.notnull = true;
            if (k.contype === 'CONSTR_PRIMARY') { col.pk = true; col.notnull = true; t.pk.push(cd.colname); }
            if (k.contype === 'CONSTR_UNIQUE') { col.unique = true; t.uniques.push([cd.colname]); }
            if (k.contype === 'CONSTR_DEFAULT') col.def = constText(k.raw_expr);
            if (k.contype === 'CONSTR_GENERATED') col.generated = constText(k.raw_expr);
            if (k.contype === 'CONSTR_CHECK') {
              const cols = [...new Set(collectColumnRefs(k.raw_expr))];
              col.checks.push({ expr: cols, raw: k.conname || null });
              t.checks.push(cols);
            }
            if (k.contype === 'CONSTR_FOREIGN') {
              col.fk = { table: k.pktable.relname, cols: names(k.pk_attrs), del: k.fk_del_action, upd: k.fk_upd_action };
              t.fks.push({ from: [cd.colname], table: k.pktable.relname, cols: names(k.pk_attrs), del: k.fk_del_action });
            }
          }
          t.columns.push(col);
        } else if (elt.Constraint) {
          const k = elt.Constraint;
          if (k.contype === 'CONSTR_PRIMARY') t.pk.push(...names(k.keys));
          if (k.contype === 'CONSTR_UNIQUE') t.uniques.push(names(k.keys));
          if (k.contype === 'CONSTR_CHECK') t.checks.push([...new Set(collectColumnRefs(k.raw_expr))]);
          if (k.contype === 'CONSTR_FOREIGN') {
            t.fks.push({ from: names(k.fk_attrs), table: k.pktable.relname, cols: names(k.pk_attrs), del: k.fk_del_action });
          }
        }
      }
    }

    if (st.AlterTableStmt) {
      const at = st.AlterTableStmt;
      const t = ensure(at.relation.relname);
      for (const cmd of at.cmds || []) {
        const def = cmd.AlterTableCmd && cmd.AlterTableCmd.def;
        if (def && def.ColumnDef) {
          const cd = def.ColumnDef;
          if (!t.columns.some((c) => c.name === cd.colname)) {
            const col = {
              name: cd.colname, type: typeName(cd.typeName), notnull: false,
              def: null, pk: false, unique: false, generated: null, checks: [], fk: null,
              addedByAlter: true,
            };
            for (const c of cd.constraints || []) {
              const k = c.Constraint;
              if (k.contype === 'CONSTR_NOTNULL') col.notnull = true;
              if (k.contype === 'CONSTR_DEFAULT') col.def = constText(k.raw_expr);
              if (k.contype === 'CONSTR_PRIMARY') { col.pk = true; t.pk.push(cd.colname); }
              if (k.contype === 'CONSTR_UNIQUE') { col.unique = true; t.uniques.push([cd.colname]); }
            }
            t.columns.push(col);
          }
        }
        const k = def && def.Constraint;
        if (!k) continue;
        if (k.contype === 'CONSTR_FOREIGN') {
          t.fks.push({ from: names(k.fk_attrs), table: k.pktable.relname, cols: names(k.pk_attrs), del: k.fk_del_action, viaAlter: true });
        }
        if (k.contype === 'CONSTR_PRIMARY') t.pk.push(...names(k.keys));
        if (k.contype === 'CONSTR_UNIQUE') t.uniques.push(names(k.keys));
      }
    }

    if (st.IndexStmt) {
      const ix = st.IndexStmt;
      indexes.push({
        name: ix.idxname, table: ix.relation.relname, unique: !!ix.unique,
        method: (ix.accessMethod || 'btree'),
        cols: (ix.indexParams || []).map((p) => p.IndexElem && p.IndexElem.name).filter(Boolean),
        exprCount: (ix.indexParams || []).filter((p) => p.IndexElem && !p.IndexElem.name).length,
        partial: !!ix.whereClause,
      });
    }

    if (st.ViewStmt) {
      const vw = st.ViewStmt;
      views.push({ name: vw.view.relname, reads: [...collectRangeVars(vw.query)] });
    }
    if (st.CreateFunctionStmt) functions.push(names(st.CreateFunctionStmt.funcname).join('.'));
    if (st.CreateTrigStmt) {
      const tg = st.CreateTrigStmt;
      triggers.push({ name: tg.trigname, table: tg.relation.relname, fn: names(tg.funcname).join('.') });
    }

    if (st.CommentStmt) {
      const cs = st.CommentStmt;
      const obj = cs.object;
      if (cs.objtype === 'OBJECT_TABLE' && obj.List) {
        ensure(names(obj.List.items).pop()).comment = cs.comment;
      } else if (cs.objtype === 'OBJECT_COLUMN' && obj.List) {
        const f = names(obj.List.items);
        const tbl = f[f.length - 2], col = f[f.length - 1];
        comments.set(`col:${tbl}.${col}`, cs.comment);
      } else if (cs.objtype === 'OBJECT_VIEW' && obj.List) {
        comments.set(`view:${names(obj.List.items).pop()}`, cs.comment);
      }
    }
  }

  // FKs added later via ALTER TABLE land in t.fks but not on the column object.
  // Copy single-column ones back so the column table is complete.
  for (const t of tables.values()) {
    for (const fk of t.fks) {
      if (fk.from.length !== 1) continue;
      const col = t.columns.find((c) => c.name === fk.from[0]);
      if (col && !col.fk) col.fk = { table: fk.table, cols: fk.cols, del: fk.del };
    }
  }

  return { tables, views, functions, indexes, triggers, comments };
}

const DEL = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' };

function esc(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
let out = '';
out += `<!-- GENERATED FILE — DO NOT EDIT BY HAND.
     Run: npm run db:docs
     Source: ${MIGRATIONS.join(', ')} -->\n\n`;
out += `# Schema Reference (generated)\n\n`;
out += `Every column of every table, extracted from the SQL parse trees. This file is\n`;
out += `regenerated by \`npm run db:docs\` and is checked in so diffs to the schema are\n`;
out += `reviewable. For the reasoning behind the design see\n`;
out += `[02-database-schema.md](./02-database-schema.md).\n\n`;

const all = [];
for (const g of GROUPS) {
  all.push({ g, a: analyse(g.files) });
}

for (const { g, a } of all) {
  const tcount = [...a.tables.values()].filter((t) => t.columns.length).length;
  out += `---\n\n## ${g.title}\n\n`;
  out += `${g.intro}\n\nSource: ${g.files.map((f) => `\`${f}\``).join(', ')}\n`
  // Explicit plurals: "indexs" is what a naive w + 's' produces.
  const n = (c, one, many) => `${c} ${c === 1 ? one : many}`;
  out += `\n${n(tcount, 'table', 'tables')}, ${n(a.views.length, 'view', 'views')}, `;
  out += `${n(a.functions.length, 'function', 'functions')}, `;
  out += `${n(a.indexes.length, 'index', 'indexes')}.\n\n`;

  out += `### Tables\n\n`;
  for (const t of [...a.tables.values()].filter((x) => x.columns.length)) {
    out += `#### \`${t.name}\`\n\n`;
    if (t.comment) out += `${esc(t.comment)}\n\n`;
    out += `| Column | Type | Null | Default / Generated | Keys & constraints |\n`;
    out += `|---|---|---|---|---|\n`;
    for (const c of t.columns) {
      const notes = [];
      if (c.pk) notes.push('**PK**');
      if (c.unique) notes.push('UNIQUE');
      if (c.fk) notes.push(`FK → \`${c.fk.table}.${(c.fk.cols || []).join(',') || 'id'}\` on delete ${DEL[c.fk.del] || 'no action'}`);
      for (const chk of t.checks) {
        if (chk.includes(c.name) && chk.length === 1) notes.push('CHECK');
      }
      const colComment = a.comments.get(`col:${t.name}.${c.name}`);
      const def = c.generated ? `GENERATED ALWAYS AS (${esc(c.generated)}) STORED` : (c.def === null ? '' : esc(c.def));
      out += `| \`${c.name}\` | \`${esc(c.type)}\` | ${c.notnull ? 'no' : 'yes'} | ${def} | ${notes.join('; ')} |\n`;
      if (colComment) out += `| | | | | _${esc(colComment)}_ |\n`;
    }
    // table-level constraints
    const tblNotes = [];
    if (t.pk.length > 1) tblNotes.push(`composite PK (${t.pk.map((x) => '`' + x + '`').join(', ')})`);
    for (const u of t.uniques) if (u.length > 1) tblNotes.push(`UNIQUE (${u.map((x) => '`' + x + '`').join(', ')})`);
    for (const fk of t.fks.filter((f) => f.viaAlter || f.from.length > 1)) {
      tblNotes.push(`FK (${fk.from.map((x) => '`' + x + '`').join(', ')}) → \`${fk.table}\``);
    }
    if (tblNotes.length) out += `\n_Table-level:_ ${tblNotes.join(' · ')}\n`;

    const idx = a.indexes.filter((i) => i.table === t.name);
    if (idx.length) {
      out += `\n_Indexes:_\n`;
      for (const i of idx) {
        const bits = [];
        if (i.unique) bits.push('UNIQUE');
        if (i.method !== 'btree') bits.push(i.method.toUpperCase());
        bits.push(
          i.exprCount > 0
            ? `${i.cols.map((c) => '`' + c + '`').join(', ')}${i.cols.length ? ', ' : ''}+ ${i.exprCount} expression(s)`
            : (i.cols.length ? i.cols.map((c) => '`' + c + '`').join(', ') : '(expression)')
        );
        if (i.partial) bits.push('PARTIAL');
        out += `- \`${i.name}\` — ${bits.join(' ')}\n`;
      }
    }
    const trg = a.triggers.filter((x) => x.table === t.name);
    if (trg.length) out += `\n_Triggers:_ ${trg.map((x) => `\`${x.name}\` → \`${x.fn}()\``).join(', ')}\n`;
    out += `\n`;
  }

  if (a.views.length) {
    out += `### Views\n\n`;
    for (const v of a.views) {
      const c = a.comments.get(`view:${v.name}`);
      out += `#### \`${v.name}\`\n\n`;
      if (c) out += `${esc(c)}\n\n`;
      out += `Reads: ${v.reads.map((r) => '`' + r + '`').join(', ')}\n\n`;
    }
  }
  if (a.functions.length) {
    out += `### Functions\n\n${a.functions.map((f) => `- \`${f}()\``).join('\n')}\n\n`;
  }
}

// ---------------------------------------------------------------------------
// Relationship map
// ---------------------------------------------------------------------------
out += `---\n\n## Relationship map\n\n`;
out += `Foreign keys, as declared. Arrow direction is "references".\n\n`;
for (const { g, a } of all) {
  out += `### ${g.title}\n\n`;
  for (const t of [...a.tables.values()].filter((x) => x.columns.length)) {
    for (const fk of t.fks) {
      out += `- \`${t.name}\`.${fk.from.join(',')} → \`${fk.table}\`${fk.cols.length ? '.' + fk.cols.join(',') : ''}  _on delete ${DEL[fk.del] || 'no action'}_\n`;
    }
  }
  out += `\n`;
}

writeFileSync(resolve(ROOT, 'docs/schema-reference.md'), out);
const lines = out.split('\n').length;
console.log(`Wrote docs/schema-reference.md (${lines} lines, ${(Buffer.byteLength(out) / 1024).toFixed(1)} kB)`);
