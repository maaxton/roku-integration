import { describe, it, expect } from 'vitest';
import {
  compareVersion,
  deriveConnState,
  parseVersion,
} from 'roku-integration/fleet/playerState.js';

describe('compareVersion', () => {
  it('installed behind latest -> behind + updateAvailable', () => {
    const r = compareVersion('2.4.0', 'v2.7.1');
    expect(r.state).toBe('behind');
    expect(r.updateAvailable).toBe(true);
  });

  it('installed equal to latest (v-prefix normalized) -> up-to-date', () => {
    const r = compareVersion('2.7.1', 'v2.7.1');
    expect(r.state).toBe('up-to-date');
    expect(r.updateAvailable).toBe(false);
  });

  it('drift: installed AHEAD of published latest -> ahead, no update', () => {
    // On-device 2.7.x while public release lags at v2.4.0 must NOT flag update.
    const r = compareVersion('2.7.1', 'v2.4.0');
    expect(r.state).toBe('ahead');
    expect(r.updateAvailable).toBe(false);
  });

  it('minor/build precedence', () => {
    expect(compareVersion('2.7.0', 'v2.7.1').state).toBe('behind');
    expect(compareVersion('2.10.0', 'v2.9.0').state).toBe('ahead');
    expect(compareVersion('3.0.0', 'v2.99.99').state).toBe('ahead');
  });

  it('null / unparseable installed -> unknown, no update', () => {
    expect(compareVersion(null, 'v2.7.1')).toMatchObject({ state: 'unknown', updateAvailable: false });
    expect(compareVersion('', 'v2.7.1').state).toBe('unknown');
    expect(compareVersion('2.4.0', null).state).toBe('unknown');
  });

  it('parseVersion normalizes v-prefix and short forms', () => {
    expect(parseVersion('v2.7.1')).toEqual([2, 7, 1]);
    expect(parseVersion('2.7')).toEqual([2, 7, 0]);
    expect(parseVersion(null)).toBeNull();
  });
});

describe('deriveConnState', () => {
  it('paired -> paired', () => {
    expect(deriveConnState({ pairing: 'paired' })).toBe('paired');
  });
  it('revoked -> revoked', () => {
    expect(deriveConnState({ pairing: 'revoked' })).toBe('revoked');
  });
  it('unpaired + dev channel foregrounded -> stale-token (heuristic)', () => {
    expect(deriveConnState({ pairing: 'unpaired', devChannelActive: true })).toBe('stale-token');
  });
  it('unpaired + dev channel not active -> unpaired', () => {
    expect(deriveConnState({ pairing: 'unpaired', devChannelActive: false })).toBe('unpaired');
  });
  it('unknown / missing pairing -> unknown', () => {
    expect(deriveConnState({ pairing: 'unknown' })).toBe('unknown');
    expect(deriveConnState({})).toBe('unknown');
    expect(deriveConnState()).toBe('unknown');
  });
});
