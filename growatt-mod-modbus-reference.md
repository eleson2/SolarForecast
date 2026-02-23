# Growatt MOD TL3-XH — Modbus TCP Reference

Extracted from: *Growatt Inverter Modbus RTU Protocol V1.24*
Applies to: **MOD TL3-XH** series via datalogger (Modbus TCP).

---

## Register Ranges for MOD TL3-XH

| Function | Register Range | Description |
|----------|---------------|-------------|
| 03 (Holding) | 0–124 | First group: control, config, grid protection |
| 03 (Holding) | 3000–3124 | Storage/battery control (XH-specific) |
| 04 (Input) | 3000–3124 | Storage real-time data |
| 04 (Input) | 3125–3249 | Extended battery/BMS data |

---

## Communication Settings (Modbus TCP)

- **Transport**: TCP, default port 502
- **Unit ID**: 1 (same as Modbus RTU slave address; configurable via holding register 30)
- **Protocol**: Standard Modbus TCP (MBAP header, no CRC — TCP handles integrity)
- **Minimum command interval**: 850ms (recommended 1s)
- **Max read length**: 125 registers per request
- **Max write length**: 125 registers per request
- **Byte order**: Big-endian (high word first for 32-bit values)

The register map is identical to the RTU protocol document. Only the framing differs
(MBAP header instead of address+CRC).

---

## Steering Strategy: SOC Buffer Control

The inverter stays in **load-first mode** permanently. Battery behavior is controlled
by adjusting the **reserved SOC floor** (holding register 3082 `LoadFirstStopSocSet`).

In load-first mode, the battery discharges to power the house down to the reserved SOC.
By manipulating this single register, all three behaviors are achieved:

| Desired Behavior | Reserved SOC | Effect |
|---|---|---|
| **Charge** | High (e.g. 95%) | Battery won't discharge — solar/grid fills it toward target |
| **Discharge** (peak shave) | Low (e.g. 13%) | Battery freely discharges to power house |
| **Idle** (prefer grid) | Current SOC | Battery can't discharge (floor = current level), stays put |

### Advantages over time-segment approach

- **Single register write** instead of encoding complex time segments
- **Instant response** — change behavior at any 15-min slot, not limited to 9 segments
- **Simpler logic** — optimizer outputs a SOC target, not a mode enum
- **Graceful** — inverter handles the actual charge/discharge power ramping

### Implementation flow

```
Every 15 minutes:
  1. Read current SOC (input reg 3014)
  2. Optimizer decides desired behavior for this slot
  3. Write LoadFirstStopSocSet (holding reg 3082):
     - charge:    write high value (95)
     - discharge: write low value (13)
     - idle:      write current SOC
```

### Peak shaving schedule

Peak shaving is enabled during configured time windows (e.g., 07:00–09:00 and 17:00–20:00
when grid tariffs are high). Outside these windows, the battery charges from solar normally.

The optimizer combines:
- **Time-of-day rules** — which slots have peak shaving enabled
- **Price signals** — electricity spot price for cost optimization
- **Solar forecast** — expected production to decide how much SOC to reserve

---

## Holding Registers — Control & Configuration

### Basic Inverter Control (Group 1: 0–124)

| Reg | Name | R/W | Value | Unit | Description |
|-----|------|-----|-------|------|-------------|
| 0 | OnOff | W | 0=Off inv, 1=On inv, 2=Off BDC, 3=On BDC | | Remote on/off control |
| 3 | Active P Rate | W | 0–100, 255 | % | Max output active power. 255 = unlimited |
| 30 | Com Address | W | 1–254 | | Modbus unit ID |
| 45–50 | Sys Year/Month/Day/Hour/Min/Sec | W | | | System time |
| 122 | ExportLimit En/dis | R/W | 0=Disable, 1=485, 2=232, 3=CT | | Export limit enable |
| 123 | ExportLimitPowerRate | R/W | -1000 to +1000 | 0.1% | Export limit power rate |

### Storage/Battery Control (Group: 3000–3124, XH-specific)

| Reg | Name | R/W | Value | Unit | Description |
|-----|------|-----|-------|------|-------------|
| 3000 | ExportLimitFailedPowerRate | R/W | | 0.1% | Power rate when export limit fails |
| 3024 | Float charge current limit | R/W | | 0.1A | Float charge current threshold |
| 3025 | VbatWarning | R/W | | 0.1V | Battery low warning voltage |
| 3027 | Vbatstopfordischarge | R/W | | 0.1V | Battery cutoff voltage |
| 3028 | Vbat stop for charge | R/W | | 0.01V | Battery over-charge voltage |
| 3029 | Vbat start for discharge | R/W | | 0.01V | Battery start discharge voltage |
| 3030 | Vbat constant charge | R/W | | 0.01V | CV voltage (constant voltage) |
| 3031 | Bat temp lower limit d | R/W | | 0.1C | Battery min temp for discharge |
| 3032 | Bat temp upper limit d | R/W | | 0.1C | Battery max temp for discharge |
| 3033 | Bat temp lower limit c | R/W | | 0.1C | Battery min temp for charge |
| 3034 | Bat temp upper limit c | R/W | | 0.1C | Battery max temp for charge |
| 3036 | GridFirstDischargePowerRate | R/W | 1–255 | % | Discharge power rate in grid-first mode |
| 3037 | GridFirstStopSOC | R/W | 1–100 | % | Stop discharge SOC in grid-first mode |
| 3047 | BatFirstPowerRate | R/W | 1–100 | % | Charge power rate in bat-first mode |
| 3048 | BatFirstStopSOC | R/W | 1–100 | % | Stop charge SOC in bat-first mode |
| 3049 | AcChargeEnable | R/W | 0=Disable, 1=Enable | | AC (grid) charging enable |
| 3070 | BatteryType | R/W | 0=Lithium, 1=Lead-acid, 2=Other | | Battery type selection |
| 3079 | UpsFunEn | R/W | 0=Disable, 1=Enable | | UPS/EPS function |
| **3082** | **LoadFirstStopSocSet** | **R/W** | **13–100** | **%** | **Reserved SOC floor in load-first mode (primary steering register)** |
| 3085 | Com Address | R/W | 1–254 | | BDC communication address |

### Time Segments (3038–3059, XH format)

Not used in the SOC-buffer steering approach, but documented for reference.

Each time period uses 2 registers. Up to 9 time periods (Time 1–9).

**Register format for start time (even register: 3038, 3040, 3042, ...):**

| Bit | Field |
|-----|-------|
| 0–7 | Minutes (0–59) |
| 8–12 | Hour (0–23) |
| 13–14 | Priority: 0=Load first, 1=Battery first, 2=Grid first |
| 15 | Enable: 0=Disabled, 1=Enabled |

**Register format for end time (odd register: 3039, 3041, 3043, ...):**

| Bit | Field |
|-----|-------|
| 0–7 | Minutes (0–59) |
| 8–12 | Hour (0–23) |
| 13–15 | Reserved |

**Time period register pairs:**

| Period | Start Reg | End Reg |
|--------|-----------|---------|
| 1 | 3038 | 3039 |
| 2 | 3040 | 3041 |
| 3 | 3042 | 3043 |
| 4 | 3044 | 3045 |
| 5 | 3050 | 3051 |
| 6 | 3052 | 3053 |
| 7 | 3054 | 3055 |
| 8 | 3056 | 3057 |
| 9 | 3058 | 3059 |

---

## Input Registers — Real-Time Telemetry

### Inverter Status (Group 1: 0–124, shared)

| Reg | Name | Unit | Description |
|-----|------|------|-------------|
| 0 | Inverter Status | | 0=Waiting, 1=Normal, 3=Fault |
| 1–2 | Ppv H/L | 0.1W | Total PV input power (32-bit) |
| 3 | Vpv1 | 0.1V | PV1 voltage |
| 4 | PV1Curr | 0.1A | PV1 current |
| 5–6 | Ppv1 H/L | 0.1W | PV1 power (32-bit) |
| 7 | Vpv2 | 0.1V | PV2 voltage |
| 8 | PV2Curr | 0.1A | PV2 current |
| 9–10 | Ppv2 H/L | 0.1W | PV2 power (32-bit) |
| 35–36 | Pac H/L | 0.1W | Total AC output power (32-bit) |
| 37 | Fac | 0.01Hz | Grid frequency |
| 38 | Vac1 | 0.1V | Grid voltage (phase 1) |
| 39 | Iac1 | 0.1A | Grid current (phase 1) |
| 53–54 | Eactoday H/L | 0.1kWh | Energy generated today (32-bit) |
| 55–56 | Eac total H/L | 0.1kWh | Total energy generated (32-bit) |
| 93 | Temp1 | 0.1C | Inverter temperature |
| 94 | Temp2 | 0.1C | IPM temperature |
| 105 | Fault Maincode | | Fault main code |
| 106–107 | Fault Subcode | | Fault sub code |

### Storage Data (Group: 3000–3124, XH-specific)

| Reg | Name | Unit | Description |
|-----|------|------|-------------|
| 3000 | uwSysWorkMode | | System work mode (see below) |
| 3001–3008 | System fault words 0–7 | | Fault codes |
| 3009–3010 | Pdischarge1 H/L | 0.1W | Battery discharge power (32-bit) |
| 3011–3012 | Pcharge1 H/L | 0.1W | Battery charge power (32-bit) |
| 3013 | Vbat | 0.1V | Battery voltage |
| 3014 | SOC | 1% | State of charge (0–100) |
| 3015–3016 | Pactouser R H/L | 0.1W | Grid power to user, phase R (32-bit) |
| 3021–3022 | PactouserTotal H/L | 0.1W | Total grid power to user (32-bit) |
| 3023–3024 | Pactogrid R H/L | 0.1W | Power exported to grid, phase R (32-bit) |
| 3029–3030 | Pactogrid total H/L | 0.1W | Total power exported to grid (32-bit) |
| 3031–3032 | PLocalLoad R H/L | 0.1W | Local load power, phase R (32-bit) |
| 3037–3038 | PLocalLoad total H/L | 0.1W | Total local load power (32-bit) |
| 3040 | Battery Temperature | 0.1C | Battery temperature |
| 3044–3045 | Etouser_today H/L | 0.1kWh | Energy from grid today (32-bit) |
| 3046–3047 | Etouser_total H/L | 0.1kWh | Energy from grid total (32-bit) |
| 3048–3049 | Etogrid_today H/L | 0.1kWh | Energy to grid today (32-bit) |
| 3050–3051 | Etogrid_total H/L | 0.1kWh | Energy to grid total (32-bit) |
| 3052–3053 | Edischarge1_today H/L | 0.1kWh | Discharge energy today (32-bit) |
| 3054–3055 | Edischarge1_total H/L | 0.1kWh | Discharge energy total (32-bit) |
| 3056–3057 | Echarge1_today H/L | 0.1kWh | Charge energy today (32-bit) |
| 3058–3059 | Echarge1_total H/L | 0.1kWh | Charge energy total (32-bit) |
| 3060–3061 | ELocalLoad_Today H/L | 0.1kWh | Local load energy today (32-bit) |
| 3062–3063 | ELocalLoad_Total H/L | 0.1kWh | Local load energy total (32-bit) |
| 3067 | EPS Fac | 0.01Hz | UPS/EPS frequency |
| 3068 | EPS Vac1 | 0.1V | UPS output voltage |

**System work modes (input reg 3000):**

| Value | Mode | Description |
|-------|------|-------------|
| 0x00 | Waiting | Standby |
| 0x01 | Self-test | Self-test |
| 0x03 | SysFault | Fault |
| 0x04 | Flash | Firmware update |
| 0x05 | PVBATOnline | Normal (PV + battery, grid-tied) |
| 0x06 | BatOnline | Normal (battery only, grid-tied) |
| 0x07 | PVOfflineMode | Normal (PV, off-grid/EPS) |
| 0x08 | BatOfflineMode | Normal (battery, off-grid/EPS) |

### BMS Data (Group: 3125–3249, XH-specific)

| Reg | Name | Unit | Description |
|-----|------|------|-------------|
| 3169 | Vbat | 0.01V | Battery voltage (high precision) |
| 3170 | Ibat | 0.1A | Battery current |
| 3171 | SOC | 1% | State of charge |
| 3215 | BMS_SOC | 1% | SOC from BMS |
| 3216 | BMS_BatteryVolt | 0.01V | Battery voltage from BMS |
| 3217 | BMS_BatteryCurr | 0.01A | Battery current from BMS |
| 3218 | BMS_BatteryTemp | 0.1C | Battery cell max temperature |

---

## Reading 32-bit Values

Many power and energy values span two registers (H/L). Combine as:

```
value = (register_H << 16) | register_L
```

Then apply the unit scaling (e.g., divide by 10 for 0.1W to get watts).

---

## Key Operations for Battery Optimizer

### 1. Read current state

Two reads needed (different register groups):

**Group 1** — input regs 0–10 (function 04, start=0, count=11):
- **Inverter status**: reg 0
- **Solar power**: regs 1–2 (Ppv H/L)

**Storage group** — input regs 3000–3040 (function 04, start=3000, count=41):
- **Battery discharge power**: regs 3009–3010
- **Battery charge power**: regs 3011–3012
- **Battery voltage**: reg 3013
- **SOC**: reg 3014
- **Grid import (total)**: regs 3021–3022
- **Grid export (total)**: regs 3029–3030
- **Local load (total)**: regs 3037–3038
- **Battery temperature**: reg 3040

### 2. Steer battery via SOC buffer (primary method)

Write a single holding register:
- **Register 3082** (`LoadFirstStopSocSet`): 13–100%

```
To charge:    write 95  (or desired target SOC)
To discharge: write 13  (minimum allowed)
To idle:      read SOC from input reg 3014, write that value to 3082
```

### 3. Remote on/off

Write holding register 0: value 1 = inverter on, value 0 = inverter off.

---

## Comparison: Cloud API vs Modbus TCP

| Aspect | Current (Cloud API) | Modbus TCP |
|--------|-------------------|------------|
| Latency | 1–5s (internet round-trip) | <100ms (local network) |
| Availability | Depends on internet + Growatt servers | Always available on LAN |
| Rate limit | Growatt API limits apply | Only 850ms min between commands |
| Steering | 9 time segments + mode switches | Single register write (SOC buffer) |
| SOC reading | Polled via cloud | Direct register read |
| Granularity | API abstractions | Full register-level control |
| Setup | API token + device_sn | Datalogger IP + unit ID |

---

## Notes

- The MOD TL3-XH shares the "Storage Power" register range with MIX/SPH models for battery operations
- Holding register writes should follow manufacturer guidance; grid protection registers (52–79) should not be modified casually
- 32-bit values always use big-endian register order: high word first, low word second
- The `jsmodbus` or `modbus-serial` npm packages support Modbus TCP client
