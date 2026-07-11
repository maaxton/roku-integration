import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
// Bare specifier resolved to extensions/roku-integration/ by vitest.config.js
// resolve.alias (import/no-relative-packages forbids relative cross-package
// imports from backend/test — the established convention; see vitest.config.js).
import {
  buildDigestAuthHeader,
  parseDigestChallenge,
  selectQop,
  buildMultipartBody,
  parseInstallResult,
  md5,
  RokuDevClient,
} from 'roku-integration/RokuDevClient.js';

// Minimal fetch Response stand-in.
function makeResponse({ status = 200, wwwAuthenticate = null, body = '' }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'www-authenticate') return wwwAuthenticate;
        return null;
      },
    },
    async text() { return body; },
  };
}

describe('buildDigestAuthHeader', () => {
  it('matches the RFC 2617 §3.5 canonical vector', () => {
    // The published RFC 2617 example. response MUST be the documented constant.
    const header = buildDigestAuthHeader({
      user: 'Mufasa',
      realm: 'testrealm@host.com',
      password: 'Circle Of Life',
      method: 'GET',
      uri: '/dir/index.html',
      nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      qop: 'auth',
      nc: '00000001',
      cnonce: '0a4f113b',
      opaque: '5ccc069c403ebaf9f0171e9517f40e41',
    });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('qop=auth');
    expect(header).toContain('nc=00000001');
    expect(header).toContain('cnonce="0a4f113b"');
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it('computes a Roku-shaped vector (realm=rokudev, qop=auth) deterministically', () => {
    const header = buildDigestAuthHeader({
      user: 'rokudev',
      realm: 'rokudev',
      password: 'abcd',
      method: 'POST',
      uri: '/plugin_install',
      nonce: 'nonce123',
      qop: 'auth',
      nc: '00000001',
      cnonce: 'cafebabe',
    });
    // Independently recomputed with crypto below (not via the impl).
    const ha1 = md5('rokudev:rokudev:abcd');
    const ha2 = md5('POST:/plugin_install');
    const expected = md5(`${ha1}:nonce123:00000001:cafebabe:auth:${ha2}`);
    expect(expected).toBe('f2fc6497dc2a07801ee11cdcca15e30b');
    expect(header).toContain(`response="${expected}"`);
    expect(header).toContain('username="rokudev"');
    expect(header).toContain('uri="/plugin_install"');
    expect(header).not.toContain('abcd'); // password never leaks into the header
  });

  it('omits qop/nc/cnonce for an RFC 2069 (no-qop) challenge', () => {
    const header = buildDigestAuthHeader({
      user: 'u', realm: 'r', password: 'p', method: 'POST', uri: '/x', nonce: 'n',
    });
    const expected = md5(`${md5('u:r:p')}:n:${md5('POST:/x')}`);
    expect(header).toContain(`response="${expected}"`);
    expect(header).not.toContain('qop=');
    expect(header).not.toContain('nc=');
  });
});

describe('parseDigestChallenge + selectQop', () => {
  it('parses a Roku-style WWW-Authenticate header', () => {
    const c = parseDigestChallenge('Digest realm="rokudev", nonce="ABC123", qop="auth", opaque="zz"');
    expect(c.realm).toBe('rokudev');
    expect(c.nonce).toBe('ABC123');
    expect(c.qop).toBe('auth');
    expect(c.opaque).toBe('zz');
  });

  it('selectQop prefers auth from auth,auth-int and drops unknowns', () => {
    expect(selectQop('auth')).toBe('auth');
    expect(selectQop('auth,auth-int')).toBe('auth');
    expect(selectQop('auth-int')).toBeUndefined();
    expect(selectQop('')).toBeUndefined();
    expect(selectQop(undefined)).toBeUndefined();
  });
});

describe('buildMultipartBody', () => {
  it('builds the Install form with a boundary, dispositions, filename and raw bytes', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]); // PK.. + a non-utf8 byte
    const { buffer, contentType, boundary } = buildMultipartBody([
      { name: 'mysubmit', value: 'Install' },
      {
        name: 'archive', value: zip, filename: 'waiveo-roku.zip', contentType: 'application/zip',
      },
    ]);
    expect(contentType).toBe(`multipart/form-data; boundary=${boundary}`);
    const text = buffer.toString('latin1');
    expect(text).toContain(`--${boundary}\r\n`);
    expect(text).toContain('Content-Disposition: form-data; name="mysubmit"');
    expect(text).toContain('Install');
    expect(text).toContain('Content-Disposition: form-data; name="archive"; filename="waiveo-roku.zip"');
    expect(text).toContain('Content-Type: application/zip');
    expect(text).toContain(`--${boundary}--\r\n`);
    // The raw (non-utf8) zip bytes survive intact inside the body.
    expect(buffer.includes(zip)).toBe(true);
  });

  it('builds the Delete form with an EMPTY archive field (present, no filename)', () => {
    const { buffer } = buildMultipartBody([
      { name: 'mysubmit', value: 'Delete' },
      { name: 'archive', value: '' },
    ], 'BND');
    const text = buffer.toString('utf8');
    expect(text).toContain('name="mysubmit"');
    expect(text).toContain('Delete');
    expect(text).toContain('Content-Disposition: form-data; name="archive"\r\n');
    expect(text).not.toContain('filename='); // empty field is not a file part
  });
});

describe('parseInstallResult', () => {
  it('maps Install Success -> success', () => {
    expect(parseInstallResult('<html>Install Success</html>')).toEqual({
      success: true, status: 'success', message: 'Install Success',
    });
  });
  it('maps Install Failure: X -> failure with message', () => {
    const r = parseInstallResult('<div>Install Failure: Package upload failed.</div>');
    expect(r.success).toBe(false);
    expect(r.status).toBe('failure');
    expect(r.message).toBe('Install Failure: Package upload failed.');
  });
  it('maps neither -> unknown', () => {
    const r = parseInstallResult('<html>Roku Development Kit</html>');
    expect(r).toEqual({ success: false, status: 'unknown', message: 'unknown' });
  });
  it('tolerates null/empty', () => {
    expect(parseInstallResult(null).status).toBe('unknown');
    expect(parseInstallResult('').status).toBe('unknown');
  });
});

describe('RokuDevClient.install (401 -> digest -> retry)', () => {
  it('replays the SAME multipart Buffer and sends a correct digest on retry', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return makeResponse({
          status: 401,
          wwwAuthenticate: 'Digest realm="rokudev", nonce="nonce123", qop="auth"',
        });
      }
      return makeResponse({ status: 200, body: '<html>Install Success</html>' });
    };

    const client = new RokuDevClient('10.0.0.9', {
      passwordResolver: async () => 'abcd',
      fetchImpl,
      cnonceFn: () => 'cafebabe',
    });

    const zip = crypto.randomBytes(64);
    const result = await client.install(zip);

    expect(result).toEqual({ success: true, status: 'success', message: 'Install Success' });
    expect(calls).toHaveLength(2);

    // Replay trap: the exact SAME Buffer object is sent on both requests.
    expect(calls[0].init.body).toBe(calls[1].init.body);
    expect(Buffer.isBuffer(calls[0].init.body)).toBe(true);

    // First request carries no auth; second carries the computed digest.
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    const auth = calls[1].init.headers.Authorization;
    expect(auth).toContain('response="f2fc6497dc2a07801ee11cdcca15e30b"');
    expect(auth).toContain('nonce="nonce123"');
    expect(auth).toContain('cnonce="cafebabe"');
    expect(auth).toContain('nc=00000001');
    // Correct port-80 target.
    expect(calls[0].url).toBe('http://10.0.0.9/plugin_install');
  });

  it('surfaces a rejected password loudly (401 after retry -> DIGEST_REJECTED 502)', async () => {
    const fetchImpl = async () => makeResponse({
      status: 401,
      wwwAuthenticate: 'Digest realm="rokudev", nonce="n", qop="auth"',
    });
    const client = new RokuDevClient('10.0.0.9', {
      passwordResolver: async () => 'wrongpw',
      fetchImpl,
      cnonceFn: () => 'c',
    });
    await expect(client.install(Buffer.from('zip'))).rejects.toMatchObject({
      code: 'DIGEST_REJECTED',
      status: 502,
    });
  });

  it('throws NO_PASSWORD when no credential is configured', async () => {
    const fetchImpl = async () => makeResponse({
      status: 401,
      wwwAuthenticate: 'Digest realm="rokudev", nonce="n", qop="auth"',
    });
    const client = new RokuDevClient('10.0.0.9', {
      passwordResolver: async () => null,
      fetchImpl,
    });
    await expect(client.install(Buffer.from('zip'))).rejects.toMatchObject({ code: 'NO_PASSWORD' });
  });

  it('maps an unreachable installer to UNREACHABLE 502', async () => {
    const fetchImpl = async () => { throw new Error('connect ECONNREFUSED'); };
    const client = new RokuDevClient('10.0.0.9', {
      passwordResolver: async () => 'abcd',
      fetchImpl,
    });
    await expect(client.install(Buffer.from('zip'))).rejects.toMatchObject({
      code: 'UNREACHABLE',
      status: 502,
    });
  });
});

describe('RokuDevClient.delete (best-effort)', () => {
  it('swallows transport errors into a result object', async () => {
    const client = new RokuDevClient('10.0.0.9', {
      passwordResolver: async () => 'abcd',
      fetchImpl: async () => { throw new Error('boom'); },
    });
    const r = await client.delete();
    expect(r.success).toBe(false);
    expect(r.ignored).toBe(true);
  });
});
