/**
 * Minimal valid config object for use in validator / unit tests.
 * Use structuredClone() before mutating to keep tests isolated.
 */
export const validConfig = {
  location: {
    lat: 57.849,
    lon: 11.769,
    timezone: 'Europe/Stockholm',
  },
  panel: {
    peak_kw: 6.5,
    tilt: 38,
    azimuth: 190,
    efficiency: 0.19,
  },
  battery: {
    capacity_kwh: 15.0,
    max_charge_w: 7500,
    max_discharge_w: 7500,
    efficiency: 0.90,
    min_soc: 10,
    max_soc: 95,
  },
  price: {
    sources: ['elprisetjust'],
    region: 'SE3',
    currency: 'SEK',
  },
  // peak_shaving omitted — tests that need it add it themselves
};

/** Minimal valid peak_shaving block (new date_ranges schema). */
export const validPeakShaving = {
  enabled: true,
  date_ranges: [
    {
      from: '10-01', to: '03-31',
      default_import_kw: 4.1,
      default_export_kw: 4.0,
      schedule: [
        { from: '00:00', to: '06:45', import_kw: 12, export_kw: 11 },
      ],
    },
    {
      from: '04-01', to: '09-30',
      default_import_kw: 3.5,
      default_export_kw: 3.4,
      schedule: [],
    },
    {
      default: true,
      default_import_kw: 13,
      default_export_kw: 12,
      schedule: [],
    },
  ],
};
