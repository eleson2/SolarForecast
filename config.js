export default {
    location: {
        lat: 57.84964,
        lon: 11.76995,
        timezone: 'Europe/Stockholm'
    },
    panel: {
        peak_kw: 6.5,
        tilt: 38,        // degrees from horizontal
        azimuth: 190,    // 180 = south
        efficiency: 0.19 // starting estimate — learning will correct this
    },
    learning: {
        min_irradiance_weight: 400,    // W/m² — below this, observation gets low confidence
        empirical_blend_threshold: 30, // number of observations before fully trusting matrix
        recency_bias: {
            window_days: 14,   // rolling window of actuals used to compute the global bias scalar
            min_samples: 10,   // minimum total irradiance-weight before activating (else b=1)
            clamp_min: 0.5,    // floor: flag if model is off by more than 2× low
            clamp_max: 2.0,    // ceiling: flag if model is off by more than 2× high
        },
        // Cloud-cover suppression: at 100% cloud cover the forecast is reduced by this fraction.
        // The correction matrix captures typical conditions; this handles heavy overcast where
        // irradiance-based models still over-predict even after correction.
        // 0.65 → 35% of forecast at 100% cloud, 82.5% at 50% cloud, no effect at 0% cloud.
        cloud_suppression_max: 0.65,
        // Cloud cover % above which a sample is excluded from the correction matrix.
        // Samples taken on heavy-overcast days carry the cloud suppression factor in
        // prod_forecast, so including them would inflate the matrix and partially undo
        // the suppression on subsequent clear days.
        cloud_matrix_exclude_pct: 80,
    },
    forecast: {
        horizon_hours: 24,
        fetch_interval_hours: 6
    },
    battery: {
        capacity_kwh: 15.0,
        max_charge_w: 7500,
        max_discharge_w: 7500,
        efficiency: 0.90,
        min_soc: 10,
        max_soc: 95,
        // Fraction of forecasted solar surplus credited when computing grid charging headroom.
        // 1.0 = trust forecast fully (blocks grid charging if solar alone can fill battery).
        // 0.7 = apply 30% discount for forecast uncertainty, clouds, seasonal error.
        // Lower values charge more from grid as insurance; higher values rely more on solar.
        solar_forecast_confidence: 0.7,
        // Minimum kWh of grid charging headroom to preserve regardless of solar forecast.
        // Ensures the optimizer always plans some cheap-grid charging as insurance against
        // forecast errors. Set to 0 to disable the floor and rely solely on confidence.
        min_grid_charge_kwh: 4.0,
        // If actual SOC falls this many percentage points below the optimizer's plan,
        // executePipeline overrides the current slot to charge_grid to recover the deficit.
        soc_deviation_threshold: 10,
    },
    grid: {
        // Set sell_enabled: true to allow the optimizer to plan battery→grid export slots.
        // Revenue per kWh: spot_price × sell_price_factor − transfer_export_kwh.
        // Only profitable when spot prices are high enough to overcome the efficiency loss
        // and transfer fee. Requires the inverter to support export (check grid operator rules).
        sell_enabled: true,
        sell_price_factor: 0.80,
        // Maximum power the grid operator allows you to export (W).
        // Confirmed at 4.0 kW for this installation via Growatt app.
        max_export_w: 4000,
        transfer_import_kwh: 0.50,  // nätavgift import (SEK/kWh)
        transfer_export_kwh: 0.00,  // nätavgift export (SEK/kWh) — often 0
        energy_tax_kwh: 0.0,       // energiskatt (SEK/kWh) — only on import
    },
    consumption: {
        source: 'yesterday',
        heating_sensitivity: 0.03,
        climate: 'heating',
        flat_watts: 800,
        // Set to maximum expected house consumption WITHOUT EV charging (watts).
        // Any hourly reading above this is excluded from the temperature model,
        // preventing EV charging sessions from corrupting the regression slope.
        // Rule of thumb: peak heating load + all appliances, but not the EV charger.
        // Example: 5000 covers a well-heated Swedish home; set to 0 to disable.
        max_house_w: 5000,
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
        modbus_retries: 3,                        // retry attempts on Modbus error (1 = no retry)
        modbus_retry_delay_ms: 4000,              // delay between retries in ms
        dry_run: false,                           // true = log only, false = write registers
        data_collection_only: false,              // true = collect data only, never dispatch schedule to inverter

        // SOC buffer control — holding register 3310 (LoadFirstStopSocSet / reserved SOC for peak shaving)
        // Inverter stays in load-first mode; this register sets the discharge floor.
        charge_soc: 90,                           // SOC floor when charging (high = battery fills up)
        discharge_soc: 20,                        // SOC floor when discharging (low = battery empties)

        // --- Growatt cloud API settings (used when brand = 'growatt') ---
        // server: 'https://openapi.growatt.com/',
        // token: '',
        // device_sn: '',
    },
    peak_shaving: {
        // Grid import power cap written to inverter holding register 800 (PeakShavingPower).
        // Scale: 0.1 kW per unit (value 45 = 4.5 kW). Set enabled: true to activate.
        enabled: false,
        default_kw: 4.4,
        schedule: [
            // Time-of-day overrides (HH:MM, 24h, local time). First matching window wins.
            // { from: '00:00', to: '06:45', limit_kw: 10 },
            // { from: '21:05', to: '23:59', limit_kw: 10 },
        ],
    },
    dashboard: {
        // HTTP basic auth for remote access. Leave auth_pass empty to disable.
        // WARNING: HTTP only — do not expose to the internet without a TLS reverse proxy.
        auth_user: 'admin',
        auth_pass: '',      // set a password to enable
    },
    price: {
        source: 'elprisetjust',     // Must match a filename in src/prices/ (without .js extension)
        region: 'SE3',              // Provider-specific region code
        currency: 'SEK',            // Display currency
        day_ahead_hour: 13,         // Hour (UTC) when tomorrow's prices publish
    },
};
