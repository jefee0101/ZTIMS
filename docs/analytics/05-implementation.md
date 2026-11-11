# Analytics: what was built (server side)

12 November 2026, on the branch `claude/wizardly-dijkstra-ssze0r`. Built and tested on a local database only. Nothing on live Supabase was changed, nothing was pushed or deployed, and no schema change was needed.

This is the server half of the approved design (`03-role-dashboards-and-data-flow.md`): the calculations and the read-only API. The dashboard pages that will draw them are not built yet.

## 1. Data flow

```
Authoritative records                          analytics.js (read only)                 Readers
------------------------------------------     -------------------------------------    ------------------------------
accommodation_report_versions (+ _counts)  ->  accommodationMonths()  -+                 /api/analytics/accommodation
accommodation_periods (finalized version)                              |                 /accommodation/places
accommodation_profiles, _closed_periods                                +-> analytics-    /accommodation/benchmark (mgr)
monthly_reports municipal_total (2025)     ->  municipalBaseline()     |   engine.js     /accommodation/stays (mgr)
accommodation_stays / _stay_guests         ->  stays route (manager)   |   (periods,     /attractions, /attractions/places
attraction_daily_counts, versions, periods ->  attraction-visits.js    |   peak/low,     /attractions/daily
                                               sources.yearSources()  -+   comparison,   /reservations, /coverage
bookings, booking_rooms                    ->  reservations route          coverage)     /:domain/export.xlsx
spots (+ spot_more_categories)             ->  scope and filters
```

- **One computation.** Every card, chart, table and Excel cell comes from the same functions. The Excel export calls the very function the JSON route calls.
- **Same sources as the forms.** For attractions, analytics reads `yearSources` from `attraction-visits.js` (now exported as `module.exports.sources`), the function DTA2M and VAR 3M use. The choice of finalized, submitted or draft therefore cannot differ between a report and a chart. For accommodation, the version choice and coverage rules mirror FORM A (`municipalYear` in `accommodation.js`).
- **Computed on request.** No snapshot table, no schema change.

## 2. Calculation rules

| Rule | Where it holds |
|---|---|
| **Official** uses finalized versions only. **Operational** uses the latest saved version (accommodation), or finalized, then submitted, then draft (attractions, as `sourceFor`). Every result names its `mode`. | `accommodationMonths`, `ATT.yearSources` |
| One version per place and month, never two. A correction replaces its earlier version; it is never added to it. | Tested: September 2026 = 8 (v2), not 7 or 15 |
| A missing month is `null`, never 0. A confirmed zero (a report of 0) stays 0. | engine `accMonth`, `addAtt`, `addN` |
| Coverage is shown beside every period: expected, finalized, submitted, missing, not operating, before reporting (accommodation); expected, finalized, submitted, draft, not submitted, no staff (attractions). | `coverage` on every period |
| A period is `complete` only when every month in it is complete. Partial periods are flagged and never ranked as a peak or a low; the excluded ones are listed. | `toPeriods`, `peakLow` |
| Rates (occupancy, average length of stay) come from summed counts, never averaged, and only for private places to stay (the DAE definitions). | `accRates` |
| Comparisons with the previous year are differences in counts, only when both periods are complete, with a reason when not. No percentages (G4). | `compare` |
| Residence and sex stay unknown when not recorded: attraction classes are `null` when no residence was recorded; the unrecorded part is its own figure; sex is `null` when not recorded; sex by residence never exists. | `attMonthFigures` |
| The 2025 paper totals are a separate `baseline` series, shown only in the officer's unfiltered view, labeled as scope unconfirmed (G3). Never added to enterprise figures, never split by place, barangay or category, and no sex split is invented. | `municipalBaseline`, `baselineAdder` |
| Accommodation arrivals, attraction visits and room reservations are separate routes and results. Never added together, and no "unique tourists". | route layout |
| Reservations are room requests made through ZTIMS, by the month made: counts by status, room-nights reserved, lead time and answer time (medians). No prices, names or emails. | `/analytics/reservations` |
| Barangay is where the place is, not where visitors live. A place with several categories counts under each, so category values overlap and are never summed. | `breakdown` notes |
| Daily patterns (attractions, a manager's stays) use recorded days only. The weekday mean counts recorded days, and the 7-day average needs at least 3 recorded days. | `weekdayMeans`, `rolling7` |
| The manager's benchmark shows a municipal or barangay figure only when at least 3 places finalized that month (D-A5 default, G15). | `MIN_GROUP` |

Periods: month, quarter, year (`granularity`). Filters: `from`/`to` (months, at most 36; days, at most 366 for daily routes), `mode`, `barangay`, `category` (main or other categories), `spotId`, `bbox` (map rectangle), `compare=previous-year`.

## 3. Who reads what (enforced in the query, from the signed-in account)

| Route | Officer | Enterprise Manager | Support Staff | Visitor / none |
|---|---|---|---|---|
| accommodation, accommodation/places, reservations, export | all private places to stay | own enterprises only (403 for another's id) | 403 | 401 |
| accommodation/benchmark, accommodation/stays | 403 (stay detail is the manager's, D-A6) | own enterprise only | 403 | 401 |
| attractions, attractions/places, attractions/daily, export | all office attractions in reporting | 403 | own attraction only (403 for another's id) | 401 |
| coverage | yes | 403 | 403 | 401 |

Responses are `Cache-Control: no-store`. A shared rate limit applies: 300 reads per 15 minutes per account. Unknown query parameters, repeated parameters, bad dates, ranges that are too long and malformed ids are refused with 400. Every query is parameterized. Errors carry no SQL or stack.

## 4. Files

- `zamboanguita-backend/analytics-engine.js` (new): the arithmetic, no database.
- `zamboanguita-backend/analytics.js` (new): the routes, scope, filters and Excel.
- `zamboanguita-backend/attraction-visits.js`: the month-source helpers moved to module level and exported (`sources`). Behaviour is unchanged (149 checks still pass).
- `zamboanguita-backend/server.js`: mounts the router.
- `docs/analytics/tests/api-checks.js` (new): 129 checks.

## 5. Verification (local database, 12 November 2026)

- `docs/analytics/tests/api-checks.js`: **129 passed, 0 failed**. Expected values are computed from the raw tables with SQL, not by the code under test. Covered:
  - every analytic total against its records: finalized and latest versions, the 2025 paper total of 19,298 and December's 2,403, attraction daily counts against the finalized month (1,681), stay-register guest rows, bookings
  - no double counting: multi-version months, the paper-total months, barangay groups summing to places
  - missing shown as `null` and confirmed zero as 0
  - coverage and incomplete periods
  - quarters, filters and comparison
  - Excel cell by cell against the JSON
  - roles: no token, visitor token, the wrong role, another manager's or attraction's id
  - malformed and injected input; range bounds; response time
- Regression: attraction `api-checks.js` **149/149** (after the refactor), accommodation `api-checks.js` **104/104** and `security-checks.js` **41/41**, `npm run check`, `npm run build`, and the server loads.
- Not run this stage: the attraction browser suites (`page-flow*.js`, `page-security.js`); no page changed.

## 6. Security findings

- **Fixed in the design:**
  - the scope comes from the token's account, never from a parameter
  - a manager's or staff member's `spotId` is checked against their own places
  - the officer cannot read stay-level detail
  - the benchmark suppresses groups below 3 places, so another enterprise's figure cannot be worked out
  - no personal data in any result or export
  - typed text in Excel goes through `safeText` (no formula injection)
- **Residual:**
  - the blanket in-memory per-IP limit (150 per 15 minutes) still applies before the account limit. One office address shared by many users could reach it; this was noted earlier and is unchanged.
  - Two differences between two benchmark months could still hint at a single newcomer when the group is small but at least 3. The minimum group size needs the office's decision (G15).
  - Tokens of a deactivated Support Staff account are refused by `requireAuth` as everywhere else.

## 7. Unresolved limitations

1. **Live has no 2026 data** (G1). Live has no stays, no versions, no attraction tables and no Support Staff, so on live only the 2025 baseline would show today. The attraction schema must be rolled out first (stages 4 and 5).
2. Manager-run attractions cannot report visits (G2). They are counted in `/coverage`.
3. The scope of the 2025 paper totals is unconfirmed (G3). They are a separate baseline, and the comparison with them is marked `scopeUnconfirmed`.
4. No percentages or shares beyond the DAE rates (G4, needs a decision).
5. Minimum group size (G15) is set to 3 as a default.
6. Attraction sources are read per attraction per year (about five queries each). This is bounded (at most 200 attractions and a few years) and fast today (13 ms locally), but should be batched if the number of attractions grows.
7. Operational accommodation counts a `legacy_manual` version like any other latest version. The coverage band does not yet flag it separately.
8. No dashboard pages yet. The design's officer, manager and Support Staff views still need to be built on these routes.
