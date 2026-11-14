> Current scope (14 November 2026): entrance sales and officer collections are retired. Room payments remain. Admission-related descriptions below are historical, not current behavior. See MANUSCRIPT-NOTES.md and diagrams/entrance-removal-redraw-list.md.

# Attraction reporting: source inventory and field mapping

Stage: proposal for review (12 November 2026). Nothing here changes code or a database.
Mockup: `mockup.html` in this folder (also published as an Artifact). Page images of the sources: `source-pages/`.

What the forms say, what ZTIMS proposes, and what is not verified are kept apart throughout. The supplied copies are reference material. They do not prove the current local mandate.

## 1. Page-by-page inventory

### 311485232-Visitor-Count-for-Tourist-Attraction-and-LGU.pdf (12 pages, A4 portrait)

| Page | Content | Notes |
|---|---|---|
| 1 | **VAR 1**, "Tourism Attraction Visitor Record". Header: Month/Year, Name of Municipality, Name of attraction/Spot, Type of Tourism Attraction. Left half of the grid: Day, Week Day (Mon-Sun), Place of Residence, Philippines: This province (Male, Female, Total), Other Province (Male, Female, Total). Days 1 to 28. | The weekday column is typed in the template (day 1 is "Tue"). The "Total" cells of the residence groups are formulas showing 0. |
| 2 | VAR 1 continued: days 29 and 30, then "Total of this Month ****". Note: "*Total number must be recorded, ** Sex & ***Residence entries are optional. Total number of this month must be reported." | The grid ends at day 30. No day 31 row exists. The note has three asterisk keys but the total row is marked `****`, which no note explains. |
| 3 | VAR 1, right half of the same table: Foreign Country Residence (Male, Female, Total) and "* Grand Total Number of Visitors" (Male, Female, Total), days 1 to 28. Label "(VAR 1)". | Continuation of page 1 columns. |
| 4 | VAR 1 right half: days 29 and 30 and the monthly total row. | |
| 5, 6, 9 | Blank. | |
| 7 | **VAR 2** example: same title and header, "January- December 2012", municipality "San Antonio, Northern Samar". Rows: an attraction name, then January to December, then Attraction 2, 3, X. Columns start with Attraction Code, This province, Other Province. "Prepared by / Noted by" lines. | Despite the monthly wording of the title, the rows are months. |
| 8 | VAR 2 right half: Other Province total, Foreign Country Residence, Grand Total Number of Visitors. | |
| 10 | **VAR 3M**, "Annual Report on Same Day Visitors by Attraction". Municipality, Province, Period. January to December down the side; per attraction Domestic, Foreign, Total, for Attraction 1 and 2. Total row. | |
| 11 | VAR 3M continued: Attraction 3 and N, "Grand Total Visitors" Domestic and Foreign. | |
| 12 | VAR 3M: Grand Total "Total Visitors" column. | |

### 826073915-DTA2M-1.pdf (2 pages, A4 landscape; one table split across both)

| Page | Content |
|---|---|
| 1 | Title "Tourism Attraction Visitor Record", Month/Year, Name of Municipality. One row per attraction: Name, Attraction Code. Place of Residence, Philippines: **This Municipality**, **This Province**, **Other Province** (each Male, Female, Total), Foreign Country Residence (Male, Female, ...). Rows "Attraction 1, 2, 3, X". Green "Total of this Month ****" row. Same footnote as VAR 1. |
| 2 | Continuation: Foreign Country Residence Total, Grand Total Number of Visitors (Male, Female, Total). Label "DTA2M". |

### 943932239-Same-Day-Visitors-2019-Bataan.pdf (4 pages, letter; optional reference only)

A populated provincial consolidation for 2019. Its residence classes are "This Municipality", "Other Municipality" and "Foreign Country Residence", not DTA2M's three Philippine classes. Its attraction codes are three-digit numbers with no legend in the file. Several rows carry a total with empty or zero sex columns, and some a total larger than the sum of the residence columns. Its data is not copied, and it is not the municipal annual template. It shows only that incomplete breakdowns occur in practice.

## 2. How the forms relate

| Form | Scope | Period | Relationship |
|---|---|---|---|
| VAR 1 | One attraction | One month, by day | **The recording form.** Source of daily counts. |
| DTA2M | All attractions of the municipality | One month, one row each | Monthly consolidation of the VAR 1 monthly totals. |
| VAR 2 | One attraction (example shows several) | One year, one row per month | The annual view of the same VAR 1 monthly totals. **Not a separate encoding step.** |
| VAR 3M | All attractions | One year, months down, Domestic/Foreign/Total | Annual municipal summary of the same monthly totals. |

ZTIMS role of VAR 2: a generated view (mockup: Attraction Visits, Per attraction). Nothing is typed into it.

## 3. Proposed internal classes (decision D3 confirms DTA2M's meaning)

| Internal class (mutually exclusive) | VAR 1 | DTA2M | VAR 3M |
|---|---|---|---|
| Zamboanguita | This province (with the next) | This Municipality | Domestic |
| Rest of Negros Oriental | This province | This Province (if DTA2M means "outside the municipality") | Domestic |
| Other Philippine provinces | Other Province | Other Province | Domestic |
| Foreign countries | Foreign Country Residence | Foreign Country Residence | Foreign |
| Not recorded | not on the form | not on the form | not on the form |

DTA2M lists both This Municipality and This Province without defining the overlap. If the office means "This Province includes the municipality", DTA2M's This Province = Zamboanguita + rest of Negros Oriental, with no change to what is stored.

"Residence" means usual residence, not nationality or passport.

## 4. Field mapping

Legend: **I** input, **C** calculation from the daily record, **E** export only, **N** not collected.

| Form field | Where | ZTIMS | Type |
|---|---|---|---|
| Month/Year | VAR 1, DTA2M | Selected month | C |
| Name of Municipality, Province | all | Zamboanguita, Negros Oriental (constants, as on listings) | C |
| Name of attraction/Spot | VAR 1 | Assigned attraction's name | C (account assignment) |
| Type of Tourism Attraction | VAR 1 | Listing's category label | C |
| Attraction Code | VAR 1, DTA2M, VAR 2, VAR 3M | **Not in ZTIMS.** The office's code list is not supplied. Shown as "Code pending"; left blank in exports until the list is given | N, gap G6 |
| Day / Week Day | VAR 1 | Date and automatic weekday | C |
| Total visitors (daily) | VAR 1 "Grand Total, Total" | Required count. A confirmed 0 is allowed | **I** |
| This province / Other Province / Foreign, Total (daily) | VAR 1 | Zamboanguita and rest of Negros Oriental added, other provinces, foreign | **I** (four optional counts), residence completeness flag |
| Male, Female inside each residence group | VAR 1, DTA2M | **Not collected.** Left empty | N |
| Grand Total Male, Female | VAR 1, DTA2M | Overall male and female (optional), sex completeness flag | **I** |
| Total of this Month | VAR 1 | Sums over recorded dates | C |
| Per attraction row, month | DTA2M | Finalized monthly version | C |
| Domestic, Foreign, Total by month | VAR 3M | Domestic = Zamboanguita + rest of Negros Oriental + other provinces (known); Foreign (known); Total = confirmed total | C |
| Prepared by / Noted by | VAR 2 | Blank signature lines in the export | E |

Sex-by-residence: the forms have Male and Female under each residence group. ZTIMS records residence totals and overall sex totals separately. They are marginal totals and cannot give the cells. Those cells are left empty and never estimated. If the office needs them, a later "sex within residence" input can be proposed.

## 5. The scenario (fictional)

One attraction, one date: total 100; Zamboanguita 20, rest of Negros Oriental 30, other provinces 25, foreign 15; 10 residence unrecorded; sex unrecorded.
- Visitor total 100. Known domestic 75. Known foreign 15. **Unclassified 10.**
- VAR 1: This province 50, Other Province 25, Foreign 15, Grand Total 100. Male/Female empty. The 10 sit in a dashed ZTIMS note column outside the official grid.
- DTA2M: This Municipality 20, This Province 30, Other Province 25, Foreign 15, Grand Total 100.
- VAR 3M: Domestic 75, Foreign 15 (each marked `*`), Total 100. Domestic + Foreign is 90, not 100. The difference is on a ZTIMS note line under the table. It is never added to either column.

## 6. How incomplete data appears

| Situation | Daily record | VAR 1 / DTA2M | VAR 3M |
|---|---|---|---|
| Total only | Residence and sex unknown | Residence and sex cells "–"; Grand Total filled; the note column shows the total as unclassified | Domestic and Foreign "–" (or `*` partial); Total filled |
| Partial residence | Known counts, completeness off | Known totals shown; remainder on the note column | Known Domestic and Foreign with `*` |
| Complete residence | Counts equal the total, completeness on | Everything filled, note column 0 | Domestic + Foreign = Total |
| Confirmed zero | Total 0 | 0 in every total cell | 0 |
| Missing date | No row | "Not recorded"; month cannot be submitted | not reached |
| Authorized closure | No row; closure from the existing closed dates | "Closed (authorized)"; not a zero | not reached |
| Month not submitted | n/a | "Not submitted", never 0 | "Not submitted", never 0 |

## 7. Day 31 and leap years

The supplied VAR 1 grid stops at day 30 (pages 2 and 4). ZTIMS stores and shows every real date, including day 31 and 29 February. **The export layout is decision D2.** Options:
- **A (proposed default):** one row per real day of the month (28 to 31), as done for the accommodation DAE-1A. The template gains or loses rows. The change is documented.
- **B:** keep the 30-row grid and put day 31 in a row below it, outside the grid.
- **C:** keep the template as supplied and leave day 31 out. Rejected: it would silently drop visitors.

## 8. What counts as one visit (proposed, not a DOT rule)

The supplied forms give no definition. Proposed for the office to confirm (decision D4):
- One person entering the attraction on one date counts once. Re-entry the same day does not add.
- Each person in an organized group counts. A group is not counted as one.
- A person who returns on a later date counts again. The record is attendance, not unique visitors.
- Staff, vendors and performers are not visitors. Residents of Zamboanguita who visit are visitors (class: Zamboanguita).
- Free entrance and paid entrance count the same. Tickets and payments are never counted.

**Boundary.** VAR 3M is titled "Same Day Visitors". An attraction count cannot tell same-day visitors from overnight guests who also visit. ZTIMS records **visits to the attraction**. Whether the municipal report should include overnight guests' visits, or only same-day visitors (which needs an extra question at the entrance), is for the office to decide (D4). The system must not claim the figure is a same-day visitor count until then. Attraction visits are never added to accommodation arrivals or guest-nights, and totals across attractions are not unique tourists.

## 9. Recording completeness versus an official obligation

- **Software completeness** (ZTIMS): every date up to the month's end is a recorded count (zero allowed) or an authorized closure. It decides whether Submit is available.
- **Official obligation** (outside ZTIMS): which forms the municipality must send, to whom, and by when. The supplied copies do not state it. ZTIMS shows a target date of the 5th of the next month, which is an existing ZTIMS setting. It is labeled as a ZTIMS target, not as an official deadline.
