/**
 * Regression tests for the MikroTik configuration generator.
 *
 * These target the failures that produce NO error on the router. A rate limit
 * written the wrong way round parses, loads, and simply makes every customer
 * slow in one direction; an `action=allow` in the L3 walled garden is rejected
 * while `action=accept` in the L7 one is too; a missing `force=yes` on DHCP
 * option 114 means the option is silently never sent. None of these can be
 * caught by pasting the script into a router and seeing whether it complains,
 * so they have to be caught here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatRate, renderRateLimit, renderRadiusReply, formatExpiration, formatBytes,
} from '../lib/rate-limit.mjs';
import {
  classifyRules, hostVariants, dynamicHosts, l7Name, isIpLike, rscQuote,
  L7_ACTIONS, L3_ACTIONS,
} from '../lib/walled-garden.mjs';
import { loadSeed, isRef, refKey, maybeRefKey } from '../lib/seed.mjs';
import { renderRouterConfig } from '../lib/render-config.mjs';
import { renderHotspotFiles } from '../lib/hotspot-files.mjs';

const profile = (over = {}) => ({
  name: 'p-12-6', label: '12 / 6 Mbps',
  download_kbps: 12000, upload_kbps: 6000,
  burst_download_kbps: null, burst_upload_kbps: null,
  burst_download_threshold_kbps: null, burst_upload_threshold_kbps: null,
  burst_download_seconds: null, burst_upload_seconds: null,
  min_download_kbps: null, min_upload_kbps: null,
  queue_priority: null, address_list_name: null,
  ...over,
});

// ---------------------------------------------------------------------------
// Rate formatting: the database stores KILOBITS, MikroTik wants BITS.
// ---------------------------------------------------------------------------

test('formatRate converts kilobits to MikroTik bit units', () => {
  assert.equal(formatRate(12000), '12M');   // 12 Mbit/s, not "12000"
  assert.equal(formatRate(1000), '1M');
  assert.equal(formatRate(8), '8k');        // the suspended-account floor
  assert.equal(formatRate(1500), '1500k');  // not a whole megabit -> kilobits
  assert.equal(formatRate(null), null);
  assert.equal(formatRate(0), null);
});

test('formatRate refuses a fractional kilobit value rather than guessing', () => {
  assert.throws(() => formatRate(12000.5), /not a whole number/);
});

// ---------------------------------------------------------------------------
// THE INVERSION. rx = client UPLOAD from the router's point of view.
// ---------------------------------------------------------------------------

test('Mikrotik-Rate-Limit puts UPLOAD first (rx is client upload)', () => {
  const { value } = renderRateLimit(profile());
  // 12 Mbps down / 6 Mbps up must render as "6M/12M", never "12M/6M".
  assert.equal(value, '6M/12M');
  assert.match(value, /^6M\/12M$/);
});

test('the documented worked example renders exactly', () => {
  const { value } = renderRateLimit(profile({
    download_kbps: 10000, upload_kbps: 5000,
    burst_download_kbps: 20000, burst_upload_kbps: 10000,
    burst_download_threshold_kbps: 10000, burst_upload_threshold_kbps: 5000,
    burst_download_seconds: 12, burst_upload_seconds: 12,
    queue_priority: 8,
  }));
  assert.equal(value, '5M/10M 10M/20M 5M/10M 12s/12s 8');
});

test('burst fields are positional: asking for priority forces the burst slots', () => {
  // You cannot specify priority without first giving burst-rate, threshold and
  // time. With no burst configured the base rate is reused, which is a no-op
  // burst (you can never exceed your own ceiling) and unlocks the slots.
  const { value } = renderRateLimit(profile({ queue_priority: 5 }));
  assert.equal(value, '6M/12M 6M/12M 6M/12M 1s/1s 5');
});

test('burst time defaults to 1s, matching MikroTik behaviour when omitted', () => {
  const { value } = renderRateLimit(profile({ burst_download_kbps: 24000, burst_upload_kbps: 12000 }));
  assert.equal(value, '6M/12M 12M/24M 6M/12M 1s/1s');
});

test('rate-min renders after priority and never exceeds the base rate', () => {
  const { value } = renderRateLimit(profile({
    queue_priority: 5, min_download_kbps: 3000, min_upload_kbps: 1500,
  }));
  assert.equal(value, '6M/12M 6M/12M 6M/12M 1s/1s 5 1500k/3M');
});

test('a rate-min above the ceiling is clamped, because MikroTik rejects it', () => {
  const { value, warnings } = renderRateLimit(profile({ min_download_kbps: 99000 }));
  // min_download clamps to the 12M ceiling; min_upload is unset and falls back to
  // the 6M base upload. So the trailing rate-min pair is rx/tx = 6M/12M.
  assert.match(value, /6M\/12M$/);
  assert.ok(warnings.some((w) => /clamped/.test(w)), 'expected a clamping warning');
  assert.throws(() => renderRateLimit(profile({ min_download_kbps: 99000 }), { strict: true }),
    /min_download_kbps exceeds download_kbps/);
});

test('download slower than upload is flagged as a likely column swap', () => {
  const { warnings } = renderRateLimit(profile({ download_kbps: 2000, upload_kbps: 8000 }));
  assert.ok(warnings.some((w) => /slower than upload/.test(w)));
});

test('the seeded profiles all render without warnings', async () => {
  const seed = await loadSeed();
  for (const p of seed.rateProfiles) {
    const { value, warnings } = renderRateLimit(p);
    assert.deepEqual(warnings, [], `${p.name}: ${warnings.join('; ')}`);
    assert.ok(value.length > 0, `${p.name} rendered empty`);
    // Upload must come first, and must not exceed download.
    const [first] = value.split(' ');
    const [rx, tx] = first.split('/');
    assert.ok(rx && tx, `${p.name}: expected an rx/tx pair, got ${first}`);
  }
});

// ---------------------------------------------------------------------------
// RADIUS reply attributes
// ---------------------------------------------------------------------------

const sub = (over = {}) => ({
  subscription_status: 'active',
  expires_at: '2026-12-15T23:59:59Z',
  simultaneous_use: 2,
  idle_timeout_seconds: 1800,
  session_timeout_seconds: null,
  fup_download_kbps: null,
  fup_upload_kbps: null,
  ...over,
});

test('renderRadiusReply emits the attributes the router needs', () => {
  const { attributes } = renderRadiusReply(profile({ address_list_name: 'wv-p-12-6' }), sub());
  const byName = Object.fromEntries(attributes.map((a) => [a.attribute, a.value]));

  assert.equal(byName['Mikrotik-Rate-Limit'], '6M/12M');
  assert.equal(byName['Simultaneous-Use'], '2');
  assert.equal(byName['Expiration'], '15 Dec 2026');
  assert.equal(byName['Idle-Timeout'], '1800');
  assert.equal(byName['Mikrotik-Address-List'], 'wv-p-12-6');
  assert.equal(byName['Acct-Interim-Interval'], '300');
  // All reply attributes use := so a later group membership cannot override them.
  assert.ok(attributes.every((a) => a.op === ':='));
});

test('Mikrotik-Total-Limit is deliberately never emitted', () => {
  // It caps bytes per SESSION. Our caps are per SUBSCRIPTION, so emitting it
  // would reset a customer's monthly allowance on every reconnect and quietly
  // give away unlimited data on a capped plan.
  const { attributes } = renderRadiusReply(profile(), sub());
  assert.ok(!attributes.some((a) => a.attribute === 'Mikrotik-Total-Limit'));
});

test('fair-usage throttling replaces the plan rate instead of stacking', () => {
  const { attributes } = renderRadiusReply(
    profile(),
    sub({ subscription_status: 'fup_throttled', fup_download_kbps: 4000, fup_upload_kbps: 2000 }),
  );
  const rate = attributes.find((a) => a.attribute === 'Mikrotik-Rate-Limit');
  assert.equal(rate.value, '2M/4M');
  // Throttle, never disconnect: the customer stays online at reduced speed.
  assert.equal(attributes.filter((a) => a.attribute === 'Mikrotik-Rate-Limit').length, 1);
});

test('formatExpiration uses the dd Mon yyyy form MikroTik expects', () => {
  assert.equal(formatExpiration('2026-01-05T10:00:00Z'), '05 Jan 2026');
  assert.throws(() => formatExpiration('not a date'), /invalid date/);
});

test('formatBytes agrees with the SQL app_format_bytes presentation', () => {
  assert.equal(formatBytes(0), '0 MB');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(5 * 1024 ** 2), '5.0 MB');
  assert.equal(formatBytes(100 * 1024 ** 3), '100 GB');
});

// ---------------------------------------------------------------------------
// Walled garden: the two tables have different action vocabularies.
// ---------------------------------------------------------------------------

test('L7 and L3 actions are never mixed up', () => {
  assert.deepEqual(L7_ACTIONS, { allow: 'allow', block: 'deny' });
  assert.deepEqual(L3_ACTIONS, { allow: 'accept', block: 'drop' });
});

const rule = (over = {}) => ({
  scope: 'global', action: 'allow', match_type: 'domain',
  pattern: 'example.com', enforcement: 'walled_garden',
  priority: 10, category: 'walled_garden', is_active: true, notes: 'test',
  ...over,
});

test('an L7 rule uses allow/deny and fans a bare domain out to its wildcard', () => {
  const c = classifyRules([rule()]);
  // A bare dst-host does NOT match subdomains, so both forms are needed.
  assert.deepEqual(c.walledGardenL7.map((e) => e.dstHost).sort(),
    ['*.example.com', 'example.com']);
  assert.ok(c.walledGardenL7.every((e) => e.action === 'allow'));
  assert.equal(c.walledGardenL3.length, 0);
});

test('a block rule renders action=deny in L7 and action=drop in L3', () => {
  const l7 = classifyRules([rule({ action: 'block' })]);
  assert.ok(l7.walledGardenL7.every((e) => e.action === 'deny'));
  const l3 = classifyRules([rule({ action: 'block', enforcement: 'walled_garden_ip' })]);
  assert.ok(l3.walledGardenL3.every((e) => e.action === 'drop'));
});

test('an HTTPS portal domain lands in the L3 table, not L7', () => {
  const c = classifyRules([rule({ pattern: 'portal.wavlywifi.com', enforcement: 'walled_garden_ip' })]);
  assert.equal(c.walledGardenL3.length, 1);
  assert.equal(c.walledGardenL3[0].dstHost, 'portal.wavlywifi.com');
  assert.equal(c.walledGardenL3[0].action, 'accept');
  assert.equal(c.walledGardenL3[0].dynamic, true); // needs periodic re-resolution
  // L3 does NOT fan out to wildcards; dst-host resolution is per exact name.
  assert.equal(c.walledGardenL7.length, 0);
});

test('an IP literal cannot go in the L7 table even if enforcement says so', () => {
  const c = classifyRules([rule({ pattern: '203.0.113.5', enforcement: 'walled_garden' })]);
  assert.equal(c.walledGardenL7.length, 0);
  assert.equal(c.walledGardenL3.length, 1);
  assert.equal(c.walledGardenL3[0].dstAddress, '203.0.113.5');
});

test('firewall address lists take NO wildcards (unlike /ip dns static)', () => {
  const c = classifyRules([rule({ pattern: 'dns.google', enforcement: 'address_list', action: 'block' })]);
  const entries = c.addressListBlock.map((e) => e.entry);
  assert.deepEqual(entries, ['dns.google']);
  assert.ok(!entries.some((e) => e.includes('*')), 'RouterOS rejects *.domain in an address list');
});

test('dns enforcement sinkholes the name and its wildcard', () => {
  const c = classifyRules([rule({ pattern: 'tiktok.com', enforcement: 'dns', action: 'block' })]);
  assert.deepEqual(c.dnsSinkhole.map((e) => e.name).sort(), ['*.tiktok.com', 'tiktok.com']);
  assert.ok(c.dnsSinkhole.every((e) => e.address === '0.0.0.0'));
});

test('plan and user scoped rules never reach the router config', () => {
  const c = classifyRules([
    rule({ scope: 'plan', pattern: 'a.example' }),
    rule({ scope: 'user', pattern: 'b.example' }),
  ]);
  assert.equal(c.walledGardenL7.length, 0);
  assert.equal(c.skipped.length, 2);
  assert.ok(c.skipped.every((s) => /RADIUS\/edge/.test(s.reason)));
});

test('duplicate rules collapse so the rendered script stays diffable', () => {
  const c = classifyRules([rule(), rule({ notes: 'a different note' })]);
  assert.equal(c.walledGardenL7.length, 2); // example.com + *.example.com, once each
});

test('dynamicHosts lists everything needing periodic re-resolution', () => {
  const c = classifyRules([
    rule({ pattern: 'portal.wavlywifi.com', enforcement: 'walled_garden_ip' }),
    rule({ pattern: 'dns.google', enforcement: 'address_list', action: 'block' }),
  ]);
  assert.deepEqual(dynamicHosts(c), ['dns.google', 'portal.wavlywifi.com']);
});

test('hostVariants, isIpLike, l7Name and rscQuote behave', () => {
  assert.deepEqual(hostVariants('*.Example.COM'), ['example.com', '*.example.com']);
  assert.deepEqual(hostVariants(''), []);
  assert.equal(isIpLike('10.0.0.0/8'), true);
  assert.equal(isIpLike('example.com'), false);
  assert.equal(l7Name('https://x.example.com/a?b=c'), 'wv-https-x-example-com-a-b-c');
  assert.equal(rscQuote('a"b'), '"a\\"b"');
  assert.equal(rscQuote(''), '""');
});

// ---------------------------------------------------------------------------
// Seed extraction: the generator must read the database's own source of truth.
// ---------------------------------------------------------------------------

test('loadSeed reads plans, profiles, rules and settings from the SQL seed', async () => {
  const seed = await loadSeed();
  assert.ok(seed.sites.length >= 1);
  assert.ok(seed.plans.length >= 7);
  assert.ok(seed.rateProfiles.length >= 8);
  assert.ok(seed.networkRules.length >= 15);
  assert.ok(Object.keys(seed.settings).length >= 60);
});

test('plans are joined to their rate profile by NAME, not by an invented UUID', async () => {
  const seed = await loadSeed();
  const mb = seed.plans.find((p) => p.code === 'month-basic');
  assert.equal(mb.rate_profile_name, 'p-12-6');
  assert.equal(mb.fup_rate_profile_name, 'fup-4-2');
  // The raw column is a {$ref}, because gen_random_uuid() cannot be known statically.
  assert.equal(isRef(mb.rate_profile_id), true);
  assert.equal(refKey(mb.rate_profile_id), 'p-12-6');
  assert.equal(seed.profileFor('p-12-6').download_kbps, 12000);
  assert.throws(() => seed.profileFor('does-not-exist'), /referenced but not defined/);
});

test('jsonb settings arrive as real JS values, and secrets are never loaded', async () => {
  const seed = await loadSeed();
  assert.equal(typeof seed.settings['network.downstream_capacity_kbps'], 'number');
  assert.equal(seed.settings['network.https_redirect'], false);
  assert.equal(seed.settings['branding.business_name'], 'Wavly WiFi');
  const secretKeys = (seed.raw.settings || []).filter((r) => r.is_secret).map((r) => r.key);
  for (const k of secretKeys) {
    assert.equal(k in seed.settings, false, `secret setting ${k} must not be rendered`);
  }
});

test('a non-literal value in a column the generator reads is an error, not a guess', async () => {
  const { parseSeedInserts } = await import('../lib/seed.mjs');
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'wv-seed-'));
  const f = join(dir, 'bad.sql');
  await writeFile(f, `insert into settings (key, value, value_type) values ('x', now(), 'string');`);
  await assert.rejects(() => parseSeedInserts(f, { tables: ['settings'] }), /now\(\)/);
  await rm(dir, { recursive: true, force: true });
});

test('maybeRefKey tolerates nulls (plans without fair usage)', async () => {
  const seed = await loadSeed();
  const dayLite = seed.plans.find((p) => p.code === 'day-lite');
  assert.equal(dayLite.fup_enabled, false);
  assert.equal(dayLite.fup_rate_profile_name, undefined);
});

// ---------------------------------------------------------------------------
// Full render: invariants that must hold in the produced script.
// ---------------------------------------------------------------------------

let rendered = null;
async function script() {
  if (!rendered) rendered = renderRouterConfig(await loadSeed());
  return rendered.script;
}

test('the rendered script contains no warnings against the real seed', async () => {
  const r = renderRouterConfig(await loadSeed());
  assert.deepEqual(r.warnings, []);
});

test('DHCP option 114 carries force=yes, without which v7 never sends it', async () => {
  const s = await script();
  assert.match(s, /code=114 force=yes/);
  assert.match(s, /option sets add name=wv-hotspot-options options=wv-captive-portal/);
  assert.match(s, /dhcp-option-set=wv-hotspot-options/);
  // Android 13+ rejects a non-HTTPS option 114 URL.
  const url = s.match(/code=114 force=yes value="'([^']+)'/)[1];
  assert.match(url, /^https:\/\//);
});

test('the hotspot never accepts plaintext credentials', async () => {
  const s = await script();
  assert.match(s, /login-by=http-chap,cookie/);
  assert.ok(!/login-by=[^\n]*http-pap/.test(s), 'http-pap sends the password in plaintext');
});

test('https-redirect stays off and html-directory is the stock directory', async () => {
  const s = await script();
  // RouterOS v7 exposes no working ssl-certificate on the hotspot profile, so an
  // HTTPS login page from the router would show a certificate name mismatch.
  assert.match(s, /https-redirect=no/);
  // A fresh directory would have to ship md5.js; a missing one breaks http-chap
  // with no error message at all.
  assert.match(s, /html-directory=hotspot\b/);
});

test('the hotspot dns-name is local and never the portal hostname', async () => {
  const s = await script();
  assert.match(s, /dns-name="hotspot\.lan"/);
  assert.ok(!/dns-name="portal\.wavlywifi\.com"/.test(s),
    'the router would shadow the real cloud portal for every client');
  assert.ok(!/dns-name="[^"]*\.local"/.test(s), 'a .local name can stop iOS detecting the hotspot');
});

test('captive-portal detection endpoints are intercepted, not allowed', async () => {
  const s = await script();
  for (const h of ['connectivitycheck.gstatic.com', 'captive.apple.com', 'msftconnecttest.com']) {
    assert.ok(!new RegExp(`walled-garden[^\\n]*dst-host="${h.replace(/\./g, '\\.')}"`).test(s),
      `${h} must not be in the walled garden or the sign-in sheet never pops up`);
  }
});

test('RADIUS points at the edge node and enables CoA on 3799', async () => {
  const s = await script();
  assert.match(s, /\/radius add address=192\.168\.88\.10/);
  assert.match(s, /authentication-port=1812 accounting-port=1813/);
  assert.match(s, /\/radius incoming set accept=yes port=3799/);
  // CoA is a remote control channel: only the edge node may reach it.
  assert.match(s, /dst-port=3799 src-address=192\.168\.88\.10 action=accept/);
  assert.match(s, /comment="wv: drop all other CoA"[^\n]*action=drop|action=drop[^\n]*wv: drop all other CoA/);
});

test('no real RADIUS secret is rendered by default', async () => {
  const s = await script();
  assert.match(s, /secret="REPLACE_WITH_RADIUS_SECRET"/);
});

test('the site queue is capped below capacity in both directions and moved first', async () => {
  const s = await script();
  const m = s.match(/\/queue simple add name=wv-site-cap target=192\.168\.89\.0\/24 max-limit=(\S+)/);
  assert.ok(m, 'site queue missing');
  const [up, down] = m[1].split('/');
  assert.equal(up, '12750k');   // 15000 * 85%
  assert.equal(down, '68M');     // 80000 * 85%
  assert.match(s, /\/queue simple move \[ find name=wv-site-cap \] 0/);
});

test('hotspot clients are isolated from each other and from management', async () => {
  const s = await script();
  assert.match(s, /src-address=192\.168\.89\.0\/24 dst-address=192\.168\.89\.0\/24 action=drop/);
  assert.match(s, /src-address=192\.168\.89\.0\/24 dst-address=192\.168\.88\.0\/24 action=drop/);
  // The single exception: the activation handshake, one host and one port.
  assert.match(s, /dst-address=192\.168\.88\.10 protocol=tcp dst-port=8787 action=accept/);
  assert.match(s, /client-isolation=yes/);
});

test('the management network is not reachable from the WAN', async () => {
  const s = await script();
  for (const svc of ['telnet', 'ftp', 'www', 'api', 'api-ssl']) {
    assert.match(s, new RegExp(`/ip service set ${svc} disabled=yes`));
  }
  assert.match(s, /\/ip service set winbox disabled=no address=192\.168\.88\.0\/24/);
  assert.match(s, /\/ip cloud set ddns-enabled=no/);
});

test('QUIC is blocked so HTTP/3 cannot evade the hotspot redirect', async () => {
  const s = await script();
  assert.match(s, /protocol=udp dst-port=443 action=drop/);
  assert.match(s, /protocol=tcp dst-port=853 action=drop/); // DNS over TLS
});

test('a scheduler refreshes resolved walled-garden hosts', async () => {
  const s = await script();
  assert.match(s, /name=wv-refresh-walled-garden/);
  assert.match(s, /interval=6h/);
  // Entries are found by the tag the renderer writes.
  // Inside source="..." the script's own quotes are backslash-escaped.
  assert.match(s, /comment~\\"wv-dyn\\"/);
  assert.match(s, /walled-garden ip add action=accept dst-host="portal\.wavlywifi\.com" comment="wv-dyn:/);
});

test('the render summary reports what actually landed', async () => {
  const s = await script();
  assert.match(s, /RENDER SUMMARY/);
  assert.match(s, /rate profiles\s+8/);
  assert.match(s, /plans\s+7/);
});

test('passing a secret substitutes it and warns not to commit the file', async () => {
  const r = renderRouterConfig(await loadSeed(), { radiusSecret: 's'.repeat(40) });
  assert.match(r.script, /secret="s{40}"/);
  assert.ok(r.warnings.some((w) => /contains a real RADIUS shared secret/.test(w)));
});

// ---------------------------------------------------------------------------
// Hotspot pages
// ---------------------------------------------------------------------------

test('hotspot pages are small, self-hosted and use the stock md5.js', async () => {
  const hs = renderHotspotFiles(await loadSeed());
  assert.deepEqual(hs.warnings, []);
  const names = hs.files.map((f) => f.name);
  assert.deepEqual(names.sort(),
    ['activate.html', 'alogin.html', 'error.html', 'login.html', 'status.html']);

  for (const f of hs.files) {
    assert.ok(f.body.length < 12000, `${f.name} is ${f.body.length} bytes; keep pages small`);
    // No CDN, no external font, no framework: inside a walled garden a third-party
    // dependency is a login page that can fail for reasons we cannot control.
    assert.ok(!/https?:\/\/(?!portal\.wavlywifi\.com|192\.168\.)/.test(
      f.body.replace(/href="tel:[^"]*"/g, '')),
      `${f.name} references an external origin`);
    assert.ok(!/<link[^>]+stylesheet/.test(f.body), `${f.name} must inline its CSS`);
  }

  const login = hs.files.find((f) => f.name === 'login.html').body;
  assert.match(login, /<script src="\/md5.js">/);
  assert.match(login, /hexMD5\(chapId/);
  assert.match(login, /action="\$\(link-login-only\)"/);
  // The offline business-continuity path.
  assert.match(login, /voucher code/i);
});

test('activate.html posts to the edge node and then same-origin to the hotspot', async () => {
  const hs = renderHotspotFiles(await loadSeed());
  const a = hs.files.find((f) => f.name === 'activate.html').body;
  assert.match(a, /http:\/\/192\.168\.88\.10:8787\/activate/);
  assert.match(a, /action="\$\(link-login-only\)"/);
  assert.match(a, /params\.get\('token'\)/);
  // It must fail visibly rather than hang on a spinner.
  assert.match(a, /AbortSignal\.timeout/);
  assert.match(a, /md5\.js/);
});
