export default {
    location: {
        lat: 57.84964,
        lon: 11.76995,
        timezone: 'Europe/Stockholm'
    },
    panel: {
        peak_kw: 6.6,
        tilt: 38,        // degrees from horizontal
        azimuth: 190,    // 180 = south
        efficiency: 0.19 // starting estimate — learning will correct this
    },
    learning: {
        min_irradiance_weight: 400,    // W/m² — below this, observation gets low confidence
        empirical_blend_threshold: 30  // number of observations before fully trusting matrix
    },
    forecast: {
        horizon_hours: 24,
        fetch_interval_hours: 6
    },
    battery: {
        capacity_kwh: 10.0,
        max_charge_w: 5000,
        max_discharge_w: 5000,
        efficiency: 0.90,
        min_soc: 10,
        max_soc: 95,
    },
    grid: {
        sell_enabled: false,
        sell_price_factor: 0.80,
        transfer_import_kwh: 0.05,  // nätavgift import (SEK/kWh)
        transfer_export_kwh: 0.00,  // nätavgift export (SEK/kWh) — often 0
        energy_tax_kwh: 0.36,       // energiskatt (SEK/kWh) — only on import
    },
    consumption: {
        source: 'yesterday',
        heating_sensitivity: 0.03,
        climate: 'heating',
        flat_watts: 800,
    },
    inverter: {
        // Driver: 'growatt' = cloud API (MIN/MIX), 'growatt-modbus' = local Modbus TCP (MOD TL3-XH)
        brand: 'growatt-modbus',

        // --- Growatt MOD TL3-XH Modbus TCP settings ---
        model: 'MOD TL3-XH',                     // informational — inverter model
        host: '192.168.1.180',                    // datalogger IP on local network
        port: 502,                                // Modbus TCP port (standard)
        unit_id: 1,                               // Modbus slave address (holding reg 30)
        timeout_ms: 5000,                         // Modbus response timeout
        dry_run: true,                            // true = log only, false = write registers
        data_collection_only: true,               // true = collect data only, never dispatch schedule to inverter

        // SOC buffer control — holding register 3310 (LoadFirstStopSocSet / reserved SOC for peak shaving)
        // Inverter stays in load-first mode; this register sets the discharge floor.
        charge_soc: 95,                           // SOC floor when charging (high = battery fills up)
        discharge_soc: 13,                        // SOC floor when discharging (low = battery empties)
        //                                        // 13% is the MOD TL3-XH minimum allowed value

        // --- Growatt cloud API settings (used when brand = 'growatt') ---
        // server: 'https://openapi.growatt.com/',
        // token: '',
        // device_sn: '',
    },
    price: {
        source: 'elprisetjust',     // 'elprisetjust' (Nordics) or 'awattar' (DE/AT)
        region: 'SE3',              // Provider-specific region code
        currency: 'SEK',            // Display currency
        day_ahead_hour: 13,         // Hour (UTC) when tomorrow's prices publish
    },
};
