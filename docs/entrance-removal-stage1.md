# Entrance feature removal — Stage 1

14 November 2026. Application removal only. No change to db/schema.sql or live
data, and no diagram redrawing. Entrance fees are information; visitors pay
onsite. The default decisions flagged to the owner are: accommodation reviews
after completed bookings only, no officer Collections page, and student/child
fees retained as information. Stage 2 still needs explicit approval and its own
commit. Writing a Stage 2 block does not authorize deleting live records.

Removed: entrance offers, sales, hosted-checkout return page, admission checks,
receipt/refund/collection APIs and officer pages, purchase UI/account tab,
entrance notices, erasure/linking operations and visit-proof path. Attraction
closures now only mark the date closed. Shared gateway helpers moved first to
xendit-gateway.js; booking-payments.js imports them there. The callback stays
POST /api/payments/webhook and routes only ztims-b-<id>. Xendit CSP, test-key
restriction, booking demo flags, room checkout/payment/refund, reporting,
Support Staff, saved places and announcements remain.

Verification:
- npm run check: 42 pages, no undefined-name issues; opening-day reader parity.
- npm run build and backend server load with JWT_SECRET.
- 61 existing local room/inventory/report assertions plus 36 retirement and
  room-gateway assertions against real local PostgreSQL and a local Xendit
  stand-in: confirmation before payment, callback authentication and replay,
  return-page settlement, demo marking, full cancellation refund, completed
  stay reviews and removed endpoint 404s.
- Two synthetic legacy entrance rows and checkouts remain byte-for-byte
  unchanged after closures, callbacks and room actions. No live mutation.
- Headless production pages on 1440px/light and 390px/dark: Home, attraction,
  account, booking Manage, FAQ, Terms, Privacy, Contact, officer Dashboard and
  Destinations; no retired controls or page script errors.
- The existing 44 room-editor and visitor-picker browser assertions also pass
  on desktop/phone in both themes, including the shared uploader and styles.
- Runtime grep for ticket/collections has no matches. Remaining matches are
  the deliberately untouched schema/diagram sources, migration tests and
  historical documentation explicitly marked superseded.

Repeat the local checks on a disposable local database named *_rooms_test:
set NODE_ENV=test and DATABASE_URL, then run from zamboanguita-backend:

```text
node scripts/check-room-gateway.cjs
```

The script refuses remote databases, starts its own local gateway, and never
uses a real key. It leaves synthetic data in the disposable database. Real
gateway operation, email delivery and live-data deletion were not tested or
performed. Existing IPv6 limiter startup warnings are outside this removal.

No schema rerun is needed for Stage 1. Deploy the code normally. Prepare the
manuscript updates listed in MANUSCRIPT-NOTES.md and the drawing checklist in
diagrams/entrance-removal-redraw-list.md; neither the manuscript nor existing
diagrams was edited.
