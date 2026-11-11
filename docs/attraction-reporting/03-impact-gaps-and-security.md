# Attraction reporting: impact, conflicts, gaps and security plan

Proposal for review. The repository was inspected on 12 November 2026 (branch `claude/wizardly-dijkstra-ssze0r`).

## 1. Conflicts between the current implementation and the requirements

| # | Current implementation (inspected) | Requirement | Effect |
|---|---|---|---|
| C1 | An attraction reports through `monthly_reports` + `monthly_report_counts`: one row per country of Form A4's 72 residences, with **male and female both given**, total generated as male + female (`statistics.js` PUT `/reports/:spotId/:year/:month`). | Total-only, partial and optional breakdowns; unknown ≠ 0; residence is four classes. | Total-only is impossible today, and an empty country becomes 0. The model cannot carry the new facts. |
| C2 | No daily record. The Guest Register (`register_entries`, `register_entry_guests`) logs a group per date by country and sex, only to help fill the monthly form. | One authoritative daily source. | The register is retired for attractions (D5). Its existing rows stay. |
| C3 | The Arrivals Report (Form A4 Part I) and "Arrivals by place" add attraction reports to accommodation arrivals (decision of October 2026: a guest counts once at each place). | Keep attraction visits separate from accommodation arrivals and guest-nights everywhere. | **D1:** attraction visits leave Part I. Reverses the October 2026 rule. Arrivals Report totals change. |
| C4 | The officer may enter or correct an office attraction's monthly report as a backup (`mayEnterFor`, 10 November 2026). | The officer views, finalizes and reopens. No officer recording. | **D5:** remove the officer's write for attractions in the new module. |
| C5 | Finalize/Reopen exist as `lock`/`unlock` for all reports of a month at once (`/periods/lock`) and as a per-place unlock. | Per attraction and month, with a reopen reason, a required resubmission and retained versions. | New per-attraction lifecycle, like the accommodation module's. |
| C6 | Support Staff edit the report directly, and "a saved report counts at once". | Draft → Submitted → Finalized with locked periods. | A new Submit step and locks. |
| C7 | `statistics-excel.js` writes Form A4 only, with values rather than formulas. | VAR 1, DTA2M, VAR 3M exports from the same logic as the screens. | New exporter beside `accommodation-excel.js`. |

## 2. Impact list (existing pages, routes, tables, calculations, exports, documents)

**Pages (not changed in this stage)**
- `src/staff/staff_register.html`, `staff_statistics.html`: replaced for attractions by Daily Visitor Record and Monthly Reports. The menu becomes My attraction, Daily Visitor Record, Monthly Reports, Account.
- `src/admin/admin_statistics.html`: Tracker (Attractions), Enter a report (attraction part removed; officer view only), new Attraction Visits tab; Arrivals Report loses attraction rows.
- `src/admin/admin_analystic.html` (Dashboard): month-just-ended reports and Form A4 counts read `/tracker` and `/form-a4`; attraction figures need their own tile.
- `src/shared/stat-form.js`, `portal-flat.css`, `staff-portal.js`: reused; new shared script(s) for the daily record and the report.
- Support Staff pages' "Entered by" banner and the officer's Destinations card text stay.

**Routes**
- `statistics.js`: attraction branches of `PUT /reports/...`, the register routes, `/tracker?kind=attraction`, `/places`, `/form-a4`, `/form-a4.xlsx` change (409 `USE_DAILY_RECORD` for attractions once the module is on, mirroring `USE_STAY_REGISTER`).
- New routes for daily records, monthly figures, submit, finalize, reopen, tracker, DTA2M, VAR 3M, VAR 2 and Excel.
- `support-staff.js`, `requireReporter`, `ownsAsSupportStaff`, `counts_visitors`: reused unchanged (assignment rules kept).

**Tables**
- New: the tables in document 02. Unchanged: `monthly_reports`, `monthly_report_counts`, `register_entries`, `register_entry_guests`, `report_changes`, `residences`, `support_staff`, `spots`, `spot_closed_dates`.

**Calculations**
- New aggregation module (no database), as `accommodation-engine.js` is. The same functions feed screens, previews and Excel.

**Exports**
- New: VAR 1 (a month, one attraction), DTA2M, VAR 3M, VAR 2. Form A4 export loses attraction rows (D1).

**Documentation**
- `CLAUDE.md` (Tourism statistics, Support Staff, Guest Register, Standing constraints), `docs/MANUSCRIPT-NOTES.md`, the notes repository, the Privacy page text about what Support Staff can see (counts only, unchanged), FAQ if it mentions reports.

## 3. Gap list

### Resolved by the brief
- Roles and scope: office-run counting attractions, Support Staff assigned one each, officer views/finalizes/reopens, no approval queue, no officer recording, managers and tourists excluded.
- Online only. No names, contacts, passports or stay records. No shifts or individual arrival records.
- Unknown differs from zero. Residence is usual residence. No country-by-country recording. Total-only and partial breakdowns allowed. Known residence never exceeds the total. Male + female never exceeds the total, equality only when complete. No cross-tabulation invented.
- Do not use tickets, payments, bookings or reviews as counts. Keep visits apart from arrivals. 2025 records preserved, not allocated.

### Proposed defaults (shown in the mockup; change on request)
- P1 Submit needs every date recorded or an authorized closure.
- P2 A weekly closed day is confirmed zero by the Support Staff through a deliberate bulk action, never assumed.
- P3 Incomplete residence is shown with known Domestic and Foreign marked `*` and the remainder on a ZTIMS note line outside the official grid.
- P4 Official outputs use finalized versions. Operational view includes submitted and draft, labeled. Missing = "Not submitted".
- P5 While a finalized month is reopened, its last finalized version stays official ("correction pending") until replaced.
- P6 The 5th of the next month is a ZTIMS target, not an official deadline.
- P7 Legacy attraction reports, registers and 2025 totals stay read-only and separate. Each attraction has a first reporting month.
- P8 One counted visit: one person per date, re-entry not added, group members counted, repeat days counted (see 01, section 8).

### Decisions that block implementation
- **D1** Attraction visits leave Form A4 Part I? (Reverses the October 2026 rule; changes Arrivals Report totals.)
- **D2** VAR 1 stops at day 30. Export rows per real day (A, proposed), a 31st row outside the grid (B), or drop day 31 (C, rejected)?
- **D3** Does DTA2M "This Province" include "This Municipality"? (Storage is the same either way; the export differs.)
- **D4** Is the municipal figure all attraction visits, or only same-day visitors as VAR 3M's title says? Confirm the counted-visit rule. Without this the output cannot be called a same-day visitor count.
- **D5** Remove the officer's backup entry for attraction reports and retire the attraction Guest Register? (Existing rows kept either way.)
- **G6** The Attraction Code list is not supplied. Exports leave the code blank until the office provides it.

### Not verified
- That the supplied forms are the current required forms, and any reporting frequency or deadline. The only primary-source candidate found, the 2007 DOT-JICA Tourism Statistics Manual for LGUs (hosted by the Local Government Center, Jakarta), could not be fetched from this session (the host does not resolve). Searches found no DOT memorandum circular that ties VAR 1, VAR 3M or DTA2M to a current LGU requirement. A DOT regional office should be asked for the current forms and any deadline. Nothing here claims the copies prove the local mandate.

## 4. Security plan

**Access**
- Every route checks the token (HS256, issuer, audience), that the account exists and is active, its `sv` session version, and that it is not waiting to replace an issued password (`requireAuth`).
- Role chains: attraction routes use Support Staff or officer only. Managers and tourists are refused at the signature or role check.
- Assignment boundary: a Support Staff account may read or write only its own `spot_id`, only while the attraction is office-run, published and counting (`ownsAsSupportStaff`). The attraction id in a URL is never trusted: it is compared with `req.account.spot_id`, and a mismatch is 403 (404 for an unknown id).
- The role, attraction, status, year and owner of a request body are ignored. The server derives them from the token and the record.

**Writes**
- Explicit writable-field lists: `total`, the four residence counts, `male`, `female`, the two completeness flags, `revision`, `request_key`. Everything else is refused.
- Integers 0 to the bound, real calendar dates (28 to 31 days, leap years), dates not after today, dates inside the attraction's reporting period. Server-side, whatever the page does.
- Parameterized SQL only. Bounded queries (a month or a year, never unbounded lists).

**Locked reports and concurrency**
- Submit and finalize lock the period in the database (triggers) as well as in routes, so no route, including bulk actions, can alter a submitted or finalized month.
- Per-attraction advisory lock in each write transaction. `revision` on each daily record, `expectedVersion` on submit and finalize. A retried save with the same `request_key` returns the first result. It does not add a second one.
- Reopen needs a reason of 10 or more characters. Versions and events are immutable.

**Exports and data minimization**
- Exports use the same server functions as screens, are fetched with the Bearer header, are `no-store`, and are role-checked like the pages. Text from users is written as text (no formula injection).
- Only counts, dates and the attraction's name are collected and exported. No names, contacts or passport data exist in the model.

**Database access**
- The Express API connects to Postgres as the table owner. **Row Level Security does not apply to that connection**, because the owner bypasses it unless `FORCE ROW LEVEL SECURITY` is set. The project keeps RLS on with no policies so Supabase's public REST API returns nothing. The API is the only guard for the API path, so authorization is enforced in code and in triggers, not by RLS.
- Least privilege: no new grants, no `SECURITY DEFINER` functions. The service connection string stays in server environment variables only, never in browser code, logs or exports.

**To confirm at build time with real requests:** each role and each assignment against every route, locked and reopened months, forged attraction ids and years, oversized bodies, concurrent saves and submits, and that no export route works for the wrong role.

## 5. What the next stage needs from the office

Answers to D1 to D5, the attraction code list (G6), and the current forms and any deadline from the DOT regional office. Until then the build uses the proposed defaults and lists each as an assumption.
