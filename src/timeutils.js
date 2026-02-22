/**
 * Parse a DB timestamp string ("YYYY-MM-DDTHH:MM") into its components.
 * No Date object — avoids all timezone conversion issues.
 */
export function parseTs(ts) {
  const year  = parseInt(ts.slice(0, 4), 10);
  const month = parseInt(ts.slice(5, 7), 10);   // 1–12
  const day   = parseInt(ts.slice(8, 10), 10);   // 1–31
  const hour  = parseInt(ts.slice(11, 13), 10);  // 0–23
  return { year, month, day, hour };
}

/**
 * Convert month (1–12) + day (1–31) to day-of-year (1–365).
 * Non-leap year only — acceptable for correction matrix indexing.
 */
export function dayOfYear(month, day) {
  const cumDays = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return cumDays[month] + day;
}

/**
 * Shortest distance in days between two calendar dates, wrapping at year boundary.
 * Returns 0–182.
 */
export function calendarDayDistance(m1, d1, m2, d2) {
  const a = dayOfYear(m1, d1);
  const b = dayOfYear(m2, d2);
  const diff = Math.abs(a - b);
  return Math.min(diff, 365 - diff);
}
