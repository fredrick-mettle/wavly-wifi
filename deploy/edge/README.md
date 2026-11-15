# FreeRADIUS on the edge node — Wavly WiFi

Phase 3. This directory produces the RADIUS configuration for the Debian 12 box at
`192.168.88.10` in Nkawie.

**Nothing here is applied automatically.** The generator writes files to a local
directory; a human copies them to the node and restarts the service. It never
touches a running server, and it never writes a secret into anything git can see.

The reasoning behind every choice — including the schema bug this phase found that
would have broken every login on the site — is in
[`docs/04-freeradius.md`](../../docs/04-freeradius.md). This file is the how.

---

## What is here

```
deploy/edge/
├── generate.mjs              # renders the templates; refuses to emit a broken config
├── bin/wv-coa                # send a CoA / Disconnect; used by syncd and by you
├── freeradius/               # TEMPLATES — committed, contain no secrets
│   ├── clients.conf.tmpl
│   ├── dictionary.wavly
│   ├── mods-available/{sql,wavly}
│   ├── mods-config/files/authorize
│   ├── mods-config/sql/main/postgresql/queries.conf
│   ├── policy.d/wavly
│   └── sites-available/{wavly,originate-coa.tmpl}
├── systemd/freeradius.service.d/override.conf
├── tests/edge-config.test.mjs
└── local/                    # RENDERED OUTPUT — gitignored, contains secrets
```

The `freeradius/` tree mirrors `/etc/freeradius/3.0/` exactly, so it can be copied
across as-is. The one exception is `dictionary.wavly`, which goes to
`/usr/share/freeradius/` and must be `$INCLUDE`d from the raddb dictionary.

---

## Generate

On the edge node:

```bash
sudo install -d -m 0700 /etc/wavly
sudoedit /etc/wavly/edge.env        # mode 0600, root:root
sudo chmod 0600 /etc/wavly/edge.env
```

Required contents:

```sh
# Decomposed into the five fields the FreeRADIUS sql module needs, so the
# password is written ONCE. syncd uses the same variable.
EDGE_DATABASE_URL=postgresql://radius:<random, 32+ chars>@127.0.0.1:5432/wavly_edge

# The address this node has on the MANAGEMENT network (where the router is),
# not the hotspot network. Listeners bind to exactly this, never to *.
RADIUS_BIND_ADDRESS=192.168.88.10
# RADIUS_AUTH_PORT=1812   # optional
# RADIUS_ACCT_PORT=1813   # optional

# Emergency operator account, see "The local account" below.
EDGE_LOCAL_ADMIN_PASSWORD=<random, rotate after every use>
EDGE_LOCAL_ADMIN_RATE_PROFILE=p-20-10   # optional; must be a seeded rate profile
# EDGE_LOCAL_ADMIN_EXPIRES="15 Feb 2027" # optional; defaults to 90 days out

# One per router, named by nas_devices.shared_secret_ref — for the seeded Nkawie
# router that ref is edge:env:RADIUS_SECRET_NKAWIE01.
# Generate with:  openssl rand -hex 24
RADIUS_SECRET_NKAWIE01=<48 hex chars>

# For bin/wv-coa. A FILE, not argv: /proc exposes command lines to every user.
WV_COA_SECRET_FILE=/etc/wavly/radius-secret
```

These names are not arbitrary. `.env.example` is the contract and a test asserts
that every variable the generator requires is documented there, and that the secret
variable name matches what the seed's `shared_secret_ref` points at — the two had
drifted apart, which would have made a correctly-provisioned node fail to render.

Then:

```bash
npm ci
npm run edge:generate -- --env-file /etc/wavly/edge.env
```

Output goes to `deploy/edge/local/`, with a `README.txt` containing the exact
install commands. `--out DIR` sends it elsewhere; `--check` additionally runs
`freeradius -XC` against the result if the binary is installed.

The generator **exits non-zero** rather than producing config that would start and
then misbehave:

| It refuses when… | Because otherwise… |
|---|---|
| a token is left unsubstituted | `password = "<token>"` is valid config; the server starts and cannot reach the database |
| a required variable is empty | the error names the variable |
| `shared_secret_ref` holds a literal secret | that value would be copied into every nightly off-site backup |
| a RADIUS secret is under 22 characters | it can be recovered offline from one captured packet |
| a `coa_server` has no matching `home_server` | FreeRADIUS logs `Unknown destination for CoA request` and silently drops the disconnect |
| the site calls a policy that is not defined | FreeRADIUS refuses to start |
| the rendered post-auth query still contains `User-Password` | every customer password would be written to disk in cleartext |
| `EDGE_DATABASE_URL` has no password | FreeRADIUS connects over TCP as `radius`; peer authentication on the socket does not help it |

`--stdout` prints the config but **refuses to do so while it contains secrets**,
unless you also pass `--allow-secrets-on-stdout`. Printing a secret into terminal
scrollback, a CI log or shell history is how it ends up committed later.

---

## Install

Full commands are in the generated `README.txt`. The shape of it:

```bash
sudo cp -r deploy/edge/local/. /etc/freeradius/3.0/
sudo cp deploy/edge/local/dictionary.wavly /usr/share/freeradius/
echo '$INCLUDE /usr/share/freeradius/dictionary.wavly' | sudo tee -a /etc/freeradius/3.0/dictionary

# enable modules and sites, remove the stock ones
cd /etc/freeradius/3.0
sudo ln -s ../mods-available/sql   mods-enabled/sql
sudo ln -s ../mods-available/wavly mods-enabled/wavly
sudo ln -s ../sites-available/wavly         sites-enabled/wavly
sudo ln -s ../sites-available/originate-coa sites-enabled/originate-coa
sudo rm -f sites-enabled/default sites-enabled/inner-tunnel

# stock modules the site depends on — detail.log and expiration are easy to miss
for m in pap chap mschap files preprocess acct_unique attr_filter expiration detail.log; do
  sudo ln -sf ../mods-available/$m mods-enabled/$m
done

sudo chown -R root:freerad /etc/freeradius/3.0
sudo chmod 0640 clients.conf mods-available/sql
sudo freeradius -XC          # fix EVERYTHING before starting
sudo systemctl restart freeradius
```

Then the systemd override:

```bash
sudo install -d /etc/systemd/system/freeradius.service.d
sudo cp deploy/edge/systemd/freeradius.service.d/override.conf \
        /etc/systemd/system/freeradius.service.d/
sudo systemctl daemon-reload && sudo systemctl restart freeradius
```

**Missing `detail.log` or `expiration` fails confusingly.** `detail.log` defines the
`reply_log` instance used in `post-auth`, so without it the server refuses to start
with `Failed to find module reply_log`. `expiration` is worse: without it an expired
customer keeps logging in, nothing logs an error, and the policy simply has no
module to call.

**`radiusd.conf` is package-managed and not rendered.** Add to its `security { }`
section by hand:

```
require_message_authenticator = auto
limit_proxy_state = auto
```

---

## Verify

In this order. Each step catches a different silent failure.

**1. Does it parse?**

```bash
sudo freeradius -XC
```

Do not start the service until this is clean. A server that half-parses rejects
every login and logs something unrelated.

**2. Can a customer log in — and does the *router* accept the reply?**

```bash
radtest <username> <password> 192.168.88.10 0 <RADIUS_SECRET_NKAWIE01>
```

Then look at the router, not just at us:

```
/log print where topics~"radius" detail
```

If `radtest` says `Access-Accept` but the router says
`received packet ... with missing message auth, dropping`, the
`Message-Authenticator` block in `post-auth` is not in effect. Our log will say
`Login OK` while every customer sees *"RADIUS server is not responding"*. This is
the most confusing failure in the whole stack — see `docs/04-freeradius.md` §4.7.

**3. Can we disconnect someone who is online?**

```bash
sudo WV_COA_SECRET_FILE=/etc/wavly/radius-secret \
     deploy/edge/bin/wv-coa disconnect --nas 192.168.89.1 --user <username>
```

| Exit | Meaning | What to do |
|---|---|---|
| 0 | `Disconnect-ACK` | Working |
| 2 | `Disconnect-NAK` | The router is fine, our attributes are wrong. Retrying is pointless |
| 3 | No reply / timeout | The CoA path is broken: firewall, or `/radius incoming` is not `accept=yes`. Retrying is the only fix |

Codes 2 and 3 are separate on purpose — `syncd` branches on them, and treating a NAK
as a timeout would retry forever.

**4. Is the MAC canary silent?**

```bash
wc -l /var/log/freeradius/wavly-mac-missing.log
```

Non-zero on a site that was working yesterday means the router stopped sending
`Calling-Station-Id`. Every login still succeeds and device binding has silently
stopped working.

**5. Did the secret stay out of the database?**

```bash
psql -U postgres -d wavly_edge -c 'select nasname, secret from nas'
```

The `secret` column must be empty or a placeholder. A real value there means
`read_clients` got turned on, and every off-site backup now contains the one
credential that lets anyone authenticate any customer.

**6. Degradation drill.** Stop Postgres, confirm the local operator account still
authenticates and customers are refused cleanly, then start it again. This is the
scenario the whole edge design exists for; it should be rehearsed, not discovered.

---

## The local account

`mods-config/files/authorize` defines one account, `wavly-local-admin`, and `files`
runs **before** `sql`.

If edge Postgres is down, `sql` returns `noop` and every customer login is
rejected. That is survivable — but it also means you cannot get online to read a
runbook, reach Supabase, or download a package, on a site whose only internet path
is this RADIUS server. That turns a bad hour into a bad day.

It expires (90 days by default), it is limited to two sessions, and its password
comes from the environment. **Rotate it after every use.**

Never put a customer here. A customer defined in `files` cannot be suspended, is
not billed, and appears in no usage report — and you find out when they complain.

---

## `bin/wv-coa`

```bash
wv-coa disconnect --nas <router-ip> --user <username> [--session <id>] [--mac AA:BB:..]
wv-coa throttle   --nas <router-ip> --user <username> --rate '2M/4M' [--session <id>]
wv-coa --help
```

The secret comes from `$WV_COA_SECRET` or `$WV_COA_SECRET_FILE` — never as an
argument, because argv is world-readable via `/proc` and this secret can disconnect
every paying customer.

It exists because FreeRADIUS 3.x can only originate CoA **while handling an
incoming request**. Fair usage is easy (interim accounting arrives every five
minutes). Subscription expiry is not: nothing arrives from the router at 23:59 on
the day a monthly plan ends, so without this the customer stays online until their
device happens to re-authenticate.

---

## Things that will bite you

- **`nasreload` must exist.** Both `simul_*` queries `LEFT JOIN` it, and it is what
  makes `Simultaneous-Use` work. Phase 1 shipped the edge schema without it; on a
  real database that would raise a SQL error on *every* Access-Request. If you
  rebuild the edge database from anything other than `db/migrations/`, check for it.
- **Do not add `radacct_whoson`.** It appears in the official `schema.sql` — inside
  a comment. It is UNIQUE on `(username, acctstarttime, nasipaddress)`, so it
  rejects the accounting INSERT whenever two customers start a session in the same
  second on the same router. You lose usage records, i.e. revenue, only under load.
- **Do not simplify the Gigawords arithmetic in `queries.conf`.**
  `(gigawords::bigint << 32) + octets::bigint` is load-bearing. A 32-bit counter
  wraps at 4 GiB — about 35 minutes at 20 Mbps — and dropping the shift under-bills
  exactly your heaviest users, with numbers that look plausible.
- **`queries.conf` is a whole-file copy on purpose.** FreeRADIUS does not merge two
  sections with the same name; a second `post-auth { ... }` is a parse error or is
  silently ignored, not an override. Our single deviation is marked
  `WAVLY OVERRIDE` — grep for it after any upgrade.
- **The check/reply table split is an interface, not a style choice.** `radcheck`
  and `radgroupcheck` become `&control:`; `radreply` and `radgroupreply` become
  `&reply:`. Put the data cap in the wrong one and it is *sent to the router* while
  the fair-usage policy reads an empty attribute and never fires. The contract table
  is at the top of `policy.d/wavly`.
- **`safe-characters` in `mods-available/sql` must include `:`.** MikroTik sends
  `AA:BB:CC:DD:EE:FF`. Without the colon, `%{SQL-User-Name}` is mangled into
  something that matches no row — a customer who exists but cannot log in.
- **Upgrading to FreeRADIUS 4.x is a rewrite, not a patch.** 4.x uses
  `recv`/`send` instead of `authorize`/`authenticate` and a `radius.coa` module
  instead of `update coa`. Debian 12 ships 3.2.x; stay there.
- **`dictionary.wavly` uses placeholder PEN 52381.** Harmless today because no
  Wavly attribute ever goes on the wire. Register a real PEN with IANA (free) or
  delete the vendor block before that changes.

---

## Tests

```bash
npm run test:edge     # 45 tests
npm test              # everything: SQL validation, structural checks, router + edge
```

The tests render into a temp directory with throwaway secrets. `wv-coa` is tested
against a stubbed `radclient` on `PATH`, so the real argument validation, packet
construction and exit-code mapping all run — including that a Disconnect carries no
authorization attributes (RFC 5176) and that an unrecognised reply is never
reported as success.
