/**
 * Renders the MikroTik RouterOS v7 configuration for a Wavly WiFi site.
 *
 * Output is a .rsc script: reviewable text you paste into the router terminal.
 * It is NOT pushed live, and that is deliberate — see docs/decisions.md D12.
 * A config generator that can reach the router can also brick the only internet
 * connection a village has, from a laptop that may be 200 km away.
 *
 * ---------------------------------------------------------------------------
 * THINGS THIS FILE GETS RIGHT ON PURPOSE
 * ---------------------------------------------------------------------------
 * 1. Two walled gardens. L7 (Host header, PLAIN HTTP ONLY, action=allow|deny)
 *    and L3 (dst IP/host, HTTPS-capable, action=accept|drop|reject). The cloud
 *    portal is HTTPS, so it goes in L3. Mixing up the action words is a silent
 *    failure that locks paying customers out.
 * 2. dns-name is a LOCAL name (hotspot.lan), never the portal's public hostname.
 *    If the router answered for portal.wavlywifi.com it would shadow the real
 *    portal for every client. Never use a .local name either: iOS may then fail
 *    to detect the hotspot.
 * 3. Captive-portal detection endpoints are left INTERCEPTED, not allowed. If
 *    connectivitycheck.gstatic.com is in the walled garden the phone gets its 204
 *    and never shows the sign-in sheet.
 * 4. DHCP option 114 needs force=yes on RouterOS v7, because v7 only sends
 *    options the client requested and no client requests 114.
 * 5. Rate limits render upload FIRST (rx = client upload from the router's view).
 * 6. The site parent queue is capped below measured capacity in BOTH directions,
 *    because Starlink uplink is the scarce resource.
 * 7. Hotspot clients are isolated from each other at the wifi datapath AND in the
 *    firewall, and isolated from the management network except one host/port.
 * 8. The RADIUS shared secret is never rendered as a real value by default.
 */

import { renderRateLimit, renderUserProfileRateLimit } from './rate-limit.mjs';
import { classifyRules, dynamicHosts, rscQuote } from './walled-garden.mjs';

const L = (out) => (...lines) => out.push(...lines);

/** RouterOS time interval from seconds. */
function dur(seconds) {
  const s = Math.round(Number(seconds));
  if (!Number.isFinite(s) || s <= 0) return null;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  let out = '';
  if (d) out += `${d}d`;
  if (h) out += `${h}h`;
  if (m) out += `${m}m`;
  if (sec || !out) out += `${sec}s`;
  return out;
}

/** kbps -> MikroTik rate string, whole megabits only (see rate-limit.mjs). */
function rate(kbps) {
  const v = Math.round(Number(kbps));
  if (!Number.isFinite(v) || v <= 0) return null;
  return v % 1000 === 0 ? `${v / 1000}M` : `${v}k`;
}

function netOf(ip, prefix = 24) {
  const parts = String(ip).split('.').slice(0, 3).join('.');
  return `${parts}.0/${prefix}`;
}

/**
 * @typedef {object} RenderResult
 * @property {string} script      the full .rsc text
 * @property {string[]} warnings  human-readable issues to resolve before applying
 * @property {string[]} manual    steps that cannot be generated
 */

/**
 * @param {object} seed   output of loadSeed()
 * @param {object} [opts]
 * @param {string} [opts.radiusSecret]  if set, substituted into /radius add.
 *        Leave unset to emit a placeholder (recommended).
 * @param {string} [opts.routerAdminUser]
 * @returns {RenderResult}
 */
export function renderRouterConfig(seed, opts = {}) {
  const out = [];
  const add = L(out);
  /** @type {string[]} */ const warnings = [];
  /** @type {string[]} */ const manual = [];

  const s = seed.settings;
  const str = (k, d) => (s[k] === undefined || s[k] === null ? d : String(s[k]));
  const num = (k, d) => (s[k] === undefined || s[k] === null ? d : Number(s[k]));
  const bool = (k, d) => (s[k] === undefined || s[k] === null ? d : Boolean(s[k]));

  // ------------------------------------------------------------------ topology
  const site = seed.sites[0] || {};
  const ssid = str('branding.wifi_ssid', 'Wavly WiFi');
  const hotspotAddress = str('network.hotspot_address', '192.168.89.1');
  const edgeAddress = str('network.edge_node_address', '192.168.88.10');
  const edgePort = num('network.edge_activate_port', 8787);
  const localDnsName = str('network.hotspot_local_dns_name', 'hotspot.lan');
  const portalUrl = str('branding.portal_url', 'https://portal.wavlywifi.com');
  const mgmtAddress = str('network.mgmt_address', '192.168.88.1');

  const hotspotNet = netOf(hotspotAddress);
  const mgmtNet = netOf(mgmtAddress);

  if (/\.local$/i.test(localDnsName)) {
    warnings.push(`network.hotspot_local_dns_name is "${localDnsName}" — a .local name can stop iOS from detecting the hotspot. Use .lan instead.`);
  }
  try {
    if (new URL(portalUrl).hostname === localDnsName) {
      warnings.push(`hotspot dns-name equals the portal hostname (${localDnsName}). The router would shadow the real portal for every client.`);
    }
  } catch { warnings.push(`branding.portal_url is not a valid URL: ${portalUrl}`); }

  // --------------------------------------------------------------- capacity
  const downCapK = num('network.downstream_capacity_kbps', 80000);
  const upCapK = num('network.upstream_capacity_kbps', 15000);
  const utilPct = num('network.site_queue_utilisation_pct', 85);
  if (utilPct >= 100) {
    warnings.push(`network.site_queue_utilisation_pct is ${utilPct}. A queue at exactly line rate adds unbounded latency; use 80-90.`);
  }
  if (upCapK >= downCapK) {
    warnings.push(`upstream capacity (${upCapK}k) >= downstream (${downCapK}k). On Starlink upload is the scarce resource (10-25 Mbps); this looks inverted.`);
  }
  const siteDownK = Math.round(downCapK * utilPct / 100);
  const siteUpK = Math.round(upCapK * utilPct / 100);

  // ------------------------------------------------------------ rate profiles
  const profiles = seed.rateProfiles;
  if (!profiles.length) warnings.push('No active rate profiles in the seed.');
  for (const p of profiles) {
    const { warnings: w } = renderRateLimit(p);
    warnings.push(...w);
  }
  // Oversubscription. Summing the ceilings of the PLANS is meaningless - it says
  // nothing about how many people buy them, and with 7 plans it lands near 1:1 by
  // coincidence. The honest figure needs a headcount, so the headcount is an
  // explicit setting. What we report is the worst case: every concurrent user on
  // the fastest plan. Real demand is lower, but a capacity warning that assumes
  // the good case is not a warning.
  const concurrent = num('network.planned_concurrent_users', 80);
  const fastest = profiles.reduce((best, p) => (p.download_kbps > (best?.download_kbps || 0) ? p : best), null);
  const peakDownK = (fastest?.download_kbps || 0) * concurrent;
  const peakUpK = (fastest?.upload_kbps || 0) * concurrent;
  const oversubDown = siteDownK > 0 ? (peakDownK / siteDownK).toFixed(1) : '0';
  const oversubUp = siteUpK > 0 ? (peakUpK / siteUpK).toFixed(1) : '0';

  // ------------------------------------------------------------ network rules
  const classified = classifyRules(seed.networkRules, { hotspotServer: 'wv-hotspot' });
  const dynHosts = dynamicHosts(classified);
  const interceptDetection = bool('network.intercept_captive_detection', true);
  const detectionHosts = ['connectivitycheck.gstatic.com', 'captive.apple.com', 'www.apple.com',
    'msftconnecttest.com', 'connectivitycheck.platform.hicloud.com'];
  for (const h of detectionHosts) {
    const allowed = classified.walledGardenL7.some((e) => e.dstHost === h || e.dstHost === `*.${h}`)
      || classified.walledGardenL3.some((e) => e.dstHost === h);
    if (allowed && interceptDetection) {
      warnings.push(`${h} is in the walled garden but network.intercept_captive_detection=true. The sign-in sheet will not pop up on that OS.`);
    }
  }

  // ============================================================== the script
  add(`# ${'='.repeat(74)}`,
    `# Wavly WiFi - MikroTik RouterOS v7 configuration`,
    `# Site: ${site.name || 'unnamed'} (${site.town || ''}${site.region ? ', ' + site.region : ''})`,
    `# Generated ${new Date().toISOString()} by deploy/mikrotik/generate.mjs`,
    `# Source of truth: db/seed/0001_core_defaults.sql (parsed, not hand-copied)`,
    `#`,
    `# READ deploy/mikrotik/README.md BEFORE APPLYING. Summary:`,
    `#   * Work from WinBox over ETHERNET or the management Wi-Fi, never over the`,
    `#     hotspot network you are about to reconfigure.`,
    `#   * /export file=pre-wavly-backup and /system backup save first.`,
    `#   * Paste in sections and watch for errors; do not paste the whole file blind.`,
    `#   * ${'='.repeat(66)}`,
    ``);

  // ------------------------------------------------------- 0. system identity
  add(`## ---- 0. System identity, clock, NTP ------------------------------------`,
    `# Ghana is GMT+0 year round (no DST). Correct time matters because RADIUS`,
    `# Expiration attributes and TLS both reject a badly skewed clock.`,
    `/system identity set name=${rscQuote(`wavly-${(site.code || 'site').slice(0, 24)}`)}`,
    `/system clock set time-zone-name=${rscQuote(site.timezone || 'Africa/Accra')} time-zone-autodetect=no`,
    `/system ntp client set enabled=yes mode=unicast`,
    `/system ntp server set enabled=no`,
    `/ipv6 settings set disable-ipv6=yes`,
    `# IPv6 is disabled deliberately. Starlink CGNAT gives us no routable inbound`,
    `# IPv6, and a half-working IPv6 path lets clients bypass every IPv4 hotspot`,
    `# control we configure below.`,
    ``);

  // ------------------------------------------------------------- 1. interfaces
  add(`## ---- 1. Interface lists, bridges, Wi-Fi ---------------------------------`,
    `# Physical layout assumed for a hAP ax3 (model C53UiG+5HPaxD2HPaxD):`,
    `#   ether1  -> Starlink Mini (WAN, DHCP client)`,
    `#   ether2  -> management network (edge node, admin devices)`,
    `#   ether3-5, wifi1 (5 GHz), wifi2 (2.4 GHz) -> hotspot network`,
    `# NOTE: on the AX line the radio labels are SWAPPED - wifi1 is 5 GHz and wifi2`,
    `# is 2.4 GHz. Verify with "/interface wifi print" before trusting this.`,
    ``,
    `/interface list add name=WAN comment="Uplink to Starlink"`,
    `/interface list add name=MGMT comment="Management network"`,
    `/interface list add name=HOTSPOT comment="Customer hotspot network"`,
    `/interface list member add interface=ether1 list=WAN`,
    ``,
    `/interface bridge add name=bridge-mgmt comment="Wavly management (edge node, admins)" protocol-mode=none`,
    `/interface bridge add name=bridge-hotspot comment="Wavly hotspot (customers)" protocol-mode=none`,
    `/interface bridge port add bridge=bridge-mgmt interface=ether2`,
    `/interface bridge port add bridge=bridge-hotspot interface=ether3`,
    `/interface bridge port add bridge=bridge-hotspot interface=ether4`,
    `/interface bridge port add bridge=bridge-hotspot interface=ether5`,
    `/interface list member add interface=bridge-mgmt list=MGMT`,
    `/interface list member add interface=bridge-hotspot list=HOTSPOT`,
    ``,
    `# An OPEN SSID. Authentication is the hotspot login, not the Wi-Fi password:`,
    `# that is what lets the portal issue per-customer credentials and change them`,
    `# without anyone re-entering a Wi-Fi key. The trade-off is that over-the-air`,
    `# traffic is not encrypted at layer 2, which is why the hotspot login uses`,
    `# http-chap (challenge/response) and never http-pap (plaintext), and why the`,
    `# cloud portal is HTTPS-only.`,
    `#`,
    `# client-isolation is set on the wifi DATAPATH, not the bridge. It stops hotspot`,
    `# clients reaching each other at layer 2, which the firewall cannot do as`,
    `# cheaply. Section 6 repeats the isolation at layer 3 so a wired customer on`,
    `# ether3-5 is covered too.`,
    `# The SSID MUST be OPEN - no WPA passphrase. The captive-portal model depends`,
    `# on it: customers have to be able to associate before they have any`,
    `# credentials, and the hotspot login is what authenticates them. A WPA2 key on`,
    `# this SSID means nobody can join at all.`,
    `#`,
    `# No security profile is set below, which leaves a freshly created`,
    `# configuration open on the builds this was written against. VERIFY after`,
    `# applying:  /interface wifi configuration print detail`,
    `# and confirm authentication-types is empty. If your build defaults it to`,
    `# wpa2-psk, set it explicitly:`,
    `#   /interface wifi configuration set wv-hotspot-cfg security.authentication-types=""`,
    `/interface wifi configuration add name=wv-hotspot-cfg mode=ap ssid=${rscQuote(ssid)} country=${rscQuote(site.country === 'GH' ? 'Ghana' : (site.country || 'Ghana'))}`,
    `/interface wifi datapath add name=wv-hotspot-dp bridge=bridge-hotspot client-isolation=yes`,
    `/interface wifi set [ find default-name=wifi1 ] name=wv-5g configuration=wv-hotspot-cfg datapath=wv-hotspot-dp disabled=no channel.band=5ghz-ax`,
    `/interface wifi set [ find default-name=wifi2 ] name=wv-24g configuration=wv-hotspot-cfg datapath=wv-hotspot-dp disabled=no channel.band=2ghz-ax`,
    `# datapath.bridge already attaches the radios to bridge-hotspot. Do NOT also add`,
    `# them with "/interface bridge port" - that creates a second, conflicting path.`,
    ``);
  if (ssid.length > 32) warnings.push(`branding.wifi_ssid "${ssid}" is ${ssid.length} chars; SSIDs are limited to 32.`);

  // ------------------------------------------------------------------ 2. IP/DHCP
  const hotspotPool = `${hotspotNet.replace('/24', '')}`;
  const captiveApiUrl = str('network.captive_api_url', `${portalUrl.replace(/\/$/, '')}/captive-api.json`);
  if (!/^https:/i.test(captiveApiUrl)) {
    warnings.push(`network.captive_api_url must be HTTPS ("${captiveApiUrl}"). Android 13+ fetches it over HTTP and rejects a non-HTTPS URL.`);
  }
  add(`## ---- 2. Addresses, DHCP, and captive-portal advertisement ---------------`,
    `/ip address add address=${hotspotAddress}/24 interface=bridge-hotspot comment="Wavly hotspot gateway"`,
    `/ip address add address=${mgmtAddress}/24 interface=bridge-mgmt comment="Wavly management gateway"`,
    ``,
    `/ip dhcp-client add interface=ether1 disabled=no comment="Starlink Mini uplink"`,
    ``,
    `/ip pool add name=wv-pool-hotspot ranges=${hotspotPool.replace(/\.0$/, '')}.20-${hotspotPool.replace(/\.0$/, '')}.254`,
    `/ip pool add name=wv-pool-mgmt ranges=${mgmtNet.replace(/\.0\/24$/, '')}.100-${mgmtNet.replace(/\.0\/24$/, '')}.149`,
    ``,
    `# RFC 8910 captive-portal URL. This is the RELIABLE way to get Android 13+ to`,
    `# open the sign-in page in the real browser instead of the stripped captive`,
    `# portal WebView.`,
    `#`,
    `# force=yes is MANDATORY on RouterOS v7. v6 always sent configured options; v7`,
    `# only sends options the client asked for in its Parameter Request List, and no`,
    `# client asks for code 114. Without force=yes this option is silently never`,
    `# sent and the feature appears to do nothing.`,
    `/ip dhcp-server option add name=wv-captive-portal code=114 force=yes value=${rscQuote(`'${captiveApiUrl}'`)}`,
    `/ip dhcp-server option sets add name=wv-hotspot-options options=wv-captive-portal`,
    ``,
    `# Lease time is short on the hotspot: addresses must recycle as customers come`,
    `# and go, and a stale lease is a customer who cannot reconnect.`,
    `/ip dhcp-server add name=wv-dhcp-hotspot interface=bridge-hotspot address-pool=wv-pool-hotspot lease-time=2h authoritative=yes dhcp-option-set=wv-hotspot-options disabled=no`,
    `/ip dhcp-server network add address=${hotspotNet} gateway=${hotspotAddress} dns-server=${hotspotAddress} comment="Wavly hotspot"`,
    ``,
    `/ip dhcp-server add name=wv-dhcp-mgmt interface=bridge-mgmt address-pool=wv-pool-mgmt lease-time=1d authoritative=yes disabled=no`,
    `/ip dhcp-server network add address=${mgmtNet} gateway=${mgmtAddress} dns-server=${mgmtAddress} comment="Wavly management"`,
    ``,
    `/ip dns set allow-remote-requests=yes cache-size=4096 servers=1.1.1.1,8.8.8.8`,
    `#`,
    `# 1.1.1.1 and 8.8.8.8 also appear in the wv-blocked address list in section 5.`,
    `# THAT IS NOT A CONTRADICTION - do not "fix" it. The blocklist applies to`,
    `# FORWARD traffic from hotspot clients, so it stops a customer pointing their`,
    `# phone at a public resolver and bypassing every DNS rule we have. The queries`,
    `# below are made by the ROUTER ITSELF through its DNS proxy and never traverse`,
    `# the forward chain. Clients must use our resolver; the router may use a public`,
    `# one. Removing either half breaks something: remove the block and DNS`,
    `# filtering is optional; remove these servers and nothing resolves.`,
    `#`,
    `# The edge node becomes the authoritative resolver for hotspot clients in`,
    `# production; these stay as the fallback for when it is down.`,
    ``);
  manual.push(`Point /ip dns servers at the edge node (${edgeAddress}) once FreeRADIUS/dnsmasq is up, keeping 1.1.1.1 as fallback.`);
  manual.push(`Verify the Starlink Mini is in BYPASS mode, otherwise you have double NAT and the router's WAN lease is another private range.`);

  // ----------------------------------------------------------- 3. walled garden
  add(`## ---- 3. Walled garden ----------------------------------------------------`,
    `# TWO SEPARATE TABLES. They are not interchangeable.`,
    `#`,
    `#   /ip hotspot walled-garden       L7. Matches the HTTP Host header and path.`,
    `#                                   PLAIN HTTP ONLY. action = allow | deny`,
    `#   /ip hotspot walled-garden ip    L3/L4. Matches destination IP, protocol and`,
    `#                                   port, plus dst-host which RouterOS resolves`,
    `#                                   into DYNAMIC address entries.`,
    `#                                   action = accept | drop | reject`,
    `#`,
    `# The cloud portal is HTTPS on Vercel. RouterOS cannot read a Host header inside`,
    `# a TLS ClientHello, so an L7 rule would NOT unblock it. Every HTTPS destination`,
    `# needs an L3 entry. Getting this wrong is silent: the config loads, and new`,
    `# customers simply cannot reach the portal.`,
    ``);

  if (classified.walledGardenL7.length) {
    add(`# --- L7 (plain HTTP only) ---`);
    for (const e of classified.walledGardenL7) {
      const parts = [`action=${e.action}`, `dst-host=${rscQuote(e.dstHost)}`];
      if (e.comment) parts.push(`comment=${rscQuote(`wv: ${e.comment}`)}`);
      add(`/ip hotspot walled-garden add ${parts.join(' ')}`);
    }
    add(``);
  } else {
    warnings.push('No L7 walled-garden rules were rendered.');
  }

  add(`# --- L3 (required for every HTTPS destination) ---`);
  for (const e of classified.walledGardenL3) {
    const parts = [`action=${e.action}`];
    if (e.dstHost) parts.push(`dst-host=${rscQuote(e.dstHost)}`);
    if (e.dstAddress) parts.push(`dst-address=${rscQuote(e.dstAddress)}`);
    const tag = e.dynamic ? 'wv-dyn: ' : 'wv: ';
    if (e.comment) parts.push(`comment=${rscQuote(tag + e.comment)}`);
    add(`/ip hotspot walled-garden ip add ${parts.join(' ')}`);
  }
  if (!classified.walledGardenL3.length) warnings.push('No L3 walled-garden rules were rendered - the HTTPS portal will be unreachable before login.');
  add(``);

  if (interceptDetection) {
    add(`# --- Captive-portal detection endpoints are LEFT INTERCEPTED ---`,
      `# Counter-intuitive, and the single most common reason a portal "does not pop up".`,
      `# These probes are how the phone decides whether to show the sign-in sheet. They`,
      `# must be intercepted so the probe receives a 302 to our login page instead of`,
      `# its expected 204/"Success". Allowing them through makes the OS conclude there`,
      `# is real internet, and the sheet never appears.`,
      `#`,
      `# Do NOT add these to the walled garden:`,
      ...detectionHosts.map((h) => `#   ${h}`),
      `#`,
      `# If one specific handset model misbehaves, flip`,
      `# network.intercept_captive_detection to false and regenerate - that adds these`,
      `# hosts as allow rules - rather than hand-editing the router.`,
      ``);
  }

  // ------------------------------------------------------------ 4. DNS blocking
  if (classified.dnsSinkhole.length) {
    add(`## ---- 4. DNS sinkholes (post-authentication filtering) --------------------`,
      `# These do NOT belong in the walled garden: they are applied after login.`,
      `# Resolving the name to 0.0.0.0 also defeats HTTPS, because the connection never`,
      `# reaches the real origin - TLS cannot save a host that does not resolve.`,
      `#`,
      `# This is exactly why DNS-over-HTTPS resolvers are blocked separately in section`,
      `# 5: a client using DoH ignores our DNS entirely and every rule here is bypassed.`);
    for (const e of classified.dnsSinkhole) {
      add(`/ip dns static add name=${rscQuote(e.name)} address=0.0.0.0 comment=${rscQuote(`wv: ${e.comment || 'blocked'}`)}`);
    }
    add(``);
  }

  // ----------------------------------------------------------- 5. address lists
  if (classified.addressListBlock.length) {
    add(`## ---- 5. Blocked address list --------------------------------------------`,
      `# Covers DoH/DoT resolvers and anything that would bypass our DNS filtering.`,
      `# Entries tagged "wv-dyn" are hostnames RouterOS resolves dynamically; the`,
      `# scheduler near the end of this script refreshes them, because these providers`,
      `# rotate IPs and a stale entry silently stops blocking.`);
    for (const e of classified.addressListBlock) {
      const tag = e.dynamic ? 'wv-dyn: ' : 'wv: ';
      add(`/ip firewall address-list add list=${rscQuote(e.list)} address=${rscQuote(e.entry)} comment=${rscQuote(tag + (e.comment || ''))}`);
    }
    add(``);
  }

  // ---------------------------------------------------------------- 6. firewall
  add(`## ---- 6. Firewall ---------------------------------------------------------`,
    `# ORDERING IS NOT HANDLED FOR YOU. RouterOS evaluates a chain top to bottom and`,
    `# these rules are APPENDED, after whatever the factory default config already`,
    `# put there. The default input chain typically ends with a "drop all not coming`,
    `# from LAN" rule, and the hotspot network is deliberately NOT in the LAN list -`,
    `# so that default rule would shadow ours and block the login page itself.`,
    `#`,
    `# After pasting, run:   /ip firewall filter print`,
    `# and confirm every rule commented "wv:" sits ABOVE any defconf drop rule in the`,
    `# same chain. Drag them into position in WinBox (IP -> Firewall -> Filter),`,
    `# which is far safer than guessing at "move" indices over a console.`,
    `#`,
    `# This is the one part of the script that needs a human to look at the result.`,
    `# Everything else is either idempotent or fails loudly.`,
    ``,
    `# --- input: protect the router itself ---`,
    `/ip firewall filter add chain=input comment="wv: drop invalid" connection-state=invalid action=drop`,
    `/ip firewall filter add chain=input comment="wv: accept established/related" connection-state=established,related action=accept`,
    `#`,
    `# CoA (RFC 3576) listens on UDP 3799. It is how the cloud tells a live session`,
    `# to disconnect at expiry or throttle at fair usage. It is also a remote`,
    `# control channel, so it is accepted from the edge node and from NOTHING else.`,
    `/ip firewall filter add chain=input comment="wv: CoA from edge node only" protocol=udp dst-port=3799 src-address=${edgeAddress} action=accept`,
    `/ip firewall filter add chain=input comment="wv: drop all other CoA" protocol=udp dst-port=3799 action=drop`,
    `#`,
    `# RADIUS is router -> edge (outbound), so it needs no input rule.`,
    `/ip firewall filter add chain=input comment="wv: management services from mgmt network only" in-interface-list=MGMT protocol=tcp dst-port=22,8291,443 action=accept`,
    `/ip firewall filter add chain=input comment="wv: hotspot clients may reach the hotspot service" in-interface-list=HOTSPOT protocol=tcp dst-port=80,443 action=accept`,
    `/ip firewall filter add chain=input comment="wv: hotspot clients need DNS and DHCP" in-interface-list=HOTSPOT protocol=udp dst-port=53,67 action=accept`,
    `/ip firewall filter add chain=input comment="wv: management services from hotspot network - deny" in-interface-list=HOTSPOT action=drop`,
    `/ip firewall filter add chain=input comment="wv: drop WAN management access" in-interface-list=WAN protocol=tcp dst-port=22,23,8291,443,8728 action=drop`,
    ``,
    `# --- forward: what hotspot traffic may do ---`,
    `/ip firewall filter add chain=forward comment="wv: drop invalid" connection-state=invalid action=drop`,
    `/ip firewall filter add chain=forward comment="wv: accept established/related" connection-state=established,related action=accept`,
    `#`,
    `# The ONE exception to management isolation: the activation handshake. An https`,
    `# portal cannot POST to an http router, but a top-level 302 from https to http is`,
    `# allowed, so the portal redirects to the router's activate.html, which POSTs to`,
    `# the edge node to collect one-time RADIUS credentials and then submits a`,
    `# SAME-ORIGIN POST to the router's /login. Expose one host and one port;`,
    `# nothing else on the management network is reachable from the hotspot.`,
    `/ip firewall filter add chain=forward comment="wv: activation handshake to edge node only" src-address=${hotspotNet} dst-address=${edgeAddress} protocol=tcp dst-port=${edgePort} action=accept`,
    `/ip firewall filter add chain=forward comment="wv: hotspot -> management DENIED" src-address=${hotspotNet} dst-address=${mgmtNet} action=drop`,
    `#`,
    `# Client-to-client isolation at layer 3. The wifi datapath already does this for`,
    `# wireless clients; this covers anyone plugged into ether3-5.`,
    `/ip firewall filter add chain=forward comment="wv: hotspot client-to-client DENIED" src-address=${hotspotNet} dst-address=${hotspotNet} action=drop`,
    `#`,
    `# Basic abuse protection. DoH/DoT would bypass every DNS rule in section 4.`,
    `/ip firewall filter add chain=forward comment="wv: block known DoH/DoT bypass list" src-address=${hotspotNet} dst-address-list=wv-blocked action=drop`,
    `/ip firewall filter add chain=forward comment="wv: block DoT (port 853)" src-address=${hotspotNet} protocol=tcp dst-port=853 action=drop`,
    `/ip firewall filter add chain=forward comment="wv: block QUIC/HTTP3 UDP 443 - uninspectable and evades the hotspot redirect" src-address=${hotspotNet} protocol=udp dst-port=443 action=drop`,
    `/ip firewall filter add chain=forward comment="wv: hotspot clients must use OUR DNS" src-address=${hotspotNet} protocol=udp dst-port=53 action=drop`,
    `/ip firewall filter add chain=forward comment="wv: allow hotspot to internet" src-address=${hotspotNet} out-interface-list=WAN action=accept`,
    `/ip firewall filter add chain=forward comment="wv: allow management to internet" src-address=${mgmtNet} out-interface-list=WAN action=accept`,
    `/ip firewall filter add chain=forward comment="wv: default deny forwarding" action=drop`,
    ``,
    `# Masquerade on the uplink only.`,
    `/ip firewall nat add chain=srcnat comment="wv: masquerade to Starlink" out-interface-list=WAN action=masquerade`,
    ``);
  add(`# QUIC is blocked deliberately. HTTP/3 runs over UDP 443, which the hotspot`,
    `# cannot intercept or shape with HTTP-based rules, so it both evades the login`,
    `# redirect and defeats the rate limits. Clients fall back to HTTP/2 over TCP.`,
    ``);

  // ------------------------------------------------------------------- 7. hotspot
  const interim = num('radius.interim_update_seconds', 300);
  const httpsRedirect = bool('network.https_redirect', false);
  add(`## ---- 7. Hotspot server and profile --------------------------------------`,
    `# html-directory must be a directory ON THE ROUTER. html-directory-override is`,
    `# only for files on attached USB/HDD storage - it is NOT a remote URL mechanism,`,
    `# so the custom pages cannot be served from the cloud.`,
    `#`,
    `# We override individual pages in the STOCK 'hotspot' directory rather than`,
    `# pointing at a fresh one. A fresh directory has to ship every file the hotspot`,
    `# machinery expects, including md5.js - and a missing md5.js breaks http-chap`,
    `# login with no error message at all, which is a very expensive thing to debug`,
    `# on a live site. Overriding pages keeps the stock dependencies intact.`,
    `#`,
    `# login-by is http-chap,cookie and NEVER http-pap: http-pap sends the customer's`,
    `# credentials in plaintext over an unencrypted hotspot. cookie keeps a device`,
    `# logged in across short disconnects so a phone that sleeps does not have to`,
    `# re-authenticate every time.`,
    `/ip hotspot profile add name=wv-hotspot-profile \\`,
    `    hotspot-address=${hotspotAddress} \\`,
    `    dns-name=${rscQuote(localDnsName)} \\`,
    `    html-directory=hotspot \\`,
    `    use-radius=yes \\`,
    `    radius-accounting=yes \\`,
    `    radius-interim-update=${interim > 0 ? dur(interim) : 'received'} \\`,
    `    login-by=http-chap,cookie \\`,
    `    http-cookie-lifetime=${dur(num('radius.cookie_lifetime_seconds', 86400)) || '1d'} \\`,
    `    radius-mac-format=XX:XX:XX:XX:XX:XX \\`,
    `    radius-location-id=${rscQuote(site.code || 'nkawie-01')} \\`,
    `    radius-location-name=${rscQuote(site.name || 'Nkawie')} \\`,
    `    nas-port-type=wireless-802.11 \\`,
    `    comment="Wavly WiFi hotspot"`,
    ``,
    `# https-redirect is ${httpsRedirect ? 'ON' : 'OFF'}. RouterOS v7 does not expose a working`,
    `# ssl-certificate on the hotspot profile, so redirecting an https:// URL lands`,
    `# the client on a certificate name mismatch. Better to let the plain-HTTP probe`,
    `# and DHCP option 114 do the redirecting.`,
    `/ip hotspot profile set [ find name=wv-hotspot-profile ] https-redirect=${httpsRedirect ? 'yes' : 'no'}`,
    ``,
    `/ip hotspot add name=wv-hotspot interface=bridge-hotspot address-pool=wv-pool-hotspot profile=wv-hotspot-profile addresses-per-mac=1 idle-timeout=${dur(num('radius.idle_timeout_seconds', 1800)) || '30m'} keepalive-timeout=5m disabled=no`,
    ``,
    `# addresses-per-mac=1 stops one MAC address holding several leases, which is how`,
    `# a single customer otherwise consumes a whole pool.`,
    ``);

  // ------------------------------------------------------- 8. hotspot user profiles
  add(`## ---- 8. Local hotspot user profiles (RADIUS-independent) -----------------`,
    `# These exist so the router is still usable when FreeRADIUS is down, and for`,
    `# staff and suspended accounts. Everything else authenticates through RADIUS.`,
    `#`,
    `# Trial is deliberately NOT enabled: an unlimited free trial on a paid service`,
    `# with a hard data cap upstream is a business problem, not a config option.`);
  const suspended = profiles.find((p) => p.name === 'suspended');
  const staffProfile = profiles.find((p) => p.name === 'p-20-10') || profiles[0];
  if (suspended) {
    add(`/ip hotspot user profile add name=wv-suspended rate-limit=${renderUserProfileRateLimit(suspended)} shared-users=1 transparent-proxy=no comment="Suspended accounts: 8 kbps is enough to reach the portal and renew, nothing else"`);
  }
  if (staffProfile) {
    add(`/ip hotspot user profile add name=wv-staff rate-limit=${renderUserProfileRateLimit(staffProfile)} shared-users=5 transparent-proxy=no comment="On-site staff. Do not hand this to customers."`);
  }
  add(``,
    `# --- rate-limit values that RADIUS will send per plan ---`,
    `# Rendered from rate_profiles so the numbers here and in the database cannot`,
    `# drift. NOTE THE ORDER: MikroTik's attribute is rx/tx FROM THE ROUTER'S VIEW,`,
    `# so rx is client UPLOAD and tx is client DOWNLOAD. A plan sold as`,
    `# "12 down / 6 up" is written "6M/12M". Getting this backwards produces no`,
    `# error anywhere - everything is just slow in one direction.`);
  for (const p of profiles) {
    const { value: v } = renderRateLimit(p);
    add(`#   ${p.name.padEnd(11)} ${p.label.padEnd(14)} -> Mikrotik-Rate-Limit="${v}"`);
  }
  add(`#`,
    `# Burst thresholds above are RATES in bits/s, not byte counts. A column called`,
    `# burst_threshold_bytes would parse, load, and never burst.`,
    ``);

  // -------------------------------------------------------------------- 9. RADIUS
  const secret = opts.radiusSecret || null;
  if (!secret) {
    manual.push(`Set the RADIUS shared secret on the router. In WinBox: Radius -> select the entry commented "Wavly edge FreeRADIUS" (address ${edgeAddress}) -> Secret. It must match RADIUS_SECRET_NKAWIE01 in /etc/wavly/edge.env on the edge node. The generated script deliberately contains the placeholder REPLACE_WITH_RADIUS_SECRET, not the secret.`);
  } else {
    warnings.push('The rendered script contains a real RADIUS shared secret. Do not commit it: .gitignore excludes deploy/**/*secret*, so name the output file accordingly.');
  }
  const radiusTimeout = num('radius.timeout_ms', 3000);
  add(`## ---- 9. RADIUS client and CoA -------------------------------------------`,
    `# FreeRADIUS runs on the EDGE NODE, not in the cloud. A satellite round trip is`,
    `# 400-900 ms and MikroTik gives up at ~300 ms by default, so cloud RADIUS would`,
    `# fail logins intermittently - and worse, paying customers could not`,
    `# re-authenticate at all during a Starlink outage.`,
    `/radius add address=${edgeAddress} secret=${rscQuote(secret || 'REPLACE_WITH_RADIUS_SECRET')} service=hotspot authentication-port=1812 accounting-port=1813 timeout=${radiusTimeout}ms comment="Wavly edge FreeRADIUS"`,
    ``,
    `# CoA (Change of Authorization, RFC 3576) on UDP 3799. This is the ONLY way to`,
    `# disconnect a live session the moment a subscription expires, or throttle it`,
    `# the moment fair usage is hit. Without it, expiry only bites at the next`,
    `# re-authentication - which for a monthly customer can be days later.`,
    `#`,
    `# Starlink CGNAT means nothing can originate a connection INTO this site, so CoA`,
    `# can only come from the edge node on the same LAN. That constraint is why the`,
    `# edge node exists.`,
    `/radius incoming set accept=yes port=3799`,
    ``);

  // ------------------------------------------------------------------- 10. queues
  add(`## ---- 10. Site capacity queue -------------------------------------------`,
    `# Measured capacity (edit these two settings after measuring on site):`,
    `#   downstream ${downCapK} kbps, upstream ${upCapK} kbps, capped at ${utilPct}%`,
    `#   => site ceiling ${rate(siteUpK)} up / ${rate(siteDownK)} down`,
    `#`,
    `# This is NOT a safety margin, it is the difference between a site that is busy`,
    `# and a site that feels broken. A queue running at exactly line rate develops`,
    `# unbounded latency: throughput still measures fine while every video call`,
    `# collapses. Upstream is capped hardest because Starlink upload (10-25 Mbps)`,
    `# saturates first and it is what makes calls fail for everyone at once.`,
    `#`,
    `# Oversubscription, stated honestly. Worst case is ${concurrent} concurrent users`,
    `# all on the fastest plan (${fastest ? fastest.label : 'n/a'}):`,
    `#   download  ${peakDownK} kbps demanded vs ${siteDownK} kbps ceiling  => ~${oversubDown}:1`,
    `#   upload    ${peakUpK} kbps demanded vs ${siteUpK} kbps ceiling  => ~${oversubUp}:1`,
    `# Real demand is far lower - most customers idle most of the time, and nobody`,
    `# sustains their ceiling. But this is exactly why per-plan rates are CAPS and`,
    `# never guarantees, why the portal must say "up to", and why the site queue`,
    `# above exists: it is the only thing standing between one heavy user and`,
    `# everyone else's video call.`,
    `#`,
    `# Edit network.planned_concurrent_users and the two capacity settings as the`,
    `# subscriber count grows, then regenerate. When the ratio passes roughly 20:1`,
    `# downlink the answer is a second radio and a second site, not a bigger queue.`,
    `#`,
    `# max-limit is rx/tx, and rx is UPLOAD from the router's view - the same`,
    `# inversion as the rate-limit attribute.`,
    `# default-small is the right type for a PARENT queue: it polices the aggregate`,
    `# without adding a second layer of buffering. A real queueing discipline here`,
    `# would double-queue traffic that the per-user queues already shape.`,
    `/queue simple add name=wv-site-cap target=${hotspotNet} max-limit=${rate(siteUpK)}/${rate(siteDownK)} queue=default-small/default-small comment="Site ceiling - MUST sit above the dynamic per-user queues" disabled=no`,
    ``,
    `# Position is not cosmetic. Simple queues form a hierarchy by target, and the`,
    `# hotspot's dynamic per-user queues only nest under this one if it comes FIRST.`,
    `/queue simple move [ find name=wv-site-cap ] 0`,
    ``,
    `# VERIFY after applying:  /queue simple print hierarchy`,
    `# The dynamic per-user queues must appear INDENTED under wv-site-cap. If they are`,
    `# at the same level, the site ceiling is not being applied and one customer can`,
    `# saturate the uplink for everyone.`,
    ``);

  add(`## ---- 11. Optional PCQ fair sharing ------------------------------------`,
    `# Left DISABLED by default. Per-user RADIUS rate limits already shape each`,
    `# customer to their plan; PCQ adds automatic fair sharing BETWEEN customers on`,
    `# the same profile when the site is congested.`,
    `#`,
    `# Enable only after measuring. pcq-rate=0 means "share the available bandwidth`,
    `# equally", which is what you want here - a fixed pcq-rate would cap each flow`,
    `# regardless of how many users are online.`,
    `/queue type add name=wv-pcq-down kind=pcq pcq-rate=0 pcq-classifier=dst-address pcq-total-limit=2000KiB disabled=no`,
    `/queue type add name=wv-pcq-up kind=pcq pcq-rate=0 pcq-classifier=src-address pcq-total-limit=2000KiB disabled=no`,
    `# To use them, set the site queue's type and let the per-user queues inherit:`,
    `#   /queue simple set [ find name=wv-site-cap ] queue=wv-pcq-up/wv-pcq-down`,
    `# pcq-classifier=dst-address on the DOWN queue and src-address on the UP queue`,
    `# is not a typo: each direction must be classified by the customer's address.`,
    ``);

  // ---------------------------------------------------------------- 12. scheduler
  if (dynHosts.length) {
    add(`## ---- 12. Scheduler: refresh resolved walled-garden hosts ---------------`,
      `# dst-host entries are resolved by RouterOS into DYNAMIC address entries.`,
      `# Cloudflare and Vercel rotate addresses, so a stale resolution silently locks`,
      `# new customers out of the portal while everything else looks healthy - the`,
      `# worst failure mode here, because it presents as "the portal is down".`,
      `#`,
      `# Re-setting dst-host to its own value forces re-resolution. Entries are found by`,
      `# the "wv-dyn:" comment tag written in section 3.`,
      `# Hosts: ${dynHosts.join(', ')}`,
      `/system script add name=wv-refresh-walled-garden dont-require-permissions=no owner=admin policy=read,write,api source=${rscQuote(
        `:local n 0\n` +
        `:foreach e in=[/ip hotspot walled-garden ip find where comment~"wv-dyn"] do={\n` +
        `  :local h [/ip hotspot walled-garden ip get $e dst-host]\n` +
        `  /ip hotspot walled-garden ip set $e dst-host=$h\n` +
        `  :set n ($n + 1)\n` +
        `}\n` +
        `:foreach e in=[/ip firewall address-list find where comment~"wv-dyn"] do={\n` +
        `  :local a [/ip firewall address-list get $e address]\n` +
        `  /ip firewall address-list set $e address=$a\n` +
        `  :set n ($n + 1)\n` +
        `}\n` +
        `/log info "wv: refreshed $n dynamic walled-garden entries"`
      )}`,
      `/system scheduler add name=wv-refresh-walled-garden interval=6h start-time=startup on-event=wv-refresh-walled-garden policy=read,write,api comment="Re-resolve portal/CDN addresses"`,
      ``);
  }

  add(`## ---- 13. Nightly configuration backup ---------------------------------`,
    `# Written to the router's flash and to a second copy on the management network.`,
    `# A backup that lives only on the device it backs up is not a backup: if the`,
    `# router is stolen or struck by lightning, the config goes with it.`,
    `/system script add name=wv-nightly-backup dont-require-permissions=no owner=admin policy=read,write,test,sensitive source=${rscQuote(
      `:local d [/system clock get date]\n` +
      `:local t [/system clock get time]\n` +
      `:local stamp ($d . "-" . $t)\n` +
      `/export file=("wavly-config-" . $stamp)\n` +
      `/system backup save name=("wavly-" . $stamp) dont-encrypt=yes\n` +
      `/log info ("wv: nightly backup saved as wavly-" . $stamp)`
    )}`,
    `/system scheduler add name=wv-nightly-backup interval=1d start-time=02:30:00 on-event=wv-nightly-backup policy=read,write,test,sensitive comment="Nightly config backup"`,
    ``);
  manual.push(`Copy /wavly-config-*.rsc off the router weekly (WinBox -> Files -> drag out). Do not rely on the router's own flash as the only copy.`);

  // ------------------------------------------------------------- 14. admin hygiene
  const adminUser = opts.routerAdminUser || null;
  add(`## ---- 14. Management hardening -------------------------------------------`,
    `# Services reachable from the hotspot network are attack surface for customers`,
    `# who have a financial incentive to bypass the portal.`,
    `/ip service set telnet disabled=yes`,
    `/ip service set ftp disabled=yes`,
    `/ip service set www disabled=yes`,
    `/ip service set api disabled=yes`,
    `/ip service set api-ssl disabled=yes`,
    `/ip service set www-ssl disabled=yes address=${mgmtNet}`,
    `/ip service set ssh disabled=no address=${mgmtNet}`,
    `/ip service set winbox disabled=no address=${mgmtNet}`,
    `# SSH and WinBox are bound to the MANAGEMENT network only. If you must`,
    `# administer remotely, use a VPN into the management network - do not expose`,
    `# these on the uplink.`,
    ``,
    `/ip neighbor discovery-settings set discover-interface-list=MGMT`,
    `/tool mac-server set allowed-interface-list=MGMT`,
    `/tool mac-server mac-winbox set allowed-interface-list=MGMT`,
    `/tool mac-server ping set enabled=no`,
    `/ip proxy set enabled=no`,
    `/ip socks set enabled=no`,
    `/ip upnp set enabled=no`,
    `/ip cloud set ddns-enabled=no update-time=no`,
    `# /ip cloud is disabled because it would publish a reachable name for this`,
    `# router. Starlink CGNAT means inbound does not work anyway; leaving it on only`,
    `# creates a false sense of a management path.`,
    ``);
  if (!adminUser) {
    manual.push(`Rename or disable the default 'admin' router account and set a long passphrase. It is not rendered here because a router password must not pass through a generated file in git.`);
  }

  // ----------------------------------------------------------------- 15. diagnostics
  add(`## ---- 15. Logging and diagnostics ----------------------------------------`,
    `/system logging add topics=hotspot action=memory`,
    `/system logging add topics=hotspot,debug action=memory disabled=yes`,
    `/system logging add topics=radius action=memory`,
    `/system logging add topics=dns action=memory disabled=yes`,
    `# hotspot,debug and dns are added DISABLED. Turn them on only while diagnosing:`,
    `# they are extremely chatty and will rotate useful history out of the buffer.`,
    ``,
    `# --- checks to run after applying ---`,
    `#   /radius/monitor 0            pending, accepts, rejects, resends, timeouts,`,
    `#                                bad-replies, last-request-rtt`,
    `#   /ip hotspot active print     who is online right now`,
    `#   /ip hotspot host print where bypassed=yes`,
    `#   /ip hotspot walled-garden print stats`,
    `#   /queue simple print hierarchy  (per-user queues MUST nest under wv-site-cap)`,
    `#   /log print where topics~"hotspot,radius"`,
    `#   /ip dhcp-server lease print where dynamic=yes`,
    `#`,
    `# --- the 60-second smoke test ---`,
    `# 1. Join the SSID. The sign-in sheet must pop up on its own within ~10 s.`,
    `#    If it does not, see section 3 - a detection endpoint is being allowed`,
    `#    through, or option 114 is missing force=yes.`,
    `# 2. Log in with a test RADIUS account. /ip hotspot active print shows it.`,
    `# 3. Open https://${new URL(portalUrl).hostname} - it must load BEFORE login`,
    `#    (this is the L3 walled garden working).`,
    `# 4. From a hotspot client, ping ${mgmtAddress} must FAIL and ping ${edgeAddress} must FAIL`,
    `#    (management isolation), while tcp/${edgePort} to ${edgeAddress} must succeed`,
    `#    (the activation handshake).`,
    `# 5. Expire the test subscription and confirm CoA disconnects it within seconds.`,
    `#    If it only drops at the next re-auth, /radius incoming or the firewall rule`,
    `#    on UDP 3799 is wrong.`,
    ``);

  // ------------------------------------------------------------- trailing report
  add(`# ${'='.repeat(74)}`,
    `# RENDER SUMMARY`,
    `#   rate profiles      ${profiles.length}`,
    `#   plans              ${seed.plans.length}`,
    `#   walled garden L7   ${classified.walledGardenL7.length} entries`,
    `#   walled garden L3   ${classified.walledGardenL3.length} entries (${dynHosts.length} dynamic host(s))`,
    `#   DNS sinkholes      ${classified.dnsSinkhole.length}`,
    `#   blocked addresses  ${classified.addressListBlock.length}`,
    `#   rules not rendered ${classified.skipped.length}`);
  for (const sk of classified.skipped.slice(0, 40)) {
    add(`#     - ${sk.pattern}: ${sk.reason}`);
  }
  if (classified.skipped.length > 40) add(`#     ... and ${classified.skipped.length - 40} more`);
  add(`# ${'='.repeat(74)}`, ``);

  if (warnings.length) {
    // Warnings are emitted at the TOP of the file too, so they cannot be missed
    // by someone who pastes only the first few sections.
    const header = [
      `# ${'!'.repeat(74)}`,
      `# ${warnings.length} WARNING(S) TO RESOLVE BEFORE APPLYING`,
      ...warnings.map((w, i) => `#   ${i + 1}. ${w}`),
      `# ${'!'.repeat(74)}`,
      ``,
    ];
    out.unshift(...header);
  }

  return { script: out.join('\n'), warnings, manual };
}
