# 03 — MikroTik RouterOS v7 configuration

**Phase 2 of 8.** Deliverable: hotspot, RADIUS client, walled garden for the
payment and SMS paths, and rate-limit profiles.

Operational instructions live in [`deploy/mikrotik/README.md`](../deploy/mikrotik/README.md).
This document is about *why* the configuration is shaped the way it is.

---

## 3.1 The configuration is rendered from the database, not written by hand

`node deploy/mikrotik/generate.mjs` parses `db/seed/0001_core_defaults.sql` and
emits a `.rsc` script plus the hotspot HTML pages.

The alternative implementations are both wrong:

| Approach | Why it fails |
|---|---|
| Require a live database at generation time | There isn't one at authoring time; the script must be reviewable as a file; and "run psql against production to generate the router config" is how a typo reaches 80 customers |
| Keep a second JSON/YAML copy of the numbers | Two sources of truth drift. Someone edits a plan in the admin UI, regenerates nothing, and the router keeps shaping traffic at last month's rate |

So the seed is the single source of truth and the script is a pure function of
it. Change a plan → regenerate → diff → paste. There is nothing to remember to
update, and the diff *is* the change review.

Parsing uses `libpg-query` — the real PostgreSQL grammar compiled to WASM, the
same dependency the schema checker uses — not a regex, so quoting, comments and
line wrapping are handled correctly. Anything it cannot evaluate exactly throws.
It refuses to guess at `now()` or `gen_random_uuid()`.

**Foreign keys resolve to natural keys, never to invented UUIDs.** The seed
writes `(select id from rate_profiles where name = 'p-12-6')`, and that `id` does
not exist until the row is inserted. Fabricating one would be a lie that type
checks. Instead each such subquery becomes a `{$ref}` descriptor carrying the
table and the matched natural key, and plans are joined to profiles *by name*.
A dangling reference is an error, not a silent empty rate limit.

`generated/` is committed for the same reason `docs/schema-reference.md` is: a
generated file you can diff in a pull request is a reviewable change, and a
generated file you cannot see is a surprise.

---

## 3.2 There are two walled gardens, and they are not interchangeable

This is the single most consequential finding of the phase, and it changed the
schema.

| | Path | Matches | `action` values |
|---|---|---|---|
| HTTP (L7) | `/ip hotspot walled-garden` | the HTTP `Host` header and URL path — **plain HTTP only** | `allow` / `deny` |
| IP (L3/L4) | `/ip hotspot walled-garden ip` | destination IP, protocol, port — **and `dst-host`, which RouterOS resolves into dynamic address entries** | `accept` / `drop` / `reject` |

Three consequences:

**1. Our HTTPS portal must go in the L3 table.** The portal is HTTPS on Vercel
behind Cloudflare. RouterOS cannot read a Host header inside a TLS ClientHello,
so a `dst-host=` entry in the L7 table does nothing at all for it. Every HTTPS
destination needs an L3 entry with `action=accept`.

**2. The `action` vocabulary differs between the tables.** `allow` in the IP
table is rejected; `accept` in the L7 table is too. If either were silently
accepted it would be a no-op, and the failure mode is "new customers cannot reach
the portal" — which presents as *the portal is down* while every dashboard you
have says it is up.

**3. Resolution goes stale, so it must be refreshed.** Vercel and Cloudflare
rotate addresses. RouterOS resolves `dst-host` into dynamic entries; when those
addresses change, the walled garden quietly stops matching. The rendered config
tags those entries `wv-dyn:` and installs a scheduler that re-sets `dst-host` to
its own value every six hours, forcing re-resolution.

The schema changed to match: `network_rules.enforcement` gained
`walled_garden_ip` alongside `walled_garden`, so a rule can say which table it
belongs in rather than leaving the renderer to guess.

---

## 3.3 Captive-portal detection endpoints must stay *intercepted*

Counter-intuitive, and the most common reason a portal "does not pop up".

`connectivitycheck.gstatic.com`, `captive.apple.com`,
`msftconnecttest.com`, `connectivitycheck.platform.hicloud.com` and
`www.apple.com` are how a phone decides whether to show the sign-in sheet. They
must be intercepted, so the probe receives a `302` to our login page instead of
its expected `204`/`"Success"`.

Putting them in the walled garden is the natural mistake and it is exactly
backwards: the OS gets its expected answer, concludes it has real internet, and
never shows the portal. The customer is connected to Wi-Fi, has no internet, and
sees nothing to fix it.

They were seeded as *allowed* in Phase 1. They are now seeded **inactive**, with
the reasoning in the row's `notes`, and `network.intercept_captive_detection`
(default `true`) controls the behaviour. If one specific handset model
misbehaves, flip that setting and regenerate — do not hand-edit the router.

Detection therefore rests on two mechanisms: intercepting the plain-HTTP probes,
and DHCP option 114.

---

## 3.4 DHCP option 114 needs `force=yes` on v7

RFC 8910 defines a DHCP option carrying the captive-portal URL (RFC 8908
describes the API document it points at). It is the reliable way to get Android
13+ to open the sign-in page in the **real browser** rather than the stripped
captive-portal WebView — which matters a great deal here, because the WebView has
no saved passwords, no autofill, and frequently no working payment sheet. MoMo
approval prompts are exactly the thing that breaks in it.

RouterOS v6 always sent configured options. **v7 only sends options the client
asked for** in its Parameter Request List — and no client asks for code 114.
Without `force=yes` the option is silently never sent and the feature appears to
do nothing:

```
/ip dhcp-server option add name=wv-captive-portal code=114 force=yes \
    value="'https://portal.wavlywifi.com/captive-api.json'"
/ip dhcp-server option sets add name=wv-hotspot-options options=wv-captive-portal
/ip dhcp-server set [find name=wv-dhcp-hotspot] dhcp-option-set=wv-hotspot-options
```

The URL must be **HTTPS**. Android 13+ fetches it over plain HTTP and rejects a
non-HTTPS URL, which is a nasty inversion: the option only works if the portal is
properly TLS-terminated.

---

## 3.5 `dns-name` must not be the portal's hostname

`/ip hotspot profile dns-name` makes the **router** answer for that name on the
hotspot network. Phase 1 seeded it as `portal.wavlywifi.com` — the same hostname
as the cloud portal.

That would have the router shadow the real portal for every connected client:
DNS returns the router's address, the browser gets a login page instead of the
portal, and the portal becomes unreachable from precisely the network that
depends on it. It is now `hotspot.lan`, with `network.hotspot_local_dns_name`
separate from `branding.portal_url`, and the generator **warns if they are ever
set to the same value**.

It must also never end in `.local`: MikroTik's own documentation notes iOS may
then fail to detect the hotspot. The generator warns on that too.

---

## 3.6 Rate limits: the rx/tx inversion

```
Mikrotik-Rate-Limit: rx-rate[/tx-rate] [rx-burst-rate[/tx-burst-rate]
  [rx-burst-threshold[/tx-burst-threshold] [rx-burst-time[/tx-burst-time]
    [priority] [rx-rate-min[/tx-rate-min]]]]]
```

Documented as *"from the point of view of the router (so rx is client upload, and
tx is client download)"*. A plan sold as **12 Mbps down / 6 Mbps up** renders as
`6M/12M`. Upload first.

Nothing in the system detects getting this backwards. The attribute parses, the
customer connects, accounting works, and everyone is simply slow in one
direction — with upload the slow one, which breaks video calls and MoMo
confirmation round-trips while a speed test still "looks fine". Hence
[`lib/rate-limit.mjs`](../deploy/mikrotik/lib/rate-limit.mjs) and tests that
assert the inversion directly.

Four further traps the renderer handles:

- **Units.** The database stores *kilobits*; MikroTik wants *bits*. `12000`
  means `12M`, never `"12000"`. Only whole megabits get an `M` suffix — a
  fractional `1.5M` is not something MikroTik documents accepting, and an
  attribute the router silently rejects is worse than an ugly one, so `1500k` it
  is.
- **Positional parameters.** You cannot give `priority` without first giving
  burst-rate, threshold and time. When a caller wants priority and the profile
  has no burst, the renderer emits the base rate as the burst rate — a no-op
  burst, since you can never exceed your own ceiling — purely to unlock the slots.
- **Burst threshold is a rate, not a byte count.** It is "the average data rate
  that must not be exceeded for the burst to be allowed", in bits/s. Phase 1 had
  this as `*_threshold_bytes`, which would have parsed, loaded, and never burst.
- **`rate-min` may not exceed the base rate.** MikroTik rejects the attribute.
  The renderer clamps and warns, or throws under `strict`.

Both halves are always rendered explicitly (`8k/8k`, not `8k`) even though
MikroTik would accept the shorthand. Two extra characters, and a reader never has
to remember which half was implied.

---

## 3.7 There is no RADIUS attribute that names a parent queue

A widespread misconception, and Phase 1 encoded it: `rate_profiles` had a
`total_queue_name` column.

What MikroTik actually provides is `Mikrotik-Address-List` (vendor 14988,
attribute 19), which places the client's IP in a named address list for the
session and removes it automatically on logout. The column is now
`address_list_name`, seeded per profile (`wv-p-12-6`, `wv-fup`, `wv-suspended`).

That is the real hook for optional per-plan PCQ classes and plan-scoped firewall
rules, and it is why `v_radius_authorization` now exposes the **complete** rate
profile — burst, thresholds, times, minimums, priority and address list — rather
than only the base rates. Exposing only the base rates would have made the edge
silently drop every burst configuration while still producing a valid-looking
attribute.

Site-wide shaping is a separate mechanism: a `/queue simple` on the hotspot
subnet, capped below measured capacity, `move`d to position 0 so the hotspot's
dynamic per-user queues nest under it. `limit-at` is a guarantee (CIR),
`max-limit` is a ceiling (MIR), and the sum of children's `limit-at` must not
exceed the parent's `max-limit`.

---

## 3.8 Capacity is two numbers, not one

Phase 1 seeded a single `network.upstream_capacity_kbps = 80000` whose own
description said "Starlink Mini **downlink**".

Starlink Mini does roughly 60–150 Mbps down and only **10–25 Mbps up**. A single
capacity figure produces a site queue that is generous in the direction which is
already fine and useless in the direction that saturates first — and uplink
saturation is what makes every video call on the site collapse at once, while
throughput metrics still look acceptable.

Now three settings: `network.downstream_capacity_kbps` (80000),
`network.upstream_capacity_kbps` (15000), `network.site_queue_utilisation_pct`
(85). All three should be corrected after measuring on site.

The 85% is not a safety margin. A queue running at exactly line rate develops
unbounded latency. The generator warns if it is set to 100 or more, and warns if
upstream capacity is configured at or above downstream, since that looks
inverted.

**Oversubscription is now stated honestly.** Phase 1 claimed "~12:1". Summing the
ceilings of the seven *plans* gives 71 Mbps against a 68 Mbps ceiling — a
meaningless ~1:1, because it says nothing about how many people buy them. The
ratio needs a headcount, so `network.planned_concurrent_users` (80) is now an
explicit setting, and the script reports the worst case:

```
download  1,600,000 kbps demanded vs 68,000 kbps ceiling  => ~23.5:1
upload      800,000 kbps demanded vs 12,750 kbps ceiling  => ~62.7:1
```

Real demand is far lower — most customers idle most of the time, and nobody
sustains their ceiling. But a capacity warning that assumes the good case is not
a warning. The 63:1 uplink figure is the number that should govern how many
subscriptions this site can sell.

---

## 3.9 Why the router hosts HTML at all

There is a cloud portal. Three jobs still only the router can do:

1. **`login.html` is what the interception actually serves.** The phone's probe
   gets a `302` here. It must work with zero connectivity.
2. **`activate.html` completes the mixed-content handshake.** An `https:` portal
   cannot `POST` to `http://192.168.89.1/login`, but a top-level `302` from
   `https:` to `http:` *is* allowed. So the portal redirects here with a one-time
   token; this page collects credentials from the edge node over the LAN and then
   submits a **same-origin** POST to the hotspot. That last step cannot happen
   from the cloud.
3. **`error.html` and `status.html` are the only pages reachable** when a customer
   is out of credit and everything else is blocked.

Constraints honoured:

- **Small.** 3.6–7.3 kB per page, inline CSS, no framework, no external font, no
  CDN. A CDN dependency inside a walled garden is a login page that depends on a
  third party we cannot reliably allowlist.
- **No plaintext credentials.** `login-by=http-chap,cookie`, never `http-pap`.
  CHAP needs `md5.js`, which is why pages override individual files in the
  **stock** `hotspot` directory rather than pointing `html-directory` at a fresh
  one: a fresh directory must ship every file the hotspot expects, and a missing
  `md5.js` breaks `http-chap` with no error message anywhere. `login.html` checks
  for it and fails visibly rather than silently falling back to plaintext.
- **Vouchers work with the satellite down**, so the voucher form is on the login
  page itself, not behind the portal.
- **`https-redirect=no`.** RouterOS v7 exposes no working `ssl-certificate` on the
  hotspot profile, so redirecting an `https://` URL lands the client on a
  certificate name mismatch. Better to let the plain-HTTP probe and option 114 do
  the redirecting.

---

## 3.10 Network segmentation and the one deliberate hole

```
ether1 ──── Starlink Mini (WAN, DHCP client)
ether2 ──── bridge-mgmt      192.168.88.0/24   router .1, edge node .10, admins
ether3-5 ─┐
wifi1 (5G)├─ bridge-hotspot  192.168.89.0/24   customers
wifi2(2.4)┘
```

Hotspot clients are isolated from each other twice — at the Wi-Fi **datapath**
(`client-isolation=yes`, which the firewall cannot do as cheaply at layer 2) and
in `forward` (which covers anyone plugged into ether3-5).

Hotspot → management is dropped, with exactly one exception: `tcp/8787` to the
edge node, which is the activation handshake. One host, one port.

Also blocked from the hotspot network: DNS over TLS (853) and **QUIC (UDP 443)**.
QUIC matters because HTTP/3 runs over UDP, which the hotspot cannot intercept or
shape with HTTP-based rules — so it both evades the login redirect and defeats the
rate limits. Clients fall back to HTTP/2 over TCP. And hotspot clients must use
*our* DNS, or every sinkhole rule in the config is bypassed.

IPv6 is disabled. Starlink CGNAT gives no routable inbound IPv6, and a
half-working IPv6 path lets clients bypass every IPv4 hotspot control.

CoA on UDP 3799 is accepted **from the edge node and nothing else**. It is a
remote control channel that can disconnect every paying customer at once, so it
gets a specific source address and an explicit drop behind it.

---

## 3.11 What the generator refuses to do

- **Never renders a real RADIUS secret** by default. `--radius-secret-env VAR`
  substitutes one and writes to `*.secret.rsc`, which `.gitignore` excludes; the
  generator also warns. This secret protects a channel that can disconnect every
  customer.
- **Never renders a router admin password.** Reported as a manual step instead. A
  password must not pass through a generated file in git.
- **Never skips a setting marked `is_secret`** in the seed — those are filtered
  out during extraction, before rendering.
- **Never pushes to the router.** There is no API client, no SSH, no
  `--apply` flag. That is a deliberate absence, not an unimplemented feature.

Warnings are emitted at the **top** of the script as well as the bottom, so they
cannot be missed by someone who pastes only the first few sections. The CLI exits
non-zero on any unacknowledged warning, because everything that warns here —
an inverted capacity pair, a `dns-name` colliding with the portal, a non-HTTPS
option 114 URL — produces a configuration that loads cleanly and does not work.

---

## 3.12 Two things a human must check after applying

The generator cannot determine either, because both depend on what the factory
default configuration already put in the router:

1. **Firewall rule ordering.** The script appends. The default `input` chain
   typically ends with "drop everything not coming from LAN", and our hotspot
   network is deliberately not in the LAN list — so that rule would shadow ours
   and block the login page itself. Verify with `/ip firewall filter print` and
   drag `wv:` rules above any `defconf` drop in WinBox.
2. **Site queue position.** `/queue simple print hierarchy` must show the dynamic
   per-user queues **indented** under `wv-site-cap`. If they are siblings, the
   site ceiling is not being applied.

Both are called out in the script at the point where they matter, and in the
smoke test at the end.

---

## 3.13 Corrections this phase made to Phase 1

Found by verifying against live RouterOS documentation rather than from memory.
Each would have produced a configuration that loaded without complaint and did
not work.

| # | Phase 1 said | Reality |
|---|---|---|
| 1 | `html-directory-override` points the hotspot at remote pages | It is for files on attached USB/HDD storage only |
| 2 | Captive-detection endpoints belong in the walled garden | They must stay **intercepted** or the sign-in sheet never appears |
| 3 | One walled garden | Two, with different `action` vocabularies; L7 cannot see HTTPS |
| 4 | `rate_profiles.total_queue_name` attaches a profile to a parent queue | No such RADIUS attribute exists; `Mikrotik-Address-List` does |
| 5 | `network.upstream_capacity_kbps = 80000` | That is a *downlink* figure; uplink is 10–25 Mbps |
| 6 | `branding.hotspot_dns_name = portal.wavlywifi.com` | Would shadow the real portal for every client |
| 7 | "~12:1 oversubscription" | Summing plan ceilings is meaningless; ≈24:1 down / ≈63:1 up at 80 concurrent users |
| 8 | `v_radius_authorization` exposes base rates only | The edge needs burst, thresholds, minimums, priority and address list too |

---

**Next: [04-freeradius.md](./04-freeradius.md)** — FreeRADIUS on the edge node:
`sql` module against local Postgres, the `wavly_` authorization queries, CoA
origination, `radpostauth` redaction, and the edge sync daemon's contract.
