#!/usr/bin/env node
/**
 * Generates the MikroTik RouterOS v7 configuration for a Wavly WiFi site.
 *
 *   node deploy/mikrotik/generate.mjs [--seed PATH] [--out PATH] [--stdout]
 *                                     [--radius-secret-env VAR]
 *
 * The router script is RENDERED, never pushed live (docs/decisions.md D12): a
 * tool that can reconfigure the router can also cut the only internet connection
 * a village has. Output is text you read, diff, and paste.
 *
 * Exit codes: 0 ok, 1 usage/read error, 2 the render produced warnings that were
 * not acknowledged with --allow-warnings. Failing loudly on a warning matters
 * because the things that warn here (an inverted uplink capacity, a portal
 * hostname colliding with the hotspot dns-name, a non-HTTPS captive API URL) all
 * produce a router configuration that loads cleanly and does not work.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSeed } from './lib/seed.mjs';
import { renderRouterConfig } from './lib/render-config.mjs';
import { renderHotspotFiles } from './lib/hotspot-files.mjs';
import { renderRateLimit } from './lib/rate-limit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function usage(code = 1) {
  process.stderr.write(`Usage: node deploy/mikrotik/generate.mjs [options]

Options:
  --seed PATH              Seed SQL to read config from
                           (default: db/seed/0001_core_defaults.sql)
  --out DIR                Output directory (default: deploy/mikrotik/generated)
  --stdout                 Print the router script to stdout and write nothing
  --allow-warnings         Exit 0 even when the render reports warnings
  --radius-secret-env VAR  Read the RADIUS shared secret from this env var and
                           substitute it into /radius add. Without this, a
                           placeholder is emitted and you set the secret in
                           WinBox - which is the recommended path, because a
                           generated file is a file that can end up in git.
  -h, --help               This text
`);
  process.exit(code);
}

/** Minimal argv parsing: no dependency, and errors must be obvious. */
function parseArgs(argv) {
  const opts = { seed: null, out: null, stdout: false, allowWarnings: false, radiusSecretEnv: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) { process.stderr.write(`error: ${a} needs a value\n`); usage(); }
      return v;
    };
    switch (a) {
      case '-h': case '--help': usage(0); break;
      case '--seed': opts.seed = next(); break;
      case '--out': opts.out = next(); break;
      case '--stdout': opts.stdout = true; break;
      case '--allow-warnings': opts.allowWarnings = true; break;
      case '--radius-secret-env': opts.radiusSecretEnv = next(); break;
      default: process.stderr.write(`error: unknown option ${a}\n`); usage();
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const seedPath = resolve(repoRoot, opts.seed ?? 'db/seed/0001_core_defaults.sql');
// NOT 'out/', 'dist/' or 'build/': those are conventional ignore patterns, and a
// generated router script that is silently untracked is one nobody reviews.
const outDir = resolve(repoRoot, opts.out ?? 'deploy/mikrotik/generated');

let seed;
try {
  seed = await loadSeed(seedPath);
} catch (e) {
  process.stderr.write(`error: could not read the seed at ${seedPath}\n  ${e.message}\n`);
  process.exit(1);
}

let radiusSecret = null;
if (opts.radiusSecretEnv) {
  radiusSecret = process.env[opts.radiusSecretEnv];
  if (!radiusSecret) {
    process.stderr.write(`error: --radius-secret-env ${opts.radiusSecretEnv} was given but that variable is empty or unset\n`);
    process.exit(1);
  }
  if (radiusSecret.length < 22) {
    process.stderr.write(`warning: RADIUS secret is only ${radiusSecret.length} chars. Use at least 32 random characters; this secret protects a channel that can disconnect every paying customer.\n`);
  }
}

const { script, warnings, manual } = renderRouterConfig(seed, { radiusSecret });

const siteCode = seed.sites[0]?.code || 'site';
// A filename containing "secret" is what .gitignore excludes, so a script that
// has had a real secret substituted into it cannot be committed by accident.
const routerName = radiusSecret
  ? `wavly-${siteCode}-router.secret.rsc`
  : `wavly-${siteCode}-router.rsc`;

const hotspot = renderHotspotFiles(seed, { warnings });

if (opts.stdout) {
  process.stdout.write(script);
} else {
  await mkdir(resolve(outDir, 'hotspot'), { recursive: true });
  await writeFile(resolve(outDir, routerName), `${script}\n`, 'utf8');
  for (const f of hotspot.files) {
    await writeFile(resolve(outDir, 'hotspot', f.name), f.body, 'utf8');
  }
  await writeFile(resolve(outDir, 'MANIFEST.md'), renderManifest(seed, routerName, hotspot, warnings, manual), 'utf8');
  process.stdout.write(`wrote ${resolve(outDir, routerName)}\n`);
  process.stdout.write(`wrote ${hotspot.files.length} hotspot page(s) to ${resolve(outDir, 'hotspot')}\n`);
  process.stdout.write(`wrote ${resolve(outDir, 'MANIFEST.md')}\n`);
}

if (warnings.length) {
  process.stderr.write(`\n${warnings.length} warning(s):\n`);
  for (const w of warnings) process.stderr.write(`  - ${w}\n`);
}
if (manual.length) {
  process.stderr.write(`\n${manual.length} step(s) that cannot be generated:\n`);
  for (const m of manual) process.stderr.write(`  - ${m}\n`);
}
if (warnings.length && !opts.allowWarnings && !opts.stdout) process.exit(2);

function renderManifest(sd, routerFile, hs, warns, man) {
  const site = sd.sites[0] || {};
  const lines = [
    `# Generated MikroTik configuration — ${site.name || 'Wavly WiFi'}`,
    ``,
    `Generated ${new Date().toISOString()} from \`db/seed/0001_core_defaults.sql\`.`,
    `Do not hand-edit these files: change the seed (or the database, then the seed)`,
    `and regenerate, so the router and the billing system cannot drift apart.`,
    ``,
    `## Files`,
    ``,
    `| File | What it is | Where it goes |`,
    `|---|---|---|`,
    `| \`${routerFile}\` | The full RouterOS script | Pasted into the router terminal, section by section |`,
    `| \`hotspot/*.html\` | The pages the router serves pre-authentication | Uploaded to \`flash/wavly/\` on the router |`,
    ``,
    `## What was rendered`,
    ``,
    `| Thing | Count |`,
    `|---|---|`,
    `| Rate profiles | ${sd.rateProfiles.length} |`,
    `| Plans | ${sd.plans.length} |`,
    `| Network rules | ${sd.networkRules.length} |`,
    `| Settings read | ${Object.keys(sd.settings).length} |`,
    ``,
    `## Plans and their rendered rate limits`,
    ``,
    `| Plan | Price | Rate profile | Mikrotik-Rate-Limit |`,
    `|---|---|---|---|`,
  ];
  for (const p of sd.plans) {
    const rp = sd.profileFor(p.rate_profile_name);
    const price = p.price_pesewas === 0 ? 'free' : `GH\u20b5${(p.price_pesewas / 100).toFixed(2)}`;
    lines.push(`| ${p.name} (\`${p.code}\`) | ${price} | \`${rp.name}\` | \`${renderRateLimit(rp).value}\` |`);
  }
  lines.push(``, `Mikrotik-Rate-Limit reads **upload first** (rx = client upload from the router's`, `point of view). A plan sold as "12 down / 6 up" renders \`6M/12M\`.`, ``);

  if (warns.length) {
    lines.push(`## Warnings`, ``, ...warns.map((w, i) => `${i + 1}. ${w}`), ``);
  }
  if (man.length) {
    lines.push(`## Manual steps`, ``, ...man.map((m) => `- [ ] ${m}`), ``);
  }
  lines.push(
    `## Applying it`,
    ``,
    `See \`deploy/mikrotik/README.md\`. In short: back up the router first, work over`,
    `ethernet or the management Wi-Fi (never over the hotspot network you are about`,
    `to change), paste one section at a time, and run the smoke test at the end of`,
    `the script.`,
    ``,
  );
  return lines.join('\n');
}
