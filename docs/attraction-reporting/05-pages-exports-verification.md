# Attraction visitor reporting: the pages, the exports against the PDFs, verification, rollout

Stage 5, 12 November 2026, on the branch `claude/wizardly-dijkstra-ssze0r`. Tested on a **local, isolated** Postgres and API only. Nothing was pushed to `main`, deployed, or changed on the live Supabase project, and no live data was read or deleted in this stage.

It completes stage 4 (document 04): the backend there is now used by real pages, and both must ship in the same release.

## 1. What changed

| Area | Change |
|---|---|
| `src/shared/att-common.js` (new) | What both sides share: month and day states as pills, the figure tiles, the residence and sex tables (unknown shown empty), the VAR 1 day table, history, version changes, the source of a consolidated figure. Built on `acc-common.js`. |
| `src/shared/att-staff.js` (new) | The Support Staff's **Daily Visitor Record** and **Monthly Report**. |
| `src/shared/att-officer.js` (new) | The officer's **Attraction visits** tab: Tracker, Monthly (DTA2M), Annual (VAR 3M), Issued. |
| `src/staff/staff_register.html`, `staff_statistics.html` | Rebuilt on the new scripts (they had been the Guest Register and the typed monthly report, whose routes now answer 409). |
| All four `src/staff/*.html` | Menu: "Guest Register" → **Daily Visitor Record**. |
| `src/admin/admin_statistics.html` | Fifth tab **Attraction visits**; Enter a report and Tracker list places to stay only, with a link to the new tab. |
| `src/admin/admin_analystic.html` | Dashboard card "attraction reports to finalize" (last month), apart from the accommodation card. |
| `src/shared/portal-flat.css` | `.att-*` styles (calendar, form, legend, tracker, mode switch). |
| `src/shared/acc-common.js` | A signed-out redirect from `src/staff/` now reaches the staff sign-in (it went to a missing path). |
| `attraction-engine.js` | A month with **no residence recorded at all** gives `null` residence classes in DTA2M and VAR 3M (it gave 0). `addN` adds where null is unknown. |
| `attraction-visits.js` | The VAR 3M sums start from unknown, not 0. |
| `attraction-visits-excel.js` | Rebuilt print arrangement and headers to match the PDFs (section 3). Column page breaks written into the sheet XML. |
| `package.json` / `package-lock.json` | `jszip` declared (it was already installed as ExcelJS's own dependency, same version 3.10.2). |
| Tests | `tests/page-flow.js` (57), `tests/page-flow-extra.js` (20), `tests/page-security.js` (14); `check-exports.py` follows the new note columns. |
| `exports/` | Each printed export page beside the source page. |

## 2. The pages

**Support Staff, Daily Visitor Record.** The assigned attraction is already chosen (from the account; the server compares it on every call). The page opens on the current month (or `?month=`) with the first missing date selected and the **Date** and **Total visitors** boxes first. "Add a breakdown (optional)" opens the four residence classes and male and female, with a live "90 of 100 classified · 10 not recorded". Save confirms with the date and the count and offers the next missing date. Things that never pass silently:
- Leaving unsaved figures (another day, another month, closing the page) asks "Discard your changes?". "Keep editing" keeps both the date and the figures.
- A save that fails says **Not saved** and keeps the figures. With no connection the same request key is reused, so pressing Save again cannot count twice. A stale save (someone changed the date meanwhile) offers "Load the saved figures".
- A locked month (submitted, finalized) disables the form. A reopened month shows the officer's reason.
- Missing is never zero: a missing day is dashed red ("—"), a confirmed zero is hatched ("0"), an authorized closure is struck through ("Closed"). Each day's full state is in its `aria-label`. "Record 0 for several dates" ticks only the dates nobody came, and none is ticked by default.

**Support Staff, Monthly Report.** It has a month picker, a state banner, tiles (visits, dates counted, confirmed zeros, missing or closures), and incomplete residence or sex said in words. The residence and sex tables keep "not recorded" as its own row. The page also shows Day by day (VAR 1), the versions with what changed and an Excel each, and the history.

**Submit** (or **Submit correction**) opens a window with the attraction, the period, the total (and the earlier version's total for a correction), the dates, and the incomplete breakdowns. A correction needs a reason.

**Officer, Statistics → Attraction visits.**
- **Tracker:** attractions × months by state, with a count per state. A cell opens the month: figures as submitted, versions, history and VAR 1 Excel. **Finalize version n** is asked once. **Reopen** needs a reason of 10+ characters and says which issued files become "needs regenerating". "Reporting settings" sets the first reporting month and the attraction code. The window has no field for a count.
- **Monthly (DTA2M):** month, Official (finalized) / Operational. Coverage pills read, for example, "2 of 2 finalized" or "1 not submitted". Each row says where its figures came from. "–" means not submitted, empty means not recorded. DTA2M Excel and **Issue DTA2M** are here.
- **Annual (VAR 3M):** the same for the year, with the residence-not-recorded line and the 2025 municipal totals kept apart.
- **Issued:** every issued file with Current, Needs regenerating or Superseded, and "Excel as issued".

The page carries the portal's own look: flat outlined panels, pill buttons, sentence-case labels, the shared dialog shell, toasts, light and dark, and the sideways-scrolling tables. It works with no page scroll at 390 px. Every field has a label, and focus is visible on days and controls.

## 3. The exports against the source PDFs

Each was rendered to PDF with LibreOffice and set beside the source page (`exports/*.png`). LibreOffice reports **0 formula errors**.

| Form | Faithful to the PDF | Adapted (and why) |
|---|---|---|
| **VAR 1** (PDF pages 1–4) | The title, "( This recording form … )", Month/Year, Municipality and Attraction labels on underlined lines, and the "Type of Tourism Attraction" box. The grid has Date / Day / Week Day; *** Place of Residence / Philippines / This province / Other Province / Foreign Country Residence / * Grand Total Number of Visitors, Male / Female / Total under each, in the same yellow and borders. The "Total of this Month ****" row and the Note follow it. "(VAR 1)" sits over the right half. It prints **A4 portrait, 4 pages**: days 1–28, then the rest with the total, then Foreign and Grand Total on pages 3–4. | One row for every real day, so **day 31** exists (the PDF grid stops at 30; **D2, assumed**). Empty cells mean not recorded and 0 is a confirmed zero (the PDF shows 0 everywhere). "This province" is Zamboanguita plus the rest of Negros Oriental, from the two classes. A ZTIMS note column sits after a blank column, outside the form. Small ZTIMS notes and a version or "NOT SUBMITTED" line are added outside the grid. |
| **DTA2M** | The title and subtitle, Month/Year and Municipality on underlined lines, and "DTA2M" over the right half. Visitor Attraction / Name / Attraction Code, This Municipality / This Province / Other Province / Foreign Country Residence / * Grand Total, and Male / Female / Total. The form's empty row before the total. "Total of this Month ****" is light green, with grand-total Male / Female in dark green. The Note follows. It prints **A4 landscape, 2 pages wide**. | One row per office attraction (the PDF has Attraction 1–3 and X). The PDF breaks the page inside Foreign Country Residence; here it breaks after Other Province so no group is split. Residence Male and Female stay empty (never estimated). ZTIMS notes (status, residence not recorded) sit outside the grid. |
| **VAR 3M** (PDF pages 10–12) | "VAR 3M", the title, Municipality / Province / Period on underlined lines. Month (yellow, bold) with one Domestic / Foreign / Total group per attraction, "Name - (Code)", and Grand Total Visitors. "Total:" has heavy borders. It prints **A4 portrait, continuing sideways**: two attraction groups per page, as the PDF does. | One group per office attraction (the PDF has 1, 2, 3, N). The PDF cuts Grand Total across pages 11 and 12; here the break falls between groups. Domestic and Foreign are what was recorded, and an asterisk marks a month with residence not recorded. The ZTIMS note row (residence not recorded) sits below the grid. A note says the title's "Same Day Visitors" is not claimed (**D4, assumed**). |
| **VAR 2** (pages 7–8; generated with VAR 3M) | The headers like the PDF (Visitor Attraction / Name / Month / Attraction Code, residence groups with Male / Female / Total), the green total row, the Note, **Prepared by:** and **Noted by:**, and "VAR 2" over the right half. It prints **A4 portrait, 2 pages wide**. | One sheet per attraction with its 12 months (the PDF lists further attractions under the first). Residence Male and Female are empty. (Stage 4 had collapsed the residence groups to single totals, which redesigned the form; that is corrected.) |

Numbers are numbers (`#,##0`). A total is a formula that stays blank when nothing it adds is recorded. Text people typed (attraction names, codes, reasons) is written so it is never a formula: an attraction named `=HYPERLINK(…)` stays text. File names are letters, digits, `_`, `.` and `-` only, and downloads are `no-store`.

**What depends on unanswered decisions** (built as the proposal's default, each easy to change in `attraction-visits-excel.js`):
- **D2:** VAR 1's day 31 row. If the office wants exactly the supplied 30-row grid, day 31 has no official place.
- **D3:** DTA2M "This Province" excludes Zamboanguita.
- **D4:** the VAR 3M title is kept but not claimed as a same-day-visitor count.
- **Attraction codes:** blank ("Code pending") until the office sets them.

## 4. Verification evidence (all local)

| Check | Result |
|---|---|
| `npm run check` (frontend) | 43 pages, 0 problems; open days agree |
| `npm run build` | built |
| Backend loads (`node -e "require('./server')"`, with `JWT_SECRET`) | loads |
| `tests/api-checks.js` (stage 4 API, after the engine change) | 149 passed, 0 failed |
| `tests/check-exports.py` (inside the above; LibreOffice recalculation) | all passed, 0 formula errors |
| `tests/page-flow.js` (Chromium, real pages, real API) | 57 passed, 0 failed |
| `tests/page-flow-extra.js` | 20 passed, 0 failed |
| `tests/page-security.js` | 14 passed, 0 failed |
| Accommodation `api-checks.js` / `security-checks.js` (regression) | 104 / 41 passed, 0 failed |
| `schema.sql` | not changed in this stage (applied twice in stage 4) |

**The flow exercised in the browser:** record (complete breakdown, total only, residence partly recorded, a refused value, unsaved changes, a confirmed zero, a stale save, day 31) → monthly preview → Submit → locked record (page and API) → officer Finalize → DTA2M and VAR 3M (Excel and Issue) → Reopen (a short reason refused) → issued files "Needs regenerating" → the reopening reason shown to the Support Staff → correct → Submit correction (reason, earlier total shown) → version 2 with what changed → Finalize → issue again (the old ones Superseded, kept) → DTA2M uses version 2 only (never both) → operational view labeled. It also ran at phone width (no sideways scroll) and in dark theme, with every field labeled and no script errors.

**Also checked:**
- February 2024 (29 rows) and day 31 (stage 4 API checks).
- 31 December 2025 and 1 January 2026 in separate months and years.
- The 2025 municipal totals (12 months) reported apart and never added.
- A change of Support Staff: the old session stops at once, the tracker shows no staff, the new person sees the versions and earlier names, can correct an open month and is named, and cannot open another attraction.
- An attraction switched off: writes refused 409 `NOT_COUNTED`, and the page shows a message instead of the form.
- A totals-only month shows empty residence cells (not 0) on the screen, in the API and in the Excel.
- Agreement: the daily counts (1,360) = the live month = version 2 = the DTA2M row = the VAR 1 Excel total cell. The DTA2M screen total (1,670) = the DTA2M Excel cell = VAR 3M October = the VAR 3M year cell.

**Not checked:** Microsoft Excel itself (LibreOffice recalculated and printed the files instead); a physical phone; a screen reader (only the labels and `aria-label`s were checked); the live database role (document 04 §6).

## 5. Security review of the implemented behavior

Real requests by role and assignment (stage 4's 149 checks plus this stage's):
- **Who:** no token, a tourist, and an enterprise manager are refused on every attraction route. A Support Staff with another attraction's id gets 403 or 404 on reads, writes, previews and downloads. Officer-only routes (finalize, reopen, tracker, consolidations, issue, issued downloads) refuse Support Staff, and the officer has no recording route. A deactivated or replaced Support Staff account stops at once (`session_version`); the officer's deactivation is stage 4's.
- **State:** the server refuses a change to a submitted or finalized month on every route, and the database triggers refuse it too. Stale saves, duplicate retries, two submits at once and save/finalize races are covered in stage 4.
- **Injection:** SQL is parameterized, and an id like `x' or 1=1 --` gives 404. Stored markup in an attraction's name, its code and a reopening reason shows as text and never runs on either side (checked in Chromium). Typed text in Excel is never a formula.
- **Cross-site:** sign-in is a Bearer token in the request header, never a cookie, so another site cannot send a request in the user's name (CSRF does not apply). No CORS grant goes to another origin, including the preflight for a PUT. A write without a token gets 401.
- **Exposure:** month views and errors carry no password, hash, token or secret, and no stack or SQL. Exports carry counts, dates, the attraction's name and code, and the submitter's staff email in the history. No visitor's identity exists anywhere in this module.
- **Bounds:** years are 2000–2100, months 1–12, at most 31 dates per bulk zero, at most 200 attractions per consolidation, and the shared write limit applies.

**Findings, not fixed here (outside this change):**
1. **The blanket request limit** is 150 requests per 15 minutes per address, in memory (`server.js`). Each save on the Daily Visitor Record makes two requests (the save, then the month again, so every figure comes from the server). A Support Staff catching up a month's backlog (about 60 requests) on the Municipal Hall's shared address, alongside the officer, can reach it. The browser tests had to give each request its own address to run. Raising it, or counting per signed-in account, is worth a separate decision.
2. The staff token lives in browser storage, as everywhere in the portals: a script injected into a staff page could read it. No injection was found.

## 6. Old rules that conflict, now marked in CLAUDE.md

- "Don't split attraction arrivals back out into a separate part or page" (Tourism statistics): superseded by D1. Attraction visits have their own tab and forms.
- "Statistics has four tabs … no separate Attractions tab or route": now five, with **Attraction visits**.
- "the officer may also enter or correct an office place's report as a backup" (Who reports; Support Staff; the officer's Guest Register rule): retired for attractions by D5. The officer never records a daily count.
- The Support Staff menu "Guest Register" and their "Guest Register and Monthly Report … the manager's pages": now the Daily Visitor Record and the attraction Monthly Report.
- Tracker "Places (Places to stay / Attractions)": places to stay only.

## 7. Remaining limitations

- D1 to D5 are still the proposal's defaults, not confirmed by the office (section 3, and 04 §8).
- The attraction code list was not supplied.
- The supplied forms were not checked against current official DOT requirements (the guidance could not be reached).
- The 5th of the next month is a ZTIMS target.
- The blanket request limit (section 5).
- The legacy attraction tracker route (`/api/statistics/tracker?kind=attraction`) still answers, marked `legacy`. No page uses it.
- The Privacy and FAQ pages do not yet describe the Daily Visitor Record. They say only that Support Staff see their attraction and its counts, which stays true.

## 8. Rollout to production (later; each step needs the user's yes)

It replaces 04 §10 step 2 and adds the dependency note. Code first, then the schema, with pages and backend in one deploy.
1. The office answers D1 to D5 and gives the attraction codes, or the user accepts the defaults.
2. **Back up** (Supabase SQL Editor, CSV): `monthly_reports`, `monthly_report_counts`, `register_entries`, `register_entry_guests`, `report_changes`, `spot_closed_dates`, `support_staff`. Confirm the daily backup is recent.
3. Run `docs/attraction-reporting/reconcile.sql` on live and keep the output. Confirm there are still no earlier attraction reports or attraction Guest Register entries (the "cannot transform" lines). If any exist, stop and ask.
4. Push the branch to `main` (fast-forward). The commit includes `package.json` and `package-lock.json` (`jszip`), which Vercel's `npm ci` needs. Vercel deploys.
   - Until step 5, the new attraction routes and pages answer with an error (their tables do not exist).
   - The Arrivals Report keeps working, without attraction visits.
5. In the Supabase SQL Editor, run `zamboanguita-backend/db/schema.sql` once. Then check:
   - seven `attraction_*` tables exist, with RLS on;
   - `reconcile.sql`'s preserved lines match step 3.
6. Redeploy, or confirm the deploy, then on the live site:
   - open Statistics → Attraction visits;
   - set each attraction's first reporting month and code in "Reporting settings";
   - have one Support Staff sign in and record today.
   Submit or finalize nothing for real unless the office means it: counts are never deleted.
7. Confirm which database role the live API connects as (04 §6).
8. **If something is wrong:**
   - Revert the commit on `main` and redeploy.
   - Then, after exporting the `attraction_*` tables and only with the user's yes, run `rollback.sql`. It drops only what was recorded in the new tables.
