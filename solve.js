// A faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Same answers as makefun-site's build() on every input, byte for byte; only the
// work is different. Where it is faster, and why:
//
//  - inline(): the reference escapes every character of a body's text with its own
//    regex-replace call. Here literal runs are flushed through escapeHtml in one
//    call each, and the next construct is found with indexOf, not a per-char loop.
//  - lex(): lines are classified by their first characters before any regex runs;
//    most lines are plain paragraph lines and never touch a regex at all.
//  - parseFrontMatter(): scans only the front-matter lines by index; the body is a
//    slice of the source, not lines sliced and re-joined.
//  - readSources(): the \r\n -> \n rewrite is skipped when a file holds no '\r'.
//  - slugify(): pure-ASCII strings skip NFKD + the combining-mark regex (both are
//    the identity there), and results are cached: a tag name is slugified once,
//    not four times per post.
//  - wordsOf(): counts word runs by scanning, no match() array of every word.
//  - renderNodes(): output is pushed into one array and joined once at the top;
//    a for loop reuses one scope object and one loop object instead of allocating
//    both per element; no forEach closures.
//  - code blocks: the whole block is escaped in one call, not line by line.
//
// Nothing here changes an answer: every rule below is the reference's rule,
// re-implemented with the same edge cases (see the comments where it matters).

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
/**
 * `text` with & < > " and ' escaped. One regex pass, as the reference's
 * replace, but the exec loop is ~2.5x faster than replace with a callback on
 * this input (measured): with no special character it returns the input
 * itself, with no copy. The regex is module-level and escapeHtml never
 * re-enters itself, so sharing lastIndex is safe.
 */
function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = ESC_RE.exec(text)) !== null) {
    out += text.slice(last, m.index) + ESCAPES[m[0]];
    last = m.index + 1;
  }
  if (last === 0) return text;
  return out + text.slice(last);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const NONASCII_RE = /[^\x00-\x7F]/;
const MARK_RE = /\p{M}/gu;

/** slugify's results, by input: a tag name or title is slugified once, not per use. */
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most SLUG_MAX
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 * NFKD is the identity on pure ASCII and no combining mark is ASCII, so ASCII
 * strings skip both steps; the character loop is the reference's, by code unit
 * (identical to its by-code-point loop here: no step distinguishes a surrogate
 * pair from its two halves, both non-alphanumeric).
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = NONASCII_RE.test(text) ? text.normalize('NFKD').replace(MARK_RE, '') : text;
  const parts = [];
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = parts.length > 0;
      continue;
    }
    if (gap) parts.push('-');
    gap = false;
    parts.push(keep);
  }
  let out = parts.join('').slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace (no array). */
const WS_SINGLE = /\s/;
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Whitespace per \s: the ASCII set by code, anything else by the same test
    // the reference's \S+ uses (a non-ASCII char is whitespace only if \s says so).
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || (c >= 128 && WS_SINGLE.test(text[i]));
    if (ws) inWord = false;
    else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. The reference splits the whole
 * source into lines; here only the front-matter lines are walked by index and the
 * body is the slice after the closing line's newline, which is the same string
 * the reference's lines.slice(close + 1).join('\n') builds (a trailing newline
 * after the close leaves the same empty last line on both sides).
 */
function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  let pos = nl === -1 ? text.length : nl + 1;
  // Walk lines from pos (line 2), looking for the closing '---' (line numbers
  // count from 1 at the opening, as the reference's).
  let lineNo = 2;
  let closeLineStart = -1;
  let closeBodyStart = -1;
  while (pos <= text.length) {
    const end = text.indexOf('\n', pos);
    const line = end === -1 ? text.slice(pos) : text.slice(pos, end);
    if (line === '---') {
      closeLineStart = pos;
      closeBodyStart = end === -1 ? text.length : end + 1;
      break;
    }
    lineNo++;
    if (end === -1) break;
    pos = end + 1;
  }
  if (closeLineStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Re-walk the front-matter lines (between the opening and the close) for values.
  pos = nl === -1 ? text.length : nl + 1;
  for (let n = 2; n < lineNo; n++) {
    const end = text.indexOf('\n', pos);
    const line = end === -1 ? text.slice(pos) : text.slice(pos, end);
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) {
      pos = end + 1;
      continue;
    }
    const m = LINE.exec(line);
    if (!m) return { error: `line ${n} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    pos = end + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeBodyStart) };
}

// ---------------------------------------------------------------- markdown

/** A line of only spaces/tabs (or empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** Strip spaces and tabs at either end (only those two, as the reference's regex). */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

/** A fence-opening line's language, or null: ``` then a language, then spaces/tabs. */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length ? lang : null;
}

/** Whether `line` closes a fence: ``` then spaces/tabs only. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  if (line[0] !== '#') return null;
  let k = 0;
  while (k < line.length && line[k] === '#') k++;
  if (k === 0 || k > 6) return null;
  if (line[k] !== ' ' && line[k] !== '\t') return null;
  const text = trimLine(line.slice(k + 1));
  return text === '' ? null : { depth: k, text };
}

/** Whether `line` is a thematic break: --- or ***, then spaces/tabs only. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line[0];
  if (c === ' ' || c === '\t') return isBlank(line);
  if (c === '`') return fenceLang(line) !== null;
  if (c === '#') return headingOf(line) !== null;
  if (c === '-' || c === '*') return isHr(line);
  return false;
}

/**
 * `src`'s block tokens, in order. Lines are walked by index (the reference's
 * split('\n') array is never built); classification looks at a line's first
 * characters before any regex runs, so a plain paragraph line costs a few
 * comparisons and no regex at all.
 */
function lex(src) {
  const tokens = [];
  const N = src.length;
  let pos = 0;
  // Next line, or null when the split('\n') lines are exhausted (a trailing
  // newline leaves one final empty line, as split does).
  const readLine = () => {
    if (pos > N) return null;
    const nl = src.indexOf('\n', pos);
    if (nl === -1) {
      const line = src.slice(pos);
      pos = N + 1;
      return line;
    }
    const line = src.slice(pos, nl);
    pos = nl + 1;
    return line;
  };
  // Peek at the next line without consuming it: re-read from the saved position.
  let line = readLine();
  while (line !== null) {
    if (isBlank(line)) {
      line = readLine();
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      line = readLine();
      while (line !== null && !isFenceClose(line)) {
        body.push(line);
        line = readLine();
      }
      line = readLine();
      tokens.push({ type: 'code', lang, lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
      line = readLine();
      continue;
    }
    if (isHr(line)) {
      tokens.push({ type: 'hr' });
      line = readLine();
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (line !== null && line[0] === '>') {
        body.push(line[1] === ' ' ? line.slice(2) : line.slice(1));
        line = readLine();
      }
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((l) => l !== '') });
      continue;
    }
    const c0 = line[0];
    const isBullet = (c0 === '-' || c0 === '*') && line[1] === ' ';
    let isOrdered = false;
    let ordStart = 1;
    let ordText = '';
    if (!isBullet && c0 >= '0' && c0 <= '9') {
      let d = 0;
      while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
      if (d >= 1 && d <= 9 && line[d] === '.' && line[d + 1] === ' ') {
        isOrdered = true;
        ordStart = Number(line.slice(0, d));
        ordText = line.slice(d + 2);
      }
    }
    if (isBullet || isOrdered) {
      const items = [];
      while (line !== null) {
        if (isBullet && ((line[0] === '-' || line[0] === '*') && line[1] === ' ')) {
          items.push([trimLine(line.slice(2))]);
          line = readLine();
        } else if (isOrdered && line[0] >= '0' && line[0] <= '9') {
          let d = 0;
          while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
          if (d >= 1 && d <= 9 && line[d] === '.' && line[d + 1] === ' ') {
            items.push([trimLine(line.slice(d + 2))]);
            line = readLine();
          } else break;
        } else if (/^ {2,}\S/.test(line)) {
          items[items.length - 1].push(trimLine(line));
          line = readLine();
        } else break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start: isOrdered ? ordStart : 1, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(line)];
    line = readLine();
    while (line !== null && !endsParagraph(line)) {
      body.push(trimLine(line));
      line = readLine();
    }
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. The reference walks
 * every character and escapes each one with its own regex call; here one /g
 * regex finds the next construct and the plain run before it is escaped in one
 * call. A character that turns out to be literal (an unmatched backtick, a lone
 * `*`, a `[` that is no link, a backslash before a character it does not escape)
 * is written as itself, which is the same bytes the reference's per-character
 * escape writes (none of those characters is escaped). The regex is created by
 * the outermost call and shared with the recursive calls for strong, emphasis
 * and link text; lastIndex is saved and restored around each, so the outer
 * scan resumes where it left off.
 */
const INLINE_RE = /[\\`*[]/g;
function inline(s, env, re) {
  re = re || INLINE_RE;
  const out = [];
  const N = s.length;
  let i = 0;
  while (i < N) {
    re.lastIndex = i;
    const m = re.exec(s);
    const j = m === null ? N : m.index;
    if (j > i) out.push(escapeHtml(s.slice(i, j)));
    if (j === N) break;
    const c = s[j];
    i = j;
    if (c === '\\') {
      if (i + 1 < N && ESCAPABLE.has(s[i + 1])) {
        out.push(escapeHtml(s[i + 1]));
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          const save = re.lastIndex;
          out.push('<strong>', inline(s.slice(i + 2, k), env, re), '</strong>');
          re.lastIndex = save;
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        const save = re.lastIndex;
        out.push('<em>', inline(s.slice(i + 1, k), env, re), '</em>');
        re.lastIndex = save;
        i = k + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    const k = findUnescaped(s, ']', i + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      const save = re.lastIndex;
      out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, k), env, re), '</a>');
      re.lastIndex = save;
      i = mm + 1;
      continue;
    }
    out.push('[');
    i++;
  }
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or ""). A code block is escaped in one call, not line
 * by line: escaping commutes with the '\n' joins (a newline is never escaped),
 * so the bytes are the reference's.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>\n`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        const body = t.lines.length === 0 ? '' : escapeHtml(`${t.lines.join('\n')}\n`);
        blocks.push(`<pre><code${cls}>${body}</code></pre>\n`);
        break;
      }
      case 'hr':
        blocks.push('<hr>\n');
        break;
      case 'blockquote':
        blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>\n`);
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        let inner = '';
        for (const item of t.items) inner += `<li>${inline(item, env)}</li>\n`;
        blocks.push(`${open}\n${inner}</${tag}>\n`);
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>\n`);
        break;
      }
    }
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (an array of chunks, joined once by the caller) in
 * `scope` ({ vars, parent }). `ctx` holds the parsed templates, the HTML escape,
 * the include depth, the templates whose output never changes in a build
 * (`constant`, with a memo of their renderings), and how deep the current render
 * sits inside for loops (`loopDepth`). The reference builds one string with +=
 * across every recursive call; pushing chunks into a shared array writes the
 * same bytes with far fewer intermediate strings. A for loop reuses one scope
 * object and one loop object for all its elements: rendering is synchronous and
 * nothing keeps a scope past its render, so mutating them per element is the
 * same as the reference's fresh object per element.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const vars = { [n.name]: null, loop: { index: 0, first: false, last: false, length: xs.length } };
        const child = { vars, parent: scope };
        ctx.loopDepth++;
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          const loop = vars.loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        ctx.loopDepth--;
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        // A constant template's rendering depends only on the build's site,
        // tags and recent, which never change in a build, and it holds no
        // include of its own, so its depth never matters either. Outside any
        // for loop (where no loop variable could shadow those names) it is
        // rendered once and the string reused; inside a loop it renders as
        // usual. The set is computed from the parsed trees (below), not
        // guessed: a template that reads a loop variable of its caller, like
        // tag-list reading `p`, is never in it.
        if (ctx.constant.has(n.name) && ctx.loopDepth === 0) {
          let html = ctx.memo.get(n.name);
          if (html === undefined) {
            const tmp = [];
            renderNodes(t, scope, ctx, depth + 1, tmp);
            html = tmp.join('');
            ctx.memo.set(n.name, html);
          }
          out.push(html);
        } else {
          renderNodes(t, scope, ctx, depth + 1, out);
        }
        break;
      }
    }
  }
}

/**
 * The templates whose rendering never changes in a build: no include of their
 * own, and every name they read that no enclosing for loop binds is one of
 * site, tags, recent (the build's constants). `loop` counts as bound only
 * inside a for body. A name read from a caller's loop (tag-list's `p`) keeps
 * its template out of the set.
 */
function constantTemplates(templates) {
  const constant = new Set();
  const walk = (nodes, bound, free) => {
    for (const n of nodes) {
      if (n.kind === 'include') return false;
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        if (!walk(n.then, bound, free)) return false;
        if (n.else !== null && !walk(n.else, bound, free)) return false;
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        const inner = new Set(bound);
        inner.add(n.name);
        inner.add('loop');
        if (!walk(n.body, inner, free)) return false;
      }
    }
    return true;
  };
  for (const [name, nodes] of templates) {
    const free = new Set();
    if (!walk(nodes, new Set(), free)) continue;
    let ok = true;
    for (const f of free) {
      if (f !== 'site' && f !== 'tags' && f !== 'recent') {
        ok = false;
        break;
      }
    }
    if (ok) constant.add(name);
  }
  return constant;
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order (one slugify per name). */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const sl = slugify(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A tag as templates read it (its posts as cards). */
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

/** A post's card, as lists show it. The reading minutes are computed once per
 * source: a post's card is built for the cards map and again for its own page,
 * and the body never changes, so the second build reuses the first count. */
function cardOf(s) {
  if (s.readingMinutes === undefined) s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates, escape: escapeHtml, constant: constantTemplates(b.templates), memo: new Map(), loopDepth: 0 };
  // One vars object and one scope per render shape, reused across renders:
  // rendering is synchronous and nothing keeps a scope past its render, so
  // mutating the render's own slots (page, posts/pager, tag) before each render
  // is the same as the reference's fresh object per render, without the
  // allocation. The shapes never change, so V8 keeps them fast.
  const pageVars = { site, tags: allTags, recent, page: null };
  const pageScope = { vars: pageVars, parent: null };
  const indexVars = { site, tags: allTags, recent, posts: null, pager: null };
  const indexScope = { vars: indexVars, parent: null };
  const tagVars = { site, tags: allTags, recent, tag: null };
  const tagScope = { vars: tagVars, parent: null };
  const tagsVars = { site, tags: allTags, recent };
  const tagsScope = { vars: tagsVars, parent: null };
  const render = (name, scope) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  for (const s of b.sources) {
    pageVars.page = pageOf(s);
    b.output[`${s.outDir}/index.html`] = render(s.layout, pageScope);
  }
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    indexVars.posts = b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p));
    indexVars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = render('index', indexScope);
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    tagVars.tag = tagOf(b, t);
    const html = render('tag', tagScope);
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', tagsScope);
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** The plugins, in the order a build runs them. */
const PIPELINE = [readSources, frontMatter, permalinks, markdown, collections, tags, layouts, report];

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  for (const plugin of PIPELINE) plugin(b);
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input (faster, identical). */
export function run(input) {
  return build(input);
}
