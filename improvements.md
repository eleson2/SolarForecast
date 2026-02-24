# Improvement Ideas

Ideas collected here for later evaluation and prioritization.

---

## Learner / Correction Matrix

### Weight corrections by irradiance level
A correction factor learned on a cloudy day at 20 W/m² is much less reliable
than one learned on a clear day at 400 W/m². Currently all samples are weighted
equally, meaning a single cloudy day can distort a cell until enough clear-day
samples average it out.

**Idea:** Weight each new correction sample by the irradiance level (or a
normalized confidence score) when updating `correction_avg`. High-irradiance
samples count more; low-irradiance samples count less.

### Use weather forecast to flag cloudy-day corrections
Combine irradiance weighting with the Open-Meteo cloud cover forecast. When a
learning update happens under heavily overcast conditions (e.g. cloud cover > 80%
or irradiance < some threshold), mark the correction as low-confidence or skip
it entirely. This would make the learner robust to bad-weather noise almost
immediately rather than relying on the smoother to dilute it over weeks.

**Depends on:** irradiance weighting above (both ideas work well together).

---

## General

*(Add more ideas here as they come up)*
