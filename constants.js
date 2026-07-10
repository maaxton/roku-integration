/**
 * Roku ECP port. Kept dep-free (no imports) so index.js can pull it in at
 * MODULE SCOPE without transitively importing RokuClient.js (and therefore
 * the CommonJS xml2js dependency it wraps) — see index.js's lazy RokuClient
 * loader comment for why that matters.
 */
export const ROKU_ECP_PORT = 8060;
