import { describe, it, expect } from 'vitest';
import {
  reducePairingForSerial,
  buildPairingMap,
  pairingStateForSerial,
  pairingStateForIdentities,
  buildScreenLinkMap,
  identitiesForDevice,
} from 'roku-integration/fleet/pairingState.js';

describe('reducePairingForSerial', () => {
  it('one active (revoked:0) row -> paired', () => {
    expect(reducePairingForSerial([{ revoked: 0 }])).toBe('paired');
  });

  it('mixed rows with any active -> paired (dedupe by "any active")', () => {
    expect(reducePairingForSerial([{ revoked: 1 }, { revoked: 0 }])).toBe('paired');
  });

  it('all rows revoked -> revoked', () => {
    expect(reducePairingForSerial([{ revoked: 1 }, { revoked: true }])).toBe('revoked');
  });

  it('no rows -> unpaired', () => {
    expect(reducePairingForSerial([])).toBe('unpaired');
  });

  it('null (table missing / read failed) -> unknown', () => {
    expect(reducePairingForSerial(null)).toBe('unknown');
    expect(reducePairingForSerial(undefined)).toBe('unknown');
  });

  it('treats string/boolean revoked encodings as truthy', () => {
    expect(reducePairingForSerial([{ revoked: '1' }])).toBe('revoked');
    expect(reducePairingForSerial([{ revoked: true }])).toBe('revoked');
    expect(reducePairingForSerial([{ revoked: '0' }])).toBe('paired');
    expect(reducePairingForSerial([{ revoked: false }])).toBe('paired');
  });
});

describe('buildPairingMap + pairingStateForSerial', () => {
  const rows = [
    { device_serial: 'AAA', revoked: 0 },
    { device_serial: 'AAA', revoked: 1 },
    { device_serial: 'BBB', revoked: 1 },
  ];

  it('groups raw getDeviceTokens() rows by device_serial', () => {
    const map = buildPairingMap(rows);
    expect(map.get('AAA')).toHaveLength(2);
    expect(map.get('BBB')).toHaveLength(1);
  });

  it('resolves per-serial state from all rows', () => {
    expect(pairingStateForSerial(rows, 'AAA')).toBe('paired');
    expect(pairingStateForSerial(rows, 'BBB')).toBe('revoked');
    expect(pairingStateForSerial(rows, 'CCC')).toBe('unpaired');
  });

  it('null all-rows (table missing) -> unknown for any serial', () => {
    expect(pairingStateForSerial(null, 'AAA')).toBe('unknown');
  });
});

describe('pairingStateForIdentities (ChannelClientId bridge)', () => {
  // Slidecast keys an auto-discovered screen's token by the Roku's ChannelClientId,
  // not the hardware serial — the regression that made a paired, playing screen
  // read 'unpaired' in the fleet because it only looked up by hardware serial.
  const rows = [
    { device_serial: 'ccid-hanger-xyz', revoked: 0 }, // token keyed by ChannelClientId
    { device_serial: 'MANUAL01', revoked: 0 }, // token keyed by hardware serial
    { device_serial: 'GONE', revoked: 1 },
  ];

  it('a serial-only lookup MISSES a token keyed by ChannelClientId (the bug)', () => {
    expect(pairingStateForSerial(rows, 'X029009JC6LF')).toBe('unpaired');
  });

  it('matches via the linked ChannelClientId -> paired (the fix)', () => {
    expect(pairingStateForIdentities(rows, ['X029009JC6LF', 'ccid-hanger-xyz'])).toBe('paired');
  });

  it('still matches when the token IS keyed by the hardware serial', () => {
    expect(pairingStateForIdentities(rows, ['MANUAL01'])).toBe('paired');
  });

  it('no identity matches -> unpaired', () => {
    expect(pairingStateForIdentities(rows, ['NOPE', 'also-nope'])).toBe('unpaired');
  });

  it('all matching rows revoked -> revoked', () => {
    expect(pairingStateForIdentities(rows, ['GONE'])).toBe('revoked');
  });

  it('accepts a single identity (not only an array)', () => {
    expect(pairingStateForIdentities(rows, 'ccid-hanger-xyz')).toBe('paired');
  });

  it('empty / all-null identities -> unpaired', () => {
    expect(pairingStateForIdentities(rows, [])).toBe('unpaired');
    expect(pairingStateForIdentities(rows, [null, undefined, ''])).toBe('unpaired');
  });

  it('null all-rows (slidecast absent) -> unknown', () => {
    expect(pairingStateForIdentities(null, ['X029009JC6LF', 'ccid-hanger-xyz'])).toBe('unknown');
  });
});

describe('screen-link bridge (buildScreenLinkMap + identitiesForDevice)', () => {
  // EXACT shapes read off the dev-lab box (2026-07-07). Slidecast auto-creates a
  // screen with serial = the discovery DEVICE ID ('roku:<hw serial>'), NOT the
  // bare hardware serial the fleet keys on — so a bridge map keyed only by
  // screen.serial misses every lookup and a validly-paired, PLAYING device
  // still reads 'stale-token' (the 2.1.3 residual bug).
  const boxScreens = [{
    serial: 'roku:X029009JC6LF',
    metadata: JSON.stringify({
      roku_device_id: 'roku:X029009JC6LF',
      ip_address: '192.168.50.51',
      serial_number: 'X029009JC6LF',
      channel_client_id: 'a40963c8-5694-528b-80ce-035ee589efd7',
    }),
  }];
  const boxTokens = [
    { device_serial: 'a40963c8-5694-528b-80ce-035ee589efd7', revoked: 0 },
  ];
  const device = { serialNumber: 'X029009JC6LF', deviceId: 'roku:X029009JC6LF' };

  it('END-TO-END regression: exact box data -> paired', () => {
    const map = buildScreenLinkMap(boxScreens);
    const ids = identitiesForDevice(map, device);
    expect(pairingStateForIdentities(boxTokens, ids)).toBe('paired');
  });

  it('keys the map by EVERY screen identity: serial, metadata.serial_number, metadata.roku_device_id', () => {
    const map = buildScreenLinkMap(boxScreens);
    const ccid = ['a40963c8-5694-528b-80ce-035ee589efd7'];
    expect(map.get('roku:X029009JC6LF')).toEqual(ccid);
    expect(map.get('X029009JC6LF')).toEqual(ccid);
  });

  it('accepts already-parsed metadata objects (not only JSON strings)', () => {
    const map = buildScreenLinkMap([{
      serial: 's1',
      metadata: { serial_number: 'HW1', channel_client_id: 'ccid-1' },
    }]);
    expect(map.get('HW1')).toEqual(['ccid-1']);
    expect(map.get('s1')).toEqual(['ccid-1']);
  });

  it('malformed metadata JSON -> screen keyed by serial only, no links, no throw', () => {
    const map = buildScreenLinkMap([{ serial: 's1', metadata: '{oops' }]);
    expect(map.get('s1')).toEqual([]);
  });

  it('null/absent screen rows -> empty map', () => {
    expect(buildScreenLinkMap(null).size).toBe(0);
    expect(buildScreenLinkMap(undefined).size).toBe(0);
    expect(buildScreenLinkMap('bogus').size).toBe(0);
  });

  it('identitiesForDevice always includes the device identifiers themselves', () => {
    const ids = identitiesForDevice(new Map(), device);
    expect(ids).toContain('X029009JC6LF');
    expect(ids).toContain('roku:X029009JC6LF');
  });

  it('identitiesForDevice tolerates a null/absent map (slidecast unavailable)', () => {
    const ids = identitiesForDevice(null, device);
    expect(ids).toContain('X029009JC6LF');
    expect(pairingStateForIdentities(boxTokens, ids)).toBe('unpaired'); // honest fallback
  });

  it('identitiesForDevice dedupes and drops empties', () => {
    const map = buildScreenLinkMap(boxScreens);
    const ids = identitiesForDevice(map, {
      serialNumber: 'X029009JC6LF',
      deviceId: 'roku:X029009JC6LF',
    });
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(null);
    expect(ids).not.toContain('');
  });
});
