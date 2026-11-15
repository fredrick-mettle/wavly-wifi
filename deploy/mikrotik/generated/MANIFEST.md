# Generated MikroTik configuration — Nkawie Main

Generated 2026-11-15T12:47:28.784Z from `db/seed/0001_core_defaults.sql`.
Do not hand-edit these files: change the seed (or the database, then the seed)
and regenerate, so the router and the billing system cannot drift apart.

## Files

| File | What it is | Where it goes |
|---|---|---|
| `wavly-nkawie-01-router.rsc` | The full RouterOS script | Pasted into the router terminal, section by section |
| `hotspot/*.html` | The pages the router serves pre-authentication | Uploaded to `flash/wavly/` on the router |

## What was rendered

| Thing | Count |
|---|---|
| Rate profiles | 8 |
| Plans | 7 |
| Network rules | 21 |
| Settings read | 89 |

## Plans and their rendered rate limits

| Plan | Price | Rate profile | Mikrotik-Rate-Limit |
|---|---|---|---|
| Free Trial (`free-trial`) | free | `p-3-1` | `1M/3M 2M/6M 500k/1500k 8s/8s 8 250k/500k` |
| Daily Lite (`day-lite`) | GH₵5.00 | `p-6-3` | `3M/6M 6M/12M 1500k/3M 10s/10s 7 500k/1M` |
| Daily Plus (`day-plus`) | GH₵10.00 | `p-10-5` | `5M/10M 10M/20M 2500k/5M 12s/12s 6 1M/2M` |
| Weekly (`week-1`) | GH₵25.00 | `p-10-5` | `5M/10M 10M/20M 2500k/5M 12s/12s 6 1M/2M` |
| Monthly Basic (`month-basic`) | GH₵70.00 | `p-12-6` | `6M/12M 12M/24M 3M/6M 15s/15s 5 1500k/3M` |
| Monthly Plus (`month-plus`) | GH₵100.00 | `p-20-10` | `10M/20M 20M/40M 5M/10M 15s/15s 4 2500k/5M` |
| 10 GB Bundle (`data-10gb`) | GH₵20.00 | `p-10-5` | `5M/10M 10M/20M 2500k/5M 12s/12s 6 1M/2M` |

Mikrotik-Rate-Limit reads **upload first** (rx = client upload from the router's
point of view). A plan sold as "12 down / 6 up" renders `6M/12M`.

## Manual steps

- [ ] Point /ip dns servers at the edge node (192.168.88.10) once FreeRADIUS/dnsmasq is up, keeping 1.1.1.1 as fallback.
- [ ] Verify the Starlink Mini is in BYPASS mode, otherwise you have double NAT and the router's WAN lease is another private range.
- [ ] Set the RADIUS shared secret on the router. In WinBox: Radius -> select the entry commented "Wavly edge FreeRADIUS" (address 192.168.88.10) -> Secret. It must match RADIUS_SECRET_NKAWIE01 in /etc/wavly/edge.env on the edge node. The generated script deliberately contains the placeholder REPLACE_WITH_RADIUS_SECRET, not the secret.
- [ ] Copy /wavly-config-*.rsc off the router weekly (WinBox -> Files -> drag out). Do not rely on the router's own flash as the only copy.
- [ ] Rename or disable the default 'admin' router account and set a long passphrase. It is not rendered here because a router password must not pass through a generated file in git.

## Applying it

See `deploy/mikrotik/README.md`. In short: back up the router first, work over
ethernet or the management Wi-Fi (never over the hotspot network you are about
to change), paste one section at a time, and run the smoke test at the end of
the script.
