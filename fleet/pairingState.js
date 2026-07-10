/**
 * pairingState - PURE reducer over slidecast_device_tokens rows.
 *
 * The box table is read best-effort and defensively (roku-integration does NOT
 * require slidecast; the table may be absent). This module never touches the
 * DB; the caller passes in the already-fetched rows (or null when the table is
 * missing) and this reduces them per serial.
 *
 * A serial can have MULTIPLE rows: completePairing always inserts a new row,
 * autoPairDevice reuses the first — so we dedupe by "is there ANY active
 * (revoked-falsy) row?", matching slidecast's own liveness test
 * (validateToken queries where {token_hash, revoked:0}).
 *
 * States:
 *   'paired'   - >= 1 row with revoked falsy
 *   'revoked'  - rows exist but ALL are revoked
 *   'unpaired' - zero rows for the serial
 *   'unknown'  - rows === null (table missing / read failed)
 */

/** SQLite stores booleans as 0/1; be liberal about truthy encodings. */
function isRevoked(row) {
  const v = row && row.revoked;
  return v === 1 || v === true || v === '1';
}

/**
 * Reduce the token rows for a single serial to a pairing state.
 * @param {Array<object>|null|undefined} rows rows for ONE serial, or null when
 *   the token table is unavailable.
 */
export function reducePairingForSerial(rows) {
  if (rows == null || !Array.isArray(rows)) return 'unknown';
  if (rows.length === 0) return 'unpaired';
  if (rows.some((r) => !isRevoked(r))) return 'paired';
  return 'revoked';
}

/**
 * Group all token rows by serial. Accepts the raw getDeviceTokens() shape
 * (device_serial) or a normalized {serial} shape.
 * @returns {Map<string, Array<object>>}
 */
export function buildPairingMap(allRows) {
  const bySerial = new Map();
  if (!Array.isArray(allRows)) return bySerial;
  for (const row of allRows) {
    const serial = row.device_serial != null ? row.device_serial : row.serial;
    if (serial == null) continue;
    if (!bySerial.has(serial)) bySerial.set(serial, []);
    bySerial.get(serial).push(row);
  }
  return bySerial;
}

/**
 * Convenience: pairing state for `serial` given all rows (or null when the
 * table is missing → 'unknown' for every serial).
 */
export function pairingStateForSerial(allRows, serial) {
  if (allRows == null) return 'unknown';
  const map = buildPairingMap(allRows);
  return reducePairingForSerial(map.get(serial) || []);
}

/**
 * Like pairingStateForSerial, but matches a device's tokens against a SET of
 * identities — its hardware serial AND any linked identifier (e.g. the Roku's
 * ChannelClientId). Slidecast keys an auto-discovered screen's token by the
 * ChannelClientId (bridged via slidecast_screens.metadata.channel_client_id),
 * NOT the hardware serial — so a validly-paired, playing device is invisible to
 * a hardware-serial-only lookup and wrongly reads 'unpaired'. Feed it the device's
 * serial plus any channel_client_id linked to it via its slidecast screen.
 */
export function pairingStateForIdentities(allRows, identities) {
  if (allRows == null) return 'unknown';
  const ids = new Set(
    (Array.isArray(identities) ? identities : [identities]).filter((x) => x != null && x !== ''),
  );
  if (ids.size === 0) return 'unpaired';
  const map = buildPairingMap(allRows);
  const rows = [];
  for (const id of ids) {
    const forId = map.get(id);
    if (forId) rows.push(...forId);
  }
  return reducePairingForSerial(rows);
}

/**
 * Build a lookup of screen-linked identifiers from slidecast_screens rows.
 *
 * Slidecast auto-creates a screen with `serial` set to the discovery DEVICE ID
 * ('roku:<hw serial>'), NOT the bare hardware serial the fleet keys on — so a
 * map keyed only by screen.serial misses every fleet lookup. Key the map by
 * EVERY identity the screen row carries (serial, metadata.serial_number,
 * metadata.roku_device_id); each key maps to the linked ids (channel_client_id)
 * whose tokens should count as this device's. metadata may arrive as a JSON
 * string or an already-parsed object; malformed metadata yields no links.
 *
 * @param {Array<object>|null|undefined} screenRows raw slidecast_screens rows
 * @returns {Map<string, string[]>}
 */
export function buildScreenLinkMap(screenRows) {
  const map = new Map();
  if (!Array.isArray(screenRows)) return map;
  for (const s of screenRows) {
    if (s == null) continue;
    let meta = s.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch { meta = null; }
    }
    if (meta == null || typeof meta !== 'object') meta = {};
    const links = [];
    if (meta.channel_client_id != null && meta.channel_client_id !== '') {
      links.push(meta.channel_client_id);
    }
    const keys = [s.serial, meta.serial_number, meta.roku_device_id];
    for (const key of keys) {
      if (key == null || key === '') continue;
      const existing = map.get(key);
      if (existing) {
        for (const id of links) { if (!existing.includes(id)) existing.push(id); }
      } else {
        map.set(key, [...links]);
      }
    }
  }
  return map;
}

/**
 * The full identity set to match a device's tokens against: the device's own
 * identifiers (hardware serial + device_id) plus any screen-linked ids found
 * under either key in the screen-link map. Deduped, empties dropped. Tolerates
 * a null/absent map (slidecast unavailable) — the device identifiers alone are
 * the honest fallback (no worse than the pre-bridge serial-only lookup).
 *
 * @param {Map<string, string[]>|null|undefined} screenLinkMap
 * @param {{serialNumber?: string, deviceId?: string}} device
 * @returns {string[]}
 */
export function identitiesForDevice(screenLinkMap, { serialNumber, deviceId } = {}) {
  const ids = new Set();
  for (const own of [serialNumber, deviceId]) {
    if (own == null || own === '') continue;
    ids.add(own);
    const links = (screenLinkMap && typeof screenLinkMap.get === 'function')
      ? screenLinkMap.get(own) : null;
    if (Array.isArray(links)) {
      for (const id of links) { if (id != null && id !== '') ids.add(id); }
    }
  }
  return [...ids];
}

export default {
  reducePairingForSerial,
  buildPairingMap,
  pairingStateForSerial,
  pairingStateForIdentities,
  buildScreenLinkMap,
  identitiesForDevice,
};
