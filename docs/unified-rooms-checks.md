# Unified Rooms verification

Use a disposable **local** PostgreSQL database named `*_rooms_test`, with a
user able to create the schema/extensions and the local `anon`/`authenticated`
roles. The runner refuses remote database hosts and requires `NODE_ENV=test`.
It creates synthetic records and leaves them in the disposable database.

From `zamboanguita-backend`, set `DATABASE_URL` to that local database and run:

```text
node scripts/check-rooms.cjs
```

The suite seeds an earlier type-only booking before the numbered-room
migration, runs schema.sql twice, verifies preservation, then exercises the
actual Express routes and local PostgreSQL. Checks include room rates/photos,
ownership, derived quantities, double-booking races, walk-ins, outages,
closures, calendar recovery, legacy and numbered date moves, expiry,
cancellation, check-in corrections, price snapshots, safe deletion and
immutable finalized reporting. It re-runs schema over the saved records.

For headless UI checks, run that command with `--serve`. It prints the local
API address and writes a synthetic account fixture in the operating system's
temporary folder (or `ROOMS_FIXTURE`). Keep it running; start Vite development
or preview with `ZTIMS_API` pointing to the printed address. Production preview
requires `npm run build` first. The isolated API's coarse in-memory flood
counter resets every five seconds in this mode; authentication and
database-backed form limits remain enabled. Production server code is unchanged.

With Playwright and Edge installed, run:

```text
node scripts/check-room-browser.cjs
```

`ROOMS_BROWSER_ORIGIN` defaults to `http://127.0.0.1:3000`; set it to the local
Vite/preview address. `PLAYWRIGHT_MODULE` can point to a separate installed
Playwright package. `ROOMS_SCREENSHOTS` chooses the output directory (defaults
to a temporary folder). Never commit account fixtures or database backups.
The browser script refuses remote website origins. Ctrl+C stops the test API.

The UI checks cover 1440px/390px, light/dark, actual room editing and saving,
photo selection/reordering/removal, delete cancellation/confirmation, exact
visitor room selection, horizontal overflow and page script errors. Synthetic
photos and Cloudinary upload responses are intercepted locally: these checks
do **not** prove live Cloudinary uploads or email delivery. No real account,
payment or external email is used.

Verified 14 November 2026: **61 API assertions**, earlier booking migration,
schema twice plus a later re-run, frontend `check`/production build, and
**44 browser assertions** on the compiled production pages. Existing startup
warnings about IPv6 rate-limit key generators and unconfigured local mail are
outside this change. Home source files and styles were not changed.
