---
name: ztims-citation-check
description: Check that every in-text citation in the ZTIMS manuscript has a matching reference entry, every reference is cited, and entries follow APA 7 shape. Use after editing the RRL, framework or any chapter, and before submitting a revision.
---

# ZTIMS citation and reference check

## Run the script
Get the manuscript as plain text (for a `.docx`: `pandoc file.docx -t plain --wrap=none -o ms.txt`; for a `.doc`: first convert with `soffice --headless --convert-to docx file.doc`). Then:

```
python3 docs/skills/ztims-citation-check/cite_check.py ms.txt
```

It finds the REFERENCES section, reads the author and year of each entry, finds author-year citations in the text before it, and prints:
- **Cited but not in the references** (must be fixed).
- **In the references but never cited** (remove, or cite it where it belongs).
- **Entries that look wrong**: no year, no DOI or URL, not in alphabetical order, duplicate first author and year without a letter (2020a, 2020b).

The script is a helper, not a judge. It can miss citations written in unusual forms and can flag laws or organisations as author names. Read each finding before acting.

## Then check by hand
1. Every DOI or URL: present, and opened or marked for the user to click-check. Never add a DOI that was not seen on a page.
2. Author names and spelling in the text equal those in the entry. "et al." for three or more authors in the text (APA 7); entries list up to 20 authors.
3. Year in text equals year in the entry.
4. Direct figures (percentages, means) next to a citation are in the source.
5. Statements cited to a study say what the study says. When unsure, read the abstract again.
6. Alphabetical order, hanging indent, italics for journal name and volume.
7. Cited only in the framework or RRL is fine; cited nowhere is not.

## Report
List what was fixed, what remains, and what the user must verify. Do not claim a source is verified if it was not opened.
