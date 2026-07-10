/**
 * Roku re-probe heuristics (originally Kanban #1673; relocated off the
 * shared device-discovery extension by audit DD3, 2026-07-04).
 *
 * Some Roku TVs announce themselves only via AirPlay (or other non-ECP) mDNS
 * and therefore land in `discovery_candidates` typed "AirPlay Device" without
 * ever being ECP-confirmed at the candidate level. As a result the pending UI
 * has no serial/model and — critically — no user-set friendly name, so the
 * card falls back to "Roku <model>" or a bare IP.
 *
 * This module implements THIS integration's `devices.roku.discover.shouldReprobe`
 * hook (the generic contract in DeviceTypeHost/DeviceManager). The platform's
 * GET /candidates surface calls it for every pending candidate to decide
 * whether to fire a best-effort `discovery:candidate-matched` back at this
 * extension. If it answers, roku-integration's discover.probe does a live ECP
 * probe on port 8060 (RokuClient) and, if it responds, the platform emits
 * `discovery:candidate-confirmed` carrying the user-device-name as the
 * friendly name — converting the card title to the real name.
 *
 * Pure + dependency-free so they unit-test without a DB or event bus.
 */

export const ROKU_ECP_PORT = 8060;

/** Normalize a candidate's open-port list across the shapes the API uses. */
function openPortsOf(candidate) {
  const ports = candidate.open_ports
    || candidate.openPorts
    || (candidate.raw_data && candidate.raw_data.openPorts)
    || [];
  return Array.isArray(ports) ? ports.map(Number) : [];
}

/**
 * A candidate is a *likely Roku* if it exposes the ECP port (8060) OR it
 * arrived via an announcement that Rokus emit (AirPlay / Roku mDNS). The
 * AirPlay signal is what catches the nameless TVs: the actual 8060 reachability
 * is re-checked live by this extension's discover.probe, so a false positive
 * here just yields a harmless no-op probe.
 */
export function isLikelyRoku(candidate, opts = {}) {
  if (!candidate) return false;
  const port = Number(opts.rokuPort || ROKU_ECP_PORT);

  if (openPortsOf(candidate).includes(port)) return true;

  const dt = String(candidate.device_type || candidate.deviceType || '').toLowerCase();
  if (dt.includes('roku') || dt.includes('airplay')) return true;

  const services = candidate.services || [];
  if (Array.isArray(services) && services.some((s) => String(s).toLowerCase().includes('airplay'))) {
    return true;
  }

  return false;
}

/**
 * A candidate is already ECP-confirmed once this extension has written a
 * serial into raw_data.confirmed. Confirmed candidates must NOT be re-probed.
 */
export function isConfirmedRoku(candidate) {
  if (!candidate) return false;
  const confirmed = (candidate.raw_data && candidate.raw_data.confirmed) || {};
  return !!(confirmed.serial_number || confirmed.serial || confirmed.serialNumber);
}

/**
 * The `devices.roku.discover.shouldReprobe` implementation: should the
 * platform's GET /candidates surface fire a re-probe for this pending
 * candidate? Only when it looks like a Roku AND has not yet been confirmed.
 */
export function shouldReprobeRoku(candidate, opts = {}) {
  return isLikelyRoku(candidate, opts) && !isConfirmedRoku(candidate);
}
