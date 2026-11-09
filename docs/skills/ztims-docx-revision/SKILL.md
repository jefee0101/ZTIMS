---
name: ztims-docx-revision
description: Edit the ZTIMS manuscript Word file safely: convert .doc to .docx, change text and tables without losing formatting, swap figures, insert paragraphs and references, name the new revision, validate and render the result. Use when the user wants an actual revised .docx rather than paste-ready text.
---

# ZTIMS docx revision

## Rules
1. **Never edit the user's original.** Work on a copy. Name each output with the next revision number (`FINALIZATION_ZTIMS_rev10.docx` after rev9), keep the old files. The user's rule: rename the file for every revision.
2. **Only the changes asked for** (and the ones needed to keep the thread consistent, listed in the report). Do not touch survey instruments, collected data, tables of results or the appendices unless asked.
3. **Keep formatting.** Text goes into existing runs; new paragraphs are copies of a nearby paragraph of the same kind (heading, body, reference, caption). Never type formatting by hand when a template paragraph exists.
4. Do not create a file when the user says "don't create a file". Give paste-ready text.

## Method (tested on the real manuscript)
1. `.doc` first: `soffice --headless --convert-to docx file.doc` (works for the 17 MB manuscript; takes about a minute). Expect LibreOffice to rewrite styles; the converted file has two known schema warnings that exist before any edit.
2. Load with `python-docx`; list body children (`body.iterchildren()`) with their index and first words, and **capture the elements you will change before inserting or deleting anything**, so indexes do not shift.
3. Use `docx_tools.py` (this folder):
   - `replace_text(paragraph, old, new)`: replaces across runs and keeps the run formatting.
   - `set_text(paragraph, new, keep_lead=True)`: rewrites a paragraph and keeps a bold lead-in ("Input.", "Stakeholder Participation.").
   - `clone_paragraph(template, segments)`: new paragraph from a template with `(text, bold, italic)` segments.
   - `swap_image(drawing_paragraph, png_path, ratio=None)`: replaces a figure's picture and fixes its height.
4. Italic reference parts use `*asterisks*` in your source text, then `segments_from_markdown`.
5. References: insert each new entry alphabetically among the existing reference paragraphs, cloned from one of them; remove entries nothing cites any more (check with `ztims-citation-check`).
6. Tables: edit cell paragraphs the same way. Do not merge or add columns.
7. Contents and the lists of tables and figures are typed text, not fields. Say that page numbers must be updated in Word.

## Validate and look
```
python3 /mnt/skills/public/docx/scripts/office/validate.py --original original.docx revised.docx
soffice --headless --convert-to pdf revised.docx     # then view the changed pages
pandoc revised.docx -t plain --wrap=none -o revised.txt   # text for searching and citation check
```
Report: file name, what changed, what was checked, what was not (for example "formatting looked right on pages 24 to 30 only"), and what the user must do in Word.
