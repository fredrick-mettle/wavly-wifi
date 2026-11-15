#!/usr/bin/env node
/**
 * Parse-validates SQL files against the real PostgreSQL grammar (libpg-query,
 * PG 18.2) without needing a live server.
 *
 *   node db/scripts/validate-sql.mjs db/migrations/*.sql db/seed/*.sql
 *
 * Catches: syntax errors, unbalanced parens, bad constraint definitions,
 * stray semicolons inside plpgsql bodies.
 * Does NOT catch: missing tables/columns, type mismatches, permission errors.
 * Those need a real database -- run `npm run db:migrate` against a scratch
 * Supabase project or local Postgres before deploying (see docs/07-deployment.md).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('libpg-query');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node db/scripts/validate-sql.mjs <file.sql> [...]');
  process.exit(2);
}

let failed = 0;

for (const file of files) {
  const path = resolve(file);
  const sql = readFileSync(path, 'utf8');
  try {
    const result = await parse(sql);
    const bytes = Buffer.byteLength(sql, 'utf8');
    console.log(`  ok   ${file}  (${result.stmts.length} statements, ${(bytes / 1024).toFixed(1)} kB)`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${file}`);
    console.error(`       ${err.message}`);
    if (err.position) {
      const upto = sql.slice(0, err.position);
      const line = upto.split('\n').length;
      const lines = sql.split('\n');
      const from = Math.max(0, line - 3);
      const to = Math.min(lines.length, line + 2);
      for (let i = from; i < to; i++) {
        console.error(`       ${String(i + 1).padStart(5)}${i + 1 === line ? '>' : ' '} ${lines[i]}`);
      }
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) failed to parse.`);
  process.exit(1);
}
console.log('\nAll files parse cleanly.');
