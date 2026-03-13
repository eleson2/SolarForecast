# Optimizer Observations & Reflections

A running log of noteworthy optimizer decisions, anomalies, and behavioral patterns.
Intended for periodic review to validate that the LP is behaving correctly across diverse
price curves, seasons, and edge cases.

Format: date, observation, verdict (correct / sub-optimal / bug).

---

## 2026-03-13

### Intraday solar scalar anomaly — watch list
**Context:** Scheduler at 17:30. Today's actual solar was 6.4× the forecast (640%).
Scalar clamped to maximum 2.00.
**Observation:** Cloud cover forecast for tomorrow is 100%, yet the inflated scalar (2.00) is
being applied, doubling the already cloud-suppressed solar estimates (~65–432W → ~130–864W).
**Risk:** If the anomalous ratio persists for several days of genuine overcast, the optimizer
will slightly overestimate available solar, potentially under-charging from the grid.
**Verdict:** No action now — the 2.00 clamp and cloud suppression limit the blast radius.
Revisit if solar actuals continue to diverge from forecast by >3× for more than 3–4 days.

---
