/**
 * RokuDevClient - Roku developer application installer client (port 80).
 *
 * This is a DIFFERENT surface from RokuClient.js (ECP, port 8060, no auth):
 * the dev installer at http://<ip>/plugin_install and /plugin_inspect speaks
 * multipart/form-data over HTTP Digest auth (RFC 2617, MD5). Node's global
 * fetch has no digest support and nothing digest-capable exists in the repo,
 * so the digest handshake is hand-rolled with the built-in `crypto` module.
 *
 * Mirrors waiveo-roku-player/scripts/deploy.sh:
 *   Delete: curl --user U:P --digest -F mysubmit=Delete  -F archive=
 *   Install: curl --user U:P --digest -F mysubmit=Install -F archive=@zip
 * Success/failure is scraped from the HTML body ("Install Success" /
 * "Install Failure"), never a status code (Roku returns 200 either way).
 *
 * The digest computation, multipart builder, challenge parser and result
 * scraper are exported as PURE functions so they are offline-unit-testable
 * against RFC 2617 vectors with fixed cnonce/nc. The instance methods do the
 * 401 -> nonce -> retry dance, replaying the SAME multipart Buffer on both
 * requests (a consumed stream cannot be re-sent after the 401).
 */

import crypto from 'node:crypto';

/** Default Roku developer username (deploy.sh ROKU_USER default). */
export const ROKU_DEV_USER = 'rokudev';
/** The dev installer listens on plain HTTP port 80, not the ECP 8060 port. */
export const ROKU_DEV_PORT = 80;

/** MD5 hex digest helper (Digest auth is MD5-based per RFC 2617). */
export function md5(input) {
  return crypto.createHash('md5').update(input).digest('hex');
}

/**
 * Build an RFC 2617 Digest `Authorization` header value.
 *
 * Pure: given the challenge fields + a fixed cnonce/nc it is deterministic,
 * so it can be asserted against the RFC 2617 canonical vector.
 *
 * @param {object} p
 * @param {string} p.user     username
 * @param {string} p.realm    realm from the WWW-Authenticate challenge
 * @param {string} p.password shared secret
 * @param {string} p.method   HTTP method (e.g. 'POST')
 * @param {string} p.uri      request-uri (e.g. '/plugin_install')
 * @param {string} p.nonce    server nonce
 * @param {string} [p.qop]    quality of protection ('auth') if offered
 * @param {string} [p.nc]     nonce count (hex, 8 digits) when qop present
 * @param {string} [p.cnonce] client nonce when qop present
 * @param {string} [p.opaque] opaque value to echo back
 * @returns {string} the full `Digest ...` header value
 */
export function buildDigestAuthHeader({
  user, realm, password, method, uri, nonce, qop, nc, cnonce, opaque,
}) {
  const ha1 = md5(`${user}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${user}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    'algorithm=MD5',
    `response="${response}"`,
  ];
  if (qop) {
    parts.push(`qop=${qop}`);
    parts.push(`nc=${nc}`);
    parts.push(`cnonce="${cnonce}"`);
  }
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

/**
 * Parse a `WWW-Authenticate: Digest ...` challenge into its fields.
 * Pure. Returns lower-cased keys ({ realm, nonce, qop, opaque, ... }).
 */
export function parseDigestChallenge(header) {
  const raw = String(header || '').replace(/^\s*Digest\s+/i, '');
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
  let m = re.exec(raw);
  while (m !== null) {
    out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] || '');
    m = re.exec(raw);
  }
  return out;
}

/**
 * Pick the qop token to use. Roku advertises `qop="auth"`; some servers offer
 * `auth,auth-int` — prefer plain `auth`, else undefined (RFC 2069 fallback).
 */
export function selectQop(qopValue) {
  if (!qopValue) return undefined;
  const tokens = String(qopValue).split(',').map((s) => s.trim().toLowerCase());
  if (tokens.includes('auth')) return 'auth';
  return undefined;
}

/**
 * Build a multipart/form-data body as a single Buffer plus its Content-Type.
 *
 * @param {Array<{name:string,value:(string|Buffer),filename?:string,contentType?:string}>} fields
 * @param {string} [boundary] override for deterministic tests
 * @returns {{buffer: Buffer, contentType: string, boundary: string}}
 *
 * A file part (with `filename`) mirrors `-F archive=@zip`; a plain part
 * mirrors `-F mysubmit=Install`. An empty value with no filename mirrors the
 * Delete step's `-F archive=` (empty field, NOT omitted).
 */
export function buildMultipartBody(fields, boundary) {
  const CRLF = '\r\n';
  const bnd = boundary || `----WaiveoRokuBoundary${crypto.randomBytes(16).toString('hex')}`;
  const chunks = [];
  for (const f of fields) {
    let head = `--${bnd}${CRLF}Content-Disposition: form-data; name="${f.name}"`;
    if (f.filename !== undefined && f.filename !== null) {
      head += `; filename="${f.filename}"`;
    }
    head += CRLF;
    if (f.contentType) head += `Content-Type: ${f.contentType}${CRLF}`;
    head += CRLF;
    chunks.push(Buffer.from(head, 'utf8'));
    const val = f.value == null ? '' : f.value;
    chunks.push(Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf8'));
    chunks.push(Buffer.from(CRLF, 'utf8'));
  }
  chunks.push(Buffer.from(`--${bnd}--${CRLF}`, 'utf8'));
  return {
    buffer: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${bnd}`,
    boundary: bnd,
  };
}

/**
 * Scrape the plugin_install HTML response.
 * Pure. Roku returns HTTP 200 for both outcomes; the only signal is the body.
 *   "Install Success"       -> { success:true,  status:'success' }
 *   "Install Failure: <msg>"-> { success:false, status:'failure', message }
 *   neither                 -> { success:false, status:'unknown' }
 */
export function parseInstallResult(html) {
  const text = String(html == null ? '' : html);
  if (text.includes('Install Success')) {
    return { success: true, status: 'success', message: 'Install Success' };
  }
  const failMatch = text.match(/Install Failure[^<]*/);
  if (failMatch) {
    return { success: false, status: 'failure', message: failMatch[0].trim() };
  }
  return { success: false, status: 'unknown', message: 'unknown' };
}

/**
 * Client for the Roku dev installer (port 80, Digest + multipart).
 *
 * The dev password is read via an injected async `passwordResolver` rather
 * than from ctx directly, so the class is testable offline. fetch and the
 * cnonce generator are also injectable for deterministic unit tests.
 */
export class RokuDevClient {
  constructor(ip, opts = {}) {
    this.ip = ip;
    this.port = opts.port || ROKU_DEV_PORT;
    this.user = opts.user || ROKU_DEV_USER;
    this.baseUrl = `http://${ip}${this.port === 80 ? '' : `:${this.port}`}`;
    this.timeout = opts.timeout || 60000;
    this._passwordResolver = opts.passwordResolver || (async () => null);
    this._fetch = opts.fetchImpl || ((url, init) => globalThis.fetch(url, init));
    this._cnonce = opts.cnonceFn || (() => crypto.randomBytes(8).toString('hex'));
  }

  async _resolvePassword() {
    const pw = await this._passwordResolver();
    if (pw == null || pw === '') {
      const err = new Error('No Roku dev password configured');
      err.code = 'NO_PASSWORD';
      err.status = 400;
      throw err;
    }
    return pw;
  }

  /**
   * fetch bounded by this.timeout via AbortController. A wedged Roku on :80
   * must not hold the per-device lock indefinitely (spec guardrail: fleet ops
   * must not stall) — the caller's catch maps the abort to UNREACHABLE/502.
   */
  async _timedFetch(url, init) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeout);
    try {
      return await this._fetch(url, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * POST a pre-built multipart Buffer to `uri` using the 401->digest->retry
   * dance. The SAME `bodyBuffer` reference is sent on both requests.
   * Returns the (authenticated) response body text.
   */
  async _digestPost(uri, bodyBuffer, contentType) {
    const url = `${this.baseUrl}${uri}`;
    const baseHeaders = {
      'Content-Type': contentType,
      'Content-Length': String(bodyBuffer.length),
      'User-Agent': 'Waiveo-Roku-Dev/1.0',
    };

    let res1;
    try {
      res1 = await this._timedFetch(url, { method: 'POST', headers: baseHeaders, body: bodyBuffer });
    } catch (e) {
      const err = new Error(`Roku dev installer unreachable at ${url}: ${e.message}`);
      err.code = 'UNREACHABLE';
      err.status = 502;
      throw err;
    }

    // Roku may (rarely) not challenge; if it already answered, use it.
    if (res1.status !== 401) {
      return res1.text();
    }

    const challenge = parseDigestChallenge(res1.headers.get('www-authenticate'));
    if (!challenge.nonce) {
      const err = new Error('Roku dev installer did not present a Digest challenge');
      err.code = 'NO_CHALLENGE';
      err.status = 502;
      throw err;
    }

    const password = await this._resolvePassword();
    const authHeader = buildDigestAuthHeader({
      user: this.user,
      realm: challenge.realm,
      password,
      method: 'POST',
      uri,
      nonce: challenge.nonce,
      qop: selectQop(challenge.qop),
      nc: '00000001',
      cnonce: this._cnonce(),
      opaque: challenge.opaque,
    });

    let res2;
    try {
      res2 = await this._timedFetch(url, {
        method: 'POST',
        headers: { ...baseHeaders, Authorization: authHeader },
        body: bodyBuffer, // SAME Buffer replayed
      });
    } catch (e) {
      const err = new Error(`Roku dev installer unreachable at ${url}: ${e.message}`);
      err.code = 'UNREACHABLE';
      err.status = 502;
      throw err;
    }

    if (res2.status === 401) {
      const err = new Error('Roku dev password rejected');
      err.code = 'DIGEST_REJECTED';
      err.status = 502;
      throw err;
    }
    return res2.text();
  }

  /**
   * Install a sideload zip: mysubmit=Install + archive=@zip.
   * Returns parseInstallResult() of the response HTML.
   */
  async install(zipBuffer, { filename = 'waiveo-roku.zip' } = {}) {
    const { buffer, contentType } = buildMultipartBody([
      { name: 'mysubmit', value: 'Install' },
      {
        name: 'archive', value: zipBuffer, filename, contentType: 'application/zip',
      },
    ]);
    const html = await this._digestPost('/plugin_install', buffer, contentType);
    return parseInstallResult(html);
  }

  /**
   * Delete the installed dev channel: mysubmit=Delete + archive= (empty).
   * Best-effort per deploy.sh (errors are swallowed into the result object)
   * so a wedged/absent channel does not abort a reset.
   */
  async delete() {
    const { buffer, contentType } = buildMultipartBody([
      { name: 'mysubmit', value: 'Delete' },
      { name: 'archive', value: '' },
    ]);
    try {
      const html = await this._digestPost('/plugin_install', buffer, contentType);
      return parseInstallResult(html);
    } catch (e) {
      return {
        success: false, status: 'error', message: e.message, ignored: true,
      };
    }
  }

  /**
   * Inspect the installed dev channel: mysubmit=Inspect + archive= (empty).
   * Returns the raw HTML (a fallback version source; ECP getApps id='dev' is
   * the primary, auth-free version path).
   */
  async inspect() {
    const { buffer, contentType } = buildMultipartBody([
      { name: 'mysubmit', value: 'Inspect' },
      { name: 'archive', value: '' },
    ]);
    const html = await this._digestPost('/plugin_inspect', buffer, contentType);
    return { html };
  }
}

export default RokuDevClient;
