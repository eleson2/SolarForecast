/**
 * In-memory manual override state.
 *
 * When an override is active, executePipeline applies the override action
 * to the inverter on every cycle instead of the computed schedule.
 * The override expires automatically after the requested duration.
 *
 * This module is intentionally stateless across process restarts — a reboot
 * always returns to schedule-based control.
 *
 * Sources:
 *   'manual'       — set via POST /battery/override (API / operator)
 *   'ev_detection' — set automatically when EV charging is detected
 *
 * Priority: a 'manual' override is never overwritten by 'ev_detection'.
 */

let _override = null; // { action: string, expiresAt: number, source: string }

/**
 * Activate an override.
 * @param {'charge'|'discharge'|'idle'} action
 * @param {number} durationMinutes — 1 to 1440
 * @param {'manual'|'ev_detection'} [source]
 */
export function setOverride(action, durationMinutes, source = 'manual') {
  // A manual override takes precedence — don't let automation overwrite it.
  if (_override && _override.source === 'manual' && source !== 'manual') return;
  _override = {
    action,
    expiresAt: Date.now() + durationMinutes * 60 * 1000,
    source,
  };
}

/** Cancel the active override immediately (regardless of source). */
export function clearOverride() {
  _override = null;
}

/**
 * Cancel the active override only if it matches the given source.
 * Used by automated logic to clean up its own overrides without touching manual ones.
 * @param {'manual'|'ev_detection'} source
 */
export function clearOverrideBySource(source) {
  if (_override?.source === source) _override = null;
}

/**
 * Return the current override state, or null if none is active.
 * Automatically clears expired overrides.
 * @returns {{ action: string, source: string, expires_at: string, remaining_minutes: number } | null}
 */
export function getOverride() {
  if (!_override) return null;
  if (Date.now() >= _override.expiresAt) {
    _override = null;
    return null;
  }
  return {
    action: _override.action,
    source: _override.source,
    expires_at: new Date(_override.expiresAt).toISOString(),
    remaining_minutes: Math.ceil((_override.expiresAt - Date.now()) / 60000),
  };
}
