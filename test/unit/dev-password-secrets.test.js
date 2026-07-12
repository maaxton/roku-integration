/**
 * Variables & Secrets plan, Phase 4 / Task 8 — the Roku dev-connection
 * password moves off the plaintext `ctx.config` 'dev_credentials' blob onto
 * per-scope ENCRYPTED secrets in the central store: fleet default at key
 * 'roku_dev_password', per-device override at 'roku_dev_password:<serial>'
 * (per-device wins). Covers:
 *   - resolveDevPassword's precedence (exported for direct testing)
 *   - PUT /fleet/dev-credentials writes/clears via ctx.secrets, never ctx.config
 *   - GET /fleet/dev-credentials computes presence from ctx.secrets
 *   - migrateDevCredentialsToSecrets: one-time blob -> secrets migration that
 *     never loses the password on failure
 *   - init() registers the fleet-default need via ctx.secrets.require
 *
 * Bare specifier resolved by vitest.config.js resolve.alias (roku-integration/
 * -> repo root), same pattern as roku-platform-lite.test.js.
 */
import { describe, it, expect } from 'vitest';
import roku, { resolveDevPassword, migrateDevCredentialsToSecrets, DEV_PW_MASK } from 'roku-integration/index.js';

/** A minimal `ctx.data.query(table)` stand-in — mirrors roku-platform-lite.test.js. */
function makeMockDataQuery(rowsByTable) {
  return {
    query: (table) => {
      const filters = [];
      const builder = {
        where(field, op, value) {
          filters.push([field, op, value]);
          return builder;
        },
        async get() {
          const rows = rowsByTable[table] || [];
          return rows.filter((row) => filters.every(([field, op, value]) => {
            if (op === '=') return row[field] === value;
            throw new Error(`mock ctx.data.query: unsupported op '${op}'`);
          }));
        },
        async first() {
          const rows = await builder.get();
          return rows[0] || null;
        },
      };
      return builder;
    },
  };
}

/** In-memory ctx.secrets stand-in (get/set/delete/require) with call tracking,
 * mirroring the real ContextFactory.js `ctx.secrets` sugar's shape/semantics
 * (get returns null for an absent key; set/delete never echo plaintext back
 * to the caller in this test — callers only inspect `store` directly). */
function makeSecretsStore(initial = {}) {
  const store = { ...initial };
  const calls = {
    get: [], set: [], delete: [], require: [],
  };
  return {
    store,
    calls,
    secrets: {
      get: async (key) => {
        calls.get.push(key);
        return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
      },
      set: async (key, value) => {
        calls.set.push([key, value]);
        store[key] = value;
        return { key, owner_extension: 'roku-integration' };
      },
      delete: async (key) => {
        calls.delete.push(key);
        const had = Object.prototype.hasOwnProperty.call(store, key);
        delete store[key];
        return { deleted: had ? 1 : 0 };
      },
      require: async (key, meta) => {
        calls.require.push([key, meta]);
        return { key, owner_extension: 'roku-integration' };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// resolveDevPassword precedence
// ---------------------------------------------------------------------------

describe('resolveDevPassword — per-device secret wins over the fleet default', () => {
  it('returns the per-device secret when both are set', async () => {
    const { secrets } = makeSecretsStore({
      roku_dev_password: 'fleetpw',
      'roku_dev_password:SER1': 'devicepw',
    });
    await expect(resolveDevPassword({ secrets }, 'SER1')).resolves.toBe('devicepw');
  });

  it('falls back to the fleet default when no per-device secret is set', async () => {
    const { secrets } = makeSecretsStore({ roku_dev_password: 'fleetpw' });
    await expect(resolveDevPassword({ secrets }, 'SER1')).resolves.toBe('fleetpw');
  });

  it('returns null when neither scope has a value', async () => {
    const { secrets } = makeSecretsStore();
    await expect(resolveDevPassword({ secrets }, 'SER1')).resolves.toBeNull();
  });

  it('a null serial skips the per-device lookup entirely and reads only the fleet key', async () => {
    const { secrets, calls } = makeSecretsStore({ roku_dev_password: 'fleetpw' });
    await expect(resolveDevPassword({ secrets }, null)).resolves.toBe('fleetpw');
    expect(calls.get).toEqual(['roku_dev_password']);
  });
});

// ---------------------------------------------------------------------------
// PUT /fleet/dev-credentials — writes to ctx.secrets, never ctx.config
// ---------------------------------------------------------------------------

describe('PUT /fleet/dev-credentials — writes/clears via ctx.secrets, never ctx.config', () => {
  it('fleet scope: sets roku_dev_password via ctx.secrets.set, never touches ctx.config', async () => {
    const { secrets, calls, store } = makeSecretsStore();
    const configSetCalls = [];
    const ctx = {
      secrets,
      config: { set: async (...args) => configSetCalls.push(args), get: async () => null },
      body: { scope: 'fleet', password: 'newpw' },
      log: () => {},
    };
    const result = await roku.routes['PUT /fleet/dev-credentials'](ctx);
    expect(result).toEqual({
      success: true, scope: 'fleet', fleet: { set: true }, device: undefined,
    });
    expect(calls.set).toEqual([['roku_dev_password', 'newpw']]);
    expect(configSetCalls).toEqual([]);
    expect(store.roku_dev_password).toBe('newpw');
  });

  it('fleet scope: password:null clears via ctx.secrets.delete', async () => {
    const { secrets, calls, store } = makeSecretsStore({ roku_dev_password: 'old' });
    const ctx = {
      secrets, config: { set: async () => {}, get: async () => null }, body: { scope: 'fleet', password: null }, log: () => {},
    };
    const result = await roku.routes['PUT /fleet/dev-credentials'](ctx);
    expect(result.fleet).toEqual({ set: false });
    expect(calls.delete).toEqual(['roku_dev_password']);
    expect(store).not.toHaveProperty('roku_dev_password');
  });

  it('device scope: sets roku_dev_password:<serial>, resolved from the device\'s serial_number', async () => {
    const { secrets, calls } = makeSecretsStore();
    const ctx = {
      secrets,
      config: { set: async () => {}, get: async () => null },
      data: makeMockDataQuery({
        device_registry: [{
          id: 'roku:1', integration: 'roku-integration', serial_number: 'SER1', friendly_name: 'Living Room',
        }],
      }),
      body: { scope: 'device', device_id: 'roku:1', password: 'devpw' },
      log: () => {},
    };
    const result = await roku.routes['PUT /fleet/dev-credentials'](ctx);
    expect(result).toEqual({
      success: true, scope: 'device', fleet: { set: false }, device: { serial: 'SER1', set: true },
    });
    expect(calls.set).toEqual([['roku_dev_password:SER1', 'devpw']]);
  });

  it("device scope: password:'' clears the per-device secret via ctx.secrets.delete", async () => {
    const { secrets, calls } = makeSecretsStore({ 'roku_dev_password:SER1': 'old' });
    const ctx = {
      secrets,
      config: { set: async () => {}, get: async () => null },
      data: makeMockDataQuery({
        device_registry: [{
          id: 'roku:1', integration: 'roku-integration', serial_number: 'SER1', friendly_name: 'Living Room',
        }],
      }),
      body: { scope: 'device', device_id: 'roku:1', password: '' },
      log: () => {},
    };
    const result = await roku.routes['PUT /fleet/dev-credentials'](ctx);
    expect(result.device).toEqual({ serial: 'SER1', set: false });
    expect(calls.delete).toEqual(['roku_dev_password:SER1']);
  });

  it('device scope: 404s for an unknown device_id and never touches ctx.secrets', async () => {
    const { secrets, calls } = makeSecretsStore();
    const ctx = {
      secrets,
      config: { set: async () => {}, get: async () => null },
      data: makeMockDataQuery({ device_registry: [] }),
      body: { scope: 'device', device_id: 'roku:missing', password: 'x' },
      log: () => {},
    };
    const result = await roku.routes['PUT /fleet/dev-credentials'](ctx);
    expect(result).toEqual({ success: false, error: 'Device not found', status: 404 });
    expect(calls.set).toEqual([]);
    expect(calls.delete).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /fleet/dev-credentials — presence computed from ctx.secrets
// ---------------------------------------------------------------------------

describe('GET /fleet/dev-credentials — reports set/masked from ctx.secrets, never plaintext, never ctx.config', () => {
  it('fleet + per-device presence reflects the secrets store, masked value is the constant mask', async () => {
    const { secrets } = makeSecretsStore({
      roku_dev_password: 'fleetpw',
      'roku_dev_password:SER1': 'devpw',
    });
    const configGetCalls = [];
    const ctx = {
      secrets,
      config: { get: async (key) => { configGetCalls.push(key); return null; } },
      data: makeMockDataQuery({
        device_registry: [
          {
            id: 'roku:1', device_type: 'roku', serial_number: 'SER1', friendly_name: 'Living Room',
          },
          {
            id: 'roku:2', device_type: 'roku', serial_number: 'SER2', friendly_name: 'Bedroom',
          },
        ],
      }),
      log: () => {},
    };
    const result = await roku.routes['GET /fleet/dev-credentials'](ctx);
    expect(result.success).toBe(true);
    expect(result.fleet).toEqual({ set: true, masked: DEV_PW_MASK });
    expect(result.devices).toEqual([
      {
        device_id: 'roku:1', serial: 'SER1', name: 'Living Room', set: true, masked: DEV_PW_MASK,
      },
      {
        device_id: 'roku:2', serial: 'SER2', name: 'Bedroom', set: false, masked: null,
      },
    ]);
    expect(configGetCalls).toEqual([]); // never reads the legacy config blob anymore
    const asJson = JSON.stringify(result);
    expect(asJson).not.toContain('fleetpw');
    expect(asJson).not.toContain('devpw');
  });

  it('reports not-set when the secrets store is empty', async () => {
    const { secrets } = makeSecretsStore();
    const ctx = {
      secrets,
      config: { get: async () => null },
      data: makeMockDataQuery({ device_registry: [] }),
      log: () => {},
    };
    const result = await roku.routes['GET /fleet/dev-credentials'](ctx);
    expect(result.fleet).toEqual({ set: false, masked: null });
    expect(result.devices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// migrateDevCredentialsToSecrets — one-time blob -> secrets migration
// ---------------------------------------------------------------------------

describe('migrateDevCredentialsToSecrets — moves the legacy blob to per-scope secrets and clears it', () => {
  it('migrates fleet_default + per_device to secrets, then clears the config blob', async () => {
    const { secrets, store } = makeSecretsStore();
    const configStore = {
      dev_credentials: { fleet_default: 'fleetpw', per_device: { SER1: 'devpw1', SER2: '' } },
    };
    const logs = [];
    const ctx = {
      secrets,
      config: {
        get: async (key) => configStore[key] ?? null,
        set: async (key, value) => { configStore[key] = value; },
      },
      log: (message, level) => logs.push({ message, level }),
    };
    await migrateDevCredentialsToSecrets(ctx);
    expect(store.roku_dev_password).toBe('fleetpw');
    expect(store['roku_dev_password:SER1']).toBe('devpw1');
    expect(store).not.toHaveProperty('roku_dev_password:SER2'); // empty string = nothing to migrate
    expect(configStore.dev_credentials).toBeNull(); // legacy blob cleared
    expect(logs.some((l) => l.level === 'info' && l.message.includes('migrated dev_credentials'))).toBe(true);
  });

  it('no-op when there is no legacy blob (already migrated / fresh install)', async () => {
    const { secrets, calls } = makeSecretsStore();
    let configSetCalled = false;
    const ctx = {
      secrets,
      config: {
        get: async () => null,
        set: async () => { configSetCalled = true; },
      },
      log: () => {},
    };
    await migrateDevCredentialsToSecrets(ctx);
    expect(calls.set).toEqual([]);
    expect(configSetCalled).toBe(false);
  });

  it('on a ctx.secrets.set failure (e.g. E_NO_SECRETS_KEY), leaves the plaintext blob in place and warns — never loses the password', async () => {
    const configStore = {
      dev_credentials: { fleet_default: 'fleetpw', per_device: { SER1: 'devpw1' } },
    };
    const logs = [];
    const ctx = {
      secrets: {
        get: async () => null,
        set: async () => { const e = new Error('secrets key not configured'); e.code = 'E_NO_SECRETS_KEY'; throw e; },
        delete: async () => {},
      },
      config: {
        get: async (key) => configStore[key] ?? null,
        set: async (key, value) => { configStore[key] = value; },
      },
      log: (message, level) => logs.push({ message, level }),
    };
    await migrateDevCredentialsToSecrets(ctx);
    expect(configStore.dev_credentials).toEqual({ fleet_default: 'fleetpw', per_device: { SER1: 'devpw1' } }); // untouched
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('migration to secrets failed'))).toBe(true);
  });

  it('a config.get failure is non-fatal (warns and returns without attempting a migration)', async () => {
    const logs = [];
    const { secrets, calls } = makeSecretsStore();
    const ctx = {
      secrets,
      config: { get: async () => { throw new Error('db locked'); }, set: async () => { throw new Error('should not be called'); } },
      log: (message, level) => logs.push({ message, level }),
    };
    await expect(migrateDevCredentialsToSecrets(ctx)).resolves.toBeUndefined();
    expect(calls.set).toEqual([]);
    expect(logs.some((l) => l.level === 'warn')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// init() — registers the fleet-default need
// ---------------------------------------------------------------------------

describe('init() — registers the roku_dev_password fleet-default need via ctx.secrets.require', () => {
  it('calls ctx.secrets.require with the documented key/label/description', async () => {
    const { secrets, calls } = makeSecretsStore();
    const ctx = {
      secrets,
      config: { get: async () => null, set: async () => {} },
      log: () => {},
    };
    await roku.init(ctx);
    expect(calls.require).toEqual([[
      'roku_dev_password',
      {
        label: 'Roku dev-connection password (fleet default)',
        description: 'rokudev digest password used to sideload/control Rokus',
      },
    ]]);
  });

  it('also runs the migration during init (blob present -> migrated to secrets)', async () => {
    const { secrets, store } = makeSecretsStore();
    const configStore = { dev_credentials: { fleet_default: 'fleetpw', per_device: {} } };
    const ctx = {
      secrets,
      config: {
        get: async (key) => configStore[key] ?? null,
        set: async (key, value) => { configStore[key] = value; },
      },
      log: () => {},
    };
    await roku.init(ctx);
    expect(store.roku_dev_password).toBe('fleetpw');
    expect(configStore.dev_credentials).toBeNull();
  });
});
