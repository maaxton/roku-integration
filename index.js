/**
 * Roku Integration Extension -- SDK v2
 *
 * Discover and control Roku devices on the local network.
 * Uses Roku's External Control Protocol (ECP) on port 8060.
 *
 * The declarative devices: block is the entire device-integration contract
 * (docs/architecture/device-automation-standard.md) — the platform's
 * DeviceTypeHost consumes it:
 * - Device discovery: devices.roku.discover (probe + admission policy)
 * - Polling: devices.roku.poll (750ms interval, canonical object shape)
 * - Commands: devices.roku.commands (auto-become automation actions + the
 *   REST entity-command path; no separate action declarations, no HTTP templates)
 * - Automation trigger templates: automations.triggers below (UI metadata
 *   only — spec §5.2 canonical-shape fold; folded in from the deleted
 *   automation.json sidecar, read in-memory via ActionRegistry)
 * - Routes: declared in routes {}
 */

// HOT-RELOAD CONTRACT: internal sub-modules must be imported dynamically with
// the loader's cache-bust token — a static `import './RokuClient.js'` pins the
// FIRST-loaded copy forever (Node's ESM cache is keyed by URL, and the loader
// only busts index.js). That staleness broke the 2.1.1→2.1.2 update outright:
// the cached old fleet/pairingState.js had no `pairingStateForIdentities`
// export, so importing the new index.js threw and the update rolled back.
// Unlike slidecast (which imports inside init()), these run at module scope via
// top-level await: the devices: block below is registered BEFORE init() runs
// (ExtensionLoader step 10 vs 13), so its probe/poll callbacks need these
// bindings live the moment the module is evaluated. The token comes from the
// ?t= the loader put on OUR OWN url; Date.now() covers direct imports (tests).
const RELOAD_TOKEN = new URL(import.meta.url).searchParams.get('t') ?? Date.now();
const subModule = (rel) => `${new URL(rel, import.meta.url).href}?t=${RELOAD_TOKEN}`;

const [
  { ROKU_ECP_PORT },
  { shouldAutoAdmit },
  { shouldReprobeRoku },
  { RokuDevClient },
  { ReleaseClient },
  { withDeviceLock, runFleetOp, runSerial },
  { pairingStateForIdentities, buildScreenLinkMap, identitiesForDevice },
  { compareVersion, deriveConnState },
] = await Promise.all([
  import(subModule('./constants.js')),
  import(subModule('./admission.js')),
  import(subModule('./reprobe.js')),
  import(subModule('./RokuDevClient.js')),
  import(subModule('./fleet/ReleaseClient.js')),
  import(subModule('./fleet/FleetQueue.js')),
  import(subModule('./fleet/pairingState.js')),
  import(subModule('./fleet/playerState.js')),
]);

// RokuClient pulls the CommonJS `xml2js` dep. Importing it at MODULE SCOPE
// poisons Node's ESM/CJS resolution during a marketplace install (see the
// 2.1.6 install failure). Load it lazily on first use — at runtime the
// process + node_modules are stable, so resolution is correct.
let _RokuClientCtor = null;
const getRokuClient = async () => {
  if (!_RokuClientCtor) {
    ({ RokuClient: _RokuClientCtor } = await import(subModule('./RokuClient.js')));
  }
  return _RokuClientCtor;
};

// ============================================
// Helper functions
// ============================================

/**
 * Slugify a device name for use in entity IDs
 */
function slugify(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Interpret Roku's raw power-mode and active app to determine actual power state.
 *
 * Known gotcha: entity state values are normalized, not raw Roku values.
 * "poweron" -> "on", "standby" -> "off", etc.
 * Automation triggers must use these normalized values.
 */
function interpretPowerState(rawPowerMode, activeApp) {
  // Normalize: lowercase + strip whitespace so "Power On" === "PowerOn".
  const mode = (rawPowerMode || '').toLowerCase().replace(/\s+/g, '');

  // WHITELIST the modes that mean the display is genuinely ON. Everything else —
  // standby, ready, displayoff, suspend, poweroff, unknown/empty — is standby.
  //
  // Why a whitelist, not a blacklist: Roku standby is not a single mode. A TV in
  // standby cycles through low-power sub-modes (Ready → DisplayOff → Suspend). The
  // old blacklist only knew standby/ready/displayoff, so "Suspend" fell through to
  // a default `return 'on'`. That made the entity flap off↔on every few minutes
  // while the TV was actually off, re-firing the slidecast auto-launch and yanking
  // the TV back to Waiveo. Only PowerOn (and non-screensaver Headless) are truly on.

  // PowerOn: the display is on regardless of screensaver. Do NOT reclassify as
  // standby based on screensaver — the device is powered on and the main-state
  // logic (on/idle/playing) handles screensaver separately. Reclassifying here once
  // caused the entity to stay 'off' on a screensaver-active power-on, so auto-launch
  // never saw the off → on transition.
  if (mode === 'poweron') {
    return 'on';
  }

  // Headless: powered but driving no display (e.g. HDMI-CEC audio, or a streaming
  // stick whose TV input is switched away). Treat as 'on' unless it is just the
  // screensaver, which is standby.
  if (mode === 'headless') {
    return activeApp?.type === 'screensaver' ? 'standby' : 'on';
  }

  return 'standby';
}

/**
 * Determine main entity state from power state and active app.
 * Returns one of: 'on', 'off', 'playing', 'idle'
 */
function determineMainState(powerState, activeApp) {
  if (powerState === 'off' || powerState === 'standby') {
    return 'off';
  }
  if (activeApp?.type === 'screensaver') {
    return 'idle';
  }
  // The Roku Home screen = powered on, no channel foregrounded → 'on'. Detect it
  // by ECP type ('home'/'menu'), since its NAME varies by firmware ("Home",
  // "Roku", "Roku Dynamic Menu"). Without this, Home reported as "Roku Dynamic
  // Menu" fell through to 'playing', so a genuine power-on-to-Home looked like a
  // running app and the auto-launch (to:['on']) would miss it.
  if (activeApp?.type === 'home' || activeApp?.type === 'menu' || activeApp?.name === 'Home') {
    return 'on';
  }
  if (activeApp?.name) {
    return 'playing';
  }
  return 'on';
}

/**
 * Find a device by ID in device_registry (the single source of truth).
 * Searches: device_registry by id -> device_registry by serial (roku:SERIAL).
 */
async function findDevice(ctx, deviceId) {
  // Check device_registry by id. Own-integration-scoped (fork-host Wave 3 Task
  // 2): every route in this file is a roku-only operation (power/keypress/
  // fleet/unregister/...), so a device_registry row belonging to some OTHER
  // integration must never resolve here — without this filter a stray/guessed
  // id from another extension would silently succeed against roku's routes
  // (and, before ctx.devices.unregister added its own ownership check, DELETE
  // could unregister ANY extension's device). A non-roku id now correctly
  // misses and every caller below treats it as "not found" (404).
  try {
    const results = await ctx.data.query('device_registry')
      .where('id', '=', deviceId)
      .where('integration', '=', 'roku-integration')
      .get();
    if (results?.length > 0) {
      const d = results[0];
      return {
        device_id: d.id || d.device_id,
        ip_address: d.ip_address,
        name: d.friendly_name || d.name || 'Unknown Roku',
        serial_number: d.serial_number || null,
        online: d.online,
      };
    }

    // Try by serial number (extract from roku:SERIAL format)
    const serialMatch = deviceId.match(/^roku:(.+)$/i);
    if (serialMatch) {
      const serial = serialMatch[1];
      const bySerial = await ctx.data.query('device_registry')
        .where('serial_number', '=', serial)
        .where('integration', '=', 'roku-integration')
        .get();
      if (bySerial?.length > 0) {
        const d = bySerial[0];
        return {
          device_id: d.id || d.device_id,
          ip_address: d.ip_address,
          name: d.friendly_name || d.name || 'Unknown Roku',
          serial_number: d.serial_number || null,
          online: d.online,
        };
      }
    }
  } catch (err) {
    ctx.log(`findDevice: error querying device_registry for ${deviceId}: ${err.message}`, 'warn');
  }

  return null;
}

// ============================================
// Fleet layer (player lifecycle) helpers
// ============================================

// Module-scoped ReleaseClient so its metadata (30s TTL) + zip-Buffer caches
// persist across requests within a load and are cleanly recreated on hot-reload
// (mirrors the FleetQueue module-singleton pattern).
const releaseClient = new ReleaseClient();

// ?refresh=1 (or true) on the fleet GET routes bypasses the release metadata
// cache — the "Check for updates" affordance on the fleet page.
const wantsReleaseRefresh = (ctx) => ctx.query
  && (ctx.query.refresh === '1' || ctx.query.refresh === 'true');

// Fixed-length mask returned by GET /fleet/dev-credentials — presence only, and
// deliberately a CONSTANT so it never leaks the real password's length.
export const DEV_PW_MASK = '••••••••';

/**
 * One-time migration off the legacy plaintext `ctx.config` 'dev_credentials'
 * blob onto per-scope encrypted secrets (`roku_dev_password` fleet default +
 * `roku_dev_password:<serial>` per device). Runs on every init() but is a
 * no-op once the blob is cleared. NEVER lose the password: any failure while
 * writing secrets (e.g. `E_NO_SECRETS_KEY` — the host key isn't available
 * yet) leaves the plaintext blob in place untouched and just warns; only a
 * fully successful migration clears it.
 */
export async function migrateDevCredentialsToSecrets(ctx) {
  let blob;
  try {
    blob = await ctx.config.get('dev_credentials');
  } catch (err) {
    ctx.log(`Fleet: failed to read legacy dev_credentials for migration: ${err.message}`, 'warn');
    return;
  }
  if (!blob || typeof blob !== 'object') return; // nothing to migrate
  const fleetDefault = (blob.fleet_default != null && blob.fleet_default !== '') ? blob.fleet_default : null;
  const perDevice = (blob.per_device && typeof blob.per_device === 'object') ? blob.per_device : {};
  try {
    if (fleetDefault != null) {
      await ctx.secrets.set('roku_dev_password', fleetDefault);
    }
    await Promise.all(Object.entries(perDevice)
      .filter(([, password]) => password != null && password !== '')
      .map(([serial, password]) => ctx.secrets.set(`roku_dev_password:${serial}`, password)));
    await ctx.config.set('dev_credentials', null);
    ctx.log('Fleet: migrated dev_credentials to per-scope encrypted secrets', 'info');
  } catch (err) {
    ctx.log(`Fleet: dev_credentials migration to secrets failed (${err.message}); leaving the legacy plaintext blob in place`, 'warn');
  }
}

// Send a handler result object as JSON on a [stream] route. Long-running write
// routes (player install/reset, fleet update-all) are marked [stream] so the
// host guards them for ATTRIBUTION only (no uncancellable 30s route ceiling that
// would 500 the client mid-install and orphan the roll); a [stream] handler must
// therefore write its own response. Honors a numeric `status` on the object.
function sendJson(ctx, result) {
  const status = result && typeof result.status === 'number' && result.status >= 400
    ? result.status
    : 200;
  ctx.res.status(status).json(result);
}

/** All roku rows from device_registry (the single source of truth). */
async function queryRokuDevices(ctx) {
  try {
    const rows = await ctx.data.query('device_registry')
      .where('device_type', '=', 'roku')
      .get();
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    ctx.log(`Fleet: failed to query device_registry: ${err.message}`, 'warn');
    return [];
  }
}

/**
 * Best-effort, read-only, defensive read of slidecast's token table. This
 * reaches into ANOTHER extension's table (shared SQLite), so a missing table
 * (slidecast not installed) must degrade to `null` → pairing 'unknown', never
 * throw. We intentionally do NOT add requires:['slidecast'].
 */
async function readTokenRows(ctx) {
  try {
    const rows = await ctx.data.query('slidecast_device_tokens').get();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return null; // table absent / read failed → pairing state 'unknown'
  }
}

/**
 * Best-effort read of slidecast_screens to bridge a device's identifiers → the
 * Roku's ChannelClientId. Slidecast keys an auto-discovered screen's token by
 * the ChannelClientId (see PairingManager.validateToken), while the fleet keys
 * on device_registry identifiers — and the screen row's own `serial` is the
 * DEVICE ID form ('roku:<hw serial>'), not the bare hardware serial. The map is
 * therefore keyed by every identity the screen row carries (see
 * buildScreenLinkMap). Empty Map on a missing/failed read (slidecast absent) so
 * lookups just fall back to the device identifiers (no worse than before).
 */
async function readScreenLinks(ctx) {
  try {
    const rows = await ctx.data.query('slidecast_screens').get();
    return buildScreenLinkMap(rows);
  } catch {
    return new Map(); // slidecast screens unavailable → device identifiers only
  }
}

/**
 * Resolve the dev password for a serial from the central encrypted secrets
 * store: per-device secret (`roku_dev_password:<serial>`) wins over the fleet
 * default (`roku_dev_password`). Never a JSON blob in ctx.config.
 */
export async function resolveDevPassword(ctx, serial) {
  if (serial != null) {
    const perDevice = await ctx.secrets.get(`roku_dev_password:${serial}`);
    if (perDevice) return perDevice;
  }
  return (await ctx.secrets.get('roku_dev_password')) || null;
}

/** Build a RokuDevClient whose password is resolved from secrets at op time. */
function makeDevClient(ctx, device) {
  return new RokuDevClient(device.ip_address, {
    passwordResolver: async () => resolveDevPassword(ctx, device.serial_number),
  });
}

/**
 * Map a RokuDevClient error into a LOUD route response. Wrong password (digest
 * 401 after the nonce retry) and not-in-dev-mode (installer refuses on :80) are
 * surfaced explicitly per the spec guardrail.
 */
function devErrorResponse(err) {
  switch (err && err.code) {
    case 'DIGEST_REJECTED':
      return {
        success: false, error: 'Dev password rejected — check the Roku dev password', dev_state: 'password_rejected', status: 502,
      };
    case 'NO_PASSWORD':
      return {
        success: false, error: 'No Roku dev password configured — set it under Roku Fleet → Dev Credentials', dev_state: 'no_password', status: 400,
      };
    case 'UNREACHABLE':
    case 'NO_CHALLENGE':
      return {
        success: false, error: `Roku dev installer unreachable — is the device in developer mode? (${err.message})`, dev_state: 'not_dev_mode', status: 502,
      };
    default:
      return { success: false, error: err ? err.message : 'Unknown error', status: (err && err.status) || 502 };
  }
}

/** Cheap dev-mode classification from auth-free ECP signals + config presence. */
function computeDevState({ reachable, developerEnabled, hasPassword }) {
  if (!reachable) return 'unreachable';
  if (!developerEnabled) return 'not_dev_mode';
  if (!hasPassword) return 'no_password';
  return 'ok';
}

/**
 * Aggregate one device's player status from auth-free ECP reads + the pairing
 * reducer + release metadata. No digest/:80 call here (that is a write path),
 * so GET /fleet/players stays a single fan-out with no N+1 per device.
 */
async function buildPlayerStatus(ctx, device, {
  tokenRows, screenLinks, latestMeta, hasPassword,
}) {
  const status = {
    id: device.device_id,
    name: device.name,
    ip_address: device.ip_address || null,
    serial_number: device.serial_number || null,
    online: !!device.online,
    installed_version: null,
    active_app: null,
    latest_tag: latestMeta ? latestMeta.tag : null,
    updateAvailable: false,
    version_state: 'unknown',
    pairing_state: 'unknown',
    conn_state: 'unknown',
    dev_state: 'unknown',
  };

  let reachable = false;
  let developerEnabled = false;
  let devChannelActive = false;

  if (device.ip_address) {
    try {
      const client = new (await getRokuClient())(device.ip_address);
      client.setTimeout(2500);
      const [apps, activeApp, info] = await Promise.all([
        client.getApps().catch(() => null),
        client.getActiveApp().catch(() => null),
        client.getDeviceInfo().catch(() => null),
      ]);
      if (apps || activeApp || info) reachable = true;
      if (Array.isArray(apps)) {
        const devApp = apps.find((a) => a.id === 'dev');
        status.installed_version = devApp ? devApp.version || null : null;
      }
      if (activeApp) {
        status.active_app = activeApp.name || null;
        devChannelActive = activeApp.id === 'dev';
      }
      if (info) developerEnabled = info.developerEnabled === true;
    } catch {
      reachable = false;
    }
  }

  status.online = reachable;
  // Match tokens by ALL of this device's identities — bare hardware serial,
  // device_id, and any ChannelClientId linked via its slidecast screen —
  // slidecast keys auto-discovered screens' tokens by the ChannelClientId (and
  // its screen rows by the device_id form), so a serial-only lookup misses a
  // paired, playing screen.
  const identities = identitiesForDevice(screenLinks, {
    serialNumber: status.serial_number,
    deviceId: device.device_id,
  });
  status.pairing_state = pairingStateForIdentities(tokenRows, identities);
  status.conn_state = deriveConnState({ pairing: status.pairing_state, devChannelActive });
  const cmp = compareVersion(status.installed_version, status.latest_tag);
  status.version_state = cmp.state;
  status.updateAvailable = cmp.updateAvailable;
  status.dev_state = computeDevState({ reachable, developerEnabled, hasPassword });
  return status;
}

/** Re-read the installed dev-channel version over ECP (best-effort, post-op). */
async function readInstalledVersion(ipAddress) {
  try {
    const client = new (await getRokuClient())(ipAddress);
    client.setTimeout(3000);
    const apps = await client.getApps();
    const devApp = Array.isArray(apps) ? apps.find((a) => a.id === 'dev') : null;
    return devApp ? devApp.version || null : null;
  } catch {
    return null;
  }
}

// ============================================
// Extension Definition
// ============================================

export default {
  // === Identity ===
  name: 'roku-integration',
  // No `version` here: package.json is the single authoritative version (the
  // loader overwrites a declared one anyway and WARNs when it drifts — which
  // it had, stuck at 2.1.0 through two releases).
  description: 'Discover and control Roku devices on your network',
  requires: ['device-discovery'],
  provides: ['roku-control'],

  // Fork-host Wave 3 Task 4: declares (self-requests) read access to the two
  // CORE tables this extension reads directly via ctx.data (findDevice/
  // getDevices service/GET /devices all read `device_registry`; the same two
  // routes also read `entity_states` for current power/app state) — neither
  // is a table roku itself owns/declares, so the isolated CtxRpcBroker's
  // ownership check (`runData`, spec §4.1) denies them without an ENUMERATED
  // `readCore` grant. This declaration alone is NOT sufficient for isolated
  // reads to work: the broker enforces the admin-APPROVED grant set
  // (GrantStore), not the self-declared one (deny-by-default) — an admin
  // still has to approve it once via `POST /api/extensions/roku-integration/grants`
  // (or the equivalent consent UI) before these routes function isolated.
  // Harmless in-process: grants are read only by the isolated CtxRpcBroker.
  grants: { readCore: ['device_registry', 'entity_states'] },

  // === npm dependencies ===
  dependencies: {
    xml2js: '^0.6.2',
  },

  // === Navigation ===
  nav: [
    {
      label: 'Roku',
      icon: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
      path: '/ext/roku-integration',
      order: 60,
    },
    {
      label: 'Roku Fleet',
      icon: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h14a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4z',
      path: '/ext/roku-integration/fleet',
      order: 61,
    },
  ],

  // === UI contributions (spec §6 / D9, Wave 5 Slice 5.3) ===
  // Inject a Roku-specific panel into the device-discovery device-detail
  // Modal's deviceTabs slot. componentPath 'device-tab' resolves to
  // frontend-routes/roku-integration/device-tab/+page.svelte via the
  // component-serve route. deviceType: 'roku' means device-discovery's
  // deviceType filter (matchesDeviceType) only shows this tab for devices it
  // resolves as a Roku — the end-to-end proof of the deviceTabs contribution
  // slot AND its deviceType filtering.
  contributions: {
    deviceTabs: [
      {
        componentPath: 'device-tab',
        label: 'Roku',
        deviceType: 'roku',
        order: 10,
      },
    ],
  },

  // === Database tables ===
  // No private tables. device_registry (core) is the single source of truth
  // for Roku devices; the legacy `roku_devices` mirror table has been removed
  // (D4) — see init() for the one-time DROP TABLE IF EXISTS.

  // === Device integration ===
  devices: {
    roku: {
      discover: {
        ports: [ROKU_ECP_PORT],
        probe: async (ip) => {
          try {
            const client = new (await getRokuClient())(ip);
            const info = await client.getDeviceInfo();
            const serial = info.serialNumber || info.deviceId;
            if (!serial) return null;
            return {
              id: `roku:${serial}`,
              name: info.friendlyDeviceName || `Roku ${info.modelName}`,
              manufacturer: info.vendorName || 'Roku',
              model: info.modelName,
              serial,
              firmware: info.softwareVersion,
            };
          } catch {
            return null;
          }
        },
        // Admission gate (#1671): a discovered device is a proposal, not a
        // member. Passive announcements (mDNS/SSDP) are held as PENDING for
        // explicit approval; only explicit scans (via_scan) or manual adds
        // auto-admit. The escape hatch `passive_discovery_requires_approval=
        // false` restores legacy auto-claim. Called by the platform
        // DeviceTypeHost after a successful probe.
        admit: async (candidate, { ctx }) => {
          let passiveRequiresApproval = true;
          try {
            const settings = (await ctx.config.get('settings')) || {};
            passiveRequiresApproval = settings.passive_discovery_requires_approval !== false;
          } catch (cfgErr) {
            ctx.log(`Admission: failed to read settings (${cfgErr.message}); defaulting to approval-required`, 'warn');
          }
          return shouldAutoAdmit(candidate, { passiveRequiresApproval });
        },
        // DD3: device-agnostic re-probe contract hook (DeviceManager /
        // DeviceTypeHost). Some Roku TVs only announce via AirPlay mDNS and
        // land in discovery_candidates unconfirmed with no serial/friendly
        // name; this tells the platform's GET /candidates surface when it's
        // worth firing another live probe at this extension. See reprobe.js.
        shouldReprobe: (candidate) => shouldReprobeRoku(candidate),
      },

      poll: {
        interval: 750,
        states: ['on', 'off', 'playing', 'idle'],
        entities: (device) => [
          {
            id: `media_player.${slugify(device.friendly_name || device.name || device.id)}`,
            domain: 'media_player',
            name: device.friendly_name || device.name || device.id,
          },
        ],
        fn: async (device) => {
          const ip = device.ip_address;
          if (!ip) throw new Error(`Device ${device.id} missing ip_address`);

          const client = new (await getRokuClient())(ip);
          // P1 perf (audit 2026-07-04): the poll loop runs every 750ms across
          // up to 7 live Rokus. RokuClient's 5s default timeout is sized for
          // interactive commands (keypress/launch/etc.) and would let one
          // stuck/unreachable device hold a poll slot for up to 5s; drop it
          // to ~1.2s here so a dead device fails fast and doesn't starve the
          // schedule. Interactive commands elsewhere keep the 5s default.
          client.setTimeout(1200);
          // P1 perf: getPowerMode() regex-extracts just <power-mode> instead
          // of running the full xml2js parse getDeviceInfo() does to build
          // its ~40-field object. Static fields (serial/model/firmware/etc.)
          // never change poll-to-poll — they're captured once at
          // discovery/probe time and already live in device_registry.
          const [powerMode, activeApp] = await Promise.all([
            client.getPowerMode(),
            client.getActiveApp(),
          ]);

          const powerState = interpretPowerState(powerMode, activeApp);
          const mainState = determineMainState(powerState, activeApp);
          const slug = slugify(device.friendly_name || device.name || device.id);

          return {
            [`media_player.${slug}`]: {
              state: mainState,
              attributes: {
                power_mode: powerMode,
                power_state: powerState,
                active_app: activeApp?.name || 'Home',
                active_app_id: activeApp?.id || null,
                app_type: activeApp?.type || null,
                app_version: activeApp?.version || null,
                is_screensaver: activeApp?.type === 'screensaver',
                screensaver_name: activeApp?.type === 'screensaver' ? activeApp.name : null,
                device_type: 'roku',
                friendly_name: device.friendly_name,
              },
            },
          };
        },
      },

      commands: {
        turn_on: {
          label: 'Power on Roku',
          category: 'media',
          description: 'Wake up a Roku device from standby',
          fields: {
            device_id: { type: 'device', label: 'Roku Device', required: true },
          },
          fn: async (device) => {
            const client = new (await getRokuClient())(device.ip_address);
            await client.powerOn();
            return { success: true };
          },
        },
        turn_off: {
          label: 'Power off Roku',
          category: 'media',
          description: 'Put a Roku device into standby',
          fields: {
            device_id: { type: 'device', label: 'Roku Device', required: true },
          },
          fn: async (device) => {
            const client = new (await getRokuClient())(device.ip_address);
            await client.powerOff();
            return { success: true };
          },
        },
        launch_app: {
          label: 'Launch app on Roku',
          category: 'media',
          description: 'Launch an app on a Roku device',
          fields: {
            device_id: { type: 'device', label: 'Roku Device', required: true },
            app_id: {
              type: 'select',
              label: 'App',
              required: true,
              source: '/api/extensions/roku-integration/devices/{{device_id}}/apps',
            },
          },
          fn: async (device, { app_id }) => {
            const client = new (await getRokuClient())(device.ip_address);
            await client.launchApp(app_id);
            return { success: true, app_id };
          },
        },
        send_keypress: {
          label: 'Send Roku remote key',
          category: 'media',
          description: 'Send a remote control key press to a Roku device',
          fields: {
            device_id: { type: 'device', label: 'Roku Device', required: true },
            key: {
              type: 'select',
              label: 'Key',
              required: true,
              options: [
                { value: 'Home', label: 'Home' },
                { value: 'Back', label: 'Back' },
                { value: 'Select', label: 'OK/Select' },
                { value: 'Up', label: 'Up' },
                { value: 'Down', label: 'Down' },
                { value: 'Left', label: 'Left' },
                { value: 'Right', label: 'Right' },
                { value: 'Play', label: 'Play' },
                { value: 'Pause', label: 'Pause' },
                { value: 'Rev', label: 'Rewind' },
                { value: 'Fwd', label: 'Fast Forward' },
                { value: 'VolumeUp', label: 'Volume Up' },
                { value: 'VolumeDown', label: 'Volume Down' },
                { value: 'VolumeMute', label: 'Mute' },
              ],
            },
          },
          fn: async (device, { key }) => {
            const client = new (await getRokuClient())(device.ip_address);
            await client.keypress(key);
            return { success: true, key };
          },
        },
      },
    },
  },

  // === Automation trigger templates (spec §5.2 canonical-shape fold) ===
  // UI trigger-picker metadata, folded in from the deleted automation.json
  // sidecar — read in-memory by the automation extension's GET /triggers via
  // the platform ActionRegistry (ExtensionLoader Step 10.5b), not a file scan.
  // Automation ACTIONS are still auto-derived from devices.roku.commands above
  // — see docs/architecture/device-automation-standard.md.
  automations: {
    triggers: [
      {
        key: 'state',
        label: 'Roku turned on',
        description: 'When a Roku device powers on from standby',
        fields: [
          { key: 'device_id', type: 'device', label: 'Roku Device (optional - blank for any)' },
          { key: 'domain', type: 'hidden', default: 'media_player' },
          { key: 'from', type: 'hidden', default: ['off', 'standby'] },
          { key: 'to', type: 'hidden', default: ['on'] },
        ],
        output: ['entity_id', 'old_state', 'new_state', 'attributes'],
      },
      {
        key: 'state',
        label: 'Roku turned off',
        description: 'When a Roku device goes into standby',
        fields: [
          { key: 'device_id', type: 'device', label: 'Roku Device (optional - blank for any)' },
          { key: 'domain', type: 'hidden', default: 'media_player' },
          { key: 'to', type: 'hidden', default: 'off' },
        ],
        output: ['entity_id', 'old_state', 'new_state', 'attributes'],
      },
      {
        key: 'state',
        label: 'Roku started playing',
        description: 'When a Roku device launches an app or starts playing content',
        fields: [
          { key: 'device_id', type: 'device', label: 'Roku Device (optional - blank for any)' },
          { key: 'domain', type: 'hidden', default: 'media_player' },
          { key: 'to', type: 'hidden', default: 'playing' },
        ],
        output: ['entity_id', 'old_state', 'new_state', 'attributes'],
      },
      {
        key: 'state',
        label: 'Roku went idle',
        description: 'When the screensaver activates on a Roku device',
        fields: [
          { key: 'device_id', type: 'device', label: 'Roku Device (optional - blank for any)' },
          { key: 'domain', type: 'hidden', default: 'media_player' },
          { key: 'to', type: 'hidden', default: 'idle' },
        ],
        output: ['entity_id', 'old_state', 'new_state', 'attributes'],
      },
    ],
  },

  // === Inter-extension services ===
  services: {
    getDevices: async (ctx) => {
      // Query device_registry (same source as GET /devices HTTP route)
      try {
        const result = await ctx.data.query('device_registry')
          .where('device_type', '=', 'roku')
          .get();

        if (result?.length > 0) {
          const stateEntities = await ctx.data.query('entity_states')
            .where('entity_id', 'like', 'media_player.%')
            .get();

          const stateMap = new Map();
          for (const entity of stateEntities || []) {
            try {
              const attrs = typeof entity.attributes === 'string'
                ? JSON.parse(entity.attributes)
                : entity.attributes;
              if (attrs?.device_type === 'roku') {
                stateMap.set(entity.entity_id, {
                  power_mode: attrs.power_mode,
                  state: entity.state,
                  active_app: attrs.active_app || null,
                  active_app_id: attrs.active_app_id || null,
                  app_type: attrs.app_type || null,
                });
              }
            } catch (e) { /* ignore parse errors */ }
          }

          return result.map((d) => {
            const deviceKey = slugify(d.friendly_name || d.name || '');
            const entityKey = `media_player.${deviceKey}`;
            const stateInfo = stateMap.get(entityKey);

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
              power_mode: stateInfo?.power_mode || null,
              power_state: stateInfo?.state || null,
              // Currently-active app from media_player entity attributes
              // (drives Playing/Idle indicator on slidecast Screens page)
              active_app: stateInfo?.active_app || null,
              active_app_id: stateInfo?.active_app_id || null,
              app_type: stateInfo?.app_type || null,
              discovered_at: d.discovered_at,
              consecutive_failures: d.consecutive_failures,
            };
          });
        }
      } catch (err) {
        ctx.log(`getDevices: failed to query device_registry: ${err.message}`, 'warn');
      }

      return [];
    },
    getDevice: async (ctx, { deviceId }) => {
      return await findDevice(ctx, deviceId);
    },
    launchApp: async (ctx, { deviceId, appId }) => {
      const device = await findDevice(ctx, deviceId);
      if (!device) throw new Error(`Device ${deviceId} not found`);
      const client = new (await getRokuClient())(device.ip_address);
      await client.launchApp(appId);
      return { success: true };
    },
    sendKeypress: async (ctx, { deviceId, key }) => {
      const device = await findDevice(ctx, deviceId);
      if (!device) throw new Error(`Device ${deviceId} not found`);
      const client = new (await getRokuClient())(device.ip_address);
      await client.keypress(key);
      return { success: true };
    },
    powerOn: async (ctx, { deviceId }) => {
      const device = await findDevice(ctx, deviceId);
      if (!device) throw new Error(`Device ${deviceId} not found`);
      const client = new (await getRokuClient())(device.ip_address);
      await client.powerOn();
      return { success: true };
    },
    powerOff: async (ctx, { deviceId }) => {
      const device = await findDevice(ctx, deviceId);
      if (!device) throw new Error(`Device ${deviceId} not found`);
      const client = new (await getRokuClient())(device.ip_address);
      await client.powerOff();
      return { success: true };
    },
  },

  // === HTTP routes ===
  routes: {

    // GET /devices -- list all Roku devices
    // Sole source: device_registry (D4 — the private roku_devices mirror
    // table is gone; there is no fallback).
    'GET /devices': async (ctx) => {
      let devices = [];

      // device_registry
      try {
        const result = await ctx.data.query('device_registry')
          .where('device_type', '=', 'roku')
          .get();

        if (result?.length > 0) {
          // Fetch media_player entities for current state
          const stateEntities = await ctx.data.query('entity_states')
            .where('entity_id', 'like', 'media_player.%')
            .get();

          const stateMap = new Map();
          for (const entity of stateEntities || []) {
            try {
              const attrs = typeof entity.attributes === 'string'
                ? JSON.parse(entity.attributes)
                : entity.attributes;
              if (attrs?.device_type === 'roku') {
                stateMap.set(entity.entity_id, {
                  power_mode: attrs.power_mode,
                  state: entity.state,
                });
              }
            } catch (e) { /* ignore parse errors */ }
          }

          devices = result.map((d) => {
            const deviceKey = slugify(d.friendly_name || d.name || '');
            const entityKey = `media_player.${deviceKey}`;
            const stateInfo = stateMap.get(entityKey);

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
              power_mode: stateInfo?.power_mode || null,
              power_state: stateInfo?.state || null,
              discovered_at: d.discovered_at,
              consecutive_failures: d.consecutive_failures,
            };
          });
        }
      } catch (err) {
        ctx.log(`Failed to query device_registry: ${err.message}`, 'warn');
      }

      return { success: true, devices };
    },

    // GET /devices/:id -- single device
    'GET /devices/:id': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) return { success: false, error: 'Device not found', status: 404 };
      return { success: true, device };
    },

    // GET /devices/:id/apps -- installed apps
    // DD6: matches the try/catch every other GET /devices/:id/* route already
    // has (info, access) — an unreachable device or malformed ECP response
    // used to bubble up as an unhandled 500 instead of a clean 502.
    'GET /devices/:id/apps': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) return { success: false, error: 'Device not found', status: 404 };
      try {
        const client = new (await getRokuClient())(device.ip_address);
        const apps = await client.getApps();
        return { success: true, apps };
      } catch (error) {
        return { success: false, error: error.message, status: 502 };
      }
    },

    // GET /devices/:id/active-app
    // (same DD6 try/catch gap as /apps above)
    'GET /devices/:id/active-app': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) return { success: false, error: 'Device not found', status: 404 };
      try {
        const client = new (await getRokuClient())(device.ip_address);
        const activeApp = await client.getActiveApp();
        return { success: true, activeApp };
      } catch (error) {
        return { success: false, error: error.message, status: 502 };
      }
    },

    // GET /devices/:id/info -- full device info
    'GET /devices/:id/info': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) return { success: false, error: 'Device not found', status: 404 };
      try {
        const client = new (await getRokuClient())(device.ip_address);
        const info = await client.getDeviceInfo();
        return { success: true, info };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // GET /devices/:id/access -- mobile control access level
    'GET /devices/:id/access': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) return { success: false, error: 'Device not found', status: 404 };
      try {
        const client = new (await getRokuClient())(device.ip_address);
        const access = await client.checkMobileControlAccess();
        return { success: true, access };
      } catch (error) {
        return { success: true, access: { level: 'disabled', canControl: false, canQueryApps: false } };
      }
    },

    // POST /devices/:id/keypress/:key
    'POST /devices/:id/keypress/:key': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) return { success: false, error: 'Device not found', status: 404 };
      try {
        const client = new (await getRokuClient())(device.ip_address);
        await client.keypress(ctx.params.key);
        return { success: true, message: `Sent ${ctx.params.key} to ${device.name}` };
      } catch (error) {
        return { success: false, error: `Keypress failed: ${error.message}`, status: 502 };
      }
    },

    // POST /devices/:id/launch/:appId
    // Accepts optional JSON body with launch params (e.g. { serverUrl: "http://..." })
    // which are forwarded as ECP query params to the Roku device.
    'POST /devices/:id/launch/:appId': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) return { success: false, error: 'Device not found', status: 404 };
      const params = ctx.body && typeof ctx.body === 'object' ? { ...ctx.body } : {};
      // Remove fields that aren't launch params
      delete params.app_id;
      delete params.device_id;
      const { appId } = ctx.params;
      // #autolaunch-delay: optional pre-launch delay (ms). The power-on auto-launch automation
      // sets delay_ms so launch/dev fires AFTER the just-woken Roku is ready to foreground and
      // render the channel — firing the instant the Roku comes on-line pends the launch without
      // rendering (→ Home). Manual/UI launches omit delay_ms and launch instantly. One launch, no retry.
      let delayMs = 0;
      if (params.delay_ms !== undefined) {
        delayMs = parseInt(params.delay_ms, 10) || 0;
        delete params.delay_ms;
      }
      try {
        if (delayMs > 0) {
          ctx.log(`launch ${appId} on ${device.name}: waiting ${delayMs}ms for the Roku to be ready before launch`, 'info');
          await new Promise((r) => setTimeout(r, Math.min(delayMs, 60000)));
        }
        const client = new (await getRokuClient())(device.ip_address);
        await client.launchApp(appId, params);
        return { success: true, message: `Launched app ${appId} on ${device.name}${delayMs ? ` (after ${delayMs}ms delay)` : ''}` };
      } catch (error) {
        return { success: false, error: `Launch failed: ${error.message}`, status: 502 };
      }
    },

    // POST /devices/:id/power/on
    'POST /devices/:id/power/on': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) return { success: false, error: 'Device not found', status: 404 };
      try {
        const client = new (await getRokuClient())(device.ip_address);
        await client.powerOn();
        return { success: true, message: `Powered on ${device.name}` };
      } catch (error) {
        return { success: false, error: `Power on failed: ${error.message}`, status: 502 };
      }
    },

    // POST /devices/:id/power/off
    'POST /devices/:id/power/off': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) return { success: false, error: 'Device not found', status: 404 };
      try {
        const client = new (await getRokuClient())(device.ip_address);
        await client.powerOff();
        return { success: true, message: `Powered off ${device.name}` };
      } catch (error) {
        return { success: false, error: `Power off failed: ${error.message}`, status: 502 };
      }
    },

    // GET /devices/:id/icon/:appId -- proxy Roku app icon to avoid direct device requests
    'GET /devices/:id/icon/:appId [stream]': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) {
        ctx.res.status(404).json({ error: 'Device not found' });
        return;
      }
      try {
        const iconUrl = `http://${device.ip_address}:8060/query/icon/${ctx.params.appId}`;
        const response = await fetch(iconUrl, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) {
          ctx.res.status(404).end();
          return;
        }
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        ctx.res.setHeader('Content-Type', contentType);
        ctx.res.setHeader('Cache-Control', 'public, max-age=86400');
        const buffer = await response.arrayBuffer();
        ctx.res.end(Buffer.from(buffer));
      } catch (error) {
        ctx.res.status(502).end();
      }
    },

    // POST /devices/add -- manual registration by IP
    'POST /devices/add': async (ctx) => {
      const { ip_address } = ctx.body;
      if (!ip_address) return { success: false, error: 'IP address required', status: 400 };

      const existingRows = await ctx.data.query('device_registry')
        .where('ip_address', '=', ip_address)
        .get();
      if (existingRows?.length > 0) return { success: false, error: 'Device already registered', status: 409 };

      try {
        const client = new (await getRokuClient())(ip_address);
        const info = await client.getDeviceInfo();
        // If the ECP endpoint responds and returns a serial number or device ID,
        // it's a Roku. Vendor/model name checks fail for onn-branded TVs
        // (vendorName='onn', modelName is a numeric part number).
        // Some Roku-powered devices may only expose device-id, not serial-number.
        if (!info.serialNumber && !info.deviceId) {
          return { success: false, error: 'Device is not a Roku (no serial number or device ID in ECP response)', status: 400 };
        }

        // Manual add is an explicit user action — auto-admit (via_scan marker).
        // Route through the SAME pipeline as network discovery: a synthetic
        // candidate-matched event that the platform DeviceTypeHost probes,
        // admits, and claims. The claim then fans out to device_registry
        // (the single source of truth — D4).
        ctx.emit('discovery:candidate-matched', {
          matchedInterest: { extensionName: 'roku-integration', deviceType: 'roku' },
          candidate: {
            ip: ip_address, ip_address, mac_address: null, via_scan: true,
          },
        });

        // The pipeline is event-driven (not awaited by emit) — poll briefly
        // for the device_registry row the claim creates.
        let device = null;
        for (let i = 0; i < 20 && !device; i++) {
          await new Promise((r) => setTimeout(r, 250));
          const rows = await ctx.data.query('device_registry')
            .where('ip_address', '=', ip_address)
            .get();
          if (rows?.length > 0) [device] = rows;
        }
        if (!device) {
          return { success: false, error: 'Device probe/claim did not complete — check logs', status: 502 };
        }
        return {
          success: true,
          device: {
            device_id: device.id,
            ip_address: device.ip_address,
            name: device.friendly_name || device.name || 'Unknown Roku',
            model: device.model,
            serial_number: device.serial_number,
            firmware_version: device.firmware_version,
          },
        };
      } catch (error) {
        return { success: false, error: `Cannot reach device: ${error.message}`, status: 400 };
      }
    },

    // DELETE /devices/:id
    'DELETE /devices/:id': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) return { success: false, error: 'Device not found', status: 404 };

      // ctx.devices.unregister (fork-host Wave 3 Task 1/2) is OWN-integration-
      // scoped — it throws E_NOT_OWNED if device_registry.integration isn't
      // 'roku-integration'. findDevice() above already filters to roku-owned
      // rows, so that should be unreachable in practice; this catch is
      // defense-in-depth (a race, or the two checks ever drifting) so a
      // surprise E_NOT_OWNED degrades to the same clean 404 rather than an
      // unhandled 500.
      try {
        await ctx.devices.unregister(ctx.params.id);
      } catch (err) {
        if (err && err.code === 'E_NOT_OWNED') {
          return { success: false, error: 'Device not found', status: 404 };
        }
        throw err;
      }

      // device-discovery owns discovery_candidates, so we don't write to it
      // directly from here — emit an event instead (D4). device-discovery
      // marks the matching candidate `ignored` so passive rediscovery (mDNS/
      // SSDP) doesn't immediately re-surface the just-removed Roku as a new
      // pending candidate. Mirrors device-discovery's own
      // POST /candidates/:id/dismiss semantics. ctx.emit forwards to the real
      // globalEventBus in BOTH runtimes, so no platform-presence guard is
      // needed here anymore.
      ctx.emit('discovery:device-unclaimed', {
        deviceId: ctx.params.id,
        ip_address: device.ip_address,
        extensionName: 'roku-integration',
      });

      ctx.broadcast('roku:device-removed', { deviceId: ctx.params.id });

      return { success: true, message: `Removed ${device.name}` };
    },

    // POST /devices/:id/poll -- force immediate poll
    // fork-host Wave 3 Task 2 decision: this used to emit 'polling:poll-now'
    // on ctx.platform.globalEventBus, but that event has had NO listener since
    // the PollingCoordinator that consumed it was deleted (see
    // CLAUDE.md "Waiveo's parallel device stacks") — it was already a silent
    // no-op in-process, not just isolated. A REAL force-poll path DOES exist
    // (extensions/device-discovery/DevicePollingManager.js#pollNow, reached
    // in-process via `ctx.platform.callExtension('device-discovery', 'POST',
    // '/polling/device/:id/poll-now')`, as developer-tools does), but it is
    // only reachable through ctx.platform (still unsupported isolated) — it is
    // NOT exposed as a device-discovery `services:` entry ctx.services could
    // reach isolated, and adding one is out of this task's scope (a
    // device-discovery change, not a roku one). Rather than keep a silent
    // no-op OR reintroduce ctx.platform, this route now returns an honest
    // "not supported" response. Wiring a real isolatable force-poll path is a
    // follow-up: expose device-discovery's pollNow as a cross-extension
    // service.
    'POST /devices/:id/poll': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) return { success: false, error: 'Device not found', status: 404 };

      return {
        success: false,
        error: 'Immediate poll is not supported — the platform DeviceTypeHost polls this device on its own interval',
        status: 501,
      };
    },

    // GET /settings
    'GET /settings': async (ctx) => {
      try {
        const config = await ctx.config.get('settings') || {};
        // passive_discovery_requires_approval (#1671) defaults to true: passive
        // mDNS/SSDP Rokus are held pending until the user approves them.
        // NOTE: no per-extension log_level — logging is governed solely by the
        // system-wide log_level setting (the core console gate), not here.
        const settings = { passive_discovery_requires_approval: true, ...config };
        return { success: true, settings };
      } catch (err) {
        ctx.log(`Failed to get settings: ${err.message}`, 'error');
        return { success: true, settings: { passive_discovery_requires_approval: true } };
      }
    },

    // PUT /settings
    'PUT /settings': async (ctx) => {
      try {
        if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) {
          return { success: false, error: 'Invalid settings: expected JSON object', status: 400 };
        }
        const existing = await ctx.config.get('settings') || {};
        // Clean up any corrupted single-char keys from previous bug
        const cleaned = Object.fromEntries(
          Object.entries(existing).filter(([k]) => k.length > 1 || isNaN(k)),
        );
        await ctx.config.set('settings', { ...cleaned, ...ctx.body });
        return { success: true };
      } catch (err) {
        ctx.log(`Failed to save settings: ${err.message}`, 'error');
        return { success: false, error: err.message };
      }
    },

    // ============================================
    // Fleet — Roku player lifecycle (dev installer :80 + digest)
    // ============================================

    // GET /fleet/dev-credentials — presence + fixed-length mask ONLY, never the
    // plaintext secret and never its real length. Presence is computed per-scope
    // straight from the encrypted secrets store (`roku_dev_password` fleet
    // default + `roku_dev_password:<serial>` per device) — never a config blob.
    'GET /fleet/dev-credentials': async (ctx) => {
      const rows = await queryRokuDevices(ctx);
      const fleetValue = await ctx.secrets.get('roku_dev_password');
      const fleetSet = fleetValue != null;
      const devices = await Promise.all(rows.map(async (d) => {
        const serial = d.serial_number || null;
        const set = serial != null && (await ctx.secrets.get(`roku_dev_password:${serial}`)) != null;
        return {
          device_id: d.id,
          serial,
          name: d.friendly_name || d.name || 'Unknown Roku',
          set,
          masked: set ? DEV_PW_MASK : null,
        };
      }));
      return {
        success: true,
        user: 'rokudev',
        fleet: { set: fleetSet, masked: fleetSet ? DEV_PW_MASK : null },
        devices,
      };
    },

    // PUT /fleet/dev-credentials — body { scope:'fleet'|'device', device_id?,
    // password|null }. Writes/clears the per-scope encrypted secret directly
    // (`roku_dev_password` fleet default, `roku_dev_password:<serial>` per
    // device); password:null|'' deletes the secret. Never echoes it back.
    'PUT /fleet/dev-credentials': async (ctx) => {
      const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
      const { scope } = body;
      if (scope !== 'fleet' && scope !== 'device') {
        return { success: false, error: "Invalid scope: expected 'fleet' or 'device'", status: 400 };
      }
      if (!Object.prototype.hasOwnProperty.call(body, 'password')) {
        return { success: false, error: 'password field required (string to set, null to clear)', status: 400 };
      }
      const { password } = body;
      if (password != null && typeof password !== 'string') {
        return { success: false, error: 'password must be a string or null', status: 400 };
      }
      const clearing = password == null || password === '';
      let targetSerial = null;
      let key;
      if (scope === 'fleet') {
        key = 'roku_dev_password';
      } else {
        if (!body.device_id) {
          return { success: false, error: 'device_id required for device scope', status: 400 };
        }
        const device = await findDevice(ctx, body.device_id);
        if (!device) return { success: false, error: 'Device not found', status: 404 };
        targetSerial = device.serial_number;
        if (!targetSerial) {
          return { success: false, error: 'Device has no serial number; cannot set a per-device password', status: 400 };
        }
        key = `roku_dev_password:${targetSerial}`;
      }
      try {
        if (clearing) await ctx.secrets.delete(key);
        else await ctx.secrets.set(key, password);
      } catch (err) {
        ctx.log(`Fleet: failed to persist dev credential '${key}': ${err.message}`, 'error');
        return { success: false, error: 'Failed to save dev credentials', status: 500 };
      }
      const fleetSet = scope === 'fleet'
        ? !clearing
        : (await ctx.secrets.get('roku_dev_password')) != null;
      const deviceSet = scope === 'device' ? !clearing : undefined;
      return {
        success: true, scope, fleet: { set: fleetSet }, device: scope === 'device' ? { serial: targetSerial, set: deviceSet } : undefined,
      };
    },

    // GET /fleet/release/latest — cached (30s TTL) release metadata backing the
    // "latest available" column. Trusts the GitHub API tag, not a checked-in
    // manifest. ?refresh=1 bypasses the cache.
    'GET /fleet/release/latest': async (ctx) => {
      try {
        const meta = await releaseClient.getLatestMeta({ force: wantsReleaseRefresh(ctx) });
        return {
          success: true,
          release: {
            tag: meta.tag, assetName: meta.assetName, size: meta.size, sha256: meta.sha256,
          },
        };
      } catch (err) {
        ctx.log(`Fleet: release lookup failed: ${err.message}`, 'warn');
        return { success: false, error: err.message, status: err.status || 502 };
      }
    },

    // GET /fleet/players — single aggregate for the fleet table (no N+1). One
    // device_registry read + one token-table read + one cached release lookup
    // (?refresh=1 bypasses the release cache), then a per-device ECP fan-out
    // (auth-free, no :80 digest here).
    'GET /fleet/players': async (ctx) => {
      const rows = await queryRokuDevices(ctx);
      const tokenRows = await readTokenRows(ctx);
      const screenLinks = await readScreenLinks(ctx);
      let latestMeta = null;
      try {
        latestMeta = await releaseClient.getLatestMeta({ force: wantsReleaseRefresh(ctx) });
      } catch (err) {
        ctx.log(`Fleet: release lookup failed (players still returned): ${err.message}`, 'warn');
      }
      const players = await Promise.all(rows.map(async (d) => {
        const device = {
          device_id: d.id,
          name: d.friendly_name || d.name || 'Unknown Roku',
          ip_address: d.ip_address,
          serial_number: d.serial_number || null,
          online: d.online,
        };
        const hasPassword = (await resolveDevPassword(ctx, device.serial_number)) != null;
        return buildPlayerStatus(ctx, device, {
          tokenRows, screenLinks, latestMeta, hasPassword,
        });
      }));
      return { success: true, latest_tag: latestMeta ? latestMeta.tag : null, players };
    },

    // GET /devices/:id/player — single-device player detail (same shape as one
    // /fleet/players row).
    'GET /devices/:id/player': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) return { success: false, error: 'Device not found', status: 404 };
      const tokenRows = await readTokenRows(ctx);
      const screenLinks = await readScreenLinks(ctx);
      let latestMeta = null;
      try {
        latestMeta = await releaseClient.getLatestMeta();
      } catch (err) {
        ctx.log(`Fleet: release lookup failed (player still returned): ${err.message}`, 'warn');
      }
      const hasPassword = (await resolveDevPassword(ctx, device.serial_number)) != null;
      const player = await buildPlayerStatus(ctx, device, {
        tokenRows, screenLinks, latestMeta, hasPassword,
      });
      return { success: true, player };
    },

    // POST /devices/:id/player/update — body { tag? }. Under the per-device
    // mutex: download the release zip (once, cached Buffer), digest-install via
    // :80, gate on "Install Success", then re-read the version over ECP.
    'POST /devices/:id/player/update [stream]': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) { sendJson(ctx, { success: false, error: 'Device not found', status: 404 }); return; }
      const tag = ctx.body && ctx.body.tag ? ctx.body.tag : null;
      sendJson(ctx, await withDeviceLock(device.device_id, async () => {
        try {
          const { buffer, tag: usedTag } = await releaseClient.downloadZip(tag);
          const client = makeDevClient(ctx, device);
          const result = await client.install(buffer);
          if (!result.success) {
            return {
              success: false, error: `Install failed: ${result.message}`, install: result, status: 502,
            };
          }
          const installedVersion = await readInstalledVersion(device.ip_address);
          return {
            success: true, tag: usedTag, installed_version: installedVersion, message: `Installed ${usedTag} on ${device.name}`,
          };
        } catch (err) {
          return devErrorResponse(err);
        }
      }));
    },

    // POST /devices/:id/player/reset — under the per-device mutex: Delete the
    // wedged channel (best-effort) then reinstall latest for a fully clean
    // player + registry.
    'POST /devices/:id/player/reset [stream]': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) { sendJson(ctx, { success: false, error: 'Device not found', status: 404 }); return; }
      const tag = ctx.body && ctx.body.tag ? ctx.body.tag : null;
      sendJson(ctx, await withDeviceLock(device.device_id, async () => {
        try {
          const client = makeDevClient(ctx, device);
          const del = await client.delete(); // best-effort, never throws
          const { buffer, tag: usedTag } = await releaseClient.downloadZip(tag);
          const result = await client.install(buffer);
          if (!result.success) {
            return {
              success: false, error: `Reinstall failed: ${result.message}`, delete: del, install: result, status: 502,
            };
          }
          const installedVersion = await readInstalledVersion(device.ip_address);
          return {
            success: true, tag: usedTag, installed_version: installedVersion, delete: del, message: `Reset player on ${device.name}`,
          };
        } catch (err) {
          return devErrorResponse(err);
        }
      }));
    },

    // POST /devices/:id/player/repair — ECP dev-channel relaunch (a fixed
    // 2.7.1+ build self-heals a stale token → shows a pairing code). Box-side
    // token revoke via slidecast is DEFERRED (blocked on the ctx.user core fix)
    // and called out in the response.
    'POST /devices/:id/player/repair': async (ctx) => {
      const device = await findDevice(ctx, ctx.params.id);
      if (!device) return { success: false, error: 'Device not found', status: 404 };
      return withDeviceLock(device.device_id, async () => {
        try {
          const client = new (await getRokuClient())(device.ip_address);
          await client.launchApp('dev');
          return {
            success: true,
            message: `Relaunched the Waiveo player (dev channel) on ${device.name}. A fixed build (2.7.1+) self-heals a stale token and shows a pairing code — approve it in Slidecast.`,
            note: 'Box-side token revoke is deferred (blocked on the ctx.user core fix); this repair is an ECP dev-channel relaunch only.',
          };
        } catch (err) {
          return { success: false, error: `Re-pair relaunch failed: ${err.message}`, status: 502 };
        }
      });
    },

    // POST /fleet/player/update — body { tag?, device_ids? }. Update-all under
    // the single global fleet lock (2nd concurrent → 409). Downloads the zip
    // ONCE and iterates at concurrency 1 (spec guardrail + box-diagnostics
    // memory) with a per-device timeout; failures roll up rather than abort.
    'POST /fleet/player/update [stream]': async (ctx) => {
      const tag = ctx.body && ctx.body.tag ? ctx.body.tag : null;
      const deviceIds = ctx.body && Array.isArray(ctx.body.device_ids) ? ctx.body.device_ids : null;
      try {
        sendJson(ctx, await runFleetOp(async () => {
          let rows = await queryRokuDevices(ctx);
          if (deviceIds) rows = rows.filter((d) => deviceIds.includes(d.id));
          if (rows.length === 0) {
            return { success: false, error: 'No matching devices to update', status: 400 };
          }
          let buffer;
          let usedTag;
          try {
            const dl = await releaseClient.downloadZip(tag);
            buffer = dl.buffer;
            usedTag = dl.tag;
          } catch (err) {
            return { success: false, error: `Release download failed: ${err.message}`, status: err.status || 502 };
          }
          const results = await runSerial(rows, (d) => {
            const device = {
              device_id: d.id,
              name: d.friendly_name || d.name || 'Unknown Roku',
              ip_address: d.ip_address,
              serial_number: d.serial_number || null,
            };
            return withDeviceLock(device.device_id, async () => {
              try {
                const client = makeDevClient(ctx, device);
                const result = await client.install(buffer);
                return {
                  id: device.device_id,
                  name: device.name,
                  ok: result.success,
                  version: result.success ? usedTag : null,
                  error: result.success ? null : result.message,
                };
              } catch (err) {
                const mapped = devErrorResponse(err);
                return {
                  id: device.device_id, name: device.name, ok: false, version: null, error: mapped.error, dev_state: mapped.dev_state || null,
                };
              }
            });
          }, { timeoutMs: 180000 });
          const updated = results.filter((r) => r.ok).length;
          return {
            success: true, tag: usedTag, total: results.length, updated, failed: results.length - updated, results,
          };
        }));
      } catch (err) {
        if (err.code === 'FLEET_BUSY') {
          sendJson(ctx, { success: false, error: 'A fleet update is already in progress', status: 409 });
          return;
        }
        sendJson(ctx, { success: false, error: err.message, status: err.status || 500 });
      }
    },
  },

  // === Lifecycle ===
  init: async (ctx) => {
    // Register the fleet-default dev password as a declared "need" — the
    // Variables & Secrets page surfaces it as needed until a value exists at
    // key 'roku_dev_password' (fleet scope). Per-device overrides
    // ('roku_dev_password:<serial>') are set ad hoc via PUT
    // /fleet/dev-credentials and are not separately declared needs.
    await ctx.secrets.require('roku_dev_password', {
      label: 'Roku dev-connection password (fleet default)',
      description: 'rokudev digest password used to sideload/control Rokus',
    });

    // One-time migration off the legacy plaintext ctx.config 'dev_credentials'
    // blob onto the per-scope encrypted secrets read above.
    await migrateDevCredentialsToSecrets(ctx);

    // Discovery, polling, and command dispatch are handled ENTIRELY by the
    // platform DeviceTypeHost consuming the declarative `devices:` block above
    // (docs/architecture/device-automation-standard.md). This extension no
    // longer wires polling adapters or discovery listeners itself.

    // D4: the private roku_devices mirror table (and the
    // discovery:device-claimed observer that kept it in sync) is gone —
    // device_registry is the only source of truth. This init() used to carry
    // a one-time idempotent `DROP TABLE IF EXISTS roku_devices` here for boxes
    // still holding the legacy table from before D4 landed. Fork-host Wave 3
    // Task 4: removed outright rather than feature-detected/guarded, because
    // (a) `.raw()` is unsupported in the isolated common-subset ctx.data
    // (E_NOT_SUPPORTED_ISOLATED — it would crash init() on every isolated
    // boot), (b) it's dead weight even in-process: the table was deleted in
    // the device-stack consolidation (2026-07-02) and Waiveo is pre-launch —
    // there is no fleet of old boxes carrying the legacy table to clean up,
    // only the dev lab, which has long since passed through a build after
    // D4. If a genuinely legacy box ever needs it, this is a one-line manual
    // `DROP TABLE` in-process, not something init() needs to carry forever.

    // Register device inspector panel for Developer Tools. The panel payload
    // carries a LIVE FUNCTION (getInspectorData) — un-RPC-able across the
    // isolated fork-host boundary — so this is the one spot left in roku that
    // still reaches for ctx.platform, and it is feature-detected rather than
    // required (fork-host Wave 3 Task 2).
    //
    // Deliberately `'platform' in ctx`, NOT `ctx.platform?.globalEventBus`:
    // in-process, `ctx.platform` is a plain, always-present object key, so
    // either form would work there. Isolated, `ctx` is a Proxy
    // (host-runtime.mjs's makeCtx) whose `get` trap THROWS
    // E_NOT_SUPPORTED_ISOLATED for any key it doesn't recognize — and
    // `platform` isn't one of the real members it builds. Optional chaining
    // only short-circuits a null/undefined RESULT; it does not catch an
    // exception raised while evaluating `ctx.platform` itself, so
    // `ctx.platform?.globalEventBus` would still throw and crash init()
    // isolated. `'platform' in ctx` instead hits the Proxy's default `has`
    // trap (`Reflect.has(target, 'platform')`), which just answers `false`
    // with no throw — the safe way to ask "does this ctx even have a
    // platform key" without risking a crash.
    if ('platform' in ctx && ctx.platform && ctx.platform.globalEventBus) {
      ctx.platform.globalEventBus.emit('polling:register-inspector-panel', {
        deviceType: 'roku',
        getInspectorData: async (device, client) => {
          if (!client) client = new (await getRokuClient())(device.ip_address);

          try {
            const [apps, activeApp, info] = await Promise.all([
              client.getApps().catch(() => []),
              client.getActiveApp().catch(() => null),
              client.getDeviceInfo().catch(() => ({})),
            ]);

            return {
              tabs: [
                { id: 'apps', label: 'Apps', data: { installed: apps, active: activeApp } },
                { id: 'info', label: 'Device Info', data: info },
                { id: 'remote', label: 'Remote', component: 'roku-remote' },
              ],
            };
          } catch (error) {
            ctx.log(`Error getting inspector data: ${error.message}`, 'warn');
            return { tabs: [] };
          }
        },
      });
      ctx.log('Registered inspector panel for roku', 'info');
    } else {
      ctx.log('Inspector panel unavailable in isolated mode (ctx.platform not present)', 'warn');
    }

    ctx.log('Roku Integration initialized', 'info');
  },
};
