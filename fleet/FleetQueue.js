/**
 * FleetQueue - module-level serialization primitives for fleet operations.
 *
 * Three guarantees (spec guardrail + box-diagnostics memory: heavy concurrent
 * sideloads peg the box CPU and saturate the LAN):
 *  1. withDeviceLock(deviceId, fn) - per-device promise-chain mutex, so two
 *     ops on the SAME Roku (e.g. update while a reset is mid-flight) serialize.
 *  2. runFleetOp(fn) - a single global fleet mutex; a second concurrent
 *     fleet-wide op is REJECTED with a 409 rather than queued (no stacking).
 *  3. runSerial(items, worker) - iterate at concurrency 1 with a per-item
 *     timeout; failures are collected into the rollup, never thrown, so one
 *     wedged Roku cannot stall the whole roll.
 *
 * State is module-scoped so it persists within a load and is cleanly recreated
 * on hot-reload. __resetForTests() clears it between unit tests.
 */

const deviceLocks = new Map(); // deviceId -> tail promise (always resolves)
let fleetBusy = false;

/**
 * Serialize `fn` against any other op for the same deviceId. Returns fn()'s
 * result (or rejection); the internal chain swallows errors so a failed op
 * does not wedge the lock for the device.
 */
export function withDeviceLock(deviceId, fn) {
  const prev = deviceLocks.get(deviceId) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(() => {}, () => {});
  deviceLocks.set(deviceId, tail);
  // Best-effort cleanup so the Map does not grow unbounded: if nothing else
  // chained after us, drop the entry once we settle.
  tail.then(() => {
    if (deviceLocks.get(deviceId) === tail) deviceLocks.delete(deviceId);
  });
  return run;
}

export function isFleetBusy() {
  return fleetBusy;
}

/**
 * Run `fn` under the single global fleet lock. A concurrent call while a fleet
 * op is in flight throws a 409 (FLEET_BUSY) instead of queueing.
 */
export async function runFleetOp(fn) {
  if (fleetBusy) {
    const err = new Error('A fleet operation is already in progress');
    err.code = 'FLEET_BUSY';
    err.status = 409;
    throw err;
  }
  fleetBusy = true;
  try {
    return await fn();
  } finally {
    fleetBusy = false;
  }
}

/**
 * Wrap a promise with a timeout. Rejects with a TIMEOUT error after `ms`.
 * ms <= 0 disables the timeout.
 */
export function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`Operation timed out after ${ms}ms`);
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Iterate `items` strictly one at a time (concurrency 1). `worker(item, i)` is
 * awaited under a per-item timeout; a rejection is captured as
 * { ok:false, error, item } in the returned rollup rather than thrown.
 */
export async function runSerial(items, worker, { timeoutMs = 120000 } = {}) {
  const results = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const value = await withTimeout(Promise.resolve().then(() => worker(item, i)), timeoutMs);
      results.push(value);
    } catch (err) {
      results.push({ ok: false, error: err.message, item });
    }
  }
  return results;
}

/** Test-only: reset module state between unit tests. */
export function __resetForTests() {
  deviceLocks.clear();
  fleetBusy = false;
}

export default {
  withDeviceLock,
  runFleetOp,
  runSerial,
  withTimeout,
  isFleetBusy,
  __resetForTests,
};
