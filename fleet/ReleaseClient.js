/**
 * ReleaseClient - fetches the published Waiveo Roku player release from the
 * public repo maaxton/waiveo-roku-releases and downloads the versioned zip.
 *
 * Facts baked in from the release reader:
 *  - The release publishes EXACTLY ONE asset, the versioned zip
 *    `waiveo-roku-<tag>.zip` (assets[0]). There is NO `latest.zip` asset.
 *  - Trust the API `tag_name`, not the checked-in manifest (the release repo
 *    lags source; public latest can be behind the source manifest).
 *  - assets[0].digest is `sha256:<hex>` and is used to verify the download.
 *
 * Two caches keep fleet update-all under the 60/hr unauth rate limit and
 * download the zip only once per roll:
 *  - metadata cache (~30s TTL — short so a fresh publish shows quickly on a
 *    dev-lab appliance; getLatestMeta({ force: true }) bypasses it outright)
 *  - zip Buffer cache keyed by tag (so every device install replays one Buffer)
 */

import crypto from 'node:crypto';

const RELEASES_LATEST_API = 'https://api.github.com/repos/maaxton/waiveo-roku-releases/releases/latest';
const RELEASE_DOWNLOAD_BASE = 'https://github.com/maaxton/waiveo-roku-releases/releases/download';
const DEFAULT_META_TTL_MS = 30 * 1000;

export class ReleaseClient {
  constructor(opts = {}) {
    this._fetch = opts.fetchImpl || ((url, init) => globalThis.fetch(url, init));
    this.apiUrl = opts.apiUrl || RELEASES_LATEST_API;
    this.downloadBase = opts.downloadBase || RELEASE_DOWNLOAD_BASE;
    this.ttlMs = opts.ttlMs == null ? DEFAULT_META_TTL_MS : opts.ttlMs;
    this._now = opts.now || (() => Date.now());
    this._metaCache = null; // { at:number, value:object }
    this._zipCache = new Map(); // tag -> Buffer
  }

  /**
   * GET /releases/latest, cached for ttlMs. Reads tag_name + assets[0].
   * Pass { force: true } to bypass the cache (the fresh result still
   * repopulates it). Returns { tag, assetName, downloadUrl, size, digest, sha256 }.
   */
  async getLatestMeta({ force = false } = {}) {
    if (!force && this._metaCache && (this._now() - this._metaCache.at) < this.ttlMs) {
      return this._metaCache.value;
    }
    let res;
    try {
      res = await this._fetch(this.apiUrl, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Waiveo-Fleet/1.0' },
      });
    } catch (e) {
      const err = new Error(`GitHub releases lookup failed: ${e.message}`);
      err.status = 502;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`GitHub releases lookup failed: HTTP ${res.status}`);
      err.status = 502;
      throw err;
    }
    const json = await res.json();
    const asset = (Array.isArray(json.assets) && json.assets[0]) || null;
    const digest = asset && asset.digest ? String(asset.digest) : null;
    const value = {
      tag: json.tag_name || null,
      assetName: asset ? asset.name || null : null,
      downloadUrl: asset ? asset.browser_download_url || null : null,
      size: asset && asset.size != null ? asset.size : null,
      digest,
      sha256: digest ? digest.replace(/^sha256:/i, '') : null,
    };
    this._metaCache = { at: this._now(), value };
    return value;
  }

  /**
   * Download the release zip for `tag` (defaults to latest) as a Buffer,
   * sha256-verifying against the release digest when known. Caches the Buffer
   * by tag; a cache hit returns the SAME Buffer reference so a fleet roll
   * replays one download across all devices.
   * Returns { tag, buffer, meta, verified }.
   */
  async downloadZip(tag, { force = false } = {}) {
    const meta = await this.getLatestMeta();
    const wantTag = tag || meta.tag;
    if (!wantTag) {
      const err = new Error('No release tag available to download');
      err.status = 502;
      throw err;
    }
    if (!force && this._zipCache.has(wantTag)) {
      return {
        tag: wantTag, buffer: this._zipCache.get(wantTag), meta, verified: false, cached: true,
      };
    }

    let downloadUrl;
    let expectedSha;
    if (wantTag === meta.tag) {
      downloadUrl = meta.downloadUrl;
      expectedSha = meta.sha256;
    } else {
      // A specific (non-latest) tag: reconstruct the conventional asset URL.
      // The digest is unknown for non-latest tags, so verification is skipped.
      downloadUrl = `${this.downloadBase}/${wantTag}/waiveo-roku-${wantTag}.zip`;
      expectedSha = null;
    }
    if (!downloadUrl) {
      const err = new Error(`No downloadable asset for tag ${wantTag}`);
      err.status = 502;
      throw err;
    }

    let res;
    try {
      res = await this._fetch(downloadUrl, {
        headers: { 'User-Agent': 'Waiveo-Fleet/1.0', Accept: 'application/octet-stream' },
        redirect: 'follow',
      });
    } catch (e) {
      const err = new Error(`Release download failed: ${e.message}`);
      err.status = 502;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Release download failed: HTTP ${res.status}`);
      err.status = 502;
      throw err;
    }
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let verified = false;
    if (expectedSha) {
      const got = crypto.createHash('sha256').update(buffer).digest('hex');
      if (got.toLowerCase() !== expectedSha.toLowerCase()) {
        const err = new Error(`Release zip sha256 mismatch: expected ${expectedSha}, got ${got}`);
        err.status = 502;
        throw err;
      }
      verified = true;
    }

    this._zipCache.set(wantTag, buffer);
    return {
      tag: wantTag, buffer, meta, verified, cached: false,
    };
  }

  clearCache() {
    this._metaCache = null;
    this._zipCache.clear();
  }
}

export default ReleaseClient;
