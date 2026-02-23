# Growatt MOD TL3-XH — Verified Register Map

This document combines the Growatt protocol V1.24 reference, the APX battery register
list, and empirical testing against the actual datalogger at 192.168.1.180.

**Important:** The actual register layout differs significantly from the V1.24 reference
document. Registers were verified by reading live data and correlating with known values.

## Connection

| Parameter   | Value           |
|-------------|-----------------|
| Transport   | Modbus TCP      |
| Host        | 192.168.1.180   |
| Port        | 502             |
| Unit ID     | 1 (all IDs return the same data) |
| Min interval| 850ms (recommended 1s) |
| Timeout     | 5000ms          |

---

## Input Registers — Inverter (Group 1: 0–49)

These work as documented. The 3000+ range mirrors these with a +3000 offset.

| Reg   | Name              | Scale | Verified | Notes |
|-------|-------------------|-------|----------|-------|
| 0     | Inverter Status   | —     | Yes      | 0=waiting, 1=normal, 3=fault |
| 1–2   | Total PV Power    | 0.1W  | Yes      | 32-bit (H/L). Confirmed ~760–1024W |
| 3     | PV1 Voltage       | 0.1V  | Yes      | Confirmed ~511–532V |
| 4     | PV1 Current       | 0.1A  | Yes      | Confirmed ~1.4–1.5A |
| 5–6   | PV1 Power         | 0.1W  | Yes      | 32-bit. Matches PV1 V×A |
| 7     | PV2 Voltage       | 0.1V  | Yes      | 0 (PV2 not connected) |
| 8     | PV2 Current       | 0.1A  | Yes      | 0 |
| 9–10  | PV2 Power         | 0.1W  | Yes      | 0 |
| 35–36 | AC Output Power   | 0.1W  | Yes      | 32-bit. Confirmed ~2240W |
| 37    | Grid Frequency    | 0.01Hz| Yes      | Confirmed 49.93 Hz |
| 38    | Grid Voltage L1   | 0.1V  | Yes      | Confirmed ~232V |
| 39    | Grid Current L1   | 0.1A  | Yes      | Confirmed ~3.1A |
| 40    | Grid Voltage L2   | 0.1V  | Suspect  | Read 0V — may be unused on this install |
| 41    | Grid Current L2   | 0.1A  | Suspect  | Read 719.8A — garbage or different meaning |
| 42    | Grid Voltage L3   | 0.1V  | Yes      | Confirmed ~231.8V |
| 43    | Grid Current L3   | 0.1A  | Yes      | Confirmed ~3.2A |
| 44–45 | AC Power L1       | 0.1W  | Yes      | 32-bit. ~741W |
| 46–47 | AC Power L2       | 0.1W  | Suspect  | Garbage (15M W) |
| 48–49 | AC Power L3       | 0.1W  | Yes      | 32-bit. ~701W |
| 50–51 | AC Power Total    | 0.1W  | Suspect  | Garbage (26M W) — use regs 35-36 instead |
| 53–54 | Energy Today      | 0.1kWh| Yes      | 32-bit. Confirmed 6.5 kWh |
| 55–56 | Energy Total      | 0.1kWh| Yes      | 32-bit. Confirmed 8568.6 kWh |
| 93    | Temp Inverter     | 0.1°C | Yes      | Confirmed 45°C |
| 94    | Temp IPM          | 0.1°C | Yes      | Confirmed 31.7°C |

### Notes on Group 1

- L2 voltage/current/power registers return garbage — possibly because this is a
  single-phase or split-phase installation, or the register map for 3-phase differs.
- AC Power Total (50–51) is also garbage. Use AC Output (35–36) instead.
- The 3000+ input range is a **mirror** of 0+ with +3000 offset (same data, same timing jitter).

---

## Input Registers — Inverter (3000+ range, alternate naming)

Per the new register file, the 3000+ range uses this layout (which matches Group 1 with offset):

| Reg       | Name                          | Scale   | Verified |
|-----------|-------------------------------|---------|----------|
| 3000      | Status                        | —       | Yes (=1) |
| 3001      | PV1 Voltage                   | 0.1V    | Yes (mirrors reg 3) |
| 3003      | PV2 Voltage                   | 0.1V    | Yes |
| 3005–3006 | Total Active Power            | 0.1W    | Yes (mirrors regs 1-2) |
| 3013      | Grid Frequency                | 0.01Hz  | Yes (mirrors reg 37) |
| 3014–3016 | Grid Voltage L1, L2, L3       | 0.1V    | Yes |
| 3017–3019 | Grid Current L1, L2, L3       | 0.1A    | Yes |
| 3020      | PV Power                      | 0.1W    | Unverified |
| 3021–3023 | Output Active Power L1, L2, L3| 0.1W    | Partially (3021-3022 as grid import was wrong interpretation) |
| 3024      | Reactive Power                | 0.1var  | Unverified |
| 3025–3026 | Total Energy Export to Grid   | 0.1kWh  | Unverified |
| 3027–3028 | Total Energy Import from Grid | 0.1kWh  | Unverified |
| 3029–3030 | Today Generation Energy       | 0.1kWh  | Unverified |
| 3031–3032 | Total Generation Energy       | 0.1kWh  | Unverified |

**Important:** The V1.24 reference doc assigns completely different meanings to these
registers (3000=work mode, 3009-3010=discharge power, 3014=SOC, etc.). Those mappings
are WRONG for this datalogger/firmware. The register file's mapping is correct.

---

## Input Registers — APX Battery (1000–1007)

From the register file. Accessible but returns all zeros — data not populated on this datalogger.

| Reg  | Name             | Scale      | Status                |
|------|------------------|------------|-----------------------|
| 1000 | Battery Status   | —          | Responds, always 0    |
| 1001 | Battery SOC      | 0.1%       | Responds, always 0    |
| 1002 | Battery Voltage  | 0.1V       | Responds, always 0    |
| 1003 | Battery Power    | 0.1W       | Responds, always 0    |
| 1004 | Battery SOC (2)  | 0.1%       | Responds, always 0    |
| 1005 | Battery Current  | 0.1A       | Responds, always 0    |
| 1006 | Battery Temp     | 0.1°C      | Responds, always 0    |
| 1007 | Battery SoH      | 0.1%       | Responds, always 0    |

Note: first test timed out, second test responded but with all zeros. Use BMS registers
(3169–3171) for battery telemetry instead.

---

## Input Registers — BMS (3169–3218)

From V1.24 reference. Partially verified through empirical testing.

| Reg  | Name          | Scale (doc) | Verified | Empirical observations |
|------|---------------|-------------|----------|------------------------|
| 3169 | Vbat          | 0.01V       | Partial  | Read 7256–7279. At 0.01V = 72.6V (low for HV pack). Scaling uncertain. |
| 3170 | Ibat          | 0.1A        | Yes      | Signed. Read -2.4 to -3.0A (negative = charging). Correlates with battery behavior. |
| 3171 | SOC           | 1%          | Yes      | Confirmed: tracks actual SOC (76%, 38%, 37%, 39%). |
| 3172 | (unknown)     | —           | No       | Read same value as 3169 (voltage mirror?) |
| 3176 | (temp?)       | 0.1°C?      | No       | Read 407 = 40.7°C — plausible for inverter temp |
| 3177 | (temp?)       | 0.1°C?      | No       | Read 316 = 31.6°C — plausible |
| 3207 | (unknown)     | —           | No       | Read 7500. At 0.1V = 750V? |
| 3215 | BMS_SOC       | 1%          | Yes      | Always matches reg 3171 |
| 3216 | BMS_BatteryV  | 0.01V       | No       | Read 3759–3773. At 0.01V = 37.7V (too low?). At 0.1V = 375.9V (plausible for HV pack). |
| 3217 | BMS_BatteryCurr| 0.01A      | No       | Read 65492 = signed -44 → -0.44A at 0.01A. Doesn't match power levels. |
| 3218 | BMS_BatteryTemp| 0.1°C      | No       | Read 0 — not reporting |

### Notes on BMS

- SOC (3171 and 3215) is reliable and confirmed across multiple tests.
- Current (3170) correlates with charge/discharge behavior.
- Voltage scaling is unclear — neither 0.01V nor 0.1V produces a clearly correct value.
- If APX battery regs (1000+) work, they provide better-documented data with known scaling.

---

## Holding Registers — Battery Summary Block (800–815)

This block contains battery state and control registers. Verified across 5 test runs.

| Reg  | Name                  | R/W  | Scale | Verified | Notes |
|------|-----------------------|------|-------|----------|-------|
| 800  | (unknown)             | R?   | —     | Observed | Constant 45 across all scans |
| 801  | (unknown)             | R?   | —     | Observed | Constant 40 across all scans |
| 802  | (live metric)         | R    | —     | Yes      | Drifts: 18, 20, 21, 22. Not a setting. |
| 803  | (live metric)         | R    | —     | Yes      | Drifts: 63, 64, 65, 66. Not a setting. |
| 807  | Current SOC           | R    | 1%    | **Yes**  | Tracks BMS SOC exactly: 38→38, 37→37, 42→42 |
| 808  | (mirror of 3310)      | R/W  | 1%    | **Yes**  | Tracks reserved SOC floor 1:1 across 4 setting changes (20%, 80%, 44%) |
| 809  | (unknown)             | R?   | —     | Observed | Constant 65535 (0xFFFF) |
| 810  | (unknown SOC setting) | R?   | 1%?   | Observed | Constant 80 across all scans. Did not change when 808 changed. |
| 812  | (live metric)         | R    | —     | Observed | Varies: 86, 88. Possibly battery-related. |
| 3310 | **LoadFirstStopSocSet** | **R/W** | **1%** | **Yes** | **Reserved SOC for peak shaving. Externally confirmed. Primary address for writes.** |
| 3312 | (mirror of 810)       | R?   | 1%?   | Yes      | Always identical to reg 810 |

### Holding registers from register file

| Reg | Name                    | Values | Status |
|-----|-------------------------|--------|--------|
| 22  | Baud Rate Set           | 0=9600, 1=19200 | Not verified |
| 100 | Inverter On/Off         | 0=Off, 1=On | Not verified |
| 300 | Maximum Active Power    | 0–100% | Not verified |
| 400 | Battery Charge Priority | Time slot settings (1,2,3) | **Timed out** — not accessible |

### Holding registers — Storage Control (3000+ range)

These are in the 3000+ range and verified on this datalogger.

| Reg  | Name (V1.24)               | Inverter label       | Value | Verified |
|------|----------------------------|----------------------|-------|----------|
| 3036 | GridFirstDischargePowerRate | —                    | 100   | Plausible (100%) |
| 3037 | GridFirstStopSOC           | —                    | 10    | Plausible (10%) |
| 3047 | BatFirstPowerRate          | —                    | 100   | Plausible (100%) |
| 3048 | BatFirstStopSOC            | **ChargeStopSOC**    | R/W | 90→99 | **Yes** — changed when user set ChargeStopSOC from 80→99 |
| 3049 | AcChargeEnable             | —                    | R/W? | 1     | Plausible (1 = enabled) |
| 3067 | (not in V1.24)             | **DischargingStopSOC** | **R/W** | 10→11 | **Yes** — read + write verified. Modbus write updates inverter. |
| 3310 | (not in V1.24)             | **LoadFirstStopSocSet** (peak shaving reserve) | **R/W** | 19 | **Yes** — confirmed across 4 setting changes. Independent from 3067. |

### Relationship between SOC settings

```
ChargeStopSOC (3048)        — upper limit: battery stops charging at this SOC
LoadFirstStopSocSet (3310)  — peak shaving reserve: battery stops discharging to load at this SOC
DischargingStopSOC (3067)   — absolute floor: battery never goes below this SOC
```

Example: with 3048=99, 3310=44, 3067=11:
- Battery charges up to 99%
- In load-first mode, battery discharges to power house down to 44% (peak shaving reserve)
- Battery never discharges below 11% under any circumstance

### Holding register 808 — confidence assessment

**Evidence for holding 3310 = LoadFirstStopSocSet (reserved SOC for peak shaving):**
1. Externally confirmed as "reserved SOC for peak shaving" register
2. Changed from 20→80 when user set reserved SOC from 20%→80% on inverter panel
3. Changed from 80→44 when user set reserved SOC to 44%
4. Mirror register 808 always shows the identical value
5. Value range (13–100) matches expected SOC percentage

**Register 808 (mirror) — additional context:**
- Located in a battery summary block (800–815) alongside current SOC (reg 807)
- Reg 807 = current SOC (verified 4 times: always matches BMS SOC at input 3171)
- Reg 810 = another SOC-related constant (always 80, never changes)

**Status:** Write verified. Writing to holding 3067 via Modbus TCP updated the inverter
setting (confirmed on panel). Initial test appeared to fail due to web/app caching —
the write actually went through. Register 3310 is the primary address for the driver.

---

## Register Map Discrepancies

### V1.24 Reference vs Actual Datalogger

The Growatt protocol V1.24 document describes a register layout for MOD TL3-XH that
does **not** match this datalogger's actual behavior:

| V1.24 says | Actual behavior |
|---|---|
| Input 3000 = System Work Mode (storage) | Input 3000 = Inverter Status (mirrors reg 0) |
| Input 3009-3010 = Discharge Power | Returns 0 |
| Input 3011-3012 = Charge Power | Returns 0 |
| Input 3013 = Battery Voltage | Input 3013 = Grid Frequency (0.01Hz) |
| Input 3014 = SOC | Input 3014 = Grid Voltage L1 (0.1V) |
| Input 3021-3022 = Grid Import Total | Input 3021-3023 = Output Active Power L1-L3 |
| Holding 3082 = LoadFirstStopSocSet | Returns 0; actual register is 808 |

### What works from V1.24

- Holding 3036-3049 (storage control settings) — read correctly
- BMS input 3171 (SOC) and 3170 (current) — read correctly
- BMS input 3215 (BMS_SOC) — read correctly

### Likely explanation

The datalogger firmware exposes a simplified/remapped register set. The 3000+ input
range is a mirror of Group 1 (0+) rather than the separate storage group described in
V1.24. Battery telemetry is available via BMS registers (3169+) and likely via APX
battery registers (1000+, pending verification).
