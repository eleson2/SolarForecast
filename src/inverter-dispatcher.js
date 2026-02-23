/**
 * Inverter driver dispatcher.
 *
 * Returns the correct driver module based on config.inverter.brand,
 * or null when no inverter is configured.
 */

import config from '../config.js';
import * as growatt from './inverters/growatt.js';
import * as growattModbus from './inverters/growatt-modbus.js';

const drivers = { growatt, 'growatt-modbus': growattModbus };

/**
 * @returns {{ getState: Function, applySchedule: Function, resetToDefault: Function } | null}
 */
export function getDriver() {
  const brand = config.inverter?.brand;
  if (!brand) return null;

  const driver = drivers[brand];
  if (!driver) {
    console.warn(`[inverter-dispatcher] Unknown inverter brand: "${brand}". Available: ${Object.keys(drivers).join(', ')}`);
    return null;
  }
  return driver;
}

/**
 * @returns {object | null} — the inverter config section, or null
 */
export function getDriverConfig() {
  return config.inverter ?? null;
}
