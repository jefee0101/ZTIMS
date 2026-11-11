# Prioritized gaps

Proposal, 12 November 2026. What cannot be shown honestly yet, in the order it blocks the analytics. **P0** stops the core picture, **P1** limits it, **P2** is a known limit. Evidence comes from the repository and a read-only check of the live project.

| ID | Priority | Gap | Affects |
|---|---|---|---|
| G1 | P0 | Live holds no 2026 reporting data yet | Every analytic except the 2025 baseline. |
| G2 | P0 | Manager-run attractions have no way to report visitors | T1, T2, T3, T6, T7, T8, T9: attraction totals cover office-run places only. |
| G3 | P0 | The scope of the 2025 municipal totals is not confirmed | A1, A2, A5, A6, A7. |
| G4 | P1 | Counts-only rule against shares and percentage change | A6, A7, T5, T8, T9, X2. |
| G5 | P1 | No attraction history, and one year of accommodation history | A5, A6, T4, T5. |
| G6 | P1 | Residence and sex are optional at attractions and absent for 2025 | A8, T8, T9, X2. |
| G7 | P1 | Residence detail is coarse | A7, T8. |
| G8 | P1 | Occupancy needs inputs that are not there yet | A4. |
| G9 | P1 | There is no verified way to count unique tourists | X4, N1. |
| G10 | P2 | No purpose of visit, age group, group size or same-day versus overnight | N3. |
| G11 | P2 | Tickets cannot stand in for visits | T11. |
| G12 | P2 | The barangay is where the place is, not where the visitor lives | A14, T7. |
| G13 | P2 | There is no holiday or fiesta calendar | T10. |
| G14 | P2 | Official figures arrive after the month ends | All monthly analytics. |
| G15 | P1 | Small numbers can identify a place or a guest | A7, A14, T7, manager benchmark. |
| G16 | P2 | Revenue is outside the statistics by the office's decision | N2. |
| G17 | P2 | Attractions have no capacity figure | T12 (visits per open day is a mean, not a utilization). |
| G18 | P1 | Most attractions are not counted at all | Every attraction analytic: coverage is at most 2 of 8 places. |

## G1 · Live holds no 2026 reporting data yet (P0)

- **Evidence:** Read-only check of live on 12 Nov 2026: 0 stays, 0 accommodation versions, 0 rooms, 0 Support Staff, 0 bookings, 0 reviews. The attraction tables are not on live (the stage 4 schema has not been run).
- **What closes it:** Roll out the accommodation and attraction work (needs the user's approval), then onboard enterprises and Support Staff.
- **Owner:** User and Tourism Office
- **Affects:** Every analytic except the 2025 baseline.

## G2 · Manager-run attractions have no way to report visitors (P0)

- **Evidence:** statistics.js refuses the monthly report and Guest Register of every place that is not a place to stay (409 USE_DAILY_RECORD), and attraction-visits.js serves office-run attractions only.
- **What closes it:** Decide whether enterprise managers get the Daily Visitor Record for their own attractions, or stay out of the statistics.
- **Owner:** User
- **Affects:** T1, T2, T3, T6, T7, T8, T9: attraction totals cover office-run places only.

## G3 · The scope of the 2025 municipal totals is not confirmed (P0)

- **Evidence:** 12 monthly totals, loaded by import: arrivals by 72 residence rows, rooms, room-nights occupied and guest nights, no place and no sex. Rooms and nights are accommodation measures, but the arrivals' scope is not stated.
- **What closes it:** The office confirms whether the 2025 Form A4 covers places to stay only. Until then it is shown as its own series, never added to 2026 sums and never called attraction visits.
- **Owner:** Tourism Office
- **Affects:** A1, A2, A5, A6, A7.

## G4 · Counts-only rule against shares and percentage change (P1)

- **Evidence:** The statistics policy allows rates and shares only where the DAE-1A, DAE-1B and FORM A templates need them (private places to stay). accommodation-engine.js already has occupancyRate, averageLengthOfStay, ratio and percentDifference.
- **What closes it:** Decide: allow shares and percentage change in analytics (everywhere, or places to stay only), or keep counts only. The prototype shows counts and hides shares behind a switch.
- **Owner:** User and Tourism Office
- **Affects:** A6, A7, T5, T8, T9, X2.

## G5 · No attraction history, and one year of accommodation history (P1)

- **Evidence:** Live has 2025 totals only, and nothing for attractions. A season or a year-on-year change needs two full years.
- **What closes it:** Time (first like-for-like attraction year is 2027), or import paper counts the office may hold.
- **Owner:** Tourism Office
- **Affects:** A5, A6, T4, T5.

## G6 · Residence and sex are optional at attractions and absent for 2025 (P1)

- **Evidence:** attraction_daily_counts keeps completeness flags; 2025 rows have total_unsplit and no male or female.
- **What closes it:** Show 'not recorded' on every breakdown; the office may set a target for completeness.
- **Owner:** Tourism Office
- **Affects:** A8, T8, T9, X2.

## G7 · Residence detail is coarse (P1)

- **Evidence:** Attractions record four classes (Zamboanguita, rest of Negros Oriental, other Philippine provinces, foreign) with no foreign country. Places to stay record one row for Filipino nationality, with no province.
- **What closes it:** Decide whether more classes or the foreign country at attractions are worth the extra counting time.
- **Owner:** Tourism Office
- **Affects:** A7, T8.

## G8 · Occupancy needs inputs that are not there yet (P1)

- **Evidence:** Live has 0 accommodation rooms and 0 accommodation profiles. The 2025 totals hold rooms and room-nights occupied but not room-nights available.
- **What closes it:** Managers set up their rooms and reporting start; for 2025 only occupied room-nights can be shown.
- **Owner:** Enterprise Managers
- **Affects:** A4.

## G9 · There is no verified way to count unique tourists (P1)

- **Evidence:** No identifier joins a guest to a visit. Arrivals count a guest once at each place; visits count each entry. The system stores no personal identity for these counts, by design.
- **What closes it:** Not planned. Arrivals and visits are shown side by side and never combined.
- **Owner:** —
- **Affects:** X4, N1.

## G10 · No purpose of visit, age group, group size or same-day versus overnight (P2)

- **Evidence:** Not collected at attractions. Tickets hold regular, student and child counts, but online payment is a demonstration and a ticket is not a visit. The VAR 3M title says 'Same Day Visitors'; ZTIMS does not claim it (decision D4).
- **What closes it:** New optional fields at the point of counting, if the office wants them.
- **Owner:** Tourism Office
- **Affects:** N3.

## G11 · Tickets cannot stand in for visits (P2)

- **Evidence:** Live has 0 tickets. The statistics rule is 'nothing from tickets': counts come from what each place records.
- **What closes it:** None needed. Ticket counts may later appear as an advance-interest signal only, after a decision.
- **Owner:** User
- **Affects:** T11.

## G12 · The barangay is where the place is, not where the visitor lives (P2)

- **Evidence:** spots.barangay on all 18 published places (8 barangays used). Visitor origin is held as residence classes and countries only.
- **What closes it:** Label every barangay chart 'by location of the place'.
- **Owner:** —
- **Affects:** A14, T7.

## G13 · There is no holiday or fiesta calendar (P2)

- **Evidence:** The announcements table (events, closures) exists but holds 0 rows on live.
- **What closes it:** The office posts events as announcements; the overlay reads them. No cause is claimed.
- **Owner:** Tourism Office
- **Affects:** T10.

## G14 · Official figures arrive after the month ends (P2)

- **Evidence:** A month is submitted after it ends and counts in the official view only once the officer finalizes it. The 5th of the next month is a ZTIMS target, not an official deadline.
- **What closes it:** Offer the labeled operational view beside the official one.
- **Owner:** —
- **Affects:** All monthly analytics.

## G15 · Small numbers can identify a place or a guest (P1)

- **Evidence:** On live, each of the 7 barangays with an attraction holds one or two, and Poblacion holds 7 of the 10 places to stay. A rare nationality at one small place can point to a guest.
- **What closes it:** Decide a minimum group size for benchmarks and for enterprise-level nationality cells.
- **Owner:** User and Tourism Office
- **Affects:** A7, A14, T7, manager benchmark.

## G16 · Revenue is outside the statistics by the office's decision (P2)

- **Evidence:** bookings.total_amount and payments exist, and statistics hold counts and totals only.
- **What closes it:** None, unless the office changes its decision.
- **Owner:** Tourism Office
- **Affects:** N2.

## G17 · Attractions have no capacity figure (P2)

- **Evidence:** No capacity or carrying-capacity field exists on spots or attraction_settings.
- **What closes it:** Add an optional capacity only if the office wants utilization.
- **Owner:** Tourism Office
- **Affects:** T12 (visits per open day is a mean, not a utilization).

## G18 · Most attractions are not counted at all (P1)

- **Evidence:** Live: 6 of 8 published attractions have Count visitors here off, 2 are counting, and 0 Support Staff accounts exist. Private attractions are covered by G2.
- **What closes it:** The office decides which attractions count and adds Support Staff to each.
- **Owner:** Tourism Office
- **Affects:** Every attraction analytic: coverage is at most 2 of 8 places.

## Decisions needed to move on

- **D-A1** Allow shares and percentage change in analytics, and where (G4).
- **D-A2** Confirm what the 2025 municipal totals cover (G3).
- **D-A3** Give enterprise managers the Daily Visitor Record for their own attractions, or leave them out (G2).
- **D-A4** Official (finalized) figures are the default on every dashboard and the operational view is always labeled.
- **D-A5** Set a minimum group size for benchmarks and for nationality cells (G15).
- **D-A6** Officer sees monthly versions only; stay-level detail (A9, A10) stays with the manager.
- **D-A7** Show saves and ratings (T11) beside the counted visits, never added to them.
- **D-A8** Overlay office-posted events and closures on the daily chart (T10).
