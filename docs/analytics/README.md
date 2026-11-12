# Analytics for accommodation and attraction statistics

Stage 1 (proposal, 12 November 2026): data inspection, planning and a reviewable prototype. Stage 2 (12 November 2026, on main since 12 November 2026): the server-side calculations and read-only API, see `05-implementation.md`. Stage 3 (12 November 2026, on main since 12 November 2026): the officer's and the manager's Analytics pages, see `06-interface.md`. Nothing deployed.

| File | What it is |
|---|---|
| `01-data-inspection.md` | What ZTIMS collects, what live holds (read-only check), existing statistics, roles, rules, design system |
| `02-analytics-inventory.md` | 34 analytics, each with source, calculation, user value, best visualization and limitations (generated from `inventory.json`) |
| `03-role-dashboards-and-data-flow.md` | Officer, Enterprise Manager and Support Staff dashboards, the data flow, who sees what, order of work |
| `04-prioritized-gaps.md` | 18 data gaps (P0 to P2) and the decisions needed (generated from `gaps.json`) |
| `05-implementation.md` | What was built: data flow, calculation rules, access, files, verification, security findings, limitations |
| `06-interface.md` | The pages: what each shows, how the rules show, tests, limitations |
| `tests/api-checks.js` | 129 checks against a local API and database |
| `tests/page-flow.js` | 62 browser checks of both pages against the API |
| `mockup.html` | The interactive responsive prototype (also published as an Artifact). Open it in a browser |
| `mockup.template.html`, `inventory.json`, `gaps.json`, `build.py` | Sources. `python3 build.py` rebuilds `mockup.html`, `02` and `04` so the mockup and the documents never differ |

In the mockup, **Verified data** is the read-only copy of the live 2025 municipal totals and live place counts; everything else is **sample data** made up for review. Accommodation and attraction are never added together, and no "unique tourists" figure is proposed.
