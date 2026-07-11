import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { ReleaseClient } from 'roku-integration/fleet/ReleaseClient.js';

function metaResponse(json) {
  return {
    ok: true, status: 200, headers: { get: () => null }, async json() { return json; },
  };
}
function zipResponse(buf) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async arrayBuffer() { return new Uint8Array(buf).buffer; },
  };
}

const ZIP = Buffer.from('ROKU-PLAYER-ZIP-BYTES');
const SHA = crypto.createHash('sha256').update(ZIP).digest('hex');

function latestJson(digestHex = SHA) {
  return {
    tag_name: 'v2.7.1',
    assets: [{
      name: 'waiveo-roku-v2.7.1.zip',
      browser_download_url: 'https://example/waiveo-roku-v2.7.1.zip',
      size: ZIP.length,
      digest: `sha256:${digestHex}`,
    }],
  };
}

describe('ReleaseClient.getLatestMeta', () => {
  it('reads tag_name + assets[0] and strips the sha256: prefix', async () => {
    const rc = new ReleaseClient({ fetchImpl: async () => metaResponse(latestJson()) });
    const meta = await rc.getLatestMeta();
    expect(meta.tag).toBe('v2.7.1');
    expect(meta.assetName).toBe('waiveo-roku-v2.7.1.zip');
    expect(meta.digest).toBe(`sha256:${SHA}`);
    expect(meta.sha256).toBe(SHA);
    expect(meta.size).toBe(ZIP.length);
  });

  it('caches metadata within the TTL and refetches after it expires', async () => {
    let apiCalls = 0;
    let clock = 0;
    const rc = new ReleaseClient({
      ttlMs: 1000,
      now: () => clock,
      fetchImpl: async () => { apiCalls += 1; return metaResponse(latestJson()); },
    });
    await rc.getLatestMeta();
    clock = 500;
    await rc.getLatestMeta();
    expect(apiCalls).toBe(1); // still cached
    clock = 2000;
    await rc.getLatestMeta();
    expect(apiCalls).toBe(2); // TTL expired → refetched
  });

  it('defaults to a 30-second metadata TTL', async () => {
    let apiCalls = 0;
    let clock = 0;
    const rc = new ReleaseClient({
      now: () => clock,
      fetchImpl: async () => { apiCalls += 1; return metaResponse(latestJson()); },
    });
    await rc.getLatestMeta();
    clock = 20_000;
    await rc.getLatestMeta();
    expect(apiCalls).toBe(1); // 20s in — still cached
    clock = 31_000;
    await rc.getLatestMeta();
    expect(apiCalls).toBe(2); // past 30s → refetched
  });

  it('force:true bypasses a fresh cache and repopulates it', async () => {
    let apiCalls = 0;
    let clock = 0;
    const rc = new ReleaseClient({
      now: () => clock,
      fetchImpl: async () => { apiCalls += 1; return metaResponse(latestJson()); },
    });
    await rc.getLatestMeta();
    expect(apiCalls).toBe(1);
    const meta = await rc.getLatestMeta({ force: true }); // cache fresh, force skips it
    expect(apiCalls).toBe(2);
    expect(meta.tag).toBe('v2.7.1');
    clock = 1000; // well inside the TTL
    await rc.getLatestMeta(); // served from the cache the force call repopulated
    expect(apiCalls).toBe(2);
  });

  it('maps a non-OK API response to a 502', async () => {
    const rc = new ReleaseClient({
      fetchImpl: async () => ({ ok: false, status: 403, headers: { get: () => null } }),
    });
    await expect(rc.getLatestMeta()).rejects.toMatchObject({ status: 502 });
  });
});

describe('ReleaseClient.downloadZip', () => {
  it('downloads once, sha256-verifies, and reuses the SAME Buffer on cache hit', async () => {
    let dlCalls = 0;
    const rc = new ReleaseClient({
      fetchImpl: async (url) => {
        if (String(url).includes('api.github.com')) return metaResponse(latestJson());
        dlCalls += 1;
        return zipResponse(ZIP);
      },
    });

    const d1 = await rc.downloadZip();
    expect(d1.tag).toBe('v2.7.1');
    expect(d1.verified).toBe(true);
    expect(Buffer.compare(d1.buffer, ZIP)).toBe(0);
    expect(dlCalls).toBe(1);

    const d2 = await rc.downloadZip();
    expect(dlCalls).toBe(1); // cached, no second download
    expect(d2.buffer).toBe(d1.buffer); // SAME Buffer replayed across devices
    expect(d2.cached).toBe(true);
  });

  it('throws 502 on a sha256 mismatch', async () => {
    const wrong = 'deadbeef'.repeat(8); // 64 hex chars, != real digest
    const rc = new ReleaseClient({
      fetchImpl: async (url) => {
        if (String(url).includes('releases/latest')) return metaResponse(latestJson(wrong));
        return zipResponse(ZIP);
      },
    });
    await expect(rc.downloadZip()).rejects.toMatchObject({ status: 502 });
  });
});
