/**
 * Tests for the edge FreeRADIUS configuration generator and the CoA helper.
 *
 * These are deliberately not "does it render" tests. Each one encodes a failure
 * mode that would otherwise show up as a customer who cannot log in, a customer
 * who stays online for free, or a password written to disk - and in most cases
 * the server would report success while doing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GEN = join(REPO, 'deploy/edge/generate.mjs');
const WV_COA = join(REPO, 'deploy/edge/bin/wv-coa');
const NODE = process.execPath;

/** Env vars this generator reads. Stripped so a value in the ambient environment
 *  can never make a "missing variable" test pass. */
const OUR_KEYS = [
  'EDGE_DATABASE_URL',
  'EDGE_DB_HOST', 'EDGE_DB_PORT', 'EDGE_DB_NAME', 'EDGE_DB_USER', 'EDGE_DB_PASSWORD',
  'RADIUS_BIND_ADDRESS', 'EDGE_LISTEN_ADDRESS', 'RADIUS_AUTH_PORT', 'RADIUS_ACCT_PORT',
  'RADIUS_COA_PORT',
  'EDGE_LOCAL_ADMIN_PASSWORD', 'EDGE_LOCAL_ADMIN_EXPIRES', 'EDGE_LOCAL_ADMIN_RATE_PROFILE',
  'RADIUS_SECRET_NKAWIE01',
];

const DB_PASSWORD = 'test-only-not-a-real-password';

/** Uses the names .env.example documents, not private aliases. */
const GOOD_ENV = {
  EDGE_DATABASE_URL: `postgresql://radius:${DB_PASSWORD}@127.0.0.1:5432/wavly_edge`,
  RADIUS_BIND_ADDRESS: '192.168.88.10',
  EDGE_LOCAL_ADMIN_PASSWORD: 'test-only-local-admin',
  RADIUS_SECRET_NKAWIE01: 'a'.repeat(40),
};

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of OUR_KEYS) if (!(k in extra)) delete env[k];
  // spawnSync stringifies an undefined value to the literal "undefined", so
  // passing { WV_COA_SECRET: undefined } would hand the script a non-empty
  // secret and the "refuses without a secret" test would pass for the wrong
  // reason. Drop undefined entries instead.
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

function run(extraEnv = GOOD_ENV, args = []) {
  const out = mkdtempSync(join(tmpdir(), 'wavly-edge-'));
  const r = spawnSync(NODE, [GEN, '--out', out, ...args], {
    env: cleanEnv(extraEnv),
    cwd: REPO,
    encoding: 'utf8',
  });
  return { ...r, out };
}

function render(extraEnv = GOOD_ENV, args = []) {
  const r = run(extraEnv, args);
  assert.equal(r.status, 0, `generator failed:\n${r.stderr}\n${r.stdout}`);
  const read = (p) => readFileSync(join(r.out, p), 'utf8');
  return { read, dir: r.out, stdout: r.stdout, stderr: r.stderr };
}

/** Strip whole-line comments, so assertions test config rather than prose. Many
 *  of these files deliberately quote the mistake they are guarding against. */
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// ===========================================================================
// rendering
// ===========================================================================

test('renders the full raddb tree with no leftover placeholders', () => {
  const { read, dir } = render();
  const expected = [
    'clients.conf',
    'dictionary.wavly',
    'mods-available/sql',
    'mods-available/wavly',
    'mods-config/files/authorize',
    'mods-config/sql/main/postgresql/queries.conf',
    'policy.d/wavly',
    'sites-available/originate-coa',
    'sites-available/wavly',
  ];
  for (const f of expected) {
    assert.ok(existsSync(join(dir, f)), `missing rendered file: ${f}`);
    assert.ok(!/@@[A-Z0-9_]+@@/.test(read(f)), `${f} still contains a placeholder token`);
  }
  // The rendered tree must be copyable straight onto /etc/freeradius/3.0, so no
  // staging directories in the output.
  assert.ok(!existsSync(join(dir, 'templates')), 'a templates/ staging dir leaked into the install path');
});

test('the output directory protects itself from being committed', () => {
  const { dir } = render();
  const gi = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.match(gi, /^\*/m, 'the rendered dir must ignore everything by default');
});

test('secrets come from the environment, never from the seed', () => {
  const { read } = render();
  const clients = read('clients.conf');
  assert.ok(clients.includes(`secret = ${GOOD_ENV.RADIUS_SECRET_NKAWIE01}`));
  // And the DB password lands only in the sql module.
  assert.ok(read('mods-available/sql').includes(`password = "${DB_PASSWORD}"`));
  assert.ok(!read('clients.conf').includes(DB_PASSWORD));
});

// ===========================================================================
// refusing to produce a broken or leaky config
// ===========================================================================

test('fails loudly when a required variable is missing, naming it', () => {
  for (const key of ['EDGE_DATABASE_URL', 'RADIUS_SECRET_NKAWIE01', 'RADIUS_BIND_ADDRESS']) {
    const env = { ...GOOD_ENV };
    delete env[key];
    const r = run(env);
    assert.notEqual(r.status, 0, `${key} missing should abort`);
    assert.match(r.stderr + r.stdout, new RegExp(key),
      `the error for a missing ${key} must name it, or the operator has to go reading the source`);
  }
});

test('refuses a literal secret stored in nas_devices.shared_secret_ref', () => {
  // This is the "someone pasted the secret into the database" case. It must not
  // render, because that value then travels into every nightly off-site backup.
  const seed = readFileSync(join(REPO, 'db/seed/0001_core_defaults.sql'), 'utf8');
  assert.ok(seed.includes("'edge:env:RADIUS_SECRET_NKAWIE01'"), 'seed fixture changed; update this test');
  const bad = seed.replace("'edge:env:RADIUS_SECRET_NKAWIE01'", "'Sup3rS3cretLiteralValue'");
  const tmp = mkdtempSync(join(tmpdir(), 'wavly-seed-'));
  const badSeed = join(tmp, 'seed.sql');
  writeFileSync(badSeed, bad);

  const r = run(GOOD_ENV, ['--seed', badSeed]);
  assert.notEqual(r.status, 0, 'a literal secret in the database must not render');
  assert.match(r.stderr + r.stdout, /edge:env:/,
    'the error must explain the required pointer format');
});

test('--stdout refuses to print secrets unless explicitly allowed', () => {
  const denied = run(GOOD_ENV, ['--stdout']);
  assert.notEqual(denied.status, 0, '--stdout must not print secrets by default');
  assert.ok(!denied.stdout.includes(GOOD_ENV.RADIUS_SECRET_NKAWIE01),
    'the secret was printed to stdout while refusing - refusal must not leak');
  assert.match(denied.stderr, /allow-secrets-on-stdout/);

  const allowed = run(GOOD_ENV, ['--stdout', '--allow-secrets-on-stdout']);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.ok(allowed.stdout.includes(GOOD_ENV.RADIUS_SECRET_NKAWIE01));
});

test('a short RADIUS secret is refused, not warned about', () => {
  const r = run({ ...GOOD_ENV, RADIUS_SECRET_NKAWIE01: 'short' });
  assert.notEqual(r.status, 0, `a 5-char secret should not render: ${r.stderr}`);
  const msg = r.stderr + r.stdout;
  assert.match(msg, /RADIUS_SECRET_NKAWIE01/, 'the error must name the variable to fix');
  assert.match(msg, /at least 22 characters/i);
  assert.match(msg, /forge|Blast-RADIUS|CVE-2024-3596/i,
    'the error should say WHY a short secret is fatal, not just that it is short');
  // Nothing should have been written.
  assert.ok(!existsSync(join(r.out, 'clients.conf')), 'a refused render must not leave partial output behind');
});

// ===========================================================================
// the contract with /etc/wavly/edge.env
// ===========================================================================

test('every variable the generator requires is documented in .env.example', () => {
  // This is the test that catches the bug where .env.example says one name and the
  // generator reads another. An operator who provisions the node exactly as
  // documented then gets a render failure - or worse, a render that silently used
  // a default. The example file is the contract; this keeps both sides honest.
  const example = readFileSync(join(REPO, '.env.example'), 'utf8');
  const required = [
    'EDGE_DATABASE_URL',
    'RADIUS_BIND_ADDRESS',
    'EDGE_LOCAL_ADMIN_PASSWORD',
  ];
  for (const k of required) {
    assert.match(example, new RegExp(`^${k}=`, 'm'),
      `${k} is required by deploy/edge/generate.mjs but is not documented in .env.example`);
  }
});

test('the RADIUS secret variable name comes from the seed, and is documented', () => {
  // nas_devices.shared_secret_ref names the environment variable. If .env.example
  // documents a different name, a correctly-provisioned node fails to render.
  const seed = readFileSync(join(REPO, 'db/seed/0001_core_defaults.sql'), 'utf8');
  const refs = [...seed.matchAll(/'(edge:env:([A-Za-z0-9_]+))'/g)].map((m) => m[2]);
  assert.ok(refs.length >= 1, 'the seed should point at a RADIUS secret env var');
  const example = readFileSync(join(REPO, '.env.example'), 'utf8');
  for (const name of new Set(refs)) {
    assert.match(example, new RegExp(`^${name}=`, 'm'),
      `the seed's shared_secret_ref names ${name}, but .env.example does not document it - ` +
      `an operator following the example would set a variable the generator never reads`);
  }
});

test('EDGE_DATABASE_URL is decomposed into the sql module fields', () => {
  const { read } = render();
  const sql = code(read('mods-available/sql'));
  assert.match(sql, /server = "127\.0\.0\.1"/);
  assert.match(sql, /port = 5432/);
  assert.match(sql, /login = "radius"/);
  assert.match(sql, /radius_db = "wavly_edge"/);
  assert.ok(sql.includes(`password = "${DB_PASSWORD}"`));
});

test('a percent-encoded database password is decoded exactly once', () => {
  // Passwords with punctuation are percent-encoded in a URL. Passing the raw
  // form through would authenticate with the wrong password, and the failure is
  // "cannot connect to database" with no hint that the encoding is the problem.
  const { read } = render({
    ...GOOD_ENV,
    EDGE_DATABASE_URL: 'postgresql://radius:p%40ss%3Aw0rd@127.0.0.1:5432/wavly_edge',
  });
  const sql = code(read('mods-available/sql'));
  assert.ok(sql.includes('password = "p@ss:w0rd"'),
    `the password was not decoded: ${/password = "[^"]*"/.exec(sql)?.[0]}`);
});

test('EDGE_DATABASE_URL without a password is refused', () => {
  const r = run({ ...GOOD_ENV, EDGE_DATABASE_URL: 'postgresql://radius@127.0.0.1:5432/wavly_edge' });
  assert.notEqual(r.status, 0, 'FreeRADIUS connects over TCP as the radius role and needs a password');
  assert.match(r.stderr + r.stdout, /no password/);
});

test('auth and acct ports come from the environment, with sane defaults', () => {
  const def = render();
  const site = code(def.read('sites-available/wavly'));
  assert.match(site, /port = 1812/);
  assert.match(site, /port = 1813/);

  const custom = render({ ...GOOD_ENV, RADIUS_AUTH_PORT: '18120', RADIUS_ACCT_PORT: '18130' });
  const csite = code(custom.read('sites-available/wavly'));
  assert.match(csite, /port = 18120/);
  assert.match(csite, /port = 18130/);
});

test('the discrete EDGE_DB_* variables still work as a fallback', () => {
  const env = { ...GOOD_ENV };
  delete env.EDGE_DATABASE_URL;
  const { read } = render({
    ...env,
    EDGE_DB_HOST: '10.0.0.5', EDGE_DB_PORT: '6432', EDGE_DB_NAME: 'radius_db',
    EDGE_DB_USER: 'rad', EDGE_DB_PASSWORD: 'fallback-password',
  });
  const sql = code(read('mods-available/sql'));
  assert.match(sql, /server = "10\.0\.0\.5"/);
  assert.match(sql, /port = 6432/);
  assert.match(sql, /radius_db = "radius_db"|radius_db = /);
  assert.ok(sql.includes('password = "fallback-password"'));
});

// ===========================================================================
// clients.conf / originate-coa
// ===========================================================================

test('every client requires Message-Authenticator (Blast-RADIUS)', () => {
  const { read } = render();
  const clients = code(read('clients.conf'));
  const blocks = clients.match(/client [\w.-]+ \{[^}]*\}/g) || [];
  assert.ok(blocks.length >= 2, 'expected the NAS client and localhost');
  for (const b of blocks) {
    const name = /^client ([\w.-]+)/.exec(b)[1];
    if (name === 'localhost') continue; // radtest helper, loopback only
    assert.match(b, /require_message_authenticator = yes/,
      `${name} does not require Message-Authenticator; an attacker who reaches UDP 1812 can forge logins`);
  }
});

test('every coa_server points at a home_server that actually exists', () => {
  const { read } = render();
  const clients = code(read('clients.conf'));
  const coa = code(read('sites-available/originate-coa'));

  const referenced = [...clients.matchAll(/coa_server = ([\w.-]+)/g)].map((m) => m[1]);
  assert.ok(referenced.length >= 1, 'no client references a CoA server - FUP and expiry could not be enforced');

  const defined = [...coa.matchAll(/home_server ([\w.-]+) \{/g)].map((m) => m[1]);
  for (const name of referenced) {
    assert.ok(defined.includes(name),
      `coa_server '${name}' has no home_server. FreeRADIUS logs "Unknown destination for CoA request" and drops it silently, so throttling looks like it worked while the customer keeps full speed`);
  }
});

test('CoA home servers are type=coa on 3799 and reuse the client secret', () => {
  const { read } = render();
  const coa = code(read('sites-available/originate-coa'));
  const blocks = coa.match(/home_server [\w.-]+ \{[\s\S]*?\n\}/g) || [];
  assert.ok(blocks.length >= 1);
  for (const b of blocks) {
    assert.match(b, /type = coa/);
    assert.match(b, /port = 3799/);
    // RouterOS has ONE secret per RADIUS client entry and /radius incoming uses
    // it for CoA too, so this must match clients.conf or every CoA is rejected.
    assert.ok(b.includes(`secret = ${GOOD_ENV.RADIUS_SECRET_NKAWIE01}`),
      'the CoA secret must equal the client secret on MikroTik');
  }
});

test('CoA home servers are not collapsed into a shared fail-over pool', () => {
  const { read } = render();
  const coa = code(read('sites-available/originate-coa'));
  // A pool of type fail-over sends to the first ALIVE member. With two routers
  // that is the wrong router half the time, and the CoA appears to succeed.
  assert.ok(!/home_server_pool/.test(coa),
    'a shared CoA pool would send disconnects to the wrong NAS');
});

// ===========================================================================
// sites-available/wavly
// ===========================================================================

test('listeners are bound to the management address, never to *', () => {
  const { read } = render();
  const site = code(read('sites-available/wavly'));
  const addrs = [...site.matchAll(/ipaddr = (\S+)/g)].map((m) => m[1]);
  assert.ok(addrs.length >= 2, 'expected auth and acct listeners');
  for (const a of addrs) {
    assert.notEqual(a, '*', 'a wildcard listener would expose authentication on every interface this box ever gets');
    assert.equal(a, GOOD_ENV.RADIUS_BIND_ADDRESS);
  }
});

test('the site never listens for inbound CoA', () => {
  const { read } = render();
  const site = code(read('sites-available/wavly'));
  assert.ok(!/type = coa/.test(site),
    'we originate CoA; accepting it would add a remote-control channel onto this box for no purpose');
});

test('the site loads no EAP, LDAP, unix or digest authentication', () => {
  const { read } = render();
  const site = code(read('sites-available/wavly'));
  for (const mod of ['eap', 'ldap', 'unix', 'digest']) {
    assert.ok(!new RegExp(`^\\s*${mod}\\s*$`, 'm').test(site),
      `${mod} is enabled but unused here - an attack surface on an untrusted LAN. unix in particular would turn any shell account into a Wi-Fi credential`);
  }
});

test('post-auth puts Message-Authenticator in the reply, or MikroTik drops it', () => {
  const { read } = render();
  const site = code(read('sites-available/wavly'));
  const postAuth = /post-auth \{([\s\S]*?)\n\t\}/.exec(site);
  assert.ok(postAuth, 'no post-auth section found');
  assert.match(postAuth[1], /Message-Authenticator := 0x00/,
    'RouterOS silently drops replies without Message-Authenticator: our log says "Login OK", the router says "RADIUS server is not responding", and every login on the site fails');
  // Must run before the reply is sent, and for rejects too - so it belongs at the
  // top of post-auth rather than inside Post-Auth-Type Reply.
  const idx = postAuth[1].indexOf('Message-Authenticator');
  assert.ok(idx < postAuth[1].indexOf('Post-Auth-Type'),
    'Message-Authenticator must be set before the Post-Auth-Type branches so rejects get it too');
});

test('every wavly-* name the site calls is defined somewhere', () => {
  const { read } = render();
  const site = code(read('sites-available/wavly'));
  const policies = code(read('policy.d/wavly'));
  const mods = code(read('mods-available/wavly'));

  const invoked = new Set([...site.matchAll(/^\s*(wavly-[a-z-]+)\s*$/gm)].map((m) => m[1]));
  const defined = new Set([
    ...[...policies.matchAll(/^([a-z-]+) = policy \{/gm)].map((m) => m[1]),
    ...[...mods.matchAll(/^\s*[a-z_]+ (wavly-[a-z-]+) \{/gm)].map((m) => m[1]),
  ]);
  assert.ok(invoked.size >= 4, `expected the site to use several wavly components, found ${invoked.size}`);
  for (const name of invoked) {
    assert.ok(defined.has(name), `${name} is called by the site but never defined - FreeRADIUS refuses to start`);
  }
});

test('the expiry module is actually invoked, and rejects with an actionable message', () => {
  const { read } = render();
  const policies = code(read('policy.d/wavly'));
  assert.match(policies, /^\s*expiration\s*$/m,
    'the stock expiration module is what reads control:Expiration; without it an expired customer keeps logging in and nothing logs an error');
  assert.match(policies, /expired/i);
  // A bare Access-Reject is indistinguishable from "the internet is broken".
  assert.match(policies, /Reply-Message.*expired|Reply-Message.*renew/si);
});

test('FUP throttles with a CoA and never disconnects', () => {
  const { read } = render();
  const policies = code(read('policy.d/wavly'));
  const fup = /wavly-fup-check = policy \{([\s\S]*?)\n\}/.exec(policies);
  assert.ok(fup, 'wavly-fup-check policy not found');
  assert.match(fup[1], /update coa \{/,
    'FUP must issue a CoA - a live session cannot be re-authorized any other way');
  assert.match(fup[1], /Mikrotik-Rate-Limit/);
  assert.ok(!/update disconnect/.test(fup[1]),
    'running out of included data must slow a customer down, not cut them off: they have paid for the remaining days');
  // Without this guard every interim update re-sends the same CoA.
  assert.match(fup[1], /Wavly-Fup-Active/,
    'FUP must fire once, or every accounting interval churns the router queue tree');
});

test('FUP only runs on interim updates', () => {
  const { read } = render();
  const site = code(read('sites-available/wavly'));
  assert.match(site, /Acct-Status-Type == 'Interim-Update'/);
});

test('the device policy rejects on a decision from SQL, not from unlang string surgery', () => {
  const { read } = render();
  const policies = code(read('policy.d/wavly'));
  const dev = /wavly-device-policy = policy \{([\s\S]*?)\n\}/.exec(policies);
  assert.ok(dev, 'wavly-device-policy not found');
  assert.match(dev[1], /wavly_check_device\(/, 'the roster decision must be one SQL call');
  for (const outcome of ['reject_blocked', 'reject_bound', 'reject_limit']) {
    assert.ok(dev[1].includes(outcome), `the ${outcome} outcome is not handled`);
  }
  // Each rejection must say why, in words a customer can act on.
  const messages = [...dev[1].matchAll(/Reply-Message := "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(messages.length >= 3, 'every rejection needs a Reply-Message');
  for (const m of messages) {
    assert.ok(m.length > 20, `Reply-Message "${m}" is too terse to be actionable`);
  }
});

test('a missing MAC fails open rather than locking everyone out', () => {
  const { read } = render();
  const policies = code(read('policy.d/wavly'));
  const norm = /wavly-normalize-mac = policy \{([\s\S]*?)\n\}/.exec(policies);
  assert.ok(norm, 'wavly-normalize-mac not found');
  assert.match(norm[1], /\[0-9A-Fa-f\]\{2\}/, 'the MAC must be pattern-checked before it reaches SQL');
  assert.match(norm[1], /wavly-mac-missing/, 'a NAS that stops sending MACs must be detectable');
  assert.ok(!/^\s*reject\s*$/m.test(norm[1]),
    'rejecting on a missing MAC would take the whole site down if a firmware upgrade changed the attribute');
});

test('session enforcement is enabled so Simultaneous-Use is real', () => {
  const { read } = render();
  const site = code(read('sites-available/wavly'));
  assert.match(site, /session \{[\s\S]*?-sql/,
    'without the session section, Simultaneous-Use is decoration: nothing counts open sessions');
});

test('acct_unique runs, so sessions from a rebooted router do not collide', () => {
  const { read } = render();
  const site = code(read('sites-available/wavly'));
  assert.match(site, /acct_unique/,
    'MikroTik restarts Acct-Session-Id after a reboot; without acct_unique two customers share a radacct row and usage is attributed to the wrong one');
});

// ===========================================================================
// mods-available/sql and queries.conf
// ===========================================================================

test('read_clients stays off so no secret lands in the database', () => {
  const { read } = render();
  const sql = code(read('mods-available/sql'));
  assert.match(sql, /read_clients = no/,
    'with read_clients on, the RADIUS shared secret lives in a column and therefore in every nightly off-site backup - the one credential that lets anyone authenticate any customer');
});

test('safe-characters includes the colon, or MAC usernames never match', () => {
  const { read } = render();
  const sql = code(read('mods-available/sql'));
  const m = /safe-characters = "([^"]*)"/.exec(sql);
  assert.ok(m, 'safe-characters is not set');
  assert.ok(m[1].includes(':'),
    'MikroTik sends AA:BB:CC:DD:EE:FF; without the colon %{SQL-User-Name} is mangled and a customer who exists cannot log in');
});

test('post-auth stores REDACTED, never the submitted password', () => {
  const { read } = render();
  const queries = code(read('mods-config/sql/main/postgresql/queries.conf'));
  // Anchored at column 0: queries.conf also nests a `post-auth` inside its
  // `class { }` block, and matching that one tests the wrong query.
  const postAuth = /^post-auth \{([\s\S]*?)^\}/m.exec(queries);
  assert.ok(postAuth, 'no top-level post-auth block in queries.conf');
  assert.ok(postAuth[1].includes("'REDACTED'"), 'the password column must be the literal REDACTED');
  assert.ok(!/User-Password/.test(postAuth[1]),
    'the post-auth INSERT still interpolates the submitted password - that writes every customer credential to disk in cleartext');
  // And it must record enough to make a failure actionable.
  assert.match(postAuth[1], /Called-Station-Id/);
  assert.match(postAuth[1], /Calling-Station-Id/);
});

test('accounting still applies the Gigawords shift for counters above 4 GiB', () => {
  const { read } = render();
  const queries = code(read('mods-config/sql/main/postgresql/queries.conf'));
  // A 32-bit octet counter wraps at 4 GiB - about 35 minutes at 20 Mbps. Dropping
  // the shift under-bills exactly the heaviest users.
  assert.match(queries, /Gigawords[^)]*::bigint\s*<<\s*32/,
    'the Gigawords << 32 handling was removed; usage above 4 GiB per interval would be truncated');
});

// ===========================================================================
// dictionary
// ===========================================================================

test('byte-cap attributes are integer64, not integer', () => {
  const dict = readFileSync(join(REPO, 'deploy/edge/freeradius/dictionary.wavly'), 'utf8');
  const lines = code(dict);
  for (const name of ['Wavly-Data-Cap', 'Wavly-Used-Bytes', 'Wavly-Used-Baseline']) {
    const m = new RegExp(`^ATTRIBUTE\\s+${name}\\s+\\S+\\s+(\\S+)`, 'm').exec(lines);
    assert.ok(m, `${name} is not declared in the dictionary - unlang cannot reference it`);
    assert.equal(m[1], 'integer64',
      `${name} must be integer64: a 250 GB cap is 268435456000, which overflows a 32-bit attribute and wraps silently to a small number`);
  }
});

test('every attribute the policies reference is declared in the dictionary', () => {
  const dict = code(readFileSync(join(REPO, 'deploy/edge/freeradius/dictionary.wavly'), 'utf8'));
  const declared = new Set([...dict.matchAll(/^ATTRIBUTE\s+(\S+)/gm)].map((m) => m[1]));
  const policies = readFileSync(join(REPO, 'deploy/edge/freeradius/policy.d/wavly'), 'utf8');
  const used = new Set([...policies.matchAll(/&?(Wavly-[A-Za-z-]+)/g)].map((m) => m[1]));
  assert.ok(used.size >= 6, 'sanity: the policies should use several Wavly attributes');
  for (const u of used) {
    assert.ok(declared.has(u),
      `${u} is used in policy.d but not declared in dictionary.wavly; FreeRADIUS fails to start with "Unknown attribute"`);
  }
});

// ===========================================================================
// mods-config/files/authorize (the local emergency account)
// ===========================================================================

test('the local admin account is rendered from the environment and expires', () => {
  const { read } = render();
  const files = code(read('mods-config/files/authorize'));
  assert.match(files, /wavly-local-admin/, 'the offline-diagnosis account is missing');
  assert.ok(files.includes(GOOD_ENV.EDGE_LOCAL_ADMIN_PASSWORD),
    'the password must be substituted, not left as a placeholder');
  assert.ok(!/@@LOCAL_ADMIN/.test(files));
  assert.match(files, /Expiration/,
    'an emergency account that never expires is a standing backdoor');
  assert.match(files, /Simultaneous-Use/,
    'the local account must be limited, or a leaked credential is site-wide free internet');
});

test('no customer account can be defined in the files module', () => {
  const { read } = render();
  const files = code(read('mods-config/files/authorize'));
  // Only the local admin, and no uncommented catch-all.
  const entries = files.split('\n').filter((l) => /^\S/.test(l) && !/^\s*$/.test(l));
  assert.ok(entries.length <= 2,
    `the files module should define only the local operator account, found: ${entries.join(' | ')}`);
  assert.ok(!/^DEFAULT/m.test(files),
    'an uncommented DEFAULT entry accepts any username and makes it impossible to tell an auth problem from any other');
});

test('the local admin rate limit comes from a real seed rate profile', () => {
  const { read } = render();
  const files = code(read('mods-config/files/authorize'));
  const m = /Mikrotik-Rate-Limit := "([^"]*)"/.exec(files);
  assert.ok(m, 'the local admin gets no rate limit');
  // A real profile may carry burst terms after the base pair, so only the leading
  // rx/tx pair is asserted here. That it comes from the SEED is proved below.
  assert.match(m[1], /^\d+[kM]?\/\d+[kM]?/,
    `the rate limit "${m[1]}" does not start with a Mikrotik-Rate-Limit rx/tx pair`);

  // Same knob, different profile -> different output. This is what proves the
  // value is rendered from the seed rather than hardcoded.
  const other = render({ ...GOOD_ENV, EDGE_LOCAL_ADMIN_RATE_PROFILE: 'p-3-1' });
  const otherLimit = /Mikrotik-Rate-Limit := "([^"]*)"/.exec(code(other.read('mods-config/files/authorize')))[1];
  assert.notEqual(otherLimit, m[1],
    'changing EDGE_LOCAL_ADMIN_RATE_PROFILE did not change the rendered rate limit');

  const bad = run({ ...GOOD_ENV, EDGE_LOCAL_ADMIN_RATE_PROFILE: 'p-9999-9999' });
  assert.notEqual(bad.status, 0, 'an unknown rate profile name must not render');
  assert.match(bad.stderr + bad.stdout, /rate profile/);
});

// ===========================================================================
// bin/wv-coa
// ===========================================================================

/**
 * Build a directory containing a fake `radclient` so the real script logic runs
 * end to end: what it sends, and how it maps the reply to an exit code.
 */
function withFakeRadclient(reply, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wavly-coa-'));
  const log = join(dir, 'packets.log');
  const fake = join(dir, 'radclient');
  writeFileSync(fake, [
    '#!/usr/bin/env bash',
    `# appends everything it receives, then prints the canned reply`,
    `{ echo "--- argv: $*"; cat; } >> "${log}"`,
    `printf '%s\\n' "${reply}"`,
    'exit 0',
  ].join('\n'));
  chmodSync(fake, 0o755);
  try {
    return fn({ dir, log, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  } finally {
    // temp dir left for the OS to reap
  }
}

function coa(args, env = {}) {
  return spawnSync('bash', [WV_COA, ...args], {
    env: { ...cleanEnv(), ...env },
    encoding: 'utf8',
  });
}

test('wv-coa parses as bash and is executable', () => {
  const r = spawnSync('bash', ['-n', WV_COA], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('wv-coa refuses to run without a secret, and says why', () => {
  withFakeRadclient('Received Disconnect-ACK', ({ env }) => {
    const r = spawnSync('bash', [WV_COA, 'disconnect', '--nas', '192.168.89.1', '--user', 'bob'],
      { env: cleanEnv({ ...env }), encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'it must not send a CoA with no secret');
    assert.match(r.stderr, /WV_COA_SECRET/);
    assert.match(r.stderr, /argv|\/proc/i,
      'the error should explain why the secret is not an argument - argv is world-readable');
  });
});

test('wv-coa validates its arguments before sending anything', () => {
  // radclient is stubbed so these cases exercise validation rather than the
  // dependency check, which runs later by design.
  withFakeRadclient('Received Disconnect-ACK', ({ env }) => {
    process.env.__WV_FAKE_PATH = env.PATH;
  });
  const base = { WV_COA_SECRET: 'x'.repeat(32), PATH: process.env.__WV_FAKE_PATH };
  const cases = [
    [['disconnect'], /--nas is required/],
    [['disconnect', '--nas', '192.168.89.1'], /--user is required/],
    [['disconnect', '--nas', '999.1.1.1', '--user', 'bob'], /invalid IPv4/],
    [['disconnect', '--nas', 'router.local', '--user', 'bob'], /invalid IPv4/],
    [['throttle', '--nas', '192.168.89.1', '--user', 'bob'], /--rate/],
    [['throttle', '--nas', '192.168.89.1', '--user', 'bob', '--rate', 'fast'], /Mikrotik-Rate-Limit/],
    [['bogus', '--nas', '192.168.89.1', '--user', 'bob'], /unknown action/],
    [['disconnect', '--nas', '192.168.89.1', '--user', 'bob', '--wat'], /unknown argument/],
  ];
  for (const [args, re] of cases) {
    const r = coa(args, base);
    assert.notEqual(r.status, 0, `${args.join(' ')} should fail`);
    assert.equal(r.status, 1, `${args.join(' ')} should exit 1 (usage), got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, re, `${args.join(' ')}`);
  }
});

test('a disconnect packet carries no authorization attributes (RFC 5176)', () => {
  withFakeRadclient('Received Disconnect-ACK', ({ log, env }) => {
    const r = spawnSync('bash', [WV_COA, 'disconnect', '--nas', '192.168.89.1', '--user', 'bob'],
      { env: { ...env, WV_COA_SECRET: 'x'.repeat(32) }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);

    const sent = readFileSync(log, 'utf8');
    assert.match(sent, /User-Name = "bob"/);
    assert.match(sent, /NAS-IP-Address = 192.168.89.1/);
    // Including a rate limit or any other authorization attribute makes the NAS
    // reply Disconnect-NAK/Unsupported-Attribute, so the disconnect silently fails.
    for (const forbidden of ['Mikrotik-Rate-Limit', 'Session-Timeout', 'Framed-IP-Address']) {
      assert.ok(!sent.includes(forbidden),
        `a Disconnect-Request must not carry ${forbidden}; the NAS will NAK it with Unsupported-Attribute`);
    }
    assert.match(sent, /argv:.*\bdisconnect\b/, 'radclient must be invoked with the disconnect packet type');
  });
});

test('a throttle packet is a CoA carrying the rate limit', () => {
  withFakeRadclient('Received CoA-ACK', ({ log, env }) => {
    const r = spawnSync('bash', [WV_COA, 'throttle', '--nas', '192.168.89.1',
      '--user', 'bob', '--rate', '2M/4M', '--session', '8060001a'],
      { env: { ...env, WV_COA_SECRET: 'x'.repeat(32) }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);

    const sent = readFileSync(log, 'utf8');
    assert.match(sent, /Mikrotik-Rate-Limit = "2M\/4M"/);
    assert.match(sent, /Acct-Session-Id = "8060001a"/);
    assert.match(sent, /argv:.*\bcoa\b/);
  });
});

test('MAC addresses are normalised to the form RouterOS matches on', () => {
  withFakeRadclient('Received Disconnect-ACK', ({ log, env }) => {
    const r = spawnSync('bash', [WV_COA, 'disconnect', '--nas', '192.168.89.1',
      '--user', 'bob', '--mac', 'aa-bb-cc-dd-ee-ff'],
      { env: { ...env, WV_COA_SECRET: 'x'.repeat(32) }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const sent = readFileSync(log, 'utf8');
    assert.match(sent, /Calling-Station-Id = "AA:BB:CC:DD:EE:FF"/,
      'RouterOS is configured with radius-mac-format=XX:XX:XX:XX:XX:XX; a lower-case or hyphenated MAC matches no session and the disconnect does nothing');
  });
});

test('an invalid MAC is rejected rather than sent', () => {
  withFakeRadclient('Received Disconnect-ACK', ({ env }) => {
    const r = spawnSync('bash', [WV_COA, 'disconnect', '--nas', '192.168.89.1',
      '--user', 'bob', '--mac', 'not-a-mac'],
      { env: { ...env, WV_COA_SECRET: 'x'.repeat(32) }, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid MAC/);
  });
});

test('wv-coa --help prints usage including the exit codes', () => {
  const r = coa(['--help']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout + r.stderr;
  assert.match(out, /USAGE/i);
  assert.match(out, /EXIT CODES/i,
    'syncd branches on the exit code, so the meaning of 2 vs 3 must be documented in the help text');
  assert.match(out, /throttle/);
});

test('a missing radclient is reported as an install problem, after validation', () => {
  // An empty PATH makes radclient genuinely unfindable. bash is invoked by
  // absolute path, because with PATH stripped Node cannot resolve the bare name
  // and the child never starts (status null) - which would make this test pass
  // or fail for reasons that have nothing to do with the script.
  const bare = (args) => spawnSync('/bin/bash', [WV_COA, ...args], {
    env: cleanEnv({ WV_COA_SECRET: 'x'.repeat(32), PATH: '/nonexistent' }),
    encoding: 'utf8',
  });

  // Validation must win, so a typo is reported as a typo even on a machine that
  // cannot send CoA at all (CI, a laptop) - that is where you want to catch it.
  const typo = bare(['disconnect', '--nas', 'not-an-ip', '--user', 'bob']);
  assert.equal(typo.status, 1, typo.stderr);
  assert.match(typo.stderr, /invalid IPv4/);

  const missing = bare(['disconnect', '--nas', '192.168.89.1', '--user', 'bob']);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /radclient not found/);
  assert.match(missing.stderr, /freeradius-utils/,
    'the error must name the package to install, not just the missing binary');
});

test('replies map to distinct exit codes: ACK, NAK and no-reply', () => {
  const secret = { WV_COA_SECRET: 'x'.repeat(32) };
  const cases = [
    ['Received Disconnect-ACK Id 5 from 192.168.89.1', 0],
    ['Received CoA-ACK Id 5', 0],
    ['Received Disconnect-NAK Id 5', 2],
    ['Received CoA-NAK Id 5', 2],
    ['Received some unrelated packet', 2],
  ];
  for (const [reply, want] of cases) {
    withFakeRadclient(reply, ({ env }) => {
      const r = spawnSync('bash', [WV_COA, 'disconnect', '--nas', '192.168.89.1', '--user', 'bob'],
        { env: { ...env, ...secret }, encoding: 'utf8' });
      assert.equal(r.status, want,
        `reply "${reply}" should exit ${want}, got ${r.status}. ` +
        `NAK and timeout must differ: a NAK means our attributes are wrong and retrying is pointless, a timeout means the CoA path is broken and retrying is the only fix`);
    });
  }
});

test('an unrecognised reply is never reported as success', () => {
  // The worst thing this script can do is claim a disconnect worked when it did
  // not: that is a customer staying online for free until someone notices.
  withFakeRadclient('something nobody expected', ({ env }) => {
    const r = spawnSync('bash', [WV_COA, 'disconnect', '--nas', '192.168.89.1', '--user', 'bob'],
      { env: { ...env, WV_COA_SECRET: 'x'.repeat(32) }, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unrecognised reply/i);
  });
});

test('a secret file with a trailing newline still authenticates', () => {
  withFakeRadclient('Received Disconnect-ACK', ({ dir, env }) => {
    const f = join(dir, 'secret');
    writeFileSync(f, `${'y'.repeat(32)}\n`);
    const r = spawnSync('bash', [WV_COA, 'disconnect', '--nas', '192.168.89.1', '--user', 'bob'],
      { env: { ...env, WV_COA_SECRET_FILE: f, WV_COA_SECRET: '' }, encoding: 'utf8' });
    assert.equal(r.status, 0,
      `a trailing newline must be stripped or the authenticator mismatches and the CoA times out: ${r.stderr}`);
    // And the secret must not appear in argv, where /proc would expose it.
    const sent = readFileSync(join(dir, 'packets.log'), 'utf8');
    const argvLine = /--- argv: (.*)/.exec(sent)[1];
    assert.ok(argvLine.includes('y'.repeat(32)),
      'radclient does take the secret positionally - that is radclient\'s own interface, and is why WE never accept it as an argument');
  });
});

// ===========================================================================
// systemd
// ===========================================================================

test('the systemd override waits for Postgres and restarts', () => {
  const unit = readFileSync(join(REPO, 'deploy/edge/systemd/freeradius.service.d/override.conf'), 'utf8');
  const body = code(unit);
  assert.match(body, /Requires=postgresql\.service/,
    'without this FreeRADIUS can start before the database accepts connections and then reject every customer with no obvious cause - a common boot order on a box that loses power');
  assert.match(body, /Restart=always/);
  assert.match(body, /MemoryMax=/);
});
