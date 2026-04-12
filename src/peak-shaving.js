/**
 * Peak shaving limit resolver.
 *
 * Reads config.peak_shaving.date_ranges and returns the active import/export
 * power caps for a given slot timestamp. Used by both the LP optimizer (import
 * cap only) and the inverter dispatcher (both caps written to regs 3307/3308).
 *
 * Resolution order for a "YYYY-MM-DDTHH:MM" slot:
 *   1. Find the first date_ranges entry whose [from, to] (MM-DD) contains today.
 *      Ranges where from > to wrap across the year boundary (e.g. Oct–Mar).
 *      An entry with default: true matches unconditionally (catch-all).
 *   2. Within the matched range, find the first schedule window covering HH:MM.
 *   3. Fall back to the range's default_import_kw / default_export_kw.
 */

/**
 * @param {object} psConfig  — config.peak_shaving
 * @param {string} slotTs    — "YYYY-MM-DDTHH:MM" in configured timezone
 * @returns {{ import_kw: number, export_kw: number } | null}
 *   null if peak shaving is disabled or date_ranges is missing.
 */
export function resolvePeakShavingLimits(psConfig, slotTs) {
  if (!psConfig?.enabled || !psConfig.date_ranges) return null;

  const mmdd = slotTs.slice(5, 10);  // "MM-DD"
  const hhmm = slotTs.slice(11, 16); // "HH:MM"

  let range = null;
  for (const r of psConfig.date_ranges) {
    if (r.default) { range = r; break; }
    // Year-wrap: from > to means the range crosses Dec/Jan (e.g. "10-01" → "03-31")
    const wraps = r.from > r.to;
    const inRange = wraps ? (mmdd >= r.from || mmdd <= r.to) : (mmdd >= r.from && mmdd <= r.to);
    if (inRange) { range = r; break; }
  }
  if (!range) return null;

  for (const entry of (range.schedule || [])) {
    if (hhmm >= entry.from && hhmm <= entry.to) {
      return { import_kw: entry.import_kw, export_kw: entry.export_kw };
    }
  }
  return { import_kw: range.default_import_kw, export_kw: range.default_export_kw };
}
