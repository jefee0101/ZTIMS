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
Tourism Officer and Establishment Manager; visitors pay
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
npm run check    # check-undefined.cjs && check-open-days.cjs
```
`npm run check` is the safety net for the two failure modes ESLint can't see
because these pages carry inline `<script>`, not modules:
- `check-undefined.cjs` — parses every page's inline + local `<script>` as one
  shared scope and flags identifiers that are read/called but never defined
  anywhere on the page. Catches a helper deleted alongside dead code while a
  caller was left behind.
- `check-open-days.cjs` — runs the page's and the server's opening-days reader
  (`open-days.js`, one on each side) on the same texts and every combination of
  ticked days, and fails if they disagree. Needs a sibling backend checkout;
  skips (exit 0) if `../zamboanguita-backend` isn't present.

Run `npm run check` and `npm run build` before committing changes to any
`src/**/*.html` page.

Backend (`zamboanguita-backend/`):
```
npm run dev           # nodemon server.js
npm start              # node server.js
npm run migrate        # node migrate.js — applies db/schema.sql (idempotent)
                       # and the first-officer bootstrap (not run at startup)
npm run create-admin   # node create-admin.js
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
`src/admin/*.html`, `src/resort/*.html`, `src/user/*.html`), each loading
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
  and its Zamboanguita bounding-box sanity check. Its look is the standard one wherever it
  opens: the four steps as round numbered buttons joined by a line
  (`.sf-steps`, like the visitor's ticket steps), sentence-case labels, pills
  for the secondary controls (`.sf-chip`), open days as pills, yes/no settings
  as switches (`.sf-switch`), and a Cancel / Next / Save row that stays at the
  bottom of the window (`.sf-footer`). **Adding** walks Back / Next to Publish
  and cannot skip ahead; **editing** shows only Cancel and Save changes, and
  any step opens straight away. The preview says "Free entrance" and prices
  have no cents. Windows outside `<main>` take the flat buttons from
  `portal-flat.css` (`.ztims-modal .btn…`).
- `tourism-map.js` — Leaflet + OpenStreetMap tiles + ZTIMS's own category
  markers, and the one list of categories every page uses
  (`window.ZTIMS_CATEGORIES`: `CODES`, `info`, `label`, `of(spot)` — the main
  one first — `isStay`, and `matches(spot, filter)` with `'STAY'` for places to
  stay; old codes are read as their new ones). Never calls a routing provider directly; hands off to the backend's
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
  `<footer data-site-footer data-root="../">` placeholder so the visitor pages
  share one copy. Across its top runs a strip of ten flat tiles of Zamboanguita
  (sun and sea, bangka, reef fish, turtle, palms, waterfall, heritage church,
  Malatapay market, two patterns) in the identity's oranges, cream and ink —
  inline SVG (`tileStrip`), decoration only. The office's address, hours, phone, email and emergency
  numbers come from `GET /api/office` (Settings → Office Information); until
  they load, the built-in address and hours show and nothing else. It also
  fills Contact Us's `[data-office-field]` spots and the destination pages'
  `[data-emergency]` box.
- **The staff portals' header** (officer and manager — the fixed
  `header.glass-nav` beside the sidebar) wears the footer's tile strip, one
  tile high, from `/tiles.svg` (one rule in `theme.css`; no colour, border or
  shadow behind the tiles, so browser zoom can never show a line under them);
  its buttons sit on
  solid grounds, on the right on every portal.
- `portal-flat.css` — the flat, standard look for both staff portals
  (every `src/admin/*.html` and `src/resort/*.html`,
  after theme.css and motion.css): flat outlined panels
  and cards, sentence-case labels, pill buttons (no gradient) and status
  pills, the current page in the menu a solid burnt-orange pill with
  off-white words (`.is-current` on the page's own link; the officer's
  `.nav-active` from nav-active.js, outranked so its old tint never shows),
  labels, kickers, table headers and status tags in sentence case (codes typed
  in capitals excepted), sideways-scrolling tables holding their own hidden
  labels with labels wrapping rather than
  cut, and the subpage tabs (`.settings-tab`).
- **The manager's Establishment** (`resort/resort_spots.html`, the menu's
  "Establishment"; it was "My Listing"): the whole listing on one page in five
  subpages — `#basics`, `#location`, `#visiting`, `#photos`, `#contact` — shown
  as folder tabs hanging upside down from the header's lower edge (`.est-tabs`
  in `portal-flat.css`, inside the fixed header so they stay with it; the open
  one is the header's glass with a burnt-orange edge). The tabs are curved at
  the bottom (the user's choice) and, where a pointer can hover, tucked up
  behind the header with only their edge showing: each slides down when
  pointed at or focused, and the open one stays down. On touch screens all
  stay down. They are solid orange (the user's choice): tangerine with ink on
  it, the open one burnt orange with off-white on it. Each subpage shows the
  saved facts plainly (`.est-fact`; missing required facts in red, empty
  optional ones "None") with "Last updated" and one Edit button. Edit opens the
  shared listing form on that part only (`spotForm.openSection(spot, step)`:
  no step rail, no preview, just the fields and Save — the whole listing is
  still sent to `PUT /api/spots/:id`); Contact edits the account's
  establishment name, manager, phone and public email in a small window
  (`PATCH /api/establishment-managers/me`). Above them, a checklist of what
  visitors need (description, map pin, open days and hours, 3 photos, phone),
  each linking to its subpage, and "See it as visitors do". Location shows a
  small map from OpenStreetMap tiles (3 × 3 around the pin, `pinMap`). "Remove
  listing" is a small solid red pill at the end of Basics. With no listing yet,
  the page offers "Create your listing" (the full four-step form).
- **The manager's Account** (`resort/resort_settings.html`, was "My
  Establishment"), laid out like the officer's Settings: two tabs with their
  own addresses — `#account` (My Account: initials, full name and contact
  number, saved by `PATCH /api/establishment-managers/me` — the same
  `managerName`/`phone` Establishment → Contact shows visitors — plus the
  sign-in email, read only and set by the Tourism Office, and account issued)
  and `#security` (signed in since, change password, sign out of all devices).
- **The manager's Guest Register** (`resort/resort_register.html`, in the
  menu between Establishment and Monthly Report): the place's own log through
  the month, so nobody adds up by hand. A place to stay logs each **stay**
  (check-in date, nights, rooms, and who came: country of residence with male
  and female, − / + steppers, Add a country); an attraction logs each
  **group** (date and who came). Month picker, four tiles (Guests arrived,
  Room-nights, Guest nights, Stays — or Visitors, Male, Female, Groups), "By
  country", one row per entry (`.rg-row` in `portal-flat.css`) with Edit and
  Remove (red), and "Open the monthly report" (`resort_statistics.html?month=`).
  Tables `register_entries` (+ `register_entry_guests`, counts per country,
  never a name); routes `GET /api/statistics/register/:spotId/:year/:month`,
  `POST /api/statistics/register/:spotId`, `PUT|DELETE
  /api/statistics/register/entries/:id`, allowed to whoever enters that
  place's reports (`mayEnterFor`). Totals (`registerTotals`): a stay's guests
  arrive in its check-in month; its room-nights and guest nights fall in the
  months they are spent in, so a stay over a month's end is split. The register
  only helps: the monthly report stays the record — `stat-form.js` shows "Fill
  from the Guest Register" when the month has entries, fills the boxes, and the
  manager checks and saves. A new accommodation report starts from the rooms
  in the place's last report (`lastRooms` on the report read; "From your last
  report").
  The officer has the same page (`admin/admin_register.html`, in the menu after
  Statistics) with a Place picker, the office's own places first: it keeps the
  register for those, and sees a private place's register view only (Tourism
  Office / Private banner, Add and Edit hidden). Its "Open the monthly report"
  opens Statistics → Enter a report at that place and month
  (`admin_statistics.html?place=&month=#enter`). A manager with one place sees
  its name, not a picker, on the Guest Register and Monthly Report.
- `stat-form.js` — the monthly statistics report form (Form A4 counts by
  country of residence and sex, plus rooms and guest nights for an
  accommodation), used by `src/resort/resort_statistics.html` and the
  officer's `src/admin/admin_statistics.html`. See "Tourism statistics" below.
- `open-days.js` — reads a destination's "working days" text into weekdays and
  writes ticked days back as text (`window.ZTIMS_OPEN_DAYS`); used by the
  listing form's day boxes and the officer's Visitor setup. See "Attraction
  setup" below.
- `idle-signout.js` — signs an officer out after 30 minutes with no activity on
  any officer tab (loaded as a module on every `src/admin/*.html` page). See
  "Sign-in safety" below.
- `photo-upload.js`, `nav-active.js`, `ztims-dialog.js` —
  smaller per-concern shared pieces.

### Design system

Glassmorphism over one orange identity (`--brand-*` in `theme.css`), decided
October 2026: tangerine and burnt orange on warm off-white and off-black —
never pure white or pure black. The full table is at the top of `theme.css`:
burnt orange `#BF5700` primary actions, links, active navigation; ember
`#7A2E00` (deep burnt orange) primary's pressed state, the hero, a map route;
tangerine `#F28500` highlights, focus rings, map/directions actions,
"waiting" status — always as a fill with ink on it, never text on the light
ground; ink `#1C1917` (off-black) text and the visitor's position on a map;
paper `#FAF7F2` (off-white) the light ground, `#121110` the dark one. Red
(errors, destructive) and green (success) are the only colours outside the
identity, so a status never looks like a brand colour. Categories use the four
shades on badges, map pins and legends (Beach & Sea, Diving and Leisure &
Recreation tangerine, Nature and Adventure ember, Culture & Heritage and Faith
burnt, Places to stay ink), always with their name and icon — several share each
colour, so the icon tells them apart (the map legend shows each as its pin); the
category badge (`.cat-badge`) is a pill everywhere. Emails
(`mailer.js`, the reset email in `server.js`) use the same colours.

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
  including over the brightest part of the glow. Tangerine is never text on
  the light ground (2.4:1) — it has an ink shade (`--ztims-gold-text`), burnt
  orange has `--ztims-primary-text`, and each category has `--ztims-cat-*-ink`. Don't use Tailwind's own palette
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
  Toasts are pills on every page: each page builds them in `#toastHost`, and
  one rule in `theme.css` (`#toastHost > *`) shapes them all — solid surface,
  hairline outline, the tone in the icon only.
  **Leaving and destroying are red** (the user's decision, every page, rules
  at the end of `theme.css`): Delete / Remove / Cancel a ticket and a
  dialog's destroying confirm (`.btn-danger`) are a solid red pill, the same
  deep red in both themes; a Cancel that only closes a form or dialog, Discard,
  and Sign out of all devices (`.btn-cancel`, `#signOutEverywhereBtn`) a red
  outlined pill, so Cancel never looks like Delete (ztims-dialog's cancel is
  `.btn-cancel` only when it reads "Cancel"; "Keep it" / "Go back" stay
  neutral); Log Out in the portals' menu red, a solid red pill on hover; the
  small removes (a photo, a language, an emergency number) and the map's
  Cancel while pinning red.
  Loading spinners (`animate-spin`, on every page) are a smooth circle — a
  faint ring with one arc turning — by one rule in `theme.css`, whatever
  square corners the page's config gives.
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
no data of its own: it reads the officer's existing endpoints (spots,
establishment managers, feedback, `/api/statistics/tracker` and `/form-a4`,
`/api/payments`) and shows what is waiting on each — every card links to the
page where it is dealt with, Statistics through the tab named in the link's
address (`admin_statistics.html#tracker`) — plus the month just ended's Form A4
reports, the month's collections, and Form A4 counts by month and by country. Counts only, like the statistics themselves. Its "Add new
spot" publishes, then opens Destinations at `?new=<id>`, which finds that
listing (search filled in, scrolled to, marked for a moment with
`.just-published`), says it is live, and drops `?new` from the address.

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
  schemas were, plus the few joined queries (a listing with its establishment).
  `server.js` imports them under the old model names (`Spot`, `Payment`, …;
  `Admin` became `TourismOfficer`)
  so each route reads as it did.

Ids are text, 24 hex characters: the records copied from MongoDB kept their
ObjectIds, so shared links and signed-in sessions survived the move. Table names
say what the records are (`tourism_officers`, `establishment_managers`), which
the old collection names (`admins`, `resortOwners`) did not.

`server.js`, top to bottom:

1. Middleware: `helmet`, CORS (a page's own origin, the `CORS_ORIGIN` env
   allow-list, and this deployment's own Vercel addresses from `VERCEL_URL`,
   `VERCEL_BRANCH_URL` and `VERCEL_PROJECT_PRODUCTION_URL` — never "any
   `*.vercel.app`", which would trust anyone's site there; see
   `isSameOrigin` / `isAllowedOrigin`), rate limits, JSON body parsing
   capped at 1MB (photos go straight browser → Cloudinary, never through this
   API). The limits that guard something (login, password reset, tickets,
   feedback, directions) go through `sharedRateLimit`, which counts in the
   `rate_limits` table (`rate-limit-store.js`) so they hold across serverless
   instances; only the blanket per-request limit stays in memory, on purpose.
2. `runMigrations` and `bootstrapAdmin` (see below).
3. Auth middleware chains: `requireAuth` (a JWT checked as HS256 with its
   issuer and audience, then the account itself: it must exist, its
   `session_version` must match the token's `sv`, and it must not be waiting to
   replace an issued password; the row is `req.account`) →
   `requireAdmin`/`requireEstablishmentManager`/`requireStaff`
   (role checks; `requireAdmin` also refuses a deactivated officer, so their
   open session stops at once), `requirePasswordConfirmation` (after
   `requireAdmin`, on risky actions — see "Sign-in safety") and `optionalAuth`
   (attaches `req.auth` for a current, usable sign-in, never blocks). Roles: `admin` (Tourism Officer) and `establishment_manager` (Tourist
   Establishment Manager) —
   `'resort_owner'` is a legacy spelling of the manager role, kept only so
   tokens issued before a rename don't get rejected mid-session; nothing
   issues it anymore. `requireStaff` (officer or manager) guards listing writes
   and upload signing. There is
   deliberately no `tourist` role or tourist account at all — visitors browse
   without logging in. Both sign in on the one staff page; the login
   route searches officers, then managers, so `emailTakenBy`
   refuses any sign-in email another account already uses.
4. Routes, grouped by resource: admin, establishment-managers, login/forgot/
   reset-password, spots (listings), payments and tickets (`payments.js`),
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

### No tour guides (taken out October 2026)

ZTIMS has no tourist guide feature (the user's decision, October 2026): no
Tourist Guide role or accounts, no guide portal, no Tourist Guides or Guide
Bookings page, no guide booking for visitors and no "requires a tourist guide"
on a listing. `schema.sql`'s last block ("Tour guides taken out") deleted the
guide tables and records — guides, their destinations and languages, their
reports, the guide bookings, and the payments and checkouts made for them —
and `spots.requires_guide`. Don't bring any of it back unless the user asks.

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
- **Nothing from tickets.** Establishments report their own already-totalled
  month; ZTIMS never derives these figures from tickets sold.
- **Who reports.** A manager, for the listing they manage. The officer, for
  the places the office keeps (listings with no manager) only: a privately
  managed establishment's reports are its manager's to enter, and the officer
  views them (`mayViewFor` / `mayEnterFor` in `statistics.js`; the officer's
  "Enter a report" tab shows them read-only). `kind` comes from the listing: an accommodation reports arrivals,
  rooms and nights; an attraction reports its arrivals only (no rooms or
  nights).
- **Arrivals are arrivals at places** (the user's decision, October 2026):
  Form A4's Part I adds every place's report — places to stay and
  attractions, the office's and private ones — so a guest counts once at each
  place they arrive at (Mark stays two nights at a resort and visits the falls:
  2 arrivals, 2 guest nights). Part II (rooms, room-nights, guest nights) is
  places to stay only; its volume per sex is Part I's arrivals by sex. Don't
  split attraction arrivals back out into a separate part or page.
- **One report page.** Statistics has three tabs: Arrivals Report, Enter a
  report, Tracker (no separate Attractions tab or route). The Arrivals Report:
  Part I arrivals by country, Part II overnight stays (places to stay), then
  **Arrivals by place** (`formA4()`'s `places`: every place, places to stay
  then attractions, each with its Tourism Office / Private tag, "–" for a
  month not reported). The Excel has the Form A4 sheet ("GRAND TOTAL
  ARRIVALS") and a "By place" sheet.
- **The page's look** (the standard): title only; Arrivals Report has Year /
  From / To, Generate, Download Excel and **Only countries with arrivals**
  (ticked by default: a country or region with nobody in those months is left
  out, totals stay; the Excel always lists all 72 rows), four number tiles
  (Arrivals, Guest nights, Places reported of all places, Reports), municipal-total and finalized months as pills. Tracker: Year and
  Places (Places to stay / Attractions), a one-line legend of the cell pills,
  the on-time / late / missing counts as pills. **Who runs a place** shows
  everywhere a place is listed in Statistics (the user's decision): `.own-tag`
  pills in `portal-flat.css` — Tourism Office (tangerine, `account_balance`)
  or Private enterprise (ink outline, `storefront`; "private enterprise", never
  "private establishment", the panel's wording, October 2026) — and a bar down the row's left edge
  (`.own-row--office` tangerine, `.own-row--private` ink with a faint tint);
  Enter a report shows the same as a banner (`.own-banner`): "The Tourism
  Office enters this report" or "Entered by <manager>. View only."
  `formA4()`'s `places` carry `keptByOffice` for this.
- **Rows.** `residences` is Form A4's 72 rows in the form's order (ISO codes,
  plus `ph-filipino`, `ph-foreign`, `cis`, `other-foreign`,
  `overseas-filipino`, `unspecified`), seeded by `schema.sql`. It lives only
  in the database — the form fetches it — so it is not duplicated anywhere. Each row shows its flag beside the name, in the
  report form and the officer's Arrivals Report (`flag` in `stat-form.js`,
  `.sf-flag` in `theme.css`): small SVGs in `Zamboanguita-project/public/flags/`
  (copies of flag-icons 7.5.0, MIT, `LICENSE.txt` beside them; only the
  countries Form A4 lists), served from the site itself, never emoji (Windows
  shows those as letters) and never an outside host. The Philippine rows and
  overseas Filipinos take the Philippine flag; CIS, other foreign and
  unspecified take an icon. A country added to `residences` needs its flag
  copied there too.
- (Statistics read a place's kind from `spots.type`, never its categories.)
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

`payments.js`, mounted at `/api`: a visitor buys entrance tickets
(`POST /api/tickets`) on a Xendit hosted invoice, and
comes back to `src/payment.html?c=<checkout id>`. Tickets are sold only for
attractions the office runs (`managed_by` null, published, `entrance_fee` > 0).

- **Test mode only.** `XENDIT_SECRET_KEY` must start `xnd_development_`; anything
  else (a `xnd_production_` key above all) switches online payment off
  (`gatewayState`). Every online payment, the ticket it paid for, and the
  generated sample data carry `is_demo`.
  Visitor pages and emails do not label it "test mode" (decided); Xendit's own
  checkout page shows that, and Terms, Privacy and FAQ still say so. Paying in
  person is called paying **onsite** (never "at the gate").
- **The server decides.** Amounts come from the fees on record (`priceTickets`). A
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
- **Tables** (`schema.sql`): `tickets`, `online_checkouts` (one ticket each);
  `payments` belongs to one ticket and has `channel` (counter/online),
  `gateway_ref`, refund fields and `is_demo`. 19 tables in all, with
  `spot_closed_dates`, `spot_photos`, `spot_more_categories`, `office_info`,
  `emergency_numbers` and the Guest Register's `register_entries` /
  `register_entry_guests`.
- **The office:** `admin_collections.html` (money per month and day, OR numbers,
  refunds, Excel, load/remove demo data), `admin_tickets.html` (the check: type
  the ticket code — tickets have no QR, by the user's decision: most places
  have no entrance or staff to scan one; `admit` is one conditional update, so a ticket is used once),
  and a collections line on the Dashboard. One refund rule: the office
  cancels, the visitor is refunded. A refund goes back
  through Xendit (`POST /refunds`, `invoice_id`, an `Idempotency-key` per
  payment so a second click asks for the same refund) only for a payment one
  of our invoices made; seeded and counter payments are recorded only.
- **Demo data:** `POST /api/payments/demo` replaces the generated sample
  (tickets with no checkout) and keeps test-mode payments;
  `DELETE /api/payments/demo` removes everything `is_demo`. Real records are
  never touched.
- Money never reaches Statistics or Form A4, which stay counts only.

### The officer's Destinations (`admin_dashboard_manage.html`)

Flat and short, the important facts first: the title and **Add destination**
(the shared listing form, empty; a new place is then found, scrolled to and
marked, as from the Dashboard's `?new=`); the starter list as one line with
"Publish them" while any are missing; counts that filter — All, Tourism Office,
Private enterprises, Needs attention (red count) — then the category pills (one
scrolling row on a phone) and the search. Each place is one row (`.dest-row`
in `portal-flat.css`): photo, name, category pills, one line of facts
(barangay · who runs it · entrance or Free · a travel fee only if set · open
days), what is missing as red pills ("No photo · Fix" opens the editor), then
**Edit** (office-run) or **View** (manager-run: only the manager edits it) and a
⋯ menu (View public page, Visitor setup where it applies, Take down in red).
Prices without cents. No Refresh button: the list reloads after every change.

### The officer's Establishment Managers, Tickets and Collections

Laid out like Destinations (same `.dest-chips`, `.dest-row`, `.dest-menu` from
`portal-flat.css`), no page intro or help lines:
- **Establishment Managers** (`admin_managers.html`): title and **New manager
  account**; counts that filter (All, Active, Suspended, No listing yet);
  search; one row per account (initials, establishment, manager · sign-in
  email · phone · since, Suspended / No listing yet pills), **Edit** and ⋯ (View
  listing, New password, Suspend / Restore, Delete in red).
- The list boxes have no `overflow-hidden`, so a ⋯ menu on the last row is never
  cut off (Destinations too). `ztims-dialog`'s field labels are sentence case.
- **Tickets** (`admin_tickets.html`): Check a ticket first (code, Check, Let
  them in), then "Tickets for
  today" (or the chosen date) with counts that filter (All, Not yet used, Used,
  Cancelled or closed) and one box per place ("6 of 8 people let in") with
  a row per ticket (`.tk-row`: code, name and people, status pill). A valid
  ticket for today or a day gone by has **Mark used** (a check, asked once):
  most places have no entrance or staff, so the office ticks it afterwards
  (the user's decision; `POST /api/tickets/:id/admit` takes any day up to
  today, never a later one).
- **Collections** (`admin_collections.html`): title with the online-payments
  pill, month and Excel beside it; four tiles (Collected, Online, Onsite,
  Waiting for an OR in red when any); Payments as counts that filter (All,
  Waiting for an OR, Refunded), search, and a row per payment (`.pay-row`,
  read top to bottom: the place, what was paid for and how many people, then
  labelled facts in fixed columns `.pay-facts` — Ticket code, Paid
  by, Paid with (method, online or onsite), Paid on — the amount large, the OR number or its field with Save, and ⋯ → Cancel and refund in
  red); Day by day (payments and total); Demo data as one line with its two buttons. Pesos are whole
  unless a refund left centavos.


### The officer's Feedback (`admin_feedback.html`)

Title; counts that filter (Open — new and read, the default — New in red,
Resolved, All); topic pills (one scrolling row on a phone); search. One row per
message (`.fb-row` in `portal-flat.css`): the topic's icon, the topic, status
pill and when, the whole message (never cut), "From" name · email and "Sent
from" the page; a new message has a tangerine edge. One main button — **Mark
resolved**, or **Reopen** once resolved — and a ⋯ menu (Reply by email, a
`mailto:` with a subject, when there is an email; Mark read for a new one). No
Refresh.

### Attraction setup

`attractions.js`, mounted at `/api`, and the officer's **Visitor setup** window
on Destinations (`admin_dashboard_manage.html`), for office-run attractions:

- **Opening days** are `spots.working_days`, the text visitors read. The listing
  form and Visitor setup tick weekdays; `open-days.js` (both sides) writes the
  ticks as text ("Tuesday to Sunday") and reads text back, older free text
  included ("Closed Mondays", "Mon–Fri"). Text naming no day is unknown and
  means open every day — a sale is never refused on a guess.
- **Closed dates** (`spot_closed_dates`). Adding one that already has valid
  tickets is refused: closing a sold date is the
  closure action's job (cancel, refund or move, tell each visitor).
- **Prices per kind of visitor** (`feeTable`): regular is the entrance fee;
  `student_fee` and `child_fee` + `child_age_max` are offered only when set.
  There is no senior citizen or PWD price (taken away October 2026, the
  user's decision): `priceTickets` refuses a count for a kind that no longer
  exists, so an old cached page can't buy fewer tickets than it shows, and
  `schema.sql` drops `count_senior|pwd` / `fee_senior|pwd` once no ticket
  counts anyone in them (until then they stay, unused).
  A ticket counts people by kind (`tickets.count_regular|student|child`)
  and keeps the price each kind paid (`fee_regular|student|child`,
  read by routes as `feeBreakdown`); `people` and `amount` are worked out by
  the database (see "Normalisation"); `priceTickets` prices a purchase from the counts, and the
  gate's check says whose ID to look at. No ID is ever stored.
- **`cancel_keep_percent`**: the share kept when a visitor cancels a ticket
  at that destination.
- `dayVerdict(spot, date)` is the one answer to "can visitors come that day?",
  used by ticket sales and the Manage page alike; the public ticket offer
  carries `openDays` and `closedDates` so the form says so first.

### The visitor's journey (Home → destination → pay → after)

Frontend only, no tables of their own:
- **Home** (`index.html`), top to bottom, flat (solid fills, hairline
  outlines, pill buttons, no gradients or shadows; styles in `theme.css`
  "Home page"): the **hero** — "Mabuhay", the headline "Welcome to
  Zamboanguita", one line naming the experiences and what the site does, the
  **search** (`#heroSearch`: field with name suggestions, category from 640px,
  Search scrolls to the results);
  **Explore Zamboanguita** (`#browse`; the heading is for screen readers, and on
  screen the cove's edge is a ribbon made of the footer's flat tiles
  (`window.ztimsTiles` from `site-footer.js`, as an SVG pattern), the same
  thickness as before, with one "EXPLORE ZAMBOANGUITA" on it, in the middle of
  the flat bottom, the tiles behind the letters (off-white with an ember
  outline, the user's choice) — `coveRibbon` in the page draws
  the curve at the cove's real size so tiles and letters are not stretched,
  and redraws on resize) — four category photo tiles
  (`#categoryTiles`, eight: the seven categories and Places to stay — two a row
  on a phone, four a row from 1024px; tiles and the category menu are one control,
  `setCategory`; a second tap shows everything), a status line only while a
  search or category narrows the list (`#browseStatus`, with "Show all"), and
  the cards; **Find it on the map** (`#map`, whose ground fades from the
  destinations' colour into its own over its top 8rem, `.home-map`); **Plan your visit** (`#plan`) —
  the three "How it works" steps and the Tourism Office card (hours, address,
  phone, email and emergency numbers from `GET /api/office` through
  `site-footer.js`'s `data-office-field` / `data-emergency`), with Contact the
  Tourism Office and Manage my ticket. The search and category are kept for
  the visit in `sessionStorage.ztimsBrowse`; `?category=` opens a category.
  A **card** (`.home-card`): photo, category, name (the card's stretched link),
  barangay, "Open …" from `workingDays`/`workingTime`, the fee ("Free
  entrance" at ₱0, none for a place to stay) and its main action
  (`mainAction`, the destination page's rules): Buy tickets (office-run
  attraction with a fee, and `/api/payments/config` says online), Book a room /
  Book now (its booking link, new tab), else "Details". On a phone the photo
  sits beside the words. Tickets open `spot.html` at `#tickets`, which
  `honourArrival` turns into the ticket form (or, if it never appears, a
  scroll to At a glance). Grey
  skeleton cards while loading; card photos after the fourth load lazily.
- **Header**: the same on all nine visitor pages (Home, destination, History,
  My ticket, payment, Terms, Privacy, FAQ, Contact; styles `.site-header` and
  `.site-link` in `theme.css`): the wordmark, then words-only links
  Destinations, Map (`index.html#map`), History, My ticket, Staff
  (→ `staff_login.html`), and the theme toggle last. On a phone it is two
  rows: the name and the toggle, then the links across the full width. A solid tangerine oval on
  hover/focus, a solid burnt-orange one on the current page
  (`aria-current="page"`; the destination page counts as Destinations). The
  theme toggle is a circle on every page, portals included (`#themeToggleBtn`
  and the `toggleDarkMode()` buttons, in `theme.css`). These curves are the
  user's decision; corners stay square elsewhere.
- **Destination** (`spot.html`): one column (`.spot-wrap`, ~52rem), read top to
  bottom in the order a visitor asks — the photo with the category pill, name
  and barangay; a breadcrumb (Destinations › category › place); the actions the
  place really offers as pills — Buy tickets, Book a room / Book now (its own
  booking link), Directions — as `#actionBar` on a computer and
  `#mobileActions` fixed to the bottom of a phone (`drawActions`; never both);
  **At a glance** tiles (`glanceFacts`: open days and hours, entrance or Free,
  a travel fee only if set, barangay); About; Photos (tickets have no section
  of their own: "Buy tickets" opens the ticket form in a window, `#ticketModal`
  built by `renderTicketOffer`, and the Entrance tile says "less for students
  and children" when those prices are set); Book your stay / visit (its
  booking link) or Contact; Getting there (address, emergency numbers, Get
  directions); "Nearby places to visit" (Home's card style; nearest first when
  both have a pin, else "More places to explore", same category first;
  `renderRelated`). Flat: the page's older gradient buttons are restyled as
  solid pills in its own style block; prices without cents (`peso`).
- **My ticket, History, Staff sign-in** (and the reset-password page) follow
  the same flat style: sentence-case labels above `.bk-field`s, flat
  `.spot-panel` cards, pill buttons, status and chips as pills (`.pill`,
  `.tone-pill.rounded-pill`), short titles ("My ticket", "Staff sign in",
  "How Zamboanguita came to be"), History's figures as `.spot-fact` tiles. The
  footer's Send feedback is a pill too.
- **Steps** (`.journey-steps`, a one-line progress bar: equal columns, a round
  number with its label under it, joined by a line; done green with a tick,
  current solid burnt orange). The ticket window: price line, Your visit (date; who is coming, one row per kind with a
  − / + stepper), Your details (name, email), a summary of lines and the total,
  and one button that says what it buys ("Buy 4 tickets · ₱180"), in the
  form styles in `theme.css` (`.bk-*`, `.qty` wired by `wireQty`); the steps
  are Date & visitors → Payment → Your ticket, and `payment.html` continues
  them.
- **After paying** (`payment.html`): "What's next" — the date, Directions
  (`spot.html?spotId=…#directionsSection`; the checkout view carries `spotId`),
  Add to calendar (an `.ics` made in the browser: the whole day, Manila time),
  and Move or cancel (`manage.html?code=`).
  Flat style like the other visitor pages: one bordered card (place, date, the
  ticket code large, people), then Paid, then "What's next". The page never says the
  visitor was emailed.

### Visitor emails and "Manage my ticket"

- **`mailer.js`** sends through the office's Gmail (`MAIL_USER`, `MAIL_PASSWORD`,
  an App Password — the same account as the staff password reset). It never
  throws and gives up after 8 s: an email is a courtesy, never the record, so a
  missing setting or a refused message is logged and the change stands. Pages
  only say "we have emailed you" when the server says it went (`emailed`).
  `MAIL_TRANSPORT=file:/path` writes messages to a file, for local tests only.
  The staff password-reset email goes through it too; its link is
  `PUBLIC_SITE_URL`, else the address the request came to (never the CORS
  list, whose first entry is a local test address when `CORS_ORIGIN` is unset).
- **`notices.js`** writes each email from the database: ticket receipt (the ticket
  code, to show on the email or a screenshot), moved, cancelled, and
  (closures) the office's notice.
  An online payment's receipt is sent only by the call that recorded it
  (`recordPaid`'s `justPaid`), so the return page and Xendit's callback never
  send two. Links carry the code, never the email address.
- **`manage.js`** (`/api/manage/lookup|move|cancel`, rate-limited) and
  `src/manage.html`: the ticket code AND the email, together. Its buttons are pills: Cancel solid red
  (`.btn-danger-solid`, the same deep red in both themes), Move and Refund
  outlined.
  Changes close at 11:59 PM Manila time the day before. A visitor's cancellation
  refunds the amount less `cancel_keep_percent` (a partial Xendit refund,
  `payments.refund_amount`); the office's refunds return everything. A used
  ticket is never moved or refunded. Collections counts what was kept.
- **Closures** (`POST /api/spots/:id/close-date`, Visitor setup's "Close this
  date anyway?"): one transaction marks the date closed, puts every paid ticket
  for it in status `closed` (out of use; the gate says so) and
  cancels the unpaid ones; then each visitor is emailed (`closureNotice`). A
  `closed` one is the visitor's to settle on the Manage page whatever the
  deadline: a full refund (`/api/manage/refund-closure`) or a new date, which
  makes it valid again. The office cannot set
  `closed` by hand; Visitor setup shows how many visitors still have to choose.

A serverless host has no single startup, so nothing runs at boot: the
database pool in `db.js` opens its first connection when the first query
needs one (a route that never queries, like `/api/directions/capabilities`,
never waits on the database), and the schema and `bootstrapAdmin` run only
when someone runs `npm run migrate` (see `runMigrations` and the header of
`migrate.js`). MongoDB's two in-place reshapings (`resortName` →
`establishmentName`, `ownerId` → `managedBy`) are gone: the one-time copy
script (since deleted) translated both on the way across.
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
  with no split, the 2025 sheet). Writing one is an error, so models mark them `generated`.
- **One value per column or row**: a listing's gallery is `spot_photos` (one
  row per photo, `position` 0–29; routes still see `spot.images`, written by
  `spots.create/save` in one transaction); a listing's other
  categories are `spot_more_categories` (routes see `moreCategories`); a ticket's prices
  are `fee_*` columns (routes still see `feeBreakdown` and `unitFee`).
- **Not stored**: a listing's municipality and province (always Zamboanguita,
  Negros Oriental — `MUNICIPALITY`/`PROVINCE` in `models.js`, added on read)
  and status note; the account ids that sat beside `payments.recorded_by_email`
  and `monthly_reports.submitted_by_email`.
- **Kept on purpose**: what a record says about its own moment — the price a
  ticket was bought at, who recorded or changed something (by email, so it
  outlives the account). Those are facts of
  that record, like a receipt's price, not copies to keep in step.

### Listings and the visitor's day out

- **Categories, by the visitor's purpose** (October 2026, the user's choice):
  Beach & Sea (`BEACH`), Diving & Snorkeling (`DIVING`), Nature (`NATURE`),
  Adventure (`ADVENTURE`), Culture & Heritage (`CULTURE`), Faith (`FAITH`), and
  Leisure & Recreation (`LEISURE`, icon `pool`: swimming pools, water parks,
  parks — added so a pool-only place has a home). A
  place can have several: `spots.category` is the main one (checked against the
  seven), `spot_more_categories` holds the others (one row each, never the main
  again; routes see `spot.moreCategories`, written by `spots.create/save` in the
  same transaction as the photos). Whether it is a **place to stay** is its own
  question, `spots.type` (`accommodation` | `spot`), and it alone decides the
  monthly report's kind, tickets and "Book a room". The form asks "Kind of
  place" (two pills) and "Known for" (seven pills to tick; the first ticked is the
  main one, marked Main); `normaliseSpotCategories` in `server.js` checks them
  and reads the four old codes a cached page may send. Home's tiles and filter
  are the seven plus Places to stay (`?category=` accepts old names too); a place
  shows under every category it has. `schema.sql` converted the old values once
  (ACCOMMODATION → a place to stay, Beach & Sea if its words speak of the sea,
  else Nature; BEACH / DIVING → Beach & Sea + Diving; MOUNTAIN → Nature, +
  Adventure for a peak or ridge; CULTURAL → Culture & Heritage, Faith first for
  a church) — the office and managers adjust from there.

- **One establishment, one listing.** A manager account keeps exactly one
  listing (`spots_one_per_establishment`, a unique index on `managed_by`, and a
  plain 409 in `POST /api/spots` first). The manager creates it and it is live
  at once; their edits go live directly. Listings the office keeps
  (`managed_by` null) are not limited.
- **Visitors' details are kept one year.** `privacy.js` erases names, phones and
  emails from tickets a year after the visit, and from feedback a year after
  it was resolved; dates, counts, amounts and OR numbers stay. Run daily by
  Vercel's cron (`vercel.json` → `GET /api/maintenance/privacy`, which needs
  `CRON_SECRET`, 2 AM Manila) and whenever the officer opens Tickets
  (`GET /api/tickets`). The Privacy page says so.
- **Emergency numbers** are kept by the officer on Settings → Office Information
  (`emergency_numbers`, one row each) and show in the footer and each
  destination's `[data-emergency]` box; nothing shows while there are none.

### Settings (the officer's `admin_profile.html`)

Five subpages, one tab each, each with its own address so a link or a reload
opens it and Back returns to the one before: `#account` (the default),
`#security`, `#accounts`, `#office`, `#privacy` (`SUBPAGES` / `showSubpage` in
the page; tabs styled like Statistics').

- **My Account**: the officer's full name, position and contact number
  (`tourism_officers.full_name|position|contact_number`; `GET`/`PATCH
  /api/admin/me`), shown with initials, never a photo. The sign-in email is
  the account's identity and is not changed here. The name is stored as
  `localStorage.userName` at sign-in and shown in every officer page's account
  menu.
- **Security**: change password (`/api/admin/me/password`, needs the current
  one; other devices are signed out and this one gets a fresh token), when this
  session signed in (`last_sign_in_at`, set at each login), and "Sign out of
  all devices" (`POST /api/me/sign-out-everywhere`, this one too). The
  manager's Account has the same two.
- **Tourism Office Accounts**: every officer with position, date added, last
  sign-in and status. Add one (name required; a blank password is generated
  and shown once), issue a new password (`POST /api/admin/:id/password`), and
  deactivate or reactivate (`PATCH /api/admin/:id/status`) — all three ask for
  the officer's own password. Officers are never deleted; nobody deactivates
  themselves; a deactivated officer cannot sign in or reset a password, and an
  open session stops at once. Every active officer is emailed when an officer
  account is added.
- **Office Information** (`office.js`, `office_info` single row +
  `emergency_numbers`): address, phone, email, office hours and the emergency
  list. `GET /api/office` is public (cached 5 minutes), `PUT /api/office` is
  the officer's and replaces the emergency list in one transaction.
- **Data Privacy**: the Data Protection Officer's name and email
  (`office_info.dpo_name|dpo_email`, `PUT /api/office/privacy`, both or
  neither), published on the Privacy page through `GET /api/office`; the
  one-year erasure rule; and when it last ran (`office_info.privacy_checked_at`,
  written by `privacy.js`, officer-only via `GET /api/office/admin`). office_info
  has its own `updated_at` trigger (`ztims_touch_office_info`) so that daily run
  never changes Office Information's "last updated".

### Sign-in safety (October 2026)

- **Password rule** (`passwords.js`, every place a password is set — chosen,
  issued or reset; never checked at sign-in, so older passwords still work):
  10–72 characters, not a common password, not the site's/town's name or a
  similar word with digits, no repeated patterns or digit runs, not containing
  the account's email name. Generated passwords are 12 characters with no
  look-alike characters. The pages' minimum (10) is written on each password
  form and in `src/user/reset_password.html`.
- **Sessions end when they should.** Every token carries `sv`, the account's
  `session_version`. Changing a password, an officer issuing one, a reset link,
  and "Sign out of all devices" add one to it
  (`storePassword`, `endSessions`), so every token from before stops working at
  once. A token without `sv` (issued before this) counts as 0.
- **Issued passwords are replaced first.** `must_change_password` is set when
  someone else chose the password (officer creating or issuing one, the first
  officer from the environment). Sign-in returns `mustChangePassword`, the
  staff sign-in page asks for the person's own password (`POST /api/me/password`,
  allowed by `requireSignedInForPasswordChange`), and every other route answers
  401 `PASSWORD_CHANGE_REQUIRED` until then.
- **Sign-in says nothing without the password.** The password is checked first
  (against a stand-in hash for an unknown email), so "suspended" / "deactivated"
  / "inactive" is only told to someone who knows the password. Only failed
  sign-ins count toward the 10-per-15-minutes limit (the Municipal Hall shares
  one address); wrong current passwords on a password change are limited per
  account (`ownPasswordRateLimit`).
- **Risky actions ask for the officer's password again**
  (`requirePasswordConfirmation`, body field `confirmPassword`, 428 when
  missing, 403 when wrong, 10 wrong per 15 minutes per account): add an
  officer, deactivate/reactivate an officer, issue a password (officer,
  manager), refund (`POST /api/payments/:id/refund`) and remove
  demo data. The pages put a "Your password" field in those dialogs.
- **Emails to the account's owner** (`alertAccountOwner`, through `mailer.js`):
  their password was changed or reset, or a new one was issued; and every active
  officer when an officer account is added.
- **Photos only from our own hosting** (`PHOTO_SOURCES`, `checkPhotoSources`):
  listing photos must be on the municipality's Cloudinary account
  (or the office's earlier onecompiler folder); a photo already on the record
  is kept. Signed uploads also sign `allowed_formats` (jpg, jpeg, png, webp).
- **Idle sign-out**: officer pages sign out after 30 minutes without activity
  (`src/shared/idle-signout.js`, `ztimsLastActivity` in localStorage, shared by
  all officer tabs and cleared at each sign-in); the sign-in page says why
  (`?idle=1`).
- **Page security headers** (`vercel.json` `headers`, every path but `/api/`):
  Content-Security-Policy, no framing, nosniff, a referrer policy, a
  permissions policy (location for this site only, no camera) and HSTS. The
  CSP lists every outside host the pages use: a new CDN, image host, font or
  API called from a page must be added there, or the browser blocks it.

## Open notes

`docs/QUALITY-AND-TOOLS.md` (October 2026): how ZTIMS meets each ISO/IEC
25010:2023 characteristic, the gaps and the tools that would close them, and
which outside tools to switch (now: serve Leaflet and the fonts from the
site; before real use: email service, map tiles, routing servers, paid plans).
Nothing in it is built yet; read it before working on quality, tooling or a
framework change.

`docs/ideas/VISITOR-ORIGINS.md` (October 2026, held by the user): counting each
group's countries and male / female when it arrives (at Let them in) so
Statistics can suggest a month's visitor report. Its guide-report half no
longer applies (no guides). Not built; it needs the user's yes to change
"Nothing from tickets", and the
user noted weak signal at many places makes counting at the entrance hard
(see the note's "Weak signal").

## Duplicated facts (keep both sides in step by hand)

- **Zamboanguita bounding box**: `ZAMBOANGUITA_BOUNDS` in
  `Zamboanguita-project/src/shared/spot-form.js` and
  `ZAMBOANGUITA_SEARCH_BOX` in `zamboanguita-backend/server.js`. Deliberately
  a coarse envelope, wider than the municipality — used only to reject
  wildly-wrong pins and to bias search ranking, not as proof a pin is inside
  the municipality.
- **Barangay list**: `BARANGAYS` in `spot-form.js`, mirrored in the chips/count
  on `src/history.html`. The dropdown
  only accepts a name in this list, and reverse-geocoding is matched against
  it — a missing barangay makes auto-detection silently fail for listings in it.
- **Opening-days reader**: `zamboanguita-backend/open-days.js` (decides what is
  sold) and `Zamboanguita-project/src/shared/open-days.js` (the forms). Checked
  by `npm run check` in the frontend.
- **The tile pattern**: `TILES` in `src/shared/site-footer.js` (the footer
  strip and Home's cove ribbon) and `Zamboanguita-project/public/tiles.svg`
  (the portals' header), the same ten tiles. Change one, regenerate the other.
- **Photo hosts**: `PHOTO_SOURCES` in `server.js` and the CSP's `img-src` in
  `vercel.json`. A host only in the first is saved but never shown.
- **Password minimum (10)**: `MIN_PASSWORD_LENGTH` in
  `zamboanguita-backend/passwords.js`, and the password forms' `minlength` and
  messages (Settings, manager Settings, staff sign-in,
  `user/reset_password.html`, issue-password dialogs).

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
  live keys. (Saved at the user's request, October 2026, as a known limit to
  state in the manuscript.)
- No tour guide feature (October 2026, the user's decision): no Tourist Guide
  role or accounts, no guide portal, no guide bookings, no "requires a tourist
  guide" on a listing; the guide tables were deleted (see "No tour guides").
  Don't add any of it back unless the user asks.
- Tickets have no QR code: the ticket code is shown and typed. Where nobody
  stands at the entrance, the office marks tickets used from the day's list.
- Tickets have no senior citizen or PWD price (October 2026, the user's
  decision): regular, plus student and child where the office sets them.
- `docs/MANUSCRIPT-NOTES.md` lists what the manuscript must say after each
  system change; add to it in the same commit as a change the manuscript
  describes.
- Tourism records (spots/listings) are never hard-deleted, only marked
  inactive. Statistics reports likewise: voided, never deleted.
- Tourism statistics hold counts and totals only — no revenue and no
  percentages.
- Security decisions (October 2026): passwords follow `passwords.js` (length
  and guessability, no forced symbols, no expiry); a password someone else
  chose is always replaced at first sign-in; risky officer actions re-ask the
  officer's password; officer pages sign out after 30 idle minutes; left out by
  the user's decision: a per-account lockout after wrong sign-ins, cutting off
  a suspended manager's open session at once (it runs to
  its 2-hour expiry; officers are cut off at once), and an officer activity
  log; two-step sign-in is not built yet. Pages never load anything from a host the CSP doesn't list.
- The hero video on `index.html` intentionally has no dark scrim over it, and
  (October 2026, the user's decision) its words — "Mabuhay", "Welcome to
  ZAMBOANGUITA." and the line under it — are plain off-white `#FFFDFA` with no
  shadow, outline or gradient (`.ztims-hero h2, .ztims-hero p` in
  `theme.css`). They arrive in order (the user's choice): "Mabuhay"
  letter by letter, each dropping in (`.hero-drop__l`, 80 ms apart), then the
  welcome fades in (`.hero-fade`, from 0.75 s), then the line under it (1.3 s);
  the search is there from the start. `prefers-reduced-motion` shows all at once. Their legibility rests on the film being dark behind them. Its two buttons
  are pills filled flat like the header's ovals (`.btn-pill`): Explore
  destinations burnt orange, View the map tangerine with ink on it. The "How it works" steps are
  pills with no fill (a hairline outline), each number a tangerine circle.
