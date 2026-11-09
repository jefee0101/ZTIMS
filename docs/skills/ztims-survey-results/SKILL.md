---
name: ztims-survey-results
description: Compute and write up ZTIMS survey results correctly (frequency, percentage, weighted mean, sample standard deviation, interpretation, ranking) for the pre-development survey, TAM and ISO/IEC 25010:2023 evaluations. Use when entering or checking numbers in Chapter III tables or when writing their interpretation paragraphs.
---

# ZTIMS survey results

## Rules already decided for this study
- **Pre-development** items (difficulty of the manual process): mean (M) and SD, interpretation by the scale in Table 2, and a **ranking** of the five challenges by mean (Table 9).
- **TAM** (four constructs) and **ISO/IEC 25010:2023** (nine characteristics): weighted mean (WM) and sample SD, interpretation by the scales in Tables 3 and 4. **No ranking.**
- Frequency questions (how records are stored, how visitor data are recorded, how updates are published): show **f and %** only, sorted from the most used to the least used. These are multiple-response, so percentages add to more than 100%. Say "of the 40 respondents".
- Use the **sample** standard deviation (n minus 1).
- ISO scale (as in the file's Table 11 note): 1.00–1.80 Very Poor; 1.81–2.60 Poor; 2.61–3.40 Moderate; 3.41–4.20 Good; 4.21–5.00 Excellent. Read the TAM and challenge scales from Tables 2 and 3 of the file; do not assume them.
- Statistics here are counts and totals only; no revenue.

## Compute with the script
```
python3 docs/skills/ztims-survey-results/stats.py --counts 0 1 3 12 24
```
Counts are for ratings 1 to 5 in order. It prints N, weighted mean, sample SD and the interpretation on an equal-width five-band scale (change the bands with `--bands` to match the file's table). For raw scores use `--scores 4 5 5 3 ...`. For frequency tables use `--freq 33 25 18 --n 40` (counts per option). Always compare the output with the file's table; if they differ, find out why before changing anything.

## Checks before writing
1. Each column's counts add up to N. Each row's counts add up to the group size.
2. Mean lies inside the interpretation band stated. A mean of 3.40 and one of 3.41 sit in different bands.
3. Overall mean of a construct is the mean of all its responses (or of item means when each item has the same N); say which, and be consistent with the file.
4. Numbers in the text, tables, Summary of Findings, Executive Summary and Abstract all match.
5. Two decimals for M, WM, SD and percentages.

## Paragraph pattern
- Open with what the table shows (the table's number, the group, N).
- Give the overall result with interpretation, then the highest and lowest items with their numbers.
- Say what it means for the office or the system in one sentence, and link to the literature or the design only where the thread requires it.
- Do not claim more than the numbers show. Different samples and instruments cannot be compared directly; say so when comparing with a study.
