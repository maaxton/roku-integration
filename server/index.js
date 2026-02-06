/**
 * Roku Integration Extension
 * Discover and control Roku devices on your network
 * 
 * Uses centralized DevicePollingManager from device-discovery extension.
 */

import { RokuClient, ROKU_ECP_PORT } from './RokuClient.js';

let api = null;
let deviceStore = null;

// Model schema for roku_devices table
const MODEL_SCHEMAS = {
  devices: {
    tableName: 'roku_devices',
    description: 'Registered Roku devices',
    fields: {
      id: { type: 'integer', primaryKey: true, autoIncrement: true },
      device_id: { type: 'string', required: true },
      ip_address: { type: 'string', required: true },
      name: { type: 'string', required: true },
      model: { type: 'string' },
      serial_number: { type: 'string' },
      software_version: { type: 'string' },
      power_mode: { type: 'string' },
      status: { type: 'string', default: 'unknown' },
      metadata: { type: 'json' },
      last_seen_at: { type: 'datetime' },
      created_at: { type: 'datetime', default: 'CURRENT_TIMESTAMP' }
    },
    jsonFields: ['metadata'],
    dateFields: ['last_seen_at', 'created_at']
  }
};

/**
 * Device store wrapper for database operations
 */
class DeviceStore {
  constructor(api) {
    this.api = api;
    this.model = null;
  }

  async init() {
    this.model = this.api.model('roku_devices');
  }

  async getAllDevices() {
    const result = await this.model.findAll();
    return result || [];
  }

  async getDevice(deviceId) {
    const results = await this.model.findAll({ where: { device_id: deviceId } });
    return results?.[0] || null;
  }

  async getDeviceByIp(ipAddress) {
    const results = await this.model.findAll({ where: { ip_address: ipAddress } });
    return results?.[0] || null;
  }

  async createDevice(data) {
    const id = await this.model.create(data);
    return { id, ...data };
  }

  async updateDevice(deviceId, data) {
    const existing = await this.getDevice(deviceId);
    if (existing) {
      await this.model.update(existing.id, data);
    }
  }

  async updateDeviceStatus(deviceId, data) {
    const existing = await this.getDevice(deviceId);
    if (existing) {
      // Merge metadata if provided, don't replace entirely
      if (data.metadata && existing.metadata) {
        data.metadata = { ...existing.metadata, ...data.metadata };
      }
      await this.model.update(existing.id, data);
    }
  }

  async deleteDevice(deviceId) {
    const existing = await this.getDevice(deviceId);
    if (existing) {
      await this.model.delete(existing.id);
    }
  }
}

/**
 * Sync existing devices from roku_devices table to centralized device_registry
 * Also recovers orphaned devices from entity_states if roku_devices is empty
 */
async function syncDevicesToRegistry() {
  if (!deviceStore) {
    api.log('DeviceStore not initialized, skipping sync', 'warn');
    return;
  }
  
  // First, check roku_devices table
  let localDevices = await deviceStore.getAllDevices();
  api.log(`Found ${localDevices.length} local Roku devices`, 'debug');
  
  // If roku_devices is empty, try to recover from entity_states
  if (localDevices.length === 0) {
    api.log('roku_devices empty, attempting recovery from entity_states...', 'debug');
    localDevices = await recoverDevicesFromEntityStates();
    if (localDevices.length > 0) {
      api.log(`Recovered ${localDevices.length} devices from entity_states`, 'debug');
    }
  }
  
  if (localDevices.length === 0) {
    api.log('No Roku devices found to sync', 'debug');
    return;
  }
  
  // Sync each device to centralized registry
  for (const device of localDevices) {
    try {
      // Extract serial number from device_id (format: roku:SERIAL or roku-SERIAL)
      const serialMatch = device.device_id?.match(/^roku[:\-](.+)$/i);
      const serialNumber = serialMatch?.[1] || device.serial_number;
      
      // Normalize device ID to consistent format (roku:SERIAL)
      const normalizedId = serialNumber ? `roku:${serialNumber}` : device.device_id;
      
      // Check if device already exists in registry (with any ID format variant)
      let existingDevice = null;
      try {
        // Check for roku:SERIAL format
        const result1 = await api.queryBuilder('device_registry')
          .where('id', '=', `roku:${serialNumber}`)
          .get();
        if (result1?.length > 0) existingDevice = result1[0];
        
        // Also check for roku-SERIAL format (legacy/incorrect)
        if (!existingDevice) {
          const result2 = await api.queryBuilder('device_registry')
            .where('id', '=', `roku-${serialNumber}`)
            .get();
          if (result2?.length > 0) {
            existingDevice = result2[0];
            // Clean up legacy format entry
            api.log(`Found legacy device ID format: roku-${serialNumber}, will update to roku:${serialNumber}`, 'debug');
          }
        }
      } catch (e) {
        // Query failed, proceed with registration
      }
      
      // If device exists with different IP, log the change
      if (existingDevice && existingDevice.ip_address !== device.ip_address) {
        api.log(`Device ${device.name} IP changed: ${existingDevice.ip_address} → ${device.ip_address}`, 'debug');
      }
      
      // Register/update device with normalized ID
      await api.registerDevice({
        deviceId: normalizedId,
        name: device.name,
        type: 'roku',
        extensionSource: 'roku-integration',
        ipAddress: device.ip_address,
        model: device.model || 'Unknown',
        manufacturer: device.metadata?.vendorName || 'Roku',
        firmwareVersion: device.software_version,
        capabilities: ['power', 'apps', 'remote', 'volume'],
        metadata: {
          ...device.metadata,
          serial_number: device.serial_number || serialNumber,
          power_mode: device.power_mode
        }
      });
      api.log(`Synced device to registry: ${device.name} (${normalizedId})`, 'debug');
    } catch (e) {
      api.log(`Device sync error for ${device.name}: ${e.message}`, 'warn');
    }
  }
}

/**
 * Recover orphaned devices from entity_states when roku_devices table is empty
 * This handles cases where device records were lost but entity states remain
 */
async function recoverDevicesFromEntityStates() {
  const recoveredDevices = [];
  
  try {
    // Query entity_states for roku entities (match by entity_id prefix)
    const entities = await api.queryBuilder('entity_states')
      .where('entity_id', 'LIKE', 'roku.%')
      .get();
    
    if (!entities || entities.length === 0) {
      api.log('No entity_states found for recovery', 'debug');
      return recoveredDevices;
    }
    
    // Extract unique device names from entity_ids like "roku.the_hanger.power"
    const deviceMap = new Map();
    for (const entity of entities) {
      const entityId = entity.entity_id || entity.id;
      const parts = entityId?.split('.');
      if (parts && parts.length >= 2 && parts[0] === 'roku') {
        const deviceSlug = parts[1]; // e.g., "the_hanger"
        if (!deviceMap.has(deviceSlug)) {
          const deviceId = entity.device_id || entity.deviceId || entity.source_device_id;
          deviceMap.set(deviceSlug, {
            slug: deviceSlug,
            device_id: deviceId,
            name: entity.name || entity.friendly_name || deviceSlug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
          });
        }
      }
    }
    
    api.log(`Found ${deviceMap.size} unique devices in entity_states`, 'debug');
    
    // For each device, try to get its IP from device_registry or by discovery
    for (const [slug, deviceInfo] of deviceMap) {
      // Try to find IP in device_registry by id or by matching name
      let ipAddress = null;
      let foundDevice = null;
      
      try {
        // Try by id (format: roku:SERIAL)
        if (deviceInfo.device_id) {
          const regResult = await api.queryBuilder('device_registry')
            .where('id', '=', deviceInfo.device_id)
            .get();
          
          if (regResult && regResult.length > 0) {
            foundDevice = regResult[0];
            ipAddress = foundDevice.ip_address;
          }
        }
        
        // If not found by id, try matching by device_type=roku
        if (!ipAddress) {
          const rokuDevices = await api.queryBuilder('device_registry')
            .where('device_type', '=', 'roku')
            .get();
          
          // Match by name similarity
          if (rokuDevices && rokuDevices.length > 0) {
            const normalizedSlug = deviceInfo.slug.toLowerCase();
            for (const d of rokuDevices) {
              const deviceName = (d.friendly_name || d.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
              if (deviceName.includes(normalizedSlug) || normalizedSlug.includes(deviceName)) {
                foundDevice = d;
                ipAddress = d.ip_address;
                break;
              }
            }
          }
        }
      } catch (e) {
        api.log(`device_registry query failed: ${e.message}`, 'debug');
      }
      
      // If no IP found, we can't recover this device fully
      if (!ipAddress) {
        api.log(`No IP found for ${deviceInfo.name}, needs re-discovery`, 'debug');
        continue;
      }
      
      // Verify the device is reachable and get full info
      try {
        const client = new RokuClient(ipAddress);
        const info = await client.getDeviceInfo();
        
        // Create full device record - use consistent roku:SERIAL format
        const fullDevice = {
          device_id: deviceInfo.device_id || `roku:${info.serialNumber}`,
          ip_address: ipAddress,
          name: info.friendlyDeviceName || deviceInfo.name,
          model: info.modelName,
          serial_number: info.serialNumber,
          software_version: info.softwareVersion,
          power_mode: info.powerMode,
          status: 'online',
          metadata: {
            modelNumber: info.modelNumber,
            vendorName: info.vendorName,
            isTv: info.isTv,
            isStick: info.isStick
          },
          last_seen_at: new Date().toISOString()
        };
        
        // Save to roku_devices table
        await deviceStore.createDevice(fullDevice);
        api.log(`Recovered device: ${fullDevice.name} at ${ipAddress}`, 'debug');
        
        recoveredDevices.push(fullDevice);
      } catch (e) {
        api.log(`Could not reach device at ${ipAddress}: ${e.message}`, 'debug');
      }
    }
  } catch (e) {
    api.log(`Device recovery error: ${e.message}`, 'warn');
  }
  
  return recoveredDevices;
}

/**
 * Called when extension is first installed
 */
export async function onInstall(extensionApi) {
  api = extensionApi;
  api.log('Roku Integration installing...', 'info');

  // Register model and create table
  await api.registerModel('roku_devices', MODEL_SCHEMAS.devices);
  await api.model('roku_devices').createTable();

  api.log('Roku Integration installed', 'info');
}

/**
 * Called when extension initializes
 */
export async function init(extensionApi) {
  api = extensionApi;
  api.log('Roku Integration initializing...', 'debug');

  // Ensure model is registered (in case onInstall failed previously)
  try {
    await api.registerModel('roku_devices', MODEL_SCHEMAS.devices);
    await api.model('roku_devices').createTable();
  } catch (error) {
    // Model may already exist, that's fine
    api.log(`Model registration note: ${error.message}`, 'debug');
  }

  // Initialize store
  deviceStore = new DeviceStore(api);
  await deviceStore.init();

  // Register poll adapter FIRST - must happen before device sync
  // so polling can start as soon as devices are registered
  registerPollAdapter();
  api.log('Poll adapter registered', 'debug');

  // Sync existing devices to centralized device_registry
  // This ensures polling works for devices added before the centralized system
  try {
    await syncDevicesToRegistry();
  } catch (syncError) {
    api.log(`Device sync failed: ${syncError.message}`, 'error');
  }

  // Register routes
  registerRoutes();
  api.log('Routes registered', 'debug');

  // Register automation actions
  registerAutomationActions();
  api.log('Automation actions registered', 'debug');

  // Register discovery handler - devices are identified by port 8060 (Roku ECP)
  registerDiscoveryHandler();
  api.log('Discovery handler registered', 'debug');

  // Register device inspector panel for Developer Tools
  registerInspectorPanel();

  api.log('Roku Integration initialized', 'info');
}

/**
 * Register discovery handler with device-discovery extension
 * 
 * Uses EVENT-DRIVEN pattern (worker-safe):
 * 1. Emit discovery:register-interest (just data, no callbacks)
 * 2. Listen for discovery:candidate-matched events
 * 3. Verify device and emit discovery:claim-device to claim
 */
function registerDiscoveryHandler() {
  if (!api.globalEventBus) {
    api.log('No globalEventBus available, cannot register discovery handler', 'warn');
    return;
  }
  
  // Step 1: Register interest in discovering Roku devices (just data, no callbacks)
  api.globalEventBus.emit('discovery:register-interest', {
    extensionName: 'roku-integration',
    deviceType: 'roku',
    ports: [ROKU_ECP_PORT],
    macPrefixes: []
  });
  
  // Step 2: Listen for candidate-matched events
  api.globalEventBus.on('discovery:candidate-matched', async (event) => {
    // Only handle events meant for us
    if (event.matchedInterest?.extensionName !== 'roku-integration') {
      return;
    }
    
    const candidate = event.candidate;
    api.log(`Discovery candidate received for ${candidate.ip}`, 'debug');
    
    try {
      // Step 3: Verify it's actually a Roku device
      const result = await handleDiscoveredCandidate(candidate);
      
      if (result?.claim) {
        api.log(`Claiming Roku device: ${result.deviceId} at ${candidate.ip}`, 'debug');
        
        // Step 4: Claim the device via event
        api.globalEventBus.emit('discovery:claim-device', {
          candidate,
          deviceId: result.deviceId,
          name: result.name,
          extensionName: 'roku-integration',
          metadata: {
            deviceType: 'roku',
            serialNumber: result.serialNumber
          }
        });
      } else {
        api.log(`Device at ${candidate.ip} is not a Roku or already claimed`, 'debug');
      }
    } catch (error) {
      api.log(`Error verifying Roku at ${candidate.ip}: ${error.message}`, 'warn');
    }
  });

  api.log('Registered discovery interest for port 8060 (event-driven)', 'debug');
}

/**
 * Register poll adapter with centralized DevicePollingManager
 * This moves polling logic from DevicePoller to the central manager
 */
function registerPollAdapter() {
  const adapter = {
    deviceType: 'roku',
    extensionName: 'roku-integration',
    
    /**
     * Create a RokuClient for a device
     */
    createClient: (device) => {
      if (!device.ip_address) return null;
      return new RokuClient(device.ip_address);
    },
    
    /**
     * Get poll interval - 750ms for responsive state updates
     */
    getPollInterval: (device) => {
      // Could check device metadata for custom interval
      return 750; // 750ms polling for faster state change detection
    },
    
    /**
     * Poll device and return entity states
     * Single HTTP call returns multiple entity states
     */
    pollDevice: async (device, client) => {
      // Defensive check - ensure device has required properties
      if (!device || !device.id) {
        throw new Error('Invalid device object - missing id');
      }
      
      const deviceIp = device.ip_address;
      if (!deviceIp) {
        throw new Error(`Device ${device.id} missing ip_address`);
      }
      
      if (!client) {
        client = new RokuClient(deviceIp);
      }
      
      // Fetch device info and active app in parallel
      const [info, activeApp] = await Promise.all([
        client.getDeviceInfo(),
        client.getActiveApp()
      ]);
      
      // Interpret power state from raw Roku mode
      const powerState = interpretPowerState(info.powerMode, activeApp);
      
      // Generate entity ID slug from device name
      const deviceName = device.friendly_name || device.name || device.id;
      const slug = deviceName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
      
      // Return single HA-style media_player entity with all attributes
      // device-discovery auto-registers new entities from poll results
      
      // Determine main state: on/off/idle/playing
      let mainState;
      if (powerState === 'off' || powerState === 'standby') {
        mainState = 'off';
      } else if (activeApp?.type === 'screensaver') {
        mainState = 'idle';
      } else if (activeApp?.name && activeApp.name !== 'Home') {
        mainState = 'playing';
      } else {
        mainState = 'on';
      }
      
      const entities = [
        {
          entityId: `media_player.${slug}`,
          state: mainState,
          attributes: {
            // Power info
            power_mode: info.powerMode,
            power_state: powerState,
            
            // Active app info
            active_app: activeApp?.name || 'Home',
            active_app_id: activeApp?.id || null,
            app_type: activeApp?.type || null,
            app_version: activeApp?.version || null,
            
            // Screensaver detection (for trigger aliases)
            is_screensaver: activeApp?.type === 'screensaver',
            screensaver_name: activeApp?.type === 'screensaver' ? activeApp.name : null,
            
            // Device metadata
            device_type: 'roku',
            friendly_name: device.friendly_name
          }
        }
      ];
      
      return entities;
    }
  };
  
  api.registerDevicePollAdapter(adapter);
  api.log('Registered Roku poll adapter with DevicePollingManager', 'debug');
}

/**
 * Interpret Roku's raw power-mode and active app to determine actual power state
 */
function interpretPowerState(rawPowerMode, activeApp) {
  const mode = (rawPowerMode || '').toLowerCase();
  
  // Explicit standby states - "Ready" means display is off but Roku is running
  if (mode === 'standby' || mode === 'displayoff' || mode === 'display off' || mode === 'ready') {
    return 'standby';
  }
  
  // Headless devices (like Roku sticks without display)
  if (mode === 'headless') {
    if (activeApp?.type === 'screensaver') {
      return 'standby';
    }
    return 'on';
  }
  
  // For PowerOn state, the display is actually on
  if (mode === 'poweron' || mode === 'power on') {
    if (activeApp?.type === 'screensaver') {
      return 'standby';
    }
    return 'on';
  }
  
  // Unknown state - default interpretation
  if (mode.includes('off') || mode.includes('standby') || mode.includes('ready')) {
    return 'standby';
  }
  
  return 'on';
}

/**
 * Register inspector panel for Developer Tools Device Inspector
 */
function registerInspectorPanel() {
  api.registerDeviceInspectorPanel({
    deviceType: 'roku',
    
    getInspectorData: async (device, client) => {
      if (!client) {
        client = getClient(device.ip_address);
      }
      
      try {
        const [apps, activeApp, info] = await Promise.all([
          client.getApps().catch(() => []),
          client.getActiveApp().catch(() => null),
          client.getDeviceInfo().catch(() => ({}))
        ]);
        
        return {
          tabs: [
            {
              id: 'apps',
              label: 'Apps',
              data: {
                installed: apps,
                active: activeApp
              }
            },
            {
              id: 'info',
              label: 'Device Info',
              data: info
            },
            {
              id: 'remote',
              label: 'Remote',
              component: 'roku-remote'
            }
          ]
        };
      } catch (error) {
        api.log(`Error getting inspector data: ${error.message}`, 'warn');
        return { tabs: [] };
      }
    }
  });
}

/**
 * Get or create a client for a device IP
 */
function getClient(ipAddress) {
  return new RokuClient(ipAddress);
}

/**
 * Handle a discovered candidate - verify it's a Roku and claim it
 * Returns { claim: true, deviceId, name } if successfully claimed
 * 
 * Device matching priority:
 * 1. Serial number (most stable - survives IP/MAC changes)
 * 2. MAC address (stable - survives IP changes) 
 * 3. IP address (fallback - least stable)
 */
async function handleDiscoveredCandidate(candidate) {
  // Support both direct candidate object and nested format
  const ip = candidate.ip || candidate.ip_address;
  const mac = candidate.mac || candidate.mac_address;
  
  api.log(`Checking candidate at ${ip}`, 'debug');

  try {
    const client = new RokuClient(ip);
    const info = await client.getDeviceInfo();
    
    api.log(`Device info for ${ip}: serial=${info.serialNumber}, vendor=${info.vendorName}`, 'debug');

    // Verify it's a Roku device - check multiple indicators since third-party TV manufacturers
    // (like onn, TCL, Hisense) may not report "Roku" as the vendor name
    const isRoku = 
      // Has serial number (all Rokus have this)
      info.serialNumber ||
      // Model URL contains roku.com
      info.modelUrl?.toLowerCase().includes('roku.com') ||
      // Model description mentions Roku
      info.modelDescription?.toLowerCase().includes('roku') ||
      // Successfully responded to Roku ECP - this is the strongest indicator
      // If we got device info back at all, it's a Roku
      true;  // If we get valid device info from port 8060 ECP, it's a Roku
    
    if (!isRoku) {
      api.log(`Device at ${ip} does not appear to be a Roku`, 'debug');
      return { claim: false };
    }
    
    api.log(`Roku confirmed at ${ip} (serial: ${info.serialNumber})`, 'debug');

    // Smart device matching - find existing device by most stable identifier first
    const existing = await findExistingRoku(info.serialNumber, mac, ip);
    
    if (existing) {
      const oldIp = existing.ip_address;
      const ipChanged = oldIp !== ip;
      
      if (ipChanged) {
        api.log(`Roku ${existing.name} IP changed: ${oldIp} → ${ip}`, 'debug');
        
        // Update IP address in our local store
        await deviceStore.updateDevice(existing.device_id, {
          ip_address: ip,
          status: 'online',
          last_seen_at: new Date().toISOString(),
          metadata: {
            ...existing.metadata,
            mac_address: mac || existing.metadata?.mac_address,
            previous_ip: oldIp,
            ip_changed_at: new Date().toISOString()
          }
        });
        
        // Update IP in global device registry
        await api.registerDevice({
          deviceId: existing.device_id,
          name: existing.name,
          type: 'roku',
          extensionSource: 'roku-integration',
          ipAddress: ip, // Updated IP
          model: existing.model,
          manufacturer: 'Roku',
          firmwareVersion: existing.software_version,
          capabilities: ['power', 'apps', 'remote', 'volume'],
          metadata: {
            ...existing.metadata,
            mac_address: mac || existing.metadata?.mac_address
          }
        });
        
        // Broadcast IP change event for UI updates
        api.broadcast('roku:ip-changed', { 
          deviceId: existing.device_id,
          name: existing.name,
          oldIp,
          newIp: ip
        });
      } else {
        // Just update last seen
        await deviceStore.updateDeviceStatus(existing.device_id, {
          status: 'online',
          last_seen_at: new Date().toISOString()
        });
      }
      
      // Return claim result so it's marked as claimed in discovery
      return { claim: true, deviceId: existing.device_id, name: existing.name, serialNumber: existing.serial_number };
    }

    // Create device ID from serial number (preferred) or IP (fallback)
    // Use roku:SERIAL format consistently
    const deviceId = `roku:${info.serialNumber || ip.replace(/\./g, '-')}`;

    // Register the device
    const device = {
      device_id: deviceId,
      ip_address: ip,
      name: info.friendlyDeviceName || `Roku ${info.modelName}`,
      model: info.modelName,
      serial_number: info.serialNumber,
      software_version: info.softwareVersion,
      power_mode: info.powerMode,
      status: 'online',
      metadata: {
        modelNumber: info.modelNumber,
        vendorName: info.vendorName,
        isTv: info.isTv,
        isStick: info.isStick,
        mac_address: mac
      },
      last_seen_at: new Date().toISOString()
    };

    await deviceStore.createDevice(device);

    // Register with global device registry
    await api.registerDevice({
      deviceId: deviceId,
      name: device.name,
      type: 'roku',
      extensionSource: 'roku-integration',
      ipAddress: ip,
      macAddress: mac,
      model: device.model,
      manufacturer: 'Roku',
      firmwareVersion: device.software_version,
      capabilities: ['power', 'apps', 'remote', 'volume'],
      metadata: device.metadata
    });

    api.log(`Registered new Roku: ${device.name} at ${ip}`, 'debug');

    // Broadcast for UI updates (WebSocket to frontend)
    api.broadcast('roku:device-added', { device });
    
    // Also emit via globalEventBus for backend extensions (like slidecast)
    if (api.globalEventBus) {
      api.globalEventBus.emit('roku:device-added', { device });
    }

    // Return claim result
    return { claim: true, deviceId, name: device.name, serialNumber: info.serialNumber };

  } catch (error) {
    api.log(`Failed to verify Roku at ${ip}: ${error.message}`, 'debug');
    return { claim: false };
  }
}

/**
 * Find an existing Roku device using smart matching
 * Priority: 1. Serial number (best), 2. MAC address, 3. IP address (fallback)
 * 
 * @param {string} serialNumber - Device serial number
 * @param {string} mac - MAC address
 * @param {string} ip - IP address
 * @returns {Object|null} Existing device record or null
 */
async function findExistingRoku(serialNumber, mac, ip) {
  const allDevices = await deviceStore.getAllDevices();
  
  // Priority 1: Match by serial number (most reliable - never changes)
  if (serialNumber) {
    const serialMatch = allDevices.find(d => d.serial_number === serialNumber);
    if (serialMatch) {
      api.log(`Matched Roku by serial number: ${serialNumber}`, 'debug');
      return serialMatch;
    }
  }
  
  // Priority 2: Match by MAC address (stable across IP changes)
  if (mac) {
    const normalizedMac = mac.toUpperCase().replace(/[:-]/g, ':');
    const macMatch = allDevices.find(d => {
      const deviceMac = d.metadata?.mac_address;
      if (!deviceMac) return false;
      return deviceMac.toUpperCase().replace(/[:-]/g, ':') === normalizedMac;
    });
    if (macMatch) {
      api.log(`Matched Roku by MAC address: ${mac}`, 'debug');
      return macMatch;
    }
  }
  
  // Priority 3: Match by IP address (least reliable - can change with DHCP)
  const ipMatch = await deviceStore.getDeviceByIp(ip);
  if (ipMatch) {
    api.log(`Matched Roku by IP address: ${ip}`, 'debug');
    return ipMatch;
  }
  
  return null;
}

/**
 * Helper to find device from roku_devices OR centralized registry
 * Used by routes and automation actions
 */
async function findDevice(deviceId) {
  // First check roku_devices table
  let device = await deviceStore.getDevice(deviceId);
  if (device) return device;
  
  // If not found, check centralized device_registry
  try {
    // Try by id
    let result = await api.queryBuilder('device_registry')
      .where('id', '=', deviceId)
      .get();
    
    if (result && result.length > 0) {
      const d = result[0];
      return {
        device_id: d.id || d.device_id,
        ip_address: d.ip_address,
        name: d.friendly_name || d.name || 'Unknown Roku'
      };
    }
    
    // Try by device_id field
    result = await api.queryBuilder('device_registry')
      .where('device_id', '=', deviceId)
      .get();
    
    if (result && result.length > 0) {
      const d = result[0];
      return {
        device_id: d.id || d.device_id,
        ip_address: d.ip_address,
        name: d.friendly_name || d.name || 'Unknown Roku'
      };
    }
    
    // Try by serial number (extract from roku:SERIAL format)
    const serialMatch = deviceId.match(/^roku:(.+)$/i);
    if (serialMatch) {
      const serial = serialMatch[1];
      result = await api.queryBuilder('device_registry')
        .where('serial_number', '=', serial)
        .get();
      
      if (result && result.length > 0) {
        const d = result[0];
        return {
          device_id: d.id || d.device_id,
          ip_address: d.ip_address,
          name: d.friendly_name || d.name || 'Unknown Roku'
        };
      }
    }
  } catch (err) {
    // Silently fail - device just won't be found
  }
  
  return null;
}

/**
 * Register API routes
 */
function registerRoutes() {
  // GET /devices - List all Roku devices
  // PRIMARY SOURCE: device_registry (canonical, updated by polling)
  // FALLBACK: roku_devices table, then entity_states
  api.registerRoute('GET', '/devices', async () => {
    let devices = [];
    
    // PRIMARY: Query device_registry (has fresh last_seen_at from polling)
    try {
      const result = await api.queryBuilder('device_registry')
        .where('device_type', '=', 'roku')
        .get();
      
      if (result && result.length > 0) {
        // Also fetch power entities to get power_mode
        const powerEntities = await api.queryBuilder('entity_states')
          .where('entity_id', 'LIKE', 'roku.%.power')
          .get();
        
        // Build lookup map: device_key -> power_mode
        // entity_states has separate `state` and `attributes` columns
        const powerModeMap = new Map();
        for (const entity of powerEntities || []) {
          try {
            // Parse attributes column (contains raw_power_mode)
            const attributes = typeof entity.attributes === 'string' 
              ? JSON.parse(entity.attributes) 
              : entity.attributes;
            const powerMode = attributes?.raw_power_mode || entity.state;
            
            // Extract device key from entity_id (e.g., "roku.the_hanger.power" -> "the_hanger")
            const parts = entity.entity_id.split('.');
            if (parts.length >= 2) {
              powerModeMap.set(parts[1], powerMode);
            }
          } catch (e) { /* ignore parse errors */ }
        }
        
        devices = result.map(d => {
          // Match device to power entity by converting friendly_name to snake_case
          const deviceKey = (d.friendly_name || d.name || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '');
          const powerMode = powerModeMap.get(deviceKey);
          
          return {
            id: d.id,
            device_id: d.id,
            name: d.friendly_name || d.name || 'Unknown Roku',
            ip_address: d.ip_address,
            status: d.online ? 'online' : 'offline',
            last_seen_at: d.last_seen_at,
            model: d.model,
            manufacturer: d.manufacturer,
            serial_number: d.serial_number,
            firmware_version: d.firmware_version,
            online: d.online,
            power_mode: powerMode || null,
            discovered_at: d.discovered_at,
            consecutive_failures: d.consecutive_failures
          };
        });
      }
    } catch (err) {
      api.log(`Failed to query device_registry: ${err.message}`, 'warn');
    }
    
    // FALLBACK 1: Try roku_devices table if device_registry is empty
    if (devices.length === 0) {
      const localDevices = await deviceStore.getAllDevices();
      if (localDevices && localDevices.length > 0) {
        devices = localDevices.map(d => ({
          id: d.device_id || d.id,
          device_id: d.device_id || d.id,
          name: d.name || 'Unknown Roku',
          ip_address: d.ip_address,
          status: d.status || 'unknown',
          last_seen_at: d.last_seen_at,
          model: d.model,
          manufacturer: d.metadata?.vendorName || 'Roku',
          serial_number: d.serial_number,
          firmware_version: d.software_version,
          online: d.status === 'online' ? 1 : 0,
          power_mode: d.power_mode,
          metadata: d.metadata
        }));
      }
    }
    
    // FALLBACK 2: Try entity_states for device names
    if (devices.length === 0) {
      try {
        const result = await api.queryBuilder('entity_states')
          .where('entity_id', 'LIKE', 'roku.%')
          .get();
        
        if (result && result.length > 0) {
          const deviceMap = new Map();
          for (const entity of result) {
            const parts = entity.entity_id.split('.');
            if (parts.length >= 2 && parts[0] === 'roku') {
              const deviceKey = parts[1];
              if (!deviceMap.has(deviceKey)) {
                deviceMap.set(deviceKey, {
                  id: deviceKey,
                  device_id: deviceKey,
                  name: deviceKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
                  status: 'unknown'
                });
              }
            }
          }
          devices = Array.from(deviceMap.values());
        }
      } catch (err) {
        api.log(`Failed to query entity_states: ${err.message}`, 'warn');
      }
    }
    
    return { success: true, devices };
  });

  // GET /devices/:id - Get single device
  api.registerRoute('GET', '/devices/:id', async ({ params }) => {
    const device = await findDevice(params.id);
    if (!device) {
      return { success: false, error: 'Device not found', status: 404 };
    }
    return { success: true, device };
  });

  // GET /devices/:id/apps - Get installed apps
  api.registerRoute('GET', '/devices/:id/apps', async ({ params }) => {
    const device = await findDevice(params.id);
    if (!device) {
      return { success: false, error: 'Device not found', status: 404 };
    }

    const client = getClient(device.ip_address);
    const apps = await client.getApps();
    return { success: true, apps };
  });

  // GET /devices/:id/active-app - Get active app
  api.registerRoute('GET', '/devices/:id/active-app', async ({ params }) => {
    const device = await findDevice(params.id);
    if (!device) {
      return { success: false, error: 'Device not found', status: 404 };
    }

    const client = getClient(device.ip_address);
    const activeApp = await client.getActiveApp();
    return { success: true, activeApp };
  });

  // GET /devices/:id/info - Get detailed device info
  api.registerRoute('GET', '/devices/:id/info', async ({ params }) => {
    const device = await findDevice(params.id);
    if (!device) {
      return { success: false, error: 'Device not found', status: 404 };
    }

    try {
      const client = getClient(device.ip_address);
      const info = await client.getDeviceInfo();
      return { success: true, info };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // GET /devices/:id/access - Get mobile access level (full/limited/disabled)
  api.registerRoute('GET', '/devices/:id/access', async ({ params }) => {
    const device = await findDevice(params.id);
    if (!device) {
      return { success: false, error: 'Device not found', status: 404 };
    }

    try {
      const client = getClient(device.ip_address);
      const access = await client.checkMobileControlAccess();
      return { success: true, access };
    } catch (error) {
      return { success: true, access: { level: 'disabled', canControl: false, canQueryApps: false } };
    }
  });

  // GET /devices/mobile-access/all - Get mobile access level for all devices
  api.registerRoute('GET', '/devices/mobile-access/all', async () => {
    try {
      const devices = await api.model('device_registry').getAll();
      const rokuDevices = devices.filter(d => d.type === 'roku');
      
      const accessMap = {};
      for (const device of rokuDevices) {
        try {
          const client = getClient(device.ip_address);
          const access = await client.checkMobileControlAccess();
          accessMap[device.id] = access;
        } catch {
          accessMap[device.id] = { level: 'disabled', canControl: false, canQueryApps: false };
        }
      }
      
      return { success: true, accessMap };
    } catch (error) {
      return { success: false, error: error.message, accessMap: {} };
    }
  });

  // POST /devices/:id/keypress/:key - Send keypress
  api.registerRoute('POST', '/devices/:id/keypress/:key', async ({ params }) => {
    const device = await findDevice(params.id);
    if (!device) {
      return { success: false, error: 'Device not found', status: 404 };
    }

    const client = getClient(device.ip_address);
    await client.keypress(params.key);
    return { success: true, message: `Sent ${params.key} to ${device.name}` };
  });

  // POST /devices/:id/launch/:appId - Launch app
  api.registerRoute('POST', '/devices/:id/launch/:appId', async ({ params }) => {
    const device = await findDevice(params.id);
    if (!device) {
      return { success: false, error: 'Device not found', status: 404 };
    }

    const client = getClient(device.ip_address);
    await client.launchApp(params.appId);
    return { success: true, message: `Launched app ${params.appId} on ${device.name}` };
  });

  // POST /devices/:id/power/on - Power on
  api.registerRoute('POST', '/devices/:id/power/on', async ({ params }) => {
    const device = await findDevice(params.id);
    if (!device) {
      return { success: false, error: 'Device not found', status: 404 };
    }

    const client = getClient(device.ip_address);
    await client.powerOn();
    return { success: true, message: `Powered on ${device.name}` };
  });

  // POST /devices/:id/power/off - Power off
  api.registerRoute('POST', '/devices/:id/power/off', async ({ params }) => {
    const device = await findDevice(params.id);
    if (!device) {
      return { success: false, error: 'Device not found', status: 404 };
    }

    const client = getClient(device.ip_address);
    await client.powerOff();
    return { success: true, message: `Powered off ${device.name}` };
  });

  // POST /devices/add - Manually add device by IP
  api.registerRoute('POST', '/devices/add', async ({ body }) => {
    const { ip_address } = body;
    if (!ip_address) {
      return { success: false, error: 'IP address required', status: 400 };
    }

    // Check if already registered
    const existing = await deviceStore.getDeviceByIp(ip_address);
    if (existing) {
      return { success: false, error: 'Device already registered', status: 409 };
    }

    // Verify it's a Roku
    try {
      const client = new RokuClient(ip_address);
      const info = await client.getDeviceInfo();

      if (!info.vendorName?.toLowerCase().includes('roku')) {
        return { success: false, error: 'Device is not a Roku', status: 400 };
      }

      // Treat as discovered candidate
      await handleDiscoveredCandidate({ ip_address, mac_address: null });

      const device = await deviceStore.getDeviceByIp(ip_address);
      return { success: true, device };

    } catch (error) {
      return { success: false, error: `Cannot reach device: ${error.message}`, status: 400 };
    }
  });

  // DELETE /devices/:id - Remove device
  api.registerRoute('DELETE', '/devices/:id', async ({ params }) => {
    const device = await deviceStore.getDevice(params.id);
    if (!device) {
      return { success: false, error: 'Device not found', status: 404 };
    }

    await deviceStore.deleteDevice(params.id);

    // Unregister from global registry - this will stop polling via device:removed event
    await api.unregisterDevice(params.id);

    api.broadcast('roku:device-removed', { deviceId: params.id });

    return { success: true, message: `Removed ${device.name}` };
  });

  // POST /devices/:id/poll - Force immediate poll via central polling manager
  api.registerRoute('POST', '/devices/:id/poll', async ({ params }) => {
    const device = await deviceStore.getDevice(params.id);
    if (!device) {
      return { success: false, error: 'Device not found', status: 404 };
    }

    // The central polling manager exposes poll-now via device-discovery API
    if (api.globalEventBus) {
      api.globalEventBus.emit('polling:poll-now', { deviceId: device.device_id || params.id });
    }
    
    const updated = await deviceStore.getDevice(params.id);
    return { success: true, device: updated };
  });

  // GET /settings - Get extension settings
  // Uses the core api.getConfig() which stores in the extensions table
  api.registerRoute('GET', '/settings', async () => {
    try {
      const config = await api.getConfig() || {};
      
      // Default values
      const settings = {
        log_level: config.log_level || 'warn',
        ...config
      };
      
      return { success: true, settings };
    } catch (err) {
      api.log(`Failed to get settings: ${err.message}`, 'error');
      return { success: true, settings: { log_level: 'warn' } };
    }
  });

  // PUT /settings - Update extension settings
  // Uses the core api.setConfig() which stores in the extensions table
  api.registerRoute('PUT', '/settings', async ({ body }) => {
    try {
      // Get existing config and merge with new settings
      const existingConfig = await api.getConfig() || {};
      const newConfig = { ...existingConfig, ...body };
      
      await api.setConfig(newConfig);
      
      return { success: true };
    } catch (err) {
      api.log(`Failed to save settings: ${err.message}`, 'error');
      return { success: false, error: err.message };
    }
  });
}

/**
 * Register automation action handlers
 * Action keys MUST match automation.json definitions
 */
function registerAutomationActions() {
  // Power On action - key matches automation.json: "power_on"
  api.registerAction('power_on', async (params, triggerData = {}) => {
    const deviceId = params.device_id || params.deviceId || triggerData.device_id || triggerData.deviceId;
    if (!deviceId) throw new Error('device_id is required');
    
    const device = await findDevice(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not found`);
    
    const client = getClient(device.ip_address);
    await client.powerOn();
    api.log(`Automation: Powered on ${device.name}`, 'debug');
    return { success: true, device_name: device.name };
  }, 'Power On Roku', {
    category: 'media',
    description: 'Wake up a Roku device from standby'
  });

  // Power Off action - key matches automation.json: "power_off"
  api.registerAction('power_off', async (params, triggerData = {}) => {
    const deviceId = params.device_id || params.deviceId || triggerData.device_id || triggerData.deviceId;
    if (!deviceId) throw new Error('device_id is required');
    
    const device = await findDevice(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not found`);
    
    const client = getClient(device.ip_address);
    await client.powerOff();
    api.log(`Automation: Powered off ${device.name}`, 'debug');
    return { success: true, device_name: device.name };
  }, 'Power Off Roku', {
    category: 'media',
    description: 'Put a Roku device into standby'
  });

  // Launch App action - key matches automation.json: "launch_app"
  // Handler receives (params, triggerData) - triggerData contains the trigger context
  api.registerAction('launch_app', async (params, triggerData = {}) => {
    // Get device_id from params first, then fall back to trigger context
    const deviceId = params.device_id || params.deviceId || triggerData.device_id || triggerData.deviceId;
    const appId = params.app_id || params.appId;
    
    if (!deviceId) {
      throw new Error('device_id is required - provide it in action params or use a device trigger');
    }
    
    const device = await findDevice(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not found`);
    
    const client = getClient(device.ip_address);
    await client.launchApp(appId);
    api.log(`Automation: Launched app ${appId} on ${device.name}`, 'debug');
    return { success: true, device_name: device.name, app_id: appId };
  }, 'Launch Roku App', {
    category: 'media',
    description: 'Launch an app on a Roku device'
  });

  // Keypress action - key matches automation.json: "send_keypress"
  api.registerAction('send_keypress', async (params, triggerData = {}) => {
    const deviceId = params.device_id || params.deviceId || triggerData.device_id || triggerData.deviceId;
    const key = params.key;
    if (!deviceId) throw new Error('device_id is required');
    
    const device = await findDevice(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not found`);
    
    const client = getClient(device.ip_address);
    await client.keypress(key);
    api.log(`Automation: Sent ${key} to ${device.name}`, 'debug');
    return { success: true, device_name: device.name, key };
  }, 'Send Roku Remote Key', {
    category: 'media',
    description: 'Send a remote control key press to a Roku device'
  });
}

/**
 * Called when extension is disabled
 */
export async function onDisable() {
  // Unregister poll adapter - central manager will stop polling roku devices
  api.unregisterDevicePollAdapter('roku');
  
  api.log('Roku Integration disabled', 'info');
}

/**
 * Called when extension is enabled
 */
export async function onEnable() {
  // Re-register poll adapter with central manager
  registerPollAdapter();
  registerInspectorPanel();
  
  api.log('Roku Integration enabled', 'info');
}

/**
 * Called when extension is uninstalled
 */
export async function onUninstall() {
  // Unregister poll adapter
  api.unregisterDevicePollAdapter('roku');
  
  // Unregister discovery handler
  api.globalEventBus.emit('discovery:unregister-handler', {
    extensionName: 'roku-integration',
    deviceType: 'roku'
  });

  api.log('Roku Integration uninstalled', 'info');
}
