# Accommodation reporting: field and calculation mapping

Stage 1 (review only). No production code, live database or deployment was changed.
Scope: private places to stay (`spots.type = 'accommodation'` with a manager). Attractions are separate and out of scope.

## 1. Sources and how far they were verified

| Source (file supplied) | Pages | Read how |
|---|---|---|
| DAE-1A, Monthly Recording Format for Accommodation Establishment | 1 | Text layer, full |
| DAE-1B / DAE-2 (2019) MANUAL | 3 (p.1 Part I days 1–31, p.2 continuation, p.3 end of Part I, Part II, volume per sex, footnote) | Text layer, full |
| DAE-1B v4a Daily-Sum-Monthly AUTOMATED | 19 (three monthly sheets starting p.1, p.4, p.8; summary and Part II labels on pp.3, 7, 10–11; remaining pages are daily sheets) | Text layer, labels checked on every sheet |
| FORM A v3 (annual) | 6 (pp.1–3 blank template, pp.4–6 worked example) | Text layer, full |

**Not verified.** The DOT-JICA Tourism Statistics Manual and the PSA pages could not be fetched (`www.locjkt.or.id` and `www.psa.gov.ph` do not resolve from this environment). Any statement below about what those documents say is marked *unverified*. Allow those hosts and the check can be redone.

## 2. Terms the templates use, and what ZTIMS means by each

| Term | Meaning in this design | Template reference |
|---|---|---|
| Arrival (guest check-in) | One guest, counted once, on the check-in date | DAE-1A col. (5), p.1 |
| Guest-night | One guest sleeping one night. Counted for each date D with `check-in ≤ D < check-out` | DAE-1A col. (6), p.1 |
| Room (physical) | A numbered room in the enterprise's room list | DAE-1A item (4), p.1 |
| Rooms occupied (night) | Distinct rooms holding at least one guest that night | DAE-1A col. (7), p.1 |
| "Rooms occupied" (DAE-1B Part II item 1) | **Room-nights** occupied: the sum of col. (7) over the month. The template label reads like a count of rooms; it is a total over nights | DAE-1B p.3, v4a pp.3/7/10 |
| "Rooms available for the month" | **Room-nights** available: Σ over days of rooms that can be sold | DAE-1B p.3 |
| Residence | Where the guest lives. Philippine residents are split by nationality (Filipino or foreign). Non-residents are by country of residence | DAE-1B Part I p.1 and 3 |
| Nationality | Only used for Philippine residents (Filipino / foreign) | DAE-1B Part I |
| Overseas Filipino | Philippine passport holders permanently residing abroad. **Excludes overseas Filipino workers.** Shown as a separate line, not under a country | Footnote, DAE-1B p.3; FORM A p.3 |
| Missing | No record where one is expected | — |
| Actual zero | A record exists and the value is 0 | — |
| Not applicable (N/A) | The enterprise was not operating (every day of the month inside a closed period) | — |

## 3. Output mapping

Every output is computed from stays. Nothing is typed twice.

### 3.1 Stay record (input)

| Field | Unit / type | Required | Rule |
|---|---|---|---|
| Enterprise | listing id | Yes | Every stay belongs to one enterprise; a manager can only write their own |
| Check-in date | date | Yes | Not after today. A booking, reservation or ticket is not an arrival |
| Check-out date | date | Yes | At least one night after check-in. Night of check-out is not counted |
| Room allocation | list of (room number, from, until) | Yes | Every night has at least one room; room not taken by another stay, not out of service, not in a closed period. A transfer splits the list and adds no arrival |
| Guest groups | list of (residence class, country, male, female) | Yes | Residence class one of: Philippine resident Filipino, Philippine resident foreign national, non-Philippine resident (country required), overseas Filipino, residence not stated. Male + female is the group total. Counts are whole numbers ≥ 0, at least one guest in all |
| Change log | action, detail, reason, date, role | Auto | Every edit adds a row |
| Name, contact, ID | — | **Never** | Not stored in any statistical record |

### 3.2 DAE-1A daily register (view)

| Output | Source | Date rule | Aggregation | Template |
|---|---|---|---|---|
| (4) Total number of rooms | rooms available-from / until | rooms active on the last day of the month | count | p.1 |
| Room grid cell | allocation | occupied on date D if `from ≤ D < until` | mark per room per day | p.1 (Room identification) |
| (5) Guests checked in | guest groups | `check-in = D` | Σ male + female | p.1 |
| (6) Guests staying overnight | guest groups | `check-in ≤ D < check-out` | Σ guests | p.1 |
| (7) Rooms occupied | allocation | distinct rooms that night | count | p.1 |
| Rooms available (extra, not on the form) | room list, out of service, closed periods | rooms active − rooms out of service; 0 on a closed day | count | — |
| Average guest-night | Σ(6) ÷ Σ(5) | month | ratio | p.1 formula |
| Average room occupancy rate | Σ(7) ÷ rooms available in the month | month | ratio | p.1 formula |
| Average guests per room | Σ(6) ÷ Σ(7) | month | ratio | p.1 formula |

### 3.3 DAE-1B / DAE-2 monthly (view, then saved as a version)

| Output | Source | Date rule | Aggregation | Required | Template |
|---|---|---|---|---|---|
| Header: type of accommodation, DOT classification, AE ID code, municipality, province, region | statistical profile | — | — | Type required; DOT, AE ID optional | manual p.1; v4a p.1 |
| Part I rows, Philippine residents: Filipino nationality, Foreign nationality | guest groups | check-in month | Σ male, female, total | Rows always listed | p.1, 3 |
| Part I rows, non-Philippine residents by country | guest groups with a country | check-in month | Σ | Rows with no arrivals hidden on screen, all rows in the export | p.1–3 |
| Overseas Filipinos* | guest groups of that class | check-in month | Σ | Always listed | p.3 |
| Guests with unspecified residence | guest groups of that class | check-in month | Σ | Always listed | p.3 |
| Grand total guest arrivals | all rows | check-in month | Σ | — | p.3 |
| Part I by day (manual layout, columns 1–31) | guest groups | check-in date | Σ per row per day | Optional view | manual p.1–3 |
| Part II 1. Rooms occupied | Σ(7) | nights in the month up to the last night that has happened | Σ room-nights | Yes | p.3 |
| Part II 2. Rooms available for the month | rooms and out of service | same nights | Σ room-nights | Yes | p.3 |
| Part II 3. Total guest nights | Σ(6) | same nights | Σ | Yes | p.3 |
| Average monthly occupancy rate | item 1 ÷ item 2 | month | ratio, shown as a percentage | Template requires | p.3 |
| Average length of stay (nights) | item 3 ÷ arrivals | month | ratio | Template requires | p.3 |
| B. Volume per sex: a Philippine residents, b non-Philippine residents, c overseas Filipinos, d others / unspecified | guest groups | check-in month | Σ male, female | Yes | p.3, v4a p.11 |

### 3.4 Enterprise annual DAE-1B (summary)

Built from each month's **latest submitted version**, never from the live register. Months without a version show "–" (missing, in progress or not recorded) or "N/A" (not operating). Annual rates are ratios of sums over the reported months: annual occupancy = Σ room-nights occupied ÷ Σ room-nights available; annual length of stay = Σ guest-nights ÷ Σ arrivals. The page says when the year is incomplete and lists the reason for each month.

### 3.5 Municipal FORM A (annual)

| Output | Source | Rule | Template |
|---|---|---|---|
| January to December columns | latest submitted version of each enterprise-month, summed. 2025 is the imported municipal total | Enterprises without a version are not counted and not estimated | FORM A p.1–3 |
| Total (current year) | Σ of the months | — | p.1 |
| % share from total arrivals | row total ÷ grand total arrivals | n/a when the grand total is 0 | p.1 |
| Total (previous year) | previous year's row total | Offered as "full year" (as printed) and "same months only". The default is the printed form; the page never switches silently | p.1 |
| % difference | (current − previous) ÷ previous | **n/a when previous is 0** (the sample prints `#DIV/0!`, p.4) | p.1; example p.4 |
| Part II: rooms occupied, rooms available, total guest-nights, average occupancy rate, average length of stay | same Σ | ratios of sums | p.3 |

## 4. Residence classification used in stays

| Class | Part I row | Volume per sex line |
|---|---|---|
| Philippine resident, Filipino nationality | Philippine residents, Filipino nationality | a |
| Philippine resident, foreign nationality | Philippine residents, Foreign nationality | a |
| Non-Philippine resident, country X | Country X row | b |
| Overseas Filipino | Overseas Filipinos* | c |
| Residence not stated | Guests with unspecified residence | d |

Database `residences` already has `ph-filipino`, `ph-foreign`, `overseas-filipino`, `unspecified` and ISO country codes, so no new reference table is needed. The database has 72 rows. The 2019 templates list fewer countries (UNVERIFIED count; the PDF text lists several regional groups plus "Others and unspecified residences"). Export maps ZTIMS rows to the template rows.

## 5. Counting conventions

Confirmed by the user: arrivals once at check-in; nights allocated to the dates actually occupied, excluding the check-out night; a room transfer creates no new arrival; follow template formulas but explain their limits; never swap a period measure for a cohort measure.

Flagged for confirmation (defaults used in the mockup):

| # | Question | Default | Why it matters |
|---|---|---|---|
| C1 | Is the check-out night counted? DAE-1A note: guests are counted "until the day he checks out" | Exclude the check-out night | Changes every guest-night and occupancy figure by one night per stay |
| C2 | A guest who joins or leaves part-way through a stay | Record as a separate stay | One stay has one set of dates |
| C3 | Day-use, same-day check-out | Refused (at least one night) | Zero-night stays have no guest-night |
| C4 | Are out-of-service nights taken off "rooms available"? | Yes | Template says "available" without defining it |
| C5 | Month still running | Figures through the last night that has happened; submit after month end | The current code allows submitting in the month |
| C6 | Country of residence for overseas Filipinos | Not asked | The template has no row for it |
| C7 | Region label on exports | Tourism Office to confirm. The code says "Region VII". Negros Oriental is now in the Negros Island Region (RA 12000, 2024; from web search, unverified against PSA) | Printed on every export |
| C8 | Country list | Keep the database's 72 rows, map to the template rows | The two lists differ |

## 6. Why the length of stay needs a caution

Average length of stay = guest-nights ÷ arrivals in the same month. A guest arriving on 29 October has an arrival in October and nights in both October and November. October's figure then holds three of five nights, November's holds nights with no arrival. This is a period measure. It is not the average length of completed stays, and it is not the average of the monthly values. The mockup says this next to the figure. A cohort measure (average of completed stays by check-in month) would give different numbers and is not offered unless the Tourism Office asks for it.

## 7. Contradictions between the templates, the current code and CLAUDE.md

| # | Where | Contradiction | Resolution in the new design |
|---|---|---|---|
| 1 | CLAUDE.md "Tourism statistics" | "Counts and totals only. No percentages anywhere" | The templates require occupancy rate, average length of stay, % share and % difference. Those are shown. Revenue stays out. The rule is rewritten |
| 2 | CLAUDE.md "Arrivals are arrivals at places" | Part I adds attractions and places to stay together | Accommodation only. Attractions reported separately later |
| 3 | `statistics.js` PUT report | Rejects "guest nights but no guests" | Invalid for a month holding only guests who arrived earlier. Rule removed. Guest-nights ≥ arrivals holds by construction (the check-in night is in the check-in month) |
| 4 | Monthly report | Hand-typed, unlinked to the register | Generated from stays |
| 5 | Local test | Extending a stay changed the register's November guest-nights 6 → 10 while the saved report stayed 5, with no flag | Differences shown against the submitted version |
| 6 | Submitted report | A manager's edit overwrites it; history has only created/updated rows | Numbered versions. A version never changes |
| 7 | Lock | Officer locks a month range for every place at once | Finalize and Reopen per enterprise and month |
| 8 | Register | A manager could still add a stay inside a finalized month | Finalize locks the month's register for stays touching it |
| 9 | `monthly_reports.rooms` | One number for the month | Numbered rooms, dated availability |
| 10 | `register_entries.rooms` | A count, not room identities | Allocation per room per date; transfers |
| 11 | Part II "Rooms occupied" | Reads as a room count | It is room-nights. Mockup labels it "Rooms occupied (room-nights)" and keeps the form's label in the export |
| 12 | Template vs code | `residences` 72 rows vs about 65 on the 2019 forms | Map on export (C8) |
| 13 | `statistics-excel.js` | Hard-codes "Region VII" and "FORM A4" | Region from office settings; FORM A and DAE-1B titles as on the templates |
| 14 | 2025 import | Printed March grand total 1,568 vs rows 1,558 | Rows kept; discrepancy noted on screen |
| 15 | FORM A sample p.4 | Prints `#DIV/0!` | Shows n/a |
| 16 | DAE-1A (7) vs room identity | Needs rooms; room types in booking only count units | New numbered rooms table; booking room types remain |
| 17 | Officer | Currently may enter or correct a monthly report as a backup | Not in this design: the officer views, finalizes, reopens. Needs the user's yes before the existing backup route is removed |
| 18 | `report_changes` | Free-form before/after JSON | Same table kept for stays and versions, with a role and a reason |
| 19 | Support Staff | Keep the attraction's register | Unchanged. Out of scope |
| 20 | Booking → register | `register_entries.booking_id` unique link | A booking never counts. A booking may prefill a stay at check-in; the stay is the record |
| 21 | Guest Register tiles | "Room-nights" from a room count × nights | From allocations |
| 22 | Open month | Report can be saved mid-month | Submitted after the month ends (C5) |
| 23 | DAE-1A highlight of check-in | The form highlights check-in cells; guests per room are not captured | Highlight kept; per-room guest counts optional, default off |
| 24 | Region on forms | "Region" blank on templates | Filled from office settings |
