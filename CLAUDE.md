# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ZTIMS — the Zamboanguita Tourism Information Management System, a site for one
Philippine municipality. Two halves live in this repo:

- `Zamboanguita-project/` — the frontend (static pages, Vite build).
- `zamboanguita-backend/` — the API (Express + Mongoose).

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
(Singapore) because the Atlas cluster is in AWS `ap-southeast-1`; the default
(`iad1`, Washington) would put every database round trip across the Pacific.
The build uses `npm ci`, so a `package.json` change must come with its
`package-lock.json`, or the deploy fails at install.

The halves share no source files. Where the same fact must exist on both
sides (see "Duplicated facts" below), it is duplicated by hand, not imported.

The repo root's own `package.json` (`@supabase/supabase-js`, `express` 5, ...),
its committed `node_modules/`, and `Zamboanguita-project/index.js` (which
imports a `./supabase.js` that does not exist) are leftover from an earlier,
abandoned auth prototype — ignore them; the build never installs them. Real
auth is the JWT system in `zamboanguita-backend/server.js`, called from
`staff_login.html`.

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
npm run check    # node scripts/check-undefined.cjs && node scripts/check-countries.cjs
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

Run both before committing changes to any `src/**/*.html` page or to the
country lists.

Backend (`zamboanguita-backend/`):
```
npm run dev           # nodemon server.js
npm start              # node server.js
npm run migrate        # node migrate.js — the one-off data migrations and
                       # first-officer bootstrap (not run at startup)
npm run create-admin   # node create-admin.js
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
Tailwind from the CDN and its own inline `<script>` blocks. `src/App.jsx` /
`src/main.jsx` are the unused default Vite+React template — `index.html` has
no `#root` element, so nothing mounts them. Don't build new features as React
components; follow the existing page pattern.

Shared logic lives in `src/shared/` as plain global-scope IIFEs (not ES
modules), loaded via `<script src="...">` on the pages that need them, on
purpose — see the header comment in `spot-form.js`:
- `spot-form.js` (~2200 lines) — the one listing form used by the
  establishment portal, the officer's Destinations page, and the officer's
  Analytics quick-add. Owns barangay list, validation, the location picker
  and its Zamboanguita bounding-box sanity check.
- `tourism-map.js` — Leaflet + OpenStreetMap tiles + ZTIMS's own category
  markers. Never calls a routing provider directly; hands off to the backend's
  `/api/directions/route`.
- `theme.css` — the single source of the color palette (RGB-triple custom
  properties so Tailwind opacity modifiers like `/40` keep working), consumed
  by every page's own inline `tailwind.config`.
- `site-footer.js` — the visitor pages' footer (Explore / Information /
  Contact Us columns, office address, quiet staff sign-in link), drawn into a
  `<footer data-site-footer data-root="../">` placeholder so seven pages
  share one copy. The office's phone and email are deliberately absent until
  the office supplies them — see the comment in `src/contact.html`.
- `photo-upload.js`, `countries.js`, `nav-active.js`, `motion.css` — smaller
  per-concern shared pieces.

Each page sets its own `const API_BASE = "/api"` (`admin_analystic.html`
calls it `BASE_API_URL`; `admin_profile.html` writes `/api/...` into its
fetches) — same-origin, since Vercel serves the API beside the pages. There is
no shared config file for this, and none is needed: to use a local backend in
development, set `ZTIMS_API` for the dev server's proxy rather than editing
pages.

## Backend architecture

Essentially one file, `zamboanguita-backend/server.js` (~3000 lines), Express +
Mongoose against MongoDB, plus `rate-limit-store.js` and `migrate.js` beside
it. Structure, top to bottom:

1. Middleware: `helmet`, CORS (a page's own origin, the `CORS_ORIGIN` env
   allow-list, and any `*.vercel.app` origin for preview deploys — see
   `isSameOrigin` / `previewOriginPattern`), rate limits, JSON body parsing
   capped at 1MB (photos go straight browser → Cloudinary, never through this
   API). The limits that guard something (login, password reset, bookings,
   feedback, directions) go through `sharedRateLimit`, which counts in
   MongoDB (`rate-limit-store.js`) so they hold across serverless instances;
   only the blanket per-request limit stays in memory, on purpose.
2. Mongoose schemas/models: `Admin`, `EstablishmentManager`, `Spot`,
   `TouristGuide`, `GuideBooking`, `Payment`.
3. Auth middleware chains: `requireAuth` (valid JWT) →
   `requireAdmin`/`requireEstablishmentManager`/`requireStaff` (role checks)
   and `optionalAuth` (attaches `req.auth` if present, never blocks). Roles:
   `admin` (Tourism Officer) and `establishment_manager` (Tourist
   Establishment Manager) — `'resort_owner'` is a legacy spelling of the
   latter, kept only so tokens issued before a rename don't get rejected
   mid-session; nothing issues it anymore. There is deliberately no `tourist`
   role or tourist account at all — visitors browse without logging in.
4. Routes, grouped by resource: admin, establishment-managers, login/forgot/
   reset-password, spots (listings), guides, guide-bookings, payments,
   feedback (public `POST /api/feedback`, rate-limited with a honeypot;
   officer inbox `GET`/`PATCH …/status` read in `src/admin/admin_feedback.html`),
   and `/api/directions/*`.

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

A serverless host has no single startup, so nothing runs at boot: the
database connection is opened lazily and cached (`connectToDatabase`), and
the three migrations/bootstraps (`migrateEstablishmentNames`,
`migrateSpotManagement`, `bootstrapAdmin`) run only when someone runs
`npm run migrate` (see `runMigrations` and the header of `migrate.js`).
`bootstrapAdmin` reads `INITIAL_ADMIN_EMAIL`/`INITIAL_ADMIN_PASSWORD` to create
the first officer account if none exists yet, and `ADMIN_PASSWORD_RESET=true`
to force a reset on an existing one — both are meant to be deleted from the
environment once used.

## Duplicated facts (keep both sides in step by hand)

- **Zamboanguita bounding box**: `ZAMBOANGUITA_BOUNDS` in
  `Zamboanguita-project/src/shared/spot-form.js` and
  `ZAMBOANGUITA_SEARCH_BOX` in `zamboanguita-backend/server.js`. Deliberately
  a coarse envelope, wider than the municipality — used only to reject
  wildly-wrong pins and to bias search ranking, not as proof a pin is inside
  the municipality.
- **Barangay list**: `BARANGAYS` in `spot-form.js`, mirrored in the chips/count
  on `src/history.html`. The dropdown only accepts a name in this list, and
  reverse-geocoding is matched against it — a missing barangay makes
  auto-detection silently fail for listings in it.
- **Country list**: `src/shared/countries.js` (names) vs `COUNTRY_CODES` in
  `server.js` (codes only, validates what the form sends). Checked by
  `npm run check` in the frontend.

## Standing constraints

Decisions already made on purpose — don't reintroduce what they rule out:

- No API key (ORS, Cloudinary secret, etc.) ever reaches frontend source; all
  third-party calls needing a key are server-side.
- A visitor's GPS coordinate is used for a directions request and discarded,
  never stored. A manager's own position becomes a listing's coordinates only
  when they explicitly press Confirm in the location picker.
- Authorization is enforced backend-side only. Hiding a button client-side is
  never treated as a control.
- No `tourist` role, no tourist accounts, no online payment anywhere — guide
  payment is recorded at the counter by staff.
- Tourism records (spots/listings) are never hard-deleted, only marked
  inactive.
- The hero video on `index.html` intentionally has no dark scrim over it
  (readability is carried by per-letter text-shadow/stroke instead) — see the
  large comment block in that file before changing hero text treatment.
