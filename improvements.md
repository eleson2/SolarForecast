# Improvement Ideas

Ideas collected here for later evaluation and prioritization.

---

## Learner / Correction Matrix

### ~~Weight corrections by irradiance level~~ ✅ Done
Implemented in `src/learner.js`. Each correction sample is now weighted by
`irr / (irr + 50)` (half-saturation at 50 W/m²). The `correction_matrix` table
gained a `total_weight` column. Weighted running average replaces the old
equal-weight formula.

### Use cloud cover forecast to further discount overcast corrections
The irradiance weighting above already handles most of the problem. A further
refinement: fetch actual cloud cover % from Open-Meteo alongside irradiance and
multiply it into the weight: `weight = irr/(irr+50) × (1 - cloud_cover/100)`.
This would penalise patchy-cloud hours where irradiance is moderate but
production is unpredictable.

**Note:** irradiance weighting alone may be sufficient — evaluate after a few
weeks of weighted data before adding cloud cover.

---

## Battery Optimizer

### Savings metric is misleading when battery is nearly empty
When SOC is low the optimizer must charge heavily before it can discharge.
The 24 h savings figure includes that charging cost but may not include enough
high-price discharge hours to recover it, producing a negative number even when
the strategy is correct. Options: extend the planning horizon beyond 24 h, or
show a "steady-state" savings estimate that assumes a typical starting SOC.

### Overlay actual SOC on the history chart
The last-24 h chart currently shows *planned* SOC from the schedule. Overlaying
the actual SOC read from the inverter (already stored via `getState` during
`executePipeline`) would show whether the inverter is actually following the plan
and make deviations immediately visible.

---

## Reliability / Operations

### Health-check endpoint and alerting
If pipelines stop running (e.g. inverter unreachable, cron skipped) there is
currently no notification. Ideas: a `/health` endpoint that returns last-run
timestamps for each pipeline, plus an alert (email, Pushover, etc.) if any
pipeline has not run within its expected interval.

### Backfill consumption from snapshots after a gap
When the scheduler was down for several hours the consumption readings could not
be recovered even though energy snapshots exist. A backfill utility that replays
snapshot deltas for any gap in `consumption_readings` would make restarts less
lossy.

### Consumption delta accuracy when a snapshot is missing on the hour boundary
If the snapshot pipeline misses the exact top-of-hour snapshot (e.g. the 19:00
slot was absent, so the 20:05 consumption job used the 18:45 snapshot), the
computed delta spans 75 min instead of 60 min. The consumption pipeline should
log a warning when the nearest snapshot is more than ~10 min from the expected
boundary, and optionally interpolate.

---

## Dashboard

### Remote access with basic authentication
The dashboard is currently only reachable on localhost. If the user wants to
monitor from a phone or another machine, Express could serve it behind HTTP basic
auth (username + password in config) to avoid exposing data publicly.

### Show correction matrix heatmap
A month × hour heatmap of the correction matrix would make it easy to see which
hours are well-learned vs still at the default 1.0, and spot suspicious outliers
(e.g. cloudy-day noise at low-irradiance hours).
