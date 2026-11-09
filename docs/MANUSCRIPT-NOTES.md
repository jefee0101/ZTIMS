# Manuscript notes

What the manuscript (the capstone paper) must say after each change to the
system. Newest first. Each entry gives the sentences to change, word for word
where the manuscript already has them, and the answer to give the panel.

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
