> Current scope (14 November 2026): entrance sales and officer collections are retired. Room payments remain. Admission-related descriptions below are historical, not current behavior. See MANUSCRIPT-NOTES.md and diagrams/entrance-removal-redraw-list.md.

# Data inspection: what ZTIMS actually collects

12 November 2026. Inspection only. Nothing in the application, the database or the live project was changed, and nothing was pushed or deployed. The live project was read with a read-only connection, counts and totals only: no names, emails, phone numbers or other personal details were read.

## 1. What was inspected

- The repository on the branch `claude/wizardly-dijkstra-ssze0r`: `db/schema.sql`, `statistics.js`, `accommodation.js` and its engine, `attraction-visits.js` and its engine, the bookings, tickets, reviews and announcements modules, the staff portals' pages and `theme.css` / `portal-flat.css`.
- The local test database (structure and fictional data).
- The live Supabase project `ztims` (row counts and aggregate totals only).

## 2. What live holds today (verified)

| Source | On live today |
|---|---|
| Published places | 18: 10 places to stay, 8 attractions. All 18 have a barangay (8 barangays used) and a map pin |
| Barangays | Poblacion: 7 places to stay and 1 attraction. Maluay: 2 and 1. Mayabon: 1 and 0. Najandig: 2 attractions. Basak, Calango, Jumao-as, Malongcay Diot: 1 attraction each |
| Main categories (all 18 places) | Beach 5, Nature 4, Culture 3, Diving 3, Leisure 2, Faith 1. Places to stay are included, so these cannot be read as attraction categories |
| 2025 municipal totals | 12 monthly reports (kind `municipal_total`, loaded by import). Arrivals by residence row, rooms, room-nights occupied and guest nights. No sex split, no place |
| Accommodation, 2026 | Tables exist. 0 stays, 0 versions, 0 rooms, 0 profiles |
| Attractions | The attraction tables are **not on live** (the schema has not been run). 2 of 8 attractions have Count visitors here on. 0 Support Staff accounts |
| Bookings, tickets, reviews, saved places | 0, 0, 0, 0. One visitor account |
| Announcements | 0 |

So the only real figures available to chart today are the 2025 municipal totals and the structure of the listings.

### The 2025 totals

| | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov | Dec | Year |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Arrivals | 1,861 | 1,358 | 1,558 | 2,341 | 1,984 | 1,305 | 1,194 | 1,307 | 940 | 1,607 | 1,440 | 2,403 | 19,298 |
| Guest nights | 4,822 | 4,517 | 5,041 | 5,453 | 4,823 | 3,319 | 3,734 | 4,118 | 2,895 | 3,780 | 4,264 | 6,216 | 52,982 |

- Peak month December (2,403 arrivals), lowest September (940). Average stay 2.75 nights (guest nights ÷ arrivals).
- By residence: Philippine residents 14,449, non-Philippine residents 4,813, overseas Filipinos 36. The largest non-Philippine countries were France 1,282, USA 744, Russia 495, Germany 294, Switzerland 165, United Kingdom 161, Australia 158 and Japan 149.
- Rooms ranged 158 to 208 a month and room-nights occupied 1,167 to 2,227. Room-nights **available** were not stored, so no occupancy rate can be stated for 2025.
- The arrivals add up: the twelve months equal the sum of the residence groups (19,298).

## 3. What each module records (verified in the schema and code)

**Accommodation (private places to stay).**
- *Stay register* (`accommodation_stays`, `accommodation_stay_guests`, `accommodation_stay_rooms`): check-in and check-out dates, rooms, and guests by residence (72 Form A4 rows) and sex. No guest names are stored.
- *Monthly versions* (`accommodation_report_versions`, `…_version_counts`): arrivals, guest nights, room-nights available and occupied, residence by sex, a late flag, who and when. Submitted versions are immutable; the officer finalizes.
- *Already computed* (`accommodation-engine.js`): occupancy rate, average length of stay, guests per room, percentage difference, and the FORM A rule that compares only months with complete coverage in both years.
- *Room requests* (`bookings`, `booking_rooms`): status, requested, decided and check-in dates, adults, children, the booker's country, price. A booking is never an arrival.

**Attractions (office-run, counting).**
- *Daily counts* (`attraction_daily_counts`): one count per attraction and date: total, four residence classes (Zamboanguita, rest of Negros Oriental, other Philippine provinces, foreign), male and female, each with a completeness flag. Sex by residence is not stored.
- *Closures* (`spot_closed_dates`), *monthly versions* and *states* (`attraction_report_versions`, `attraction_periods`).
- Manager-run attractions have no way to report (gap G2).

**Context.** Listings (barangay, type, main and other categories, map pin, whether visitors are counted), announcements (events and closures with start and end), saved places, reviews (one per visitor and place, only after a used ticket or completed stay) and tickets (demonstration only).

## 4. What already exists for statistics

- **Officer, Statistics:** Arrivals Report (Form A4 by month and residence, plus arrivals by place), Enter a report, Tracker (places to stay), FORM A (private places to stay, with coverage and a comparable-month comparison), Attraction visits (tracker, DTA2M, VAR 3M, issued files).
- **Officer, Dashboard:** counts of what waits for the officer, last month's Form A4 reports, collections, Form A4 counts by month and country.
- **Enterprise Manager:** stay register, DAE-1A, DAE-1B, versions and the year, for their own enterprise.
- **Support Staff:** Daily Visitor Record and Monthly Report for their one attraction.
- **Roles and their scope:** Tourism Officer reads everything and finalizes; Enterprise Manager sees their own enterprises; Support Staff sees their one attraction; visitors have accounts but no staff routes.

None of these shows a trend across more than a month's grid, a peak and low, a weekday pattern, a barangay or category breakdown, or coverage next to a figure. That is what this proposal adds.

## 5. Rules the analytics must respect

- **Counts and totals only; no revenue; no percentages.** The exception is the rates and shares the DAE-1A, DAE-1B and FORM A templates require for private places to stay. Anything else (shares, percentage change) needs a decision (G4).
- **Arrivals are arrivals at places and visits are visits.** A guest counts once at each place. They are never added to one another, and no "unique tourists" figure exists because there is no verified deduplication (G9).
- **Nothing from tickets.** Counts come from what each place records.
- **A missing month is not zero.** A confirmed zero is a zero. An unrecorded breakdown is its own segment, never assigned to a class.
- **Official means finalized.** Operational figures (submitted or draft) are always labeled.
- **Authorization is checked on the server**, never by a hidden chart. No personal details in any result.

## 6. The design system the prototype follows

`theme.css` and `portal-flat.css`: burnt orange `#BF5700` as the main colour (tangerine `#F28500` on dark), ink and paper neutrals, red and green only for status, flat outlined square panels, pill buttons and status pills, sentence-case labels, Plus Jakarta Sans, light and dark themes, and the portals' tables that scroll sideways on a phone.

**Chart colours.** Tested with the dataviz palette check on both surfaces. The four brand colours cannot all appear in one chart (ink reads as grey, ember is very dark, tangerine is low-contrast on light), so each chart uses one hue: burnt orange on light and tangerine on dark. A comparison is a dashed warm-grey line, labeled directly (contrast and separation pass in both themes; the grey is below the generic chroma floor, so it is never the only cue: it is dashed and named). Magnitude uses one hue in steps of opacity. Unrecorded values are hatched.
