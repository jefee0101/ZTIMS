# Manuscript notes

What the manuscript (the capstone paper) must say after each change to the
system. Newest first. Each entry gives the sentences to change, word for word
where the manuscript already has them, and the answer to give the panel.

## Tourist guides have no area (October 2026)

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
