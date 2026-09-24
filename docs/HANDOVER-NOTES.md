# Things ZTIMS still needs a human for

Everything in this file is something I could not do from the development
environment, or could not verify from it. Each entry says what is needed, why I
could not do it, and how you will know it worked.

Nothing here is a bug in the code. It is the list of things that live outside
the repository — credentials, live services, and facts about Zamboanguita that
only the municipality can confirm.

Last updated after the Coastal Tourism redesign. The three credential
tasks in section 1 were reported done on 18 September 2026 — section 1 now
records how to confirm each one actually took, because all three fail quietly.

---

## 1. Credentials — reported done, worth confirming

All three were set by the maintainer. Each one fails *silently* when it does not
take, which is the whole reason they are still written down: nothing on the site
says "the key never arrived". These are the checks that would catch it.

### 1.1 OpenRouteService key — rotated

The old key had been pasted into a chat twice and was rotated as a precaution.
It never appeared in the working tree or in git history, so there was nothing to
clean up in the repository.

**How the failure looks:** if `ORS_API_KEY` is missing or wrong on Render, the
backend does not error. It falls back to OSRM for routing and Nominatim for
search, both of which work — so directions keep working and nobody notices
except that address search gets worse.

**Confirm it:** on the live site, open a listing's Location step, choose *Search
for the place*, and search a local landmark — Malatapay market, Lutoban pier,
the municipal hall. With ORS in use the results are ranked toward Zamboanguita
because the backend sends `focus.point`. If local results are not coming first,
the key is not reaching the service.

### 1.2 Admin account — created

`INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` were set on Render and the
service redeployed.

**Confirm it:** the Render log prints one line naming the admin email at boot.
It never prints the password. Then sign in at `/src/staff_login.html`.

**One thing to check and then undo:** if `ADMIN_PASSWORD_RESET=true` was set to
reset an existing password, remove it and redeploy again. Left in place, the
password resets on every boot.

### 1.3 Cloudinary — signed uploads

`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` were
set on Render and the preset switched to signed.

**How the failure looks:** the frontend asks `/api/uploads/signature` first and
falls back to the unsigned preset if the server has no credentials. So if the
variables did not take but the preset was switched to signed anyway, uploads
fail — and if the preset were left unsigned, uploads would keep working while
the account stayed publicly writable. Neither state announces itself.

**Confirm both halves:**
1. Upload a photo to a listing, and upload one to a tourist guide. Both go
   through the same signed path now, so if either works, signing works.
2. Check the Cloudinary console shows the preset as **signed**. If uploads work
   *and* the preset is unsigned, the credentials did not take and the account is
   still open to anyone who reads the page source.

---

## 2. Facts about Zamboanguita I could not verify

The development sandbox blocks outbound access to every geographic source:
`nominatim.openstreetmap.org`, `openstreetmap.org`, `en.wikipedia.org` and
`philatlas.com` all return a proxy 403. So the values below came from a web
search rather than from the authority, and you should check them.

### 2.1 The municipal bounding box — **approximate, please replace**

`ZAMBOANGUITA_BOUNDS` in `Zamboanguita-project/src/shared/spot-form.js`, mirrored
as `ZAMBOANGUITA_SEARCH_BOX` in `zamboanguita-backend/server.js`:

```
lat 9.02 – 9.19,  lng 123.09 – 123.27
```

This is a **coarse envelope, deliberately wider than the municipality** (which is
85.86 km²; the box is roughly 340 km²). It overlaps Dauin to the north and Siaton
to the south and west.

It is used for two things and neither of them needs the real boundary:

1. Refusing a pin that is obviously somewhere else — a search result in Manila,
   a mistyped coordinate.
2. Ranking search results, so "wharf" finds the Zamboanguita one first.

A pin inside the box is **not** treated as proof it is in Zamboanguita. The
authoritative check is the reverse geocoder's municipality, which warns when it
disagrees. That is why a generous box is safe.

**To replace it with the real thing:** the municipality is OSM relation
**3740506**. Take its bounding box, or the LGU's own shapefile, and drop the four
numbers into both constants. Nothing else has to change. Keep the two files in
step — they deploy separately (Vercel and Render) so they cannot share a file.

### 2.2 The barangay list — a source disagrees with us

`BARANGAYS` in `spot-form.js` has **eleven** entries:

> Basak, Calango, Jumao-as, Lutoban, Malongcay Diot, Maluay, Mayabon, Nabago,
> Najandig, Nasig-id, Poblacion

Public sources I could reach say Zamboanguita has **ten** barangays. Jumao-as was
added on your instruction, and the other ten were originally worked out from the
municipality's school locations rather than an official register.

**Please check this against the municipality's own register.** If it changes:

- `BARANGAYS` in `Zamboanguita-project/src/shared/spot-form.js`
- the chips and the count tile ("eleven barangays") in
  `Zamboanguita-project/src/history.html`

must both move. The barangay dropdown only accepts a name already in that list,
and the reverse geocoder's answer is matched against it — so a missing barangay
means automatic detection silently fails for every listing in it.

### 2.3 The six office-kept destinations have no map pins

`STARTER_DESTINATIONS` in `src/admin/admin_dashboard_manage.html` — including
Zamora Agri Farm and St. Isidore the Farmer Church — carry no latitude or
longitude. Visitors cannot get directions to any of them.

With the redesigned Location step this is now a two-minute job each: open the
listing, press **Search for the place** or **Pick on the map**, put the pin on the
gate, press **Confirm location**, save. The officer's Destinations page flags
them with "No map pin" until you do.

### 2.4 One unresolved detail

St. Isidore the Farmer Church's habal-habal fare is recorded as `0`. I could not
tell whether that means *free* or *not available*. They display identically to a
visitor, and they mean opposite things.

---

## 3. What the tests prove, and what they cannot

The sandbox blocks `cdn.tailwindcss.com`, `unpkg.com`, `tile.openstreetmap.org`
and Google Fonts. That shapes what any test here can honestly claim.

**Proven by the test suite:**

- What ZTIMS *asks* Leaflet to draw — the centre, the zoom, the marker positions,
  when `invalidateSize()` is called. A recording stub stands in for Leaflet, and
  it records the calls exactly.
- Every decision the form makes: validation, the confirmation state, the barangay
  cross-check, what reaches the API.
- Layout at five widths from 360px to 1920px, with the icon font's metrics pinned
  to what the real font gives (otherwise every Material Symbol measures ~150px as
  literal text and fakes an overflow).

**Not proven, and needs a human on the live site:**

- **That OpenStreetMap tiles actually paint.** No test here has ever loaded a
  tile. Open a listing's Location step on the deployed site and confirm you see a
  map rather than a grey box.
- **That the geocoder returns useful results for Zamboanguita.** The search and
  reverse-geocode responses are stubbed in tests. Search for a few real local
  landmarks — Malatapay market, Lutoban pier, the municipal hall — and check that
  local results come first and that the barangay is detected correctly.
- **Real device geolocation.** Playwright supplies a fixed coordinate; it cannot
  test a real GPS fix, its accuracy, or how a specific phone's permission prompt
  behaves. Test "I am at the location" on an actual phone, standing somewhere in
  the municipality.
- **The `focus.point` and `viewbox` biasing.** Both go to external services that
  are unreachable from here, so I could confirm the parameters are sent but not
  what they do to the ranking.
- **That motorbike routes come back at all.** The Valhalla client is tested
  against stubbed responses in every shape the service returns, including both
  failure shapes — but no real request has ever left this sandbox. See 3.1.
- **That the routers actually return more than one route here.** ZTIMS asks each
  provider for alternatives and shows the quickest, but whether a given pair of
  points in Zamboanguita *has* a second sensible route is a question only the
  live service can answer. Where it returns one, the panel says so. Try a
  destination reachable both along the coast and inland — if the Recommended
  route panel never says "quickest of 2" or more anywhere, the alternatives are
  not coming back and it is worth checking the provider's response directly.

### 3.0 The hero film — check it plays, and watch the bandwidth

The landing page's hero is a looping clip from your own Cloudinary account:

```
cloud   xeo3pvpw
asset   Stuns  (v1789808713)
```

`index.html` builds three sources from it, cheapest first, ending with the
untouched URL you supplied — so if a Cloudinary transformation ever fails to
generate, the browser falls through to the original rather than showing
nothing. The still underneath is cut from frame zero of the same asset
(`so_0`), so the film and the still can never show different scenes.

**Nothing about playback could be tested here.** The sandbox cannot reach
Cloudinary and has no encoder, so no real clip was ever decoded. What is tested
is the part that decides: when the film is asked for, with what attributes, and
that the still carries every case where it is not.

**Confirm on the live site:**
1. On a desktop, the hero should be moving within a second or two.
2. On a phone, it should be a still — and the Network tab should show **no**
   video request at all. That is deliberate: see below.
3. Both should show the same scene. If the still is a different frame from where
   the film starts, `so_0` resolved oddly and you can replace the poster URL
   with any uploaded image.

**Who gets the film:** desktop and tablet only, and only when the browser has
not reported Save-Data or a 2G/3G connection, and only when the visitor has not
asked for reduced motion. Everyone else gets the still. This is a data decision,
not a visual one — a looping clip is megabytes re-fetched on every visit, and
most visitors to this site are on a phone paying for data by the gigabyte.

**Watch the Cloudinary quota.** Video bandwidth is counted against the free
tier much faster than images. If the site gets real traffic and the quota runs
low, the cheapest fix is to shorten the clip or lower `w_1600` in the two
transformation URLs in `index.html`; the last source is the original and is
unaffected.

**To change the clip:** upload a new one, then update the three source URLs and
the poster URL in `index.html`. They are together, in the `heroFilm` block at
the foot of the page and in the `.ztims-stage__media` markup.

### 3.0.1 The hero text is below AA on purpose

There is no shading between the film and the words on the landing page. It was
removed deliberately, on request, so the clip is seen at full strength. This is
the consequence, written down so it is not later read as an oversight:

**Over a bright frame, the hero title, the wordmark, the sentence under it and
the Browse heading are all below WCAG AA.** Measured against a deliberately
near-white stand-in — the worst frame any clip can show — every reading is
around 1.1:1, where AA wants 3:1 for the large headings and 4.5:1 for the
sentence.

What keeps them readable instead is a halo: several tight, dark text-shadow
layers that darken the few pixels immediately around each letter. That works
perceptually and is why the page still reads. It is not contrast in the sense a
checker means, because WCAG measures text against the colour *behind* it and a
shadow does not change that colour.

The wordmark is the fragile one. It is gradient-clipped text, so it cannot take
a text-shadow at all — a shadow shows *through* transparent letters rather than
behind them, and the usual workaround of a `drop-shadow` filter makes Chromium
stop painting the clipped gradient entirely. It carries a `-webkit-text-stroke`
instead, which is the one separation that survives both. If a future clip is
very bright it will be the first thing to become hard to read.

`cove_test.js` measures all of this at nine widths in both themes and **prints
every reading with a pass/fail against AA, without failing the suite** — the
line `contrast over the film: N/44 readings clear AA` is the number to watch.
If the decision is ever revisited, restoring a scrim is a few lines in
`.ztims-hero` / `.ztims-cove` in `src/shared/theme.css`, and the git history has
tuned values that did clear AA at every width.

### 3.1 Motorbike directions depend on a community server

Habal-habal is how most visitors actually travel, so *Motorbike* is one of the
four modes on a destination's Get Directions. It cannot come from
OpenRouteService: ORS has no motorcycle profile at all, and a car's estimate
relabelled would be worse than none. It comes from **Valhalla**, which has a
real `motorcycle` costing model.

`VALHALLA_URL` in `zamboanguita-backend/server.js` defaults to
`https://valhalla1.openstreetmap.de` — the **FOSSGIS community server**. That
means motorbike works with nothing configured on Render, which is why it is the
default, but it is a volunteer-run service under a fair-use policy and it is not
yours.

- **If it carries real traffic**, run your own Valhalla and set `VALHALLA_URL` to
  it. Nothing else has to change.
- **To turn motorbike off entirely**, set `VALHALLA_URL` to an empty string. The
  mode then disappears from `/api/directions/capabilities` and the chip stops
  being drawn — the page renders whatever the backend says it can calculate, so
  there is never a mode whose time would have to be invented.

**Confirm it on the live site:** open a destination with a pin, press Get
Directions, and choose Motorbike. A distance and a time should appear, and they
should differ from the car figures for the same route. The boot log names which
service is answering for which modes.

One thing motorbike loses: **Open in Maps** hands over to Google as *driving*.
Google's directions URL has no motorcycle travel mode — its two-wheeler mode
exists in the app in some countries but cannot be requested by link. ZTIMS's own
distance and time stay the motorbike ones; only the handover to another app
loses the distinction.

---

## 3.4 Moving the API from Render to Vercel — the cut-over

The code is done and needs nothing more. What is left is four dashboard
steps, and **the order matters**.

Why the order: `vercel.json` sits at the repo root, and its commands name
paths from there (`zamboanguita-backend/`, `Zamboanguita-project/`). Vercel
applies that file even while the Root Directory is still `Zamboanguita-project`
— but it runs the commands from inside that folder, where neither path exists,
and the build fails at install (`missing_lock_file`). This happened: the
branch's first preview failed exactly so. A failed build is never promoted, so
production is not broken by it, only not updated — but the Root Directory has
to be the repo root before anything built from this code can ship.

Something else that happened on the first real build: a `NODE_ENV=production`
copied over from Render made npm skip the frontend's build tools, and the build
stopped at `vite: not found`. The install now asks for them explicitly
(`--include=dev`), so that variable is harmless — leave it or delete it.

1. **Environment variables** — Vercel → project `ztims` → Settings →
   Environment Variables. Copy every variable from Render's Environment tab
   (the full list, with what each one does, is `zamboanguita-backend/.env.example`).
   Tick both *Production* and *Preview*. At minimum `MONGO_URI` and `JWT_SECRET`:
   without `JWT_SECRET` every `/api` call fails. Use **the same** `JWT_SECRET`
   as Render, so staff already signed in are not signed out by the move.
   `CORS_ORIGIN` is no longer needed — the site and API share one origin now.
2. **Root Directory** — Settings → Build and Deployment → Root Directory:
   clear it (the repo root). Framework Preset: *Other*. Leave the build,
   output and install overrides off; `vercel.json` sets all three.
3. **Try it on a preview first.** Build the branch fresh — push to it, or
   create a new deployment of it. Not *Redeploy* on a deploy built before
   step 2: a redeploy reuses that deploy's settings, old Root Directory
   included, and fails the same way again. On its preview URL check: `/api/directions/capabilities` returns JSON;
   the landing page shows the destinations; staff sign-in works.
4. **Merge to `main`.** Production deploys by itself. Check the same three
   things on `ztims.vercel.app`.

Already true, nothing to do: Atlas Network Access allows `0.0.0.0/0`, which
Vercel needs (its functions have no fixed IPs). `npm run migrate` is not needed
either — every migration has already run against the live database.

**If production breaks:** Deployments → the last good deployment → *Instant
Rollback*. It was built with the old setting and still points at Render, so it
works as it did — which is why Render should stay up for a week or so before
it is shut down.

Two behaviours that are new and on purpose:

- The first request after a quiet spell is slow (a cold start: loading the
  function and opening the database connection), but nothing sleeps for the
  30–60 seconds Render's free tier did.
- The function runs in `sin1` (Singapore), next to the database in
  `ap-southeast-1` — the Atlas cluster, and the Supabase project that replaces
  it, which is why §3.5 says to create that in Singapore too. If the database
  ever moves region, move `regions` in `vercel.json` with it.

---

## 3.5 Moving the database from MongoDB to Supabase — the switch-over

The code is done: the API reads and writes Postgres (`db/schema.sql`, `db.js`,
`models.js`), and `scripts/copy-from-mongo.js` brings the records across. It
was tested against a real Postgres holding a copy of the live data (personal
details masked): every API route, and every page in a browser, signed in as an
officer and as a manager.

It was a rewrite of the data layer rather than a driver swap, and the notes that
planned it still explain the choices: the API still does all authorization
(Express, not Row Level Security policies), ZTIMS keeps its own sign-in (not
Supabase Auth), and the tables were designed rather than transliterated.

**Order matters.** Once the site runs on Postgres, its records are newer than
MongoDB's, and the copy must never run over them again (the script refuses
unless told `--replace`, for exactly this reason). So:

1. **Create the Supabase project.** supabase.com → New project. Region:
   **Southeast Asia (Singapore)** — the API runs in Vercel's Singapore region,
   and every request makes several database round trips; anywhere else puts
   each of them overseas. Keep the database password somewhere safe.
2. **Get two connection strings.** Project → **Connect**:
   - *Transaction pooler* (port **6543**) — this one goes to Vercel.
   - *Session pooler* (port 5432) — for running the scripts below from a laptop.
   Replace `[YOUR-PASSWORD]` in each.
3. **Try the copy, writing nothing.** On a machine with Node and this repo:
   ```
   cd zamboanguita-backend && npm install
   MONGO_URI='<the Atlas URI>' npm run copy-from-mongo -- --dry-run
   ```
   Read the report. On 24 September 2026 the live data gave exactly this, and
   it is expected:
   - **2 payments NOT copied** (₱500 on 17 Sep, ₱500 on 21 Sep). Both point at
     bookings that no longer exist in MongoDB, and one names an officer id that
     does not exist either — the look of test records whose bookings were
     removed by hand. They are saved whole in `copy-skipped-<time>.json`
     (git-ignored; it has personal details). If they were real money, stop and
     decide what they belong to before going on.
   - **"Example Resort" repaired:** it points at establishment account
     `6aaa83ac…`, which does not exist — the account was evidently deleted and
     re-created (the live "Example Resort" account is `6aae22ec…`). It is copied
     as maintained by the Tourism Office, which is how the site already shows it.
     Re-assign it to the right account afterwards if it should be theirs.
   - **2 spots with no `status`** ("Sea Horizon Resort", "Example Resort") are
     copied as published, which is how Mongoose already read them.
   - `tourismOfficers` (1 document) is not copied: it is an older copy of the
     same officer as `admins`. `establishmentManagers` is empty.
4. **Copy for real** — a practice run, which you can repeat as often as you like:
   ```
   MONGO_URI='<the Atlas URI>' DATABASE_URL='<session pooler URI>' npm run copy-from-mongo
   ```
   It creates the tables itself (from `db/schema.sql`), copies in one
   transaction, and checks each table's count afterwards. Running it again
   needs `-- --replace`.
5. **Point a preview at it.** Vercel → Settings → Environment Variables → add
   `DATABASE_URL` = the *transaction pooler* URI, ticked for **Preview only** for
   now. Push the branch (or create a new deployment of it). On the preview URL:
   the destinations load, both an officer and a manager can sign in with their
   existing passwords, and saving a listing works. Everything written on the
   preview goes into Supabase — it is a practice copy, which step 6 replaces.
6. **Switch.** Pick a quiet moment; the gap between this step's copy and the
   deploy finishing is the only window in which something written to the live
   site could be missed.
   1. Run the copy again with `-- --replace`, so Supabase has the latest records.
   2. Add `DATABASE_URL` for **Production** as well.
   3. Merge to `main`. When the production deploy is ready, check the same
      three things on `ztims.vercel.app`.
7. **Afterwards.** Remove `MONGO_URI` from Vercel (nothing reads it now). Keep
   the Atlas cluster for a few weeks as a record of the old data, then pause
   or delete it.

**If production breaks:** Deployments → the last good deployment → *Instant
Rollback*. It still runs on MongoDB, so it works as before — but anything
written on Supabase in the meantime would not be in MongoDB. Roll back only for
something serious, and plan to copy forward by hand what was written in between.

**Two catches worth knowing:**

- A free Supabase project **pauses after a week with no activity**. A paused
  project refuses connections until someone presses *Restore* in the
  dashboard. For a defence, open the site the day before; check the current
  terms for how long pausing takes.
- The API connects encrypted but, by default, does not *verify* Supabase's
  certificate (Supabase signs it with its own authority, not a public one). To
  verify it too: Supabase → Database settings → SSL configuration → download the
  certificate, and put its contents in a `DATABASE_CA_CERT` variable. The
  startup log line `🗄️ Database: … (certificate verified)` confirms it took.

**What changed underneath, briefly, for whoever maintains this next:**

- `admins` → `tourism_officers`, `resortOwners` → `establishment_managers`:
  the new names say what the records are. The sign-in role is still `admin` in
  tokens, so sessions survive; `server.js` imports the officer table as
  `TourismOfficer`.
- A guide's `assignedSpots` array became its own table, `tourist_guide_spots`,
  so every entry is a destination that exists. The API still shows it as an
  array on the guide.
- References are now enforced. Deleting a listing that has guide bookings is
  refused (409) — MongoDB allowed it and left the bookings pointing at nothing.
  Archive such a listing instead; that was always the intended way.
- Recording a payment and confirming its booking now happen in one
  transaction, and a second payment for the same booking is refused by the
  database itself, not only by the route.
- `ratelimits` became the `rate_limits` table. Not data; rows expire within an
  hour and are swept as the API runs.

## 4. Standing constraints, so nobody undoes them later

These are decisions already made. They are written down because each one is the
kind of thing that gets quietly reversed by a later change.

- **No API key ever reaches frontend source.** ORS is called server-side only.
- **The visitor's GPS position is never stored.** Permission is requested only
  when directions are asked for, and the coordinate is used and discarded. In the
  Location step, a manager's own position becomes the *listing's* coordinates only
  if they press Confirm — ZTIMS keeps no separate record of where anyone stood.
- **Authorisation is enforced at the backend.** Hiding a button is not a control.
  Manipulating an ID in a URL must not get past the server.
- **No `tourist` role in the users table**, no Tourist Guide accounts, and no
  online payment anywhere. Guide payment is recorded at the counter.
- **Tourism records are never hard-deleted** because an establishment stops
  operating. They are marked inactive.
