/**
 * RokuAPI - Roku External Control Protocol (ECP) client
 * Implements HTTP-based control protocol for Roku devices
 * 
 * ECP Documentation: https://developer.roku.com/docs/developer-program/debugging/external-control-api.md
 */

import { parseStringPromise } from 'xml2js';

export class RokuAPI {
  constructor(ip, port = 8060) {
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
   */
  async getDeviceInfo() {
    const xml = await this._get('/query/device-info');
    const parsed = await parseStringPromise(xml, { explicitArray: false });
    
    const info = parsed['device-info'];
    return {
      serialNumber: info['serial-number'],
      deviceId: info['device-id'],
      vendorName: info['vendor-name'],
      modelName: info['model-name'],
      modelNumber: info['model-number'],
      friendlyDeviceName: info['friendly-device-name'] || info['user-device-name'],
      softwareVersion: info['software-version'],
      softwareBuild: info['software-build'],
      powerMode: info['power-mode'],
      networkType: info['network-type'],
      wifiMac: info['wifi-mac'],
      ethernetMac: info['ethernet-mac'],
      networkName: info['network-name'],
      countryCode: info['country'],
      locale: info['locale'],
      timeZone: info['time-zone'],
      supportsPrivateListening: info['supports-private-listening'] === 'true',
      headphonesConnected: info['headphones-connected'] === 'true',
      isStick: info['is-stick'] === 'true',
      isTv: info['is-tv'] === 'true',
      raw: info
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
    
    // Ensure array
    const apps = Array.isArray(appsData) ? appsData : [appsData];
    
    return apps.map(app => ({
      id: app.$.id,
      name: app._,
      type: app.$.type || 'app',
      subtype: app.$.subtype || null,
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
      // Check for screensaver
      const screensaver = parsed['active-app']?.screensaver;
      if (screensaver) {
        return {
          id: screensaver.$.id,
          name: screensaver._,
          type: 'screensaver'
        };
      }
      return null;
    }
    
    return {
      id: app.$.id,
      name: app._,
      type: 'app'
    };
  }

  /**
   * GET /query/tv-channels - Get TV channels (if device is a Roku TV)
   */
  async getTvChannels() {
    try {
      const xml = await this._get('/query/tv-channels');
      const parsed = await parseStringPromise(xml, { explicitArray: false });
      
      const channelData = parsed['tv-channels']?.channel;
      if (!channelData) return [];
      
      const channels = Array.isArray(channelData) ? channelData : [channelData];
      
      return channels.map(ch => ({
        number: ch['number'],
        name: ch['name'],
        type: ch['type'],
        userHidden: ch['user-hidden'] === 'true'
      }));
    } catch {
      // Not a Roku TV or TV tuner not available
      return [];
    }
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
        plugin: player.plugin ? {
          id: player.plugin.$.id,
          name: player.plugin.$.name,
          bandwidth: player.plugin.$.bandwidth
        } : null,
        format: player.format ? {
          audio: player.format.$.audio,
          video: player.format.$.video,
          drm: player.format.$.drm
        } : null,
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
    
    // Add query parameters if provided
    const queryParams = Object.entries(params)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
    
    if (queryParams) {
      url += `?${queryParams}`;
    }
    
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
   * POST /keydown/{key} - Key down event
   */
  async keydown(key) {
    await this._post(`/keydown/${key}`);
    return { success: true, key };
  }

  /**
   * POST /keyup/{key} - Key up event
   */
  async keyup(key) {
    await this._post(`/keyup/${key}`);
    return { success: true, key };
  }

  /**
   * POST /search/browse - Search for content
   */
  async search(keyword, options = {}) {
    const params = new URLSearchParams({
      keyword,
      type: options.type || 'tv-show',
      provider: options.provider || '',
      'launch': options.launch ? 'true' : 'false'
    });
    
    await this._post(`/search/browse?${params.toString()}`);
    return { success: true, keyword };
  }

  /**
   * POST /input - Send text input
   */
  async inputText(text) {
    for (const char of text) {
      await this._post(`/keypress/Lit_${encodeURIComponent(char)}`);
      await this._delay(50); // Small delay between characters
    }
    return { success: true, text };
  }

  /**
   * Power on - Send PowerOn key (or Home to wake)
   */
  async powerOn() {
    // Try PowerOn first, fallback to Home
    try {
      await this.keypress('PowerOn');
    } catch {
      await this.keypress('Home');
    }
    return { success: true };
  }

  /**
   * Power off - Send PowerOff key
   */
  async powerOff() {
    await this.keypress('PowerOff');
    return { success: true };
  }

  /**
   * Navigate home
   */
  async home() {
    await this.keypress('Home');
    return { success: true };
  }

  /**
   * Volume control
   */
  async volumeUp() {
    await this.keypress('VolumeUp');
    return { success: true };
  }

  async volumeDown() {
    await this.keypress('VolumeDown');
    return { success: true };
  }

  async mute() {
    await this.keypress('VolumeMute');
    return { success: true };
  }

  /**
   * Playback control
   */
  async play() {
    await this.keypress('Play');
    return { success: true };
  }

  async pause() {
    await this.keypress('Pause');
    return { success: true };
  }

  async rewind() {
    await this.keypress('Rev');
    return { success: true };
  }

  async fastForward() {
    await this.keypress('Fwd');
    return { success: true };
  }

  /**
   * Navigation control
   */
  async select() {
    await this.keypress('Select');
    return { success: true };
  }

  async back() {
    await this.keypress('Back');
    return { success: true };
  }

  async up() {
    await this.keypress('Up');
    return { success: true };
  }

  async down() {
    await this.keypress('Down');
    return { success: true };
  }

  async left() {
    await this.keypress('Left');
    return { success: true };
  }

  async right() {
    await this.keypress('Right');
    return { success: true };
  }

  /**
   * Get app icon URL
   */
  getAppIconUrl(appId) {
    return `${this.baseUrl}/query/icon/${appId}`;
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
        headers: {
          'User-Agent': 'Waiveo-Roku/1.0'
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.text();

    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('Request timeout');
      }
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

      // Roku returns 200 for success, sometimes 202 for async operations
      if (!response.ok && response.status !== 202) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return true;

    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw error;
    }
  }

  /**
   * Delay helper
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Set request timeout
   */
  setTimeout(ms) {
    this.timeout = ms;
  }

  /**
   * Get base URL
   */
  getBaseUrl() {
    return this.baseUrl;
  }
}

/**
 * Well-known Roku MAC address prefixes (OUI)
 */
export const ROKU_MAC_PREFIXES = [
  'D8:31:34',
  'B8:3E:59',
  '08:05:81',
  'C8:3A:6B',
  '00:0D:4B',
  'B0:A7:37',
  'AC:3A:7A',
  '88:DE:A9',
  '84:EA:ED',
  'CC:6D:A0',
  'D4:E2:2F',
  'DC:3A:5E',
  '10:59:32',
  '20:EF:BD',
  '2C:4D:79',
  '5C:EA:1D',
  '84:D4:C8',
  'BC:D7:D4',
  'C8:57:57',
  'D8:DF:CC'
];

/**
 * Standard Roku ECP port
 */
export const ROKU_ECP_PORT = 8060;



