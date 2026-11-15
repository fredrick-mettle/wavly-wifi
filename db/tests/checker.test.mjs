/**
 * Regression tests for db/scripts/check-schema.mjs.
 *
 * A static checker that has never been seen to fail is worthless — it may be
 * passing for the wrong reason. These fixtures each contain exactly one known
 * defect and assert the checker names it. `good.sql` asserts the checker does
 * NOT cry wolf, because a tool with false positives gets ignored the first time
 * it finds something real.
 *
 *   node --test db/tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, check } from '../scripts/check-schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name) => resolve(HERE, 'fixtures', name);
const REPO = resolve(HERE, '../..');

await boot();

// ---------------------------------------------------------------------------
// Each case: fixture file + a substring that MUST appear in one of the errors.
// ---------------------------------------------------------------------------
const BAD = [
  ['fk-forward-reference.sql',    'does not exist yet at this point in the file',
   'FK to a table created later in the same file'],
  ['fk-non-unique-target.sql',    'neither a PRIMARY KEY nor UNIQUE',
   'FK pointing at a column with no uniqueness guarantee'],
  ['fk-unknown-source-column.sql','FK source column b.nope does not exist',
   'ALTER TABLE ADD FOREIGN KEY naming a column the table does not have'],
  ['insert-arity.sql',            'has 2 values but 3 columns were listed',
   'INSERT whose VALUES row is the wrong length'],
  ['insert-unknown-column.sql',   'names unknown column "nope"',
   'INSERT naming a column that does not exist'],
  ['on-conflict-unknown-column.sql', 'DO UPDATE on t names unknown column "bogus"',
   'ON CONFLICT DO UPDATE SET on a column that does not exist'],
  ['index-unknown-column.sql',    'index t_bad references unknown column t.missing_col',
   'CREATE INDEX on a column that does not exist'],
  ['trigger-unknown-function.sql','calls undefined function nonexistent_fn()',
   'CREATE TRIGGER bound to a function that was never defined'],
  ['view-unknown-table.sql',      'view v reads unknown table ghost',
   'view joining a table that does not exist'],
  ['duplicate-table.sql',         'duplicate CREATE TABLE t',
   'the same table defined twice'],
  ['on-conflict-no-arbiter.sql',  'ON CONFLICT (name) has no matching PRIMARY KEY',
   'ON CONFLICT naming columns with no unique index behind them'],
];

for (const [file, needle, why] of BAD) {
  test(`flags: ${why}`, () => {
    const { errors } = check([fx(file)]);
    assert.ok(errors.length > 0, `expected at least one error from ${file}, got none`);
    const hit = errors.find((e) => e.includes(needle));
    assert.ok(hit, `expected an error containing ${JSON.stringify(needle)} from ${file}; got:\n  ${errors.join('\n  ')}`);
  });
}

test('accepts ON CONFLICT arbitrated by a UNIQUE INDEX, not just a table constraint', () => {
  // Column-level `unique` and `create unique index` are both valid arbiters.
  // Getting this wrong produced seven false positives on the real seed file.
  const { errors } = check([fx('on-conflict-unique-index.sql')]);
  assert.deepEqual(errors, [], `unique-index arbiter should be accepted:\n  ${errors.join('\n  ')}`);
});

test('does not cry wolf on a correct schema', () => {
  const { errors, stats } = check([fx('good.sql')]);
  assert.deepEqual(errors, [], `good.sql should be clean but produced:\n  ${errors.join('\n  ')}`);
  assert.equal(stats.tables, 4);
  assert.equal(stats.views, 1);
  assert.ok(stats.fkCount >= 3, 'good.sql has FKs the checker should have counted');
});

// ---------------------------------------------------------------------------
// The real schema. This is the assertion that matters in CI.
// ---------------------------------------------------------------------------
// Discovered, not hardcoded. A fixed list here is the same bug the checker had:
// adding db/migrations/0003 made both the checker and its tests silently skip it,
// while every run still reported "No structural errors found".
const discover = (dir) => {
  try {
    return readdirSync(resolve(REPO, dir))
      .filter((n) => n.endsWith('.sql'))
      .sort()
      .map((n) => resolve(REPO, dir, n));
  } catch { return []; }
};
const REAL = [...discover('db/migrations'), ...discover('db/seed')];

test('the checker sees every SQL file in the repository', () => {
  const expected = [
    ...discover('db/migrations'),
    ...discover('db/seed'),
  ];
  assert.ok(expected.length >= 4, `expected >=4 SQL files, found ${expected.length}`);
  assert.deepEqual(REAL, expected);
  // Specifically: the Phase 3 logic migration must be in scope. A checker that
  // skips it reports success while checking nothing.
  assert.ok(REAL.some((f) => f.endsWith('0003_edge_radius_logic.sql')),
    'db/migrations/0003_edge_radius_logic.sql is not being checked');
});

test('the real Wavly WiFi schema is structurally sound', () => {
  const { errors, stats } = check(REAL);
  assert.deepEqual(errors, [], `schema errors:\n  ${errors.join('\n  ')}`);

  // Guard rails: if these numbers move unexpectedly, a table or index was lost.
  assert.equal(stats.tables, 58, 'expected 42 cloud tables + 16 edge tables');
  assert.equal(stats.views, 4,
    'expected v_radius_authorization, v_customer_account, v_active_subscribers, wavly_open_sessions');
  assert.ok(stats.functions >= 12, `expected >=12 functions, got ${stats.functions}`);
  assert.ok(stats.fkCount >= 100, `expected >=100 FK references, got ${stats.fkCount}`);
  assert.ok(stats.indexes >= 80, `expected >=80 indexes, got ${stats.indexes}`);
});

test('cloud schema does not leak RADIUS tables, edge schema does not leak business tables', () => {
  // The two databases must stay separate: radcheck on Supabase, or orders on the
  // edge node, both indicate the boundary has been crossed by accident.
  const cloud = check([REAL[0]]);
  assert.deepEqual(cloud.errors, []);

  const cloudSrc = cloud.stats.tables;
  assert.ok(cloudSrc >= 40, 'cloud schema should define the business tables');

  // Re-check each file in isolation and look at what each one defines.
  const edge = check([REAL[1]]);
  assert.deepEqual(edge.errors, [], `edge schema errors:\n  ${edge.errors.join('\n  ')}`);
  // 9 stock FreeRADIUS tables (radacct, radcheck, radreply, radgroupcheck,
  // radgroupreply, radusergroup, nas, radpostauth, nasreload) + 7 Wavly edge
  // tables. nasreload was missing until Phase 3: it is the official 9th table and
  // both simul_* queries join it, so without it Simultaneous-Use enforcement
  // raises a SQL error on every Access-Request.
  assert.equal(edge.stats.tables, 16, 'expected 9 stock FreeRADIUS tables + 7 Wavly edge tables');
});
