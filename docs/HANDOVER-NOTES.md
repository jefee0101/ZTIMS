# Things ZTIMS still needs a human for

Everything in this file is something I could not do from the development
environment, or could not verify from it. Each entry says what is needed, why I
could not do it, and how you will know it worked.

Nothing here is a bug in the code. It is the list of things that live outside
the repository — credentials, live services, and facts about Zamboanguita that
only the municipality can confirm.

Last updated with the Location step redesign.

---

## 1. Blocking — the system is degraded until these are done

### 1.1 Rotate the OpenRouteService key

The key was pasted into this chat twice. Anything pasted into a chat should be
treated as disclosed.

- Sign in at <https://openrouteservice.org/dev/#/home>, revoke the existing key,
  create a new one.
- Put the new value in `ORS_API_KEY` on Render. Never in any file under
  `Zamboanguita-project/`.
- **How you will know:** directions and address search keep working after the old
  key is revoked. If they fall back silently, the key never reached Render —
  the backend drops to OSRM and Nominatim without complaining, which looks fine
  until you notice search results got worse.

I verified the key appears **zero** times in the working tree and **zero** times
in git history, so rotating it is a precaution, not a cleanup.

### 1.2 Regain admin access

`INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` are read at boot by
`bootstrapAdmin()` in `zamboanguita-backend/server.js`.

- Set both on Render. The password must be at least 10 characters.
- Redeploy. The account is created only if no admin exists.
- To reset an existing admin's password, also set `ADMIN_PASSWORD_RESET=true`,
  redeploy once, then **remove that variable and redeploy again**. Leaving it set
  means the password resets on every boot.
- **How you will know:** the Render log prints a line naming the admin email. It
  never prints the password.

### 1.3 Cloudinary: switch to signed uploads

The backend signs uploads at `GET /api/uploads/signature` (staff only). The
frontend uses it when it can and falls back to an unsigned preset otherwise.

- Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` on
  Render.
- In the Cloudinary console, change the upload preset from **unsigned** to
  **signed**.
- **How you will know:** photo upload still works from all three editors. If the
  preset is switched to signed *before* the environment variables are set,
  uploads will fail — do them in that order.

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

---

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
