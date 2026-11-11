# Attraction visitor reporting: what was built, mapping, reconciliation, security findings, rollout

Stage 4, 12 November 2026. Built on the branch `claude/wizardly-dijkstra-ssze0r` and tested on a **local, isolated** Postgres only. Nothing was pushed, deployed or changed on the live Supabase project. The only things done to the live project were read-only checks (listed in section 5).

This builds the approved proposal (documents 01 to 03 and `mockup.html`). The five open decisions were not answered in chat, so the proposed defaults were built and are listed as assumptions (section 8).

## 1. What changed

| Area | Change |
|---|---|
| `db/schema.sql` (end of file) | Seven `attraction_*` tables, their rules (triggers) and row level security. Re-runnable. |
| `attraction-engine.js` (new) | All the arithmetic: validation, day states, monthly figures, month state, DTA2M and VAR 3M columns, version comparison. No database. |
| `attraction-visits.js` (new) | The API at `/api/attraction-visits/*`: daily record, bulk confirm-zero, submit, finalize, reopen, tracker, consolidations, issued outputs, exports. |
| `attraction-visits-excel.js` (new) | VAR 1, DTA2M, VAR 3M and VAR 2 workbooks. |
| `statistics.js` | Attractions' old monthly report and Guest Register answer 409 `USE_DAILY_RECORD`. Form A4 (the Arrivals Report) no longer adds attraction visits. The old attraction tracker is marked `legacy`. |
| `server.js` | Mounts the new router; a request body over 1 MB answers 413 (done earlier). |
| Tests | `docs/attraction-reporting/tests/api-checks.js` (149 checks), `check-exports.py`; `reconcile.sql`, `rollback.sql`. |

**Not built in this stage:** the pages (Daily Visitor Record, Monthly Reports, the officer's Attraction Visits tab and tracker, the Dashboard tile). **Built in stage 5: see document 05**, which also updates the exports' print layout and the rollout. The existing Support Staff pages call the old routes, which now answer 409. **The pages must ship in the same release as this backend**, as with the accommodation module. See section 6.

## 2. The data model as built

One authoritative source: **`attraction_daily_counts`**, unique on `(spot_id, count_date)`.
- `total` (0 to 100,000) is confirmed. A row exists only when a count was confirmed. **No row means missing.** A row with `total = 0` is a confirmed zero and must have every breakdown empty.
- Residence: four non-overlapping classes (`res_zamboanguita`, `res_negros_oriental`, `res_other_province`, `res_foreign`), each null when unknown, plus `residence_complete`. Their sum cannot exceed the total, and equals it when complete.
- Sex: `male`, `female` (null = unknown) and `sex_complete`, with the same rule. **There is no sex-by-residence column.**
- `revision` (optimistic lock, must move by exactly 1) and `last_request_key` (a retried request returns the first result).
- Authorized closures stay in the existing `spot_closed_dates` (read only here). A count on a closure is refused.

History and lifecycle: `attraction_count_changes` (every create/change with before, after, who), `attraction_report_versions` (immutable; figures computed from the daily counts at Submit, a daily snapshot, a source digest), `attraction_periods` (current state, locks the month), `attraction_period_events` (submitted, finalized, reopened; reopen needs 10+ characters), `attraction_outputs` (issued DTA2M/VAR 3M with the exact versions used; status current, needs_regeneration or superseded), `attraction_settings` (first reporting month, attraction code).

Rules the database holds, so a script that skips the API still cannot break them:
- A submitted or finalized month's counts cannot be inserted, edited or deleted (`PERIOD_LOCKED`). A count is never deleted at all.
- A saved version, its events and the change history are never edited or removed.
- A version can be saved only for a finished month with every date counted or closed, with the next version number, and its totals must equal what the daily counts add up to when it commits (`VERSION_DRIFT`).
- A month moves only submitted → finalized | reopened, finalized → reopened, reopened → submitted.
- No count for a future date, a date before the first reporting month, a date on an authorized closure, or for anything but an office-run attraction.
- Earlier attraction records are read only: no new old-style attraction report, no change to one's figures or country rows, no new attraction Guest Register entry (`LEGACY_*_FROZEN`). Voiding, finalizing and reopening an old report remain possible.

## 3. Old to new field mapping and affected consumers

| Old (still in the database, read only) | New | Note |
|---|---|---|
| `monthly_reports` kind `attraction` (one per place and month) | `attraction_report_versions` + `attraction_periods` | Not converted. New versions are generated from daily counts. |
| `monthly_report_counts` (72 countries, male and female required, total = male + female) | `attraction_daily_counts` residence classes and sex | Not converted: see section 5. |
| `register_entries` / `register_entry_guests` for an attraction | `attraction_daily_counts` | Retired for attractions, not converted. |
| `monthly_reports.locked_at` (Finalize/Reopen, all places of a month at once) | `attraction_periods.state` per attraction and month | New per-attraction lifecycle with a reopen reason. |
| `report_changes` | `attraction_count_changes`, `attraction_period_events` | |
| Form A4 Part I including attraction reports | Accommodation only; attraction visits are in DTA2M / VAR 3M | Decision D1 built as proposed. |
| `monthly_reports` kind `municipal_total` (2025) | unchanged | Not allocated to attractions, not relabeled. |

| Consumer | Effect |
|---|---|
| `src/staff/staff_register.html`, `staff_statistics.html` | Their saves now answer 409. Replace with the Daily Visitor Record and Monthly Reports pages (next stage). |
| `src/admin/admin_statistics.html` Arrivals Report, "Arrivals by place", Excel (`/form-a4`, `/form-a4.xlsx`) | Attraction rows and totals disappear. Totals change by exactly the attraction visits that were in them. |
| Officer Tracker → Attractions (`/tracker?kind=attraction`) | Still shows the earlier reports, marked `legacy: true`. The new tracker is `/attraction-visits/tracker`. |
| `src/admin/admin_analystic.html` Dashboard | Reads `/form-a4` (now accommodation only) and `/tracker`. Needs an attraction tile from the new routes. |
| `stat-form.js` | No longer used for attractions. Still used by the officer's old view of earlier reports and by accommodation pages until retired. |
| Support Staff portal menu, Privacy, FAQ, CLAUDE.md, manuscript notes | Wording to update (section 7). |

## 4. Statistics policy as built

- Official consolidated outputs use **finalized** versions. The operational view also takes submitted and draft figures, each labeled. A month with nothing usable is "not submitted", never 0.
- While a finalized month is **reopened**, its last finalized version stays official, marked "correction pending", until the replacement is finalized. An old and a new version are never both counted.
- Reopening marks every issued DTA2M/VAR 3M that used the month as `needs_regeneration`. Issuing the replacement marks the older one `superseded`. Old issues are kept and can be downloaded as issued.
- Residence incomplete: VAR 3M and DTA2M show the known classes. Domestic + Foreign can be below Total; the visits with no residence are on a ZTIMS note outside the official grid and are never added to a class. Sex-by-residence cells are left empty.
- Screens, previews and Excel files call the same consolidation functions.
- 2025: `GET /attraction-visits/consolidated/annual?year=2025` returns no attraction figures and a note that the municipal totals are kept as loaded and not allocated to attractions.
- Visits and accommodation arrivals share no total anywhere in the new API.

## 5. Reconciliation and untransformable records

Preflight facts (read only):

| Fact | Live Supabase (12 Nov 2026) | Local test database |
|---|---|---|
| Earlier attraction reports (`kind = 'attraction'`) | **0** | 1 (October 2026) |
| Their country rows | **0** | 1 |
| Attraction Guest Register entries | **0** | 1 |
| 2025 municipal total months | **12** | 12 |
| Office attractions counting visitors | 2 | 3 |
| Active Support Staff accounts | **0** | 3 |
| `attraction_*` tables | 0 | 7 |

- **Cannot be safely transformed:** earlier attraction reports and Guest Register entries record country of residence (with "Filipino nationality" not split into municipality, province or elsewhere) and have no days. Turning them into daily counts or the four classes would invent detail. They are left as they are. **On live there are none**, so nothing is left behind; the preflight query in `reconcile.sql` must be re-run just before the rollout to confirm.
- **Reconciled locally** (`reconcile.sql`, run before and after a full cycle: rollback, then `schema.sql` twice): all 14 "preserved" lines are identical: the 2025 municipal fingerprint and count, the earlier attraction report fingerprint, its country rows, the Guest Register, accommodation reports and versions, and the account, listing and closed-date counts.
- Form A4: after the change, the October 2026 total no longer includes the earlier attraction report's visitors; accommodation arrivals are unchanged (checked in the suite).

## 6. Security review (isolated environment)

Checked with real API requests (149 checks, `tests/api-checks.js`):

| Check | Result |
|---|---|
| No token, a tourist, an enterprise manager on all 17 attraction-visit routes | 401/403 |
| Support Staff B on attraction A's routes (read, record, submit, export) | 403 |
| Support Staff on the officer's routes (finalize, reopen, settings, tracker, consolidations, outputs) | 403 |
| The officer recording a count or confirming zeros | 403 (the officer has no recording route) |
| A manager-run attraction or a place to stay through the attraction routes | 403/404 |
| A deactivated Support Staff account | 401 at once |
| Forged fields in a body (`role`, `status`, `spotId`) | 400: only the writable fields are accepted |
| An id carrying SQL, a 1 MB+ body, impossible dates, negative / fractional / huge numbers | 404 / 413 / 400 |
| A direct SQL edit, insert or delete of a locked month's counts, any delete of a count, any edit of a version, event or history | refused by triggers |
| Retries and races: 8 identical saves, 6 first saves, 3 edits of one revision, 5 submits, 4 finalizes at once | one result each, the rest 409 or replay |

Findings and handling:
- **RLS does not protect the API's own connection.** The local connection is the table owner and superuser (`postgres`, `rolbypassrls = t`); the live tables are owned by `postgres` and have RLS on with no policies and no `FORCE ROW LEVEL SECURITY`. An owner or a role with `BYPASSRLS` ignores RLS, so the Express API's connection is **not** limited by it. RLS here only keeps Supabase's public REST roles out (live shows `anon` and `authenticated` hold table privileges, so RLS with no policy is what blocks them; the new tables follow the same rule). Authorization for the API path is therefore enforced in code (role, assignment, state) and in database triggers, as built. **Open item:** confirm which role the live API connects as with the query at the end of `reconcile.sql`; a non-owner role without `BYPASSRLS` would need explicit policies or grants, which were deliberately not added.
- No new grants, no `SECURITY DEFINER` function, `search_path` fixed on every function. The live security advisor shows only the expected "RLS enabled, no policy" notices.
- Every query is parameterized; the table names that are interpolated are fixed in the code. Queries are bounded (a month, a year, at most 200 attractions).
- Exports are fetched with the Bearer header, are `no-store`, are role-checked like the pages, write typed text so it is never a formula, and contain counts, dates and the attraction name only. No visitor names, contact details or passport data exist in the model.
- Service credentials stay in server environment variables. Nothing in the new code reads or prints one.
- Remaining risks: the token is kept in browser storage (a cross-site script on a staff page would expose it); the blanket request limit is per server instance; the earlier "Preserve accounts" rule is held by not touching those tables, not by new tests beyond the counts above. No claim is made that the system is free of vulnerabilities.

## 7. Documents and notes to update when this ships

`CLAUDE.md` (updated in this commit), `docs/MANUSCRIPT-NOTES.md` (entry added), the notes repository (not pushed: it is a separate repository and a push was not authorized), the Privacy and FAQ pages (what Support Staff do), the Support Staff menu labels.

## 8. Assumptions (the proposal's open decisions, built as the proposed default)

- **D1** Attraction visits are not added to Form A4. (Reverses the October 2026 "arrivals at places" rule.)
- **D2** VAR 1 Excel has one row for every real day (28 to 31); not the 30-row grid.
- **D3** DTA2M "This Province" = the rest of Negros Oriental (excludes This Municipality).
- **D4** The figure is visits to the attraction. It is **not** claimed to be a same-day-visitor count; every output says so.
- **D5** The officer's backup entry for attraction reports and the attraction Guest Register are retired. Existing rows stay.
- The attraction code list was not supplied: the code is blank in exports until the office sets it (`PUT /attraction-visits/:spotId/settings`).
- The 5th of the next month is a ZTIMS target, not an official deadline. The supplied forms were not checked against current official requirements (the DOT guidance could not be reached).

## 9. Unresolved

- The pages (section 1). Done in stage 5 (document 05).
- Which database role the live API uses (section 6).
- D1 to D5, the attraction code list and the official requirements (section 8).
- The attraction tracker for earlier reports still exists beside the new one until the pages are replaced.

## 10. Rollout to production (later; each step needs the user's yes)

Order matters: code first, then schema, with the pages in the same deploy. **Document 05 §8 replaces this list now that the pages are built.**
1. Review and answer D1 to D5; provide the attraction codes.
2. Build and test the pages on this branch (browser pass, phone and dark). Do not release the backend without them.
3. **Backup** (Supabase SQL Editor, CSV): `monthly_reports`, `monthly_report_counts`, `register_entries`, `register_entry_guests`, `report_changes`, `spot_closed_dates`, `support_staff`. Confirm the project's daily backup is recent (Dashboard → Database → Backups).
4. Run `docs/attraction-reporting/reconcile.sql` and save the output.
5. Confirm there are still no earlier attraction reports or Guest Register entries (the "cannot transform" lines); if there are any, stop and ask.
6. Push to `main` (fast-forward). Vercel deploys. Until the schema runs, the new attraction routes fail (their tables do not exist). The Arrivals Report keeps working: its change touches only `monthly_reports`, not the new tables.
   - **Check before this step:** the Arrivals Report no longer adds attraction visits even before the schema runs (that change is code only).
7. In the Supabase SQL Editor run `zamboanguita-backend/db/schema.sql` once. Expect no errors. Then check that seven `attraction_*` tables exist with RLS on and that `reconcile.sql`'s "preserved" lines match step 4.
8. Redeploy or confirm, then add a Support Staff account to an office attraction (this switches its counting on), set its first reporting month and code, record one day, submit and finalize a test month only if the user agrees, and void nothing (counts are never deleted: use a clearly marked test attraction or leave the record).
9. Confirm the API role (section 6).
10. **If something is wrong:** revert the commit on `main` and redeploy, then (after exporting the `attraction_*` tables, and only with the user's yes) run `docs/attraction-reporting/rollback.sql`. It drops what Support Staff recorded since the rollout and leaves everything else untouched. Tested locally: after rollback the "preserved" lines are identical, and re-applying `schema.sql` works.
