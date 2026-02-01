<script>
  import { onMount, onDestroy } from 'svelte';
  import {
    JewelPage,
    Card,
    Button,
    Badge,
    Modal,
    Spinner,
    toasts
  } from '@waiveo/ui';

  let devices = [];
  let subnets = [];
  let loading = true;
  let selectedDevice = null;
  let showRemoteModal = false;
  let showAddModal = false;
  let addIp = '';
  let addLoading = false;
  let deviceApps = [];
  let activeApp = null;
  let appsLoading = false;
  let filterSubnet = 'all';
  let entityStates = {}; // Store entity states by entityId
  let hiddenDevices = []; // Array of hidden device IDs
  let showHidden = false; // Toggle to show/hide hidden devices
  let deviceAccess = {}; // { deviceId: { level: 'full'|'limited', canControl: bool } }
  
  // WebSocket subscriptions (uses global window.waiveoWebSocket)
  let unsubscribeStateChanged = null;
  let unsubscribeDeviceAdded = null;
  let unsubscribeDeviceRemoved = null;
  
  // Remote modal tabs
  let activeTab = 'remote'; // 'remote' | 'apps' | 'info'
  let appFilter = '';
  let favoriteApps = {}; // { deviceId: [appId, appId, ...] }
  let deviceInfo = null;
  let deviceInfoLoading = false;
  
  // Custom tags
  let deviceTags = {}; // { deviceId: ['tag1', 'tag2', ...] }
  let filterTag = 'all'; // 'all' or a specific tag
  let showTagInput = null; // deviceId to show tag input for
  let newTagValue = '';

  // Use centralized device registry API - filter by device_type=roku
  const DEVICES_API = '/api/devices/entities';
  const INTEGRATION_API = '/api/extensions/roku-integration';

  // Lock body scroll when any modal is open
  $: {
    const anyModalOpen = showRemoteModal || showAddModal;
    if (typeof document !== 'undefined') {
      document.body.style.overflow = anyModalOpen ? 'hidden' : '';
    }
  }

  // Create a map of subnet CIDR to friendly name
  $: subnetNameMap = subnets.reduce((acc, s) => {
    acc[s.subnet] = s.friendly_name || s.subnet;
    return acc;
  }, {});

  // Get subnet name for an IP address
  function getSubnetForIp(ip) {
    for (const subnet of subnets) {
      if (ipInSubnet(ip, subnet.subnet)) {
        return subnet.subnet;
      }
    }
    return null;
  }

  function ipInSubnet(ip, cidr) {
    if (!ip || !cidr) return false;
    const [subnetIp, maskBits] = cidr.split('/');
    const mask = parseInt(maskBits) || 24;
    
    const ipParts = ip.split('.').map(Number);
    const subnetParts = subnetIp.split('.').map(Number);
    
    const ipNum = (ipParts[0] << 24) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3];
    const subnetNum = (subnetParts[0] << 24) + (subnetParts[1] << 16) + (subnetParts[2] << 8) + subnetParts[3];
    const maskNum = ~((1 << (32 - mask)) - 1) >>> 0;
    
    return (ipNum & maskNum) === (subnetNum & maskNum);
  }

  function getSubnetName(ip) {
    const subnet = getSubnetForIp(ip);
    return subnetNameMap[subnet] || subnet || 'Unknown';
  }

  // Get unique subnets from devices
  $: uniqueSubnets = [...new Set(devices.map(d => getSubnetForIp(d.ip_address)).filter(Boolean))];
  
  // Get all unique custom tags across all devices
  $: allTags = [...new Set(Object.values(deviceTags).flat())].sort();

  $: filteredDevices = (() => {
    let filtered = devices;
    
    // Filter by subnet
    if (filterSubnet !== 'all') {
      filtered = filtered.filter(d => getSubnetForIp(d.ip_address) === filterSubnet);
    }
    
    // Filter by custom tag
    if (filterTag !== 'all') {
      filtered = filtered.filter(d => {
        const tags = deviceTags[d.id || d.device_id] || [];
        return tags.includes(filterTag);
      });
    }
    
    // Filter out hidden devices unless showHidden is true
    if (!showHidden) {
      filtered = filtered.filter(d => !hiddenDevices.includes(d.id || d.device_id));
    }
    return filtered;
  })();

  // Get count of hidden devices
  $: hiddenCount = devices.filter(d => hiddenDevices.includes(d.id || d.device_id)).length;
  
  // Get tags for a specific device
  function getDeviceTags(device) {
    return deviceTags[device.id || device.device_id] || [];
  }

  // Get power state for a device from entity states or device data
  function getDevicePowerState(device) {
    const deviceName = (device.name || device.friendly_name || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    
    // First check real-time entity states (from WebSocket updates)
    for (const [entityId, state] of Object.entries(entityStates)) {
      // NEW: Check media_player.* entities (HA-style naming)
      if (entityId === `media_player.${deviceName}`) {
        // State is 'on', 'off', 'playing', 'idle'
        const mainState = state?.state;
        if (mainState === 'off') return 'off';
        if (mainState === 'idle') return 'standby';
        if (mainState === 'on' || mainState === 'playing') return 'on';
        return mainState || 'unknown';
      }
      // LEGACY: Check roku.*.power entities (old naming)
      if (entityId.includes(deviceName) && entityId.endsWith('.power')) {
        return state?.state || 'unknown';
      }
    }
    
    // Check device.entities if available
    if (device.entities) {
      // NEW: Check for media_player entity
      const mediaPlayerEntity = device.entities.find(e => e.entity_id?.startsWith('media_player.'));
      if (mediaPlayerEntity?.state) {
        const state = mediaPlayerEntity.state?.state || mediaPlayerEntity.state;
        if (state === 'off') return 'off';
        if (state === 'idle') return 'standby';
        if (state === 'on' || state === 'playing') return 'on';
        return state;
      }
      // LEGACY: Check for power entity
      const powerEntity = device.entities.find(e => e.entity_type === 'power' || e.entity_id?.endsWith('.power'));
      if (powerEntity?.state) {
        return powerEntity.state;
      }
    }
    
    // Fall back to device's power_mode field (interpreted state: on/standby/off)
    if (device.power_mode) {
      const mode = device.power_mode.toLowerCase();
      // The backend now stores interpreted states: 'on', 'standby', 'off'
      if (mode === 'on' || mode === 'standby' || mode === 'off') {
        return mode;
      }
      // Handle legacy raw power modes from Roku API
      // IMPORTANT: "Ready" means display is OFF - it's standby, not on!
      if (mode === 'poweron' || mode === 'power on') return 'on';
      if (mode === 'standby' || mode === 'displayoff' || mode === 'display off' || mode === 'ready') return 'standby';
    }
    
    return 'unknown';
  }

  // Get active app for a device
  function getDeviceActiveApp(device) {
    const deviceName = (device.name || device.friendly_name || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    for (const [entityId, state] of Object.entries(entityStates)) {
      // NEW: media_player.* has active_app in attributes
      if (entityId === `media_player.${deviceName}`) {
        return state?.attributes?.active_app || null;
      }
      // LEGACY: roku.*.active_app entity
      if (entityId.includes(deviceName) && entityId.endsWith('.active_app')) {
        return state?.attributes?.name || state?.state?.name || null;
      }
    }
    return null;
  }

  onMount(async () => {
    loading = true;
    
    // Load metadata from server (in parallel)
    await Promise.all([
      loadHiddenDevices(),
      loadFavoriteApps(),
      loadDeviceTags()
    ]);
    await loadSubnets();
    await loadDevices();
    await loadEntityStates();
    loading = false;

    // Subscribe to real-time events via global WebSocket
    if (typeof window !== 'undefined' && window.waiveoWebSocket) {
      unsubscribeStateChanged = window.waiveoWebSocket.subscribe('state_changed', handleStateChanged);
      unsubscribeDeviceAdded = window.waiveoWebSocket.subscribe('device:added', handleDeviceAdded);
      unsubscribeDeviceRemoved = window.waiveoWebSocket.subscribe('device:removed', handleDeviceRemoved);
    }
  });

  async function loadSubnets() {
    try {
      const res = await fetch('/api/extensions/device-discovery/subnets');
      const data = await res.json();
      subnets = data.subnets || [];
    } catch (error) {
      console.error('Error loading subnets:', error);
    }
  }

  onDestroy(() => {
    // Unsubscribe from WebSocket events
    if (unsubscribeStateChanged) unsubscribeStateChanged();
    if (unsubscribeDeviceAdded) unsubscribeDeviceAdded();
    if (unsubscribeDeviceRemoved) unsubscribeDeviceRemoved();
    
    // Restore body scroll when component unmounts
    if (typeof document !== 'undefined') {
      document.body.style.overflow = '';
    }
  });

  function handleDeviceAdded({ device }) {
    // Only handle Roku devices
    if (device.device_type === 'roku' || device.integration === 'roku-integration') {
      devices = [...devices, device];
      toasts.success(`Discovered Roku: ${device.name}`);
    }
  }

  function handleDeviceRemoved({ deviceId }) {
    devices = devices.filter(d => d.id !== deviceId && d.device_id !== deviceId);
  }

  // Handle state changes from WebSocket
  function handleStateChanged(data) {
    const { entity_id, old_state, new_state, attributes, timestamp } = data || {};
    
    // Check if this is a Roku entity (supports both old roku.* and new media_player.* naming)
    const isRokuEntity = entity_id?.startsWith('roku.') || 
                         (entity_id?.startsWith('media_player.') && attributes?.device_type === 'roku');
    
    if (isRokuEntity) {
      // Update entity states
      entityStates = {
        ...entityStates,
        [entity_id]: { state: new_state, attributes, timestamp }
      };

      // If this affects the selected device, update active app
      if (selectedDevice) {
        const deviceSlug = selectedDevice.friendly_name?.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 
                          selectedDevice.name?.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        
        // LEGACY: roku.*.active_app
        if (entity_id.includes('active_app') && entity_id.includes(deviceSlug)) {
          activeApp = { name: new_state, id: attributes?.app_id || 'unknown' };
        }
        // NEW: media_player.* has active_app in attributes
        if (entity_id === `media_player.${deviceSlug}` && attributes?.active_app) {
          activeApp = { name: attributes.active_app, id: attributes.active_app_id || 'unknown' };
        }
      }

      // Handle significant state changes
      if (old_state !== new_state) {
        
        // Show toast for power state changes
        // LEGACY: roku.*.power entity
        if (entity_id.endsWith('.power')) {
          const deviceName = entity_id.split('.')[1].replace(/_/g, ' ');
          if (new_state === 'on') {
            toasts.success(`${deviceName} powered on`, { duration: 2000 });
          } else if (new_state === 'off') {
            toasts.info(`${deviceName} powered off`, { duration: 2000 });
          }
        }
        // NEW: media_player.* state changes
        if (entity_id.startsWith('media_player.')) {
          const deviceName = attributes?.friendly_name || entity_id.split('.')[1].replace(/_/g, ' ');
          if (new_state === 'on' && old_state === 'off') {
            toasts.success(`${deviceName} powered on`, { duration: 2000 });
          } else if (new_state === 'off' && old_state !== 'off') {
            toasts.info(`${deviceName} powered off`, { duration: 2000 });
          }
        }
      }
      
      // Trigger reactivity update for devices
      devices = devices;
    }
  }

  async function loadDevices() {
    try {
      // Load from centralized device registry, filter for Roku devices
      const res = await fetch(`${DEVICES_API}?type=roku`);
      const data = await res.json();
      
      // Transform to expected format
      devices = (data.devices || []).map(d => ({
        ...d,
        device_id: d.id,
        name: d.friendly_name || d.name || `${d.manufacturer || ''} ${d.model || d.ip_address}`.trim(),
        status: (d.online === 1 || d.online === true || d.is_online) ? 'online' : 'offline',
        online: d.online === 1 || d.online === true || d.is_online
      }));
      
      // Load power states from roku-specific API (has correct interpreted state)
      await loadPowerStates();
      
      // Load mobile access levels for all devices (in background)
      loadDeviceAccessLevels();
    } catch (error) {
      toasts.error('Failed to load devices');
    }
  }
  
  // Load power states from roku-specific API
  async function loadPowerStates() {
    try {
      const res = await fetch(`${INTEGRATION_API}/devices`);
      const data = await res.json();
      if (data.success && data.devices) {
        // Create a map of device_id -> power_mode
        const powerStates = {};
        for (const d of data.devices) {
          powerStates[d.device_id] = d.power_mode;
        }
        
        // Update devices with power states
        devices = devices.map(d => ({
          ...d,
          power_mode: powerStates[d.id] || powerStates[d.device_id] || d.power_mode
        }));
      }
    } catch (error) {
      console.error('Failed to load power states:', error);
    }
  }
  
  // Load cached mobile access from server (instant - stored in device metadata)
  async function loadCachedMobileAccess() {
    try {
      const res = await fetch(`${INTEGRATION_API}/devices/mobile-access/all`);
      const data = await res.json();
      return data.success ? data.accessMap : {};
    } catch {
      return {};
    }
  }
  
  // Check mobile control access level for all devices
  async function loadDeviceAccessLevels() {
    if (!devices || devices.length === 0) return;
    
    // First load cached values from server (instant display)
    const cachedAccess = await loadCachedMobileAccess();
    
    if (Object.keys(cachedAccess).length > 0) {
      // Apply cached values immediately
      devices = devices.map(device => ({
        ...device,
        mobileAccess: cachedAccess[device.id] ? { level: cachedAccess[device.id].level, cached: true } : null
      }));
    }
    
    // Then refresh from API in background (updates cache on server)
    const results = await Promise.all(
      devices.map(async (device) => {
        const deviceId = device.id;
        if (!deviceId) return { id: deviceId, access: null };
        
        try {
          const res = await fetch(`${INTEGRATION_API}/devices/${deviceId}/access`);
          const data = await res.json();
          return { id: deviceId, access: data.success ? data.access : null };
        } catch (err) {
          return { id: deviceId, access: null };
        }
      })
    );
    
    // Update devices with fresh access info (server already cached it)
    devices = devices.map(device => {
      const result = results.find(r => r.id === device.id);
      return {
        ...device,
        mobileAccess: result?.access || device.mobileAccess
      };
    });
  }

  // Load entity states for all Roku devices
  async function loadEntityStates() {
    try {
      const res = await fetch('/api/entities/states?integration=roku-integration');
      const data = await res.json();
      if (data.states) {
        entityStates = data.states;
      }
    } catch (error) {
      console.error('Error loading entity states:', error);
    }
  }

  async function openRemote(device) {
    selectedDevice = device;
    activeTab = 'remote'; // Reset to remote tab
    appFilter = ''; // Clear filter
    deviceInfo = null;
    showRemoteModal = true;
    await loadDeviceApps();
    await loadActiveApp();
    loadDeviceInfo(); // Load in background
  }

  async function loadDeviceApps() {
    if (!selectedDevice) return;
    appsLoading = true;
    try {
      const deviceId = selectedDevice.id || selectedDevice.device_id;
      const res = await fetch(`${INTEGRATION_API}/devices/${deviceId}/apps`);
      const data = await res.json();
      deviceApps = data.apps || [];
    } catch (error) {
      deviceApps = [];
    }
    appsLoading = false;
  }

  async function loadActiveApp() {
    if (!selectedDevice) return;
    try {
      const deviceId = selectedDevice.id || selectedDevice.device_id;
      const res = await fetch(`${INTEGRATION_API}/devices/${deviceId}/active-app`);
      const data = await res.json();
      activeApp = data.activeApp || { name: 'Home', id: 'home' };
    } catch {
      activeApp = { name: 'Home', id: 'home' };
    }
  }

  async function sendKey(key) {
    if (!selectedDevice) return;
    try {
      const deviceId = selectedDevice.id || selectedDevice.device_id;
      await fetch(`${INTEGRATION_API}/devices/${deviceId}/keypress/${key}`, { method: 'POST' });
    } catch (error) {
      toasts.error(`Failed to send ${key}`);
    }
  }

  async function launchApp(appId) {
    if (!selectedDevice) return;
    try {
      const deviceId = selectedDevice.id || selectedDevice.device_id;
      await fetch(`${INTEGRATION_API}/devices/${deviceId}/launch/${appId}`, { method: 'POST' });
      toasts.success('App launched');
      setTimeout(loadActiveApp, 1000);
    } catch (error) {
      toasts.error('Failed to launch app');
    }
  }

  // Load device info from Roku API
  async function loadDeviceInfo() {
    if (!selectedDevice) return;
    deviceInfoLoading = true;
    try {
      const res = await fetch(`${INTEGRATION_API}/devices/${selectedDevice.id || selectedDevice.device_id}/info`);
      const data = await res.json();
      deviceInfo = data.success ? data.info : null;
    } catch (error) {
      deviceInfo = null;
    }
    deviceInfoLoading = false;
  }

  // Load favorite apps from server metadata
  async function loadFavoriteApps() {
    try {
      const res = await fetch('/api/devices/metadata/roku-integration?key=favorite_apps');
      const data = await res.json();
      if (data.success && data.metadata) {
        // Convert metadata to favoriteApps format
        favoriteApps = {};
        for (const [deviceId, meta] of Object.entries(data.metadata)) {
          if (meta.favorite_apps && Array.isArray(meta.favorite_apps)) {
            favoriteApps[deviceId] = meta.favorite_apps;
          }
        }
      }
    } catch (e) {
      favoriteApps = {};
    }
  }

  // Save favorite apps to server metadata
  async function saveFavoriteAppsForDevice(deviceId, apps) {
    try {
      await fetch(`/api/devices/${deviceId}/metadata/roku-integration/favorite_apps`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: apps })
      });
    } catch (e) {
      console.error('Failed to save favorites:', e);
    }
  }

  // Toggle favorite app
  async function toggleFavorite(appId) {
    const deviceId = selectedDevice?.id || selectedDevice?.device_id;
    if (!deviceId) return;
    
    if (!favoriteApps[deviceId]) {
      favoriteApps[deviceId] = [];
    }
    
    if (favoriteApps[deviceId].includes(appId)) {
      favoriteApps[deviceId] = favoriteApps[deviceId].filter(id => id !== appId);
    } else {
      favoriteApps[deviceId] = [...favoriteApps[deviceId], appId];
    }
    favoriteApps = { ...favoriteApps }; // Trigger reactivity
    
    // Save to server
    await saveFavoriteAppsForDevice(deviceId, favoriteApps[deviceId]);
  }

  // Check if app is favorite
  function isFavorite(appId) {
    const deviceId = selectedDevice?.id || selectedDevice?.device_id;
    return favoriteApps[deviceId]?.includes(appId) || false;
  }

  // Load device tags from server metadata
  async function loadDeviceTags() {
    try {
      const res = await fetch('/api/devices/metadata/roku-integration?key=tags');
      const data = await res.json();
      if (data.success && data.metadata) {
        deviceTags = {};
        for (const [deviceId, meta] of Object.entries(data.metadata)) {
          if (meta.tags && Array.isArray(meta.tags)) {
            deviceTags[deviceId] = meta.tags;
          }
        }
      }
    } catch (e) {
      deviceTags = {};
    }
  }

  // Save tags for a device
  async function saveDeviceTags(deviceId, tags) {
    try {
      await fetch(`/api/devices/${deviceId}/metadata/roku-integration/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: tags })
      });
    } catch (e) {
      console.error('Failed to save tags:', e);
    }
  }

  // Add a tag to a device
  async function addTagToDevice(device, tag) {
    const deviceId = device.id || device.device_id;
    const trimmedTag = tag.trim().toLowerCase();
    if (!trimmedTag) return;
    
    const currentTags = deviceTags[deviceId] || [];
    if (currentTags.includes(trimmedTag)) {
      toasts.warning('Tag already exists');
      return;
    }
    
    const newTags = [...currentTags, trimmedTag];
    deviceTags[deviceId] = newTags;
    deviceTags = { ...deviceTags }; // Trigger reactivity
    
    await saveDeviceTags(deviceId, newTags);
    newTagValue = '';
    showTagInput = null;
  }

  // Remove a tag from a device
  async function removeTagFromDevice(device, tag, e) {
    e?.stopPropagation();
    const deviceId = device.id || device.device_id;
    const currentTags = deviceTags[deviceId] || [];
    const newTags = currentTags.filter(t => t !== tag);
    
    deviceTags[deviceId] = newTags;
    deviceTags = { ...deviceTags }; // Trigger reactivity
    
    await saveDeviceTags(deviceId, newTags);
  }

  // Handle tag input keydown
  function handleTagKeydown(e, device) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTagToDevice(device, newTagValue);
    } else if (e.key === 'Escape') {
      showTagInput = null;
      newTagValue = '';
    }
  }

  // Get filtered and sorted apps (favorites first, then filtered)
  $: filteredApps = (() => {
    const deviceId = selectedDevice?.id || selectedDevice?.device_id;
    const favs = favoriteApps[deviceId] || [];
    
    let apps = [...deviceApps];
    
    // Filter by search
    if (appFilter.trim()) {
      const search = appFilter.toLowerCase();
      apps = apps.filter(app => app.name?.toLowerCase().includes(search));
    }
    
    // Sort: favorites first, then alphabetical
    apps.sort((a, b) => {
      const aFav = favs.includes(a.id);
      const bFav = favs.includes(b.id);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    
    return apps;
  })();

  async function powerOn() {
    if (!selectedDevice) return;
    try {
      const deviceId = selectedDevice.id || selectedDevice.device_id;
      await fetch(`${INTEGRATION_API}/devices/${deviceId}/power/on`, { method: 'POST' });
      toasts.success('Power on sent');
    } catch (error) {
      toasts.error('Failed to power on');
    }
  }

  async function powerOff() {
    if (!selectedDevice) return;
    try {
      const deviceId = selectedDevice.id || selectedDevice.device_id;
      await fetch(`${INTEGRATION_API}/devices/${deviceId}/power/off`, { method: 'POST' });
      toasts.success('Power off sent');
    } catch (error) {
      toasts.error('Failed to power off');
    }
  }

  async function addDevice() {
    if (!addIp.trim()) {
      toasts.error('Enter an IP address');
      return;
    }
    addLoading = true;
    try {
      const res = await fetch('/api/devices/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          ip_address: addIp.trim(),
          device_type: 'roku',
          integration: 'roku-integration'
        })
      });
      const data = await res.json();
      if (data.success) {
        toasts.success(`Added ${data.device?.name || 'device'}`);
        await loadDevices();
        showAddModal = false;
        addIp = '';
      } else {
        toasts.error(data.error || 'Failed to add device');
      }
    } catch (error) {
      toasts.error('Failed to add device');
    }
    addLoading = false;
  }

  // Load hidden devices from server metadata
  async function loadHiddenDevices() {
    try {
      const res = await fetch('/api/devices/metadata/roku-integration?key=hidden');
      const data = await res.json();
      if (data.success && data.metadata) {
        // Get all device IDs that are marked as hidden
        hiddenDevices = Object.entries(data.metadata)
          .filter(([_, meta]) => meta.hidden === true)
          .map(([deviceId]) => deviceId);
      }
    } catch (e) {
      hiddenDevices = [];
    }
  }

  // Save hidden device status to server metadata
  async function saveHiddenDevice(deviceId, isHidden) {
    try {
      await fetch(`/api/devices/${deviceId}/metadata/roku-integration/hidden`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: isHidden })
      });
    } catch (e) {
      console.error('Failed to save hidden status:', e);
    }
  }

  // Toggle hide/show a device
  async function toggleHideDevice(device, e) {
    e?.stopPropagation(); // Prevent card click
    const deviceId = device.id || device.device_id;
    const isCurrentlyHidden = hiddenDevices.includes(deviceId);
    
    if (isCurrentlyHidden) {
      hiddenDevices = hiddenDevices.filter(id => id !== deviceId);
      toasts.success(`${device.name} is now visible`);
    } else {
      hiddenDevices = [...hiddenDevices, deviceId];
      toasts.info(`${device.name} hidden`);
    }
    
    // Save to server
    await saveHiddenDevice(deviceId, !isCurrentlyHidden);
  }

  // Check if a device is hidden
  function isDeviceHidden(device) {
    const deviceId = device.id || device.device_id;
    return hiddenDevices.includes(deviceId);
  }

  // Open remote when clicking card
  function handleCardClick(device) {
    openRemote(device);
  }

  $: onlineCount = devices.filter(d => d.status === 'online' || d.online || d.is_online).length;
  $: offlineCount = devices.filter(d => d.status !== 'online').length;

  // Derive power state counts (include entityStates in reactive deps)
  $: powerOnCount = (() => {
    // Access entityStates to make this reactive to state changes
    const _ = Object.keys(entityStates).length;
    return devices.filter(d => getDevicePowerState(d) === 'on').length;
  })();
  $: standbyCount = (() => {
    const _ = Object.keys(entityStates).length;
    return devices.filter(d => getDevicePowerState(d) === 'standby').length;
  })();
</script>

<JewelPage
  title="Roku Devices"
  subtitle="Control your Roku devices"
  icon="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
  iconGradient="purple"
>
  <svelte:fragment slot="actions">
    <Button variant="secondary" on:click={() => showAddModal = true}>
      <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
      </svg>
      Add Manually
    </Button>
    <Button variant="primary" on:click={loadDevices}>
      <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      Refresh
    </Button>
  </svelte:fragment>

  <!-- Stats with flat icons -->
  <div class="stats-row">
    <Card padding="md" class="stat-card">
      <div class="stat-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
          <polyline points="17 2 12 7 7 2" />
        </svg>
      </div>
      <div class="stat-value">{devices.length}</div>
      <div class="stat-label">Total Devices</div>
    </Card>
    <Card padding="md" class="stat-card online">
      <div class="stat-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01M4.93 13.222a10 10 0 0114.14 0M1.757 10.04a14.5 14.5 0 0120.486 0" />
        </svg>
      </div>
      <div class="stat-value">{onlineCount}</div>
      <div class="stat-label">Online</div>
    </Card>
    <Card padding="md" class="stat-card power-on">
      <div class="stat-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      </div>
      <div class="stat-value">{powerOnCount}</div>
      <div class="stat-label">Power On</div>
    </Card>
    <Card padding="md" class="stat-card standby">
      <div class="stat-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      </div>
      <div class="stat-value">{standbyCount}</div>
      <div class="stat-label">Standby</div>
    </Card>
  </div>

  <!-- Filters -->
  {#if uniqueSubnets.length > 1 || allTags.length > 0 || hiddenCount > 0}
    <div class="filter-tags">
      <!-- Network filters -->
      {#if uniqueSubnets.length > 1}
        <span class="filter-group-label">Network:</span>
        <button 
          class="filter-tag" 
          class:active={filterSubnet === 'all'}
          on:click={() => filterSubnet = 'all'}
        >
          All ({devices.length})
        </button>
        {#each uniqueSubnets as subnet}
          <button 
            class="filter-tag" 
            class:active={filterSubnet === subnet}
            on:click={() => filterSubnet = subnet}
          >
            {subnetNameMap[subnet] || subnet} ({devices.filter(d => getSubnetForIp(d.ip_address) === subnet).length})
          </button>
        {/each}
      {/if}
      
      <!-- Custom tag filters -->
      {#if allTags.length > 0}
        <span class="filter-divider"></span>
        <span class="filter-group-label">Tags:</span>
        <button 
          class="filter-tag tag-filter" 
          class:active={filterTag === 'all'}
          on:click={() => filterTag = 'all'}
        >
          All
        </button>
        {#each allTags as tag}
          <button 
            class="filter-tag tag-filter" 
            class:active={filterTag === tag}
            on:click={() => filterTag = tag}
          >
            #{tag} ({Object.entries(deviceTags).filter(([_, tags]) => tags.includes(tag)).length})
          </button>
        {/each}
      {/if}
      
      <!-- Hidden toggle -->
      {#if hiddenCount > 0}
        <button 
          class="filter-tag hidden-tag" 
          class:active={showHidden}
          on:click={() => showHidden = !showHidden}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            {#if showHidden}
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            {:else}
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>
            {/if}
          </svg>
          Hidden ({hiddenCount})
        </button>
      {/if}
    </div>
  {/if}

  <!-- Device Grid -->
  {#if loading}
    <div class="loading-state">
      <Spinner size="lg" />
      <p>Loading devices...</p>
    </div>
  {:else if devices.length === 0}
    <Card padding="lg">
      <div class="empty-state-content">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
            <polyline points="17 2 12 7 7 2" />
          </svg>
        </div>
        <h3 class="empty-title">No Roku Devices</h3>
        <p class="empty-description">Roku devices will appear here once discovered via a network scan or added manually using the button above.</p>
      </div>
    </Card>
  {:else}
    <div class="device-grid">
      {#each filteredDevices as device (device.id || device.device_id)}
        {@const powerState = getDevicePowerState(device)}
        {@const currentApp = getDeviceActiveApp(device)}
        {@const isHidden = isDeviceHidden(device)}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="device-card-wrapper" class:hidden-device={isHidden} on:click={() => handleCardClick(device)}>
          <Card padding="lg" class="device-card" hover>
            <div class="device-header">
              <div class="device-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
                  <polyline points="17 2 12 7 7 2" />
                </svg>
              </div>
              <button 
                class="hide-btn" 
                class:is-hidden={isHidden}
                on:click={(e) => toggleHideDevice(device, e)}
                title={isHidden ? 'Show device' : 'Hide device'}
              >
                {#if isHidden}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                {:else}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                {/if}
              </button>
            </div>
            <h3 class="device-name">{device.name}</h3>
            <p class="device-model">{device.model || 'Unknown model'}</p>
            
            <!-- Clean info list -->
            <ul class="device-info-list">
              <li class="info-item">
                <svg class="info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
                <span class="info-label">{device.ip_address}</span>
                <span class="info-value">{getSubnetName(device.ip_address)}</span>
              </li>
              <li class="info-item">
                <svg class="info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
                <span class="info-label">Status</span>
                <span class="info-value" class:text-success={device.status === 'online'} class:text-error={device.status !== 'online'}>
                  {device.status === 'online' ? 'Online' : 'Offline'}
                </span>
              </li>
              <li class="info-item">
                <svg class="info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                <span class="info-label">Power</span>
                <span class="info-value" class:text-success={powerState === 'on'} class:text-warning={powerState === 'standby'}>
                  {powerState === 'on' ? 'On' : powerState === 'standby' ? 'Standby' : powerState}
                </span>
              </li>
              {#if device.mobileAccess?.level}
                {@const accessLevel = device.mobileAccess.level.toLowerCase()}
                <li class="info-item">
                  <svg class="info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                    <path d="M12 18h.01" />
                  </svg>
                  <span class="info-label">Mobile</span>
                  <span class="info-value" class:text-success={accessLevel === 'full'} class:text-error={accessLevel !== 'full'}>
                    {accessLevel === 'full' ? 'Enabled' : 'Disabled'}
                  </span>
                </li>
              {/if}
              {#if currentApp && powerState === 'on'}
                <li class="info-item">
                  <svg class="info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <path d="M12 8v8m-4-4h8" />
                  </svg>
                  <span class="info-label">App</span>
                  <span class="info-value">{currentApp}</span>
                </li>
              {/if}
            </ul>
            
            <!-- Tags section (compact) -->
            {#if getDeviceTags(device).length > 0}
              <div class="device-tags-row">
                {#each getDeviceTags(device) as tag}
                  <button 
                    class="tag-chip" 
                    on:click|stopPropagation={() => filterTag = tag}
                    title="Click to filter by this tag"
                  >
                    #{tag}
                    <span 
                      class="remove-tag" 
                      on:click|stopPropagation={(e) => removeTagFromDevice(device, tag, e)}
                      title="Remove tag"
                    >×</span>
                  </button>
                {/each}
              </div>
            {/if}
            
            <!-- Add tag button OR input (inline replacement) -->
            {#if showTagInput === (device.id || device.device_id)}
              <div class="tag-input-wrapper" on:click|stopPropagation>
                <input 
                  type="text" 
                  class="tag-input"
                  placeholder="tag"
                  bind:value={newTagValue}
                  on:keydown={(e) => handleTagKeydown(e, device)}
                  autofocus
                />
                <button class="tag-input-add" on:click={() => addTagToDevice(device, newTagValue)}>+</button>
                <button class="tag-input-cancel" on:click={() => { showTagInput = null; newTagValue = ''; }}>×</button>
              </div>
            {:else}
              <button 
                class="add-tag-link" 
                on:click|stopPropagation={() => { showTagInput = device.id || device.device_id; newTagValue = ''; }}
                title="Add custom tag"
              >
                + Add tag
              </button>
            {/if}
          </Card>
        </div>
      {/each}
    </div>
  {/if}
</JewelPage>

<!-- Remote Control Modal -->
<Modal bind:open={showRemoteModal} title={selectedDevice?.name || 'Remote Control'} size="lg">
  {#if selectedDevice}
    <div class="remote-modal-container">
      <!-- Tabs -->
      <div class="remote-tabs">
        <button class="remote-tab" class:active={activeTab === 'remote'} on:click={() => activeTab = 'remote'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <circle cx="12" cy="14" r="4" />
            <path d="M12 6v2" />
          </svg>
          Remote
        </button>
        <button class="remote-tab" class:active={activeTab === 'apps'} on:click={() => activeTab = 'apps'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
          </svg>
          Apps
        </button>
        <button class="remote-tab" class:active={activeTab === 'info'} on:click={() => activeTab = 'info'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4m0-4h.01" />
          </svg>
          Info
        </button>
      </div>

      <!-- Tab Content -->
      <div class="remote-tab-content">
        {#if activeTab === 'remote'}
          <div class="remote-layout">
            <!-- Active App -->
            <div class="active-app-section">
              <span class="section-label">Now Playing:</span>
              <span class="active-app-name">{activeApp?.name || 'Home'}</span>
            </div>

            <!-- Power Controls -->
            <div class="power-section">
              <Button variant="success" on:click={powerOn}>
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18.36 6.64a9 9 0 11-12.73 0M12 2v10" />
                </svg>
                Power On
              </Button>
              <Button variant="danger" on:click={powerOff}>
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6" />
                </svg>
                Power Off
              </Button>
            </div>

            <!-- Navigation Pad -->
            <div class="nav-pad">
              <div class="nav-row">
                <div class="nav-spacer"></div>
                <Button variant="secondary" class="nav-btn" on:click={() => sendKey('Up')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 15l-6-6-6 6" />
                  </svg>
                </Button>
                <div class="nav-spacer"></div>
              </div>
              <div class="nav-row">
                <Button variant="secondary" class="nav-btn" on:click={() => sendKey('Left')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </Button>
                <Button variant="primary" class="nav-btn ok-btn" on:click={() => sendKey('Select')}>OK</Button>
                <Button variant="secondary" class="nav-btn" on:click={() => sendKey('Right')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </Button>
              </div>
              <div class="nav-row">
                <div class="nav-spacer"></div>
                <Button variant="secondary" class="nav-btn" on:click={() => sendKey('Down')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </Button>
                <div class="nav-spacer"></div>
              </div>
            </div>

            <!-- Control Buttons -->
            <div class="control-row">
              <Button variant="ghost" on:click={() => sendKey('Back')}>
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 12H5m7-7l-7 7 7 7" />
                </svg>
                Back
              </Button>
              <Button variant="ghost" on:click={() => sendKey('Home')}>
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
                Home
              </Button>
              <Button variant="ghost" on:click={() => sendKey('Info')}>
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4m0-4h.01" />
                </svg>
                Info
              </Button>
            </div>

            <!-- Playback Controls -->
            <div class="playback-row">
              <Button variant="secondary" on:click={() => sendKey('Rev')}>
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="19 20 9 12 19 4 19 20" />
                  <line x1="5" y1="19" x2="5" y2="5" />
                </svg>
              </Button>
              <Button variant="primary" on:click={() => sendKey('Play')}>
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              </Button>
              <Button variant="secondary" on:click={() => sendKey('Pause')}>
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="6" y="4" width="4" height="16" />
                  <rect x="14" y="4" width="4" height="16" />
                </svg>
              </Button>
              <Button variant="secondary" on:click={() => sendKey('Fwd')}>
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 4 15 12 5 20 5 4" />
                  <line x1="19" y1="5" x2="19" y2="19" />
                </svg>
              </Button>
            </div>

            <!-- Volume Controls -->
            <div class="volume-row">
              <Button variant="secondary" on:click={() => sendKey('VolumeDown')}>
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 010 7.07" />
                </svg>
                Vol-
              </Button>
              <Button variant="secondary" on:click={() => sendKey('VolumeMute')}>
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
                Mute
              </Button>
              <Button variant="secondary" on:click={() => sendKey('VolumeUp')}>
                <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" />
                </svg>
                Vol+
              </Button>
            </div>
          </div>

        {:else if activeTab === 'apps'}
          <div class="apps-tab-content">
            <!-- Search/Filter -->
            <div class="apps-filter">
              <input 
                type="text" 
                placeholder="Search apps..." 
                bind:value={appFilter}
                class="apps-search"
              />
            </div>
            
            {#if appsLoading}
              <div class="apps-loading"><Spinner size="lg" /></div>
            {:else if filteredApps.length === 0}
              <p class="no-apps">{appFilter ? 'No apps match your search' : 'No apps found'}</p>
            {:else}
              <div class="apps-grid-full">
                {#each filteredApps as app (app.id)}
                  <div class="app-tile-full">
                    <button class="app-icon-btn" on:click={() => launchApp(app.id)} title="Launch {app.name}">
                      <img 
                        src={`http://${selectedDevice.ip_address}:8060/query/icon/${app.id}`} 
                        alt={app.name}
                        on:error={(e) => e.target.style.display = 'none'}
                      />
                    </button>
                    <span class="app-name-full">{app.name}</span>
                    <button 
                      class="favorite-btn" 
                      class:is-favorite={isFavorite(app.id)}
                      on:click={() => toggleFavorite(app.id)}
                      title={isFavorite(app.id) ? 'Remove from favorites' : 'Add to favorites'}
                    >
                      <svg viewBox="0 0 24 24" fill={isFavorite(app.id) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>

        {:else if activeTab === 'info'}
          <div class="info-tab-content">
            {#if deviceInfoLoading}
              <div class="info-loading"><Spinner size="lg" /></div>
            {:else if deviceInfo}
              <div class="info-grid">
                <div class="info-section">
                  <h4>Device</h4>
                  <dl class="info-list">
                    <dt>Name</dt>
                    <dd>{deviceInfo['friendly-device-name'] || deviceInfo.friendlyDeviceName || selectedDevice.name}</dd>
                    <dt>Model</dt>
                    <dd>{deviceInfo['model-name'] || deviceInfo.modelName || 'Unknown'}</dd>
                    <dt>Vendor</dt>
                    <dd>{deviceInfo['vendor-name'] || deviceInfo.vendorName || 'Roku'}</dd>
                    <dt>Serial</dt>
                    <dd>{deviceInfo['serial-number'] || deviceInfo.serialNumber || 'N/A'}</dd>
                  </dl>
                </div>
                <div class="info-section">
                  <h4>Software</h4>
                  <dl class="info-list">
                    <dt>Version</dt>
                    <dd>{deviceInfo['software-version'] || deviceInfo.softwareVersion || 'N/A'}</dd>
                    <dt>Build</dt>
                    <dd>{deviceInfo['software-build'] || deviceInfo.softwareBuild || 'N/A'}</dd>
                    <dt>UI Version</dt>
                    <dd>{deviceInfo['ui-software-version'] || deviceInfo.uiSoftwareVersion || 'N/A'}</dd>
                  </dl>
                </div>
                <div class="info-section">
                  <h4>Network</h4>
                  <dl class="info-list">
                    <dt>IP Address</dt>
                    <dd>{selectedDevice.ip_address}</dd>
                    <dt>WiFi MAC</dt>
                    <dd>{deviceInfo['wifi-mac'] || deviceInfo.wifiMac || 'N/A'}</dd>
                    <dt>Network</dt>
                    <dd>{deviceInfo['network-name'] || deviceInfo.networkName || 'N/A'}</dd>
                    <dt>Type</dt>
                    <dd>{deviceInfo['network-type'] || deviceInfo.networkType || 'N/A'}</dd>
                  </dl>
                </div>
                <div class="info-section">
                  <h4>Display</h4>
                  <dl class="info-list">
                    <dt>Screen Size</dt>
                    <dd>{deviceInfo['screen-size'] ? deviceInfo['screen-size'] + '"' : 'N/A'}</dd>
                    <dt>Resolution</dt>
                    <dd>{deviceInfo['ui-resolution'] || deviceInfo.uiResolution || 'N/A'}</dd>
                    <dt>Is TV</dt>
                    <dd>{deviceInfo['is-tv'] === 'true' || deviceInfo.isTv ? 'Yes' : 'No'}</dd>
                    <dt>Power Mode</dt>
                    <dd>{deviceInfo['power-mode'] || deviceInfo.powerMode || 'N/A'}</dd>
                  </dl>
                </div>
                <div class="info-section">
                  <h4>Locale</h4>
                  <dl class="info-list">
                    <dt>Language</dt>
                    <dd>{deviceInfo.language || 'N/A'}</dd>
                    <dt>Country</dt>
                    <dd>{deviceInfo.country || 'N/A'}</dd>
                    <dt>Timezone</dt>
                    <dd>{deviceInfo['time-zone-name'] || deviceInfo.timeZoneName || 'N/A'}</dd>
                    <dt>Uptime</dt>
                    <dd>{deviceInfo.uptime ? Math.floor(deviceInfo.uptime / 3600) + 'h ' + Math.floor((deviceInfo.uptime % 3600) / 60) + 'm' : 'N/A'}</dd>
                  </dl>
                </div>
                <div class="info-section">
                  <h4>Capabilities</h4>
                  <dl class="info-list capabilities-list">
                    <dt>Mobile Control</dt>
                    {#if deviceInfo.mobileAccess?.level === 'full'}
                      <dd class="capability-badge success">Full Access</dd>
                    {:else if deviceInfo.mobileAccess?.level === 'limited'}
                      <dd class="capability-badge warning" title={deviceInfo.mobileAccess?.reason || 'Some features restricted'}>Limited</dd>
                    {:else}
                      <dd class="capability-badge success">Enabled</dd>
                    {/if}
                    {#if deviceInfo.mobileAccess?.level === 'limited'}
                      <dt></dt>
                      <dd class="access-hint">Enable "Permissive" in Roku Settings → System → Advanced → Control by mobile apps</dd>
                    {/if}
                    <dt>Wake on LAN</dt>
                    <dd class="capability-badge {deviceInfo.supportsWakeOnWlan || deviceInfo['supports-wake-on-wlan'] === 'true' ? 'success' : 'muted'}">
                      {deviceInfo.supportsWakeOnWlan || deviceInfo['supports-wake-on-wlan'] === 'true' ? 'Yes' : 'No'}
                    </dd>
                    <dt>Private Listening</dt>
                    <dd class="capability-badge {deviceInfo.supportsPrivateListening || deviceInfo['supports-private-listening'] === 'true' ? 'success' : 'muted'}">
                      {deviceInfo.supportsPrivateListening || deviceInfo['supports-private-listening'] === 'true' ? 'Yes' : 'No'}
                    </dd>
                    <dt>AirPlay</dt>
                    <dd class="capability-badge {deviceInfo.supportsAirplay || deviceInfo['supports-airplay'] === 'true' ? 'success' : 'muted'}">
                      {deviceInfo.supportsAirplay || deviceInfo['supports-airplay'] === 'true' ? 'Yes' : 'No'}
                    </dd>
                    <dt>Voice Search</dt>
                    <dd class="capability-badge {deviceInfo.voiceSearchEnabled || deviceInfo['voice-search-enabled'] === 'true' ? 'success' : 'muted'}">
                      {deviceInfo.voiceSearchEnabled || deviceInfo['voice-search-enabled'] === 'true' ? 'Yes' : 'No'}
                    </dd>
                    {#if deviceInfo.developerEnabled || deviceInfo['developer-enabled'] === 'true'}
                      <dt>Developer Mode</dt>
                      <dd class="capability-badge warning">Enabled</dd>
                    {/if}
                  </dl>
                </div>
              </div>
            {:else}
              <p class="no-info">Unable to load device information</p>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</Modal>

<!-- Add Device Modal -->
<Modal bind:open={showAddModal} title="Add Roku Device" size="sm">
  <div class="add-form">
    <label>
      <span>IP Address</span>
      <input 
        type="text" 
        bind:value={addIp} 
        placeholder="192.168.1.100"
        on:keydown={(e) => e.key === 'Enter' && addDevice()}
      />
    </label>
    <p class="add-hint">Enter the IP address of your Roku device</p>
  </div>
  <svelte:fragment slot="footer">
    <Button variant="ghost" on:click={() => showAddModal = false}>Cancel</Button>
    <Button variant="primary" on:click={addDevice} loading={addLoading}>Add Device</Button>
  </svelte:fragment>
</Modal>


<style>
  .stats-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--jewel-space-md);
    margin-bottom: var(--jewel-space-lg);
  }

  @media (max-width: 768px) {
    .stats-row {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  :global(.stat-card) {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--jewel-space-xs);
  }

  .stat-icon {
    width: 32px;
    height: 32px;
    color: rgb(var(--color-text-secondary));
  }

  .stat-icon svg {
    width: 100%;
    height: 100%;
  }

  :global(.stat-card.online) .stat-icon {
    color: rgb(var(--color-success));
  }

  :global(.stat-card.power-on) .stat-icon {
    color: rgb(34, 197, 94);
  }

  :global(.stat-card.standby) .stat-icon {
    color: rgb(234, 179, 8);
  }

  .stat-value {
    font-size: 2rem;
    font-weight: 700;
    color: rgb(var(--color-text));
  }

  .stat-label {
    font-size: 0.875rem;
    color: rgb(var(--color-text-secondary));
  }

  :global(.stat-card.online) .stat-value {
    color: rgb(var(--color-success));
  }

  :global(.stat-card.power-on) .stat-value {
    color: rgb(34, 197, 94);
  }

  :global(.stat-card.standby) .stat-value {
    color: rgb(234, 179, 8);
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--jewel-space-md);
    padding: var(--jewel-space-xl);
    color: rgb(var(--color-text-secondary));
  }

  .empty-state-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: var(--jewel-space-xl) var(--jewel-space-lg);
  }

  .empty-icon {
    width: 48px;
    height: 48px;
    margin-bottom: var(--jewel-space-md);
    color: rgb(var(--color-text-tertiary));
    opacity: 0.6;
  }

  .empty-icon svg {
    width: 100%;
    height: 100%;
  }

  .empty-title {
    font-size: 1rem;
    font-weight: 600;
    color: rgb(var(--color-text));
    margin: 0 0 var(--jewel-space-xs) 0;
  }

  .empty-description {
    font-size: 0.875rem;
    color: rgb(var(--color-text-secondary));
    margin: 0;
    max-width: 400px;
  }

  .device-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--jewel-space-lg);
  }

  :global(.device-card) {
    display: flex;
    flex-direction: column;
  }

  .filter-card {
    margin-bottom: var(--jewel-space-md);
  }

  .filter-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--jewel-space-sm);
    margin-bottom: var(--jewel-space-lg);
  }

  .filter-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 0.8rem;
    font-weight: 500;
    border-radius: var(--jewel-radius-full);
    border: 1px solid rgb(var(--color-border));
    background: rgb(var(--color-surface));
    color: rgb(var(--color-text-secondary));
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .filter-tag:hover {
    background: rgb(var(--color-surface-elevated));
    border-color: rgb(var(--color-primary) / 0.5);
    color: rgb(var(--color-text));
  }

  .filter-tag.active {
    background: rgb(var(--color-primary) / 0.15);
    border-color: rgb(var(--color-primary));
    color: rgb(var(--color-primary));
  }

  .filter-tag.hidden-tag {
    margin-left: auto;
  }

  .filter-group-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: rgb(var(--color-text-tertiary));
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 6px 0;
  }

  .filter-divider {
    width: 1px;
    height: 24px;
    background: rgb(var(--color-border));
    margin: 0 var(--jewel-space-sm);
  }

  .filter-tag.tag-filter.active {
    background: rgb(var(--color-success) / 0.15);
    border-color: rgb(var(--color-success));
    color: rgb(var(--color-success));
  }

  .filter-tag.hidden-tag.active {
    background: rgb(var(--color-warning) / 0.15);
    border-color: rgb(var(--color-warning));
    color: rgb(var(--color-warning));
  }

  .filter-tag svg {
    flex-shrink: 0;
  }

  .device-card-wrapper {
    cursor: pointer;
    transition: transform 0.15s ease;
  }

  .device-card-wrapper:hover {
    transform: translateY(-2px);
  }

  .device-card-wrapper.hidden-device {
    opacity: 0.5;
  }

  .device-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: var(--jewel-space-sm);
  }

  /* Clean info list design */
  .device-info-list {
    list-style: none;
    margin: var(--jewel-space-sm) 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .info-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: rgb(var(--color-text-muted));
  }

  .info-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    opacity: 0.6;
  }

  .info-label {
    flex-shrink: 0;
    min-width: 50px;
  }

  .info-value {
    margin-left: auto;
    font-weight: 500;
    color: rgb(var(--color-text));
  }

  .text-success {
    color: rgb(74, 222, 128) !important;
  }

  .text-error {
    color: rgb(248, 113, 113) !important;
  }

  .text-warning {
    color: rgb(251, 191, 36) !important;
  }

  /* Compact tags row */
  .device-tags-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: var(--jewel-space-sm);
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    background: rgba(99, 102, 241, 0.15);
    color: rgb(165, 180, 252);
    border: 1px solid rgba(99, 102, 241, 0.2);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .tag-chip:hover {
    background: rgba(99, 102, 241, 0.25);
  }

  .tag-chip .remove-tag {
    opacity: 0.5;
    font-size: 12px;
    margin-left: 2px;
    cursor: pointer;
  }

  .tag-chip .remove-tag:hover {
    opacity: 1;
    color: rgb(248, 113, 113);
  }

  .add-tag-link {
    background: none;
    border: none;
    color: rgb(var(--color-text-muted));
    font-size: 11px;
    padding: 4px 0;
    margin-top: auto;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.15s ease;
  }

  .add-tag-link:hover {
    opacity: 1;
    color: rgb(var(--color-primary));
  }

  /* Keep old styles for backwards compatibility */
  .device-status-row {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    justify-content: flex-start;
    margin-top: auto;
    padding-top: var(--jewel-space-md);
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    white-space: nowrap;
  }

  .status-network {
    background: rgba(99, 102, 241, 0.15);
    color: rgb(129, 140, 248);
    border: 1px solid rgba(99, 102, 241, 0.3);
  }

  .status-online {
    background: rgba(34, 197, 94, 0.15);
    color: rgb(74, 222, 128);
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .status-offline {
    background: rgba(107, 114, 128, 0.15);
    color: rgb(156, 163, 175);
    border: 1px solid rgba(107, 114, 128, 0.3);
  }

  .status-mobile-enabled {
    background: rgba(34, 197, 94, 0.15);
    color: rgb(74, 222, 128);
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .status-mobile-disabled {
    background: rgba(239, 68, 68, 0.15);
    color: rgb(248, 113, 113);
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .status-on {
    background: rgba(34, 197, 94, 0.15);
    color: rgb(74, 222, 128);
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .status-standby {
    background: rgba(234, 179, 8, 0.15);
    color: rgb(250, 204, 21);
    border: 1px solid rgba(234, 179, 8, 0.3);
  }

  .status-icon {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
  }

  .custom-tag {
    background: rgb(var(--color-primary) / 0.1);
    color: rgb(var(--color-primary));
    border: 1px solid rgb(var(--color-primary) / 0.3);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .custom-tag:hover {
    background: rgb(var(--color-primary) / 0.2);
  }

  .remove-tag {
    margin-left: 2px;
    font-size: 14px;
    line-height: 1;
    opacity: 0.6;
    cursor: pointer;
    transition: opacity 0.15s ease;
  }

  .remove-tag:hover {
    opacity: 1;
    color: rgb(var(--color-danger));
  }

  .add-tag-btn {
    background: transparent;
    border: 1px dashed rgb(var(--color-border));
    color: rgb(var(--color-text-tertiary));
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .add-tag-btn:hover {
    border-color: rgb(var(--color-primary));
    color: rgb(var(--color-primary));
    background: rgb(var(--color-primary) / 0.05);
  }

  .tag-input-wrapper {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .tag-input {
    width: 80px;
    padding: 3px 8px;
    font-size: 11px;
    border: 1px solid rgb(var(--color-primary));
    border-radius: 9999px;
    background: rgb(var(--color-surface));
    color: rgb(var(--color-text));
    outline: none;
  }

  .tag-input:focus {
    box-shadow: 0 0 0 2px rgb(var(--color-primary) / 0.2);
  }

  .tag-input-add {
    padding: 3px 8px;
    font-size: 12px;
    font-weight: bold;
    border: 1px solid rgb(var(--color-primary));
    border-radius: 9999px;
    background: rgb(var(--color-primary));
    color: white;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .tag-input-add:hover {
    background: rgb(var(--color-primary-hover));
  }

  .tag-input-cancel {
    padding: 3px 8px;
    font-size: 12px;
    font-weight: bold;
    border: 1px solid rgb(var(--color-border));
    border-radius: 9999px;
    background: transparent;
    color: rgb(var(--color-text-muted));
    cursor: pointer;
  }

  .tag-input-cancel:hover {
    background: rgba(239, 68, 68, 0.2);
    color: rgb(248, 113, 113);
    border-color: rgb(248, 113, 113);
  }

  .device-icon {
    width: 40px;
    height: 40px;
    color: rgb(var(--color-primary));
  }

  .device-icon svg {
    width: 100%;
    height: 100%;
  }

  .inline-icon {
    width: 14px;
    height: 14px;
    display: inline-block;
    vertical-align: middle;
    margin-right: 4px;
  }

  .hidden-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 0.875rem;
    color: rgb(var(--color-text-secondary));
    margin-left: auto;
  }

  .hidden-toggle input {
    cursor: pointer;
  }

  .hide-btn {
    width: 28px;
    height: 28px;
    padding: 4px;
    background: rgba(var(--color-surface), 0.8);
    border: 1px solid rgba(var(--color-border), 0.5);
    border-radius: 6px;
    color: rgb(var(--color-text-tertiary));
    cursor: pointer;
    opacity: 0;
    transition: all 0.15s ease;
    margin-left: auto;
  }

  .device-card-wrapper:hover .hide-btn {
    opacity: 1;
  }

  .hide-btn:hover {
    background: rgba(var(--color-surface), 1);
    color: rgb(var(--color-text));
    border-color: rgba(var(--color-border), 1);
  }

  .hide-btn.is-hidden {
    opacity: 1;
    color: rgb(var(--color-primary));
  }

  .hide-btn svg {
    width: 100%;
    height: 100%;
  }

  :global(.device-card) {
    display: flex;
    flex-direction: column;
  }


  .device-name {
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: var(--jewel-space-xs);
  }

  .device-model, .device-ip, .device-app {
    font-size: 0.875rem;
    color: rgb(var(--color-text-secondary));
    margin-bottom: var(--jewel-space-xs);
  }

  .device-app {
    color: rgb(var(--color-primary));
  }


  /* Remote Control Styles */
  .remote-modal-container {
    display: flex;
    flex-direction: column;
    height: 600px; /* Fixed height */
    min-height: 600px;
    max-height: 600px;
  }

  .remote-tabs {
    display: flex;
    gap: 4px;
    padding-bottom: var(--jewel-space-md);
    border-bottom: 1px solid rgb(var(--color-border));
    margin-bottom: var(--jewel-space-md);
    flex-shrink: 0;
  }

  .remote-tab {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 20px;
    background: transparent;
    border: none;
    border-radius: var(--jewel-radius-md);
    color: rgb(var(--color-text-secondary));
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    transition: all 0.15s ease;
  }

  .remote-tab svg {
    width: 18px;
    height: 18px;
  }

  .remote-tab:hover {
    background: rgba(var(--color-primary), 0.1);
    color: rgb(var(--color-text));
  }

  .remote-tab.active {
    background: rgba(var(--color-primary), 0.15);
    color: rgb(var(--color-primary));
  }

  .remote-tab-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .remote-layout {
    display: flex;
    flex-direction: column;
    gap: var(--jewel-space-lg);
  }

  .active-app-section {
    text-align: center;
    padding: var(--jewel-space-md);
    background: rgb(var(--color-surface-elevated));
    border-radius: var(--jewel-radius-md);
  }

  .section-label {
    color: rgb(var(--color-text-secondary));
    margin-right: var(--jewel-space-sm);
  }

  .active-app-name {
    font-weight: 600;
  }

  .power-section {
    display: flex;
    gap: var(--jewel-space-md);
    justify-content: center;
  }

  .nav-pad {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--jewel-space-sm);
  }

  .nav-row {
    display: flex;
    gap: var(--jewel-space-sm);
  }

  .nav-spacer {
    width: 60px;
  }

  :global(.nav-btn) {
    width: 60px;
    height: 60px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  :global(.nav-btn) svg {
    width: 24px;
    height: 24px;
  }

  :global(.ok-btn) {
    border-radius: 50%;
    font-weight: 600;
  }

  .control-row, .playback-row, .volume-row {
    display: flex;
    gap: var(--jewel-space-sm);
    justify-content: center;
    flex-wrap: wrap;
  }

  .apps-section h4 {
    margin-bottom: var(--jewel-space-md);
    font-weight: 600;
  }

  .apps-loading, .no-apps {
    text-align: center;
    padding: var(--jewel-space-md);
    color: rgb(var(--color-text-secondary));
  }

  .apps-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
    gap: var(--jewel-space-sm);
  }

  .app-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--jewel-space-xs);
    padding: var(--jewel-space-sm);
    background: rgb(var(--color-surface-elevated));
    border: 1px solid rgb(var(--color-border));
    border-radius: var(--jewel-radius-md);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .app-tile:hover {
    border-color: rgb(var(--color-primary));
    transform: translateY(-2px);
  }

  .app-tile img {
    width: 48px;
    height: 48px;
    border-radius: var(--jewel-radius-sm);
  }

  .app-tile .app-name {
    font-size: 0.75rem;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  /* Apps Tab */
  .apps-tab-content {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .apps-filter {
    margin-bottom: var(--jewel-space-md);
    flex-shrink: 0;
  }

  .apps-search {
    width: 100%;
    padding: 10px 16px;
    border: 1px solid rgb(var(--color-border));
    border-radius: var(--jewel-radius-md);
    background: rgb(var(--color-surface));
    color: rgb(var(--color-text));
    font-size: 0.9rem;
  }

  .apps-search:focus {
    outline: none;
    border-color: rgb(var(--color-primary));
  }

  .apps-grid-full {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: var(--jewel-space-md);
    overflow-y: auto;
  }

  .app-tile-full {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: var(--jewel-space-md);
    background: rgb(var(--color-surface-elevated));
    border: 1px solid rgb(var(--color-border));
    border-radius: var(--jewel-radius-lg);
    position: relative;
  }

  .app-icon-btn {
    width: 64px;
    height: 64px;
    padding: 0;
    background: none;
    border: none;
    border-radius: var(--jewel-radius-md);
    cursor: pointer;
    overflow: hidden;
    transition: transform 0.15s ease;
  }

  .app-icon-btn:hover {
    transform: scale(1.1);
  }

  .app-icon-btn img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .app-name-full {
    font-size: 0.8rem;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
    color: rgb(var(--color-text));
  }

  .favorite-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 24px;
    height: 24px;
    padding: 4px;
    background: rgba(var(--color-surface), 0.8);
    border: none;
    border-radius: 50%;
    cursor: pointer;
    color: rgb(var(--color-text-tertiary));
    transition: all 0.15s ease;
  }

  .favorite-btn:hover {
    color: rgb(234, 179, 8);
  }

  .favorite-btn.is-favorite {
    color: rgb(234, 179, 8);
  }

  .favorite-btn svg {
    width: 100%;
    height: 100%;
  }

  /* Info Tab */
  .info-tab-content {
    height: 100%;
    overflow-y: auto;
  }

  .info-loading, .no-info {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 200px;
    color: rgb(var(--color-text-secondary));
  }

  .info-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--jewel-space-lg);
  }

  .info-section {
    background: rgb(var(--color-surface-elevated));
    border-radius: var(--jewel-radius-lg);
    padding: var(--jewel-space-md);
  }

  .info-section h4 {
    font-size: 0.85rem;
    font-weight: 600;
    color: rgb(var(--color-primary));
    margin-bottom: var(--jewel-space-sm);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .info-list {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
    font-size: 0.85rem;
  }

  .info-list dt {
    color: rgb(var(--color-text-secondary));
  }

  .info-list dd {
    color: rgb(var(--color-text));
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .capability-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .capability-badge.success {
    background: rgba(var(--color-success), 0.15);
    color: rgb(var(--color-success));
  }

  .capability-badge.muted {
    background: rgba(var(--color-text-secondary), 0.1);
    color: rgb(var(--color-text-secondary));
  }

  .capability-badge.warning {
    background: rgba(var(--color-warning), 0.15);
    color: rgb(var(--color-warning));
  }

  .access-hint {
    font-size: 0.7rem;
    color: rgb(var(--color-text-secondary));
    font-style: italic;
    grid-column: 1 / -1;
    padding: 4px 0;
    line-height: 1.4;
  }

  /* Add Device Form */
  .add-form {
    display: flex;
    flex-direction: column;
    gap: var(--jewel-space-md);
  }

  .add-form label {
    display: flex;
    flex-direction: column;
    gap: var(--jewel-space-xs);
  }

  .add-form label span {
    font-weight: 500;
    font-size: 0.875rem;
  }

  .add-form input {
    padding: var(--jewel-space-sm) var(--jewel-space-md);
    border: 1px solid rgb(var(--color-border));
    border-radius: var(--jewel-radius-md);
    background: rgb(var(--color-surface));
    color: rgb(var(--color-text));
    font-size: 1rem;
  }

  .add-form input:focus {
    outline: none;
    border-color: rgb(var(--color-primary));
  }

  .add-hint {
    font-size: 0.875rem;
    color: rgb(var(--color-text-secondary));
  }
</style>
