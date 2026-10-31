# Manuscript notes

What the manuscript (the capstone paper) must say after each change to the
system. Newest first. Each entry gives the sentences to change, word for word
where the manuscript already has them, and the answer to give the panel.

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
