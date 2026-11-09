---
name: ztims-rrl-research
description: Find, verify and write reliable, credible Review of Related Literature and Studies for the ZTIMS capstone. Use when asked to add, expand, improve or check RRL, find sources, or verify a citation. Never invents a source; flags anything it could not confirm.
---

# ZTIMS RRL research

Goal: every source is real, current enough, relevant to ZTIMS, and written in the manuscript's themed RRL structure.

## Hard rules
1. **Never invent or guess** an author, year, title, journal, volume, pages, DOI or finding. If a detail was not seen in a source, leave it out or mark it `UNVERIFIED`.
2. **Two-route check for every source.** Find it in a research search (Consensus, Google Scholar, Semantic Scholar, OpenAlex, publisher or repository page), then confirm title, authors, year, venue and volume or pages through a second, independent page. Search metadata can be wrong (year, type, venue). A DOI shown only in one place is not verified. Publisher and DOI sites are often unreachable from a sandbox: say so and ask the user to click-check the DOI.
3. **Read what you cite.** Use the abstract at least; say in the report when only the abstract was seen. State a finding only if the source says it.
4. **Label the type.** Peer-reviewed article, conference paper, book chapter, thesis, report, law, preprint. Preprints (for example bioRxiv) are labelled as not peer reviewed. Prefer peer-reviewed sources.
5. **Currency and place.** Prefer the last 5 to 10 years for systems and technology; older sources only for theories, standards and landmark studies. Include both foreign and Philippine (local) studies. Add a Negros Oriental or Visayas source when one exists.
6. **Relevance.** A source must relate to something ZTIMS does or claims: tourism information systems, destination management, e-ticketing and booking, tourism statistics and visitor records, local government systems, access control and data privacy, TAM, ISO/IEC 25010, Agile development. If it only shares a keyword, drop it.
7. **No removed features.** ZTIMS has no tour guide feature. Do not add literature that supports one.

## Workflow
1. Read the manuscript's Statement of the Problem, objectives, scope and the current RRL (ask for the latest file if none is attached). List what each ZTIMS function needs literature for.
2. Search each topic with plain-language queries. Keep a table: topic, source, type, year, how found, how verified, verdict.
3. Verify (rule 2). Drop anything that fails or mark it `UNVERIFIED` and tell the user.
4. Write into the themed structure (below). Do not rewrite the user's existing paragraphs unless asked; add new ones around them.
5. Run the `ztims-citation-check` skill: every in-text citation has a reference, every reference is cited.
6. Report: what was added, what was dropped and why, what the user must click-check (DOIs, links).

## Structure the manuscript uses
- RRL lead-in sentence.
- **Related Literature**, with themed subheadings (for example tourism and information technology; access control and data privacy; tourism statistics; software quality and user acceptance).
- **Related Studies**, with themed subheadings (web-based tourism information systems; booking, e-ticketing and online payment; visitor monitoring and tourism statistics; stakeholders and community participation; development and evaluation methods). One short lead-in sentence under each.
- **Synthesis**, then **The Research Gap**.

## Paragraph pattern for one study (3 to 5 sentences, plain language)
1. What the study did, where, with whom or what, and the method or sample.
2. What it found, with numbers only if the source reports them. Citation in APA 7 author-date form.
3. How it supports or compares to ZTIMS ("This supports ...", "ZTIMS similarly ...").
4. How it differs or what it does not cover ("However ... ").
Close each theme by relating the studies to the present system.

## Research Gap
State it as two explicit gaps (First ... Second ...) that follow from the reviewed studies and tie to the Statement of the Problem. Point to Chapter III for the pre-development results; do not repeat the survey numbers in Chapter I. Use "addresses", never "solves"; call ZTIMS an "alternative", not a "replacement".

## Style
Plain, simple, active language. Short sentences. No dashes in place of a period in headings. Past tense for what a study did, present tense for what it shows. No quotation unless needed; paraphrase and cite.

## Reference entries
APA 7: `Author, A. A., & Author, B. B. (Year). Title in sentence case. *Journal Name, vol*(issue), pages. https://doi.org/...`. Alphabetical by first author, hanging indent. Only add a DOI that was seen on a page. Give the exact URL for items without a DOI and say the link should be checked.
