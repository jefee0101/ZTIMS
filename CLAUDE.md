# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ZTIMS — the Zamboanguita Tourism Information Management System, a site for one
Philippine municipality. Two halves live in this repo:

- `Zamboanguita-project/` — the frontend (static pages, Vite build).
- `zamboanguita-backend/` — the API (Express + Postgres on Supabase, via `pg`).

Both deploy together as one **Vercel** project whose Root Directory is the
repo root: `vercel.json` builds the frontend into `Zamboanguita-project/dist`
and rewrites `/api/*` to `api/index.js`, which is nothing but
`require('../zamboanguita-backend/server')`. So pages and API share one
origin. The API still runs on its own too (`npm start`, the `Dockerfile`) —
`server.js` only binds a port when run directly. It was previously on Render
at `ztims-api.onrender.com`; see `docs/HANDOVER-NOTES.md` for the move.

`vercel.json` pins every build setting so the dashboard's don't matter,
except the Root Directory, which only the dashboard can set. It must be the
repo root: with a subfolder there, Vercel still applies this `vercel.json` but
runs its commands from the subfolder, and the install fails. The frontend
install passes `--include=dev` because Vite is a devDependency, and a
`NODE_ENV=production` in the project's variables would otherwise make npm
skip it (`vite: not found`). The function is pinned to `sin1`
(Singapore) because the database is in AWS `ap-southeast-1` (Supabase's
"Southeast Asia (Singapore)"); the default (`iad1`, Washington) would put every
database round trip across the Pacific. If the database moves region, move
`regions` with it.
The build uses `npm ci`, so a `package.json` change must come with its
`package-lock.json`, or the deploy fails at install.

The halves share no source files. Where the same fact must exist on both
sides (see "Duplicated facts" below), it is duplicated by hand, not imported.

The repo root has no `package.json` and no `node_modules/` on purpose. An
earlier, abandoned Supabase auth prototype left a root `package.json`
(`@supabase/supabase-js`, `express` 5, ...), a committed root `node_modules/`
and `Zamboanguita-project/index.js`; all three have been deleted. Don't
recreate them: Node resolves modules upward, so anything installed at the
root gets picked up by the backend whenever its own install lacks a package.
If a root `package.json` is ever needed, never give it `"type": "module"` —
the Node runtime reads the nearest one, and the backend is CommonJS. Real auth
is the JWT system in `zamboanguita-backend/server.js`, called from
`staff_login.html`.

## How every session works (read first)

Several Claude sessions work on this repo, often on the same days. They all
follow this one routine, so each one's work lands the same way and nothing
collides. The user's chat is in plain, simple language.

1. **Start from the latest `main`.** `git fetch origin`, then build on
   `origin/main` (`git checkout -B <your branch> origin/main`). Look at
   `git log origin/main` and the other `claude/*` branches first: don't redo or
   undo another session's work, and don't rely on anything not yet on `main`.
2. **One finished change = one commit**, on your branch, then on `main` as a
   fast-forward: `git fetch origin main`, check
   `git merge-base --is-ancestor origin/main HEAD`, then
   `git push origin HEAD:main`. Never force-push `main`. If `main` moved,
   bring your work onto it, test again, then push. The user asks for
   "push to main" after each piece; that is the normal end of a task.
   Another session's unmerged branch goes to `main` only when the user says so.
3. **Check before every push** (there is no test suite): `npm run check` and
   `npm run build` in `Zamboanguita-project/`; the backend files load
   (`node -e "require('./server')"` with `JWT_SECRET` set); and the change is
   exercised for real on a local Postgres + API (API calls, and a headless
   browser for pages). Say what was checked, and what could not be.
4. **Database: `db/schema.sql` only, always re-runnable** (`if not exists`,
   `do $$ … if not exists (select 1 from pg_constraint …)`, `drop … if exists`
   before re-adding). Run it twice on the local database to prove it.
   **Never change the live Supabase database ahead of `main`**: the code that
   uses a schema change goes to `main` first, then the user re-runs
   `schema.sql` in the Supabase SQL Editor, then redeploys. (On 2 October a
   schema applied before its code reached `main` broke every ticket purchase.)
   Anything that deletes live data needs the user's yes first.
5. **Keep this file current in the same commit** as the change: a new table,
   route, page, rule or decision is written here, so the next session knows.
   New decisions go under "Standing constraints".
6. **Finish with a short report**: what changed, what was tested, and last,
   what the user must do themselves (re-run `schema.sql`, Vercel variables,
   redeploy, manuscript updates).

**Wording on every page** (decided): professional and brief. No page intros
or help lines under fields; keep only what appears at the moment of an action,
a warning, an error, or a confirmation before something risky. The roles are
Tourism Officer, Establishment Manager and Tourist Guide; visitors pay
**onsite** (never "at the gate"); statistics months are **Finalized** and
**Reopened**; visitor pages and emails don't say "test mode".

## Commands

Frontend (`Zamboanguita-project/`):
```
npm run dev      # vite dev server on :3000; proxies /api to the live site,
                  # or to a local API with ZTIMS_API=http://localhost:8080
npm run build    # vite build — every src/**/*.html page must be wired into
                  # vite.config.js's glob-generated `pages` map or it's dropped
                  # from dist/ silently (see that file's own comment)
npm run lint     # eslint . (flat config, src/*.jsx only — the standalone
                  # HTML pages' inline <script> blocks are NOT linted by this)
npm run check    # check-undefined.cjs && check-countries.cjs && check-open-days.cjs
```
`npm run check` is the safety net for the two failure modes ESLint can't see
because these pages carry inline `<script>`, not modules:
- `check-undefined.cjs` — parses every page's inline + local `<script>` as one
  shared scope and flags identifiers that are read/called but never defined
  anywhere on the page. Catches a helper deleted alongside dead code while a
  caller was left behind.
- `check-countries.cjs` — diffs the country list `src/shared/countries.js`
  ships to the booking form against `COUNTRY_CODES` in
  `zamboanguita-backend/server.js`, which validates it. Needs a sibling
  backend checkout to run; skips (exit 0) if `../zamboanguita-backend` isn't
  present.
- `check-open-days.cjs` — runs the page's and the server's opening-days reader
  (`open-days.js`, one on each side) on the same texts and every combination of
  ticked days, and fails if they disagree. Also skips without the backend.

Run both before committing changes to any `src/**/*.html` page or to the
country lists.

Backend (`zamboanguita-backend/`):
```
npm run dev           # nodemon server.js
npm start              # node server.js
npm run migrate        # node migrate.js — applies db/schema.sql (idempotent)
                       # and the first-officer bootstrap (not run at startup)
npm run create-admin   # node create-admin.js
npm run copy-from-mongo -- --dry-run   # the one-time MongoDB → Postgres copy;
                       # see scripts/copy-from-mongo.js before running it for real
npm run import-form-a4 -- db/form-a4-2025.json --dry-run
                       # loads a paper Form A4 year as locked municipal totals;
                       # skips months already recorded (see the script's header)
```
Needs a `.env` (see `.env.example` for every variable, each documented inline
with what it defaults to when unset — most integrations degrade gracefully
rather than erroring; read that file before touching auth, uploads, or
directions).

**There is no test suite in this repo.** `docs/HANDOVER-NOTES.md` describes a
Playwright/`cove_test.js` suite that validated Leaflet calls and layout — it
is not present in this checkout; don't assume it exists or try to run it.

## Frontend architecture

The real site is **not** a React SPA. It's a set of standalone, mostly
server-independent HTML pages under `src/` (`index.html` at the root, plus
`src/spot.html`, `src/history.html`, `src/staff_login.html`, the
information pages `src/terms.html`, `src/privacy.html`, `src/faq.html`,
`src/contact.html` (visitor feedback form → `POST /api/feedback`),
`src/admin/*.html`, `src/resort/*.html`, `src/guide/*.html`, `src/user/*.html`), each loading
Tailwind from the CDN and its own inline `<script>` blocks. That CDN script only
runs in development: `npm run build` compiles each page's CSS from its own
`tailwind.config` (the `ztims-compile-tailwind` plugin in `vite.config.js`),
writes it into the page and swaps the CDN tag for a one-line stand-in, so
visitors on weak signal never download or run Tailwind. A class built from
pieces at runtime (`'bg-' + colour`) is invisible to that compile — write class
names out whole. `src/App.jsx` /
`src/main.jsx` are the unused default Vite+React template — `index.html` has
no `#root` element, so nothing mounts them. Don't build new features as React
components; follow the existing page pattern.

Shared logic lives in `src/shared/` as plain global-scope IIFEs (not ES
modules), loaded via `<script src="...">` on the pages that need them, on
purpose — see the header comment in `spot-form.js`:
- `spot-form.js` (~2200 lines) — the one listing form used by the
  establishment portal, the officer's Destinations page, and the officer's
  Dashboard quick-add. Owns barangay list, validation, the location picker
  and its Zamboanguita bounding-box sanity check.
- `tourism-map.js` — Leaflet + OpenStreetMap tiles + ZTIMS's own category
  markers. Never calls a routing provider directly; hands off to the backend's
  `/api/directions/route`.
- `theme.css` — the design system: the single source of the color palette
  (RGB-triple custom properties so Tailwind opacity modifiers like `/40` keep
  working, consumed by every page's own inline `tailwind.config`) and the
  reusable components (`.glass*`, `.btn-*`, `.ztims-card`, `.cat-badge`,
  `.tone-*`, `.ztims-modal`, fields). See "Design system" below.
- `theme.js` — light/dark, for every page: a classic, render-blocking
  `<script src>` placed right after `<meta charset>` so the first frame is
  already the right theme. It must stay classic (a module would run after
  paint), which is why `vite.config.js` copies it into `dist/` itself — Vite
  only bundles module scripts. Pages keep calling `toggleTheme()` /
  `toggleDarkMode()`; no page reads `localStorage.theme` itself any more.
- `motion.css` — the duration and easing scale, and every shared animation
  (page enter, `.ztims-stagger`, dialogs, menus, skeletons), plus the one
  `prefers-reduced-motion` switch-off.
- `site-footer.js` — the visitor pages' footer (Explore / Information /
  Contact Us columns, office address, quiet staff sign-in link), drawn into a
  `<footer data-site-footer data-root="../">` placeholder so seven pages
  share one copy. The office's address, hours, phone, email and emergency
  numbers come from `GET /api/office` (Settings → Office Information); until
  they load, the built-in address and hours show and nothing else. It also
  fills Contact Us's `[data-office-field]` spots and the destination pages'
  `[data-emergency]` box.
- `guide-portal.js` + `guide-portal.css` — the Tourist Guide portal's frame
  (sidebar, header, account menu, phone drawer) and helpers, shared by the four
  `src/guide/*.html` pages (Dashboard, Schedule & Availability, Languages, My
  Profile). Unlike the officer's and manager's pages, which each carry that
  frame inline, the guide pages draw it from here. Loaded as a module, so page
  code calls `window.GuidePortal` only inside `DOMContentLoaded`.
- `stat-form.js` — the monthly statistics report form (Form A4 counts by
  country of residence and sex, plus rooms and guest nights for an
  accommodation), used by `src/resort/resort_statistics.html` and the
  officer's `src/admin/admin_statistics.html`. See "Tourism statistics" below.
- `open-days.js` — reads a destination's "working days" text into weekdays and
  writes ticked days back as text (`window.ZTIMS_OPEN_DAYS`); used by the
  listing form's day boxes and the officer's Visitor setup. See "Attraction
  setup" below.
- `photo-upload.js`, `countries.js`, `nav-active.js`, `ztims-dialog.js` —
  smaller per-concern shared pieces.

### Design system

Glassmorphism over one five-colour identity (`--brand-*` in `theme.css`),
each colour with one job — the full table is at the top of `theme.css`:
blue `#30638E` primary actions, links, active navigation; navy `#003D5B`
primary's pressed state and the hero; teal `#00798C` secondary actions (map,
directions), focus, success; coral `#D1495B` the visitor's position and route
on a map, errors, destructive actions; gold `#EDAE49` highlights and
"waiting" status, as a fill with navy on it. Categories reuse the same five
on badges, map pins and legends (Mountain teal, Beach/Diving navy, Cultural
gold, Accommodation blue). The grounds are true white and true black; the
brand colours carry identity, not the backgrounds.

- **Theme.** One choice for the whole site: the toggle on any page stores
  `theme` (light or dark) and every page, and every other open tab at once,
  shows it until toggled again. Until someone has chosen, the device's
  `prefers-color-scheme` is followed live. Signing out keeps it: pages sign out
  through `ztimsTheme.clearStorage()`, never a bare `localStorage.clear()`.
  All in `theme.js`.
- **Glass.** Translucent fill, hairline border, lit top edge, soft navy-tinted
  shadow, over a fixed ambient glow of the brand colours (`body::before`).
  `backdrop-filter` blur only on surfaces content scrolls behind — `.glass-nav`
  (header, sidebar), modals, menus, toasts; cards (`.glass-card`,
  `.glass-panel`, `.ztims-card`) are translucent without blur, for scrolling
  performance on phones.
- **Contrast.** Every text/background token pair is ≥ 4.5:1 in both themes,
  including over the brightest part of the glow. Saffron is never text on
  white (1.95:1) — it has an ink shade (`--ztims-gold-text`), as does each
  category (`--ztims-cat-*-ink`). Don't use Tailwind's own palette
  (`text-amber-400`, `bg-white/10`, …) for status or tints: those were tuned for
  one theme. Use `.tone-warning|success|info|danger|neutral` (+ `.tone-pill`),
  `.cat-badge .cat-*`, and `on-surface/…` tints.
- **Foundations.** Type scale `--text-display|title|heading|body|support|label|micro`,
  weights `--weight-*`, a 4px spacing grid `--space-*`, radii `--radius-sm|md|lg|xl`
  (all 0: corners are square everywhere by decision, and each page's Tailwind
  config maps every `rounded-*` to 0 — the hero's curved cove is the one curve),
  three elevations `--ztims-shadow-card|raised|overlay`. Icons are Material
  Symbols Outlined, never meaning on their own; `.icon-chip` tints one by tone
  or category.
- **Components.** Buttons `.btn` + `.btn-primary|secondary|ghost|accent|highlight|danger`
  (+ `.btn-sm`); fields `.field`, `.glass-field` (search over the hero);
  surfaces `.glass-panel`, `.glass-card`, `.ztims-card`, `.ztims-modal`;
  `.ztims-dropdown` for anything that opens from a control; `.ztims-table`;
  `.ztims-empty` for "nothing here yet" (add a `.tone-*` for a failed load);
  `.tone-*`/`.tone-pill` for status; `.cat-badge .cat-*` for categories.
  Leaflet's zoom, attribution and popups are restyled in theme.css ("The map");
  pins and legends take their colours from `tourism-map.js`'s `CATEGORIES`.
- **Motion.** Durations 120/160 ms (micro), 200/240 ms (standard UI), 300/350 ms
  (dialogs, larger panels) — `--dur-*` — and easing by
  meaning (`--ease-standard` for things under the user's control,
  `--ease-decelerate` for arrivals, `--ease-accelerate` for exits,
  `--ease-spring` only for small things). Only transform and opacity move.
  Each page's `tailwind.config` points Tailwind's default transition curve at
  `--ease-standard`, so `transition-all duration-300` follows the system too.
  Page-to-page and theme switches crossfade via View Transitions.
  `prefers-reduced-motion` stills everything from `motion.css` alone.

The officer's first page is the **Dashboard**, `src/admin/admin_analystic.html`
(the file keeps its old name so sign-in and bookmarks still land on it). It holds
no data of its own: it reads the officer's existing endpoints (guide bookings,
spots, establishment managers, feedback, guide reports,
`/api/statistics/tracker` and `/form-a4`) and shows what is waiting on each —
every card links to the page where it is dealt with, opening Guide Bookings on
the right tab through its `bookingsTab` session key and Statistics through the
tab named in the link's address (`admin_statistics.html#tracker`) — plus
today's tours, the month just ended's Form A4 reports, and Form A4 counts by
month and by country. Counts only, like the statistics themselves.

Each page sets its own `const API_BASE = "/api"` (`admin_analystic.html`
calls it `BASE_API_URL`; `admin_profile.html` writes `/api/...` into its
fetches) — same-origin, since Vercel serves the API beside the pages. There is
no shared config file for this, and none is needed: to use a local backend in
development, set `ZTIMS_API` for the dev server's proxy rather than editing
pages.

## Backend architecture

`zamboanguita-backend/server.js` (~2700 lines, Express) holds the routes. The
data lives in Postgres on Supabase (it moved off MongoDB Atlas; see
`docs/HANDOVER-NOTES.md` §3.5), in three files beside it:

- `db/schema.sql` — every table, constraint, index and trigger. Idempotent;
  `npm run migrate` or the Supabase SQL Editor applies it. Row Level Security is
  on for every table with **no policies**, on purpose: only the API (connecting
  as the table owner) can read anything, and Supabase's public REST API returns
  nothing. Don't add policies unless the browser is meant to read a table
  directly — nothing in ZTIMS does.
- `db.js` — the connection pool (small, lazy, serverless-safe; strips `sslmode`
  from the URL because node-postgres would otherwise verify Supabase's
  certificate against public authorities and fail) and a small `Table` class.
  Routes get rows back as the same plain objects Mongoose used to give them
  (`_id`, camelCase), and `Table.save(doc)` writes only the fields that changed.
  That's what let the move leave every page untouched. Postgres errors are
  translated into the shapes routes already handled (`code: 11000` for a
  duplicate, `ValidationError` for a bad value, `STILL_REFERENCED` for a delete
  that a reference blocks). A field can be `generated` (the database works it
  out; never written), `hidden` (a column routes never see, read and written
  through a `virtual`), or `external` (not a column of the table; its model
  writes it) — see "Normalisation" below.
- `models.js` — one `Table` per record type, field for field what the Mongoose
  schemas were, plus the few joined queries (a listing with its establishment,
  a booking with its destination and guide). `server.js` imports them under the
  old model names (`Spot`, `GuideBooking`, …; `Admin` became `TourismOfficer`)
  so each route reads as it did.

Ids are text, 24 hex characters: the records copied from MongoDB kept their
ObjectIds, so shared links and signed-in sessions survived the move. Table names
say what the records are (`tourism_officers`, `establishment_managers`), which
the old collection names (`admins`, `resortOwners`) did not.

`server.js`, top to bottom:

1. Middleware: `helmet`, CORS (a page's own origin, the `CORS_ORIGIN` env
   allow-list, and any `*.vercel.app` origin for preview deploys — see
   `isSameOrigin` / `previewOriginPattern`), rate limits, JSON body parsing
   capped at 1MB (photos go straight browser → Cloudinary, never through this
   API). The limits that guard something (login, password reset, bookings,
   feedback, directions) go through `sharedRateLimit`, which counts in the
   `rate_limits` table (`rate-limit-store.js`) so they hold across serverless
   instances; only the blanket per-request limit stays in memory, on purpose.
2. `runMigrations` and `bootstrapAdmin` (see below), and `COUNTRY_CODES`.
3. Auth middleware chains: `requireAuth` (valid JWT) →
   `requireAdmin`/`requireEstablishmentManager`/`requireStaff`/`requireGuide`
   (role checks; `requireAdmin` also looks the officer up, so a deactivated
   officer's open session stops at once) and `optionalAuth` (attaches `req.auth` if present, never
   blocks). Roles: `admin` (Tourism Officer), `establishment_manager` (Tourist
   Establishment Manager) and `tourist_guide` (Tourist Guide) —
   `'resort_owner'` is a legacy spelling of the manager role, kept only so
   tokens issued before a rename don't get rejected mid-session; nothing
   issues it anymore. `requireStaff` (officer or manager) deliberately
   excludes guides: it guards listing writes and upload signing. There is
   deliberately no `tourist` role or tourist account at all — visitors browse
   without logging in. All three sign in on the one staff page; the login
   route searches officers, then managers, then guides, so `emailTakenBy`
   refuses any sign-in email another account already uses.
4. Routes, grouped by resource: admin, establishment-managers, login/forgot/
   reset-password, spots (listings), guides (see "Tourist guides" below),
   guide-bookings, payments,
   feedback (public `POST /api/feedback`, rate-limited with a honeypot;
   officer inbox `GET`/`PATCH …/status` read in `src/admin/admin_feedback.html`),
   `/api/directions/*`, and `/api/statistics/*` — mounted from `statistics.js`
   (see "Tourism statistics" below).

Directions (`/api/directions/route|search|reverse|capabilities`) is a
provider-fallback layer, not a single API call:
- Routing: OpenRouteService (`ORS_API_KEY`, set) → OSRM public demo (unset).
  Motorbike is separate again — ORS has no motorcycle profile, so that one
  mode always goes through Valhalla (`VALHALLA_URL`, defaults to the FOSSGIS
  community server; set empty to remove the mode from `/api/directions/capabilities`
  entirely rather than show a mode nothing can calculate).
- Every router is asked for alternative routes and the handler picks the
  quickest by the provider's own numbers (see the comment above
  `viaRoadName` in `server.js`) — never just `routes[0]`.
- Geocoding: OpenRouteService's geocoder (key set) → Nominatim (unset).
- `/api/directions/capabilities` tells the frontend which modes are live, so
  a page only ever renders what the backend can actually calculate.

### Tourist guides

One role, `tourist_guide`, with a **scope** on the record (`tourist_guides.scope`):
`municipal` covers the whole municipality; `barangay` + `barangay` covers one
barangay. The screens are the same for both — the scope only filters:
- a barangay guide can be given only destinations whose `spots.barangay` is
  theirs (`checkGuideScope` on save; re-checked when a booking is assigned,
  since a listing's barangay can change). A listing with a blank barangay can
  only go to a municipal guide.
- a guide's dashboard counts bookings in their jurisdiction
  (`bookings.listInJurisdiction`) — counts only; visitor names and numbers are
  shown only for bookings assigned to that guide.

The guide proposes, the office disposes. A guide keeps their own availability
(status available/unavailable and working days) and languages, and files
reports (`guide_reports`: tour completed, headcount, incident, tourist
feedback — `barangay` is derived server-side, and filing never changes a
booking), and edits their own contact number and bio directly
(`PATCH /api/guides/me/details`, no approval). The office assigns every
booking, reviews every report (rolled up per barangay on `admin_guides.html`),
and alone sets name, scope, fee, group size, destinations, photo and
`inactive` — the fields that decide what a guide may be assigned. Single days
off (`guide_time_off`) and office-approved profile changes
(`guide_profile_requests`) were taken out: a guide who cannot work sets
themselves Unavailable. `schema.sql` drops both tables on the next migrate. Guide
sign-ins are issued and withdrawn by the officer (`/api/guides/:id/account`);
a guide record without one has `email`/`password_hash` null.

Visitors choose: `GET /api/spots/:id/guides?date=&time=` (public) lists the
guides at a destination — photo, name, languages, fee, bio, group size, area,
and whether each is free then by `isGuideFreeOn` — never a phone, an email or
the booking that makes a guide busy. A booking may carry `requested_guide_id`
(null: any guide), checked at booking time (serves here, takes the group, free
then). It stays a request: `guide_id` is still the office's to set, an online
payment charges the requested guide's fee (else the lowest here), and a paid
booking can only be assigned a guide at or below what was paid.

Languages are rows, not a list: `languages` (unique on `lower(name)`) and
`guide_languages`, written by `setGuideLanguages`. That is what makes
`GET /api/guides/search?language=&date=` ("who speaks Korean and is free
Saturday") a join. "Free" is decided by `isGuideFreeOn` — the same function the
assign route uses, so the search never offers a guide assignment would refuse.

### Tourism statistics

The office's Form A4 ("Report on the Regional Distribution of Travelers",
sent to the province each month) and the visitor counts at the attractions,
collected in ZTIMS instead of a hand-kept spreadsheet. Routes in
`statistics.js`, the Excel file in `statistics-excel.js`, four tables in
`schema.sql` (`residences`, `monthly_reports`, `monthly_report_counts`,
`report_changes`).

- **Counts and totals only.** No revenue, no percentages, anywhere — the
  office asked for both to stay out. DAE-2 is shown as its counts (rooms,
  room-nights available/occupied/not occupied, guest nights), not as rates.
- **Nothing from bookings.** Establishments report their own already-totalled
  month; ZTIMS never derives these figures from guide bookings.
- **Who reports.** A manager, for the listing they manage. The officer, for
  the places the office keeps (listings with no manager) only: a privately
  managed establishment's reports are its manager's to enter, and the officer
  views them (`mayViewFor` / `mayEnterFor` in `statistics.js`; the officer's
  "Enter a report" tab shows them read-only). `kind` comes from the listing: an accommodation reports arrivals,
  rooms and nights; an attraction reports visitors only, and attraction
  visitors are never part of Form A4.
- **Rows.** `residences` is Form A4's 72 rows in the form's order (ISO codes,
  plus `ph-filipino`, `ph-foreign`, `cis`, `other-foreign`,
  `overseas-filipino`, `unspecified`), seeded by `schema.sql`. It lives only
  in the database — the form fetches it — so unlike the booking form's
  country list it is not duplicated anywhere.
- **Rules the API enforces**, whatever the page does: one live report per
  place per month; male + female = total; room-nights occupied ≤ rooms × days
  in the month; guest nights ≥ arrivals; no month that hasn't started. Due on
  the 5th of the following month, Manila time (`DEADLINE_DAY`); late reports
  are accepted and marked late.
- **Stored permanently.** Reports are voided with a reason, never deleted;
  every create, update, void, lock and unlock is a `report_changes` row with
  the before and after. Locking marks months as sent to the province; a locked
  report refuses changes until the officer unlocks it, with a reason. The pages
  call these **Finalize** and **Reopen** (the API keeps `lock`/`unlock`).
- **Municipal totals.** A month with a `municipal_total` report (a year kept on
  paper, loaded by `scripts/import-form-a4.js`) refuses per-place reports, so
  its guests are never counted twice; voiding it opens the month again. Those
  months have no sex split, and Form A4's "volume per sex" is left blank for
  them rather than shown as 0.

### Online payments (demonstration, test mode)

`payments.js`, mounted at `/api`: a visitor pays a guide booking
(`POST /api/guide-bookings/:reference/checkout`, reference + the booking's email)
or buys entrance tickets (`POST /api/tickets`) on a Xendit hosted invoice, and
comes back to `src/payment.html?c=<checkout id>`. Tickets are sold only for
attractions the office runs (`managed_by` null, published, `entrance_fee` > 0).

- **Test mode only.** `XENDIT_SECRET_KEY` must start `xnd_development_`; anything
  else (a `xnd_production_` key above all) switches online payment off
  (`gatewayState`). Every online payment, the booking
  or ticket it paid for, and the generated sample data carry `is_demo`.
  Visitor pages and emails do not label it "test mode" (decided); Xendit's own
  checkout page shows that, and Terms, Privacy and FAQ still say so. Paying in
  person is called paying **onsite** (never "at the gate").
- **The server decides.** Amounts come from the fees on record (a booking: its
  guide's fee, else the lowest available guide fee at the destination). A
  payment is confirmed only by the server asking Xendit itself (`settle`:
  `GET /v2/invoices/:id` with its own key), when the visitor returns or when
  Xendit's callback (`POST /api/payments/webhook`) arrives carrying the
  `X-CALLBACK-TOKEN` (`XENDIT_CALLBACK_TOKEN`, constant-time compare). The
  callback's body is never believed, only used to find the checkout to settle.
  The invoice must match the checkout (`external_id` `ztims-<checkout id>`),
  be in PHP and for the amount asked. `recordPaid` locks the checkout row so
  both arriving at once record it once.
  A payment for something already paid or cancelled is marked `duplicate` for a
  refund.
- **Tables** (`schema.sql`): `tickets`, `online_checkouts`; `payments` now
  belongs to a booking *or* a ticket (`payments_for_one`) and has `channel`
  (counter/online), `gateway_ref`, refund fields and `is_demo`; guide bookings
  have `is_demo`. 22 tables in all, with `spot_closed_dates`, `spot_photos`,
  `office_info` and `emergency_numbers`
  (`guide_time_off` and `guide_profile_requests` were dropped).
- **The office:** `admin_collections.html` (money per month and day, OR numbers,
  refunds, Excel, load/remove demo data), `admin_tickets.html` (the gate's check:
  type the code or scan the QR with the phone's `BarcodeDetector`, else jsQR
  loaded on demand; `admit` is one conditional update, so a ticket is used once),
  "Paid online" and "Cancel and refund" on Guide Bookings, a collections line on
  the Dashboard. One refund rule: the office cancels, the visitor is refunded;
  a plain cancel of an online-paid booking is refused. A refund goes back
  through Xendit (`POST /refunds`, `invoice_id`, an `Idempotency-key` per
  payment so a second click asks for the same refund) only for a payment one
  of our invoices made; seeded and counter payments are recorded only.
- **Demo data:** `POST /api/payments/demo` replaces the generated sample
  (`TG-DEMO-` bookings, tickets with no checkout) and keeps test-mode payments;
  `DELETE /api/payments/demo` removes everything `is_demo`. Real records are
  never touched.
- Money never reaches Statistics or Form A4, which stay counts only.

### Attraction setup

`attractions.js`, mounted at `/api`, and the officer's **Visitor setup** window
on Destinations (`admin_dashboard_manage.html`), for office-run attractions and
guided destinations:

- **Opening days** are `spots.working_days`, the text visitors read. The listing
  form and Visitor setup tick weekdays; `open-days.js` (both sides) writes the
  ticks as text ("Tuesday to Sunday") and reads text back, older free text
  included ("Closed Mondays", "Mon–Fri"). Text naming no day is unknown and
  means open every day — a sale is never refused on a guess.
- **Closed dates** (`spot_closed_dates`). Adding one that already has valid
  tickets or live guide bookings is refused: closing a sold date is the
  closure action's job (cancel, refund or move, tell each visitor).
- **Prices per kind of visitor** (`feeTable`): regular is the entrance fee;
  senior citizen and PWD always 20% off it (a rule, not a setting);
  `student_fee` and `child_fee` + `child_age_max` are offered only when set.
  A ticket counts people by kind (`tickets.count_regular|senior|pwd|student|child`)
  and keeps the price each kind paid (`fee_regular|senior|pwd|student|child`,
  read by routes as `feeBreakdown`); `people` and `amount` are worked out by
  the database (see "Normalisation"); `priceTickets` prices a purchase from the counts, and the
  gate's check says whose ID to look at. No ID is ever stored.
- **`cancel_keep_percent`**: the share kept when a visitor cancels, for tickets
  and guide bookings at that destination.
- `dayVerdict(spot, date)` is the one answer to "can visitors come that day?",
  used by ticket sales and guide bookings alike; the public ticket offer and
  guide requirement carry `openDays` and `closedDates` so the forms say so first.

### The visitor's journey (Home → destination → pay → after)

Frontend only, no tables of their own:
- **Home** (`index.html`, `#browse`): a "How it works" strip (Discover → Book &
  pay → Get there, `.how-it-works`) and four category photo tiles
  (`#categoryTiles`, `.category-tile`; photo = the first listing of that
  category with one). Tiles and the category dropdown are one control
  (`setCategory`); a second tap shows everything. The search and category are
  kept for the visit in `sessionStorage.ztimsBrowse`, and `?category=` opens a
  category (the destination page's breadcrumb links there).
- **Header**: every visitor page has "My booking" → `manage.html`.
- **Destination** (`spot.html`): a breadcrumb (Destinations › category ›
  place); the actions the place really offers — Buy tickets, Book a guide, Book
  now (its own booking link), Directions — as `#actionBar` under the photo on a
  computer and `#mobileActions` fixed to the bottom of a phone (`drawActions`;
  never both); "Nearby places to visit" (nearest first when both have a pin,
  else "More places to explore", same category first; `renderRelated`).
- **Steps** (`.journey-steps`): booking a guide shows Your details → Payment
  (or Pay onsite) → Confirmed; tickets show Date & visitors → Payment → Your
  ticket; `payment.html` continues the same steps.
- **After paying** (`payment.html`): "What's next" — the date, Directions
  (`spot.html?spotId=…#directionsSection`; the checkout view carries `spotId`
  for both kinds), Add to calendar (an `.ics` made in the browser: the whole
  day for a ticket, three hours from the chosen time for a tour, Manila time),
  and Move or cancel (`manage.html?code=`).

### Visitor emails and "Manage my ticket / booking"

- **`mailer.js`** sends through the office's Gmail (`MAIL_USER`, `MAIL_PASSWORD`,
  an App Password — the same account as the staff password reset). It never
  throws and gives up after 8 s: an email is a courtesy, never the record, so a
  missing setting or a refused message is logged and the change stands. Pages
  only say "we have emailed you" when the server says it went (`emailed`).
  `MAIL_TRANSPORT=file:/path` writes messages to a file, for local tests only.
- **`notices.js`** writes each email from the database: ticket receipt (the QR as
  an attached PNG — mail apps block inline images), booking received, booking
  paid, guide confirmed, moved, cancelled, and (closures) the office's notice.
  An online payment's receipt is sent only by the call that recorded it
  (`recordPaid`'s `justPaid`), so the return page and Xendit's callback never
  send two. Links carry the code, never the email address.
- **`manage.js`** (`/api/manage/lookup|move|cancel`, rate-limited) and
  `src/manage.html`: the code (or booking reference) AND the email, together.
  Changes close at 11:59 PM Manila time the day before. A visitor's cancellation
  refunds the amount less `cancel_keep_percent` (a partial Xendit refund,
  `payments.refund_amount`); the office's refunds return everything. A used
  ticket is never moved or refunded; a moved guide booking loses its guide and
  goes back to the office; a counter-paid booking can be moved here but is
  cancelled at the counter. Collections counts what was kept.
- **Closures** (`POST /api/spots/:id/close-date`, Visitor setup's "Close this
  date anyway?"): one transaction marks the date closed, puts every paid ticket
  and booking for it in status `closed` (out of use; the gate says so) and
  cancels the unpaid ones; then each visitor is emailed (`closureNotice`). A
  `closed` one is the visitor's to settle on the Manage page whatever the
  deadline: a full refund (`/api/manage/refund-closure`) or a new date, which
  makes it valid (ticket) or confirmed without a guide (booking) again. A
  counter-paid booking is refunded at the counter. The office cannot set
  `closed` by hand; Visitor setup shows how many visitors still have to choose.

A serverless host has no single startup, so nothing runs at boot: the
database pool in `db.js` opens its first connection when the first query
needs one (a route that never queries, like `/api/directions/capabilities`,
never waits on the database), and the schema and `bootstrapAdmin` run only
when someone runs `npm run migrate` (see `runMigrations` and the header of
`migrate.js`). MongoDB's two in-place reshapings (`resortName` →
`establishmentName`, `ownerId` → `managedBy`) are gone: the copy script
translated both on the way across, and the schema is that history now.
`bootstrapAdmin` reads `INITIAL_ADMIN_EMAIL`/`INITIAL_ADMIN_PASSWORD` to create
the first officer account if none exists yet, and `ADMIN_PASSWORD_RESET=true`
to force a reset on an existing one — both are meant to be deleted from the
environment once used.

### Normalisation

The schema keeps one fact in one place (3NF), with `schema.sql`'s
"Normalisation" block converting a database from before:

- **Worked out, never typed in** (Postgres generated columns): `tickets.people`
  (the counts added up), `tickets.amount` (counts × prices),
  `monthly_report_counts.total` (male + female, or `total_unsplit` for a month
  with no split, the 2025 sheet), `online_checkouts.kind` (from which reference
  is set). Writing one is an error, so models mark them `generated`.
- **One value per column or row**: a listing's gallery is `spot_photos` (one
  row per photo, `position` 0–29; routes still see `spot.images`, written by
  `spots.create/save` in one transaction); a guide's days are
  `works_mon…works_sun` (routes still see `availableDays`); a ticket's prices
  are `fee_*` columns (routes still see `feeBreakdown` and `unitFee`).
- **Not stored**: a listing's municipality and province (always Zamboanguita,
  Negros Oriental — `MUNICIPALITY`/`PROVINCE` in `models.js`, added on read)
  and status note; the account ids that sat beside `payments.recorded_by_email`
  and `monthly_reports.submitted_by_email`.
- **Kept on purpose**: what a record says about its own moment — the price a
  ticket was bought at, who recorded or changed something (by email, so it
  outlives the account), where a guide's report happened. Those are facts of
  that record, like a receipt's price, not copies to keep in step.

### Listings, guides and the visitor's day out

- **One establishment, one listing.** A manager account keeps exactly one
  listing (`spots_one_per_establishment`, a unique index on `managed_by`, and a
  plain 409 in `POST /api/spots` first). The manager creates it and it is live
  at once; their edits go live directly. Listings the office keeps
  (`managed_by` null) are not limited.
- **One tour per guide per day**, whatever the time (`isGuideFreeOn`): tours run
  for hours, and a busy guide leaves the others a turn.
- **Visitors' details are kept one year.** `privacy.js` erases names, phones and
  emails from guide bookings and tickets a year after the visit, and from
  feedback a year after it was resolved; dates, counts, countries, amounts and
  OR numbers stay. Run daily by Vercel's cron (`vercel.json` →
  `GET /api/maintenance/privacy`, which needs `CRON_SECRET`) and whenever the
  officer opens Guide Bookings. The Privacy page says so.
- **A guide cannot leave booked tours behind.** `PATCH /api/guides/me/availability`
  refuses Unavailable, or dropping a weekday, while a confirmed tour still to come
  falls on it, and names the bookings: the office reassigns them first.
- **Emergency numbers** are kept by the officer on Settings → Office Information
  (`emergency_numbers`, one row each) and show in the footer and each
  destination's `[data-emergency]` box; nothing shows while there are none.

### Settings (the officer's `admin_profile.html`)

- **My Account**: the officer's full name, position and contact number
  (`tourism_officers.full_name|position|contact_number`; `GET`/`PATCH
  /api/admin/me`), shown with initials, never a photo. The sign-in email is
  the account's identity and is not changed here. The name is stored as
  `localStorage.userName` at sign-in and shown in every officer page's account
  menu.
- **Security**: change password (`/api/admin/me/password`, needs the current
  one) and when this session signed in (`last_sign_in_at`, set at each login).
- **Tourism Office Accounts**: every officer with position, date added, last
  sign-in and status. Add one (name required; a blank password is generated
  and shown once), issue a new password (`POST /api/admin/:id/password`), and
  deactivate or reactivate (`PATCH /api/admin/:id/status`). Officers are never
  deleted; nobody deactivates themselves; a deactivated officer cannot sign in
  or reset a password, and an open session stops at once.
- **Office Information** (`office.js`, `office_info` single row +
  `emergency_numbers`): address, phone, email, office hours and the emergency
  list. `GET /api/office` is public (cached 5 minutes), `PUT /api/office` is
  the officer's and replaces the emergency list in one transaction.

## Duplicated facts (keep both sides in step by hand)

- **Zamboanguita bounding box**: `ZAMBOANGUITA_BOUNDS` in
  `Zamboanguita-project/src/shared/spot-form.js` and
  `ZAMBOANGUITA_SEARCH_BOX` in `zamboanguita-backend/server.js`. Deliberately
  a coarse envelope, wider than the municipality — used only to reject
  wildly-wrong pins and to bias search ranking, not as proof a pin is inside
  the municipality.
- **Barangay list**: `BARANGAYS` in `spot-form.js`, mirrored in the chips/count
  on `src/history.html` and in `BARANGAYS` in `server.js` (which validates a
  guide's barangay scope and serves the list to the guide portal and the
  officer's Tourist Guides page, so those pages keep no copy). The dropdown
  only accepts a name in this list, and reverse-geocoding is matched against
  it — a missing barangay makes auto-detection silently fail for listings in
  it, and makes a barangay guide for it impossible to create.
- **Country list**: `src/shared/countries.js` (names) vs `COUNTRY_CODES` in
  `server.js` (codes only, validates what the form sends). Checked by
  `npm run check` in the frontend.
- **Opening-days reader**: `zamboanguita-backend/open-days.js` (decides what is
  sold) and `Zamboanguita-project/src/shared/open-days.js` (the forms). Checked
  by `npm run check` in the frontend.

## Standing constraints

Decisions already made on purpose — don't reintroduce what they rule out:

- No API key (ORS, Cloudinary secret, etc.) ever reaches frontend source; all
  third-party calls needing a key are server-side.
- A visitor's GPS coordinate is used for a directions request and discarded,
  never stored. A manager's own position becomes a listing's coordinates only
  when they explicitly press Confirm in the location picker.
- Authorization is enforced backend-side only. Hiding a button client-side is
  never treated as a control.
- Online only. The site needs a connection: nothing works offline (no service
  worker, no offline gate check, no sealed or offline-checkable QR codes, no
  saved routes), as the manuscript's Limitations say. Don't add offline features.
- No `tourist` role, no tourist accounts. Online payment exists only as a
  **demonstration in Xendit's test mode** (see "Online payments" above): a
  live key is refused, every online record is `is_demo`, and paying onsite at the
  Municipal Tourism Office always stays available. Collecting real fees would need a
  municipal ordinance, the Municipal Treasurer, a merchant account in the
  municipality's name and COA-compliant official receipts — don't switch it to
  live keys.
- Tourism records (spots/listings) are never hard-deleted, only marked
  inactive. Statistics reports likewise: voided, never deleted.
- Tourism statistics hold counts and totals only — no revenue and no
  percentages.
- The hero video on `index.html` intentionally has no dark scrim over it
  (readability is carried by per-letter text-shadow/stroke instead) — see the
  large comment block in that file before changing hero text treatment.

## What to do 
Make it one role with a scope, not two roles

Create a single Tour Guide role, and give the account an assignment scope:

scope = municipal → covers the whole municipality
scope = barangay + barangay_id → covers only that barangay

Everything else (login, dashboard, schedule, languages, profile) is the same code. The scope just filters what they see and what the officer can assign them to. Two separate roles means two sets of pages, two permission tables, and double the bugs — and in your defense a panelist will ask "why are these different users if the screens are identical?" The scope answer is clean: same function, different jurisdiction.

Per module

Dashboard / reports — barangay guide sees only tours in their barangay; municipal guide sees all. Same query, different WHERE. Reports they file (tour completed, headcount, incident, tourist feedback) should roll up to the officer, and barangay reports should also be filterable by barangay so the officer can see which barangay is actually getting traffic. That rollup is a real finding for your Chapter IV.

Schedule & availability — let the guide set availability, but only the officer confirms an assignment. Guide proposes, officer disposes. Prevents double-booking and keeps your "managed by the tourist officer" claim true in the data, not just on paper.

Languages — make it a many-to-many table (guide_languages), not a text field. Then the officer can search "who speaks Korean and is free Saturday" — that single query is probably the most impressive thing you can demo.

Profile — the guide edits their own contact number and bio directly (no approval step); the officer keeps name, scope, fee, group size, destinations and photo.