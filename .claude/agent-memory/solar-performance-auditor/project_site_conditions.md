---
name: site_conditions
description: Physical site conditions and expected system behaviour specific to this installation
type: project
---

Mountains block evening sun at this installation. Correction matrix underperformance in late-afternoon hours (17:00+) is expected and normal — do not flag as an anomaly unless deviation is severe.

Location: approximately 57.85°N 11.77°E (Sweden, SE3 price region).
Inverter: Growatt MOD TL3-XH, Modbus TCP at 192.168.1.180:502.
Panel rated capacity: ~6.5 kW peak (clipping visible at high irradiance).

**Why:** Mountains create a hard horizon cut-off in the west. Late-afternoon actuals are routinely below physics-model forecast and will remain so until the correction matrix has enough seasonal data (~1 year) to learn the pattern.

**How to apply:** When reviewing solar forecast accuracy, treat hour 17 and later with relaxed thresholds. A large negative error (actual << forecast) in those hours is a site artefact, not a model failure.
