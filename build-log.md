# Build log — static-site (make.fun bounty site-generator-speed-01-run-20261122)

## What was built

- `solve.js` (single ES module, Node 22 stdlib only, no dependencies): a faster
  drop-in for makefun-site 1.0.0. Same answers as the reference `build()` on
  every input, byte for byte; only the work differs.
- `main.ts`: the baseline's driver, copied verbatim (reads `/input/cases.json`,
  answers each case with `run`, writes `/output/answers.json`). `package.json`:
  `{"type": "module"}`.
- Kit: `~/workspace/makefun/static-site-kit/` (fetched from
  `https://make.fun/c/site-generator-speed-01-run-20261122/kit`, 2026-11-23).
- Repo cap is 4 MiB; this repo is ~44 KB.

## Why it is faster

The reference is correct but slow where it runs hottest. Each change below
keeps the reference's rule exactly (edge cases noted where they matter):

1. **Inline Markdown** (was ~28% of baseline CPU: `escapeHtml` 171 + `inline`
   47 of 768 samples). The reference escapes every character with its own
   regex-replace call. Here one `/g` regex finds the next construct and the
   plain run before it is escaped in one call. A literal character (unmatched
   backtick, lone `*`, `[` that is no link, backslash before a character it
   does not escape) is written as itself — the same bytes, since none of those
   characters is escaped. The regex is created by the outermost call and
   shared with the recursive calls for strong/emphasis/link text; `lastIndex`
   is saved and restored around each, so the outer scan resumes correctly.
   Micro-benchmark over all practice bodies: char-loop 81 ms, indexOf-min
   44 ms, regex-exec 40 ms.
2. **escapeHtml**: an exec loop instead of replace-with-callback — 8.5 ms vs
   21 ms over all practice bodies. With no special character it returns the
   input itself, no copy. The module-level `/g` regex is safe: `escapeHtml`
   never re-enters itself.
3. **Markdown lexer**: lines are walked by index (no `split('\n')` array) and
   classified by first characters before any regex runs; a plain paragraph
   line costs a few comparisons. `trimLine` strips only space/tab by hand
   (`String.trim` would also strip other whitespace — different output).
   Heading/fence/HR detection is manual but exactly the reference's regexes
   (e.g. 7+ `#` is no heading, `----` is no break, a 10-digit number is no
   ordered list).
4. **Front matter**: only the front-matter lines are walked by index; the body
   is the slice after the closing line's newline — the same string the
   reference's `lines.slice(close + 1).join('\n')` builds (a trailing newline
   after the close leaves the same empty last line on both sides). Line
   numbers in errors count from 1 at the opening `---`, as the reference's.
5. **Slugs**: pure-ASCII strings skip NFKD + the combining-mark regex (both
   are the identity on ASCII); results are cached in a Map, so a tag name is
   slugified once, not four times per post. The character loop is by code
   unit, identical to the reference's by-code-point loop for this algorithm.
6. **Words**: `wordsOf` counts word runs by scanning (19 ms over all practice
   bodies, vs 69 ms for `match(/\S+/g)` and 44 ms for an exec loop), and
   reading minutes are computed once per source and cached on it — a post's
   card is built twice (cards map + its own page) and the body never changes.
7. **Templates**: output is pushed into one array and joined once at the top
   (the reference builds one string with `+=` across every recursive call);
   a `for` loop reuses one scope object and one loop object for all its
   elements (rendering is synchronous, nothing keeps a scope past its render);
   the render's vars/scope objects are reused per render shape (page, index,
   tag, tags) with stable shapes. Templates whose rendering depends only on
   the build's `site`/`tags`/`recent` are rendered once per build and reused:
   the set is computed from the parsed trees (no includes, every free name —
   one no enclosing for loop binds — in {site, tags, recent}), never guessed.
   A template reading a caller's loop variable (tag-list's `p`) is never in
   it, and the memo is only used outside any for loop (a runtime guard), so
   no loop variable can shadow those names. 19 of 37 practice template names
   qualify (aside-1/4/7/9/13, badge-2/6/7/8, nav, note-1/4/8, promo-2/3/4/5/11,
   strip-3). Footer/header are NOT memoized (they hold includes).
8. **Sources**: the `\r\n` -> `\n` rewrite is skipped when a file holds no `\r`.
9. **Code blocks**: the whole block is escaped in one call, not line by line
   (escaping commutes with the `\n` joins — a newline is never escaped).

Deliberately NOT done: compiling templates to generated functions (more speed
on paper, but the dispatch it removes is ~17% of solve time and the risk of a
subtle semantic drift is real); hoisting loop-invariant lookups (same reason).

## Verification

- **Practice set, byte-identical: 3/3 cases** (g-0001, g-0002, g-0003) —
  answers deep-equal to `practice/reference/expected.json`, and identical to
  the baseline's own answers. Two runs of the entry produce identical
  `answers.json` (deterministic).
- **Kit grade-local** (`grade-local --kit . --bot <repo> --driver process
  --worktree`): `scores {"cases_passed":3,"cases_total":3,"passed":1}`,
  `checks 3 of 3 points`, L1 regrade reproduced byte for byte.
  `result_sha256 c69b465f8d4253c4ff2102bfe167204e54baf0df7f2240dba77a8bb1e6a2aa86`
  (local only; the server's differs — it runs Node v26.13.1, this machine
  v24.22.1).
- **Benchmarks** (this machine, 1.5 shared CPUs, practice set of 3 cases,
  runs interleaved to share machine noise):
  - End to end, `node main.ts` with the kit's driver (node startup + JSON
    parse of 2.9 MB cases.json + stringify of 7.4 MB answers included),
    10 runs each: baseline median 1029 ms (mean 1037, range 953–1187),
    this entry median 541 ms (mean 530, range 488–558) — **1.90x median,
    1.96x mean**.
  - Solve only (`run(input)` in-process, no JSON I/O or startup), 10 runs
    each: baseline median 465 ms (range 439–523), this entry median 134 ms
    (range 115–170) — **3.47x median**. The harness times CPU net of a
    do-nothing control, which nets out the shared driver/JSON work, so the
    heat should see something closer to the solve-only ratio than the
    end-to-end one.
  - Profile of the baseline (768 samples): `escapeHtml` 171, driver JSON
    93, GC 63, `renderMarkdown` 52, `inline` 47. Profile of this entry
    (solve-only, 662 samples): `wordsOf` 104, `inline` 80, `renderNodes` 60,
    `render` 55, GC 41.

## Known weaknesses / honest verdict

- The scored set is drawn after entries close (drand round 34249212) from the
  same generator, so its distribution should match the practice set — but no
  entry can be verified against it in advance. The entry's correctness rests
  on replicating the reference's rules exactly, not on fitting the practice
  data; the practice set only confirms it.
- The constant-template memoization was proven from the practice templates'
  parsed trees. The scored set's templates come from the same generator, so
  the same structural facts should hold — but if a scored template had a
  shape the analysis mishandled (e.g. a for-loop variable shadowing `site`
  inside a memoized template's own tree), the memo guard (only outside any
  for loop, only templates with no includes and free names in
  {site, tags, recent}) still keeps it correct: such a template is either
  excluded from the set or its shadowing loop binds the name inside the
  template itself, where the bound value still comes from the build constants.
- Speed is measured on this shared-CPU VM; the server's 1-CPU containers
  will show different absolute times, but the ratio should hold (the work is
  the same, single-threaded, no I/O inside `run`).
- Placement is by CPU time among the contenders; beating the baseline at 95%
  confidence only qualifies. Other entries may be faster still — this one
  does not claim a place, only a measured ~3.5x solve-only / ~1.9x
  end-to-end speedup over the baseline.
- No system security notice was raised while building or running this entry.

## Verdict

**Submit-worthy.** Passes every practice case byte-identically, passes the
kit's own grader, deterministic, and ~3.5x faster than the baseline on the
work the heat times. The only remaining steps are the parent's: check,
bundle, submit (on Febiola's separate go-ahead).
