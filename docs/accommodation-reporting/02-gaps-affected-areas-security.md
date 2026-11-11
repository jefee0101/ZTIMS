# Accommodation reporting: gaps, affected areas, security and validation plan

Stage 1 (review only). Read with `01-field-and-calculation-mapping.md`. The mockup is the Artifact "ZTIMS Accommodation Reporting Mockup" (source copy in this folder, `mockup.html`).

## 1. Gaps and recommended defaults

| # | Gap | Recommended default | Who decides |
|---|---|---|---|
| G1 | Check-out night counted or not (C1) | Not counted | User, with the Tourism Office |
| G2 | Guests joining or leaving mid-stay | Separate stays | User |
| G3 | Day-use and same-day stays | Refused | User |
| G4 | Out-of-service nights in "rooms available" | Deducted | Tourism Office |
| G5 | When a month can be submitted | After it ends; due on the 5th of the next month | User |
| G6 | Region label on exports | Tourism Office states it. Negros Oriental is in the Negros Island Region from 2024 (unverified) | Tourism Office |
| G7 | Country list: 72 database rows vs the template's rows | Keep 72, map on export | Tourism Office |
| G8 | Overseas Filipino: country of residence | Not asked | User |
| G9 | Officer backup entry of a monthly report (exists today) | Remove, to match "no officer editing" | **User's yes needed** |
| G10 | Existing hand-typed reports for 2026 | Keep as they are; new design starts at a stated month per enterprise. No stays are invented for earlier months | User |
| G11 | Annual comparison for an incomplete year | Print the form as is, show a clear banner, offer "same months only" | User |
| G12 | Per-room guest counts for the DAE-1A grid | Off. Columns (5) to (7) do not need them | User |
| G13 | Sex of guests not stated | Not allowed (template has male and female only) | Tourism Office |
| G14 | DOT classification values and AE ID code format | Free text, optional | Tourism Office |
| G15 | Excel exports for DAE-1A, DAE-1B and FORM A reproducing the exact template labels | Needed in implementation; the mockup cannot download | — |
| G16 | Rebuilding the DOT-JICA manual and PSA checks | Allow `www.locjkt.or.id` and `www.psa.gov.ph` in the environment network settings | User |
| G17 | Retention of stay detail | Keep counts and dates; no personal data exists, so `privacy.js` needs no change for stays | — |

## 2. Affected system areas (for stage 2)

**Database (`db/schema.sql`, re-runnable, applied only after the code is on `main`)**
- New: `accommodation_rooms` (spot, number, type, beds, sleeps, available from, until), `room_out_of_service`, `closed_periods`, `stays`, `stay_room_periods` (stay, room, from, until), `stay_guest_groups` (stay, residence code, male, female), `stay_changes` (action, before/after, reason, role, date), `report_versions` (spot, year, month, version, figures, submitted by/at, reason), `report_events` (submitted, finalized, reopened with reason).
- Extended: `spots` statistical profile (reporting start, DOT classification, AE ID code); `monthly_reports` kept for 2025 imports and attractions.
- Constraints: no overlapping room periods for one room (exclusion constraint on a date range), check-out after check-in, male + female > 0 per group, one live version number per spot and month, `finalized` blocks writes through a trigger or the API check.
- The 2025 municipal totals (`monthly_reports` with `municipal_total`) stay untouched.

**API (`statistics.js`, `bookings.js`, `server.js`)**
- New stay, room, closed-period and version routes; generated DAE-1A and DAE-1B reads; officer Finalize and Reopen per enterprise-month.
- Changed: `registerTotals`, `formA4()` (accommodation only, adds percentages), lock logic, validation rules (remove the "guest nights but no guests" rule; add the new ones), the Excel builder (`statistics-excel.js`: template labels, region).
- Booking link: `register_entries.booking_id` becomes an optional prefill of a stay.

**Pages**
- Manager: `resort_spots.html` (statistical profile subpage), `resort_rooms.html` (numbered rooms, out of service, availability), `resort_register.html` (stays and DAE-1A), `resort_statistics.html` (DAE-1B month, versions, year), `stat-form.js`.
- Officer: `admin_statistics.html` (tracker, Arrivals Report as FORM A, Finalize and Reopen), `admin_analystic.html` dashboard cards that read the Form A4.
- Support Staff pages stay as they are (attractions).

**Documents**
- `CLAUDE.md` "Tourism statistics", "Support Staff" and standing constraints (percentages rule, accommodation-only arrivals, officer role); `docs/MANUSCRIPT-NOTES.md`; the notes repo (decisions, open items, session log); `docs/QUALITY-AND-TOOLS.md` if rate limits change.

## 3. Security and validation plan

**Authorization (server only)**
- Every stay, room and version route checks that the enterprise belongs to the signed-in manager (`managed_by`), else 403. Another manager's id returns 403, never 404 that leaks existence.
- Officer routes use `requireAdmin`; Finalize and Reopen also use `requirePasswordConfirmation` (same as other risky officer actions). The officer has no stay-write route (`mayKeepRegister` stays false for officers).
- Visitor and Support Staff tokens are refused on these routes (separate audiences and role checks).

**Integrity**
- Submitted versions are immutable: no update or delete route; a correction inserts version n + 1. A database rule or trigger blocks updates to `report_versions`.
- Finalize requires: a submitted version, the month ended, and no differences between the live figures and that version. The check runs on the server at the moment of Finalize.
- Reopen requires a reason of at least 10 characters, stored in `report_events` and shown to the manager.
- A finalized month locks stays that have an arrival or a night in it, closed periods, out-of-service periods and room availability dates in that month. The check is in one shared function used by every write route.
- Writes that take rooms lock the room rows (`for update`) and re-check conflicts in the same transaction, as `holdRooms` does for bookings.
- Overlap protection also as a database exclusion constraint, so a race cannot double-book a room.

**Input validation (server)**
- Dates are real calendar dates; check-in ≤ today (Manila time); check-out > check-in; stay length at most 366 nights.
- Counts are whole numbers, 0 to 999 per group, at least one guest; classes from a fixed list; country must exist in `residences` and is required only for non-Philippine residents; free text (reasons) trimmed and capped at 300 characters.
- Capacity is a warning, not an error.
- JSON body capped at 1 MB (existing). Lists capped (rooms 200 per enterprise, groups 20 per stay, room periods 20 per stay).

**Privacy**
- No name, phone, email, ID or free-text note about a guest in any statistical table. The change log stores roles, never names. Counts only reach the officer.
- Reports are never deleted; stays are corrected, not removed (a void with a reason, as reports do today).

**Abuse and audit**
- `sharedRateLimit` on stay writes (for example 120 an hour per account) and on Finalize and Reopen (10 per 15 minutes).
- Every create, edit, transfer, extension, void, submit, finalize and reopen is a row with before and after, role, date and reason.
- Server-side computation only. The page never sends totals; the server derives every figure and snapshot from the stays.

**Tests to run before any push (stage 2)**
- Engine against `registerTotals`: same inputs, same outputs, including a stay across a month boundary and a transfer.
- Another manager's enterprise (403), officer write attempts (403), tokens of other roles (401), finalized-month edit (409), reopen without a reason (400), finalize with differences (409), second concurrent booking of the same room (one wins).
- `schema.sql` run twice on a local database. The live Supabase database changes only after the code is on `main`, then the user re-runs the schema and redeploys.

## 4. Questions that change correctness

1. Should a guest be counted overnight on the night of check-out? (Default no, G1.)
2. What region name should exports carry? (G6.)
3. Which country list do the Tourism Office's forms use? (G7.)
4. May the officer's existing backup entry of a monthly report be removed? (G9.)
