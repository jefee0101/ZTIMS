---
name: ztims-manuscript-writing
description: Write and align the ZTIMS capstone manuscript in the school's format and the user's plain-language style, keeping the golden thread (problems, objectives, methods, results, conclusions, recommendations) consistent across all chapters. Use when drafting, rewriting, aligning or checking any chapter, caption, table, summary or abstract.
---

# ZTIMS manuscript writing and alignment

## Voice
- Plain, simple language. Short sentences. Active voice. Define a term once, then use it the same way everywhere.
- Past tense for what was done and found, present tense for what the system does.
- Say "addresses", never "solves". The system is an "alternative" to the manual process, never a "replacement". Findings say what the data show, no more.
- Roles are capitalized: Tourism Officers, Enterprise Managers. A place a manager runs is an **enterprise**, never an "establishment". Visitors pay **onsite**. Do not call the online payment "live"; it is a demonstration in Xendit's test mode.
- Headings in the Significance section end with a period, not a dash. The Executive Summary has no bullets.
- Do not edit the survey instruments, collected data or computed results unless the user asks.

## Structure and order (follow the existing file)
Title page, Approval Sheet, Acknowledgement, Executive Summary, Abstract, contents lists, Chapter I (background, objectives, Significance, Scope and Limitation, Operational Definition of Terms, Theoretical and Conceptual Framework, Review of Related Literature and Studies), Chapter II (methodology), Chapter III (results), Chapter IV (technical aspects), Chapter V (summary, conclusions, recommendations), References, Appendices.

## Captions and tables (the file's format)
- One-line captions: `Table 1. Title` above each table and `Figure 1. Title` below each figure, as the file already does. Keep every caption in the same form.
- Tables and figures are numbered in order of appearance. Each is cited in the text before it appears, and is described in the paragraph that follows.
- A table note starts with `Note.` and defines abbreviations (N, WM, SD) and the interpretation scale.
- After adding or removing any table or figure: renumber, fix every in-text mention, and update the lists of tables and figures. (In the current file the contents and lists are typed text, not fields; page numbers must be updated by hand.)

## The golden thread (check before finishing any edit)
1. **Statement of the Problem** (5 problems) is answered by **objectives** (same order), **methods** (design, respondents, instruments, analysis), **Chapter III** results (one section per problem), **Summary of Findings** (one finding per problem, same order), **Conclusions**, **Recommendations**.
2. Problems 1 to 3 (current process, challenges, requirements) come from the pre-development survey. Problems 4 and 5 are TAM (end users) and ISO/IEC 25010:2023 (IT experts).
3. Each conclusion rests on a finding; each recommendation rests on a conclusion. A claim that appears in a summary or abstract must exist in a chapter.
4. Numbers match everywhere: N, counts, percentages, means, SDs, weighted means, interpretations. Search the whole file for each number you change.
5. Statistics reported as counts and totals only. No revenue, no percentages inside the system's statistics.
6. The Research Gap in the RRL points to Chapter III and ties to Problems 1 to 5.
7. Executive Summary and Abstract describe the same study, same numbers, same version of the system as the chapters.
8. Terms, role names and feature names match the Operational Definition of Terms.

## Describing the system
Describe the system as it is now, from `CLAUDE.md` and `docs/MANUSCRIPT-NOTES.md`. If the evaluated version differed from the current one, say so once, in Chapter II, and note that later refinements were not covered by the TAM and ISO results. Use the `ztims-system-manuscript-sync` skill to list what changed.

## Working method
1. Read the current text first (ask for the latest file if none is attached). Say which file and revision you are working from.
2. Change only what was asked, plus what must change to keep the thread consistent. List the extra changes.
3. Give paste-ready text unless the user asks for a file. When a file is needed, use `ztims-docx-revision`.
4. Finish by running the checks: numbers, terms, captions, `ztims-citation-check`.
