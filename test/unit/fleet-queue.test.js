import {
  describe, it, expect, beforeEach,
} from 'vitest';
import {
  withDeviceLock,
  runFleetOp,
  runSerial,
  withTimeout,
  isFleetBusy,
  __resetForTests,
} from 'roku-integration/fleet/FleetQueue.js';

const delay = (ms) => new Promise((r) => { setTimeout(r, ms); });

beforeEach(() => __resetForTests());

describe('withDeviceLock', () => {
  it('serializes ops on the SAME device (no interleave)', async () => {
    let active = 0;
    let maxActive = 0;
    const work = (id) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active -= 1;
      return id;
    };

    const p1 = withDeviceLock('roku-1', work('a'));
    const p2 = withDeviceLock('roku-1', work('b'));
    const results = await Promise.all([p1, p2]);

    expect(maxActive).toBe(1); // never two at once on the same device
    expect(results).toEqual(['a', 'b']); // FIFO order preserved
  });

  it('allows different devices to run concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const work = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active -= 1;
    };

    await Promise.all([withDeviceLock('roku-a', work), withDeviceLock('roku-b', work)]);
    expect(maxActive).toBe(2);
  });

  it('a failed op does not wedge the lock for subsequent ops', async () => {
    const p1 = withDeviceLock('roku-x', async () => { throw new Error('fail'); });
    await expect(p1).rejects.toThrow('fail');
    const p2 = withDeviceLock('roku-x', async () => 'ok');
    await expect(p2).resolves.toBe('ok');
  });
});

describe('runFleetOp', () => {
  it('rejects a 2nd concurrent fleet op with 409 FLEET_BUSY', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });

    const first = runFleetOp(() => gate); // holds the global lock
    expect(isFleetBusy()).toBe(true);

    await expect(runFleetOp(async () => 'second')).rejects.toMatchObject({
      status: 409,
      code: 'FLEET_BUSY',
    });

    release('first-done');
    await expect(first).resolves.toBe('first-done');
    expect(isFleetBusy()).toBe(false);

    // Lock released → a fresh fleet op is allowed.
    await expect(runFleetOp(async () => 'again')).resolves.toBe('again');
  });

  it('releases the lock even if the fleet op throws', async () => {
    await expect(runFleetOp(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(isFleetBusy()).toBe(false);
  });
});

describe('runSerial', () => {
  it('iterates at concurrency 1 and collects a rollup (failures captured, not thrown)', async () => {
    let active = 0;
    let maxActive = 0;
    const results = await runSerial([1, 2, 3], async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active -= 1;
      if (item === 2) throw new Error('boom');
      return { ok: true, item };
    });

    expect(maxActive).toBe(1);
    expect(results[0]).toEqual({ ok: true, item: 1 });
    expect(results[1]).toMatchObject({ ok: false, error: 'boom', item: 2 });
    expect(results[2]).toEqual({ ok: true, item: 3 });
  });

  it('applies a per-item timeout so one wedged device does not stall the roll', async () => {
    const results = await runSerial([1, 2], (item) => {
      if (item === 1) return new Promise(() => {}); // never resolves
      return Promise.resolve({ ok: true, item });
    }, { timeoutMs: 20 });

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/timed out/);
    expect(results[1]).toEqual({ ok: true, item: 2 });
  });
});

describe('withTimeout', () => {
  it('rejects with TIMEOUT when the promise does not settle in time', async () => {
    await expect(withTimeout(new Promise(() => {}), 20)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('passes through a value that settles in time', async () => {
    await expect(withTimeout(Promise.resolve('v'), 50)).resolves.toBe('v');
  });
});
