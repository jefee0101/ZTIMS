# Manuscript notes

What the manuscript (the capstone paper) must say after each change to the
system. Newest first. Each entry gives the sentences to change, word for word
where the manuscript already has them, and the answer to give the panel.


## Entrance sales retired — Stage 1 (14 November 2026)

This entry supersedes older entrance-sale and officer-collection descriptions
below. Visitors pay attraction entrance fees onsite. Online Xendit payment
remains only for room bookings, after confirmation, with test keys only.
Stage 1 changes application code, pages, email and documentation; schema.sql
and all live data are unchanged. Optional Stage 2 needs explicit approval and
a separate commit. Do not erase collected research results or claim this later
refinement was part of the original TAM/ISO evaluation.

Manuscript changes to prepare (do not edit manuscript formatting/data here):
- Specific Objective 3(d): replace entrance-ticket sales/checking/collection
  claims with displayed onsite entrance information and room-booking payment
  where appropriate; confirm the objective wording with the adviser.
- Chapter I Scope and Limitations: remove online attraction sales, admission
  checks, entrance refunds and officer collections. Keep room requests,
  room-only online payment, attraction visitor records and statistics.
- Chapter IV Figures 11 and 13: replace or remove retired screens and update
  their captions/descriptions after the manuscript's figure mapping is checked.
- Table 7 “Entrance ticketing and feedback”: remove entrance-selling functions;
  retain feedback and describe onsite entrance-fee information separately.
- Update user journeys, account tabs, notifications, Terms/Privacy/FAQ and
  role permissions consistently. Do not alter original evaluation data.
- Redraw list only: docs/diagrams/entrance-removal-redraw-list.md. Existing
  context/DFD/ERD/use-case/architecture images and DBML are not changed here.

Defaults flagged to the owner: accommodation reviews after a completed booking
only; remove officer Collections; keep student/child fees as information.
Stage 2 approval remains outstanding; approval to write its block does not by
itself authorize deleting live records.

## Unified Rooms with individual rates and photos (14 November 2026)

The manager's Rooms page groups actual numbered rooms under room types. A type
sets a default nightly rate; each room can set a different rate and carry up to
12 photos with a cover photo. Quantity comes from the numbered rooms. Visitors
select a specific room and its displayed rate; saved bookings retain their
original prices. Reservations, registered stays, closures and room outages
share availability. Bookings remain separate from guest arrivals and reports.
Delete is available only for unused rooms and empty types without protected
history; used rooms end availability or their type retires. Finalized reports
and saved versions remain protected. Existing type-only reservations retain
their original records and prices; no room assignment is guessed.

Update manager Rooms and visitor booking descriptions/screenshots after this
change is deployed. Treat it as a later refinement, not part of the original
TAM/ISO evaluation unless there is evidence that it was evaluated. No manuscript
text, survey data, spacing or existing UI figure was edited in this task.

## Conceptual framework redrawn in the IPO format (13 November 2026)

**The change.** Figure (Conceptual Framework) in the school's Input–Process–Output
layout: square boxes with a header row, solid arrows, Input as justified items,
Process with "Theoretical Foundation" and "Evaluation" sub-heads, Output in bold
capitals. Process lists the three theories of the theoretical framework (Buhalis, 2000; Sheehan et al., 2016; d'Angella & Go, 2009 and Sautter & Leisen, 1999) and TAM (Davis, 1989); no Agile cycle picture; "Establishment
Managers" now reads "Enterprise Managers".

**Change in the manuscript:** replace the figure with
`docs/diagrams/ztims-conceptual-framework.png`; where the text names the
respondents, use "Enterprise Managers".

## Room booking: pay at the property or pay online (13 November 2026)

**The change.** A visitor booking a room now chooses how to pay, in a new
**Payment** step of the booking window: **Pay at the property** (as before: the
resort's instructions come with its confirmation) or **Pay online**. Online is
paid only after the resort confirms, for the full amount still owed, on the
same payment service as tickets (GCash, Maya, QR Ph, card, bank transfer), in
its test mode: no real money moves. Nothing is charged if the resort declines.
The visitor can switch between the two in My account until paying. A booking
paid online cannot be moved; cancelled within the resort's free-cancellation
days, the online payment is returned in full. Each resort decides which ways
it takes (Rooms → Settings). The resort sees how each guest pays and when it
is paid. The Tourism Office still sees no money. Payments are never counts.

**Change in the manuscript:**
- Where room booking is described (Chapter III system description, scope),
  replace "the guest pays the resort directly; ZTIMS takes no payment for
  rooms" with: "The guest pays at the property or, where the resort allows it,
  online after the resort confirms, through the same test-mode payment service
  as entrance tickets."
- Scope and limitations: online room payment is a demonstration in test mode,
  like tickets; taking real payments for resorts would need each resort's own
  merchant account.
- Data dictionary / ERD: new table `booking_checkouts`; new columns
  `bookings.payment_choice`, `enterprise_booking_settings.allow_pay_at_property`
  and `allow_pay_online`, and `booking_payments.channel`, `gateway_ref`,
  `is_demo`, `refunded_at`, `refund_amount`, `refund_reason` (34 tables).
- System User Interface: add the booking window's Payment step, the Move or
  cancel Payment panel, and Rooms → Settings with the two switches.

**If the panel asks** "Does ZTIMS hold the resort's money?": No. It runs in
test mode only; real collection would go to each resort's own account.

## Stay register: DAE-1B / DAE 2 tab (13 November 2026)

**The change.** The manager's Guest Register (stay register) has a third tab
beside Stays and Daily register (DAE-1A): **DAE-1B / DAE 2**, Part I of the
2019 monthly form as on paper — country of residence and total, every row of
the form in its order (Philippine residents, then each region's countries with
a sub-total, overseas Filipinos, grand total) — worked out from the stays. Its
Excel button downloads that form alone, in the DOT layout.

**Change in the manuscript:** where the stay register is described, add the
DAE-1B / DAE 2 view and its export; add a screenshot if the System User
Interface shows the register.

## Stay register: Voided filter (13 November 2026)

**The change.** The manager's Guest Register (stay register) lists voided stays
under a new **Voided** filter, after "Carried over from previous months" (was
"Continuing from earlier"). A voided stay never counts in any report; it is shown
with its reason and opens read-only. A stay carried over from a previous month
is one whose check-in was in an earlier month and whose nights fall in this
month: its nights count here, its arrival counted in the check-in month.

**Change in the manuscript:** where the stay register is described, say stays
are voided with a reason, never deleted, and can be reviewed under Voided.

## Enterprise page tabs always shown (13 November 2026)

**The change.** On the Enterprise Manager's Enterprise page, the subpage tabs
(Basics, Location, Visiting, Photos, Contact, and Reporting for a place to stay)
are now underline tabs under the title, always visible, like Statistics and
Settings. They were folder tabs hidden behind the header until pointed at.

**Change in the manuscript:** where the System User Interface shows the
manager's Enterprise page, retake its screenshot.

## Statistics page: Accommodation / Attraction switch (13 November 2026)

**The change.** The Tourism Officer's Statistics page opens with a two-way
switch, Accommodation or Attraction. Accommodation holds the Arrivals Report,
Enter a report, Tracker and FORM A tabs; Attraction holds the attraction
visits (Tracker, Monthly DTA2M, Annual VAR 3M, Issued). Nothing else changed.

**Change in the manuscript:** where the System User Interface describes the
Tourism Statistics page, say it is split by a switch into Accommodation and
Attraction reports; retake its screenshot.

## Page numbering and contents (13 November 2026)

**The change.** Nothing in the system. `FINALIZATION_ZTIMS_rev13.docx` (Word,
made from the Google Doc rev12): title page counted as i with no number shown,
the rest of the preliminary pages in lowercase Roman (ii, iii, ...), Chapter I
restarts at 1 in Arabic and runs to the last page with no break; all footers
show the page at the bottom right. The Table of Contents and the Lists of
Figures and Tables are Word TOC fields built from hidden "Mark Entry" (TC)
fields at each heading and caption, so Word's Update Table rebuilds them; the
file asks Word to update fields on opening. Entries for things not in the
manuscript were dropped (Software Development Life Cycle, Figure 3, Figures
9 to 27); "Foreign/Local Related Literature" now reads "Related Literature /
Related Studies" as the headings do; Table 1 reads "Respondents of the Study";
the second Table 10 (Connections in the System Architecture) was added.

**Still to fix in the manuscript:** two tables numbered 10; no Figure 3 caption;
System User Interface has no screenshots or captions (Figures 9 to 27); two
empty pages with the old campus header and a draft copy of Tables 5 and 6 after
Appendix M; the title page runs onto a second page ("November 2026" lands on
the Approval Sheet page).

## Appendices E to L: the DOT report forms (12 November 2026)

**The change.** Nothing in the system. The manuscript now has one appendix per
blank DOT form behind ZTIMS's reports: E DAE-1A; F DAE-1B (v4a) daily (3 pages);
G DAE-1B / DAE-2 (2019) monthly (3 pages); H FORM A (3 pages); I VAR 1; J VAR 2;
K VAR 3M; L DTA2M. Each page holds its "APPENDIX X" label, the form's title
(with "page n of 3" where it runs on) and the form, sized to fit inside the
page's body so it never reaches the footer; wide forms are turned sideways.
VAR 1, VAR 2, VAR 3M and DTA2M were printed with their tables cut across pages
in the source PDFs; they are joined into one table each (VAR 2's sample entry
blanked). The images and how they were made: `docs/manuscript/appendix-e/`.
Survey Documentation, first Appendix E, then F, is now Appendix M.

**Change in the manuscript:** done in the Google Doc (contents lines E to M
added). The contents page numbers are out of date for every appendix (in the
export of 12 November: A 119, B 120, C 125, D 136, E 140, F 141, G 144, H 147,
I 150, J 151, K 152, L 153, M 154); refresh them before submitting. Cite
Appendices E to L where Chapter III or IV names the DOT forms.

## Theoretical framework, ERD and database schema figures redrawn (12 November 2026)

**The change.** Nothing in the system. Three figure files in `docs/diagrams/`:
- `ztims-theoretical-framework.png` (and its source `.svg`): the three theories
  (Destination Management and Marketing Framework, Buhalis 2000; Destination
  Information and Knowledge Management, Sheehan et al. 2016; Stakeholder
  Participation, d'Angella & Go 2009 and Sautter & Leisen 1999) lead into the
  Agile cycle (1 Planning, 2 Design, 3 Development, 4 Testing, 5 Review,
  6 Deployment), then to ZTIMS, then to Software Quality Evaluation
  (ISO/IEC 25010:2023, rated by IT experts) and User Acceptance Evaluation
  (TAM, Davis 1989, rated by end users). The "Developed System" box and the
  four user boxes were removed, at the adviser's request.
- `ztims-erd.png`: Destinations is now a box the same size as every other
  entity; the relationships and cardinalities are unchanged.
- `ztims-schema.dbml`: regenerated from `schema.sql` (52 tables, every column,
  key and link); it had still listed the tour-guide tables. The older
  `ztims-erd.dbml` (also with guide tables) was removed.

**Change in the manuscript:** replace the theoretical framework figure and the
ERD figure, and make the paragraph under the theoretical framework follow the
new order (theories → Agile → ZTIMS → ISO/IEC 25010 and TAM) without naming the
user groups there.

## Analytics pages for the Tourism Officer and the Enterprise Manager (12 November 2026, on a branch; not live yet)

**The change.** A new Analytics page in each portal.
- **The officer's** has tabs for places to stay, attractions, room requests
  and reporting coverage.
- **The manager's** covers their own enterprise only: arrivals and nights,
  guests and stays, and room requests.
- **On both:** filters by month range, month, quarter or year, and finalized
  or all figures; for the officer also barangay, category and place. Cards,
  trend charts, peak and low, residence and sex where recorded, breakdowns by
  place, barangay and category, a reporting-coverage band under every chart,
  and Excel.

**What the manuscript must say:** add Analytics to the officer's and the
manager's module lists, and use cases "View analytics" for both. In the
interface section, use one figure of each page (screenshots in the session's
local test run). Say that:
- a month not reported is shown as not reported, not zero;
- partial months are marked and never called a peak;
- visits, arrivals and room requests are kept apart and never added together;
- no figure counts unique visitors;
- a manager sees only their own enterprise.

## Analytics: the calculations behind the dashboards (12 November 2026, server side on a branch; not live yet)

**The change.** ZTIMS now works out trends, peak and low periods, weekday
patterns, coverage and breakdowns by barangay, category and place. It works
them out from the records the reports already use: the finalized monthly
versions, the attraction daily counts and the room requests. The dashboard
pages are not built yet.

**What the manuscript must say (once the pages exist):**
- Analytics are read only and come from the same records as the official
  forms, so a chart and a form never disagree.
- Accommodation arrivals, attraction visits and room reservations are
  separate measures and are never added together. ZTIMS does not estimate
  unique tourists.
- A month that was not reported is shown as not reported, never as zero. Each
  figure shows how many places reported. Incomplete periods are never called a
  peak or a low.
- Official figures use finalized reports. Operational figures include
  submitted and draft ones and say so.
- The Tourism Officer sees every place. An Enterprise Manager sees only their
  own enterprises, plus a municipal comparison when at least three places
  reported. Support Staff see only their attraction.
- The 2025 paper totals are shown as a separate baseline.

## Attraction visitor reporting: the pages and the printed forms (12 November 2026, stage 5 on a branch; not live yet)

What the manuscript must say once this ships (with the backend entry below):
- **Support Staff record visitors one date at a time** on the **Daily Visitor Record**: the month as a calendar, the date and the total first, residence (Zamboanguita, rest of Negros Oriental, other Philippine provinces, foreign) and sex optional. A date nobody counted stays missing; 0 is recorded only when nobody came. Their menu is My attraction, Daily Visitor Record, Monthly Report, Account (the attraction Guest Register is gone).
- **The Monthly Report is generated**, never typed: Support Staff check it and **Submit**; a reopened month is corrected on the daily record and submitted again with a reason. Each submission is a saved version.
- **The Tourism Officer** reviews in Statistics → **Attraction visits** (a fifth tab): a tracker of attractions by month, **Finalize**, **Reopen** with a reason, and the municipal **DTA2M** (monthly) and **VAR 3M** (annual) with their Excel files and issued copies. The officer never records counts. The Dashboard shows attraction reports waiting to be finalized.
- **The Excel files follow the supplied forms** (VAR 1, DTA2M, VAR 3M, VAR 2): the same titles, headings, colours, totals, notes and page arrangement (portrait, landscape for DTA2M, continuing sideways). Adaptations: a row for day 31; one row or column group per attraction; empty cells for "not recorded"; ZTIMS notes outside the forms; residence male and female left empty because sex by residence is not recorded.
- **Attraction visits are not tourist arrivals**: they are kept out of the Arrivals Report (Form A4) and the accommodation reports, and totals across attractions are visits, not unique tourists. **This changes the October 2026 text that Form A4 counts arrivals at attractions.**
- Testing: a browser test of the whole cycle (record, submit, finalize, issue, reopen, correct, resubmit, reissue), API and security tests, and the printed exports compared page by page with the source PDFs (`docs/attraction-reporting/05`, `exports/`).

## Attraction visitor reporting: daily record, monthly report, DTA2M and VAR 3M (12 November 2026, backend on a branch; not live yet)

**The change.**
- An office attraction's Support Staff records one visitor count per date: the total (required, 0 only when confirmed), and optionally where visitors live (four classes) and their sex.
- The monthly report (VAR 1), the saved versions, the monthly DTA2M and the annual VAR 3M and VAR 2 are worked out from those counts. Nothing is typed twice.
- Submit, then the Tourism Officer finalizes or reopens with a reason; a correction becomes a new version. A submitted or finalized month is locked.
- Visits to attractions are kept apart from accommodation arrivals. The Arrivals Report no longer adds attraction visits.

**Where it goes.**
- Chapter I, Scope and Limitations: the counts are visits to the attraction, not unique tourists and not claimed to be same-day visitors; residence and sex are optional; where residence is not recorded the report says so and does not assign it.
- Chapter III, ERD and data dictionary: seven tables (daily counts, change history, report versions, periods, period events, issued outputs, settings).
- Use cases: Support Staff "Record the day's visitors; Submit the month"; Tourism Officer "Review, Finalize or Reopen; generate DTA2M and VAR 3M". Remove the officer's attraction recording and the attraction Guest Register.
- Testing: 149 API checks, Excel checks against LibreOffice, a rollback and re-apply test on an isolated database.
- Security: assignment-bound Support Staff, locks in the database, retry keys and revisions, no sex-by-residence data, read-only history.

**For the panel.**
- *Why can the total be larger than Domestic plus Foreign?* Because residence is optional. The remainder is shown as not recorded and never assigned.
- *Why is a month "not submitted" instead of 0?* A missing report is not the same as no visitors.
- *Can an attraction change a month after it is sent?* No. The database refuses it until the Tourism Office reopens the month with a reason.

## Accommodation reporting: the pages, exports and security review (12 November 2026, on a branch; not on main or live yet)

**The change.**
- Managers of private places to stay now have the screens: the stay register (Guest Register), the monthly DAE-1B with Submit and versions, the annual summary, room numbers and out of service (Rooms), and the reporting profile and closed periods (Enterprise → Reporting).
- The Tourism Officer has a places-to-stay tracker, a month review with Finalize and Reopen, and a FORM A tab with coverage per month.
- Every report downloads as Excel in the DOT layouts (DAE-1A, DAE-1B daily and monthly, FORM A, the enterprise's year), worked out from the saved versions.
- The Arrivals Report (Form A4) now takes private places to stay from their saved versions.

**Where it goes.**
- Chapter I, Scope: list the exports (DAE-1A, DAE-1B, FORM A, annual summary) as Excel files in the DOT layouts.
- Chapter I, Limitations: the Excel files are rebuilt from the PDF forms, not the DOT's original workbooks; their formulas are the system's own. A missing report is left blank, never 0.
- Chapter III, Screens: add the stay register, the DAE-1B month with its versions, the officer's FORM A and month review.
- Chapter III, Use cases: Enterprise Manager "Record stays; submit the month"; Tourism Officer "Review and finalize or reopen a month; generate FORM A".
- Chapter III, Testing: 104 API checks, 41 security checks, 36 export reconciliation checks, a browser pass on desktop, phone and dark mode, and an end-to-end submit → finalize → reopen.
- Chapter III, Security (ISO/IEC 25010 security): role and enterprise checks on every route, finalized months locked in the database too, parameterized queries, protection against spreadsheet formula injection, no personal details in exports.

**For the panel.**
- *How do you know the Excel is right?* Every figure in each file is compared with the saved version it came from, and every file recalculates without an error.
- *Can an enterprise change a month after it is sent?* No. Once the Tourism Office finalizes it, the database itself refuses any change that would alter it, until the office reopens it with a reason the enterprise sees.

## Accommodation reporting from a stay register (11 November 2026, stage 2 on a branch; not live yet)

**The change.**
- A private place to stay records each stay: check-in, check-out, which numbered room on which nights, and the guests by residence, male and female.
- The DAE-1A daily register, the monthly DAE-1B, the enterprise's year and the municipal FORM A are worked out from those stays and never typed.
- A submitted month is saved as a version that never changes. A correction is a new version with a reason.
- The Tourism Officer finalizes a month or reopens it with a reason, and never edits stays.
- Attractions keep their monthly report and Guest Register.
- The 2025 paper totals stay as they are and are used as the previous year only for months where both years are complete.

**Where it goes.**
- Chapter I, Objectives: one objective becomes "to record each guest stay once and generate the DAE-1A, DAE-1B and FORM A reports from it".
- Chapter I, Scope: the system shows the rates the forms require (occupancy rate, average length of stay, % share, % difference) for places to stay. It still holds no revenue.
- Chapter I, Limitations:
  - a booking is never counted as an arrival;
  - 2025 has municipal totals only, with no enterprise or sex detail;
  - a month counts as complete only when every listed place to stay reported or was closed.
- Chapter II/III, Data model (ERD) and DFD:
  - the stay register (rooms, room availability, stays, room nights, guests by residence);
  - report versions and their events;
  - the officer's Finalize / Reopen.
- Chapter III, Testing:
  - the stage-2 checks: 104 API checks, the schema run twice, and the rollback;
  - the schema repair of the booking tables (on an empty early draft).

**For the panel.**
- *Why not type the monthly report?* Typing it twice is how the counts drifted from the register in testing. Working it out from each stay makes the daily, monthly and yearly figures agree.
- *Why percentages now?* The DOT forms require occupancy and length of stay, and FORM A requires share and difference. They are calculated, never typed. Yearly rates use the year's totals, not an average of monthly rates.

## No Guest Register for the Tourism Officer (10 November 2026)

**The change.** The Tourism Officer no longer keeps a Guest Register. Each
office attraction that counts visitors has Support Staff, who keep its Guest
Register and send its monthly report; a private enterprise's manager does the
same for it. The officer reads the registers' totals through the reports,
can still enter or correct a monthly report as a backup, and Finalizes or
Reopens the month. An office place counts visitors only through its Support
Staff: adding someone switches "Count visitors here" on; a new office listing
starts off; office places to stay are not counted; places that need no
counting (a marker, a statue) stay off. When someone leaves, the place waits,
still counting, for the replacement.

**Change in the manuscript:** remove the Tourism Officer's "Keep the Guest
Register" use case and the officer's Guest Register screen; the Tourism
Officer's reporting use case becomes "Review reports; enter or correct one as
a backup; Finalize / Reopen". In the access matrix, Guest Register: Tourism
Officer "No (reads totals via reports)". In the process description, the data
flow for an office attraction is Support Staff → Guest Register → monthly
report → Tourism Officer (review, Finalize) → Form A4.

## Support Staff: the complete module (10 November 2026)

Everything below is built and on `main`, and was checked end to end (the
officer adds an account, the first sign-in and password change, a listing
detail edited, Guest Register entries, the monthly report filled and saved,
the officer finalizes the month, the officer deactivates the account).

**New role.** **Support Staff**: a person of the Municipal Tourism Office,
under the Tourism Officer, who looks after **one attraction the office runs**
(no enterprise manager) whose "Count visitors here" is on. Users are now
four: Tourism Officer, Enterprise Manager, Support Staff (staff, sign in on
the staff sign-in page) and Tourist (visitor account). One active Support
Staff account per attraction; accounts are deactivated, never deleted.

**Use cases** (actor: use case).
- Tourism Officer: Add a Support Staff account (choose the attraction; a
  password is generated and shown once; the officer's own password is asked);
  Issue a new password; Deactivate or reactivate an account; View who is
  assigned (Destinations); Finalize or Reopen the month's reports (unchanged).
- Support Staff: Sign in and replace the issued password; View and edit the
  attraction's details (description, photos, opening days and hours, contact,
  map pin; category and prices shown, locked); Keep the Guest Register (add
  and edit groups by country and sex); Fill and save the monthly report (from
  the Guest Register); Edit own account (name, position, contact number);
  Change password; Sign out of all devices.
- System: Refuse anything outside the person's one attraction; refuse locked
  fields; stop a deactivated account's session at once; keep the attraction
  counting and published while someone is assigned.

**Access matrix.**

| | Tourism Officer | Enterprise Manager | Support Staff |
|---|---|---|---|
| Places covered | All | Their own enterprises | One office-run attraction |
| Listing details | All | Own | Own, except name, category and prices |
| Category, entrance and other fees | Yes | Own | No |
| Guest Register | No (10 Nov 2026: reads totals through reports) | Own | Own (no removing entries) |
| Monthly report (enter) | Office places, as a backup | Own | Own |
| Finalize, Reopen, void | Yes | No | No |
| Closed dates, take down, Visitor setup | Yes | – | No |
| Tickets (check, Mark used), Collections, refunds | Yes | No | No |
| Accounts, settings, feedback, reviews, other places | Yes | No | No |
| Delete anything | Never | Never | Never |

**ERD.** SPOT 1 — 0..n SUPPORT_STAFF (`spot_id`; at most one active per
spot). The person's email is written on what they save:
`monthly_reports.submitted_by_email` / `submitted_by_role`,
`report_changes.changed_by_email` / `changed_by_role`,
`register_entries.created_by_email` (the existing columns; no new links).

**Data dictionary** (new table, 33 in all).

| Table | Column | Type | Meaning |
|---|---|---|---|
| support_staff | id | text PK | |
| | email | text, unique (any case) | Sign-in email; no other staff account may use it |
| | password_hash | text (bcrypt) | |
| | reset_token_hash, reset_token_expires | text, timestamptz | Forgot-password link (hash only) |
| | full_name | text 1–120 | |
| | position | text ≤ 120 | e.g. Tourism Aide |
| | contact_number | text ≤ 40 | |
| | spot_id | text FK spots | The attraction looked after |
| | status | text | active or inactive (never deleted) |
| | must_change_password | boolean | True when issued; cleared at the first own password |
| | session_version | integer | Raised to end every sign-in |
| | last_sign_in_at | timestamptz | |
| | created_by_email | text | The officer who added it |
| | created_at, updated_at | timestamptz | |

Index `support_staff_one_active_per_spot`: unique `spot_id` where status is
active.

**Security (for the Security section).**
- A new staff role, `support_staff`, in the same signed sign-in tokens as the
  other staff, carrying the account's session version. Every route checks the
  role on the server: Support Staff are refused on every officer, manager,
  ticket, money, feedback and settings route, and the officer's and managers'
  tokens are refused on Support Staff's own routes.
- Same password rules as the other staff (at least 10 characters, not easily
  guessed, bcrypt); the officer's issued password must be replaced at the first
  sign-in; 30-minute idle sign-out on their pages; deactivating ends every open
  session at once.
- The officer's own password is asked again to add an account, issue a
  password, or deactivate or reactivate one.
- Listing edits from Support Staff are checked field by field: a change to
  the name, category, any fee, kind, status, publishing or manager is refused.

**Data Privacy.** The account holds a staff member's own name, position,
contact number and email, kept while the account exists (deactivated, not
deleted, so their records still say who entered them). Support Staff see
counts only (numbers by country and sex, never visitors' names), and never
tickets, payments, bookings or feedback. The Privacy page says so.

**Limitations.** One person per attraction (no team or shifts); only office-run
attractions that count visitors; they cannot remove a register entry (the
officer can); they work online only, like the rest of ZTIMS.

**Wording.** "Support Staff" (never "Site Officer"); "My attraction";
"Entered by <name>"; "Deactivate" (never "delete") for an account.

## Support Staff: database, API and pages (10 November 2026)

**The change.** A fourth user, **Support Staff**, under the Tourism Officer:
a person of the Municipal Tourism Office who looks after one attraction the
office runs (with Count visitors here on). They keep its Guest Register, its
monthly report and its listing details, but not its category or prices; no
tickets, money, closing dates, taking it down, Finalize or Reopen. The officer
adds them (one active per attraction), issues passwords and deactivates them,
each with the officer's own password; accounts are never deleted. New table
`support_staff` (33 tables). Pages: their own small portal (My attraction —
the listing's details with category and prices shown locked; Guest Register;
Monthly Report; Account), the officer's Settings → Support Staff (add, new
password, deactivate or reactivate), a "Support Staff: <name>" marker on
Destinations' card, and Statistics naming who entered a report.
Screenshots for the manuscript: the Support Staff portal's My attraction and
its locked form, the officer's Settings → Support Staff, the Statistics banner.
The full entry (use cases, access matrix, ERD, data dictionary, security)
comes with the end-to-end check.

## Visitor accounts, saved places and reviews: the complete module (9 November 2026)

Everything below is built and on `main` (visitor accounts, no public ticket
search, saved places and reviews; the entries below give each step). Privacy,
Terms and FAQ say the same, dated 9 November 2026.

**New module for the manuscript.** *Visitor Accounts and Reviews*: a visitor
(the new user **Tourist**) creates an account with email and password,
confirmed by an emailed link, or with Google; signs in to buy entrance tickets
and request rooms (the name, email and phone come from the account); finds
their tickets and bookings in My account, and moves or cancels them there;
saves places with a heart; and, after a used ticket or a completed stay,
rates and reviews the place. The Tourism Officer can hide or unhide a review,
always with a reason. The visitor can delete the account.

**Users.** Three now: Tourism Officer, Enterprise Manager, and **Tourist**
(visitor with an account). Browsing, the map and directions still need no
account.

**Use cases** (actor: use case).
- Tourist: Create an account (email and password, then Confirm email; or
  Continue with Google); Sign in / Sign out; Reset a forgotten password; Edit
  profile (name, phone, country); Change password; Sign out of all devices;
  Buy an entrance ticket; Request a room; View my tickets and bookings; Move or
  cancel a ticket or booking; Save or unsave a place; View saved places;
  Write, edit or delete a review; Delete my account.
- Tourism Officer: View all reviews (filter Shown / 1 or 2 stars / Hidden /
  All, search); Hide a review with a reason; Unhide a review with a reason.
- Enterprise Manager: none new (cannot reply to or hide reviews).
- System: Link earlier guest tickets and bookings to an account by its
  confirmed email; check the visit before accepting a review; erase a deleted
  account's details at once.

**ERD** (new entities and links; one-to-many unless said).
- VISITOR 1 — n VISITOR_TOKEN (emailed links)
- VISITOR n — n SPOT through SAVED_PLACE
- VISITOR 1 — n REVIEW; SPOT 1 — n REVIEW; one REVIEW per (VISITOR, SPOT)
- REVIEW n — 0..1 TICKET and n — 0..1 BOOKING (the visit that proves it; one
  of the two always set)
- REVIEW 1 — n REVIEW_CHANGE (each hide or unhide)
- VISITOR 1 — n TICKET and VISITOR 1 — n BOOKING (`visitor_id`, nullable for
  guest records from before accounts)

**Data dictionary** (PK primary key, FK foreign key).

| Table | Column | Type | Meaning |
|---|---|---|---|
| visitors | id | text PK | |
| | email | text, unique (any case), null only once deleted | Sign-in email |
| | email_verified_at | timestamptz | When the email was confirmed (link or Google) |
| | password_hash | text (bcrypt) | Null for a Google-only account |
| | google_sub | text, unique | The Google account's id for ZTIMS |
| | full_name | text ≤ 120 | |
| | phone | text ≤ 40 | Asked once at the first checkout that needs it |
| | country_code | text FK residences | Country of residence (Form A4 row), for rooms |
| | session_version | integer | Raised to end every sign-in |
| | status | text | active, suspended, deleted |
| | last_sign_in_at, deleted_at, created_at, updated_at | timestamptz | |
| visitor_tokens | id | text PK | |
| | visitor_id | text FK visitors | |
| | purpose | text | verify (48 hours) or reset (30 minutes) |
| | token_hash | text | SHA-256 of the emailed code; the code itself is never stored |
| | expires_at, used_at, created_at | timestamptz | Single use |
| saved_places | visitor_id, spot_id | text, PK together, FK visitors / spots | |
| | created_at | timestamptz | |
| reviews | id | text PK | |
| | visitor_id | text FK visitors | |
| | spot_id | text FK spots | Unique with visitor_id: one per place |
| | rating | integer 1–5 | |
| | body | text ≤ 600 | Optional |
| | status | text | visible or hidden |
| | hidden_reason | text ≤ 300 | |
| | hidden_by_email, hidden_at | text, timestamptz | Who hid it, when |
| | ticket_id | text FK tickets | The used ticket that proves the visit, or |
| | booking_id | text FK bookings | the completed stay (one of the two always set) |
| | created_at, updated_at | timestamptz | |
| review_changes | id | text PK | |
| | review_id | text FK reviews (removed with the review) | |
| | action | text | hidden or shown |
| | reason | text, 3–300 | Required both ways |
| | by_email, at | text, timestamptz | The officer and when |
| tickets, bookings (changed) | visitor_id | text FK visitors, nullable | The account that holds it |

32 tables in all.

**Security (for the Security section).**
- A new role, **tourist**, for visitors only. Visitor sign-in tokens are
  signed with a different audience (`ztims-visitor`) from staff tokens
  (`ztims-web`): a visitor token never opens a staff route, and a staff token
  never opens a visitor's account. Each token carries the account's session
  version, so a password change, a reset or "Sign out of all devices" ends
  every earlier sign-in at once. Tokens last 30 days.
- Passwords: at least 10 characters, not common or guessable
  (`passwords.js`), stored with bcrypt; failed sign-ins limited to 10 per 15
  minutes; sign-ups 5 an hour per connection. An email link carries a
  single-use code (only its hash is stored), never the email or password.
  Forgot-password answers the same for any email, so it cannot reveal who has
  an account.
- **Google sign-in** (Google Identity Services): the server itself checks the
  Google ID token — signature against Google's public keys, issued by Google,
  for ZTIMS's client id, and a Google-verified email. ZTIMS never receives
  the Google password. A Google sign-in joins an existing ZTIMS account only
  when that account's email was never confirmed, or with that account's
  password. The pages' security headers allow only Google's sign-in script and
  frame.
- Tickets and bookings open only for the account that holds them (no public
  search by code). The server, not the page, checks the visit before a review
  and that only the officer hides one.

**Limitations to state.**
- **Signing in is required** to buy a ticket or book a room; there is no
  guest checkout. A visitor without an email address, or in a hurry at the
  entrance, must create an account first (paying onsite at the Municipal
  Tourism Office stays available).
- **Weak signal**: creating an account needs the emailed link to arrive and
  open, and every page needs a connection (no offline use), which is harder at
  the upland and coastal sites with weak mobile signal. Google sign-in needs
  Google to be reachable.
- Reviews come only from visitors whose ticket was marked used or whose stay
  was completed in ZTIMS; places without tickets or ZTIMS bookings get no
  reviews. Managers cannot reply. Visitors cannot be suspended from a page
  yet (the status exists in the database only).

**Data Privacy (for the Data Privacy section).**
- An account is kept **until the visitor deletes it**; it is not erased for
  being unused. Saved places and reviews belong to it.
- **Deleting** (My account → Security; the password, or a Google sign-in from
  the last ten minutes) erases at once the name, email, phone, country,
  password hash and Google id, ends every sign-in and removes saved places.
  The row stays, marked deleted, so tickets, bookings and reviews still point
  somewhere. **Reviews stay, shown as "Former visitor"**, so ratings stay
  honest; the visitor can delete them first. Tickets and bookings keep their
  own guest details until the one-year rule (a year after the visit or
  check-out). The email can sign up again as a new account.
- Public reviews show the first name and last initial only, never the email.
  The officer's Reviews page shows the author's name, never the email.
- Rights: the visitor sees and corrects their own data in My account and
  deletes the account themselves; other requests go to the Data Protection
  Officer named on the Privacy page.

**Wording to use.** "Tourist" as the user; "visitor account"; "Sign in" /
"Create an account" / "Continue with Google"; "My account"; "Saved places";
"Reviews" (a rating of 1 to 5 stars); "Hide" / "Unhide" with a reason (never
"delete" for the officer); "Former visitor"; "enterprise", never
"establishment"; pay "onsite".

## Saved places and reviews (9 November 2026)

**The change.** A signed-in visitor saves places with a heart (on Home's
cards and a destination's photo; signed out, the heart asks them to sign in)
and finds them in My account → Saved places. A visitor with a used ticket or a
completed stay at a place may review it once (1 to 5 stars and optional text,
up to 600 characters), and edit or delete their own review. A destination page
shows the average, the number of reviews, how many gave each number of stars,
and the list; Home's and the officer's Destinations cards show the rating. The
Tourism Officer's new Reviews page hides or unhides a review, always with a
reason, kept in a new table `review_changes` (32 tables in all). Hidden reviews
leave the public page and the rating. Managers cannot reply. Ratings and counts
only, never money.

**Change in the manuscript:** use cases — Tourist: Save a place, Write a
review, Edit or delete own review; Tourism Officer: Hide or unhide a review;
ERD and data dictionary: `saved_places`, `reviews` (rating 1–5, body ≤ 600,
status visible | hidden, hidden reason, by and when, the ticket or booking that
proves the visit, one per visitor per place) and `review_changes` (review,
action hidden | shown, reason, by, at). Security: the server checks the visit
on every review; only the officer can hide. Screenshots: a destination's
Reviews panel, the review form, Home's card with its rating and heart, the
officer's Reviews page with the reason dialog.

## No public ticket and booking search (9 November 2026)

**The change.** "My ticket or booking", where anyone with a code and its
email could open a ticket or booking, is gone. A visitor signs in and opens
their own from My account ("Move or cancel"); the server opens a ticket or
booking only for the account that holds it. Emails link there through Sign in.
Tickets and bookings made as a guest before accounts join the account that
signs in with their email.

**Change in the manuscript:** wherever the Manage / "My ticket" page is
described as opened with the code and email, say it is opened from My account
after signing in; the header and footer say "My account". Security: no public
lookup of tickets or bookings. Screenshot: Move or cancel.

## Visitor accounts (November 2026)

**The change.** Visitors now have accounts (the panelist's request), with
the role Tourist. They sign up with email and password (the email confirmed by
an emailed link) or with Google. Signing in is required to buy a ticket or book
a room; the name, email and phone come from the account. Tickets and bookings
made earlier with the same email are joined to the account. The account keeps
saved places and, later, reviews. A visitor may delete the account: the name,
email, phone and password are erased; past tickets and bookings stay under the
one-year rule, and reviews stay as "Former visitor". Four new tables (31 in
all).

**Change in the manuscript:** reverse every sentence saying visitors have no
accounts or browse without signing in only (Scope, Definition of Terms, users:
Tourism Officer, Enterprise Manager and Tourist); add the Tourist to the use
case and context diagrams; add `visitors`, `visitor_tokens`, `saved_places` and
`reviews` (and `visitor_id` on tickets and bookings) to the ERD and data
dictionary; security (a separate visitor sign-in, Google sign-in checked on the
server, email confirmation); Limitations (signing in is required to buy or
book, which is harder on weak signal or in a hurry); Data Privacy (accounts kept
until the visitor deletes them). Screenshots: Sign in (with Continue with
Google), Create an account, Check your email, My account (its six tabs: My
tickets, My bookings, Saved places, My reviews, Profile, Security), the header's
Sign in and account menu, and the room form's "Your details" filled from the
account.

## Room booking: the complete module (9 November 2026)

Everything below is built and on `main`: the database and API (8 November),
the manager's Rooms and Bookings, the visitor's Book a room and My ticket or
booking, check-in into the Guest Register, and the officer's Bookings
overview. The earlier entries below give the detail of each step.

**New module for the manuscript.** *Room Booking*: a visitor asks a private
place to stay for rooms on given dates; the resort's Enterprise Manager
confirms or declines by hand; payment stays between guest and resort; at
check-in the guests are counted in the Guest Register, which feeds the monthly
Form A4 report. The Tourism Officer sees counts per enterprise and month and
can pause an enterprise's bookings, but never money or a guest's details.

**Use cases** (actor: use case).
- Visitor: Request a room (choose dates and guests, see only the rooms free,
  give details, get a booking code); Manage a booking (find by code + email,
  see the status and, once confirmed, how to pay; ask for new dates; cancel by
  the resort's deadline).
- Enterprise Manager: Manage room types (add, edit, price, rooms, photo,
  retire); Block dates; Set booking rules (take bookings, answer time,
  check-in/out times, nights, how far ahead, free cancellation, how to pay);
  Answer a request (confirm, decline with a reason, adjust the price with a
  reason); Record a payment; Check in / check out / mark no-show; Count the
  guests in the Guest Register (filled from the booking; male and female added
  by the manager).
- Tourism Officer: View the bookings overview (counts per enterprise and
  month); Pause or resume an enterprise's bookings.
- System (daily and as bookings are read): Remind the resort halfway through
  the answer time; Expire an unanswered request; Erase a guest's details a
  year after check-out.

**ERD** (new entities and links; one-to-many unless said).
- SPOT 1 — 0..1 ENTERPRISE_BOOKING_SETTINGS (spot_id is its key)
- SPOT 1 — n ROOM_TYPE; ROOM_TYPE 1 — n ROOM_BLOCK
- SPOT 1 — n BOOKING; RESIDENCE 1 — n BOOKING (country_code)
- BOOKING n — n ROOM_TYPE through BOOKING_ROOM (units, rate_per_night)
- BOOKING 1 — n BOOKING_CHANGE; BOOKING 1 — n BOOKING_PAYMENT
- BOOKING 1 — 0..1 REGISTER_ENTRY (register_entries.booking_id, unique)

**Data dictionary** (PK primary key, FK foreign key; every table also has
created/updated times where shown).

| Table | Column | Type | Meaning |
|---|---|---|---|
| enterprise_booking_settings | spot_id | text PK, FK spots | The place to stay |
| | accepts_bookings | boolean | The manager takes requests |
| | paused_by_office | boolean | The Tourism Officer's pause |
| | response_hours | integer 1–72 | Time to answer a request |
| | check_in_time, check_out_time | time | The resort's times |
| | min_nights, max_nights | integer 1–60 | Shortest and longest stay |
| | advance_days | integer 1–730 | How far ahead a stay may start |
| | free_cancel_days | integer 0–60 | Days before check-in that changes close (at least 1) |
| | payment_instructions | text | How guests pay the resort; required to take bookings |
| | updated_by_email | text | Who last changed it |
| room_types | id | text PK | |
| | spot_id | text FK spots | |
| | name, description | text | |
| | beds, max_guests | integer | Beds; guests per room |
| | base_rate | numeric | Price per night (₱) |
| | units | integer | How many rooms of this type |
| | photo_url | text | |
| | active | boolean | Retired types stay, inactive (never deleted) |
| | position | integer | Display order |
| room_blocks | id | text PK | |
| | room_type_id | text FK room_types | |
| | starts_on, ends_on | date | First and last night out of booking |
| | units | integer | Rooms blocked |
| | reason, created_by_email | text | |
| bookings | id | text PK | |
| | code | text, unique | Booking code shown to the guest (e.g. CC-SXDM9S) |
| | spot_id | text FK spots | |
| | guest_name, email, phone | text | Erased a year after check-out |
| | country_code | text FK residences | Country of residence (Form A4 row) |
| | adults, children | integer | |
| | check_in, check_out | date | |
| | nights | integer, generated | check_out − check_in |
| | status | text | requested, confirmed, checked_in, completed, declined, expired, cancelled, no_show |
| | total_amount | numeric | Worked out by the server from the rates |
| | note | text | The guest's note; erased with the details |
| | requested_at, expires_at, reminder_sent_at | timestamptz | The answer deadline and reminder |
| | decided_by_email, decided_at, decline_reason | | Who answered, when, why declined |
| booking_rooms | booking_id, room_type_id | text PK/FK | |
| | units | integer | Rooms of that type |
| | rate_per_night | numeric | The rate when booked (kept) |
| booking_changes | id | text PK | |
| | booking_id | text FK bookings | |
| | action | text | requested, confirmed, declined, price_adjusted, moved, cancelled, payment_recorded, checked_in, completed, no_show, expired |
| | before, after | jsonb | Status, dates, guests, total — never a guest's name, email or phone |
| | by_email, at | | Who and when |
| booking_payments | id | text PK | |
| | booking_id | text FK bookings | |
| | amount | numeric | What the guest paid the resort |
| | method | text | cash, gcash, maya, bank, card, other |
| | received_on | date | |
| | reference, recorded_by_email | text | |
| register_entries (changed) | booking_id | text FK bookings, unique, nullable | The booking a Guest Register entry was counted from |

27 tables in all.

**Wording to use in the manuscript.** "Room booking" (the module); "Book a
room" (the visitor's button); a booking is a **request until the resort
confirms**; the guest **pays the resort directly** (never "pay online" for
rooms); "My ticket or booking" (never "Manage my ticket"); "Enterprise
Manager" and "enterprise" (never "establishment"); "checked in" is when guests
are **counted**, through the Guest Register — a booking itself is never a
visitor count.

**Limitations to state.** Payment for rooms is outside the system; version 1
has blocked dates only, no seasonal rates; email only, no SMS; the resort
confirms by hand; expiry relies on the daily run and on bookings being read
(Vercel Hobby's cron is daily).

## Room booking at private places to stay (November 2026; database and API)

**The change.** A visitor can ask a private place to stay for rooms on given
dates. The resort's Enterprise Manager confirms or declines by hand; an
unanswered request expires after the resort's response time (a reminder goes
halfway). The server works out the price; payment stays between the guest and
the resort (ZTIMS shows the resort's payment instructions and the manager may
record what was received). The guest manages the booking with its code and
email, like a ticket. The Tourism Officer sees counts per enterprise and can
pause one. A booking is not a visitor count: guests are counted through the
Guest Register entry saved at check-in. Guests' names, emails and phones are
erased a year after check-out. Seven new tables (27 in all).

**Change in the manuscript** (once the pages are built): the scope (room
booking for private places to stay, confirm by hand, no online payment for
rooms), the data dictionary (the seven tables), the use cases (request, confirm
or decline, move or cancel, record payment, check in, pause), the Limitations
(payment outside the system; no seasonal rates; email only, no SMS).

**The manager's pages are built** (November 2026): Rooms (room types with
price, rooms and photo; blocked dates; booking settings) and Bookings (an inbox
with "Needs your answer" and each request's deadline, Confirm, Decline with a
reason, Adjust price, Record payment, Check in / Check out / No-show, and a
month view of rooms free and taken). The System User Interface section gains
these two screens (screenshots from the manager portal, desktop and phone);
the use cases above can now point to them. The email's Review request button
opens the request after signing in.

**The visitor's pages are built** (9 November 2026): on a place to stay's page,
Book a room opens a four-step window (Dates and guests, Rooms — only the rooms
free for those dates, with the price per night and the total — Your details,
Sent with the booking code); no payment step, and the resort's payment
instructions appear only after it confirms. "My ticket" is now **"My ticket or
booking"** everywhere (the header, the footer, Home): the same code + email
finds a ticket or a booking, and a booking can be moved or cancelled until the
resort's deadline. Home's card says Book a room for resorts taking bookings.
FAQ (a Room bookings section), Terms (section 4 is now "Entrance tickets and
room bookings") and Privacy (what a room request collects, that the resort
sees it, erased a year after check-out) are updated, dated 9 November 2026.
In the manuscript: the visitor use case "Request a room" and "Manage a
booking", the System User Interface screenshots of the window's four steps and
of My ticket or booking, and every "Manage my ticket" in the text becomes "My
ticket or booking". (The officer's overview is now built: see "Room booking:
the complete module".)

## Announcements and calendar of events (November 2026)

**The change.** The Tourism Officer posts announcements (advisory, event,
closure or general) with a start and end in Manila time, an optional place and
photo, and the text in English plus Filipino or Bisaya. There is no approval
step: a notice is live when saved, leaves the website after its end, and is
never deleted (the officer can hide it and show it again). The officer works on
one page with two tabs, Announcements and Calendar of events. Visitors get two
new pages, Announcements and Calendar of events (with Add to calendar), a "What
is happening in Zamboanguita" section on Home, and a notice line on the
destination it concerns. No Facebook feature.

**Change in the manuscript:** add the module to the system's features, scope
and the officer's functions; add the `announcements` table to the ERD and data
dictionary (20 tables); add the officer's page and the two public pages to the
System User Interface (screenshots: officer Announcements and Calendar tabs,
public Announcements, public Calendar of events, Home's new section, a
destination with a notice line); the visitor header now has Announcements and
Events links.

## Count visitors here (November 2026)

**The change.** Visitor counting applies to places that receive and record
visitors. The Tourism Officer can switch off "Count visitors here" for a place
the office runs that has nothing to count, such as a statue or a marker. It
stays on the site and the map, but it leaves the monthly report tracker, the
report and Guest Register lists and Form A4's arrivals by place, so it is never
shown as "missing". A private enterprise always counts. A place that already
has reports or register entries stays counted; nothing is deleted.

**Change in the manuscript:** where the statistics module says every
destination submits a monthly report, add: "Visitor counting applies to places
that receive and record visitors; the Tourism Officer marks office-run places
with nothing to count, such as monuments, as not counted." Screenshot: the
listing form's Visiting step (the switch) and a Destinations card with "Not
counted".

## One manager, many enterprises (November 2026)

**The change.** The panel asked that one Enterprise Manager be able to run
several private enterprises. The account is now the person; each enterprise is
its own listing with its own name, phone and public email. A manager signs in
once, sees My enterprises, picks the one to work on from a switcher in the
header, and can add another at any time (it goes live at once, with no limit).
The officer creates a manager account without any enterprise.

**Change in the manuscript:** wherever it says an enterprise manager manages
"an enterprise" or "a listing" (one each), say the manager may run one or more
enterprises. The manager's menu is now My enterprises, Enterprise, Guest
Register, Monthly Report, Account. Screenshots to retake: the manager's header
(switcher), My enterprises, and the officer's Enterprise Managers (a manager's
enterprises under their name and "New manager account" without an enterprise
name). Statistics are unchanged: reports are still filed per place.

## The conceptual and theoretical framework figures are saved here (November 2026)

**The change.** Nothing in the system. The two framework figures, which lived
only on an old branch, are now in `docs/diagrams/`:
`ztims-conceptual-framework.png` (and its editable `.drawio`) and
`ztims-theoretical-framework.png` (destination management and marketing
framework, replacing the system theories).

**Change in the manuscript:** the conceptual framework's editable file still
says "Establishment" once; change it to "Enterprise" to match the rest of the
paper before it is used again.

## New Destination, History and Staff sign in pages (November 2026)

**The change.** Three more pages follow the group's UX Pilot designs:
- **Destination:** a rounded photo; the category, name and barangay under
  it, with Directions and Buy tickets on the right; tinted "at a glance"
  tiles; About beside a "Getting there" card (address, emergency numbers, Get
  directions); a photo grid; and "Nearby places to visit" cards showing each
  place's opening hours and price. The breadcrumb was removed.
- **History:** the story without the photo; the municipal facts as tiles;
  "Where it is" and "The barangays" side by side with their headings; the
  town fiesta as a dark orange band.
- **Staff sign in:** the coast on the left, the sign-in card on the right,
  with "Forgot password?" beside the Password label.
Nothing behind the pages changed.

**Change in the manuscript:** retake the screenshots of the Destination page
(and the ticket window over it), the History page and the Staff sign in page
in the System User Interface, and describe them in the order above.

## A new Home page, header and footer (October 2026)

**The change.** The Home page was rebuilt from the group's UX Pilot design: a
rounded hero with a new film, "Popular" places and one featured place; a
moving strip of what is here; "Browse by interest" (four big category photos
and four small cards); "Featured destinations" with category pills and "View
all destinations"; the map with its legend and "Open full map"; and "Plan
your visit" (three step cards and the Tourism Office card). Every visitor page
now has the same floating header (with a Buy tickets button) and the new
footer. Nothing behind the pages changed: the same places, tickets, map and
office details.

**Change in the manuscript:** retake the Home page screenshots in the System
User Interface (the Home figure, and any figure showing a visitor page's
header or footer), and describe Home in the order above. The design was made
in UX Pilot; say so where the manuscript names its design tools.

**If the panel asks why the visitor pages look different from the staff
portals:** "The visitor pages are for tourists, so they follow a more visual
design made in UX Pilot. The staff portals are work tools and keep their plain,
square layout. Both use the same colours, and the same records behind them."

## The tour guide feature is removed (October 2026)

**The change.** ZTIMS no longer has anything for tourist guides: no Tourist
Guide user or sign-in, no guide portal (dashboard, schedule, languages,
profile, reports), no Tourist Guides or Guide Bookings page for the officer, no
"Book a guide" for visitors, and no "requires a tourist guide" setting on a
listing. The guide records and guide bookings, and the payments made for those
bookings, were deleted from the database. What visitors pay for online is
entrance tickets only; "My booking" in the visitor menu is now "My ticket".
The users are two: the Tourism Officer and the Enterprise Manager, plus
visitors without accounts.

**Change in the manuscript:** take out the Tourist Guide as a user (Scope,
Operational Definition of Terms, use case and context diagrams, the ERD's
guide, guide booking, guide report and language tables, the data dictionary),
the guide booking and guide payment from the visitor's process and the
Collections description ("guide fees"), and the guide module from the testing
chapter. Wherever it lists three kinds of staff account, write two.

## "Enterprise", not "establishment", everywhere (October 2026)

**The change.** At the panel's suggestion, every place a manager runs is an
**enterprise**, never an "establishment", in the system and in the
manuscript. The role is the **Enterprise Manager** (was Establishment
Manager); the manager's menu reads **Enterprise**; the officer's page is
**Enterprise Managers**; a place the Tourism Office does not run is a
**private enterprise**, shown "Private enterprise" in Statistics, the Guest
Register and the Excel's "By place" sheet, and Destinations filters by
"Tourism Office" and "Private enterprises". FAQ, Terms, Privacy and every
message say enterprise too. (Only names inside the code and database, which
nobody sees, keep the old word.)

**Change in the manuscript:** replace "establishment" with "enterprise"
throughout: "Establishment Manager" → "Enterprise Manager", "tourist
establishment" → "tourist enterprise", "private establishment" / "privately
managed establishment" → "private enterprise", "accommodation
establishment" → "accommodation enterprise", including the use case and
context diagrams, the Operational Definition of Terms and the user manual.

## Tourist guides have no area (October 2026) — superseded: tour guides were removed, see above

**The change.** A tourist guide is no longer set to "the whole municipality"
or "one barangay". Where a guide works is the destinations the Tourism Officer
gives them; a booking can only go to a guide who serves that destination. The
guide's dashboard counts the tours at their destinations. Guides' reports are
still grouped by barangay for the officer, taken from the destination of the
tour.

**Change in the manuscript (rev11 wording):**

- Scope and Limitation, Scope paragraph:
  - was: "Tourist Guides, each assigned to the whole municipality or to one
    barangay, update their availability and languages, view assigned tours,
    and submit tour reports."
  - now: "Tourist Guides, each assigned by the Tourism Officer to the
    destinations they guide, update their availability and languages, view
    assigned tours, and submit tour reports."
- Operational Definition of Terms, Tourist Guide:
  - was: "An authenticated user, assigned to the whole municipality or to one
    barangay, who updates availability and languages, views assigned tours,
    and submits tour reports through the system."
  - now: "An authenticated user, assigned by the Tourism Officer to the
    destinations they guide, who updates availability and languages, views
    assigned tours, and submits tour reports through the system."
- System User Interface:
  - Figure 22 (Tourist Guides): say "destinations" where it said "area (the
    whole municipality or one barangay)".
  - Figure 26 (Tourist Guide Dashboard): the dashboard counts "the tours at
    the guide's destinations", not "only their barangay".
  - Figure 12 (Booking a Tourist Guide): the guide card no longer shows
    "Whole municipality".

**If the panel asks why there is no barangay or municipal guide:** "Where a
guide works is already decided by the destinations the Tourism Officer
assigns. A separate area would say the same thing twice, and the two could
disagree. One Tourist Guide role; the destinations decide where each guide
works."

## Tickets have no senior citizen or PWD price (October 2026)

**The change.** The 20% senior citizen and PWD discount was taken out.
Tickets count regular visitors, plus students and children where the office
sets a price for them.

**Change in the manuscript:** any sentence about "Regular, Senior citizen,
and Person with disability" or "a 20% discount for senior citizens and persons
with disability" (rev11 had it only in the old Destination Page figure text,
which the new System User Interface section replaces). Figure 11's text:
"Student and Child rows appear only where the office has set a price for
them."

## Earlier October 2026 changes the manuscript already reflects (rev10–rev11)

- Tickets have no QR code; the visitor shows the ticket code, and the office
  can click Mark used where nobody stands at the entrance.
- Guide bookings: confirm first, pay later (the office confirms within one
  working day; the visitor is reminded the day before).
- A seventh category, Leisure & Recreation (pools, water parks, parks).
- Online payment is a demonstration in Xendit's test mode only.

## Chapter IV diagrams revised (12 November 2026)

Figures 4 to 8 were redrawn on the panel's advice (fewer outside services; users, processes and data only):
context flow diagram (four users, no external services), top level diagram (five processes, only the four
shared data stores), ERD (17 core entities in the panel-approved box-and-line format), use case diagram
(four actors, shared Log In) and system architecture (portrait tiers, ten numbered connections).
The new Table 10, Connections in the System Architecture, moves Software, Hardware and Network
Requirements to Tables 11 to 13. Replacement text: docs/manuscript/chapter-iv-diagrams-revised.docx.

## Executive Summary redone (12 November 2026)

Rewritten in the panel-approved four-column format (Problem, Findings, Conclusions, Recommendations), one row
per SOP with the SOP's full wording and sub-items. Study numbers unchanged from rev12; conclusions and
recommendations follow the current system (Support Staff, generated reports and DOT forms).
File: docs/manuscript/executive-summary-revised.docx.
