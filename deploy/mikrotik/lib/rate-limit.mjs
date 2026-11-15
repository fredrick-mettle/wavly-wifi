/**
 * Mikrotik-Rate-Limit renderer.
 *
 * This is the single most dangerous piece of logic in the whole system, because
 * getting it wrong produces NO error anywhere. The router accepts the attribute,
 * the customer connects, and everything is simply slow in one direction.
 *
 * ---------------------------------------------------------------------------
 * THE INVERSION
 * ---------------------------------------------------------------------------
 * MikroTik documents the attribute as:
 *
 *   rx-rate[/tx-rate] [rx-burst-rate[/tx-burst-rate]
 *     [rx-burst-threshold[/tx-burst-threshold]
 *       [rx-burst-time[/tx-burst-time] [priority] [rx-rate-min[/tx-rate-min]]]]]
 *
 *   "from the point of view of the router (so rx is client upload, and tx is
 *    client download)"
 *
 * So a plan SOLD as "12 Mbps down / 6 Mbps up" is written  "6M/12M".
 * Upload first. Every field pair in this file is ordered upload-then-download
 * for that reason, and there is a test asserting it.
 *
 * ---------------------------------------------------------------------------
 * UNITS
 * ---------------------------------------------------------------------------
 * MikroTik rates are BITS PER SECOND with an optional 'k' (x1000) or 'M'
 * (x1000000) suffix. Our database columns are KILOBITS per second. Writing the
 * raw column value would be a factor-of-1000 error: download_kbps=12000 means
 * 12 Mbit/s and must render as "12M" or "12000k", never "12000".
 *
 * ---------------------------------------------------------------------------
 * POSITIONAL PARAMETERS
 * ---------------------------------------------------------------------------
 * The parameters are positional. You cannot specify `priority` without first
 * specifying burst-rate, burst-threshold and burst-time; you cannot specify
 * rate-min without priority. So when a caller wants priority but the profile has
 * no burst, we emit burst-rate = rate, threshold = rate and time = 1s. That is
 * a no-op burst (you can never exceed your own ceiling) and it unlocks the
 * positional slots we need. This is the standard idiom and it is deliberate.
 *
 * ---------------------------------------------------------------------------
 * BURST THRESHOLD IS A RATE, NOT A BYTE COUNT
 * ---------------------------------------------------------------------------
 * burst-threshold is "the value of average data rate that must not be exceeded
 * for the burst to be allowed", in bits/s. It is NOT "burst until N bytes have
 * been transferred". A column named burst_threshold_bytes would produce a
 * configuration that parses, loads, and never bursts.
 */

/**
 * Bits-per-second with a k/M suffix. Input is KILOBITS per second.
 *
 * Only exact multiples of 1000 are rendered with an 'M' suffix. A fractional
 * form like "1.5M" is not something MikroTik documents accepting, and an
 * attribute the router silently rejects is worse than an ugly one — so anything
 * that is not a whole number of megabits renders in kilobits ("1500k"), which is
 * unambiguous and always valid.
 */
export function formatRate(kbps) {
  if (kbps === null || kbps === undefined) return null;
  const v = Number(kbps);
  if (!Number.isFinite(v) || v <= 0) return null;
  const whole = Math.round(v);
  if (whole !== v) throw new Error(`formatRate: ${kbps} kbps is not a whole number of kilobits`);
  return whole % 1000 === 0 ? `${whole / 1000}M` : `${whole}k`;
}

/** Burst time renders as "<n>s/<n>s"; MikroTik defaults to 1s when omitted. */
function formatTime(seconds) {
  if (seconds === null || seconds === undefined) return null;
  const v = Number(seconds);
  if (!Number.isFinite(v) || v <= 0) return null;
  return `${Math.round(v)}s`;
}

/**
 * @typedef {object} RateProfile
 * @property {string}  name
 * @property {number}  download_kbps                     client download (tx)
 * @property {number}  upload_kbps                       client upload   (rx)
 * @property {?number} burst_download_kbps
 * @property {?number} burst_upload_kbps
 * @property {?number} burst_download_threshold_kbps     a RATE, not bytes
 * @property {?number} burst_upload_threshold_kbps       a RATE, not bytes
 * @property {?number} burst_download_seconds
 * @property {?number} burst_upload_seconds
 * @property {?number} min_download_kbps                 becomes limit-at
 * @property {?number} min_upload_kbps                   becomes limit-at
 * @property {?number} queue_priority                    1 (highest) .. 8 (lowest)
 * @property {?string} address_list_name                 Mikrotik-Address-List
 */

/**
 * Render the Mikrotik-Rate-Limit value for a rate profile.
 *
 * @param {RateProfile} p
 * @param {{strict?: boolean}} [opts] strict=true throws on an invalid profile
 *        instead of clamping. Use strict in tests, clamping in production.
 * @returns {{value: string, warnings: string[]}}
 */
export function renderRateLimit(p, opts = {}) {
  const warnings = [];
  const strict = opts.strict === true;

  const down = Number(p.download_kbps);
  const up = Number(p.upload_kbps);
  if (!Number.isFinite(down) || down <= 0) {
    const msg = `rate profile ${p.name}: download_kbps must be a positive number`;
    if (strict) throw new Error(msg);
    warnings.push(msg);
  }
  if (!Number.isFinite(up) || up <= 0) {
    const msg = `rate profile ${p.name}: upload_kbps must be a positive number`;
    if (strict) throw new Error(msg);
    warnings.push(msg);
  }
  if (down < up) {
    const msg = `rate profile ${p.name}: download (${down}k) is slower than upload (${up}k) — ` +
                `check the columns were not swapped when this row was written`;
    if (strict) throw new Error(msg);
    warnings.push(msg);
  }

  const rate = { rx: formatRate(up), tx: formatRate(down) }; // rx=upload, tx=download
  const parts = [pair(rate.rx, rate.tx)];

  const hasBurst = [
    p.burst_download_kbps, p.burst_upload_kbps,
    p.burst_download_threshold_kbps, p.burst_upload_threshold_kbps,
    p.burst_download_seconds, p.burst_upload_seconds,
  ].some((v) => v !== null && v !== undefined && Number(v) > 0);

  const priority = p.queue_priority === null || p.queue_priority === undefined
    ? null : Number(p.queue_priority);
  const hasPriority = Number.isInteger(priority) && priority >= 1 && priority <= 8;

  let minUp = p.min_upload_kbps === null || p.min_upload_kbps === undefined ? null : Number(p.min_upload_kbps);
  let minDown = p.min_download_kbps === null || p.min_download_kbps === undefined ? null : Number(p.min_download_kbps);
  // MikroTik: "The rx-rate-min and tx-rate-min values can not exceed rx-rate and
  // tx-rate values." Exceeding them makes the router reject the attribute.
  if (minUp !== null && minUp > up) {
    warnings.push(`rate profile ${p.name}: min_upload_kbps ${minUp} exceeds upload_kbps ${up}; clamped`);
    if (strict) throw new Error(`rate profile ${p.name}: min_upload_kbps exceeds upload_kbps`);
    minUp = up;
  }
  if (minDown !== null && minDown > down) {
    warnings.push(`rate profile ${p.name}: min_download_kbps ${minDown} exceeds download_kbps ${down}; clamped`);
    if (strict) throw new Error(`rate profile ${p.name}: min_download_kbps exceeds download_kbps`);
    minDown = down;
  }
  const hasMin = (minUp !== null && minUp > 0) || (minDown !== null && minDown > 0);

  if (hasBurst || hasPriority || hasMin) {
    // burst-rate
    const burstRx = formatRate(p.burst_upload_kbps) ?? rate.rx;
    const burstTx = formatRate(p.burst_download_kbps) ?? rate.tx;
    parts.push(pair(burstRx, burstTx));

    // burst-threshold — a RATE. Falls back to the rate, which MikroTik also does
    // by default, and which means "burst whenever you are below your ceiling".
    const thrRx = formatRate(p.burst_upload_threshold_kbps) ?? rate.rx;
    const thrTx = formatRate(p.burst_download_threshold_kbps) ?? rate.tx;
    parts.push(pair(thrRx, thrTx));

    // burst-time — MikroTik defaults to 1s when omitted.
    const timeRx = formatTime(p.burst_upload_seconds) ?? '1s';
    const timeTx = formatTime(p.burst_download_seconds) ?? '1s';
    parts.push(pair(timeRx, timeTx));
  }

  if (hasPriority || hasMin) {
    parts.push(String(priority ?? 8));
  }
  if (hasMin) {
    parts.push(pair(formatRate(minUp ?? up), formatRate(minDown ?? down)));
  }

  return { value: parts.join(' '), warnings };
}

/**
 * Always render "rx/tx", even when both halves are identical.
 *
 * MikroTik would accept a single value and reuse it for the other direction, so
 * "12s" and "12s/12s" are equivalent, and "8k" and "8k/8k" are too. We emit the
 * explicit form anyway. This is the one attribute in the whole system where
 * getting the two halves the wrong way round is invisible — nothing errors, the
 * customer just gets a slow upload forever — so a reader should never have to
 * remember which half was implied. Two extra characters buy that.
 */
function pair(a, b) {
  if (a === null || a === undefined) return b ?? '';
  if (b === null || b === undefined) return `${a}/${a}`;
  return `${a}/${b}`;
}

/**
 * Render the full set of RADIUS reply attributes for a subscription.
 * This is what the edge sync agent writes into radgroupreply / radreply.
 *
 * @param {RateProfile} profile
 * @param {object} sub   the v_radius_authorization row
 * @param {object} [cfg]
 * @returns {{attributes: Array<{attribute:string, op:string, value:string}>, warnings: string[]}}
 */
export function renderRadiusReply(profile, sub, cfg = {}) {
  const warnings = [];
  const { value, warnings: rlWarnings } = renderRateLimit(profile);
  warnings.push(...rlWarnings);

  /** @type {Array<{attribute:string, op:string, value:string}>} */
  const attributes = [
    { attribute: 'Mikrotik-Rate-Limit', op: ':=', value },
  ];

  if (sub.subscription_status === 'fup_throttled' && sub.fup_download_kbps) {
    // Fair-usage ceiling replaces the plan ceiling. Delivered as a separate
    // radusergroup membership at higher priority (see docs/02 §2.3), but the
    // attribute itself is rendered here so both paths agree.
    const fupProfile = {
      ...profile,
      name: `fup:${profile.name}`,
      download_kbps: sub.fup_download_kbps,
      upload_kbps: sub.fup_upload_kbps,
      burst_download_kbps: null, burst_upload_kbps: null,
      burst_download_threshold_kbps: null, burst_upload_threshold_kbps: null,
      burst_download_seconds: null, burst_upload_seconds: null,
      min_download_kbps: null, min_upload_kbps: null,
    };
    const fup = renderRateLimit(fupProfile);
    warnings.push(...fup.warnings);
    attributes[0] = { attribute: 'Mikrotik-Rate-Limit', op: ':=', value: fup.value };
  }

  // Expiry: MikroTik rejects the login outright once this date passes, which is
  // the backstop behind the CoA disconnect. Format is "dd mon yyyy".
  if (sub.expires_at) {
    attributes.push({
      attribute: 'Expiration', op: ':=', value: formatExpiration(sub.expires_at),
    });
  }

  // Simultaneous sessions. FreeRADIUS enforces this against open radacct rows.
  const simultaneous = Number(sub.simultaneous_use || 1);
  attributes.push({ attribute: 'Simultaneous-Use', op: ':=', value: String(simultaneous) });

  if (sub.idle_timeout_seconds) {
    attributes.push({ attribute: 'Idle-Timeout', op: ':=', value: String(Math.round(sub.idle_timeout_seconds)) });
  }
  if (sub.session_timeout_seconds) {
    attributes.push({ attribute: 'Session-Timeout', op: ':=', value: String(Math.round(sub.session_timeout_seconds)) });
  }

  // Address list membership for the session (removed automatically on logout).
  // This is the hook for optional per-plan PCQ classes and plan-scoped firewall
  // rules. There is NO RADIUS attribute that names a parent queue — a common
  // misconception — which is why the schema column is address_list_name.
  if (profile.address_list_name) {
    attributes.push({ attribute: 'Mikrotik-Address-List', op: ':=', value: profile.address_list_name });
  }

  // Interim accounting interval. Kept server-side so it can be tuned without
  // touching the router (settings.radius.interim_update_seconds).
  const interim = Number(cfg.interim_update_seconds || 300);
  if (interim > 0) {
    attributes.push({ attribute: 'Acct-Interim-Interval', op: ':=', value: String(interim) });
  }

  // Mikrotik-Total-Limit is deliberately NOT emitted. It caps bytes per SESSION,
  // and our caps are per SUBSCRIPTION. Emitting it would reset a customer's
  // allowance every time they reconnect, which silently gives away unlimited
  // data on a capped plan.
  return { attributes, warnings };
}

/** MikroTik's Expiration attribute wants "dd mon yyyy", e.g. "15 Dec 2026". */
export function formatExpiration(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`formatExpiration: invalid date ${iso}`);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${dd} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Render a rate profile as a MikroTik hotspot user-profile rate-limit string.
 * Used for the local fallback profiles (staff, suspended) that are not driven by
 * RADIUS, and for `/ip hotspot user profile` rows.
 */
export function renderUserProfileRateLimit(profile) {
  return renderRateLimit(profile).value;
}

/**
 * Bytes -> the "250 GB" style string used in portal copy and SMS. Separate from
 * the SQL app_format_bytes() so both sides agree.
 */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 MB';
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${Math.round(v / 1024)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(v < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(v / 1024 ** 3).toFixed(v < 10 * 1024 ** 3 ? 1 : 0)} GB`;
}
