# Accommodation reporting, stage 2: data model, calculations, rollout

Built on the approved mockup and `01-field-and-calculation-mapping.md`. The changes are on the branch `claude/wizardly-dijkstra-ssze0r` only. Nothing was applied to the live database and nothing was deployed. The live database was read, never written.

## 1. What the live database holds (read-only check, 11 November 2026)

| Item | Live |
|---|---|
| `monthly_reports` | 12 rows, all `municipal_total` 2025, locked, `submitted_by_role = import` |
| `monthly_report_counts` | 321 rows, every one `total_unsplit` (no sex split) |
| `report_changes` | 12 rows, `created` |
| Per-place accommodation reports, `register_entries`, `bookings`, `room_types` | 0 rows each |
| Places to stay | 10 private (each with a manager); office places to stay: none |
| Manager accounts / listings / photos / visitors | 14 / 18 / 187 / 1. None are touched by this change |
| `btree_gist` | available, not installed. The schema installs it in `extensions` |

The 2025 import was rebuilt locally from `db/form-a4-2025.json` and matches live: 12 months, 321 rows, the same monthly totals (1,861 … 2,403; rows 19,298, printed 19,308).

**Drift found and repaired (at the user's request, in this change).** Live's seven booking tables are an early draft of the design, all empty (0 rows):
- `bookings` has no `requested_at`, which `bookings.js` uses for expiry and the reminder, so room booking would fail on live once used;
- `bookings.country_code` is nullable and `expires_at` is not;
- `room_types.beds` is text;
- the length, rate and guest limits are older, and a few defaults and indexes differ.

`create table if not exists` never corrects an existing table. A guarded block before the booking tables in `schema.sql` handles this:
- **When:** the draft is detected (no `requested_at`, or text `beds`) **and all seven tables are empty**.
- **What it does:** drops the seven tables, which are then recreated exactly as defined.
- **Foreign keys:** a block at the end restores the keys from `register_entries`, `reviews` and `accommodation_stays` that the cascade removes.
- **If any of the seven tables has a row:** nothing is dropped and a notice says so.

Tested on a local copy of live's exact draft, rebuilt from live's column, check and index definitions:
- after two runs, the seven tables match a fresh build exactly (columns, types, defaults, checks, indexes, foreign keys);
- the second run does nothing;
- with one row in `room_types`, the tables are left untouched with the notice;
- the room-booking suite passes 56 checks on the repaired tables, including expiry and the halfway reminder.

Its 6 failures come from later decisions, not the schema:
- the country comes from the visitor's account since 9 November; two failures follow from that test's extra booking;
- the old register entry from a booking is now refused, see §6;
- the public code-and-email lookup was removed on 9 November.

**Rule followed:** dropping only empty tables deletes no data. It is still a production schema operation, and it runs only when the user re-runs `schema.sql` in the rollout.

## 2. The model (`db/schema.sql`, block "Accommodation reporting")

One authoritative record per stay. The DAE-1A, DAE-1B, annual summary and FORM A are all worked out from it.

| Table | Holds | Key rules |
|---|---|---|
| `accommodation_profiles` | DAE-1B header facts, month reporting starts | Only a private place to stay |
| `accommodation_rooms` | Numbered rooms, `available_from` / `available_until`, `shared` (dormitory) | Number unique per enterprise (case-insensitive); never deleted |
| `accommodation_room_unavailability` | Out of service, inclusive dates | Voided with a reason, never deleted; dates never change |
| `accommodation_closed_periods` | Not operating, inclusive dates | Same |
| `accommodation_stays` | Check-in, check-out, `revision`, optional `booking_id` | `check_out > check_in`, ≤ 366 nights; void, never delete |
| `accommodation_stay_rooms` | Room per night range `[starts, ends)` | **Exclusion constraint**: a private room cannot hold two active stays on one night. Shared rooms may |
| `accommodation_stay_guests` | Residence, male, female, `[starts, ends)` | A row starting later is a guest who joined, an arrival that day. A row ending earlier is a guest who left |
| `accommodation_report_versions` (+ `_counts`) | A submitted month: figures, provenance, source digest, reason, late | Immutable; numbered with no gaps; counts must add to `arrivals` |
| `accommodation_periods` | A finalized month | Only the officer finalizes or reopens |
| `accommodation_period_events` | submitted / finalized / reopened: version, actor role, email, time, reason | Immutable; reopen needs ≥ 10 characters |
| `accommodation_changes` | Every change to the records above: before, after, reason, affected months | Immutable |

**Held by the database, whatever calls it** (triggers, checked at commit where order matters):
- Every night of a stay has a room and a guest. Rooms and guests fall inside the stay. Someone arrives at check-in and someone leaves at check-out.
- A room is never used outside its availability, while out of service, or on a closed day. A room is never given twice to one stay on one night.
- **Finalized months do not move.** Every insert, update or void that reaches a finalized month of that enterprise is refused. This covers a stay's old and new dates, a room's availability change, out of service, closed periods and the reporting start.
- A version cannot be added to a finalized month. Its residence counts must add up to its arrivals.
- A month holding a 2025-style municipal total refuses enterprise versions, and a municipal total cannot be recorded for a month enterprises reported. **The two can never be counted for the same month.**
- Nothing in the new tables is deleted. Versions, their counts, events and changes refuse update and delete.
- Row Level Security is on with no policies, like every other table.

**Concurrency.** Each write runs in one transaction, holding a per-enterprise transaction lock (`pg_advisory_xact_lock`). This covers recording, editing, voiding, submitting, finalizing and reopening. The exclusion constraint guards room double-booking even without the lock. Two more guards:
- An edit must name the stay `revision` it read.
- A submit or finalize must name the latest version it saw.

Anything stale gets 409.

## 3. Calculations (`accommodation-engine.js`)

| Figure | Rule |
|---|---|
| Arrivals | A guest row's male + female on its `starts_on`; counted in that month |
| Guest-nights | For each date D with `starts_on ≤ D < ends_on`. The check-out night never counts |
| Rooms occupied (room-nights) | For each date, the **distinct** rooms holding a guest. A shared room or a transfer never counts twice |
| Room-nights available | For each date: rooms available that day, minus rooms out of service; 0 on a closed day |
| Rooms (DAE-1A item 4) | Most rooms available on any day of the month |
| Occupancy, average length of stay, guests per room | The template ratios; null (not 0) when the denominator is 0 |
| A month still running | Nights through yesterday, arrivals through today (Manila). Submitted only after it ends; due the 5th, late marked |
| Annual (enterprise and FORM A) | Sums of the saved versions, then **ratios of the sums**. Never the mean of monthly rates. Months without a version contribute nothing and are listed as missing |

**Month states:** `municipal_total`, `future`, `finalized`, `reopened`, `submitted`, `changed` (the register differs from the latest version, with the differences listed), `not_operating`, `not_set_up`, `not_recorded` (before reporting starts), `open`, `due`, `overdue`. Missing is never zero.

**Corrections, reopening and versions:**
- A change to a stay returns every month it reaches (old and new dates) and each month's state.
- A month already submitted becomes `changed` with its differences listed. The officer cannot finalize it until the enterprise submits version n + 1 with a reason.
- A finalized month refuses the change. The officer reopens it with a reason, the enterprise corrects and submits again, and the officer finalizes again.
- Every earlier version stays exactly as saved; this was verified byte for byte. The latest version is the current one. The events table shows the full order with actor, time and reason.

**FORM A consolidation** (`GET /api/accommodation/form-a?year=`):
- Each month has one source: `municipal_total`, `enterprise_reports` or `none`.
- An enterprise month is **complete** when every listed private place to stay has a version or was not operating all month. Missing places are counted, never estimated.
- Rows come in `residences` order with section, continent and region, so the template's groups and row order stay intact.
- **Previous-year comparison** uses only months with complete coverage in both years. It is `null`, with a reason, when there is none. A row's % difference is `null` when its baseline is 0.
- 2025 has no sex split. Volume per sex lists those months as not recorded rather than showing zeros. Its room-nights available are rooms × days and are marked as derived.

## 4. What the preserved 2025 data can and cannot support

It can support:
- 2025 FORM A month by month and row by row;
- the 2025 Part II counts (rooms, room-nights occupied, guest-nights);
- the 2025 annual occupancy and length of stay, as ratios of sums;
- the baseline for 2026 % differences, in months where 2026 coverage is complete.

It cannot support:
- any per-enterprise figure;
- any male / female split;
- daily figures or room-nights available as reported. Available is derived from the monthly room count × days, which assumes every room was open every day.

The printed March total (1,568) is 10 above its rows; the rows are kept.

## 5. Migration and backfill

- **2025 municipal totals:** untouched. Only a guard trigger is added to `monthly_reports`; it refuses new municipal totals for months enterprises reported.
- **Hand-typed accommodation monthly reports:** copied once each into version 1 with provenance `legacy_manual`, together with their counts and, if locked, the finalized period. Nothing is invented behind them, and no difference is computed against stays. Live has none, so this does nothing on live.
- **Old Guest Register entries** for places to stay are not converted, because they have no room identities. Live has none. They stay readable.
- **Office-run places to stay and attractions:** unchanged.
- **Old routes:** for a private place to stay, the hand-typed monthly report (`PUT /api/statistics/reports/...`) and the old Guest Register writes now answer 409 `USE_STAY_REGISTER`. Attractions keep every route as before.

## 6. Impact on routes, pages and exports

| Area | Impact |
|---|---|
| New API, `/api/accommodation/*` | See the table below |
| `statistics.js` | Private places to stay refused on three write routes (409). `/form-a4` and `/form-a4.xlsx` (the Arrivals Report) read each private place to stay's latest saved version instead of `monthly_reports` (stage 3), so the stay register feeds them once. Attraction routes and `/tracker` are unchanged |
| `server.js` | Mounts `accommodation.js`. Stage 3: the JSON body reader's refusals answer 413 (too large) and 400 (unreadable) instead of 500 |
| Manager pages | **Built (stage 3).** For a private place to stay, `resort_register.html` mounts the stay register (`acc-register.js`) and `resort_statistics.html` the DAE-1B, versions and year (`acc-report.js`); `resort_rooms.html#numbers` and `resort_spots.html#reporting` hold room numbers, out of service, the profile and closed periods (`acc-setup.js`). Attractions keep their pages |
| Officer pages | **Built (stage 3).** `admin_statistics.html`: Tracker → Places to stay uses `/accommodation/tracker`; a cell opens the month (Finalize, Reopen, versions, history, Excel) on Enter a report; a new FORM A tab (coverage, Part I/II, comparison, volume per sex, Excel) (`acc-officer.js`). Arrivals Report and the attraction tracker unchanged |
| Exports | **Built (stage 3)**, `accommodation-excel.js`; see §6a |
| Bookings | A stay may carry `booking_id` (unique); the booking itself never counts. **Changed:** at check-in, the manager's Bookings page posts the booking's `registerDraft` to the old Guest Register, which now answers 409 for a place to stay. **Done (stage 3):** Check in opens `resort_register.html?booking=<id>`, the stay form prefilled from the booking (`POST /api/accommodation/:spotId/stays` with `bookingId`) |
| Booking tables | The early-draft repair in §1 runs with `schema.sql`; it only acts while the seven tables are empty |

New routes (manager = own enterprises only; officer = read all, finalize, reopen):

```
GET  /api/accommodation/:spotId/profile            PUT  .../profile                         (manager)
GET  /api/accommodation/:spotId/rooms              POST .../rooms; PATCH /api/accommodation/rooms/:id
POST /api/accommodation/:spotId/out-of-service     POST /api/accommodation/out-of-service/:id/void
POST /api/accommodation/:spotId/closed-periods     POST /api/accommodation/closed-periods/:id/void
GET  /api/accommodation/:spotId/stays?month=       POST .../stays
GET  /api/accommodation/stays/:id                  PUT  /api/accommodation/stays/:id {revision, reason}
POST /api/accommodation/stays/:id/void {revision, reason}
GET  /api/accommodation/:spotId/months/:y/:m       POST .../submit {expectedVersion, reason}
POST .../finalize {expectedVersion}  (officer)     POST .../reopen {reason ≥ 10}            (officer)
GET  /api/accommodation/versions/:id               GET  /api/accommodation/:spotId/year/:y
GET  /api/accommodation/tracker?year=  (officer)   GET  /api/accommodation/form-a?year=      (officer)
GET  /api/accommodation/:spotId/months/:y/:m/export.xlsx?version=n|latest|current
GET  /api/accommodation/:spotId/year/:y/export.xlsx GET  /api/accommodation/form-a.xlsx?year= (officer)
GET  /api/accommodation/templates/dae1a.xlsx|dae1b.xlsx|form-a.xlsx   (blank)
```

### 6a. Excel exports (stage 3)

Rebuilt from the four supplied PDFs (DAE-1A; DAE-1B v4a, daily; DAE-1B 2019 manual, monthly; FORM A). Kept: headings and their wording, country order and grouping, the PDFs' colours (yellow `FFFF00`, blue `0070C0`, light blue `00B0F0`, green `92D050`, sage `D8E4BC`, orange `FFC000` on FORM A's % columns), borders, merged headings, signature lines, units, A4 print set-up and the page breaks (FORM A and the monthly DAE-1B after the Middle East subtotal and after Australasia; the daily DAE-1B after South Asia and after Eastern Europe).

Not reproduced: the PDFs' example records, their `#DIV/0!` cells, and any claim to their original formulas or workbook metadata. The formulas are ZTIMS's own: a total is blank when nothing in its range is reported (`IF(COUNT(r)=0,"",SUM(r))`), and a rate shows "n/a" when its divisor is blank or 0. Missing stays blank; a reported 0 is 0.

Template adjustments (the forms do not fix these):
- **Rooms.** DAE-1A has one column per numbered room the enterprise had that month (the sample has 15); it stays on one A4 page, landscape above 18 rooms. "x" marks a room held by a party with several rooms that night, whose guests are counted in (6), not split by room; check-in cells are yellow, closed days grey.
- **Days.** 28, 29, 30 or 31 day rows, by the month (leap years included).
- **Residences.** ZTIMS keeps Form A4's 72 rows. On the 2019 layout, Macau, Oman, Qatar, Andorra and Turkey go to "Others and unspecified non-Philippine residences", Israel to the Middle East, and the Serbia and Montenegro row stays blank.
- **Status line.** Each month export names its version and submission date, or says "NOT SUBMITTED: worked out from the stay register on …".
- **FORM A.** Previous-year and % difference columns use only the comparable months, named in a note; paper months give rooms, so their available room-nights are rooms × days and marked derived.
- The DAE-1B footnote adds "and Former Filipinos" as in v4a.

Checks: every export recalculates in LibreOffice with 0 errors; `tests/reconcile-exports.py` compares every figure with its saved version (36 checks); a leap February 2028 with 20 rooms was rendered (29 rows, totals 32 / 386 / 193 as built, DAE-1A on one page).

## 7. Verification (local, real API calls and SQL)

`schema.sql`:
- on the local development database, ran twice, then a third time over test data;
- on a fresh database built from `main`'s schema, with live's drift reproduced and the 2025 import, ran twice.

The 2025 rows hashed identically before and after.

The API suite passed **104 of 104 checks**. Figures were compared with an independent oracle that loops over the stays. Covered:

- **Arithmetic and arrivals**
  - Aug, Sep and Oct arithmetic.
  - A family arriving 29 Oct and transferred on 1 Nov: one arrival in October, nights split, one room a night.
  - A shared dormitory: two parties, one room-night per night.
  - A guest joining on 4 Oct counted as an arrival that day; a guest leaving on 5 Oct.
  - October available = 7 × 31 − 5 out-of-service nights.
- **Month states**
  - July closed: not operating.
  - June: before reporting.
  - November: through yesterday, not submittable.
- **Refusals**
  - A room taken, out of service, or on a closed day.
  - A future check-in, a night without a room, no arrival at check-in.
  - Fractional or negative counts, an unknown residence.
  - Another enterprise's room.
  - The officer writing, or another manager writing or reading.
- **Concurrency**
  - Two simultaneous requests for one room: exactly one wins.
  - Two simultaneous submissions: exactly one version.
  - A stale stay edit: refused.
- **Finalize, correct, reopen**
  - Finalized September refuses stay edits, voids, out-of-service, room availability changes and a back-dated room, both through the API and directly in SQL.
  - A version cannot be updated or deleted; events cannot be deleted.
  - A version whose counts do not add up is refused.
  - A correction across Oct and Nov names both months. October becomes `changed`, Finalize is refused until v2, and v1 stays unchanged.
  - Reopen needs a reason. After reopening, Finalize waits for a new version; a stay reaching a still-finalized October is refused and names October.
  - September's history reads: submitted > finalized > reopened (reason) > submitted (reason) > finalized.
  - No name, email or phone appears in any change record.
- **Annual and FORM A**
  - Annual occupancy is the ratio of sums. The test confirms it differs from the mean of monthly rates.
  - FORM A 2025: 19,298 arrivals from 12 municipal months; no comparison without 2024; volume per sex not recorded; available room-nights marked derived; rows in the form's order.
  - FORM A 2026: incomplete coverage means no comparison. With every other enterprise closed for August, only August is compared, with Filipino residents against 888 in August 2025. A zero baseline gives `null`.
  - A municipal total and enterprise versions cannot coexist for a month, in either direction.
- **Unchanged areas**
  - Old routes refuse places to stay.
  - An attraction report (officer backup) still saves.
  - The old Form A4 and attraction tracker still answer.

Rollback (`rollback.sql`) was run on the live-shaped database:
- it left the 2025 data identical;
- it is re-runnable;
- the schema reapplied cleanly after it.

## 7a. Security review (stage 3)

Checked with `tests/security-checks.js` (41 checks, local API and database) and a browser pass. Findings and fixes:

| Finding | Fix |
|---|---|
| A month with no stays exported "NaN" as its occupancy, and zero subtotals as blank: exceljs's `cell.value` drops a cached result of 0 | Totals are kept as computed and read through `cell.result` (`cellNumber`) |
| A body over 1 MB answered 500 | The error handler answers 413 (and 400 for unreadable JSON), for every route |
| Editing a stay checked the reason before ownership (a 400 to another enterprise, with no data) | Ownership is checked first |
| A stay in a finalized month offered Edit, Transfer, Change check-out and Void (the server refused them) | The stay opens locked, naming the finalized months |

What holds (each with a test): tourists, Support Staff and anonymous callers get 401/403 on all 21 accommodation routes; another manager gets 403/404 on every read, export and write of an enterprise not theirs, including ids taken from it (stays, rooms, versions, out-of-service, closed periods) and a stay of their own pointing at another enterprise's room; managers get 403 on the tracker, FORM A and its Excel, Finalize and Reopen; the officer cannot write rooms or stays; a finalized month refuses out of service, closed periods, a room retired or added, a stay reaching it and voiding out of service, through the API and through SQL (triggers), and saved versions refuse update and delete; odd ids are plain not-found; negative or unknown counts, over-long stays and oversized bodies are refused; six submits at once save one version, four finalizes give one event, four stays for the same room and night save one, two edits of one revision give one change and one "reload"; names starting `=`, `+`, `-` or `@` land in Excel as text; no email address appears in an export; markup typed into a room label or a reason shows as text on the pages.

Not separately exploitable, noted: every query is parameterized (table names come from a fixed list). CSRF: staff sign-in is a Bearer token in the `Authorization` header, never a cookie, and exports are fetched with that header; a cross-site form or link carries no credential, so classic CSRF does not apply. CORS is not used as authorization: every route checks the token, the role and the enterprise (`placeFor`). RLS stays on with no policies; no grants or `SECURITY DEFINER` functions were added. Exports carry counts and room numbers only, no guest names or contact details.

Remaining risks: the token lives in `localStorage`, so an XSS on a staff page would expose it (pages escape every stored text and the CSP limits scripts, but this is not proof against every XSS); the blanket per-request rate limit is per serverless instance; the void routes check the reason's length before ownership (a 400 that reveals nothing); the system is not claimed to be free of vulnerabilities.

## 8. Remaining semantic uncertainty

1. **Check-out night** (DAE-1A says guests count "until the day he checks out"). Built as not counted.
2. **Room-nights available** deduct out-of-service rooms. The templates do not define "available".
3. **"Rooms" (DAE-1A item 4)** is taken as the most rooms available on any day of the month. The templates do not say what to report when the count changes mid-month.
4. **Coverage** counts every currently listed private place to stay as expected in every month. A place that opened later must record the earlier months as a closed period, or those months stay incomplete. Listing dates were not used: the live `created_at` reflects the database move, not opening.
5. **The 2025 baseline is municipal and unsplit.** A 2026 month is comparable only when every listed enterprise reported or was closed, so comparisons will be rare until coverage is full. This is deliberate, not a defect.
6. **Region label, country list mapping, and removing the officer's backup entry** for accommodation reports remain open from stage 1. The officer's backup entry is already refused for private places to stay, which were never the officer's to enter; office-run places to stay are unchanged.
7. The DOT-JICA manual and PSA sources are still unverified (hosts unreachable).

## 9. Rollout (each step needs the user's yes)

1. ~~Build the stay-register and report pages~~ Done (stage 3).
2. ~~Run on the branch: checks, build, server load, the API, security and export suites, a browser pass~~ Done (stage 3; see §6a and §7a).
3. **Back up live before anything else:**
   - In the Supabase SQL Editor, export `monthly_reports`, `monthly_report_counts` and `report_changes` as CSV.
   - Confirm the project's daily backup is recent (Dashboard → Database → Backups).
   - Record the 2025 hash (query in §7).
4. Push to `main` (fast-forward). Vercel deploys the code. The new routes will not run until the next step: before then, the `accommodation_*` tables they use do not exist, and the 409 guard on old routes is code only.
5. Just before running it, confirm the seven booking tables are still empty: `select count(*) from bookings` and the same for the other six. If any has rows, stop and ask the user, because the draft repair would then leave them unrepaired. In the Supabase SQL Editor, run `zamboanguita-backend/db/schema.sql` once. Expect the notice "Early-draft booking tables were empty: dropped, recreated below". Then:
   - check that the `accommodation_*` tables exist;
   - check `select count(*) from accommodation_report_versions` = 0;
   - check that `bookings.requested_at` exists and `room_types.beds` is an integer;
   - check that the 2025 hash is unchanged.
6. Redeploy or confirm, then smoke-test with a manager's real enterprise: profile, one room, one stay, the month view. Void the test stay with a reason.
7. **If something is wrong:** revert the commit on `main` and redeploy. Then, after exporting the `accommodation_*` tables, run `rollback.sql` (this drops what managers recorded since the rollout, so it needs the user's yes).
