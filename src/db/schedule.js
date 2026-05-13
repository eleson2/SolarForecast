import db from './db-instance.js';

const stmts = {
  upsertPrice: db.prepare(`
    INSERT INTO price_readings (slot_ts, spot_price, region)
    VALUES (?, ?, ?)
    ON CONFLICT(slot_ts) DO UPDATE SET
      spot_price = excluded.spot_price,
      region = excluded.region
  `),
  getPricesForRange: db.prepare(`
    SELECT * FROM price_readings
    WHERE slot_ts >= ? AND slot_ts <= ?
    ORDER BY slot_ts ASC
  `),
  getScheduleForRange: db.prepare(`
    SELECT * FROM battery_schedule
    WHERE slot_ts >= ? AND slot_ts <= ?
    ORDER BY slot_ts ASC
  `),
  deleteScheduleForRange: db.prepare(`
    DELETE FROM battery_schedule
    WHERE slot_ts >= ? AND slot_ts <= ?
  `),
  upsertSchedule: db.prepare(`
    INSERT INTO battery_schedule (slot_ts, action, watts, soc_start, soc_end, price_kwh, solar_watts, consumption_watts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot_ts) DO UPDATE SET
      action = excluded.action,
      watts = excluded.watts,
      soc_start = excluded.soc_start,
      soc_end = excluded.soc_end,
      price_kwh = excluded.price_kwh,
      solar_watts = excluded.solar_watts,
      consumption_watts = excluded.consumption_watts
  `),
  recordPipelineRun: db.prepare(`
    INSERT INTO pipeline_runs (pipeline, last_run_ts, last_status)
    VALUES (?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(pipeline) DO UPDATE SET
      last_run_ts = excluded.last_run_ts,
      last_status = excluded.last_status
  `),
  getAllPipelineRuns: db.prepare('SELECT * FROM pipeline_runs')
};

export function upsertPrice(slotTs, spotPrice, region) {
  return stmts.upsertPrice.run(slotTs, spotPrice, region);
}

export function upsertPricesBatch(prices) {
  const runBatch = db.transaction((rows) => {
    for (const row of rows) {
      stmts.upsertPrice.run(row.slot_ts, row.spot_price, row.region);
    }
  });
  runBatch(prices);
}

export function getPricesForRange(fromTs, toTs) {
  return stmts.getPricesForRange.all(fromTs, toTs);
}

export function upsertScheduleBatch(slots) {
  const runBatch = db.transaction((rows) => {
    for (const row of rows) {
      stmts.upsertSchedule.run(
        row.slot_ts, row.action, row.watts, row.soc_start, row.soc_end,
        row.price_kwh, row.solar_watts, row.consumption_watts
      );
    }
  });
  runBatch(slots);
}

export function getScheduleForRange(fromTs, toTs) {
  return stmts.getScheduleForRange.all(fromTs, toTs);
}

export function deleteScheduleForRange(fromTs, toTs) {
  return stmts.deleteScheduleForRange.run(fromTs, toTs);
}

export function recordPipelineRun(pipeline, status = 'ok') {
  return stmts.recordPipelineRun.run(pipeline, status);
}

export function getAllPipelineRuns() {
  return stmts.getAllPipelineRuns.all();
}
