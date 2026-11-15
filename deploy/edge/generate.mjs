#!/usr/bin/env node
/**
 * Renders the FreeRADIUS configuration for a Wavly WiFi edge node.
 *
 *   node deploy/edge/generate.mjs --env-file /etc/wavly/edge.env [--out DIR]
 *                                 [--stdout] [--check]
 *
 * Templates live in deploy/edge/freeradius/ and carry @@TOKENS@@. This script
 * substitutes them from the environment and writes real config files.
 *
 * WHY THE OUTPUT IS NOT COMMITTED
 * Unlike the MikroTik script (deploy/mikrotik/generated/), the rendered output
 * here contains the edge database password and the RADIUS shared secret. So it
 * goes to deploy/edge/local/, which .gitignore excludes, and the templates -
 * which contain no secrets - are what you review.
 *
 * WHAT IT REFUSES TO DO
 *   * leave any @@TOKEN@@ unsubstituted. A half-rendered FreeRADIUS config does
 *     not fail at parse time in an obvious way; `password = "@@EDGE_DB_PASSWORD@@"`
 *     is a perfectly valid string, and the server starts and then cannot reach
 *     the database. Failing here turns a confusing outage into a clear error.
 *   * write a secret to stdout, unless --stdout is explicitly combined with
 *     --allow-secrets-on-stdout. Printing a secret into a terminal scrollback, a
 *     CI log, or a shell history file is how secrets end up in git later.
 *   * invent a RADIUS secret. If nas_devices.shared_secret_ref names an env var
 *     that is unset, that is an error, not a default.
 */

import { readFile, writeFile, mkdir, readdir, chmod } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSeed } from '../mikrotik/lib/seed.mjs';
import { renderRateLimit } from '../mikrotik/lib/rate-limit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------
function usage(code = 1) {
  process.stderr.write(`Usage: node deploy/edge/generate.mjs [options]

Options:
  --env-file PATH   Read KEY=VALUE pairs from PATH (e.g. /etc/wavly/edge.env).
                    The real process environment always wins over the file.
  --out DIR         Output directory (default: deploy/edge/local, gitignored)
  --stdout          Print the rendered files to stdout instead of writing them.
                    Refuses to do so when the output contains secrets unless
                    --allow-secrets-on-stdout is also given.
  --allow-secrets-on-stdout
                    Explicitly permit printing secrets. For piping into a
                    remote file, not for reading.
  --seed PATH       Seed SQL (default: db/seed/0001_core_defaults.sql)
  --check           After rendering, run "freeradius -XC" on the output if the
                    binary is available, and statically cross-check the config.
  -h, --help        This text
`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const opts = { envFile: null, out: null, stdout: false, allowSecrets: false, seed: null, check: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    const v = argv[++i];
    if (v === undefined) { process.stderr.write(`error: ${a} needs a value\n`); usage(); }
    return v;
  };
  switch (a) {
    case '-h': case '--help': usage(0); break;
    case '--env-file': opts.envFile = next(); break;
    case '--out': opts.out = next(); break;
    case '--stdout': opts.stdout = true; break;
    case '--allow-secrets-on-stdout': opts.allowSecrets = true; break;
    case '--seed': opts.seed = next(); break;
    case '--check': opts.check = true; break;
    default: process.stderr.write(`error: unknown option ${a}\n`); usage();
  }
}

const outDir = resolve(repoRoot, opts.out ?? 'deploy/edge/local');
const frRoot = resolve(here, 'freeradius');

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------
/**
 * Parse a shell-style env file. Only KEY=VALUE lines; comments and `export` are
 * tolerated because /etc/wavly/edge.env is also sourced by the syncd unit.
 */
async function readEnvFile(path) {
  const env = {};
  if (!path) return env;
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (e) { throw new Error(`cannot read --env-file ${path}: ${e.message}`); }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    // Strip one layer of matching quotes, as a shell would.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

const fileEnv = await readEnvFile(opts.envFile);
/** Real environment wins, so a one-off override does not need an edited file. */
const env = { ...fileEnv, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) };

const need = (key, what) => {
  const v = env[key];
  if (v === undefined || v === '') {
    throw new Error(`${key} is required (${what}) but is empty or unset. Put it in ${opts.envFile || 'the environment'}.`);
  }
  return v;
};

/** First non-empty of the given names, or null. */
const firstOf = (...keys) => {
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v !== '') return v;
  }
  return null;
};

/**
 * Decompose EDGE_DATABASE_URL into the five fields the sql module needs.
 *
 * .env.example documents EDGE_DATABASE_URL because syncd connects with it too.
 * Asking the operator to also write the same host, port, user and password as
 * four separate variables in the SAME file means the same secret twice — and the
 * day one is rotated and the other is not, FreeRADIUS loses its database while
 * syncd keeps working, which reads as "RADIUS is broken" rather than "these two
 * disagree".
 *
 * The discrete EDGE_DB_* variables remain as a fallback for a socket-authenticated
 * or otherwise unusual local setup.
 */
function dbConfig() {
  const url = env.EDGE_DATABASE_URL;
  if (url) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      throw new Error(`EDGE_DATABASE_URL is not a parseable URL: ${e.message}`);
    }
    if (!/^postgres(ql)?:$/.test(u.protocol)) {
      throw new Error(`EDGE_DATABASE_URL must be a postgres:// URL, got '${u.protocol}'`);
    }
    if (!u.hostname) throw new Error('EDGE_DATABASE_URL has no host');
    // Percent-encoded passwords are the normal case for anything with punctuation.
    const password = decodeURIComponent(u.password || '');
    if (!u.username) throw new Error('EDGE_DATABASE_URL has no user');
    if (!password) {
      throw new Error(
        'EDGE_DATABASE_URL has no password. Local Postgres may be configured for peer ' +
        'authentication, but FreeRADIUS connects over TCP as the `radius` role and needs ' +
        'one; without it the sql module fails to open a connection and every login is rejected.'
      );
    }
    return {
      host: u.hostname,
      port: u.port || '5432',
      name: (u.pathname || '/').replace(/^\//, '') || 'wavly_edge',
      user: decodeURIComponent(u.username),
      password,
      source: 'EDGE_DATABASE_URL',
    };
  }

  // Neither form was given. Name both, because an operator reading
  // "EDGE_DB_HOST is required" while .env.example shows EDGE_DATABASE_URL would
  // reasonably conclude the two files disagree - which, until this message, they
  // did.
  if (!env.EDGE_DB_HOST) {
    throw new Error(
      `the local database is not configured. Set EDGE_DATABASE_URL (the form ` +
      `.env.example documents, and the one syncd uses too), or the discrete ` +
      `EDGE_DB_HOST / EDGE_DB_PORT / EDGE_DB_NAME / EDGE_DB_USER / EDGE_DB_PASSWORD ` +
      `variables. Put it in ${opts.envFile || 'the environment'}.`
    );
  }

  const host = need('EDGE_DB_HOST', 'the local Postgres host');
  const password = need('EDGE_DB_PASSWORD', 'the RADIUS database password');
  return {
    host,
    port: env.EDGE_DB_PORT || '5432',
    name: env.EDGE_DB_NAME || 'wavly_edge',
    user: need('EDGE_DB_USER', 'the RADIUS database role'),
    password,
    source: 'EDGE_DB_* variables',
  };
}

/** like need(), but for a value that may come from one of several names. */
function missing(key, what) {
  throw new Error(`${key} is required (${what}) but is empty or unset. Put it in ${opts.envFile || 'the environment'}.`);
}

function isSecretToken(token) {
  return /PASSWORD|SECRET|DB_/.test(token);
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------
const seed = await loadSeed(opts.seed ? resolve(repoRoot, opts.seed) : undefined);
if (!seed.nasDevices.length) {
  throw new Error('the seed contains no nas_devices rows; nothing to render clients.conf for');
}

/**
 * Resolve a shared_secret_ref pointer.
 *
 * The ref is "edge:env:RADIUS_SECRET_NKAWIE01" - a POINTER to where the secret
 * lives, never the secret. That is what lets a nightly pg_dump, copied off-site,
 * contain no credential that would let someone authenticate any user they like.
 */
function resolveSecretRef(ref, nasName) {
  if (typeof ref !== 'string') {
    throw new Error(`nas_devices '${nasName}' has no shared_secret_ref`);
  }
  const m = /^edge:env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref.trim());
  if (!m) {
    throw new Error(
      `nas_devices '${nasName}' has shared_secret_ref '${ref}', which is not of the ` +
      `form 'edge:env:VAR_NAME'. If this value is a literal secret, remove it from ` +
      `the database: it would be copied into every nightly backup.`
    );
  }
  const v = env[m[1]];
  if (!v) throw new Error(`${m[1]} (referenced by nas_devices '${nasName}') is empty or unset`);
  // Fatal, not a warning. The RADIUS shared secret is the only thing standing
  // between someone on the management network and a forged Access-Accept (see
  // Blast-RADIUS, CVE-2024-3596). A short secret can be recovered offline from a
  // single captured packet, and after that the attacker can log any user in or
  // disconnect any user at will. There is no operational reason to accept a weak
  // one, so the generator refuses rather than letting a warning scroll by.
  if (v.length < 22) {
    throw new Error(
      `${m[1]} is only ${v.length} characters. A RADIUS shared secret must be at ` +
      `least 22 characters (32+ random characters recommended): a short one can be ` +
      `recovered offline from a single captured packet, after which anyone on the ` +
      `management network can forge Access-Accepts.`
    );
  }
  return v;
}

/** The staff/local-admin rate limit, rendered from the seed like everything else. */
function localAdminRateLimit() {
  const name = env.EDGE_LOCAL_ADMIN_RATE_PROFILE || 'p-20-10';
  const profile = seed.rateProfiles.find((p) => p.name === name);
  if (!profile) {
    throw new Error(`EDGE_LOCAL_ADMIN_RATE_PROFILE='${name}' does not match any active rate profile`);
  }
  return renderRateLimit(profile).value;
}

// ---------------------------------------------------------------------------
// token table
// ---------------------------------------------------------------------------
function buildTokens() {
  const db = dbConfig();
  const active = seed.nasDevices.filter((n) => n.status !== 'retired');

  /** One `client` block per router. */
  const clients = active.map((n) => {
    const secret = resolveSecretRef(n.shared_secret_ref, n.name);
    const coa = n.coa_enabled !== false;
    const lines = [
      `# ${n.name} (${n.model || n.kind}, RouterOS ${n.routeros_version || '?'})`,
      `client ${n.shortname || n.name} {`,
      `\tipaddr = ${n.ip_address}`,
      `\tsecret = ${secret}`,
      `\tnas_type = other`,
      // Blast-RADIUS (CVE-2024-3596) mitigation. RouterOS 7.x DOES send
      // Message-Authenticator in Access-Requests, so requiring it costs nothing
      // and stops anyone who reaches UDP 1812 from forging a login.
      //
      // If this ever breaks every login on a router, the FreeRADIUS log says
      //   "BlastRADIUS check: Received packet without Message-Authenticator"
      // and the fix is to upgrade that router's firmware, not to set this to no.
      // Setting it to no re-opens the hole; the mgmt network is only as private
      // as the firewall rule that keeps customers off it.
      `\trequire_message_authenticator = yes`,
    ];
    if (coa) {
      // Points at this router's own home_server in sites-available/originate-coa.
      // Per-NAS on purpose: a shared pool of type fail-over would send CoA to the
      // first alive member, i.e. the wrong router half the time.
      lines.push(`\tcoa_server = ${n.shortname || n.name}-coa`);
    }
    lines.push(`}`);
    return lines.join('\n');
  });

  /** One CoA `home_server` per router, for originate-coa. */
  const homeServers = active
    .filter((n) => n.coa_enabled !== false)
    .map((n) => {
      const secret = resolveSecretRef(n.shared_secret_ref, n.name);
      const port = n.coa_port || env.RADIUS_COA_PORT || 3799;
      return [
        `# CoA/Disconnect destination for ${n.name} at ${n.ip_address}:${port}.`,
        `# The router's firewall accepts UDP ${port} from this edge node only - a CoA`,
        `# port reachable from the hotspot network would let any customer disconnect`,
        `# any other customer.`,
        `home_server ${n.shortname || n.name}-coa {`,
        `\ttype = coa`,
        `\tipaddr = ${n.ip_address}`,
        `\tport = ${port}`,
        `\tsecret = ${secret}`,
        `\t# Retransmission: RFC 5176 initial/max retransmit interval, max`,
        `\t# retransmit count, max retransmit duration (seconds).`,
        `\tcoa {`,
        `\t\tirt = 2`,
        `\t\tmrt = 16`,
        `\t\tmrc = 5`,
        `\t\tmrd = 30`,
        `\t}`,
        `\t# Mark it dead after this many seconds of silence, so a rebooting`,
        `\t# router does not make syncd queue CoA packets forever.`,
        `\tzombie_period = 30`,
        `}`,
      ].join('\n');
    });

  return {
    '@@CLIENTS@@': clients.join('\n\n'),
    '@@COA_HOME_SERVERS@@': homeServers.join('\n\n') || '# no NAS has CoA enabled',

    '@@EDGE_DB_HOST@@': db.host,
    '@@EDGE_DB_PORT@@': db.port,
    '@@EDGE_DB_NAME@@': db.name,
    '@@EDGE_DB_USER@@': db.user,
    '@@EDGE_DB_PASSWORD@@': db.password,

    // Bound to the management address, not *, so a second interface on this box
    // can never expose an authentication service to customers by accident.
    // RADIUS_BIND_ADDRESS is the name .env.example documents and syncd also
    // reads; EDGE_LISTEN_ADDRESS is accepted as an alias.
    '@@EDGE_LISTEN_ADDRESS@@': firstOf('RADIUS_BIND_ADDRESS', 'EDGE_LISTEN_ADDRESS')
      ?? missing('RADIUS_BIND_ADDRESS', 'the edge node address on the management network, e.g. 192.168.88.10'),

    // Ports are configurable because a node that cannot bind 1812 (another
    // service, or a second RADIUS instance during a migration) should not require
    // editing a template.
    '@@RADIUS_AUTH_PORT@@': env.RADIUS_AUTH_PORT || '1812',
    '@@RADIUS_ACCT_PORT@@': env.RADIUS_ACCT_PORT || '1813',

    '@@LOCAL_ADMIN_PASSWORD@@': need('EDGE_LOCAL_ADMIN_PASSWORD', 'the emergency local operator password'),
    '@@LOCAL_ADMIN_EXPIRES@@': env.EDGE_LOCAL_ADMIN_EXPIRES || defaultExpiry(),
    '@@LOCAL_ADMIN_RATE_LIMIT@@': localAdminRateLimit(),
  };
}

/**
 * The Expiration attribute wants "dd Mmm yyyy". Default to 90 days out: an
 * emergency account that never expires is a standing backdoor, and 90 days is
 * long enough to survive a forgotten rotation and short enough to matter.
 */
function defaultExpiry() {
  const d = new Date(Date.now() + 90 * 86400 * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// walk and render
// ---------------------------------------------------------------------------
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

async function renderAll() {
  const tokens = buildTokens();
  /** @type {Array<{rel: string, dest: string, body: string, hadSecrets: boolean}>} */
  const rendered = [];

  for (const path of await collect(frRoot)) {
    const rel = relative(frRoot, path);
    const src = await readFile(path, 'utf8');
    let body = src;
    let hadSecrets = false;

    for (const [token, value] of Object.entries(tokens)) {
      if (!body.includes(token)) continue;
      if (isSecretToken(token)) hadSecrets = true;
      body = body.split(token).join(value);
    }

    // A leftover token is a config that will start and then not work.
    const leftover = body.match(/@@[A-Z0-9_]+@@/g);
    if (leftover) {
      throw new Error(`${rel}: unrendered token(s) ${[...new Set(leftover)].join(', ')}`);
    }

    // .tmpl files lose the suffix on the way out; clients.conf.tmpl -> clients.conf
    const dest = rel.endsWith('.tmpl') ? rel.slice(0, -'.tmpl'.length) : rel;
    rendered.push({ rel, dest, body, hadSecrets });
  }

  return { rendered, tokens };
}

async function collect(root) {
  const out = [];
  for await (const p of walk(root)) out.push(p);
  return out;
}

const { rendered } = await renderAll();
const anySecrets = rendered.some((r) => r.hadSecrets);

// ---------------------------------------------------------------------------
// static cross-checks
// ---------------------------------------------------------------------------
/**
 * Drop whole-line `#` comments, so checks match what the server will actually
 * parse rather than what the file says about itself.
 *
 * These config files are heavily commented on purpose (they are the runbook), and
 * several comments quote the very string a check is looking for. Without this, a
 * documented example of a mistake is reported as the mistake.
 */
function codeOnly(text) {
  return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

/**
 * Checks that cost nothing and catch the mistakes a syntax check cannot:
 * a site that calls a policy which was never defined, or a token that was
 * substituted into a place that changes the server's behaviour.
 */
function staticCheck(files) {
  const problems = [];
  const byDest = new Map(files.map((f) => [f.dest, f.body]));

  const site = codeOnly(byDest.get('sites-available/wavly') || '');
  const policies = codeOnly(byDest.get('policy.d/wavly') || '');
  const mods = codeOnly(byDest.get('mods-available/wavly') || '');
  const sql = codeOnly(byDest.get('mods-available/sql') || '');

  // Every `wavly-*` name invoked in the site must be defined SOMEWHERE. It may be
  // a policy (policy.d/wavly) or a module instance (mods-available/wavly) - e.g.
  // wavly-detail is a `detail` instance, not a policy. Checking only policy.d
  // reported a false failure for it; checking neither would miss the real one
  // (a typo'd policy name stops the server starting).
  const invoked = new Set([...site.matchAll(/^\s*(wavly-[a-z-]+)\s*$/gm)].map((m) => m[1]));
  const definedPolicies = new Set([...policies.matchAll(/^([a-z-]+)\s*=\s*policy\s*\{/gm)].map((m) => m[1]));
  const definedInstances = new Set(
    [...mods.matchAll(/^\s*[a-z_]+\s+(wavly-[a-z-]+)\s*\{/gm)].map((m) => m[1])
  );
  const defined = new Set([...definedPolicies, ...definedInstances]);
  for (const name of invoked) {
    if (!defined.has(name)) {
      problems.push(`sites-available/wavly calls '${name}', which neither policy.d/wavly nor mods-available/wavly defines. FreeRADIUS will refuse to start.`);
    }
  }
  for (const name of definedPolicies) {
    if (!invoked.has(name)) {
      problems.push(`policy '${name}' is defined but never called - dead config, or a missing line in the site.`);
    }
  }

  // Module instances referenced by the site must exist somewhere.
  for (const inst of ['wavly-detail', 'wavly-mac-missing']) {
    const inSite = site.includes(inst);
    const inMods = mods.includes(inst);
    if (inSite && !inMods) {
      problems.push(`the site references module instance '${inst}' but mods-available/wavly does not define it.`);
    }
  }

  // The password redaction must actually be in place. This is the single most
  // important line in the whole edge configuration: without it every customer's
  // Wi-Fi password is written to radpostauth in cleartext.
  // Comment lines must be excluded from these two checks. queries.conf documents
  // what the UPSTREAM query was (a line containing the original password
  // interpolation) so a reader can diff the two; matching that comment produced a
  // false "still interpolates User-Password" failure. Matching only real config
  // lines means the positive check ('REDACTED' present) and the negative check
  // (password interpolation absent) both test what actually runs.
  const queries = codeOnly(byDest.get('mods-config/sql/main/postgresql/queries.conf') || '');
  if (!queries.includes("'REDACTED'")) {
    problems.push("queries.conf does not contain the 'REDACTED' postauth override - customer passwords would be logged in cleartext.");
  }
  if (/User-Password\}:-%\{Chap-Password/.test(queries)) {
    problems.push('queries.conf still interpolates User-Password/Chap-Password into the post-auth INSERT.');
  }

  // read_clients must stay off, or the secret is in the database and therefore
  // in every off-site backup.
  if (!/read_clients\s*=\s*no/.test(sql)) {
    problems.push('mods-available/sql does not set read_clients = no; a RADIUS secret would end up in the database and in every backup.');
  }

  // No EAP, LDAP or unix authentication: each is an attack surface with no use here.
  for (const bad of ['\teap', '\tldap', '\tunix', '\tdigest']) {
    if (new RegExp(`^\\s*${bad.trim()}\\s*$`, 'm').test(site)) {
      problems.push(`sites-available/wavly enables '${bad.trim()}', which this deployment should not use.`);
    }
  }

  // The listeners must not be bound to *.
  if (/ipaddr\s*=\s*\*/.test(site)) {
    problems.push('a listener is bound to ipaddr = *; bind it to the management address instead.');
  }

  return problems;
}

const problems = staticCheck(rendered);
if (problems.length) {
  process.stderr.write(`\nstatic check found ${problems.length} problem(s):\n`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------
if (opts.stdout) {
  if (anySecrets && !opts.allowSecrets) {
    process.stderr.write(
      `error: the rendered configuration contains secrets (the edge database password ` +
      `and RADIUS shared secrets), and --stdout was given without ` +
      `--allow-secrets-on-stdout.\n` +
      `       Printing a secret into a terminal, a CI log, or shell history is how it ` +
      `ends up committed later.\n` +
      `       Write to a directory instead, or pass --allow-secrets-on-stdout if you ` +
      `are piping it somewhere deliberate.\n`
    );
    process.exit(2);
  }
  for (const f of rendered) {
    process.stdout.write(`\n===== ${f.dest} =====\n${f.body}\n`);
  }
} else {
  if (anySecrets) {
    // Belt and braces: the output directory is gitignored, but a local .gitignore
    // makes the intent explicit at the point where the secret lands, and survives
    // someone moving the directory.
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, '.gitignore'), '# Rendered config contains secrets. Never commit.\n*\n!.gitignore\n', 'utf8');
  }
  for (const f of rendered) {
    const p = join(outDir, f.dest);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, f.body, 'utf8');
    // 0640 root:freerad is what Debian expects for files containing secrets.
    // Best effort here; the provisioning script chowns after copying.
    try { await chmod(p, 0o640); } catch { /* non-fatal */ }
    // Show a repo-relative path when the output is inside the repo; an absolute
    // one otherwise, because "../../tmp/..." is not a path anyone can use.
    const rel = relative(repoRoot, p);
    process.stdout.write(`wrote ${rel.startsWith('..') ? p : rel}\n`);
  }
  await writeFile(join(outDir, 'README.txt'), renderInstallNotes(rendered), 'utf8');
}

if (opts.check) {
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('freeradius', ['-XC'], { cwd: outDir, stdio: 'inherit' });
  } catch (e) {
    if (e.code === 'ENOENT') {
      process.stderr.write('note: freeradius binary not found; skipped -XC validation. Run it on the edge node.\n');
    } else {
      process.stderr.write('freeradius -XC rejected the rendered configuration\n');
      process.exit(3);
    }
  }
}

process.stdout.write(`\n${rendered.length} file(s) rendered, static checks passed.\n`);

function renderInstallNotes(files) {
  const raddb = '/etc/freeradius/3.0';
  return [
    `RENDERED FREERADIUS CONFIGURATION - CONTAINS SECRETS`,
    `Do not commit this directory and do not copy it off the edge node.`,
    ``,
    `Generated ${new Date().toISOString()} by deploy/edge/generate.mjs`,
    `Templates: deploy/edge/freeradius/    Environment: ${opts.envFile || 'process environment'}`,
    ``,
    `1. COPY (paths below are relative to ${raddb} unless stated)`,
    ...files.map((f) => `     ${f.dest}`),
    ``,
    `   dictionary.wavly is NOT a raddb path. Copy it to`,
    `   /usr/share/freeradius/dictionary.wavly and add one line to ${raddb}/dictionary:`,
    `       $INCLUDE /usr/share/freeradius/dictionary.wavly`,
    ``,
    `2. ENABLE MODULES (symlinks into mods-enabled/)`,
    `   Ours:`,
    `       ln -s ../mods-available/sql    mods-enabled/sql`,
    `       ln -s ../mods-available/wavly  mods-enabled/wavly`,
    `   Stock, required by sites-available/wavly:`,
    `       ln -s ../mods-available/pap         mods-enabled/pap`,
    `       ln -s ../mods-available/chap        mods-enabled/chap`,
    `       ln -s ../mods-available/mschap      mods-enabled/mschap`,
    `       ln -s ../mods-available/files       mods-enabled/files`,
    `       ln -s ../mods-available/preprocess  mods-enabled/preprocess`,
    `       ln -s ../mods-available/acct_unique mods-enabled/acct_unique`,
    `       ln -s ../mods-available/attr_filter mods-enabled/attr_filter`,
    `       ln -s ../mods-available/expiration  mods-enabled/expiration`,
    `       ln -s ../mods-available/detail.log  mods-enabled/detail.log`,
    ``,
    `   The last two are easy to miss and both fail confusingly:`,
    `     * expiration enforces subscription end dates. Without it an expired`,
    `       customer keeps logging in, and nothing logs an error - the policy`,
    `       simply has no module to call.`,
    `     * detail.log defines the reply_log instance used in post-auth. Without`,
    `       it the server refuses to start with "Failed to find module reply_log".`,
    ``,
    `3. ENABLE SITES`,
    `       ln -s ../sites-available/wavly         sites-enabled/wavly`,
    `       ln -s ../sites-available/originate-coa sites-enabled/originate-coa`,
    `       rm -f sites-enabled/default`,
    `       rm -f sites-enabled/inner-tunnel`,
    ``,
    `   Removing default matters: leaving it enabled means the stock site also`,
    `   listens on 1812/1813 and loads EAP, LDAP and unix authentication - i.e. a`,
    `   local shell account on this box becomes a Wi-Fi credential.`,
    ``,
    `4. BLAST-RADIUS (CVE-2024-3596) IN radiusd.conf`,
    `   radiusd.conf is package-managed, so it is NOT rendered here. Add to its`,
    `   security { } section:`,
    `       require_message_authenticator = auto`,
    `       limit_proxy_state = auto`,
    ``,
    `5. OWNERSHIP, PERMISSIONS, START`,
    `       chown -R root:freerad ${raddb}`,
    `       chmod 0640 ${raddb}/clients.conf ${raddb}/mods-available/sql`,
    `       freeradius -XC      # parse check. Fix EVERYTHING it reports before`,
    `                           # starting: a server that half-parses will reject`,
    `                           # every login and log something unrelated.`,
    `       systemctl restart freeradius`,
    `       systemctl status freeradius`,
    ``,
    `6. VERIFY (do not skip - each of these fails silently in a different way)`,
    `   a. Login works end to end, and the router accepts the reply:`,
    `          radtest <user> <pass> ${firstOf('RADIUS_BIND_ADDRESS', 'EDGE_LISTEN_ADDRESS') || '<edge-ip>'} 0 <secret>`,
    `      then check the ROUTER's log, not just ours. If radtest says Access-Accept`,
    `      but the router says "missing message auth, dropping", step 2's post-auth`,
    `      Message-Authenticator block is not in effect.`,
    `   b. CoA reaches the router:`,
    `          bin/wv-coa disconnect --nas <router-ip> --user <user>`,
    `      Exit 0 = ACK. Exit 2 = NAK (our attributes are wrong). Exit 3 = no reply`,
    `      (firewall, or /radius incoming is not set accept=yes on the router).`,
    `   c. Confirm the shared secret is not in the database:`,
    `          psql -U postgres -d wavly_edge -c 'select nasname, secret from nas'`,
    `      The secret column must be empty or a placeholder. A real value there`,
    `      means read_clients was turned on, and every nightly off-site backup now`,
    `      contains the one credential that lets anyone authenticate any customer.`,
    ``,
  ].join('\n');
}
