# ZTIMS manuscript skills

Seven skills that help develop the capstone manuscript. Each is a folder with a `SKILL.md` (name and description in the header, then the rules). Four have a small script that was tested on the real files.

| Skill | What it does | Script |
|---|---|---|
| `ztims-drawio-diagrams` | Clean, accurate draw.io diagrams and figures | `check_drawio.py` |
| `ztims-rrl-research` | Reliable, verified RRL sources and writing | none |
| `ztims-manuscript-writing` | Format, plain-language style, golden thread across chapters | none |
| `ztims-citation-check` | In-text citations against the reference list | `cite_check.py` |
| `ztims-system-manuscript-sync` | What the manuscript must change after system changes | none |
| `ztims-survey-results` | f, %, WM, sample SD, interpretation, ranking | `stats.py` |
| `ztims-docx-revision` | Safe edits of the Word file, validate and render | `docx_tools.py` |

## Use in Claude Code
Open the repo. The skills are in `docs/skills/`. To have Claude Code load them as skills, copy the folders to `~/.claude/skills/` (all projects) or `.claude/skills/` (this repo), then name one in your request, for example "use ztims-rrl-research".

## Use in Codex CLI, by typing the prompt
Without installing anything, open Codex in the repo and paste the matching prompt from `PROMPTS.md`. Each prompt tells Codex to read the skill file first and follow it, then gives your task. To install them instead, copy the folders to `~/.agents/skills/` and type `$ztims-rrl-research` before your task.

## Keep in step
The skills quote decisions from `CLAUDE.md` and `docs/MANUSCRIPT-NOTES.md`. When a decision changes there (roles, terms, features), update the skill that repeats it.
