/**
 * Renders the hotspot HTML pages that live ON THE ROUTER.
 *
 * Why the router hosts pages at all, when we have a cloud portal
 * --------------------------------------------------------------
 * Three jobs only the router can do:
 *
 *   1. `login.html` is what the captive-portal interception actually serves. The
 *      phone's probe gets a 302 here. It has to work with zero connectivity.
 *   2. `activate.html` completes the mixed-content handshake. An https: portal
 *      cannot POST to http://192.168.89.1/login, but a top-level 302 from https:
 *      to http: IS allowed. So the portal redirects here with a one-time token,
 *      this page collects credentials from the edge node over the LAN, and then
 *      submits a SAME-ORIGIN POST to the hotspot. That last step has to happen
 *      on the router's own origin or the browser blocks it.
 *   3. `error.html` / `status.html` are the only pages reachable when a customer
 *      is out of credit and everything else is blocked.
 *
 * Constraints honoured here
 * -------------------------
 *   * Small. Every byte is fetched over an unencrypted, possibly congested
 *     hotspot link. Inline CSS, no framework, no external font, no CDN. A CDN
 *     dependency inside a walled garden means the login page depends on a third
 *     party we cannot allowlist reliably.
 *   * Works with JavaScript disabled for the paths that matter. The voucher form
 *      is a plain POST. (CHAP does need JS; with JS off the router falls back to
 *      the portal link, which is why the portal is the primary call to action.)
 *   * `md5.js` comes from the STOCK hotspot directory. We override individual
 *     pages in `hotspot/` rather than pointing at a fresh directory precisely so
 *     that md5.js and the other files the hotspot expects are still there. A
 *     missing md5.js breaks http-chap with no error message anywhere.
 *   * Every MikroTik template variable is written `$(name)`, which is safe inside
 *     JS template literals (only `${` would interpolate).
 */

import { rscQuote } from './walled-garden.mjs';

const s = (settings, key, fallback) => {
  const v = settings[key];
  return v === undefined || v === null ? fallback : String(v);
};

/**
 * @param {object} seed  output of loadSeed()
 * @param {object} [opts]
 * @returns {{files: Array<{name: string, body: string}>, warnings: string[]}}
 */
export function renderHotspotFiles(seed, opts = {}) {
  const st = seed.settings;
  const warnings = [];

  const brand = s(st, 'branding.business_name', 'Wavly WiFi');
  const portalUrl = s(st, 'branding.portal_url', 'https://portal.wavlywifi.com').replace(/\/$/, '');
  const supportPhone = s(st, 'branding.support_phone_e164', '');
  const edgeAddress = s(st, 'network.edge_node_address', '192.168.88.10');
  const edgePort = Number(s(st, 'network.edge_activate_port', '8787'));
  const siteName = seed.sites[0]?.name || '';
  const activateTtl = Number(s(st, 'activation.token_ttl_seconds', '60'));

  if (!/^https:\/\//i.test(portalUrl)) {
    warnings.push(`branding.portal_url is not HTTPS (${portalUrl}); activate.html will be blocked as mixed content.`);
  }

  /** Shared page chrome. Inline so there is exactly one request. */
  const css = renderCss();

  const page = ({ title, body, script = '', extraHead = '' }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${css}</style>
${extraHead}</head>
<body>
<main class="card">
  <header class="brand">
    <span class="logo" aria-hidden="true">W</span>
    <div>
      <h1>${esc(brand)}</h1>
      ${siteName ? `<p class="sub">${esc(siteName)}</p>` : ''}
    </div>
  </header>
${body}
  <footer>
    ${supportPhone ? `<p>Help: <a href="tel:${esc(supportPhone)}">${esc(supportPhone)}</a></p>` : ''}
    <p class="fine">By connecting you agree to our <a href="${esc(portalUrl)}/privacy">privacy notice</a>.</p>
  </footer>
</main>
${script ? `<script>${script}</script>` : ''}
</body>
</html>
`;

  // ------------------------------------------------------------------ login.html
  // This is the page the captive-portal interception serves. It must present the
  // cloud portal as the primary path AND a voucher form that works with no
  // internet at all, because vouchers are the business-continuity path: they can
  // be sold for cash while Starlink is down.
  const loginHtml = page({
    title: `${brand} — Get online`,
    extraHead: `<script src="/md5.js"></script>`,
    body: `
  <p class="lede">Get online in about a minute. Pay with MTN, Telecel or AirtelTigo MoMo.</p>

  <a class="btn btn-primary" href="${esc(portalUrl)}/?src=hotspot&amp;mac=$(mac)">Get online — see plans</a>

  <details class="voucher">
    <summary>I have a voucher code</summary>
    <form name="sendForm" method="post" action="$(link-login-only)" onsubmit="return doLogin()">
      <input type="hidden" name="dst" value="$(link-orig-esc)">
      <input type="hidden" name="popup" value="true">
      $(if chap-id)
      <input type="hidden" name="chap-id" value="$(chap-id)">
      <input type="hidden" name="chap-challenge" value="$(chap-challenge)">
      $(endif)
      <label for="vc">Voucher code</label>
      <input id="vc" type="text" name="username" autocapitalize="characters" autocomplete="off"
             spellcheck="false" inputmode="text" required placeholder="e.g. 7QK4M-2XZ9R">
      <label for="vp">Code again, or leave blank</label>
      <input id="vp" type="password" name="password" autocomplete="off">
      <button class="btn" type="submit">Connect</button>
    </form>
    <p class="fine">Vouchers work even when the satellite link is down.</p>
  </details>

  $(if error)
  <p class="err" role="alert"><strong>$(error)</strong></p>
  <p class="fine">If you have already paid, wait a moment and try again — activation can take a
  few seconds to reach the router.</p>
  $(endif)

  <div class="offline">
    <p class="fine">If the button above does not load, our internet link is down. Your existing
    session will keep working; a voucher code will too. Nothing is charged while we are offline.</p>
  </div>`,
    script: `
// http-chap: never send the code in plaintext over an unencrypted hotspot.
// hexMD5 comes from the stock /md5.js. Without JS the form still posts, and the
// router will reject it only if http-pap is disabled — which it is, deliberately.
function doLogin() {
  var f = document.sendForm;
  if (!f.password.value) { f.password.value = f.username.value; }
  $(if chap-id)
  var chapId = '$(chap-id)';
  var chapChallenge = '$(chap-challenge)';
  if (window.hexMD5) {
    f.password.value = hexMD5(chapId + f.password.value + chapChallenge);
  } else {
    // md5.js missing would silently send plaintext; fail visibly instead.
    alert('This page is missing a required file. Please tell the operator: md5.js');
    return false;
  }
  $(endif)
  return true;
}`,
  });

  // -------------------------------------------------------------- activate.html
  // The mixed-content handshake. Loaded over plain HTTP from the router's own
  // origin, so the final POST to /login is same-origin and cannot be blocked.
  const activateHtml = page({
    title: `${brand} — Activating`,
    extraHead: `<script src="/md5.js"></script>`,
    body: `
  <p class="lede" id="msg">Activating your connection…</p>
  <div class="spinner" id="spin" role="status" aria-live="polite"></div>
  <noscript><p class="err">This step needs JavaScript. Please go back and use a
  voucher code instead, or enable JavaScript and try again.</p></noscript>
  <div id="fail" hidden>
    <p class="err" role="alert"><strong id="failMsg">Activation failed.</strong></p>
    <a class="btn btn-primary" href="${esc(portalUrl)}/account">Back to my account</a>
    <p class="fine">You have NOT been charged twice. If this keeps failing, send the code
    shown to <a href="tel:${esc(supportPhone)}">${esc(supportPhone)}</a>.</p>
  </div>

  <!-- Hidden form posts to the hotspot on OUR OWN origin. The browser allows a
       top-level redirect from https: to http:, but it will not let an https: page
       POST to http:. That asymmetry is the whole reason this page exists. -->
  <form name="sendForm" method="post" action="$(link-login-only)" hidden>
    <input type="hidden" name="dst" value="$(link-orig-esc)">
    <input type="hidden" name="popup" value="false">
    $(if chap-id)
    <input type="hidden" name="chap-id" value="$(chap-id)">
    <input type="hidden" name="chap-challenge" value="$(chap-challenge)">
    $(endif)
    <input type="hidden" name="username" value="">
    <input type="hidden" name="password" value="">
  </form>`,
    script: `
(function () {
  var EDGE = 'http://${edgeAddress}:${edgePort}/activate';
  var TTL_SECONDS = ${activateTtl};
  var params = new URLSearchParams(location.search);
  var token = params.get('token');
  var mac = '$(mac)';
  var msg = document.getElementById('msg');
  var fail = document.getElementById('fail');
  var failMsg = document.getElementById('failMsg');
  var spin = document.getElementById('spin');

  function die(reason, code) {
    spin.hidden = true;
    fail.hidden = false;
    failMsg.textContent = reason;
    msg.hidden = true;
    // A short, copyable code beats a paragraph a customer has to read aloud.
    if (code) { failMsg.textContent += ' (' + code + ')'; }
  }

  if (!token) {
    die('This activation link is incomplete. Please start again from your account page.', 'NO_TOKEN');
    return;
  }

  msg.textContent = 'Activating your connection…';

  // The token is one-time, MAC-bound and short-lived (see edge table
  // activation_tokens, purged after 5 minutes). It is NOT a payment secret: it
  // only proves the portal already authorised this device.
  fetch(EDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token, mac: mac }),
    // Abort rather than hang: a customer staring at a spinner is worse than one
    // reading an error, and the satellite link is the slow part, not the LAN.
    signal: AbortSignal.timeout((TTL_SECONDS + 5) * 1000)
  }).then(function (r) {
    if (!r.ok) { return r.json().catch(function(){return {};}).then(function (b) { throw Object.assign(new Error(b.error || 'rejected'), { code: b.code || ('HTTP_' + r.status) }); }); }
    return r.json();
  }).then(function (creds) {
    if (!creds || !creds.username || !creds.password) {
      die('The activation service sent an incomplete response. Please try again.', 'BAD_PAYLOAD');
      return;
    }
    var f = document.sendForm;
    f.username.value = creds.username;
    f.password.value = creds.password;
    $(if chap-id)
    var chapId = '$(chap-id)';
    var chapChallenge = '$(chap-challenge)';
    if (window.hexMD5) {
      f.password.value = hexMD5(chapId + creds.password + chapChallenge);
    } else {
      die('This page is missing a required file (md5.js). Please tell the operator.', 'NO_MD5');
      return;
    }
    $(endif)
    msg.textContent = 'Connecting you now…';
    // Same-origin POST. This is the step that could not happen from the cloud.
    f.submit();
  }).catch(function (e) {
    var code = e.code || (e.name === 'TimeoutError' || e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    if (code === 'NETWORK' || code === 'TIMEOUT') {
      die('We could not reach the activation service on the local network. Your payment is safe — please try again in a minute.', code);
    } else {
      die(e.message || 'Activation failed.', code);
    }
  });
})();`,
  });

  // ---------------------------------------------------------------- alogin.html
  const aloginHtml = page({
    title: `${brand} — You are online`,
    body: `
  <p class="lede ok">You are online.</p>
  <a class="btn btn-primary" href="${esc(portalUrl)}/account">See my data, expiry and renew</a>
  <p class="fine">Keep this page open or bookmark it. It is how you check what is left
  and top up before you run out.</p>
  <p class="fine">Tip: turn OFF "private Wi-Fi address" for this network in your phone's
  settings, or you may have to log in again on every reconnect.</p>`,
    script: `
// The stock behaviour is to close the popup and resume the original request.
// $(if link-redirect) is a MikroTik conditional, not JavaScript.
$(if link-redirect)
setTimeout(function () { location.href = '$(link-redirect-esc)'; }, 1200);
$(endif)`,
  });

  // ----------------------------------------------------------------- error.html
  const errorHtml = page({
    title: `${brand} — Problem connecting`,
    body: `
  <p class="lede err">$(if error)$(error)$(else)We could not connect you.$(endif)</p>
  <p class="fine">The usual causes: your plan has expired or run out of data, the code was
  typed incorrectly, or another device is already using your account.</p>
  <a class="btn btn-primary" href="${esc(portalUrl)}/account">Renew or check my account</a>
  <a class="btn" href="$(link-login)">Try again</a>
  <p class="fine">You are never billed while you are offline. If you paid in the last hour
  and still cannot connect, call <a href="tel:${esc(supportPhone)}">${esc(supportPhone)}</a>.</p>`,
  });

  // ---------------------------------------------------------------- status.html
  const statusHtml = page({
    title: `${brand} — Connection status`,
    body: `
  <p class="lede">Connected as <strong>$(username)</strong></p>
  <dl class="stat">
    <dt>Online for</dt><dd>$(uptime)</dd>
    <dt>Downloaded</dt><dd>$(bytes-in-nice)</dd>
    <dt>Uploaded</dt><dd>$(bytes-out-nice)</dd>
    <dt>Time left this session</dt><dd>$(session-time-left)</dd>
    <dt>Your address</dt><dd>$(ip) · $(mac)</dd>
  </dl>
  <p class="fine">These are per-session figures. Your plan's total allowance and expiry date
  are on your account page.</p>
  <a class="btn btn-primary" href="${esc(portalUrl)}/account">My account</a>
  <form method="get" action="$(link-logout)"><button class="btn" type="submit">Log out</button></form>`,
  });

  return {
    warnings,
    files: [
      { name: 'login.html', body: loginHtml, purpose: 'served by captive-portal interception; portal link + offline voucher form' },
      { name: 'activate.html', body: activateHtml, purpose: 'mixed-content handshake: token -> edge node -> same-origin CHAP POST' },
      { name: 'alogin.html', body: aloginHtml, purpose: 'shown immediately after a successful login' },
      { name: 'error.html', body: errorHtml, purpose: 'failed/expired login, with a renew call to action' },
      { name: 'status.html', body: statusHtml, purpose: 'per-session counters for the connected customer' },
    ],
  };
}

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Minimal, self-hosted CSS. Dark-mode aware, large touch targets, no web font:
 * a font request to a CDN from inside a walled garden is a login page that
 * depends on a third party we cannot reliably allowlist.
 */
function renderCss() {
  return `
:root{--bg:#0f172a;--fg:#f8fafc;--mut:#94a3b8;--acc:#22c55e;--err:#f87171;--card:#1e293b;--line:#334155}
@media (prefers-color-scheme:light){:root{--bg:#f1f5f9;--fg:#0f172a;--mut:#475569;--card:#fff;--line:#e2e8f0}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
 font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
 -webkit-text-size-adjust:100%}
.card{max-width:26rem;margin:0 auto;padding:1.25rem 1.1rem calc(1.25rem + env(safe-area-inset-bottom))}
.brand{display:flex;align-items:center;gap:.7rem;margin-bottom:1rem}
.logo{display:grid;place-items:center;width:2.4rem;height:2.4rem;border-radius:.6rem;
 background:var(--acc);color:#052e16;font-weight:800;font-size:1.2rem;flex:none}
h1{margin:0;font-size:1.15rem;line-height:1.2}
.sub{margin:.1rem 0 0;color:var(--mut);font-size:.8rem}
.lede{margin:.2rem 0 1rem}
.lede.ok{color:var(--acc);font-weight:600}
.err{color:var(--err)}
.btn{display:block;width:100%;margin:.5rem 0;padding:.85rem 1rem;border:1px solid var(--line);
 border-radius:.65rem;background:var(--card);color:var(--fg);font:inherit;font-weight:600;
 text-align:center;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent}
.btn:active{transform:translateY(1px)}
.btn-primary{background:var(--acc);border-color:var(--acc);color:#052e16}
label{display:block;margin:.8rem 0 .25rem;font-size:.85rem;color:var(--mut)}
input{width:100%;padding:.8rem;border:1px solid var(--line);border-radius:.6rem;
 background:var(--bg);color:var(--fg);font:inherit}
input:focus{outline:2px solid var(--acc);outline-offset:1px}
.voucher{margin-top:1.25rem;border-top:1px solid var(--line);padding-top:.75rem}
.voucher summary{cursor:pointer;font-weight:600;padding:.5rem 0;color:var(--mut)}
.stat{display:grid;grid-template-columns:auto 1fr;gap:.4rem .8rem;margin:0 0 1rem;font-size:.9rem}
.stat dt{color:var(--mut)}
.stat dd{margin:0;font-variant-numeric:tabular-nums;text-align:right}
.fine{color:var(--mut);font-size:.78rem;margin:.6rem 0}
footer{margin-top:1.5rem;border-top:1px solid var(--line);padding-top:.75rem}
footer a{color:var(--fg)}
.spinner{width:1.5rem;height:1.5rem;margin:1rem auto;border-radius:50%;
 border:3px solid var(--line);border-top-color:var(--acc);animation:sp .8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.offline{margin-top:1rem}
`.replace(/\n\s*/g, '');
}
