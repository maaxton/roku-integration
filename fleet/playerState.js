/**
 * playerState - PURE helpers for player version + connection-state derivation.
 *
 * compareVersion handles the release-repo drift: the on-device build can be
 * AHEAD of the published latest tag (e.g. installed 2.7.1 vs public v2.4.0),
 * which must read as up-to-date (no false "update available"), while a genuine
 * behind case (2.4.0 vs v2.7.1) flags updateAvailable.
 *
 * deriveConnState folds the pairingState reducer output together with the ECP
 * "is the dev channel foregrounded?" signal into the UI's connection badge.
 * The stale-token state is a HEURISTIC (no active token + dev channel running),
 * not proof — true disambiguation needs the Roku to send its held token, which
 * only the shipped self-heal build produces.
 */

/** Parse a version/tag ("v2.7.1", "2.4.0", "2.7") into [major,minor,build]. */
export function parseVersion(v) {
  if (v == null) return null;
  const cleaned = String(v).trim().replace(/^v/i, '');
  const m = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

/** Compare two [major,minor,build] tuples: -1 / 0 / 1. */
export function compareParts(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

/**
 * Compare an installed version against the latest published tag.
 * @returns {{installed, latest, state:'behind'|'up-to-date'|'ahead'|'unknown', updateAvailable:boolean}}
 */
export function compareVersion(installed, latestTag) {
  const a = parseVersion(installed);
  const b = parseVersion(latestTag);
  if (!a || !b) {
    return {
      installed: installed == null ? null : installed,
      latest: latestTag == null ? null : latestTag,
      state: 'unknown',
      updateAvailable: false,
    };
  }
  const cmp = compareParts(a, b);
  let state;
  if (cmp < 0) state = 'behind';
  else if (cmp > 0) state = 'ahead';
  else state = 'up-to-date';
  return {
    installed, latest: latestTag, state, updateAvailable: cmp < 0,
  };
}

/**
 * Derive the UI connection/pairing badge state.
 * @param {object} p
 * @param {'paired'|'revoked'|'unpaired'|'unknown'} p.pairing pairingState output
 * @param {boolean} [p.devChannelActive] ECP active-app is the dev channel
 * @returns {'paired'|'revoked'|'unpaired'|'stale-token'|'unknown'}
 */
export function deriveConnState({ pairing, devChannelActive } = {}) {
  switch (pairing) {
    case 'paired':
      return 'paired';
    case 'revoked':
      return 'revoked';
    case 'unpaired':
      // No active box-side token but the dev channel is foregrounded → the
      // player is likely clinging to a token the box no longer honors.
      return devChannelActive ? 'stale-token' : 'unpaired';
    default:
      return 'unknown';
  }
}

export default {
  parseVersion, compareParts, compareVersion, deriveConnState,
};
