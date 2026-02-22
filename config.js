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
        brand: 'growatt',                         // driver name — matches src/inverters/<brand>.js
        server: 'https://openapi.growatt.com/',   // EU; use -us or -cn for other regions
        token: '',                                // Growatt OpenAPI V1 token
        device_sn: '',                            // MIN inverter serial number
        poll_interval_s: 30,
        failsafe_mode: 'load_first',
    },
    price: {
        source: 'elprisetjust',     // 'elprisetjust' (Nordics) or 'awattar' (DE/AT)
        region: 'SE3',              // Provider-specific region code
        currency: 'SEK',            // Display currency
        day_ahead_hour: 13,         // Hour (UTC) when tomorrow's prices publish
    },
};
