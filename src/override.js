/**
 * In-memory manual override state.
 *
 * When an override is active, executePipeline applies the override action
 * to the inverter on every cycle instead of the computed schedule.
 * The override expires automatically after the requested duration.
 *
 * This module is intentionally stateless across process restarts — a reboot
 * always returns to schedule-based control.
 */

let _override = null; // { action: string, expiresAt: number }

/**
 * Activate an override.
 * @param {'charge'|'discharge'|'idle'} action
 * @param {number} durationMinutes — 1 to 1440
 */
export function setOverride(action, durationMinutes) {
  _override = {
    action,
    expiresAt: Date.now() + durationMinutes * 60 * 1000,
  };
}

/** Cancel the active override immediately. */
export function clearOverride() {
  _override = null;
}

/**
 * Return the current override state, or null if none is active.
 * Automatically clears expired overrides.
 * @returns {{ action: string, expires_at: string, remaining_minutes: number } | null}
 */
export function getOverride() {
  if (!_override) return null;
  if (Date.now() >= _override.expiresAt) {
    _override = null;
    return null;
  }
  return {
    action: _override.action,
    expires_at: new Date(_override.expiresAt).toISOString(),
    remaining_minutes: Math.ceil((_override.expiresAt - Date.now()) / 60000),
  };
}
