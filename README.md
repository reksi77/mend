# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/reksi77/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/reksi77/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and mend reads all four to one written specification, `SPEC.md`. It finds the lines an edit names even when the model drifted their whitespace or indentation (three matching tiers: exact, trailing whitespace, then leading and trailing whitespace with re-indentation), and it changes every file or none: a failed edit is reported and nothing is written.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` (or nothing) to read it from standard input. `--format=NAME` forces one format (`unified`, `search-replace`, `v4a`, `json`; `auto` detects it). `--check` does everything but write. `--strict` matches lines exactly (tier 0 only). Exit 0 prints one line per changed file and `ok: <n> files`; exit 1 lists the edits that failed and `failed: <k> of <n> edits`; exit 2 reports a usage, missing-patch, format or parse error. Node 22 and its standard library alone — no dependencies, no network, deterministic.

## Checking it

```sh
node check.ts <practice.json>            # all 100 practice checks
node check.ts <practice.json> u-offset s-basic   # one family, or a key prefix
```

On the kit's public practice set this entry passes 100 of 100 checks (practice score 1000): 30 unified, 20 SEARCH/REPLACE, 20 V4A, 15 JSON and 15 CLI. It was also checked against 77 extra hand-built edge cases drawn from sentences of `SPEC.md` the practice set does not show — `\ No newline at end of file` in creations and changes, hunk and chunk parsing faults, moves and their `R` output lines, strict matching, CRLF files and files without a final line break — and passes all of them. Running the same check twice gives byte-identical stdout and files.

## The files

- `main.ts` — the CLI. Sections 1–4, 9 and 10 of `SPEC.md` come from the kit's starter; sections 5–8 (three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches) are written in this repository. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts` — the kit's trial runner, unchanged.
- `check.ts` — the practice set on your own machine: `node check.ts <practice.json>` prints every check the CLI gets wrong and the practice score.
- `SPEC.md` — the whole specification.
- `LICENSE` — MIT.

## How it works

Each format is parsed into edits first — a parse error is reported before any file is looked at — and the edits then apply in order to an in-memory tree, so a file created, changed, moved or deleted by an earlier edit is seen so by a later one. Every path an edit names is checked for safety before anything else about it. Unified hunks take the occurrence nearest to their (drifted) line number, V4A chunks follow a cursor past their anchor, and SEARCH/REPLACE blocks fail as ambiguous when their old lines occur more than once. Line breaks stay the file's own (CRLF included) and a file's final line break is kept unless a unified hunk says otherwise; created files end with a line break unless a `\ No newline at end of file` line follows their last added line.

---

<sub>Entered on [make.fun](https://make.fun/?ref=t3nmdwvx&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
