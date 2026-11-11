# Analytics: the pages

12 November 2026, on the branch `claude/wizardly-dijkstra-ssze0r`. Built and tested locally. Nothing was pushed or deployed, and live data was not touched. The pages draw only what `/api/analytics/*` returns (`05-implementation.md`), so every number on them was worked out by the server.

## 1. Where

| Page | Who | Menu |
|---|---|---|
| `src/admin/admin_insights.html` | Tourism Officer | **Analytics**, after Statistics, on every officer page |
| `src/resort/resort_analytics.html` | Enterprise Manager, current enterprise from the header switcher | **Analytics**, after Monthly Report, on every manager page |

Both are built from the portals' own shell (sidebar, header tiles, account menu, idle sign-out on the officer's) and use only `theme.css`, `motion.css` and `portal-flat.css`. Nothing new is loaded from outside, so the CSP is unchanged. The drawing is `src/shared/analytics-view.js` (plain global `window.ztimsAnalytics`, on `acc-common.js`), and its styles are the `.ax-*` block at the end of `portal-flat.css`. Charts are plain SVG and HTML: no chart library and no framework.

## 2. What each page shows

**Filters (one row above the tabs):**
- From and To months (the last 12 months by default).
- Group by month, quarter or year.
- **Finalized** or **Include submitted and draft**, stated under the filters every time.
- Officer only: Barangay, Category and Place.
- Compare with a year earlier.

**Officer tabs**, each with its own address (`#accommodation`, `#attractions`, `#requests`, `#coverage`):

- **Places to stay:**
  - Four cards: guest arrivals (marked "Partial" when not every place reported), guest nights, occupancy rate with both room-night counts, and average length of stay.
  - The trend chart, with a switch for arrivals, guest nights or room-nights occupied, and Excel. Under it, the coverage band: finalized of expected for each period.
  - Peak and low, and the year-earlier comparison.
  - Where guests live, and guests by sex.
  - Arrivals by place and by barangay.
  - The 2025 paper totals as their own card, marked "Separate source".
- **Attractions:**
  - Cards: visits, dates counted (with days with nobody and closed days), residence recorded and sex recorded (each "of N visits; M not recorded").
  - The trend chart with its coverage band and Excel; peak and low.
  - Where visitors live, with "not recorded" as its own hatched part, and visitors by sex.
  - By attraction, category and barangay.
  - With one attraction chosen, its last 90 days with a 7-day average, and the average by weekday.
- **Room requests:**
  - A banner saying a request is not an arrival.
  - Cards: requests, accepted, room-nights reserved, median answer time.
  - Requests by month, what happened to them, and where the guests live.
- **Reporting coverage:** the office's gap counts (attractions not counted, counting without Support Staff, manager-run attractions, places to stay without a reporting start or rooms), the incomplete months, and a month-by-month table of reports finalized for places to stay and for attractions.

**Manager tabs:**
- **Arrivals and nights:** the same as the officer's, for the current enterprise only. No paper totals and no other place.
- **Guests and stays:** from the live stay register. Arrivals day by day with the 7-day average, arrivals by weekday, length of stay, and the comparison with the barangay and all places to stay. A group is hidden below 3 finalized places.
- **Room requests:** the enterprise's own.
- If the current enterprise is an attraction, the page says analytics are for places to stay.

## 3. How the rules show

- **Not reported is never 0.**
  - A period with nothing reported has no bar, only a dashed outline and "Not reported (not 0)" in the legend.
  - Tables show "–" and "Not reported", and places show "Not reported".
  - A reported zero is a 0 with a short line on the baseline.
- **Partial periods are hatched.**
  - Their cards say "Partial" and have a dashed border.
  - They are never named a peak or a low; the number left out is stated.
- **2025 months held only as the paper total** are marked "Kept only as a 2025 municipal paper total". The paper totals are a separate card on the officer's page.
- **Separate measures in separate tabs.** Accommodation arrivals, attraction visits and room requests are never added together. The attraction tab says "Visits are not people". No card or chart is a count of unique visitors.
- **Residence and sex** are shown only from what was recorded. Unrecorded is its own hatched, named part. Sex by residence does not exist.
- **Every chart has "Show as a table"** with the same numbers, as a real table with headers.
- **Excel** comes from the server, from the same functions as the screen.
- **States:**
  - Loading: a spinner, announced to screen readers.
  - Error: a red box with the server's message and Try again.
  - Empty: a plain sentence saying why.
- **Accessibility:**
  - Tabs use arrow keys and `aria-selected`.
  - Each chart is an image with a description, and each column is focusable with a spoken label and a tooltip.
  - The coverage band has screen-reader text.
  - Colour is never the only cue: hatched, dashed and named.
- **Phone:**
  - Filters stack and charts are drawn at phone width, with fewer labels.
  - Bars with long labels wrap.
  - No sideways scroll at 390px.
- **Dark mode:** figures turn tangerine, from the theme's own tokens.

## 4. Tests (local database and API, built site through `vite preview`)

- `docs/analytics/tests/page-flow.js`: **62 passed, 0 failed.** Every card, table row and place figure checked against the API's own answer for the same filters (and the API against SQL in `api-checks.js`). Covered:
  - finalized against operational
  - the measure switch, quarters, the comparison message and a barangay with nothing reported
  - the paper-total card and the marked paper month
  - one attraction day by day; empty, error, loading and Try again
  - Excel download; phone width and dark mode
  - a stored name with markup shown as text
  - Manager:
    - only their own enterprise
    - no filters for other places
    - the comparison hidden below 3 places
    - an attraction enterprise
    - from the manager's own browser, another enterprise, attractions and coverage all refused (403)
    - the officer page sends them to sign in
  - Signed out: 401.
  - No script errors on any page.
- `api-checks.js` **129/129**. Attraction `page-flow.js` **57/57**, `page-flow-extra.js` **20/20** and `page-security.js` **14/14** after the menu change. `npm run check` (45 pages, 0 problems) and `npm run build`.

## 5. Limitations and gaps

1. **Live shows almost nothing yet.** Live has no 2026 reports, the attraction schema is not rolled out and there are no Support Staff accounts, so live would show the 2025 paper totals and "Not reported" everywhere else (G1).
2. **No Support Staff view.** They have their Daily Visitor Record and Monthly Report; the read-only view in the design is not built.
3. **Manager-run attractions** have no reports, so no analytics (G2).
4. **No shares or percentage change**, only counts and the DAE rates, until the office decides (G4). The minimum group of 3 is a default (G15).
5. **No map-area filter on the page.** The API takes `bbox`; the page offers barangay and place.
6. **One attraction day by day covers at most the last 90 days** of the range.
7. **The 2025 paper totals' scope is unconfirmed** (G3). They are shown apart and never added in.
8. **The browser tests share one local address through the preview proxy,** so a long run can reach the blanket limit of 150 requests per 15 minutes. Restart the local API between suites. On live each person has their own address.
