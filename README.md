# static-site: a faster drop-in for makefun-site 1.0.0

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/FSerlyta/static-site/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/FSerlyta/static-site/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0, the house baseline of the make.fun
bounty "Build a static site faster". `solve.js` (Node 22, standard library
only, no dependencies) returns exactly the answer makefun-site's `build()`
returns for every input — the same output tree, byte for byte — in about a
third of the baseline's CPU time. `main.ts` is the baseline's driver,
unchanged: it reads every case from `/input/cases.json`, answers each with
`run`, and writes `/output/answers.json`.

## Why it is faster

The reference is correct but slow in the places that run hottest: its inline
Markdown renderer escapes every character with its own regex call, its
template renderer builds one string with `+=` across every recursive call,
and it re-derives the same values (a tag's slug, a post's reading minutes, a
site-only template's rendering) over and over. This entry keeps every rule
and re-implements the work:

- **Inline Markdown**: one regex finds the next construct; the plain run
  before it is escaped in one call. The escape itself is an exec loop, ~2.5x
  faster than replace-with-callback on this input.
- **Markdown lexer**: lines are classified by their first characters before
  any regex runs; a plain paragraph line costs a few comparisons.
- **Front matter**: only the front-matter lines are walked by index; the body
  is a slice, not lines re-joined.
- **Slugs**: pure-ASCII strings skip NFKD and the combining-mark regex (both
  are the identity there); results are cached, so a tag name is slugified
  once, not four times per post.
- **Words**: reading minutes count word runs by scanning, no `match()` array;
  and they are computed once per source, not once per card.
- **Templates**: output is pushed into one array and joined once; a `for`
  loop reuses one scope and one loop object; the render's vars/scope objects
  are reused per render shape; templates whose output depends only on the
  build's `site`/`tags`/`recent` (proven from their parsed trees, never
  guessed — a template reading a caller's loop variable is never in the set)
  are rendered once per build and reused.
- **Sources**: the `\r\n` rewrite is skipped when a file holds no `\r`.

See `build-log.md` for the verification numbers and the known weaknesses.

## Verification

Kit grade-local: `passed: 1`, `cases_passed: 3/3` on the practice set, L1
regrade reproduced byte for byte. End to end (node startup + JSON I/O
included, 10 interleaved runs each): baseline median 1029 ms, this entry
median 541 ms — **1.90x**. Solve only (the work the heat times, net of the
driver): baseline median 465 ms, this entry median 134 ms — **3.47x**.
