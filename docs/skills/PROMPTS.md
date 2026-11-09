# Prompts to type in Codex (or paste into any agent)

Replace the text in [brackets]. Each prompt makes the agent read the skill file first. Work in the repo root.

## draw.io diagrams
Read docs/skills/ztims-drawio-diagrams/SKILL.md and follow it exactly. Task: [redraw the Use Case Diagram for the current system / create the Top Level Diagram / fix the ERD]. Read CLAUDE.md and docs/MANUSCRIPT-NOTES.md first so the figure matches the system now. Start from the file in docs/diagrams/. Run check_drawio.py, export the PNG, and tell me what you checked and what you could not.

## RRL research
Read docs/skills/ztims-rrl-research/SKILL.md and follow it exactly. Task: [find and verify sources for <topic> / expand the theme <theme> / check the sources in my RRL]. Verify every source by two routes, never invent details, mark anything unverified, and give me paste-ready paragraphs in the manuscript's RRL structure plus the reference entries.

## Manuscript writing and alignment
Read docs/skills/ztims-manuscript-writing/SKILL.md and follow it exactly. Latest manuscript: [file or pasted text]. Task: [rewrite <section> / align Chapters I to V / check the golden thread]. Use plain, simple language. Give paste-ready text unless I ask for a file. List every other place that must change to stay consistent.

## Citation and reference check
Read docs/skills/ztims-citation-check/SKILL.md and follow it. Run cite_check.py on [manuscript text file]. Fix or list every finding and tell me which DOIs I must click-check.

## System to manuscript sync
Read docs/skills/ztims-system-manuscript-sync/SKILL.md and follow it. My manuscript is [file, revision, date]. List what it must change to match the system now, as a table with the exact new sentences, and mark what needs new screenshots or diagrams.

## Survey results
Read docs/skills/ztims-survey-results/SKILL.md and follow it. Data: [counts per rating or raw scores, group size N]. Compute with stats.py, check my table [paste], and write the interpretation paragraph. Do not rank TAM or ISO results.

## Docx revision
Read docs/skills/ztims-docx-revision/SKILL.md and follow it. Original: [path to .doc or .docx]. Make these changes only: [list]. Save as [next revision name], validate it against the original, render the changed pages, and report what you checked and what I must do in Word.
