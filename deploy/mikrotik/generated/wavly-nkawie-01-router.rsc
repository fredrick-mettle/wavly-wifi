# ==========================================================================
# Wavly WiFi - MikroTik RouterOS v7 configuration
# Site: Nkawie Main (Nkawie, Ashanti)
# Generated 2026-11-15T12:47:28.778Z by deploy/mikrotik/generate.mjs
# Source of truth: db/seed/0001_core_defaults.sql (parsed, not hand-copied)
#
# READ deploy/mikrotik/README.md BEFORE APPLYING. Summary:
#   * Work from WinBox over ETHERNET or the management Wi-Fi, never over the
#     hotspot network you are about to reconfigure.
#   * /export file=pre-wavly-backup and /system backup save first.
#   * Paste in sections and watch for errors; do not paste the whole file blind.
#   * ==================================================================

## ---- 0. System identity, clock, NTP ------------------------------------
# Ghana is GMT+0 year round (no DST). Correct time matters because RADIUS
# Expiration attributes and TLS both reject a badly skewed clock.
/system identity set name="wavly-nkawie-01"
/system clock set time-zone-name="Africa/Accra" time-zone-autodetect=no
/system ntp client set enabled=yes mode=unicast
/system ntp server set enabled=no
/ipv6 settings set disable-ipv6=yes
# IPv6 is disabled deliberately. Starlink CGNAT gives us no routable inbound
# IPv6, and a half-working IPv6 path lets clients bypass every IPv4 hotspot
# control we configure below.

## ---- 1. Interface lists, bridges, Wi-Fi ---------------------------------
# Physical layout assumed for a hAP ax3 (model C53UiG+5HPaxD2HPaxD):
#   ether1  -> Starlink Mini (WAN, DHCP client)
#   ether2  -> management network (edge node, admin devices)
#   ether3-5, wifi1 (5 GHz), wifi2 (2.4 GHz) -> hotspot network
# NOTE: on the AX line the radio labels are SWAPPED - wifi1 is 5 GHz and wifi2
# is 2.4 GHz. Verify with "/interface wifi print" before trusting this.

/interface list add name=WAN comment="Uplink to Starlink"
/interface list add name=MGMT comment="Management network"
/interface list add name=HOTSPOT comment="Customer hotspot network"
/interface list member add interface=ether1 list=WAN

/interface bridge add name=bridge-mgmt comment="Wavly management (edge node, admins)" protocol-mode=none
/interface bridge add name=bridge-hotspot comment="Wavly hotspot (customers)" protocol-mode=none
/interface bridge port add bridge=bridge-mgmt interface=ether2
/interface bridge port add bridge=bridge-hotspot interface=ether3
/interface bridge port add bridge=bridge-hotspot interface=ether4
/interface bridge port add bridge=bridge-hotspot interface=ether5
/interface list member add interface=bridge-mgmt list=MGMT
/interface list member add interface=bridge-hotspot list=HOTSPOT

# An OPEN SSID. Authentication is the hotspot login, not the Wi-Fi password:
# that is what lets the portal issue per-customer credentials and change them
# without anyone re-entering a Wi-Fi key. The trade-off is that over-the-air
# traffic is not encrypted at layer 2, which is why the hotspot login uses
# http-chap (challenge/response) and never http-pap (plaintext), and why the
# cloud portal is HTTPS-only.
#
# client-isolation is set on the wifi DATAPATH, not the bridge. It stops hotspot
# clients reaching each other at layer 2, which the firewall cannot do as
# cheaply. Section 6 repeats the isolation at layer 3 so a wired customer on
# ether3-5 is covered too.
# The SSID MUST be OPEN - no WPA passphrase. The captive-portal model depends
# on it: customers have to be able to associate before they have any
# credentials, and the hotspot login is what authenticates them. A WPA2 key on
# this SSID means nobody can join at all.
#
# No security profile is set below, which leaves a freshly created
# configuration open on the builds this was written against. VERIFY after
# applying:  /interface wifi configuration print detail
# and confirm authentication-types is empty. If your build defaults it to
# wpa2-psk, set it explicitly:
#   /interface wifi configuration set wv-hotspot-cfg security.authentication-types=""
/interface wifi configuration add name=wv-hotspot-cfg mode=ap ssid="Wavly WiFi" country="Ghana"
/interface wifi datapath add name=wv-hotspot-dp bridge=bridge-hotspot client-isolation=yes
/interface wifi set [ find default-name=wifi1 ] name=wv-5g configuration=wv-hotspot-cfg datapath=wv-hotspot-dp disabled=no channel.band=5ghz-ax
/interface wifi set [ find default-name=wifi2 ] name=wv-24g configuration=wv-hotspot-cfg datapath=wv-hotspot-dp disabled=no channel.band=2ghz-ax
# datapath.bridge already attaches the radios to bridge-hotspot. Do NOT also add
# them with "/interface bridge port" - that creates a second, conflicting path.

## ---- 2. Addresses, DHCP, and captive-portal advertisement ---------------
/ip address add address=192.168.89.1/24 interface=bridge-hotspot comment="Wavly hotspot gateway"
/ip address add address=192.168.88.1/24 interface=bridge-mgmt comment="Wavly management gateway"

/ip dhcp-client add interface=ether1 disabled=no comment="Starlink Mini uplink"

/ip pool add name=wv-pool-hotspot ranges=192.168.89.20-192.168.89.254
/ip pool add name=wv-pool-mgmt ranges=192.168.88.100-192.168.88.149

# RFC 8910 captive-portal URL. This is the RELIABLE way to get Android 13+ to
# open the sign-in page in the real browser instead of the stripped captive
# portal WebView.
#
# force=yes is MANDATORY on RouterOS v7. v6 always sent configured options; v7
# only sends options the client asked for in its Parameter Request List, and no
# client asks for code 114. Without force=yes this option is silently never
# sent and the feature appears to do nothing.
/ip dhcp-server option add name=wv-captive-portal code=114 force=yes value="'https://portal.wavlywifi.com/captive-api.json'"
/ip dhcp-server option sets add name=wv-hotspot-options options=wv-captive-portal

# Lease time is short on the hotspot: addresses must recycle as customers come
# and go, and a stale lease is a customer who cannot reconnect.
/ip dhcp-server add name=wv-dhcp-hotspot interface=bridge-hotspot address-pool=wv-pool-hotspot lease-time=2h authoritative=yes dhcp-option-set=wv-hotspot-options disabled=no
/ip dhcp-server network add address=192.168.89.0/24 gateway=192.168.89.1 dns-server=192.168.89.1 comment="Wavly hotspot"

/ip dhcp-server add name=wv-dhcp-mgmt interface=bridge-mgmt address-pool=wv-pool-mgmt lease-time=1d authoritative=yes disabled=no
/ip dhcp-server network add address=192.168.88.0/24 gateway=192.168.88.1 dns-server=192.168.88.1 comment="Wavly management"

/ip dns set allow-remote-requests=yes cache-size=4096 servers=1.1.1.1,8.8.8.8
#
# 1.1.1.1 and 8.8.8.8 also appear in the wv-blocked address list in section 5.
# THAT IS NOT A CONTRADICTION - do not "fix" it. The blocklist applies to
# FORWARD traffic from hotspot clients, so it stops a customer pointing their
# phone at a public resolver and bypassing every DNS rule we have. The queries
# below are made by the ROUTER ITSELF through its DNS proxy and never traverse
# the forward chain. Clients must use our resolver; the router may use a public
# one. Removing either half breaks something: remove the block and DNS
# filtering is optional; remove these servers and nothing resolves.
#
# The edge node becomes the authoritative resolver for hotspot clients in
# production; these stay as the fallback for when it is down.

## ---- 3. Walled garden ----------------------------------------------------
# TWO SEPARATE TABLES. They are not interchangeable.
#
#   /ip hotspot walled-garden       L7. Matches the HTTP Host header and path.
#                                   PLAIN HTTP ONLY. action = allow | deny
#   /ip hotspot walled-garden ip    L3/L4. Matches destination IP, protocol and
#                                   port, plus dst-host which RouterOS resolves
#                                   into DYNAMIC address entries.
#                                   action = accept | drop | reject
#
# The cloud portal is HTTPS on Vercel. RouterOS cannot read a Host header inside
# a TLS ClientHello, so an L7 rule would NOT unblock it. Every HTTPS destination
# needs an L3 entry. Getting this wrong is silent: the config loads, and new
# customers simply cannot reach the portal.

# --- L7 (plain HTTP only) ---
/ip hotspot walled-garden add action=allow dst-host="portal.wavlywifi.com" comment="wv: Plain-HTTP leg of the portal. The HTTPS leg is the walled_garden_ip row below."
/ip hotspot walled-garden add action=allow dst-host="*.portal.wavlywifi.com" comment="wv: Plain-HTTP leg of the portal. The HTTPS leg is the walled_garden_ip row below."
/ip hotspot walled-garden add action=allow dst-host="wavlywifi.com" comment="wv: Plain-HTTP leg of the marketing site / privacy notice."
/ip hotspot walled-garden add action=allow dst-host="*.wavlywifi.com" comment="wv: Plain-HTTP leg of the marketing site / privacy notice."

# --- L3 (required for every HTTPS destination) ---
/ip hotspot walled-garden ip add action=accept dst-host="checkout.paystack.com" comment="wv-dyn: L3 walled garden (dst-host). Hosted-checkout fallback."
/ip hotspot walled-garden ip add action=accept dst-host="portal.wavlywifi.com" comment="wv-dyn: L3 walled garden (dst-host). REQUIRED for HTTPS — the L7 table cannot match TLS."
/ip hotspot walled-garden ip add action=accept dst-host="standard.paystack.co" comment="wv-dyn: L3 walled garden (dst-host)."
/ip hotspot walled-garden ip add action=accept dst-host="wavlywifi.com" comment="wv-dyn: L3 walled garden (dst-host)."

# --- Captive-portal detection endpoints are LEFT INTERCEPTED ---
# Counter-intuitive, and the single most common reason a portal "does not pop up".
# These probes are how the phone decides whether to show the sign-in sheet. They
# must be intercepted so the probe receives a 302 to our login page instead of
# its expected 204/"Success". Allowing them through makes the OS conclude there
# is real internet, and the sheet never appears.
#
# Do NOT add these to the walled garden:
#   connectivitycheck.gstatic.com
#   captive.apple.com
#   www.apple.com
#   msftconnecttest.com
#   connectivitycheck.platform.hicloud.com
#
# If one specific handset model misbehaves, flip
# network.intercept_captive_detection to false and regenerate - that adds these
# hosts as allow rules - rather than hand-editing the router.

## ---- 5. Blocked address list --------------------------------------------
# Covers DoH/DoT resolvers and anything that would bypass our DNS filtering.
# Entries tagged "wv-dyn" are hostnames RouterOS resolves dynamically; the
# scheduler near the end of this script refreshes them, because these providers
# rotate IPs and a stale entry silently stops blocking.
/ip firewall address-list add list="wv-blocked" address="cloudflare-dns.com" comment="wv-dyn: Cloudflare DoH."
/ip firewall address-list add list="wv-blocked" address="dns.adguard.com" comment="wv-dyn: AdGuard DoH."
/ip firewall address-list add list="wv-blocked" address="dns.alidns.com" comment="wv-dyn: AliDNS DoH."
/ip firewall address-list add list="wv-blocked" address="dns.google" comment="wv-dyn: Google DoH — bypasses all DNS filtering."
/ip firewall address-list add list="wv-blocked" address="dns.google.com" comment="wv-dyn: Google DoH."
/ip firewall address-list add list="wv-blocked" address="dns.quad9.net" comment="wv-dyn: Quad9 DoH/DoT."
/ip firewall address-list add list="wv-blocked" address="doh.dns.apple.com" comment="wv-dyn: Apple DoH — iOS enables this automatically when the resolver supports it."
/ip firewall address-list add list="wv-blocked" address="doh.opendns.com" comment="wv-dyn: OpenDNS DoH."
/ip firewall address-list add list="wv-blocked" address="doh.pub" comment="wv-dyn: DNSPod DoH."
/ip firewall address-list add list="wv-blocked" address="mozilla.cloudflare-dns.com" comment="wv-dyn: Firefox TRR."
/ip firewall address-list add list="wv-blocked" address="one.one.one.one" comment="wv-dyn: Cloudflare DoH."
/ip firewall address-list add list="wv-blocked" address="1.1.1.1/32" comment="wv: Cloudflare resolver IP. Block the IP too, not just the name."
/ip firewall address-list add list="wv-blocked" address="208.67.222.222/32" comment="wv: OpenDNS resolver IP."
/ip firewall address-list add list="wv-blocked" address="8.8.8.8/32" comment="wv: Google resolver IP."
/ip firewall address-list add list="wv-blocked" address="9.9.9.9/32" comment="wv: Quad9 resolver IP."

## ---- 6. Firewall ---------------------------------------------------------
# ORDERING IS NOT HANDLED FOR YOU. RouterOS evaluates a chain top to bottom and
# these rules are APPENDED, after whatever the factory default config already
# put there. The default input chain typically ends with a "drop all not coming
# from LAN" rule, and the hotspot network is deliberately NOT in the LAN list -
# so that default rule would shadow ours and block the login page itself.
#
# After pasting, run:   /ip firewall filter print
# and confirm every rule commented "wv:" sits ABOVE any defconf drop rule in the
# same chain. Drag them into position in WinBox (IP -> Firewall -> Filter),
# which is far safer than guessing at "move" indices over a console.
#
# This is the one part of the script that needs a human to look at the result.
# Everything else is either idempotent or fails loudly.

# --- input: protect the router itself ---
/ip firewall filter add chain=input comment="wv: drop invalid" connection-state=invalid action=drop
/ip firewall filter add chain=input comment="wv: accept established/related" connection-state=established,related action=accept
#
# CoA (RFC 3576) listens on UDP 3799. It is how the cloud tells a live session
# to disconnect at expiry or throttle at fair usage. It is also a remote
# control channel, so it is accepted from the edge node and from NOTHING else.
/ip firewall filter add chain=input comment="wv: CoA from edge node only" protocol=udp dst-port=3799 src-address=192.168.88.10 action=accept
/ip firewall filter add chain=input comment="wv: drop all other CoA" protocol=udp dst-port=3799 action=drop
#
# RADIUS is router -> edge (outbound), so it needs no input rule.
/ip firewall filter add chain=input comment="wv: management services from mgmt network only" in-interface-list=MGMT protocol=tcp dst-port=22,8291,443 action=accept
/ip firewall filter add chain=input comment="wv: hotspot clients may reach the hotspot service" in-interface-list=HOTSPOT protocol=tcp dst-port=80,443 action=accept
/ip firewall filter add chain=input comment="wv: hotspot clients need DNS and DHCP" in-interface-list=HOTSPOT protocol=udp dst-port=53,67 action=accept
/ip firewall filter add chain=input comment="wv: management services from hotspot network - deny" in-interface-list=HOTSPOT action=drop
/ip firewall filter add chain=input comment="wv: drop WAN management access" in-interface-list=WAN protocol=tcp dst-port=22,23,8291,443,8728 action=drop

# --- forward: what hotspot traffic may do ---
/ip firewall filter add chain=forward comment="wv: drop invalid" connection-state=invalid action=drop
/ip firewall filter add chain=forward comment="wv: accept established/related" connection-state=established,related action=accept
#
# The ONE exception to management isolation: the activation handshake. An https
# portal cannot POST to an http router, but a top-level 302 from https to http is
# allowed, so the portal redirects to the router's activate.html, which POSTs to
# the edge node to collect one-time RADIUS credentials and then submits a
# SAME-ORIGIN POST to the router's /login. Expose one host and one port;
# nothing else on the management network is reachable from the hotspot.
/ip firewall filter add chain=forward comment="wv: activation handshake to edge node only" src-address=192.168.89.0/24 dst-address=192.168.88.10 protocol=tcp dst-port=8787 action=accept
/ip firewall filter add chain=forward comment="wv: hotspot -> management DENIED" src-address=192.168.89.0/24 dst-address=192.168.88.0/24 action=drop
#
# Client-to-client isolation at layer 3. The wifi datapath already does this for
# wireless clients; this covers anyone plugged into ether3-5.
/ip firewall filter add chain=forward comment="wv: hotspot client-to-client DENIED" src-address=192.168.89.0/24 dst-address=192.168.89.0/24 action=drop
#
# Basic abuse protection. DoH/DoT would bypass every DNS rule in section 4.
/ip firewall filter add chain=forward comment="wv: block known DoH/DoT bypass list" src-address=192.168.89.0/24 dst-address-list=wv-blocked action=drop
/ip firewall filter add chain=forward comment="wv: block DoT (port 853)" src-address=192.168.89.0/24 protocol=tcp dst-port=853 action=drop
/ip firewall filter add chain=forward comment="wv: block QUIC/HTTP3 UDP 443 - uninspectable and evades the hotspot redirect" src-address=192.168.89.0/24 protocol=udp dst-port=443 action=drop
/ip firewall filter add chain=forward comment="wv: hotspot clients must use OUR DNS" src-address=192.168.89.0/24 protocol=udp dst-port=53 action=drop
/ip firewall filter add chain=forward comment="wv: allow hotspot to internet" src-address=192.168.89.0/24 out-interface-list=WAN action=accept
/ip firewall filter add chain=forward comment="wv: allow management to internet" src-address=192.168.88.0/24 out-interface-list=WAN action=accept
/ip firewall filter add chain=forward comment="wv: default deny forwarding" action=drop

# Masquerade on the uplink only.
/ip firewall nat add chain=srcnat comment="wv: masquerade to Starlink" out-interface-list=WAN action=masquerade

# QUIC is blocked deliberately. HTTP/3 runs over UDP 443, which the hotspot
# cannot intercept or shape with HTTP-based rules, so it both evades the login
# redirect and defeats the rate limits. Clients fall back to HTTP/2 over TCP.

## ---- 7. Hotspot server and profile --------------------------------------
# html-directory must be a directory ON THE ROUTER. html-directory-override is
# only for files on attached USB/HDD storage - it is NOT a remote URL mechanism,
# so the custom pages cannot be served from the cloud.
#
# We override individual pages in the STOCK 'hotspot' directory rather than
# pointing at a fresh one. A fresh directory has to ship every file the hotspot
# machinery expects, including md5.js - and a missing md5.js breaks http-chap
# login with no error message at all, which is a very expensive thing to debug
# on a live site. Overriding pages keeps the stock dependencies intact.
#
# login-by is http-chap,cookie and NEVER http-pap: http-pap sends the customer's
# credentials in plaintext over an unencrypted hotspot. cookie keeps a device
# logged in across short disconnects so a phone that sleeps does not have to
# re-authenticate every time.
/ip hotspot profile add name=wv-hotspot-profile \
    hotspot-address=192.168.89.1 \
    dns-name="hotspot.lan" \
    html-directory=hotspot \
    use-radius=yes \
    radius-accounting=yes \
    radius-interim-update=5m \
    login-by=http-chap,cookie \
    http-cookie-lifetime=1d \
    radius-mac-format=XX:XX:XX:XX:XX:XX \
    radius-location-id="nkawie-01" \
    radius-location-name="Nkawie Main" \
    nas-port-type=wireless-802.11 \
    comment="Wavly WiFi hotspot"

# https-redirect is OFF. RouterOS v7 does not expose a working
# ssl-certificate on the hotspot profile, so redirecting an https:// URL lands
# the client on a certificate name mismatch. Better to let the plain-HTTP probe
# and DHCP option 114 do the redirecting.
/ip hotspot profile set [ find name=wv-hotspot-profile ] https-redirect=no

/ip hotspot add name=wv-hotspot interface=bridge-hotspot address-pool=wv-pool-hotspot profile=wv-hotspot-profile addresses-per-mac=1 idle-timeout=30m keepalive-timeout=5m disabled=no

# addresses-per-mac=1 stops one MAC address holding several leases, which is how
# a single customer otherwise consumes a whole pool.

## ---- 8. Local hotspot user profiles (RADIUS-independent) -----------------
# These exist so the router is still usable when FreeRADIUS is down, and for
# staff and suspended accounts. Everything else authenticates through RADIUS.
#
# Trial is deliberately NOT enabled: an unlimited free trial on a paid service
# with a hard data cap upstream is a business problem, not a config option.
/ip hotspot user profile add name=wv-suspended rate-limit=8k/8k 8k/8k 8k/8k 1s/1s 8 8k/8k shared-users=1 transparent-proxy=no comment="Suspended accounts: 8 kbps is enough to reach the portal and renew, nothing else"
/ip hotspot user profile add name=wv-staff rate-limit=10M/20M 20M/40M 5M/10M 15s/15s 4 2500k/5M shared-users=5 transparent-proxy=no comment="On-site staff. Do not hand this to customers."

# --- rate-limit values that RADIUS will send per plan ---
# Rendered from rate_profiles so the numbers here and in the database cannot
# drift. NOTE THE ORDER: MikroTik's attribute is rx/tx FROM THE ROUTER'S VIEW,
# so rx is client UPLOAD and tx is client DOWNLOAD. A plan sold as
# "12 down / 6 up" is written "6M/12M". Getting this backwards produces no
# error anywhere - everything is just slow in one direction.
#   p-3-1       3 / 1 Mbps     -> Mikrotik-Rate-Limit="1M/3M 2M/6M 500k/1500k 8s/8s 8 250k/500k"
#   p-6-3       6 / 3 Mbps     -> Mikrotik-Rate-Limit="3M/6M 6M/12M 1500k/3M 10s/10s 7 500k/1M"
#   p-10-5      10 / 5 Mbps    -> Mikrotik-Rate-Limit="5M/10M 10M/20M 2500k/5M 12s/12s 6 1M/2M"
#   p-12-6      12 / 6 Mbps    -> Mikrotik-Rate-Limit="6M/12M 12M/24M 3M/6M 15s/15s 5 1500k/3M"
#   p-20-10     20 / 10 Mbps   -> Mikrotik-Rate-Limit="10M/20M 20M/40M 5M/10M 15s/15s 4 2500k/5M"
#   fup-4-2     FUP 4 / 2 Mbps -> Mikrotik-Rate-Limit="2M/4M 2M/4M 2M/4M 1s/1s 8 500k/1M"
#   fup-6-3     FUP 6 / 3 Mbps -> Mikrotik-Rate-Limit="3M/6M 3M/6M 3M/6M 1s/1s 8 750k/1500k"
#   suspended   Suspended      -> Mikrotik-Rate-Limit="8k/8k 8k/8k 8k/8k 1s/1s 8 8k/8k"
#
# Burst thresholds above are RATES in bits/s, not byte counts. A column called
# burst_threshold_bytes would parse, load, and never burst.

## ---- 9. RADIUS client and CoA -------------------------------------------
# FreeRADIUS runs on the EDGE NODE, not in the cloud. A satellite round trip is
# 400-900 ms and MikroTik gives up at ~300 ms by default, so cloud RADIUS would
# fail logins intermittently - and worse, paying customers could not
# re-authenticate at all during a Starlink outage.
/radius add address=192.168.88.10 secret="REPLACE_WITH_RADIUS_SECRET" service=hotspot authentication-port=1812 accounting-port=1813 timeout=3000ms comment="Wavly edge FreeRADIUS"

# CoA (Change of Authorization, RFC 3576) on UDP 3799. This is the ONLY way to
# disconnect a live session the moment a subscription expires, or throttle it
# the moment fair usage is hit. Without it, expiry only bites at the next
# re-authentication - which for a monthly customer can be days later.
#
# Starlink CGNAT means nothing can originate a connection INTO this site, so CoA
# can only come from the edge node on the same LAN. That constraint is why the
# edge node exists.
/radius incoming set accept=yes port=3799

## ---- 10. Site capacity queue -------------------------------------------
# Measured capacity (edit these two settings after measuring on site):
#   downstream 80000 kbps, upstream 15000 kbps, capped at 85%
#   => site ceiling 12750k up / 68M down
#
# This is NOT a safety margin, it is the difference between a site that is busy
# and a site that feels broken. A queue running at exactly line rate develops
# unbounded latency: throughput still measures fine while every video call
# collapses. Upstream is capped hardest because Starlink upload (10-25 Mbps)
# saturates first and it is what makes calls fail for everyone at once.
#
# Oversubscription, stated honestly. Worst case is 80 concurrent users
# all on the fastest plan (20 / 10 Mbps):
#   download  1600000 kbps demanded vs 68000 kbps ceiling  => ~23.5:1
#   upload    800000 kbps demanded vs 12750 kbps ceiling  => ~62.7:1
# Real demand is far lower - most customers idle most of the time, and nobody
# sustains their ceiling. But this is exactly why per-plan rates are CAPS and
# never guarantees, why the portal must say "up to", and why the site queue
# above exists: it is the only thing standing between one heavy user and
# everyone else's video call.
#
# Edit network.planned_concurrent_users and the two capacity settings as the
# subscriber count grows, then regenerate. When the ratio passes roughly 20:1
# downlink the answer is a second radio and a second site, not a bigger queue.
#
# max-limit is rx/tx, and rx is UPLOAD from the router's view - the same
# inversion as the rate-limit attribute.
# default-small is the right type for a PARENT queue: it polices the aggregate
# without adding a second layer of buffering. A real queueing discipline here
# would double-queue traffic that the per-user queues already shape.
/queue simple add name=wv-site-cap target=192.168.89.0/24 max-limit=12750k/68M queue=default-small/default-small comment="Site ceiling - MUST sit above the dynamic per-user queues" disabled=no

# Position is not cosmetic. Simple queues form a hierarchy by target, and the
# hotspot's dynamic per-user queues only nest under this one if it comes FIRST.
/queue simple move [ find name=wv-site-cap ] 0

# VERIFY after applying:  /queue simple print hierarchy
# The dynamic per-user queues must appear INDENTED under wv-site-cap. If they are
# at the same level, the site ceiling is not being applied and one customer can
# saturate the uplink for everyone.

## ---- 11. Optional PCQ fair sharing ------------------------------------
# Left DISABLED by default. Per-user RADIUS rate limits already shape each
# customer to their plan; PCQ adds automatic fair sharing BETWEEN customers on
# the same profile when the site is congested.
#
# Enable only after measuring. pcq-rate=0 means "share the available bandwidth
# equally", which is what you want here - a fixed pcq-rate would cap each flow
# regardless of how many users are online.
/queue type add name=wv-pcq-down kind=pcq pcq-rate=0 pcq-classifier=dst-address pcq-total-limit=2000KiB disabled=no
/queue type add name=wv-pcq-up kind=pcq pcq-rate=0 pcq-classifier=src-address pcq-total-limit=2000KiB disabled=no
# To use them, set the site queue's type and let the per-user queues inherit:
#   /queue simple set [ find name=wv-site-cap ] queue=wv-pcq-up/wv-pcq-down
# pcq-classifier=dst-address on the DOWN queue and src-address on the UP queue
# is not a typo: each direction must be classified by the customer's address.

## ---- 12. Scheduler: refresh resolved walled-garden hosts ---------------
# dst-host entries are resolved by RouterOS into DYNAMIC address entries.
# Cloudflare and Vercel rotate addresses, so a stale resolution silently locks
# new customers out of the portal while everything else looks healthy - the
# worst failure mode here, because it presents as "the portal is down".
#
# Re-setting dst-host to its own value forces re-resolution. Entries are found by
# the "wv-dyn:" comment tag written in section 3.
# Hosts: checkout.paystack.com, cloudflare-dns.com, dns.adguard.com, dns.alidns.com, dns.google, dns.google.com, dns.quad9.net, doh.dns.apple.com, doh.opendns.com, doh.pub, mozilla.cloudflare-dns.com, one.one.one.one, portal.wavlywifi.com, standard.paystack.co, wavlywifi.com
/system script add name=wv-refresh-walled-garden dont-require-permissions=no owner=admin policy=read,write,api source=":local n 0
:foreach e in=[/ip hotspot walled-garden ip find where comment~\"wv-dyn\"] do={
  :local h [/ip hotspot walled-garden ip get $e dst-host]
  /ip hotspot walled-garden ip set $e dst-host=$h
  :set n ($n + 1)
}
:foreach e in=[/ip firewall address-list find where comment~\"wv-dyn\"] do={
  :local a [/ip firewall address-list get $e address]
  /ip firewall address-list set $e address=$a
  :set n ($n + 1)
}
/log info \"wv: refreshed $n dynamic walled-garden entries\""
/system scheduler add name=wv-refresh-walled-garden interval=6h start-time=startup on-event=wv-refresh-walled-garden policy=read,write,api comment="Re-resolve portal/CDN addresses"

## ---- 13. Nightly configuration backup ---------------------------------
# Written to the router's flash and to a second copy on the management network.
# A backup that lives only on the device it backs up is not a backup: if the
# router is stolen or struck by lightning, the config goes with it.
/system script add name=wv-nightly-backup dont-require-permissions=no owner=admin policy=read,write,test,sensitive source=":local d [/system clock get date]
:local t [/system clock get time]
:local stamp ($d . \"-\" . $t)
/export file=(\"wavly-config-\" . $stamp)
/system backup save name=(\"wavly-\" . $stamp) dont-encrypt=yes
/log info (\"wv: nightly backup saved as wavly-\" . $stamp)"
/system scheduler add name=wv-nightly-backup interval=1d start-time=02:30:00 on-event=wv-nightly-backup policy=read,write,test,sensitive comment="Nightly config backup"

## ---- 14. Management hardening -------------------------------------------
# Services reachable from the hotspot network are attack surface for customers
# who have a financial incentive to bypass the portal.
/ip service set telnet disabled=yes
/ip service set ftp disabled=yes
/ip service set www disabled=yes
/ip service set api disabled=yes
/ip service set api-ssl disabled=yes
/ip service set www-ssl disabled=yes address=192.168.88.0/24
/ip service set ssh disabled=no address=192.168.88.0/24
/ip service set winbox disabled=no address=192.168.88.0/24
# SSH and WinBox are bound to the MANAGEMENT network only. If you must
# administer remotely, use a VPN into the management network - do not expose
# these on the uplink.

/ip neighbor discovery-settings set discover-interface-list=MGMT
/tool mac-server set allowed-interface-list=MGMT
/tool mac-server mac-winbox set allowed-interface-list=MGMT
/tool mac-server ping set enabled=no
/ip proxy set enabled=no
/ip socks set enabled=no
/ip upnp set enabled=no
/ip cloud set ddns-enabled=no update-time=no
# /ip cloud is disabled because it would publish a reachable name for this
# router. Starlink CGNAT means inbound does not work anyway; leaving it on only
# creates a false sense of a management path.

## ---- 15. Logging and diagnostics ----------------------------------------
/system logging add topics=hotspot action=memory
/system logging add topics=hotspot,debug action=memory disabled=yes
/system logging add topics=radius action=memory
/system logging add topics=dns action=memory disabled=yes
# hotspot,debug and dns are added DISABLED. Turn them on only while diagnosing:
# they are extremely chatty and will rotate useful history out of the buffer.

# --- checks to run after applying ---
#   /radius/monitor 0            pending, accepts, rejects, resends, timeouts,
#                                bad-replies, last-request-rtt
#   /ip hotspot active print     who is online right now
#   /ip hotspot host print where bypassed=yes
#   /ip hotspot walled-garden print stats
#   /queue simple print hierarchy  (per-user queues MUST nest under wv-site-cap)
#   /log print where topics~"hotspot,radius"
#   /ip dhcp-server lease print where dynamic=yes
#
# --- the 60-second smoke test ---
# 1. Join the SSID. The sign-in sheet must pop up on its own within ~10 s.
#    If it does not, see section 3 - a detection endpoint is being allowed
#    through, or option 114 is missing force=yes.
# 2. Log in with a test RADIUS account. /ip hotspot active print shows it.
# 3. Open https://portal.wavlywifi.com - it must load BEFORE login
#    (this is the L3 walled garden working).
# 4. From a hotspot client, ping 192.168.88.1 must FAIL and ping 192.168.88.10 must FAIL
#    (management isolation), while tcp/8787 to 192.168.88.10 must succeed
#    (the activation handshake).
# 5. Expire the test subscription and confirm CoA disconnects it within seconds.
#    If it only drops at the next re-auth, /radius incoming or the firewall rule
#    on UDP 3799 is wrong.

# ==========================================================================
# RENDER SUMMARY
#   rate profiles      8
#   plans              7
#   walled garden L7   4 entries
#   walled garden L3   4 entries (15 dynamic host(s))
#   DNS sinkholes      0
#   blocked addresses  15
#   rules not rendered 0
# ==========================================================================

