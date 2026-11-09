---
name: ztims-drawio-diagrams
description: Draw or fix the ZTIMS manuscript diagrams and figures (context flow diagram, top-level DFD, ERD, use case diagram, system architecture, theoretical and conceptual frameworks) as clean, accurate draw.io files and PNG exports. Use when asked to create, redraw, update or check any figure of the capstone manuscript.
---

# ZTIMS draw.io diagrams

Goal: every figure is accurate to the system, readable when printed in black and white on a Letter page, and consistent with the others in `docs/diagrams/`.

## Before drawing
1. Read what the system really does. Sources, in this order: `CLAUDE.md`, `docs/MANUSCRIPT-NOTES.md` (newest first), `docs/diagrams/ztims-schema.dbml` and `zamboanguita-backend/db/schema.sql` for tables. Never draw from memory.
2. Open the existing source file in `docs/diagrams/*.drawio` and change it. Start a new file only when there is none. Keep the file name (`ztims-<figure>.drawio` and `.png`).
3. List the changes as facts first (entities, processes, actors, flows), then draw. Ask the user if a fact is unclear. Do not invent a flow, table or actor.

## Current system facts to respect (check `MANUSCRIPT-NOTES.md` for newer ones)
- Users: Visitor (no account), Tourism Officer, Enterprise Manager. Never "establishment" in a label. There is no Tourist Guide (taken out October 2026).
- External services: Map and Directions Providers, Xendit Payment Gateway (test mode), Email Service, Cloudinary.
- Stack for the architecture figure: browser, Vercel (static pages and `/api/*`), Express on Node.js, PostgreSQL on Supabase (Singapore). Layer names must match the manuscript text.
- A figure that shows the evaluated version must say so in its caption note, not silently differ from the text.

## Style rules (match the existing files)
- Black and white. Fill `#ffffff`, stroke `#000000`, stroke width 1.5 to 2. No colour, shadow or gradient. Colour is allowed only when it is the only way to tell two things apart, and then a pattern or label must also tell them apart.
- One font for the whole figure (Times New Roman, or the draw.io default if the existing file uses it). Sizes: title 16 to 24, shapes 12 to 14, edge labels 11 to 12. Nothing under 10 pt after scaling to page width.
- `html=1;whiteSpace=wrap;` on every label. Use `&lt;br&gt;` for line breaks.
- Align to a 10 px grid. Equal spacing between siblings. No overlapping shapes, no label on top of a line, no line through a shape.
- Edges: orthogonal (`edgeStyle=orthogonalEdgeStyle`), every edge connected to a source and a target (never loose), an arrowhead, and a short verb label where meaning is not obvious. Avoid crossings; reroute or move shapes first.
- Names: Title Case for entities and processes, the same words as the manuscript text and the other figures.
- Set the page size to the diagram bounds so the PNG has little white margin. Portrait for tall figures.

## Notation by figure type
- **Context flow diagram (Level 0 context):** one central process (ZTIMS), external entities as squares, labelled flows both ways. No data stores.
- **Top-level DFD (Level 1):** numbered processes (1.0, 2.0 ...), data stores D1, D2 ... with open-sided rectangles, external entities outside a dashed system boundary. Every process has at least one input and one output. Flows to a data store carry data names.
- **ERD:** the repository's ERD is in Chen notation (rectangles for entities, diamonds for relationships with 1 / N, ovals for key attributes). Keep that notation across the file. Entity names are the table names in Title Case. Check every relationship against the foreign keys in `schema.sql`.
- **Use case diagram:** actors outside the system box, use cases as ovals inside, one line per actor-use case pair, `<<include>>` and `<<extend>>` only when true. Group by actor top to bottom.
- **System architecture:** stacked layers (Client, Application, Data, External Services) as dashed rounded boxes, components inside, arrows only between layers that really talk. Arrows leave from the layer that makes the call.
- **Framework figures:** boxes and arrows only, wording identical to the Theoretical and Conceptual Framework text.

## Check, export, verify
1. Run `python3 docs/skills/ztims-drawio-diagrams/check_drawio.py <file.drawio>`. It reports duplicate ids, edges with no source or target, shapes outside the page, overlapping shapes and mixed fonts. Fix every finding.
2. Export PNG at 2x scale with a white background. If the draw.io CLI is installed: `drawio -x -f png -s 2 -b 10 -o out.png file.drawio` (use `-a` to export all pages). If it is not, say so and tell the user to use File > Export as > PNG in draw.io; do not draw the PNG by another tool unless asked.
3. Look at the PNG. Read every label. Compare against the facts list. Say what was checked and what could not be.
4. Caption goes in the manuscript, one line: `Figure N. Title`. The paragraph under the figure describes it in the order a reader follows the arrows.

## Do not
- Add features the system does not have, or keep ones taken out (tour guides, QR codes, senior or PWD prices).
- Mix notations in one figure.
- Overwrite a figure that the manuscript uses without keeping the old one in git history.
