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
