/**
 * Maps `network_rules` rows onto MikroTik constructs.
 *
 * THE TWO WALLED GARDENS ARE NOT INTERCHANGEABLE
 * -----------------------------------------------
 *   /ip hotspot walled-garden      (L7)  matches the HTTP Host header + path.
 *                                        PLAIN HTTP ONLY. action=allow|deny
 *   /ip hotspot walled-garden ip   (L3)  matches dst IP/protocol/port, and
 *                                        dst-host which RouterOS RESOLVES into
 *                                        dynamic address entries.
 *                                        action=accept|drop|reject
 *
 * Two traps this module exists to avoid:
 *
 *   1. `action` differs between the tables. Writing `action=allow` into the IP
 *      table is rejected — and if it were accepted it would be a silent no-op.
 *      Every HTTPS destination therefore needs an L3 entry with action=accept.
 *   2. A bare `dst-host=example.com` in the L7 table does NOT match
 *      `www.example.com`. Wildcards are explicit. So a single "domain" rule
 *      fans out to both the exact host and its `*.` variant.
 *
 * DNS-sinkholed and address-list rules are POST-authentication controls; they do
 * not belong in the walled garden at all and are rendered separately.
 */

/** action values differ per table — never mix them up. */
export const L7_ACTIONS = { allow: 'allow', block: 'deny' };
export const L3_ACTIONS = { allow: 'accept', block: 'drop' };

/**
 * Fan a domain rule out into the host names MikroTik needs to see.
 * `domain` and `domain_suffix` behave the same here: matching the apex alone
 * would silently miss www and every other subdomain.
 */
export function hostVariants(pattern) {
  const p = String(pattern).trim().toLowerCase().replace(/^\*?\./, '');
  if (!p) return [];
  return [p, `*.${p}`];
}

/** RouterOS quoting: wrap in double quotes, escape embedded quotes/backslashes. */
export function rscQuote(v) {
  const s = String(v);
  if (s === '') return '""';
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** True when a pattern looks like an IP literal or CIDR rather than a hostname. */
export function isIpLike(pattern) {
  return /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(String(pattern).trim());
}

/**
 * Split active network rules into the constructs they render to.
 *
 * @param {object[]} rules  rows from network_rules (already filtered is_active)
 * @param {object} [opts]
 * @param {string} [opts.hotspotServer] name of the hotspot server, for `server=`
 * @returns {{
 *   walledGardenL7: object[], walledGardenL3: object[],
 *   dnsSinkhole: object[], addressListBlock: object[], layer7: object[],
 *   skipped: Array<{pattern:string, reason:string}>
 * }}
 */
export function classifyRules(rules, opts = {}) {
  const server = opts.hotspotServer ?? null;
  /** @type {object[]} */ const walledGardenL7 = [];
  /** @type {object[]} */ const walledGardenL3 = [];
  /** @type {object[]} */ const dnsSinkhole = [];
  /** @type {object[]} */ const addressListBlock = [];
  /** @type {object[]} */ const layer7 = [];
  /** @type {object[]} */ const skipped = [];

  const seen = new Set();
  const push = (bucket, key, entry) => {
    if (seen.has(key)) return; // de-dup: the same domain may appear in two rules
    seen.add(key);
    bucket.push(entry);
  };

  // Deterministic order so the rendered script diffs cleanly run to run.
  const sorted = [...rules].sort(
    (a, b) => (a.priority - b.priority) || String(a.pattern).localeCompare(String(b.pattern)),
  );

  for (const r of sorted) {
    const pattern = String(r.pattern).trim();
    if (!pattern) continue;

    // Only global rules reach the router. Plan/user-scoped rules are enforced by
    // RADIUS reply attributes and the edge policy engine, not by static config.
    if (r.scope && r.scope !== 'global') {
      skipped.push({ pattern, reason: `scope=${r.scope} is enforced by RADIUS/edge, not by router config` });
      continue;
    }

    switch (r.enforcement) {
      case 'walled_garden': {
        if (isIpLike(pattern)) {
          // An IP cannot be matched by Host header; it belongs in the L3 table.
          push(walledGardenL3, `l3:ip:${r.action}:${pattern}`, {
            action: L3_ACTIONS[r.action], dstAddress: pattern, comment: note(r),
          });
          break;
        }
        for (const host of hostVariants(pattern)) {
          push(walledGardenL7, `l7:${r.action}:${host}`, {
            action: L7_ACTIONS[r.action], dstHost: host, comment: note(r), server,
          });
        }
        break;
      }

      case 'walled_garden_ip': {
        if (isIpLike(pattern)) {
          push(walledGardenL3, `l3:ip:${r.action}:${pattern}`, {
            action: L3_ACTIONS[r.action], dstAddress: pattern, comment: note(r),
          });
        } else {
          // dst-host in the L3 table makes RouterOS resolve the name and add a
          // DYNAMIC entry. Cloudflare/Vercel IPs rotate, so a scheduler must
          // re-resolve — see the rendered `/system scheduler` entry.
          push(walledGardenL3, `l3:host:${r.action}:${pattern}`, {
            action: L3_ACTIONS[r.action], dstHost: pattern, comment: note(r),
            dynamic: true,
          });
        }
        break;
      }

      case 'dns': {
        if (isIpLike(pattern)) {
          skipped.push({ pattern, reason: 'enforcement=dns needs a hostname, not an IP' });
          break;
        }
        // Sinkhole: resolving the name to a blackhole address. Works for HTTPS
        // too, because the connection never reaches the real origin. It does NOT
        // work against DoH, which is exactly why the DoH resolvers are separately
        // blocked via address_list.
        for (const host of hostVariants(pattern)) {
          push(dnsSinkhole, `dns:${host}`, {
            name: host, address: r.action === 'block' ? '0.0.0.0' : null, comment: note(r),
          });
        }
        break;
      }

      case 'address_list': {
        if (isIpLike(pattern)) {
          push(addressListBlock, `al:ip:${pattern}`, {
            list: 'wv-blocked', entry: pattern, comment: note(r),
          });
        } else {
          // NO wildcard variants here. /ip firewall address-list address= takes an
          // IP, a CIDR, or ONE FQDN that RouterOS resolves; "*.dns.google" is
          // rejected. That differs from /ip dns static, which does accept
          // wildcards - the two constructs look alike and are not.
          push(addressListBlock, `al:host:${pattern}`, {
            list: 'wv-blocked', entry: pattern, dynamic: true, comment: note(r),
          });
        }
        break;
      }

      case 'layer7': {
        push(layer7, `l7p:${pattern}`, { name: l7Name(pattern), regexp: pattern, comment: note(r) });
        break;
      }

      case 'portal_only':
        skipped.push({ pattern, reason: 'portal_only is handled in application code' });
        break;

      default:
        skipped.push({ pattern, reason: `unknown enforcement '${r.enforcement}'` });
    }
  }

  return { walledGardenL7, walledGardenL3, dnsSinkhole, addressListBlock, layer7, skipped };
}

/** A short, single-line comment; RouterOS comments must not contain newlines. */
function note(r) {
  const raw = (r.notes || r.category || r.enforcement || '').toString();
  const flat = raw.replace(/\s+/g, ' ').trim();
  // RouterOS truncates long comments in the console; keep them useful.
  return flat.length > 96 ? `${flat.slice(0, 93)}...` : flat;
}

/** `/ip firewall layer7-protocol` names: lowercase alphanumerics and dashes. */
export function l7Name(pattern) {
  const base = String(pattern).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `wv-${(base || 'rule').slice(0, 40)}`;
}

/**
 * Hosts whose DNS resolution must be refreshed periodically, because Cloudflare
 * and Vercel rotate addresses and a stale walled garden locks paying customers
 * out of the portal while everything else looks healthy.
 */
export function dynamicHosts(classified) {
  const hosts = new Set();
  for (const e of classified.walledGardenL3) if (e.dynamic && e.dstHost) hosts.add(e.dstHost);
  for (const e of classified.addressListBlock) if (e.dynamic && e.entry) hosts.add(e.entry);
  return [...hosts].sort();
}
