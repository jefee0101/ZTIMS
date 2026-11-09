---
name: ztims-system-manuscript-sync
description: List exactly what the ZTIMS manuscript must change after the system changed, by reading CLAUDE.md, docs/MANUSCRIPT-NOTES.md and the git log. Use when the user asks what changed in the system, what the manuscript needs, or before preparing a new manuscript revision.
---

# System to manuscript sync

The code is the truth about the system; the manuscript must describe it (or say clearly which version it describes).

## Steps
1. **Find the manuscript's version.** Ask which file and revision, and its date. Note the version that was evaluated (TAM and ISO) and the date of the evaluation, if the file says.
2. **Read the sources, newest first:**
   - `docs/MANUSCRIPT-NOTES.md` (what each system change means for the manuscript, with wording).
   - `CLAUDE.md` (current features, roles, rules, limits, decisions under "Standing constraints").
   - `git log --since=<manuscript date> --format='%h %ad %s' --date=short origin/main` and the diffs of `docs/` and `db/schema.sql` when a note is missing.
3. **Map each change to manuscript places.** Use this checklist: Executive Summary and Abstract; Background; Statement of the Problem and objectives (feature list); Significance (each beneficiary); Scope and Limitation (roles, modules, limits); Operational Definition of Terms; Chapter II (development narrative, post-evaluation refinements, respondents); Chapter III (only via a link, never changed data); Chapter IV (Figures: context, top-level DFD, ERD, use case, architecture, every user-interface screenshot and its paragraph; Tables of software, hardware and network requirements; data dictionary); Chapter V (findings 3, conclusions, recommendations); keywords; lists of tables and figures.
4. **Separate three kinds of change** and say which each is:
   - Wording only (role or term names).
   - Description of the system (new or removed feature).
   - Evidence the user must produce (new screenshots, redrawn diagrams, a new evaluation). You cannot produce screenshots from here unless the app is run; say what is needed.
5. **Output** a table: place in the manuscript | current text (first words) | required change | source (note or commit) | kind. Then the exact new sentences for the descriptive changes.

## Rules
- Never put secrets, passwords, keys or visitors' data in anything you write.
- The evaluated version's results (TAM, ISO) are not rewritten. A change after the evaluation is stated once in Chapter II as a refinement not covered by the results, and the Limitations say so.
- Respect the standing decisions: no tour guides, no QR codes, no senior or PWD price, online payment only as a test-mode demonstration, "enterprise" not "establishment", statistics as counts and totals only, no offline features.
- If `MANUSCRIPT-NOTES.md` and the code disagree, trust the code and say so.
- When your work changes a decision, rule or open item, the repository's session routine applies (update `CLAUDE.md`, and the notes repo when it is attached).
