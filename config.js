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
        // Fog suppression: at 100% fog the forecast is reduced by this fraction (on top of cloud suppression).
        // Fog fully blocks direct beam; a strong default of 0.9 reflects near-zero output in dense fog.
        fog_suppression_max: 0.90,
        // Cloud cover % above which a sample is excluded from the correction matrix.
        // Samples taken on heavy-overcast days carry the cloud suppression factor in
        // prod_forecast, so including them would inflate the matrix and partially undo
        // the suppression on subsequent clear days.
        cloud_matrix_exclude_pct: 80,
        // Intra-day solar scalar cap: maximum factor by which today's actuals can scale
        // the remaining solar forecast during the battery re-optimization.
        // 2.0 = safe default; raise to 3.0+ on sites with frequent dramatic cloud clearing
        // where Open-Meteo under-predicts. The scalar applies to all remaining hours, so
        // setting it too high risks over-valuing solar on days where clearing was temporary.
        intraday_scalar_max: 3.0,
        // Cloud-irradiance cap: when cloud cover is high but irradiance forecast is also
        // high (conflicting signals that cause severe over-forecasting), cap prod_forecast
        // at a fraction of the raw physics baseline (peak_kw × poa/1000).
        // Only fires when BOTH thresholds are exceeded simultaneously.
        // cap_factor 0.45 = at most 45% of clear-sky physics output under heavy cloud.
        cloud_irradiance_cap: {
            enabled: true,
            cloud_pct_threshold: 30,   // apply when cloud_cover >= this %
            cloud_pct_max: 65,         // do NOT apply when cloud_cover > this % (heavy overcast already handled by cloudFactor)
            irr_wm2_threshold: 400,    // apply when irr_forecast >= this W/m²
            cap_factor: 0.80,          // max fraction of physics baseline allowed (was 0.45 — raised to avoid harming high-diffuse overcast days)
        },
        // If today's actual/forecast ratio exceeds this, trigger a fresh Open-Meteo
        // fetch before re-optimizing. Captures mid-day NWP updates on days where the
        // morning forecast was badly wrong (e.g., cloud clearing not in the model).
        intraday_refetch_threshold: 1.8,
    },
    forecast: {
        horizon_hours: 24,
        fetch_interval_hours: 6
    },
    battery: {
        capacity_kwh: 20.0,
        max_charge_w: 7500,
        max_discharge_w: 7500,
        efficiency: 0.90,
        min_soc: 14,
        max_soc: 100, 
        // Small penalty for holding SOC during the pre-sunrise window (3 h before first solar slot).
        // Nudges the LP to discharge more aggressively before dawn, leaving more room for solar.
        // Expressed as a fraction of the average buy price — 0 disables, 0.3 is a gentle nudge.
        dawn_soc_penalty: 0,
        // Forward-feasibility ceiling: penalises holding SOC that exceeds what the remaining
        // consumption-bounded discharge slots can actually absorb in this planning window.
        // Prevents the LP from hoarding charge overnight when morning/evening windows cannot
        // fully use it — e.g. battery started at 70%, house load is modest, yet the LP idles
        // overnight while the grid covers the house instead of spending stranded battery Wh.
        //
        // How it works: for each non-solar slot t, the optimizer pre-computes the maximum Wh
        // it can discharge from t to end of window (bounded by consumption per slot). Any SOC
        // above that ceiling is "stranded" and earns a soft penalty, nudging earlier discharge.
        //
        // Weight = fraction of slot buy-price per Wh above ceiling:
        //   0      — disabled (original behaviour, no overnight nudge)
        //   0.10   — very subtle; only fires on large, sustained stranding
        //   0.20   — default gentle nudge; good starting point
        //   0.40   — assertive; use if overnight idle persists on clearly high-SOC days
        //   0.50+  — strong; risk of discharging before a late price peak the model under-sees
        //
        // Tune UP if:  battery still idles overnight with obvious spare capacity and the
        //              morning/evening discharge never approaches the floor.
        // Tune DOWN if: it discharges the night before a clear price peak earlier than wanted,
        //               or if overnight discharge eats into capacity needed the next morning.
        stranded_soc_penalty: 0.20,
        // Maximum buy price (SEK/kWh, inclusive) at which grid charging is allowed.
        // Slots with buy_price above this threshold have their charge_grid bound set to zero,
        // preventing the optimizer from charging at obviously expensive prices.
        // null = no ceiling (backward-compatible default).
        charge_grid_max_buy_price: null,
        // Safety margin (percentage points ABOVE min_soc) the optimizer protects
        // with grid charging. The margin SOC is  min_soc + grid_charge_floor_buffer_soc
        // (currently 8 + 5 = 13%).
        // Grid charge is only allowed when the battery cannot otherwise bridge to
        // the next solar-production onset (sunrise) while staying at/above this
        // margin — i.e. floor protection only. Above it, the optimizer never
        // grid-charges for arbitrage/hedging (e.g. buying cheap pre-dawn when SOC
        // can ride to sunrise). Robust to solar under-forecast: the pre-solar
        // bridge depends on current SOC and near-term load, not on the uncertain
        // solar magnitude — on a genuinely cloudy day the battery rides down
        // toward the margin and imports directly rather than pre-buying.
        // 0 = protect exactly min_soc; 5 = keep a 5-point reserve above it.
        // null disables the gate (legacy arbitrage behaviour).
        grid_charge_floor_buffer_soc: 5,
        // If actual SOC falls this many percentage points below the optimizer's plan,
        // a full replan is triggered so the optimizer can pick the cheapest recovery slot.
        soc_deviation_threshold: 8,
        // Optimization horizon in hours (rolling window from "now"). 24 = legacy
        // behaviour; 48 lets the optimizer see the upcoming night when planning
        // daytime charging, so it can fill the battery during cheap hours to cover
        // an expensive night instead of discovering the need only the next morning.
        // The effective span is still capped by how many price slots are published
        // (next-day prices arrive ~13:00), so before then it naturally runs shorter.
        // Only affects batteryPipeline; dispatch/snapshot still use the current slot.
        optimizer_window_hours: 48,
    },
    grid: {
        // Set sell_enabled: true to allow the optimizer to plan battery→grid export slots.
        // Revenue per kWh: spot_price × sell_price_factor − transfer_export_kwh.
        // Only profitable when spot prices are high enough to overcome the efficiency loss
        // and transfer fee. Requires the inverter to support export (check grid operator rules).
        // On Growatt MOD TL3-XH: also switches inverter to Grid First mode (holding reg 3038 = 2)
        // during sell slots, enabling active battery→grid export after sunset.
        // Verify reg 3038 with write-register.js before enabling — see battery-optimizer.md Phase 0.
        sell_enabled: false,
        sell_price_factor: 0.80,
        // Fallback export cap (W) used only when peak_shaving is disabled or no limits resolve.
        // When peak_shaving is enabled, export_kw from the matching date_range/schedule is used instead.
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
    ev: {
        // Set enabled: true if an EV charges at this location via a supplier-controlled charger.
        // When enabled, consumption readings above max_house_w are stored as house-only
        // (total − charge_watts) and tagged 'inverter_delta_ev', keeping the consumption
        // model clean. Battery discharge is bounded to house load only — the EV draws from
        // the grid directly, enforced by the peak_shaving hardware register (800).
        //
        // NOTE: raise peak_shaving.schedule limit during EV charging hours so the hardware
        // allows enough grid import for EV + house, e.g. { from: '00:00', to: '06:45', limit_kw: 12 }
        enabled: true,
        charge_watts: 5300,           // nameplate EV charger draw (W)

        // Auto-charge battery when EV charging is detected.
        // When consumption > max_house_w + charge_watts/2 AND solar < threshold,
        // executePipeline triggers a 'charge' override so the battery fills to
        // charge_soc (90%) alongside the EV — useful during Tibber Grid Rewards.
        // The override is cleared automatically when EV charging stops or solar appears.
        // A manual override always takes priority over this automatic behaviour.
        auto_charge_grid: true,
        auto_charge_solar_threshold_w: 200, // suppress auto-charge when solar exceeds this (W)
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
        discharge_soc: 14,                         // SOC floor when discharging (low = battery empties); matches battery.min_soc — grid-charge gate protects min_soc + grid_charge_floor_buffer_soc (13%) above this

        // --- Growatt cloud API settings (used when brand = 'growatt') ---
        // server: 'https://openapi.growatt.com/',
        // token: '',
        // device_sn: '',
    },
    peak_shaving: {
        // Grid import/export power caps written to inverter holding registers 3307/3308.
        // Scale: 0.1 kW per unit (value 45 = 4.5 kW). Only written when value changes.
        //
        // Resolution order for each 15-min slot:
        //   1. Find the first date_ranges entry where today's MM-DD falls in [from, to]
        //      (or entry has default: true as catch-all). Ranges that cross year-end
        //      (e.g. Oct–Mar: from '10-01' > to '03-31') are handled automatically.
        //   2. Within that range, find the first schedule window covering the slot time.
        //   3. Fall back to the range's default_import_kw / default_export_kw.
        enabled: true,
        date_ranges: [
            {
                from: '10-01', to: '03-31',        // Oct–Mar (wraps year boundary)
                default_import_kw: 4.1,
                default_export_kw: 4.0,
                schedule: [
                    // Raise limit during overnight EV charging hours (HH:MM, first match wins).
                    { from: '00:00', to: '06:45', import_kw: 12, export_kw: 11 },
                    { from: '21:05', to: '23:59', import_kw: 12, export_kw: 11 },
                ],
            },
            {
                from: '04-01', to: '09-30',        // Apr–Sep
                default_import_kw: 12,
                default_export_kw: 11,
                schedule: [],
            },
            {
                default: true,                     // catch-all if no date range matches
                default_import_kw: 12,
                default_export_kw: 11,
                schedule: [],
            },
        ],
    },
    dashboard: {
        // HTTP basic auth for remote access. Leave auth_pass empty to disable.
        // WARNING: HTTP only — do not expose to the internet without a TLS reverse proxy.
        auth_user: 'admin',
        auth_pass: '',      // set a password to enable
    },
    system: {
        // How long (ms) to wait after a config.js change before restarting.
        // Guards against editors that write the file multiple times in quick succession.
        config_reload_debounce_ms: 240000, // 4 min
    },
    price: {
        // Price sources tried in order — first one to return data wins.
        // Each entry must match a filename in src/prices/ (without .js extension).
        sources: ['elprisetjust', 'nordpool'],
        region: 'SE3',              // Provider-specific region code
        currency: 'SEK',            // Display currency (must be SEK when using energidataservice)
        day_ahead_hour: 13,         // Hour (UTC) when tomorrow's prices publish
    },
};
