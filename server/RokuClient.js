/**
 * RokuClient - Roku External Control Protocol (ECP) client
 * Documentation: https://developer.roku.com/docs/developer-program/debugging/external-control-api.md
 */

import { parseStringPromise } from 'xml2js';

/**
 * Standard Roku ECP port - devices are identified by responding to ECP queries, not MAC addresses
 */
export const ROKU_ECP_PORT = 8060;

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
      friendlyDeviceName: info['friendly-device-name'] || info['user-device-name'],
      softwareVersion: info['software-version'],
      softwareBuild: info['software-build'],
      uiSoftwareVersion: info['ui-software-version'],
      powerMode: info['power-mode'],
      networkType: info['network-type'],
      wifiMac: info['wifi-mac'],
      ethernetMac: info['ethernet-mac'],
      networkName: info['network-name'],
      country: info['country'],
      language: info['language'],
      locale: info['locale'],
      timeZone: info['time-zone'],
      timeZoneName: info['time-zone-name'],
      screenSize: info['screen-size'],
      uiResolution: info['ui-resolution'],
      uptime: info['uptime'] ? parseInt(info['uptime'], 10) : null,
      supportsPrivateListening: info['supports-private-listening'] === 'true',
      headphonesConnected: info['headphones-connected'] === 'true',
      isStick: info['is-stick'] === 'true',
      isTv: info['is-tv'] === 'true',
      
      // Mobile control capabilities - if device responds to ECP, mobile controls are enabled
      // (If "Control by mobile apps" is disabled on device, it won't respond to ECP at all)
      supportsEcp: info['supports-ecp'] === 'true' || true, // If we got here, ECP works
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
      'friendly-device-name': info['friendly-device-name'] || info['user-device-name'],
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
      'is-stick': info['is-stick']
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

    return apps.map(app => ({
      id: app.$.id,
      name: app._,
      type: app.$.type || 'app',
      version: app.$.version || null
    }));
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
        return { id: screensaver.$.id, name: screensaver._, type: 'screensaver' };
      }
      return null;
    }

    return { id: app.$.id, name: app._, type: 'app' };
  }

  /**
   * GET /query/media-player - Get media player state
   */
  async getMediaPlayer() {
    try {
      const xml = await this._get('/query/media-player');
      const parsed = await parseStringPromise(xml, { explicitArray: false });
      const player = parsed.player;

      if (!player) return null;

      return {
        error: player.$.error === 'true',
        state: player.$.state,
        position: player.position ? parseInt(player.position._) : null,
        duration: player.duration ? parseInt(player.duration._) : null,
        isLive: player['is_live'] === 'true'
      };
    } catch {
      return null;
    }
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
   */
  async keypress(key) {
    await this._post(`/keypress/${key}`);
    return { success: true, key };
  }

  /**
   * POST /search/browse - Search for content
   */
  async search(keyword, options = {}) {
    const params = new URLSearchParams({
      keyword,
      type: options.type || 'tv-show',
      'launch': options.launch ? 'true' : 'false'
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
          return { level: 'limited', canControl: false, canQueryApps: false, reason: 'Mobile control restricted - enable "Permissive" mode in Roku settings' };
        }
        // Other error, but device-info worked
        return { level: 'limited', canControl: false, canQueryApps: false };
      }
    } catch (err) {
      return { level: 'disabled', canControl: false, canQueryApps: false, reason: 'Device not responding to ECP' };
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
        headers: { 'User-Agent': 'Waiveo-Roku/1.0' }
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
          'Content-Length': body.length.toString()
        },
        body
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
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  setTimeout(ms) {
    this.timeout = ms;
  }
}

