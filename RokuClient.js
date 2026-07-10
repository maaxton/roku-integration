/**
 * RokuClient - Roku External Control Protocol (ECP) client
 * Documentation: https://developer.roku.com/docs/developer-program/debugging/external-control-api.md
 */

import { parseStringPromise } from 'xml2js';
import { ROKU_ECP_PORT } from './constants.js';

// Re-exported for any consumer that still imports ROKU_ECP_PORT from here
// directly. index.js now gets it from constants.js at module scope instead
// (this module is loaded lazily — see index.js's getRokuClient()).
export { ROKU_ECP_PORT };

export class RokuClient {
  constructor(ip, port = ROKU_ECP_PORT) {
    this.ip = ip;
    this.port = port;
    this.baseUrl = `http://${ip}:${port}`;
    this.timeout = 5000;
  }

  /**
   * Check if device is reachable
   */
  async isReachable() {
    try {
      await this.getDeviceInfo();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * GET /query/device-info - Get device information
   * Returns both camelCase and kebab-case keys for compatibility
   */
  async getDeviceInfo() {
    const xml = await this._get('/query/device-info');
    const parsed = await parseStringPromise(xml, { explicitArray: false });
    const info = parsed['device-info'];

    // Return comprehensive device info with both formats for compatibility
    return {
      // camelCase format
      serialNumber: info['serial-number'],
      deviceId: info['device-id'],
      vendorName: info['vendor-name'],
      modelName: info['model-name'],
      modelNumber: info['model-number'],
      // #1673: prefer the OWNER-set name (user-device-name) over the marketing
      // friendly-device-name and the factory default-device-name. This is what
      // the pending discovery card titles itself with — e.g. "The Hanger".
      friendlyDeviceName:
        info['user-device-name'] || info['friendly-device-name'] || info['default-device-name'],
      userDeviceName: info['user-device-name'] || null,
      defaultDeviceName: info['default-device-name'] || null,
      friendlyModelName: info['friendly-model-name'],
      softwareVersion: info['software-version'],
      softwareBuild: info['software-build'],
      uiSoftwareVersion: info['ui-software-version'],
      powerMode: info['power-mode'],
      networkType: info['network-type'],
      wifiMac: info['wifi-mac'],
      ethernetMac: info['ethernet-mac'],
      networkName: info['network-name'],
      country: info.country,
      language: info.language,
      locale: info.locale,
      timeZone: info['time-zone'],
      timeZoneName: info['time-zone-name'],
      screenSize: info['screen-size'],
      uiResolution: info['ui-resolution'],
      uptime: info.uptime ? parseInt(info.uptime, 10) : null,
      supportsPrivateListening: info['supports-private-listening'] === 'true',
      headphonesConnected: info['headphones-connected'] === 'true',
      isStick: info['is-stick'] === 'true',
      isTv: info['is-tv'] === 'true',

      // Mobile control capabilities - if device responds to ECP, mobile controls are enabled
      // (If "Control by mobile apps" is disabled on device, it won't respond to ECP at all)
      supportsEcp: info['supports-ecp'] === 'true',
      supportsWakeOnWlan: info['supports-wake-on-wlan'] === 'true',
      supportsSuspend: info['supports-suspend'] === 'true',
      supportsAirplay: info['supports-airplay'] === 'true',
      hasMobileScreensaver: info['has-mobile-screensaver'] === 'true',
      developerEnabled: info['developer-enabled'] === 'true',
      searchEnabled: info['search-enabled'] === 'true',
      voiceSearchEnabled: info['voice-search-enabled'] === 'true',
      notificationsEnabled: info['notifications-enabled'] === 'true',
      notificationsFirstUse: info['notifications-first-use'] === 'true',

      // ECP version info
      ecpVersion: info['ecp-version'] || null,

      // kebab-case format for frontend compatibility
      'serial-number': info['serial-number'],
      'device-id': info['device-id'],
      'vendor-name': info['vendor-name'],
      'model-name': info['model-name'],
      'model-number': info['model-number'],
      // #1673: same owner-first precedence in the kebab-case mirror.
      'friendly-device-name':
        info['user-device-name'] || info['friendly-device-name'] || info['default-device-name'],
      'user-device-name': info['user-device-name'] || null,
      'default-device-name': info['default-device-name'] || null,
      'friendly-model-name': info['friendly-model-name'],
      'software-version': info['software-version'],
      'software-build': info['software-build'],
      'ui-software-version': info['ui-software-version'],
      'power-mode': info['power-mode'],
      'network-type': info['network-type'],
      'wifi-mac': info['wifi-mac'],
      'ethernet-mac': info['ethernet-mac'],
      'network-name': info['network-name'],
      'time-zone': info['time-zone'],
      'time-zone-name': info['time-zone-name'],
      'screen-size': info['screen-size'],
      'ui-resolution': info['ui-resolution'],
      'is-tv': info['is-tv'],
      'is-stick': info['is-stick'],
    };
  }

  /**
   * GET /query/apps - Get list of installed apps
   */
  async getApps() {
    const xml = await this._get('/query/apps');
    const parsed = await parseStringPromise(xml, { explicitArray: false });
    const appsData = parsed.apps?.app;

    if (!appsData) return [];
    const apps = Array.isArray(appsData) ? appsData : [appsData];

    // DD6: xml2js only attaches `$` (attributes) when the element actually
    // has attributes; a malformed/truncated ECP response could hand back a
    // bare string entry instead of an object. Guard every access instead of
    // assuming shape.
    return apps.map((app) => {
      const attrs = app?.$ || {};
      return {
        id: attrs.id ?? null,
        name: app?._ ?? null,
        type: attrs.type || 'app',
        version: attrs.version || null,
      };
    });
  }

  /**
   * GET /query/active-app - Get currently active app
   */
  async getActiveApp() {
    const xml = await this._get('/query/active-app');
    const parsed = await parseStringPromise(xml, { explicitArray: false });
    const app = parsed['active-app']?.app;

    if (!app) {
      const screensaver = parsed['active-app']?.screensaver;
      if (screensaver) {
        const attrs = screensaver.$ || {};
        return { id: attrs.id ?? null, name: screensaver._ ?? null, type: 'screensaver' };
      }
      return null;
    }

    // Preserve the real type from the ECP response ('home' for the Roku Home
    // screen, 'appl' for a channel, etc.) instead of flattening everything to
    // 'app'. The Home screen reports <app id="562859" type="home">Roku Dynamic
    // Menu</app>; without the real type, callers can't tell Home from a channel
    // (its NAME varies by firmware — "Home", "Roku", "Roku Dynamic Menu"…).
    // DD6: guard `$` — a malformed response could hand back an app node with
    // no attributes at all.
    const attrs = app.$ || {};
    return { id: attrs.id ?? null, name: app._ ?? null, type: attrs.type || 'app' };
  }

  /**
   * GET /query/media-player - Get media player state
   */
  async getMediaPlayer() {
    try {
      const xml = await this._get('/query/media-player');
      const parsed = await parseStringPromise(xml, { explicitArray: false });
      const { player } = parsed;

      if (!player) return null;

      // DD6: guard `$` the same way as getApps/getActiveApp.
      const attrs = player.$ || {};
      return {
        error: attrs.error === 'true',
        state: attrs.state,
        position: player.position ? parseInt(player.position._, 10) : null,
        duration: player.duration ? parseInt(player.duration._, 10) : null,
        isLive: player.is_live === 'true',
      };
    } catch {
      return null;
    }
  }

  /**
   * GET /query/device-info, but only regex-extract <power-mode> instead of
   * parsing the full XML tree into the ~40-field object getDeviceInfo()
   * builds. Poll (P1, audit 2026-07-04) calls this every ~750ms per device —
   * across 7 live Rokus that's ~9 full xml2js parses/s replaced with a single
   * cheap regex match. Static fields (serial/model/firmware/etc.) never
   * change poll-to-poll; they're captured once via getDeviceInfo() at
   * discovery/probe time and persisted to device_registry.
   */
  async getPowerMode() {
    const xml = await this._get('/query/device-info');
    const match = xml.match(/<power-mode>([^<]*)<\/power-mode>/i);
    return match ? match[1] : null;
  }

  /**
   * POST /launch/{appId} - Launch an app
   */
  async launchApp(appId, params = {}) {
    let url = `/launch/${appId}`;
    const queryParams = Object.entries(params)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
    if (queryParams) url += `?${queryParams}`;

    await this._post(url);
    return { success: true, appId };
  }

  /**
   * POST /keypress/{key} - Send a keypress
   *
   * DD7: `key` used to be forwarded verbatim into the ECP URL path — the
   * automation command UI restricts it to a fixed <select> allowlist, but the
   * REST route (POST /devices/:id/keypress/:key) and the sendKeypress()
   * service both hand this whatever the caller supplied. Validate against
   * Roku's actual key-name grammar (word characters only — covers every
   * named ECP key plus `Lit_<char>` input) and encode before building the
   * URL, as a single choke point for every caller.
   */
  async keypress(key) {
    const safeKey = String(key ?? '');
    if (!/^[A-Za-z0-9_]{1,32}$/.test(safeKey)) {
      throw new Error(`Invalid keypress key: ${JSON.stringify(key)}`);
    }
    await this._post(`/keypress/${encodeURIComponent(safeKey)}`);
    return { success: true, key: safeKey };
  }

  /**
   * POST /search/browse - Search for content
   */
  async search(keyword, options = {}) {
    const params = new URLSearchParams({
      keyword,
      type: options.type || 'tv-show',
      launch: options.launch ? 'true' : 'false',
    });
    await this._post(`/search/browse?${params.toString()}`);
    return { success: true, keyword };
  }

  /**
   * POST /input - Send text input character by character
   */
  async inputText(text) {
    for (const char of text) {
      await this._post(`/keypress/Lit_${encodeURIComponent(char)}`);
      await this._delay(50);
    }
    return { success: true, text };
  }

  // Convenience methods
  async powerOn() {
    try {
      await this.keypress('PowerOn');
    } catch {
      // Fallback to Home if PowerOn not supported
      await this.keypress('Home');
    }
    return { success: true };
  }

  async powerOff() {
    await this.keypress('PowerOff');
    return { success: true };
  }

  async home() {
    return this.keypress('Home');
  }

  async back() {
    return this.keypress('Back');
  }

  async select() {
    return this.keypress('Select');
  }

  async up() {
    return this.keypress('Up');
  }

  async down() {
    return this.keypress('Down');
  }

  async left() {
    return this.keypress('Left');
  }

  async right() {
    return this.keypress('Right');
  }

  async play() {
    return this.keypress('Play');
  }

  async pause() {
    return this.keypress('Pause');
  }

  async rewind() {
    return this.keypress('Rev');
  }

  async fastForward() {
    return this.keypress('Fwd');
  }

  async volumeUp() {
    return this.keypress('VolumeUp');
  }

  async volumeDown() {
    return this.keypress('VolumeDown');
  }

  async mute() {
    return this.keypress('VolumeMute');
  }

  /**
   * Get app icon URL
   */
  getAppIconUrl(appId) {
    return `${this.baseUrl}/query/icon/${appId}`;
  }

  /**
   * Check mobile control access level
   * Returns: 'full' | 'limited' | 'disabled'
   * - full: All ECP commands work (Permissive mode)
   * - limited: Device info works, but apps/commands may be restricted (Default mode)
   * - disabled: Device doesn't respond at all
   */
  async checkMobileControlAccess() {
    try {
      // First check if device responds at all
      await this.getDeviceInfo();

      // Try to get apps list - this fails with 403 when mobile control is disabled
      // DO NOT send any keypresses - that would affect the TV!
      try {
        await this.getApps();
        // If apps query works, mobile control is enabled
        return { level: 'full', canControl: true, canQueryApps: true };
      } catch (appsErr) {
        if (appsErr.message.includes('403')) {
          return {
            level: 'limited', canControl: false, canQueryApps: false, reason: 'Mobile control restricted - enable "Permissive" mode in Roku settings',
          };
        }
        // Other error, but device-info worked
        return { level: 'limited', canControl: false, canQueryApps: false };
      }
    } catch (err) {
      return {
        level: 'disabled', canControl: false, canQueryApps: false, reason: 'Device not responding to ECP',
      };
    }
  }

  /**
   * Internal HTTP GET request
   */
  async _get(path) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'Waiveo-Roku/1.0' },
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') throw new Error('Request timeout');
      throw error;
    }
  }

  /**
   * Internal HTTP POST request
   */
  async _post(path, body = '') {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Waiveo-Roku/1.0',
          'Content-Length': body.length.toString(),
        },
        body,
      });
      clearTimeout(timeoutId);

      if (!response.ok && response.status !== 202) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return true;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') throw new Error('Request timeout');
      throw error;
    }
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  setTimeout(ms) {
    this.timeout = ms;
  }
}
