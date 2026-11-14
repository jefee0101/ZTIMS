> Current scope (14 November 2026): entrance sales and officer collections are retired. Room payments remain. Admission-related descriptions below are historical, not current behavior. See MANUSCRIPT-NOTES.md and diagrams/entrance-removal-redraw-list.md.

# Analytics inventory

Proposal, 12 November 2026. Nothing here is built. Each analytic names its data source, calculation, user value, best visualization and limitations. G-numbers refer to `03-dashboards-data-flow-gaps.md`.

**Status.** **Computable now**: every input exists in the code and on live. **Computable once reporting runs**: the inputs exist in the schema, but have no rows yet. **Needs a decision first**: it conflicts with a standing rule or its scope is unconfirmed. **Needs new data**: it is not collected. **Not proposed**: it cannot be done honestly with what exists.

**Build order.** 1 = first, 2 = second, 3 = third; 0 = not proposed.

## Accommodation

### A1 · Guest arrivals per month

*For:* Officer, Manager · *Status:* Computable once reporting runs · *Build order:* 1

- **Data source:** accommodation_report_versions.arrivals (finalized versions; submitted and draft only in the labeled operational view). 2025: monthly_reports kind municipal_total (12 months on live).
- **Calculation:** Sum of arrivals of each place's official version in the month. A guest counts once at each place they arrive at.
- **User value:** Shows how arrivals move through the year and whether a month is above or below the others.
- **Best visualization:** Column chart by month; the same month last year as a dashed line; coverage band under the axis.
- **Limitations:** Arrivals at places, not people. A month with places missing is partial and says so. 2025 is a paper municipal total with no place detail, so it is a separate series until its scope is confirmed (G3).

### A2 · Guest nights per month

*For:* Officer, Manager · *Status:* Computable once reporting runs · *Build order:* 1

- **Data source:** accommodation_report_versions.guest_nights; 2025 monthly_reports.guest_nights.
- **Calculation:** Sum of official guest nights. A stay's nights fall in the month they are spent in.
- **User value:** Shows how much stay time the municipality hosts, which arrivals alone hide.
- **Best visualization:** Column chart by month, aligned to A1 on its own scale.
- **Limitations:** Counts only (no revenue). Not comparable with attraction visits.

### A3 · Average length of stay

*For:* Officer, Manager · *Status:* Computable now · *Build order:* 1

- **Data source:** accommodation-engine.js averageLengthOfStay = guest nights ÷ arrivals (already in the DAE-1B). 2025 has both inputs.
- **Calculation:** Guest nights ÷ arrivals for the month or year, from the same versions.
- **User value:** Tells a manager whether guests stay longer or shorter, and the officer where stays are short.
- **Best visualization:** Line by month with the year average as a reference line.
- **Limitations:** A ratio the DAE-1B already requires, so it is allowed for private places to stay. It is an average: it hides a few long stays.

### A4 · Occupancy (room-nights occupied of available)

*For:* Officer, Manager · *Status:* Computable once reporting runs · *Build order:* 1

- **Data source:** accommodation_report_versions.room_nights_occupied and room_nights_available. 2025 stores rooms and room-nights occupied, not room-nights available.
- **Calculation:** Room-nights occupied ÷ room-nights available (accommodation-engine.js occupancyRate). Counts of both are shown beside the rate.
- **User value:** The standard measure of how full places are; the manager sees their own, the officer the municipal total.
- **Best visualization:** Line by month plus a month × year heat grid once there are two years.
- **Limitations:** Needs each place's rooms set up (live: 0 rooms today). The DAE templates define this rate, so it is allowed for private places to stay. For 2025 only occupied room-nights are known, so no rate can be stated (G8).

### A5 · Peak and low months

*For:* Officer, Manager · *Status:* Computable now · *Build order:* 1

- **Data source:** The same monthly series as A1 and A2. On live today: 2025, 12 months.
- **Calculation:** Rank the months of a year by arrivals (and by guest nights). Peak = the highest, low = the lowest. Seasonality (a typical month) needs at least two full years.
- **User value:** Plan staffing, promotions and closures around the busy and quiet months.
- **Best visualization:** Column chart with the peak and low labeled, then a month × year heat grid (sequential, one hue).
- **Limitations:** One year shows the order of months, not a season. No cause is claimed for a peak. Months with places missing are excluded from the ranking and marked.

### A6 · Month and year comparison

*For:* Officer, Manager · *Status:* Needs a decision first · *Build order:* 2

- **Data source:** Versions for the month and the same month a year earlier (FORM A's comparable-month rule in accommodation.js).
- **Calculation:** Difference in counts for months with complete coverage in both years. A percentage difference only after the policy decision (G4).
- **User value:** Answers 'are we up or down on last year?' fairly.
- **Best visualization:** Grouped columns (this year solid, last year muted) with the difference as a number; no dual axis.
- **Limitations:** Counts-only policy: percentage change is already built for FORM A (private places to stay) but is not approved elsewhere. First possible comparison is 2027 against 2026 for enterprise data.

### A7 · Where guests live (residence)

*For:* Officer, Manager · *Status:* Computable once reporting runs · *Build order:* 2

- **Data source:** accommodation_report_version_counts (residence_code × male/female; 72 Form A4 rows). 2025 municipal totals have the same rows without sex.
- **Calculation:** Sum arrivals by residence group (Philippine residents, non-Philippine residents, overseas Filipinos, unspecified) and by country. 'Unspecified' is shown, never dropped.
- **User value:** Shows which markets the places serve and how many guests are not classified.
- **Best visualization:** Horizontal bars for the top countries, one stacked bar for the groups with 'unspecified' hatched.
- **Limitations:** Shares and percentages need the decision (G4); counts are always shown. Philippine residents are not split by province for places to stay (G7). Rare countries at one small place could identify a guest: manager-only at enterprise level (G15).

### A8 · Sex of guests

*For:* Officer, Manager · *Status:* Computable once reporting runs · *Build order:* 2

- **Data source:** accommodation_report_version_counts.male and .female. 2025 has none (total_unsplit).
- **Calculation:** Male and female arrivals for months where the split exists; months without a split are excluded and listed.
- **User value:** Describes the guest mix where it is recorded.
- **Best visualization:** Two-segment bar by month with a coverage note; or a single number pair.
- **Limitations:** Not collected for 2025. Only male and female exist; nothing else is recorded, so nothing else is shown.

### A9 · Arrivals by weekday and day

*For:* Manager · *Status:* Computable once reporting runs · *Build order:* 3

- **Data source:** accommodation_stays.check_in and accommodation_stay_guests (the manager's own stay register).
- **Calculation:** Count arrivals by check-in weekday and by day of the month from the stays of the enterprise (active stays only; voided ones excluded).
- **User value:** Helps a manager set staffing for check-ins.
- **Best visualization:** Seven-bar weekday chart; a calendar heat grid for the month.
- **Limitations:** From the live stay register, so a figure can change until the month is submitted. Stay-level detail stays with the manager; the officer sees monthly versions only (to be confirmed).

### A10 · Length-of-stay distribution

*For:* Manager · *Status:* Computable once reporting runs · *Build order:* 3

- **Data source:** accommodation_stays.check_in and check_out (nights per stay).
- **Calculation:** Number of stays with 1, 2, 3, 4–6, 7+ nights.
- **User value:** Shows whether business is short breaks or long stays, which the average hides.
- **Best visualization:** Column histogram.
- **Limitations:** Counts stays, not guests. Shared rooms and transfers follow the stay register's rules.

### A11 · Room request funnel (ZTIMS bookings)

*For:* Manager, Officer · *Status:* Computable once reporting runs · *Build order:* 3

- **Data source:** bookings.status (requested, confirmed, checked_in, completed, declined, expired, cancelled, no_show) and the enterprise's own settings. Live: 0 bookings.
- **Calculation:** Count of requests by outcome in a month. The officer sees counts only, no guest data and no money (as on the Bookings page).
- **User value:** Shows how many requests turn into stays, and how many expire unanswered.
- **Best visualization:** A horizontal funnel of counts (requested → confirmed → checked in).
- **Limitations:** Only requests made through ZTIMS, not all reservations. A booking is never an arrival (only the stay register counts arrivals). Total price exists but is excluded by the no-revenue rule.

### A12 · Booking lead time and response time

*For:* Manager · *Status:* Computable once reporting runs · *Build order:* 3

- **Data source:** bookings.requested_at, check_in, decided_at.
- **Calculation:** Median days from request to check-in; median hours from request to the manager's answer.
- **User value:** Tells a manager how far ahead guests book and how fast they are answered.
- **Best visualization:** Two number tiles with a small dot-plot of the last 12 requests.
- **Limitations:** Needs enough requests to be meaningful (suppress below a minimum count, to decide).

### A13 · Where room requests come from

*For:* Manager · *Status:* Computable once reporting runs · *Build order:* 3

- **Data source:** bookings.country_code (the booker's country of residence).
- **Calculation:** Count of requests by country.
- **User value:** An early signal of markets before stays are reported.
- **Best visualization:** Horizontal bars.
- **Limitations:** Requests, not arrivals or guests. Only ZTIMS requests.

### A14 · Accommodation by barangay, type and location

*For:* Officer · *Status:* Computable once reporting runs · *Build order:* 2

- **Data source:** spots.barangay, spots.type, spots.latitude and longitude joined to the places' official versions; accommodation_profiles.accommodation_type.
- **Calculation:** Sum arrivals and guest nights of the places in each barangay, by place type, and on the map.
- **User value:** Shows where stays concentrate and which barangays have no reporting place.
- **Best visualization:** Sorted horizontal bars by barangay; map bubbles (the map already exists in tourism-map.js).
- **Limitations:** The barangay is where the place is, not where guests live. On live, 10 places to stay are in 3 barangays (Poblacion 7, Maluay 2, Mayabon 1); a barangay with one place shows that place's figures (small-number disclosure, G15).

## Attraction

### T1 · Attraction visits per month

*For:* Officer, Support Staff · *Status:* Computable once reporting runs · *Build order:* 1

- **Data source:** attraction_report_versions.total (finalized versions); the labeled operational view also takes submitted and draft.
- **Calculation:** Sum of the official monthly totals per attraction and across attractions. A month with no usable version is 'not submitted', never 0.
- **User value:** Shows how busy attractions are through the year.
- **Best visualization:** Column chart by month; the same month last year as a dashed line; coverage band under the axis.
- **Limitations:** Visits to attractions, not unique tourists; added across attractions they are still visits. Only office-run, counting attractions exist (2 of 8 on live) (G2). No 2025 attraction data exists.

### T2 · Daily visits and 7-day average

*For:* Officer, Support Staff · *Status:* Computable once reporting runs · *Build order:* 1

- **Data source:** attraction_daily_counts.total by count_date (operational; locked by the month's submission).
- **Calculation:** Daily total with a trailing 7-day mean over recorded days only. Missing days are gaps, confirmed zeros are zeros, closures are marked.
- **User value:** Shows the day-to-day pattern and the busiest days, early, without waiting for the month to be finalized.
- **Best visualization:** Line with a smoothed average; gaps drawn as gaps; closures as markers.
- **Limitations:** Operational until submitted. Counting depends on Support Staff entering every date.

### T3 · Visits by weekday

*For:* Officer, Support Staff · *Status:* Computable once reporting runs · *Build order:* 1

- **Data source:** attraction_daily_counts grouped by weekday (the date's weekday in Manila).
- **Calculation:** Mean visits per recorded open day for each weekday; only dates with a count (zero included) enter, missing and closed dates do not.
- **User value:** Tells staff and the office which days to prepare for.
- **Best visualization:** Seven columns with the overall mean as a reference line.
- **Limitations:** Needs several weeks of data; the number of days behind each bar is shown. Holidays and events are not separated unless overlaid (T10).

### T4 · Peak and low days and months

*For:* Officer, Support Staff · *Status:* Computable once reporting runs · *Build order:* 1

- **Data source:** The series of T1 and T2.
- **Calculation:** Rank recorded days and months by visits.
- **User value:** Identifies pressure points and quiet periods for planning.
- **Best visualization:** Calendar heat map (one hue, light to dark) for days; labeled columns for months.
- **Limitations:** A closure is not a low day. No cause is claimed.

### T5 · Month and year comparison

*For:* Officer · *Status:* Needs a decision first · *Build order:* 2

- **Data source:** Finalized versions for the month and the same month a year earlier.
- **Calculation:** Difference in counts over months finalized in both years. Percentage change after the decision (G4).
- **User value:** Shows growth or decline fairly.
- **Best visualization:** Grouped columns, this year solid and last year muted, with the difference as a number.
- **Limitations:** There is no 2025 attraction data, so the first like-for-like year is 2027 (G5). The 2025 municipal totals are not attraction visits and are never used as a baseline.

### T6 · Visits by attraction

*For:* Officer · *Status:* Computable once reporting runs · *Build order:* 1

- **Data source:** attraction_report_versions joined to spots (title, category, barangay).
- **Calculation:** Official visits per attraction for a period, ranked; coverage (months finalized) shown with each.
- **User value:** Shows which attractions carry the load and which are not reporting.
- **Best visualization:** Ranked horizontal bars; small multiples of the monthly trend per attraction.
- **Limitations:** Rankings compare unlike places (a pool and a falls); show the counts without a score. An attraction that is not counted is listed as 'not counted', not as 0.

### T7 · Visits by barangay and category

*For:* Officer · *Status:* Computable once reporting runs · *Build order:* 2

- **Data source:** spots.barangay, spots.category and spot_more_categories joined to T1.
- **Calculation:** Sum visits of the attractions in each barangay and in each category. An attraction with several categories counts under each (stated on the chart).
- **User value:** Shows where visits happen and which kinds of attraction draw them.
- **Best visualization:** Sorted horizontal bars; map bubbles.
- **Limitations:** Barangay is where the attraction is, not where visitors live. Category totals overlap, so they are never added up. Few attractions per barangay: figures are close to a single place's (G15).

### T8 · Where visitors live (four classes)

*For:* Officer, Support Staff · *Status:* Computable once reporting runs · *Build order:* 2

- **Data source:** attraction_daily_counts residence classes: Zamboanguita, rest of Negros Oriental, other Philippine provinces, foreign; with the completeness flag.
- **Calculation:** Sum each class over the period; 'residence not recorded' = total − classified. Never assigned to a class.
- **User value:** Shows local versus outside visitors and how much of the record is classified.
- **Best visualization:** One stacked horizontal bar with 'not recorded' hatched, and the counts beside it.
- **Limitations:** Optional field: the unclassified share can be large (shown). Shares need the decision (G4). Only four classes: no countries for foreign visitors (G7).

### T9 · Sex of visitors

*For:* Officer, Support Staff · *Status:* Computable once reporting runs · *Build order:* 2

- **Data source:** attraction_daily_counts.male and .female with the completeness flag.
- **Calculation:** Sum male and female; 'not recorded' = total − male − female.
- **User value:** Describes the visitor mix where recorded.
- **Best visualization:** Two-segment bar with a hatched 'not recorded' segment.
- **Limitations:** Sex by residence is never stored, so a cross-tabulation is never shown.

### T10 · Visits around announced events and closures

*For:* Officer · *Status:* Computable once reporting runs · *Build order:* 3

- **Data source:** announcements (category event or closure, starts_at, ends_at, optional spot_id) and spot_closed_dates, over T2.
- **Calculation:** Mark event and closure dates on the daily series; compare the mean of event days with other days of the same weekday.
- **User value:** Lets the office see whether an event moves visits, without guessing.
- **Best visualization:** Daily line with shaded event bands and closure markers.
- **Limitations:** Only events the office posted; there is no holiday or fiesta calendar (G13). Association, never cause.

### T11 · Interest signals: saves and ratings

*For:* Officer · *Status:* Computable once reporting runs · *Build order:* 3

- **Data source:** saved_places (visitor × place), reviews.rating for visible reviews; visitor accounts. Live: 1 account, 0 saves, 0 reviews.
- **Calculation:** Count of saves per place; average rating and number of visible reviews (a review requires a used ticket or completed stay).
- **User value:** Shows interest and satisfaction beside the counted visits.
- **Best visualization:** Bars of saves; a rating with its count.
- **Limitations:** A save is not a visit. Reviews need a visit proof that exists only for ticket or booking visits, so they cover a small part of the visitors. Not added to any visit count.

### T12 · Visits per open day

*For:* Officer, Support Staff · *Status:* Computable once reporting runs · *Build order:* 2

- **Data source:** attraction_daily_counts and spot_closed_dates, spots.working_days.
- **Calculation:** Total visits ÷ dates counted (zero days included, closed and missing excluded).
- **User value:** Compares months of different length and attractions with different opening days.
- **Best visualization:** Number tile and line by month.
- **Limitations:** A mean of daily counts; not a capacity measure (no capacity data exists, G17).

## Cross-cutting

### X1 · Reporting completeness

*For:* Officer, Manager, Support Staff · *Status:* Computable now · *Build order:* 1

- **Data source:** accommodation tracker states and attraction tracker states (already built), accommodation_periods, attraction_periods, spots.counts_visitors, support_staff.
- **Calculation:** For each month and domain: places expected, submitted, finalized, missing, with no staff or not counted. Shown under every chart as a coverage band.
- **User value:** Tells every reader how much of the picture is in before they trust a number.
- **Best visualization:** A coverage band (segmented bar) per month; the existing tracker grid for detail.
- **Limitations:** 'Expected' is the places that count visitors or have set up reporting; places that never started are not expected (shown separately). The 5th-of-the-month deadline is a ZTIMS target.

### X2 · Unclassified share of the record

*For:* Officer · *Status:* Computable once reporting runs · *Build order:* 2

- **Data source:** Residence and sex 'not recorded' counts from A7, A8, T8 and T9.
- **Calculation:** Count of arrivals or visits with no residence (or no sex) recorded, per month.
- **User value:** Shows whether residence and sex charts can be trusted for a month.
- **Best visualization:** A small hatched segment on each breakdown chart, plus a line of counts.
- **Limitations:** A count, not a percentage, unless G4 is decided.

### X3 · Timeliness of reports

*For:* Officer · *Status:* Computable once reporting runs · *Build order:* 3

- **Data source:** accommodation_report_versions.late and submitted_at; attraction_period_events (submitted).
- **Calculation:** Days between month end and submission; count submitted after the 5th.
- **User value:** Shows which places need a reminder.
- **Best visualization:** A dot per place and month (on time or late); the existing tracker colors.
- **Limitations:** The 5th is a ZTIMS target, not an official deadline.

### X4 · Municipal overview: two panels on one month axis

*For:* Officer · *Status:* Computable once reporting runs · *Build order:* 1

- **Data source:** A1 and T1.
- **Calculation:** Accommodation arrivals and attraction visits shown in separate panels that share the month axis. Never summed, never indexed together.
- **User value:** Lets the officer read both without mistaking one for the other.
- **Best visualization:** Two aligned small-multiple charts, each with its own scale and its own coverage band.
- **Limitations:** No verified deduplication exists (G9), so the two can never be combined into 'unique tourists' or 'total tourists'.

### X5 · Data gaps panel

*For:* Officer · *Status:* Computable now · *Build order:* 2

- **Data source:** spots (counts_visitors, status, managed_by), support_staff, accommodation_profiles, accommodation_rooms.
- **Calculation:** List attractions not counted, counting attractions with no Support Staff, places to stay with no rooms or no reporting start, private attractions with no reporting path.
- **User value:** Turns 'missing data' into a to-do list for the office.
- **Best visualization:** A checklist with counts, each linking to the page that fixes it.
- **Limitations:** Describes setup, not the quality of what was entered.

## Not proposed

### N1 · Unique tourists / total tourists

*For:* — · *Status:* Not proposed · *Build order:* 0

- **Data source:** None.
- **Calculation:** Would need one identifier across places, which does not exist. Arrivals and visits repeat across places by design.
- **User value:** A headline number many readers expect.
- **Best visualization:** Not shown.
- **Limitations:** No verified deduplication (G9). Do not combine arrivals and visits.

### N2 · Revenue, average spend, RevPAR, ADR

*For:* — · *Status:* Not proposed · *Build order:* 0

- **Data source:** bookings.total_amount and payments exist but are excluded.
- **Calculation:** Not computed.
- **User value:** Economic impact.
- **Best visualization:** Not shown.
- **Limitations:** The office asked for revenue to stay out of statistics (G16).

### N3 · Purpose of visit, age groups, same-day versus overnight

*For:* — · *Status:* Not proposed · *Build order:* 0

- **Data source:** Not collected (tickets hold regular, student and child counts for demo data only).
- **Calculation:** Not computed.
- **User value:** Market segmentation.
- **Best visualization:** Not shown.
- **Limitations:** Would need new fields at the point of counting (G10); the 'Same Day Visitors' title is not claimed (decision D4).
