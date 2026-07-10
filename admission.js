/**
 * Device admission helpers (Kanban #1671).
 *
 * Spec: docs/superpowers/specs/2026-06-10-device-admission-model-design.md
 *
 * A discovered device is a *proposal, not a member*. It is only admitted
 * (claimed → registered + given a screen) via one of three paths:
 *   1. Passive discovery (mDNS/SSDP) → pending → explicit approval.
 *   2. Explicit subnet scan (nmap / POST /scan) → auto-add.
 *   3. Roku app connects → auto-add (handled in slidecast).
 *
 * These are pure, dependency-free helpers so the admission decision can be
 * unit-tested without spinning up the extension runtime.
 */

// Methods that arrive as unsolicited announcements (the device advertises
// itself; the user did not ask us to look). These require approval by default.
export const PASSIVE_METHODS = ['mdns', 'ssdp'];

// Methods that originate from an explicit, user-initiated probe.
const SCAN_METHODS = ['nmap', 'arp', 'scan'];

/**
 * Decide whether a discovery candidate came from a passive announcement
 * (mDNS/SSDP) rather than an explicit scan or manual add.
 *
 * Discriminator priority:
 *   1. `via_scan === true` / `via_approval === true` / `admitted === true` — the
 *      authoritative admission markers. Candidates produced by POST /scan (and
 *      manual single-device adds) carry `via_scan`; a pending candidate that the
 *      user explicitly APPROVED is re-driven through admission carrying
 *      `via_approval`/`admitted`. All mean "the user's intent admits this device"
 *      and so are NOT passive — they auto-admit even when discovery_method says
 *      mdns/ssdp.
 *   2. `discovery_method` / `discoveryMethod` string — nmap/arp/scan are scan
 *      methods; mdns/ssdp are passive.
 *   3. Default: passive (the safe default — unknown provenance requires
 *      approval rather than silently auto-admitting).
 *
 * @param {object} candidate
 * @returns {boolean} true if the candidate is a passive announcement
 */
export function isPassiveCandidate(candidate = {}) {
  if (candidate.via_scan === true) return false;
  if (candidate.via_approval === true || candidate.admitted === true) return false;

  const method = String(candidate.discovery_method || candidate.discoveryMethod || '')
    .toLowerCase()
    .trim();

  if (SCAN_METHODS.includes(method)) return false;
  if (PASSIVE_METHODS.includes(method)) return true;

  // Unknown provenance with no scan marker → treat as passive (requires approval).
  return true;
}

/**
 * Decide whether a candidate should be auto-admitted (claimed immediately) or
 * held as pending for explicit approval.
 *
 * - Scan / manual candidates are always auto-admitted (running the scan / the
 *   manual add IS the intent).
 * - Passive candidates are auto-admitted only when approval is disabled
 *   (the `passive_discovery_requires_approval=false` escape hatch). The default
 *   is approval-required, so passive candidates are held as pending.
 *
 * @param {object} candidate
 * @param {{ passiveRequiresApproval?: boolean }} [opts]
 * @returns {boolean} true if the candidate should be auto-admitted now
 */
export function shouldAutoAdmit(candidate, opts = {}) {
  const passiveRequiresApproval = opts.passiveRequiresApproval !== false; // default true

  if (!isPassiveCandidate(candidate)) return true; // scan / manual → auto-add
  return !passiveRequiresApproval; // passive → only when approval is disabled
}
