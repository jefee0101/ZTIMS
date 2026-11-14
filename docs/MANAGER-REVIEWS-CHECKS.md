# Manager Reviews / officer Feedback correction — 14 November 2026

The owner clarified that enterprise reviews belong in the manager portal,
not in Tourism Officer Feedback. This supersedes the two-group officer UI
introduced in `055d9c2`.

## Result

- Officer Feedback loads office attraction/general private messages only,
  with the existing attraction/status/topic/search filters and status actions.
- Managers have Reviews in their portal, using the selected enterprise.
  The new read-only endpoint checks the signed-in manager's ownership and
  accommodation type on the server. It returns visible reviews, abbreviated
  public author names, average/count, rating/text filters and 10-row pages.
- Managers receive no office messages, other enterprises' reviews, visitor
  email, internal moderation history, reply or hide/delete controls.
- Existing completed-stay eligibility, officer moderation API permissions and
  historical review/moderation records are preserved. There is no enterprise
  review group or review-fetch request in officer Feedback.
- Legacy Reviews links send managers to their Reviews page; officers return
  to messages-only Feedback. All manager sidebars include Reviews.

## Validation

- Frontend check: 44 pages, zero undefined-name problems; 145 open-days checks.
- Production build and backend load against isolated local Postgres passed.
- Existing 61 room/report API and 36 room-gateway/removal checks passed with
  synthetic records and the local Xendit stand-in.
- New API checks cover same/other owner, officer/visitor/signed-out denial,
  attraction/invalid IDs, invalid rating, pagination without duplicates,
  rating/text filters, hidden-review exclusion and absence of private fields.
- Compiled browser pages checked at 1440px and 390px, light and dark:
  retry after an API error, counts, filters, search, empty state, pagination,
  enterprise switching, no cross-enterprise rows or moderation controls,
  legacy redirect, no page-script errors or horizontal document overflow.
  Officer Feedback's review group/requests are absent; message status works.
- All 70 new API/browser assertions passed.

Screenshots and synthetic fixtures remain in the local scratchpad/work folder,
not in the repository. No Home, shared theme, room payment, schema or live-data
changes are part of this correction. No schema re-run is needed. Real email
delivery, live payments and production signed-in data mutations were not tested.
