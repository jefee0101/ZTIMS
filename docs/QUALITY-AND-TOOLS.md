# ZTIMS — quality (ISO/IEC 25010:2023) and tools: notes

Notes kept on 10 October 2026, for the manuscript and for later work. Nothing
here is built yet unless it says so.

## 1. Where ZTIMS stands on each ISO/IEC 25010:2023 characteristic

| Characteristic | Already in ZTIMS | Gap | Tool / feature that would close it |
|---|---|---|---|
| 5.1 Functional Suitability | Every module built; rules enforced by the server (statistics, payments, guide scope) | No automated tests committed to the repo | Playwright (pages) + Node's test runner (API), committed; a requirements traceability matrix |
| 5.2 Performance Efficiency | Tailwind compiled at build, `sin1` region, Cloudinary `q_auto`, no blur on scrolling cards | Never measured | Lighthouse / PageSpeed Insights on slow 3G, Vercel Speed Insights, k6 load test, Supabase performance advisor |
| 5.3 Compatibility | Works alongside Xendit, Cloudinary, OpenRouteService, Gmail; same-origin API | Tested in Chromium only | Playwright on Chromium, Firefox and WebKit (Safari); one low-end Android phone |
| 5.4 Interaction Capability | Design system (≥ 4.5:1 contrast), reduced motion, clear errors, password re-check before risky actions | English only; usability not measured | axe DevTools / WAVE, SUS questionnaire with real users, a Filipino/Cebuano language option |
| 5.5 Reliability | Provider fallbacks, email never blocks a change, server-confirmed payments, Vercel rollback | No outage alerts; backups never test-restored | UptimeRobot, Sentry, a restore drill of a Supabase backup |
| 5.6 Security | October 2026 sign-in safety (see CLAUDE.md), RLS on every table, page security headers | Accountability / non-repudiation weak without an officer activity log (left out by decision) | OWASP ZAP baseline scan, securityheaders.com / Mozilla Observatory, Dependabot, GitHub secret scanning; reconsider the activity log |
| 5.7 Maintainability | Shared modules, one design system, CLAUDE.md, `npm run check` | No CI; inline page scripts not linted | GitHub Actions (check + build + tests on every push), ESLint for inline scripts, Prettier |
| 5.8 Flexibility | Docker, environment-driven settings, swappable map providers, payment gateway replaced once (PayMongo → Xendit), serverless scaling | Scaling never shown | k6 results as scalability evidence; a one-page install guide |
| 5.9 Safety | Emergency numbers on destinations, date closures (typhoons), group-size limits, fail-safe payments | No hazard information per destination | A safety advisory per destination ("slippery trail after rain", "strong currents"); links to MDRRMO / PAGASA advisories |

Priority for the defense: (1) tests + GitHub Actions, (2) Lighthouse, axe and
securityheaders scores, (3) UptimeRobot + Sentry, (4) safety advisories per
destination, (5) officer activity log, (6) Filipino/Cebuano.

For the manuscript: an ISO 25010 Likert questionnaire answered by officers,
managers, guides and visitors, each characteristic backed by the tool results
above.

## 2. Tools to switch

Keep: Vercel, Supabase (Postgres), Express, Vite, Tailwind, Leaflet, Cloudinary,
Xendit (test mode), bcrypt + JWT, helmet, the rate limits.

| Now | Switch to | Why | When |
|---|---|---|---|
| Leaflet from unpkg, jsQR from jsDelivr | Installed from npm and served from the site | Reliability (no outside CDN outage); Security (no outside code; narrower CSP) | Before the defense |
| Google Fonts + Material Symbols from Google | Self-hosted font files | Privacy (no visitor IPs sent to Google; Data Privacy Act); Performance on weak signal | Before the defense |
| Gmail App Password (nodemailer) | Brevo (300/day free) or Resend (3,000/month free), from the municipality's domain | Reliability (Gmail sending limits, spam folder); Security (no personal mailbox password) | Before real use |
| OpenStreetMap's own tiles | MapTiler or Stadia Maps (free tiers) | Reliability (OSM's tile usage policy forbids heavy app use) | Before real use |
| Public demo routing (OSRM demo, FOSSGIS Valhalla) | OpenRouteService wherever it can; own or paid Valhalla for motorbike | Reliability (no uptime promise) | Before real use |
| Vercel Hobby, Supabase Free | Vercel Pro and Supabase Pro, or LGU-arranged hosting | Reliability (Supabase Free pauses when idle, short backups; Hobby is for personal projects) | Before real use |

The "before real use" rows belong under Recommendations in the manuscript.

If the frontend later moves to React (decided: not before the defense): React,
TypeScript, React Router, react-leaflet, Vitest; Vite, Tailwind, Playwright and
the whole backend stay. Move the officer portal first, visitor pages last.
