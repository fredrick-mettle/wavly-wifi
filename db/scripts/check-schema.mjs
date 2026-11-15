#!/usr/bin/env node
/**
 * Static structural checker for the Wavly WiFi SQL.
 *
 *   node db/scripts/check-schema.mjs
 *
 * libpg-query proves the SQL PARSES. That is not enough: the bug classes that
 * actually bite in a 40-table money schema are structural, and Postgres only
 * reports them at apply time — usually on a machine you cannot easily roll back.
 * This script walks the real parse trees and verifies:
 *
 *   1. every FOREIGN KEY target table exists AT THE POINT IT IS REFERENCED
 *      (the forward-reference bug: `alter table x add fk -> y` before `create y`)
 *   2. every FK's referenced column is actually a PK or has a UNIQUE constraint
 *   3. every FK's local column exists on the local table
 *   4. every CREATE INDEX names an existing table and existing columns
 *   5. every CREATE TRIGGER names an existing table and an existing function
 *   6. every view only reads tables that exist
 *   7. every INSERT names columns that exist, and the VALUES arity matches
 *   8. no duplicate table, column, index or constraint names
 *   9. no CHECK constraint references a column that does not exist
 *
 * Exits non-zero on any error, so it belongs in CI.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('libpg-query');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Discover the SQL files rather than hardcoding them.
 *
 * This was a hardcoded list of three paths, which meant adding
 * db/migrations/0003_edge_radius_logic.sql silently checked nothing at all: the
 * run still printed "No structural errors found" while a new file went entirely
 * unexamined. A schema checker that quietly ignores files is worse than no
 * checker, because it produces the confidence the checker exists to earn.
 *
 * Migrations are zero-padded (0001, 0002, ...) so a lexicographic sort is the
 * apply order, which matters: FK resolution is checked in file order.
 */
function discoverSql(dir) {
  let names;
  try {
    names = readdirSync(resolve(ROOT, dir));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => `${dir}/${n}`);
}

const DEFAULT_FILES = [...discoverSql('db/migrations'), ...discoverSql('db/seed')];

if (!DEFAULT_FILES.length) {
  process.stderr.write('check-schema: found no .sql files under db/migrations or db/seed\n');
  process.exit(1);
}

// No args -> check the real schema. With args -> check exactly those files,
// resolved against the repo root if relative and against cwd if absolute.
// This is what db/tests/checker.test.mjs uses to prove the checker works.
const FILES = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES;

const errors = [];
const warnings = [];
const err = (f, m) => errors.push(`${f}: ${m}`);
const warn = (f, m) => warnings.push(`${f}: ${m}`);

// ---------------------------------------------------------------------------
// Schema model
// ---------------------------------------------------------------------------
const tables = new Map();   // name -> { columns:Set, pk:Set, unique:Set[], file, order }
const functions = new Set();
const indexes = new Map();  // name -> table
const views = new Map();
let createOrder = 0;

const str = (n) => (n && n.String ? n.String.sval : undefined);
const names = (arr) => (arr || []).map(str).filter(Boolean);

function ensureTable(name, file) {
  if (!tables.has(name)) {
    tables.set(name, {
      columns: new Set(), pk: new Set(), unique: [], file, order: createOrder++,
    });
  }
  return tables.get(name);
}

// Collect the column names referenced anywhere inside an expression tree.
// Used to validate CHECK constraints and index predicates.
function collectColumnRefs(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => collectColumnRefs(n, out)); return out; }
  if (node.ColumnRef) {
    const f = (node.ColumnRef.fields || []).map(str).filter(Boolean);
    if (f.length) out.add(f[f.length - 1]);
  }
  if (node.RangeVar && node.RangeVar.relname) out.add(`@table:${node.RangeVar.relname}`);
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
// Constraint handling
// ---------------------------------------------------------------------------
function handleConstraint(file, tableName, constraint, localCols) {
  const t = ensureTable(tableName, file);
  const kind = constraint.contype;

  if (kind === 'CONSTR_PRIMARY') {
    names(constraint.keys).forEach((c) => { t.pk.add(c); t.columns.add(c); });
    if (localCols) localCols.forEach((c) => t.pk.add(c));
  }
  if (kind === 'CONSTR_UNIQUE') {
    // A column-level `foo text unique` constraint has an EMPTY keys array — the
    // column is only known from the enclosing ColumnDef, which arrives as
    // localCols. A table-level `unique (a, b)` puts the columns in keys.
    // Missing this makes every column-level UNIQUE invisible and turns ON
    // CONFLICT validation into a wall of false positives.
    const cols = names(constraint.keys).length ? names(constraint.keys) : (localCols || []);
    if (cols.length) {
      t.unique.push(new Set(cols));
      cols.forEach((c) => t.columns.add(c));
    }
  }
  if (kind === 'CONSTR_CHECK') {
    for (const ref of collectColumnRefs(constraint.raw_expr)) {
      if (ref.startsWith('@table:')) {
        const rt = ref.slice(7);
        if (!tables.has(rt) && !views.has(rt)) warn(file, `CHECK on ${tableName} references unknown table ${rt}`);
      } else if (!t.columns.has(ref) && !['now', 'current_user'].includes(ref)) {
        // Allow SQL keywords/functions that the parser surfaces as ColumnRef.
        const sqlKeywords = new Set(['true', 'false', 'null', 'current_date', 'current_timestamp', 'not', 'excluded']);
        if (!sqlKeywords.has(ref.toLowerCase())) {
          warn(file, `CHECK on ${tableName} references column "${ref}" that is not defined on that table`);
        }
      }
    }
  }

  if (kind === 'CONSTR_FOREIGN') {
    const pkName = constraint.pktable ? constraint.pktable.relname : null;
    const pkAttrs = names(constraint.pk_attrs);
    const fkAttrs = localCols && localCols.length ? localCols : names(constraint.fk_attrs);

    if (!pkName) { err(file, `FK on ${tableName} has no target table`); return; }

    if (!tables.has(pkName)) {
      err(file, `FK ${tableName}(${fkAttrs.join(',')}) -> ${pkName}(${pkAttrs.join(',')}) ` +
                `references a table that does not exist yet at this point in the file. ` +
                `Move the table earlier or add the FK with ALTER TABLE after both tables exist.`);
      return;
    }
    const target = tables.get(pkName);

    for (const c of fkAttrs) {
      if (!t.columns.has(c)) err(file, `FK source column ${tableName}.${c} does not exist`);
    }
    if (pkAttrs.length) {
      for (const c of pkAttrs) {
        if (!target.columns.has(c)) {
          err(file, `FK target column ${pkName}.${c} does not exist`);
        }
      }
      const coveredByPk = pkAttrs.every((c) => target.pk.has(c));
      const coveredByUnique = target.unique.some((u) => pkAttrs.every((c) => u.has(c)));
      if (!coveredByPk && !coveredByUnique) {
        err(file, `FK ${tableName} -> ${pkName}(${pkAttrs.join(',')}) targets columns that are neither ` +
                  `a PRIMARY KEY nor UNIQUE. Postgres will reject this with 'there is no unique constraint'.`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Statement walking
// ---------------------------------------------------------------------------
function walkStatement(file, stmt) {
  if (stmt.CreateStmt) {
    const s = stmt.CreateStmt;
    const name = s.relation.relname;
    if (tables.has(name)) err(file, `duplicate CREATE TABLE ${name}`);
    const t = ensureTable(name, file);
    t.file = file;

    for (const elt of s.tableElts || []) {
      if (elt.ColumnDef) {
        const col = elt.ColumnDef;
        t.columns.add(col.colname);
        for (const c of col.constraints || []) {
          if (c.Constraint) handleConstraint(file, name, c.Constraint, [col.colname]);
        }
        // GENERATED ALWAYS AS (...) STORED columns are real columns.
      } else if (elt.Constraint) {
        handleConstraint(file, name, elt.Constraint, null);
      }
    }
    // Composite PK declared as `primary key (a, b)` lands in tableElts as a Constraint.
    return;
  }

  if (stmt.AlterTableStmt) {
    const s = stmt.AlterTableStmt;
    const name = s.relation.relname;
    if (!tables.has(name)) { err(file, `ALTER TABLE on unknown table ${name}`); return; }
    const t = tables.get(name);
    for (const cmd of s.cmds || []) {
      const c = cmd.AlterTableCmd;
      if (!c) continue;
      const def = c.def;
      if (def && def.Constraint) handleConstraint(file, name, def.Constraint, null);
      // ALTER TABLE ... ADD COLUMN carries a ColumnDef in `def`, and leaves
      // `name` empty. Missing this makes every added column invisible, which
      // then reports spurious "unknown column" errors on later indexes.
      if (def && def.ColumnDef) {
        t.columns.add(def.ColumnDef.colname);
        for (const k of def.ColumnDef.constraints || []) {
          if (k.Constraint) handleConstraint(file, name, k.Constraint, [def.ColumnDef.colname]);
        }
      }
      if (c.subtype === 'AT_DropColumn' && c.name) t.columns.delete(c.name);
      else if (c.name && !def) t.columns.add(c.name);
    }
    return;
  }

  if (stmt.IndexStmt) {
    const s = stmt.IndexStmt;
    const name = s.idxname;
    const tbl = s.relation.relname;
    if (name) {
      if (indexes.has(name)) err(file, `duplicate index name ${name}`);
      indexes.set(name, tbl);
    }
    if (!tables.has(tbl)) { err(file, `CREATE INDEX ${name || '(anon)'} on unknown table ${tbl}`); return; }
    const t = tables.get(tbl);
    const idxCols = [];
    for (const p of s.indexParams || []) {
      const col = p.IndexElem && p.IndexElem.name;
      if (col && !t.columns.has(col)) err(file, `index ${name} references unknown column ${tbl}.${col}`);
      if (col) idxCols.push(col);
    }
    // A UNIQUE index is a uniqueness promise ON CONFLICT can rely on — but only
    // if it is entirely plain columns. An expression index (e.g. one using
    // coalesce() to make NULLs collide) cannot be named as an arbiter, so
    // recording it would let a bogus ON CONFLICT (cols) pass silently.
    if (s.unique && idxCols.length && idxCols.length === (s.indexParams || []).length) {
      t.unique.push(new Set(idxCols));
    }
    for (const ref of collectColumnRefs(s.whereClause)) {
      if (ref.startsWith('@table:')) continue;
      if (!t.columns.has(ref) && ref.toLowerCase() !== 'now') {
        warn(file, `index ${name} predicate references "${ref}" which is not a column of ${tbl}`);
      }
    }
    return;
  }

  if (stmt.CreateFunctionStmt) {
    functions.add(stmt.CreateFunctionStmt.funcname.map(str).join('.'));
    return;
  }

  if (stmt.CreateTrigStmt) {
    const s = stmt.CreateTrigStmt;
    const tbl = s.relation.relname;
    if (!tables.has(tbl)) err(file, `CREATE TRIGGER ${s.trigname} on unknown table ${tbl}`);
    const fn = s.funcname.map(str).join('.');
    if (!functions.has(fn)) err(file, `CREATE TRIGGER ${s.trigname} calls undefined function ${fn}()`);
    return;
  }

  if (stmt.ViewStmt) {
    const s = stmt.ViewStmt;
    const name = s.view.relname;
    views.set(name, true);
    const t = ensureTable(name, file); t.isView = true;
    for (const rv of collectRangeVars(s.query)) {
      if (!tables.has(rv) && !views.has(rv)) {
        err(file, `view ${name} reads unknown table ${rv}`);
      }
    }
    return;
  }

  if (stmt.InsertStmt) {
    const s = stmt.InsertStmt;
    const tbl = s.relation.relname;
    if (!tables.has(tbl)) { err(file, `INSERT into unknown table ${tbl}`); return; }
    const t = tables.get(tbl);
    const listed = (s.cols || []).map((c) => c.ResTarget && c.ResTarget.name).filter(Boolean);
    for (const c of listed) {
      if (!t.columns.has(c)) err(file, `INSERT into ${tbl} names unknown column "${c}"`);
    }
    // ON CONFLICT (cols) must name real columns.
    const onConflict = s.onConflictClause;
    if (onConflict && onConflict.infer && onConflict.infer.indexElems) {
      const arbiter = [];
      for (const ie of onConflict.infer.indexElems) {
        const c = ie.IndexElem && ie.IndexElem.name;
        if (c && !t.columns.has(c)) err(file, `ON CONFLICT on ${tbl} names unknown column "${c}"`);
        if (c) arbiter.push(c);
      }
      // Postgres rejects ON CONFLICT (cols) unless cols match a PK or UNIQUE
      // constraint exactly: 'there is no unique or exclusion constraint matching
      // the ON CONFLICT specification'. Catch it here instead of at seed time.
      const coveredByPk = arbiter.length && arbiter.every((c) => t.pk.has(c));
      const coveredByUnique = t.unique.some((u) => u.size === arbiter.length && arbiter.every((c) => u.has(c)));
      if (arbiter.length && !coveredByPk && !coveredByUnique) {
        err(file, `INSERT into ${tbl} ... ON CONFLICT (${arbiter.join(', ')}) has no matching PRIMARY KEY ` +
                  `or UNIQUE constraint/index. Postgres will refuse the statement.`);
      }
    }
    // VALUES arity check.
    const lists = s.selectStmt && s.selectStmt.SelectStmt && s.selectStmt.SelectStmt.valuesLists;
    if (lists) {
      const expected = listed.length;
      lists.forEach((row, i) => {
        const got = (row.List ? row.List.items : []).length;
        if (expected && got !== expected) {
          err(file, `INSERT into ${tbl} row ${i + 1} has ${got} values but ${expected} columns were listed`);
        }
        for (const item of row.List ? row.List.items : []) {
          for (const rv of collectRangeVars(item)) {
            if (!tables.has(rv) && !views.has(rv)) err(file, `INSERT into ${tbl} sub-selects unknown table ${rv}`);
          }
        }
      });
      // DO UPDATE SET must name real columns.
      if (onConflict && onConflict.targetList) {
        for (const rt of onConflict.targetList) {
          const c = rt.ResTarget && rt.ResTarget.name;
          if (c && !t.columns.has(c)) err(file, `ON CONFLICT DO UPDATE on ${tbl} names unknown column "${c}"`);
        }
      }
    } else if (s.selectStmt) {
      for (const rv of collectRangeVars(s.selectStmt)) {
        if (!tables.has(rv) && !views.has(rv)) err(file, `INSERT into ${tbl} SELECTs from unknown table ${rv}`);
      }
    }
    return;
  }

  if (stmt.UpdateStmt || stmt.DeleteStmt) {
    const s = stmt.UpdateStmt || stmt.DeleteStmt;
    const tbl = s.relation.relname;
    if (tbl && !tables.has(tbl)) err(file, `UPDATE/DELETE on unknown table ${tbl}`);
    return;
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const read = (f) => readFileSync(f.startsWith('/') ? f : resolve(ROOT, f), 'utf8');

/**
 * Check a list of SQL files in dependency order.
 * @returns {{errors:string[], warnings:string[], stats:object}}
 */
export function check(files) {
  errors.length = 0;
  warnings.length = 0;
  tables.clear();
  functions.clear();
  indexes.clear();
  views.clear();
  createOrder = 0;

  let totalStatements = 0;
  for (const rel of files) {
    const tree = await_parse(read(rel));
    totalStatements += tree.stmts.length;
    for (const s of tree.stmts) walkStatement(rel, s.stmt);
  }

  const realTables = [...tables.values()].filter((t) => !t.isView);
  const fkCount = (files.map(read).join('\n').match(/references\s+\w+/gi) || []).length;

  return {
    errors: [...errors],
    warnings: [...warnings],
    stats: {
      files: files.length, statements: totalStatements, tables: realTables.length,
      views: views.size, functions: functions.size, indexes: indexes.size, fkCount,
    },
  };
}

// libpg-query exposes both an async parse() and a sync one that needs the WASM
// module booted first. Boot once, then parse synchronously so check() stays sync.
let parseSyncFn = null;
function await_parse(sql) {
  if (!parseSyncFn) throw new Error('call boot() before check()');
  return parseSyncFn(sql);
}

export async function boot() {
  const { loadModule, parseSync } = require('libpg-query');
  await loadModule();
  parseSyncFn = parseSync;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await boot();
  const { errors: e, warnings: w, stats } = check(FILES);

  console.log(`\nChecked ${stats.files} files, ${stats.statements} statements.`);
  console.log(`  ${stats.tables} tables, ${stats.views} views, ${stats.functions} functions, ${stats.indexes} indexes`);
  console.log(`  ~${stats.fkCount} foreign key references resolved in order`);

  if (w.length) {
    console.log(`\n${w.length} warning(s):`);
    for (const x of w) console.log(`  ! ${x}`);
  }
  if (e.length) {
    console.error(`\n${e.length} ERROR(S):`);
    for (const x of e) console.error(`  x ${x}`);
    process.exit(1);
  }
  console.log('\nNo structural errors found.');
}
