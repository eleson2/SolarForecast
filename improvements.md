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

---

## Learner / Correction Matrix (continued)

### Make all correction factors adaptive (time-decay)

**Context:** The matrix is indexed by `month × day × hour`, so within-year
seasonal effects are already handled by structure — Feb 24 h12 only learns from
Feb 24 h12 readings. What "adaptive" needs to solve is **cross-year drift**:
panel degradation (~0.5%/yr), a tree that grew and now shades a specific hour,
a new neighbouring building. An infinite running average resists these changes.

**Proposed approach: exponential time decay on the weighted average**

`last_updated` is already stored in the schema. When a new sample arrives,
decay the existing accumulated weight before blending in the new sample:

```
days_since       = now − last_updated
decay            = exp(−days_since / τ)        # τ = configurable half-life
new_total_weight = decay × old_total_weight + new_irr_weight
new_avg          = (decay × old_avg × old_total_weight
                    + new_correction × new_irr_weight) / new_total_weight
```

With τ = 365 days:
- 1-year-old data retains 37% of its original weight
- 2-year-old data retains 14%
- Cells not seen recently degrade gracefully — they keep their last value but
  new data quickly dominates when the season returns

**Sudden-change detection (secondary mechanism)**

Decay alone is too slow for step changes (panel replaced, obstruction removed).
Add a regime-change heuristic: if a new high-confidence sample (irr weight > 0.7)
deviates from the running average by more than a factor of 2 in either direction,
treat it as a possible regime change — multiply `total_weight` by e.g. 0.1
before applying the update, letting the new data take over quickly.

**Implementation notes**
- No schema change needed (`last_updated` and `total_weight` already exist)
- Add τ (half-life days) and regime-change threshold to `config.js`
- Suggested defaults: τ = 365 days, regime threshold = 2.0×
- **Prerequisite:** needs at least 6–12 months of data before time decay is
  meaningful; implement when year-over-year comparisons become possible
