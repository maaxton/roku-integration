/**
 * Fork-host Wave 3, Task 2 — roku-integration refactored off `ctx.platform` onto the
 * Wave-3 "platform-lite" verbs (`ctx.devices.unregister`, `ctx.emit`) + the isolated
 * inspector-panel feature-detect (spec `docs/superpowers/plans/2026-07-08-fork-host-wave3.md`).
 *
 * Two layers:
 *   1. In-process-shaped mock ctx (plain object, mirrors ContextFactory's ctx shape) —
 *      exercises the REAL route handlers exported by `index.js` for the specific
 *      behavior changes Task 2 makes: DELETE /devices/:id now calls
 *      `ctx.devices.unregister` (own-integration-scoped) and degrades an `E_NOT_OWNED`
 *      rejection to a clean 404 rather than an unhandled 500 (never swallowing any OTHER
 *      error); POST /devices/:id/poll no longer emits the orphaned 'polling:poll-now'
 *      event and instead returns an honest 501; and `init()` still registers the
 *      Developer-Tools inspector panel via `ctx.platform.globalEventBus` exactly as
 *      before when `ctx.platform` is present (in-process byte-identical).
 *   2. A LOCAL throwing-Proxy stand-in for the monorepo core's real isolated ctx
 *      (`backend/src/sdk/isolation/host-runtime.mjs`'s `makeCtx()`) — a Proxy whose
 *      `get` trap THROWS `E_NOT_SUPPORTED_ISOLATED` for any member it doesn't
 *      recognize (including `platform`, which is a plain, real, always-present key
 *      in-process but is NOT one of the isolated ctx's built members). This is the
 *      layer that actually proves the fix: a naive `ctx.platform?.globalEventBus`
 *      guard does NOT protect against this Proxy, because optional chaining only
 *      short-circuits a null/undefined RESULT — it does not catch an exception
 *      thrown while EVALUATING `ctx.platform` itself. `init()` uses
 *      `'platform' in ctx` instead (the Proxy's default `has` trap, `Reflect.has`,
 *      never throws), which this layer proves actually works against a faithful
 *      isolated-ctx stand-in, not just a plain object.
 *
 *      Moved out of the waiveo monorepo in marketplace v2 Phase 4 (core
 *      extraction — the monorepo backend test suite no longer imports
 *      roku-integration source). The real `host-runtime.mjs` Proxy + IPC broker
 *      rig is core infrastructure and is covered by the monorepo core's own
 *      host-runtime tests; here we only need to prove roku's handlers/init()
 *      behave correctly against an isolated ctx shaped the same way — (a) never
 *      crash accessing `ctx.platform`, (b) feature-detect via `'x' in ctx`.
 */
import {
  describe, it, expect,
} from 'vitest';
// Bare specifier resolved by vitest.config.js resolve.alias (roku-integration/ → repo root).
import roku from 'roku-integration/index.js';

// ---------------------------------------------------------------------------
// Layer 1 — in-process-shaped mock ctx
// ---------------------------------------------------------------------------

/** A minimal `ctx.data.query(table)` stand-in supporting the chainable
 * `.where(field, '=', value).where(...).get()/.first()` subset roku's
 * `findDevice` actually uses. Filters an in-memory fixture, so tests never
 * touch a real DB. */
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

function makeInProcessCtx({
  rowsByTable = {}, unregisterImpl, platform,
} = {}) {
  const calls = {
    emit: [], broadcast: [], unregister: [], log: [],
  };
  return {
    ctx: {
      params: { id: 'roku:1' },
      data: makeMockDataQuery(rowsByTable),
      devices: { unregister: (id) => { calls.unregister.push(id); return unregisterImpl(id); } },
      emit: (event, data) => calls.emit.push({ event, data }),
      broadcast: (event, data) => calls.broadcast.push({ event, data }),
      log: (message, level) => calls.log.push({ message, level }),
      config: { get: async () => null },
      // ctx.secrets sugar (mirrors ContextFactory.js's in-process shape,
      // added alongside the Roku dev-password → encrypted-secrets migration).
      secrets: {
        require: async () => ({}),
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      },
      ...(platform !== undefined ? { platform } : {}),
    },
    calls,
  };
}

const ROKU_ROW = {
  id: 'roku:1', integration: 'roku-integration', ip_address: '10.0.0.5', friendly_name: 'Living Room Roku',
};
const FOREIGN_ROW = {
  id: 'other:1', integration: 'virtual-device', ip_address: '10.0.0.9', friendly_name: 'Not A Roku',
};

describe('roku DELETE /devices/:id — uses ctx.devices.unregister (own-scoped), never ctx.platform', () => {
  it('on an owned device: unregisters, emits discovery:device-unclaimed via ctx.emit, broadcasts, returns success', async () => {
    const { ctx, calls } = makeInProcessCtx({
      rowsByTable: { device_registry: [ROKU_ROW] },
      unregisterImpl: async () => true,
    });
    const result = await roku.routes['DELETE /devices/:id'](ctx);
    expect(result).toEqual({ success: true, message: 'Removed Living Room Roku' });
    expect(calls.unregister).toEqual(['roku:1']);
    expect(calls.emit).toEqual([{
      event: 'discovery:device-unclaimed',
      data: { deviceId: 'roku:1', ip_address: '10.0.0.5', extensionName: 'roku-integration' },
    }]);
    expect(calls.broadcast).toEqual([{ event: 'roku:device-removed', data: { deviceId: 'roku:1' } }]);
  });

  it('findDevice is own-integration-scoped: a device_registry row owned by ANOTHER integration 404s and never reaches unregister', async () => {
    const { ctx, calls } = makeInProcessCtx({
      rowsByTable: { device_registry: [{ ...FOREIGN_ROW, id: 'roku:1' }] }, // same id, foreign integration
      unregisterImpl: async () => true,
    });
    const result = await roku.routes['DELETE /devices/:id'](ctx);
    expect(result).toEqual({ success: false, error: 'Device not found', status: 404 });
    expect(calls.unregister).toEqual([]);
    expect(calls.emit).toEqual([]);
  });

  it('ctx.devices.unregister rejecting E_NOT_OWNED (defense-in-depth) degrades to a clean 404, not an unhandled 500', async () => {
    const { ctx, calls } = makeInProcessCtx({
      rowsByTable: { device_registry: [ROKU_ROW] },
      unregisterImpl: async () => {
        const err = new Error("'roku-integration' does not own device 'roku:1'");
        err.code = 'E_NOT_OWNED';
        throw err;
      },
    });
    const result = await roku.routes['DELETE /devices/:id'](ctx);
    expect(result).toEqual({ success: false, error: 'Device not found', status: 404 });
    expect(calls.unregister).toEqual(['roku:1']); // it WAS attempted — proves this exercised the real verb
    expect(calls.emit).toEqual([]); // never reached the unclaimed emit
    expect(calls.broadcast).toEqual([]);
  });

  it('a NON-E_NOT_OWNED error from ctx.devices.unregister propagates — never silently swallowed', async () => {
    const { ctx } = makeInProcessCtx({
      rowsByTable: { device_registry: [ROKU_ROW] },
      unregisterImpl: async () => { throw new Error('database is locked'); },
    });
    await expect(roku.routes['DELETE /devices/:id'](ctx)).rejects.toThrow('database is locked');
  });
});

describe('roku POST /devices/:id/poll — the orphaned polling:poll-now emit is gone; honest 501, not a silent no-op', () => {
  it('returns a clear "not supported" response and never calls ctx.emit', async () => {
    const { ctx, calls } = makeInProcessCtx({ rowsByTable: { device_registry: [ROKU_ROW] } });
    const result = await roku.routes['POST /devices/:id/poll'](ctx);
    expect(result.success).toBe(false);
    expect(result.status).toBe(501);
    expect(calls.emit).toEqual([]);
  });

  it('still 404s for an unknown/non-owned device (findDevice check runs first)', async () => {
    const { ctx } = makeInProcessCtx({ rowsByTable: { device_registry: [] } });
    const result = await roku.routes['POST /devices/:id/poll'](ctx);
    expect(result).toEqual({ success: false, error: 'Device not found', status: 404 });
  });
});

describe('roku POST /devices/add — discovery:candidate-matched now rides ctx.emit, not ctx.platform', () => {
  it('the route source calls ctx.emit(\'discovery:candidate-matched\', ...) and no longer references ctx.platform for it', () => {
    // POST /devices/add reaches a real RokuClient (ECP network probe) before the emit,
    // so it is exercised at the source level here rather than invoked end-to-end (no
    // hardware / mocked network stack in this unit tier) — the emit-vs-platform switch
    // itself is fully covered behaviorally by the DELETE route tests above, which hit
    // the identical `ctx.emit(name, payload)` call shape.
    const fn = roku.routes['POST /devices/add'].toString();
    expect(fn).toContain("ctx.emit('discovery:candidate-matched'");
    expect(fn).not.toContain('ctx.platform');
  });
});

describe('roku init() — in-process byte-identical: still registers the inspector panel via ctx.platform when present', () => {
  it('calls ctx.platform.globalEventBus.emit(\'polling:register-inspector-panel\', ...) and logs success', async () => {
    const inspectorCalls = [];
    const { ctx, calls } = makeInProcessCtx({
      platform: { globalEventBus: { emit: (event, payload) => inspectorCalls.push({ event, payload }) } },
    });
    await roku.init(ctx);
    expect(inspectorCalls).toHaveLength(1);
    expect(inspectorCalls[0].event).toBe('polling:register-inspector-panel');
    expect(inspectorCalls[0].payload.deviceType).toBe('roku');
    expect(typeof inspectorCalls[0].payload.getInspectorData).toBe('function');
    expect(calls.log.some((l) => l.message === 'Registered inspector panel for roku')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — a local throwing-Proxy stand-in for the REAL isolated ctx
// (host-runtime.mjs's makeCtx), reproducing the specific behavior roku's
// handlers/init() depend on: any member NOT explicitly built throws
// E_NOT_SUPPORTED_ISOLATED on GET, while `'x' in ctx` never throws.
// ---------------------------------------------------------------------------

describe('roku against an isolated-ctx stand-in — never crashes on ctx.platform', () => {
  // Local stand-in for host-runtime.mjs's makeCtx isolated Proxy: any member NOT
  // explicitly built throws E_NOT_SUPPORTED_ISOLATED on GET (like the real isolated
  // ctx), while `'x' in ctx` uses Reflect.has and never throws. The real host-runtime
  // IPC wiring is covered by the monorepo core's own host-runtime tests; here we only
  // need roku to (a) not crash accessing ctx.platform and (b) feature-detect via `in`.
  function makeIsolatedCtx(built) {
    return new Proxy(built, {
      get(t, p) {
        if (p in t) return t[p];
        const e = new Error(`E_NOT_SUPPORTED_ISOLATED: ${String(p)}`);
        e.code = 'E_NOT_SUPPORTED_ISOLATED';
        throw e;
      },
      has(t, p) { return Reflect.has(t, p); },
    });
  }

  /** Build an isolated-shaped ctx from the SAME mock members Layer 1 uses above
   * (deliberately no `platform` key, so accessing it falls through the Proxy's
   * throwing `get` trap exactly like the real isolated ctx). */
  function wireIsolatedCtx({
    rowsByTable = {}, unregisterImpl = async () => true, configValues = {},
  } = {}) {
    const built = {
      params: { id: 'roku:1' },
      data: makeMockDataQuery(rowsByTable),
      devices: { unregister: (id) => unregisterImpl(id) },
      emit: () => {},
      broadcast: () => {},
      config: {
        get: async (key) => (Object.prototype.hasOwnProperty.call(configValues, key) ? configValues[key] : null),
      },
      // ctx.secrets: assumed wired as a real isolated `built` member (same
      // treatment as `entities`/`devices` in Wave 3 Task 1) backing the
      // roku_dev_password migration below. NOTE: as of this change,
      // backend/src/sdk/isolation/host-runtime.mjs's makeCtx() does NOT yet
      // build a `secrets` member — only ContextFactory.js (in-process) does
      // (Variables & Secrets plan Task 4). Until host-runtime.mjs is updated
      // to match, a REAL isolated roku-integration host would throw
      // E_NOT_SUPPORTED_ISOLATED on this init() step. Tracked as a follow-up;
      // this stand-in models the intended contract, not the current gap.
      secrets: {
        require: async () => ({}),
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      },
      log: () => {},
    };
    return makeIsolatedCtx(built);
  }

  it('sanity check: ctx.platform on this stand-in DOES throw E_NOT_SUPPORTED_ISOLATED (proves the rig is faithful)', () => {
    const ctx = wireIsolatedCtx();
    let caught;
    try {
      // eslint-disable-next-line no-unused-expressions
      ctx.platform;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe('E_NOT_SUPPORTED_ISOLATED');
  });

  it('GET /settings runs end-to-end over the isolated-ctx stand-in with zero ctx.platform involvement', async () => {
    const ctx = wireIsolatedCtx({ configValues: {} });
    const result = await roku.routes['GET /settings'](ctx);
    expect(result).toEqual({ success: true, settings: { passive_discovery_requires_approval: true } });
  });

  it('DELETE /devices/:id (owned device) runs end-to-end isolated: ctx.devices.unregister + ctx.emit, no ctx.platform crash', async () => {
    const ctx = wireIsolatedCtx({ rowsByTable: { device_registry: [ROKU_ROW] } });
    const result = await roku.routes['DELETE /devices/:id'](ctx);
    expect(result).toEqual({ success: true, message: 'Removed Living Room Roku' });
  });

  it('DELETE /devices/:id (non-owned device) 404s cleanly isolated — never touches ctx.platform', async () => {
    const ctx = wireIsolatedCtx({ rowsByTable: { device_registry: [] } }); // findDevice's own integration filter already excludes it
    const result = await roku.routes['DELETE /devices/:id'](ctx);
    expect(result).toEqual({ success: false, error: 'Device not found', status: 404 });
  });

  it('POST /devices/:id/poll returns the honest 501 isolated, never touches ctx.platform', async () => {
    const ctx = wireIsolatedCtx({ rowsByTable: { device_registry: [ROKU_ROW] } });
    const result = await roku.routes['POST /devices/:id/poll'](ctx);
    expect(result.success).toBe(false);
    expect(result.status).toBe(501);
  });

  it('init() completes isolated WITHOUT crashing on ctx.platform — feature-detects and skips the inspector panel', async () => {
    const logs = [];
    // No `ctx.data` needed: init() no longer touches `ctx.data` at all (the legacy
    // `DROP TABLE roku_devices` raw-SQL call was removed outright in fork-host Wave 3
    // Task 4 — dead cleanup for a table deleted in the device-stack consolidation).
    // `config`/`secrets` ARE needed now: init() registers the roku_dev_password
    // need and runs the one-time dev_credentials → secrets migration (see the
    // `secrets` comment on `wireIsolatedCtx` above for the isolated-wiring caveat).
    const ctx = makeIsolatedCtx({
      params: {},
      log: (message, level) => logs.push({ message, level }),
      config: { get: async () => null, set: async () => {} },
      secrets: {
        require: async () => ({}),
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      },
    });
    await expect(roku.init(ctx)).resolves.toBeUndefined();
    expect(logs.some((l) => l.message.includes('Inspector panel unavailable in isolated mode'))).toBe(true);
    expect(logs.some((l) => l.message === 'Roku Integration initialized')).toBe(true);
  });
});
