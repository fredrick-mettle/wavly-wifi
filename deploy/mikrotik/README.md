# MikroTik RouterOS v7 configuration — Wavly WiFi

This directory contains the router configuration for a Wavly WiFi site and the
generator that produces it.

**The script is rendered, never pushed live.** A tool that can reconfigure the
router can also cut the only internet connection a village has, from a laptop
that may be 200 km away. Output is text you read, diff and paste.

```
deploy/mikrotik/
├── generate.mjs              CLI: reads the SQL seed, writes the router script
├── lib/
│   ├── seed.mjs              parses db/seed/*.sql with the real PG grammar
│   ├── rate-limit.mjs        Mikrotik-Rate-Limit renderer (the rx/tx inversion)
│   ├── walled-garden.mjs     network_rules -> L7 / L3 / DNS / address lists
│   ├── render-config.mjs     assembles the whole .rsc script
│   └── hotspot-files.mjs     the HTML pages the router itself serves
├── tests/router-config.test.mjs
└── generated/               GENERATED, checked in so diffs are reviewable
    ├── wavly-nkawie-01-router.rsc
    ├── hotspot/*.html
    └── MANIFEST.md
```

## Generate

```bash
npm run router:generate          # writes deploy/mikrotik/generated/
npm run router:stdout            # prints the script, writes nothing
npm run test:router              # 48 regression tests
```

The generator reads `db/seed/0001_core_defaults.sql`. That is deliberate: the
plans, rate profiles, walled garden and capacity numbers all live in the
database, so the router script is a pure function of it and the two cannot drift.
Change a plan, regenerate, diff, paste. There is no second copy of the numbers to
remember to update.

The seed is parsed with `libpg-query` — the actual PostgreSQL grammar compiled to
WASM — not a regex, so quoting, comments and line wrapping are handled correctly.
Anything it cannot evaluate exactly (a `now()`, a `gen_random_uuid()`) throws
rather than guessing.

## Apply

### Before you touch anything

1. **Connect over ethernet or the management Wi-Fi.** Never over the hotspot
   network you are about to reconfigure. If you break hotspot bridging mid-paste
   you will lose your own session and the router will be left half-configured
   with nobody attached to fix it.
2. **Back up twice:**
   ```
   /export file=pre-wavly-export
   /system backup save name=pre-wavly-binary
   ```
   `/export` is text and survives a package change; `/system backup` is binary and
   restores exactly, including passwords. You want both. Drag them out of the
   router with WinBox → Files.
3. **Check the RouterOS version** with `/system package print`. This script is
   written for v7. Note that v7.18.x has reported DHCP regressions and v7.15.x is
   widely regarded as stable — if you are on 7.18.x and option 114 misbehaves,
   that is why.
4. **Confirm the radio names.** On the AX line the labels are *swapped*: `wifi1`
   is 5 GHz and `wifi2` is 2.4 GHz. Run `/interface wifi print` and check before
   trusting section 1.

### Then

Paste **one section at a time**, in order, and read what comes back. RouterOS
prints an error per line and keeps going, so pasting the whole file blind leaves
you with a configuration that is silently missing pieces.

Sections:

| # | What | Risk if wrong |
|---|---|---|
| 0 | Identity, clock, NTP, IPv6 off | TLS and RADIUS `Expiration` both reject a skewed clock |
| 1 | Bridges, Wi-Fi, client isolation | Radios bridged twice = a broken data path |
| 2 | Addresses, DHCP, option 114 | No option 114 ⇒ Android 13+ may not open the real browser |
| 3 | Walled garden (L7 **and** L3) | Wrong table ⇒ portal unreachable before login |
| 4 | DNS sinkholes | — |
| 5 | Blocked address list (DoH/DoT) | Customers bypass every DNS rule |
| 6 | Firewall | **Needs a human — see below** |
| 7 | Hotspot server and profile | `http-pap` would send passwords in plaintext |
| 8 | Local user profiles + rendered rate limits | The rx/tx inversion |
| 9 | RADIUS client and CoA | No CoA ⇒ expiry only bites at next re-auth |
| 10 | Site capacity queue | Position matters — see below |
| 11 | Optional PCQ | Disabled by default |
| 12 | Scheduler: refresh resolved hosts | Stale DNS ⇒ portal unreachable days later |
| 13 | Nightly backup | — |
| 14 | Management hardening | — |
| 15 | Logging, diagnostics, smoke test | — |

### Two things the generator cannot do for you

**Firewall rule ordering.** The script *appends* its rules. The factory default
configuration already has rules in `input` and `forward`, and the default `input`
chain typically ends with a "drop everything not coming from LAN" rule. Our
hotspot network is deliberately **not** in the LAN list, so that default rule
would shadow ours and block the login page itself.

After pasting section 6, run `/ip firewall filter print` and confirm every rule
commented `wv:` sits **above** any `defconf` drop rule in the same chain. Drag
them into position in WinBox (IP → Firewall → Filter). Guessing at `move` indices
over a console is how people lock themselves out.

**Site queue position.** `/queue simple` builds its hierarchy from `target`
ranges, and the hotspot's dynamic per-user queues only nest under `wv-site-cap`
if it comes first — hence the `move … 0`. Verify with:

```
/queue simple print hierarchy
```

The per-user queues must appear **indented** under `wv-site-cap`. If they are
siblings, the site ceiling is not being applied and one customer can saturate the
uplink for everybody.

### Upload the hotspot pages

The pages in `generated/hotspot/` go into the router's **stock** `hotspot` directory,
overriding individual files:

```
WinBox → Files → drag login.html, activate.html, alogin.html, error.html, status.html
         into /hotspot
```

or over SFTP/FTP to `/hotspot`.

We override pages inside the stock directory rather than pointing
`html-directory` at a fresh one, because a fresh directory has to ship *every*
file the hotspot expects — including `md5.js`. A missing `md5.js` breaks
`http-chap` login with no error message anywhere, which is an expensive thing to
debug on a live site. `login.html` explicitly checks for it and fails visibly
rather than falling back to plaintext.

Keep a copy of the original files before you overwrite them.

### Set the RADIUS secret

The script contains `secret="REPLACE_WITH_RADIUS_SECRET"`, never a real value.
Set it in WinBox (Radius → the Wavly entry → Secret) to match
`RADIUS_SECRET_NKAWIE01` in `/etc/wavly/edge.env` on the edge node.

If you would rather have it substituted, use:

```bash
RADIUS_SECRET_NKAWIE01='...' node deploy/mikrotik/generate.mjs --radius-secret-env RADIUS_SECRET_NKAWIE01
```

That writes to `*.secret.rsc`, which `.gitignore` excludes
(`deploy/**/*secret*`). The generator also warns. A shared secret that protects a
channel able to disconnect every paying customer should not travel through a
file in git.

## Smoke test

The script ends with this. Do it before walking away.

1. Join the SSID. The sign-in sheet must appear by itself within ~10 s. If it
   does not, a captive-portal detection endpoint is being allowed through
   (section 3), or option 114 is missing `force=yes` (section 2).
2. Log in with a test RADIUS account. `/ip hotspot active print` shows it.
3. Open `https://portal.wavlywifi.com` **before** logging in. It must load —
   that is the L3 walled garden working.
4. From a hotspot client: `ping 192.168.88.1` must **fail**, `ping 192.168.88.10`
   must **fail**, but `tcp/8787` to `192.168.88.10` must **succeed**. That single
   allowed host-and-port is the activation handshake; everything else from the
   hotspot to management is dropped.
5. Expire the test subscription and confirm CoA disconnects it within seconds. If
   it only drops at the next re-authentication, `/radius incoming` or the UDP 3799
   firewall rule is wrong.

Useful diagnostics:

```
/radius/monitor 0                       accepts, rejects, resends, timeouts, rtt
/ip hotspot active print                who is online
/ip hotspot host print where bypassed=yes
/ip hotspot walled-garden print stats
/queue simple print hierarchy           per-user queues must nest under wv-site-cap
/log print where topics~"hotspot,radius"
```

`/system logging` has `hotspot,debug` and `dns` added **disabled**. Enable them
only while diagnosing: they are extremely chatty and will rotate useful history
out of the buffer.

## Things that will bite you

- **`action` differs between the two walled gardens.** L7 is `allow`/`deny`;
  L3 is `accept`/`drop`/`reject`. Writing `allow` into the IP table is rejected —
  and if it were accepted it would be a silent no-op.
- **L7 cannot see HTTPS.** RouterOS cannot read a Host header inside a TLS
  ClientHello, so an HTTPS destination must have an L3 entry. This is why the
  cloud portal appears in both tables.
- **Captive-portal probes must stay intercepted.** Allowing
  `connectivitycheck.gstatic.com` through gives the phone its expected `204`, and
  the sign-in sheet never appears. Flip
  `network.intercept_captive_detection=false` in the seed and regenerate if one
  specific handset model misbehaves — do not hand-edit the router.
- **`dns-name` must not be the portal's hostname.** If the router answered for
  `portal.wavlywifi.com` it would shadow the real portal for every client. It is
  `hotspot.lan`. And never `.local` — iOS may then fail to detect the hotspot.
- **`html-directory-override` is not a remote URL.** It is for files on attached
  USB/HDD storage only.
- **Burst threshold is a rate, not a byte count.** `*_threshold_kbps`, in bits/s.
  A column named `burst_threshold_bytes` would parse, load, and never burst.
- **Upload is the scarce resource.** Starlink Mini does 60–150 Mbps down but only
  10–25 Mbps up. The site queue caps upstream hardest for that reason, and the
  rendered oversubscription figures show it (≈24:1 down, ≈63:1 up at 80
  concurrent users). Measure on site and correct
  `network.downstream_capacity_kbps` / `network.upstream_capacity_kbps`.
- **Tell customers to disable "private Wi-Fi address"** for this network. A
  rotating MAC address defeats device registration and forces a fresh login on
  every reconnect.
- **The SSID must be OPEN.** No WPA passphrase. Customers have to associate
  *before* they have any credentials; the hotspot login is what authenticates
  them. A WPA2 key on this SSID means nobody can join at all. Verify with
  `/interface wifi configuration print detail` — `authentication-types` should be
  empty.
- **`1.1.1.1` and `8.8.8.8` appear both as the router's upstream resolvers and in
  the `wv-blocked` list.** That is not a contradiction, so do not "fix" it. The
  blocklist applies to *forward* traffic from hotspot clients, which stops a
  customer pointing their phone at a public resolver and bypassing every DNS rule
  we have. The router's own queries go through its DNS proxy and never traverse
  the forward chain. Remove the block and DNS filtering becomes optional; remove
  the upstream servers and nothing resolves.
