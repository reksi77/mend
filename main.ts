// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, in patch order: [old path, new path]. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Section 5: matching lines at three tiers ---- */

type Tier = 0 | 1 | 2;

function trimTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
function lineEq(a: string, b: string, tier: Tier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}
function tiers(strict: boolean): Tier[] {
  return strict ? [0] : [0, 1, 2];
}

/** A file's text as lines, its line break, and whether it ends with one. */
function splitFile(text: string): { lines: string[]; br: string; finalBr: boolean } {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}
function joinFile(lines: string[], br: string, finalBr: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBr ? br : '');
}

/** Every start position where O occurs in lines at a tier, overlaps allowed. */
function occurrences(O: string[], lines: string[], tier: Tier, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its occurrences. */
function firstTier(O: string[], lines: string[], strict: boolean, from = 0): { tier: Tier; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = occurrences(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** N with context lines taken from the file and tier-2 lines re-indented. */
function buildReplacement(fileLines: string[], at: number, O: string[], N: NewLine[], tier: Tier): string[] {
  const f = leadingWs(fileLines[at] ?? '');
  const p = leadingWs(O[0] ?? '');
  return N.map((e) => {
    if (e.ctx) return fileLines[at + e.oIdx]!;
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
      return t;
    }
    return e.text;
  });
}

/* ---- Section 6: unified diffs ---- */

interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNl: boolean;
  /** The hunk has a `+` line. */
  hasPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoNl: boolean;
}

function parseHunkHeader(l: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
  return m === null ? null : Number(m[1]);
}

function buildHunk(header: string, body: string[]): Hunk {
  const a = parseHunkHeader(header)!;
  const o: string[] = [];
  const n: NewLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((l, i) => {
    const c = l[0];
    if (c === ' ') {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: true, oIdx: o.length - 1 });
      lastCtxPlus = i;
    } else if (c === '-') {
      o.push(l.slice(1));
    } else if (c === '+') {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      lastCtxPlus = i;
      lastPlus = i;
    } else if (l === '') {
      o.push('');
      n.push({ text: '', ctx: true, oIdx: o.length - 1 });
      lastCtxPlus = i;
    }
    // a `\` line refers to the body line before it and adds no line
  });
  const follows = (idx: number): boolean => idx >= 0 && body[idx + 1] !== undefined && body[idx + 1]!.startsWith('\\');
  return { a, o, n, noNl: follows(lastCtxPlus), hasPlus: lastPlus >= 0, plusNoNl: follows(lastPlus) };
}

/** The path a `--- ` or `+++ ` line names, or null for /dev/null. */
function uniPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function applyUnifiedHunks(text: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const { lines: start, br, finalBr: startFinal } = splitFile(text);
  let lines = start;
  let finalBr = startFinal;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      if (h.n.length === 0) continue;
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const ins = h.n.map((e) => e.text);
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
      if (atEnd) finalBr = !h.noNl;
      d += h.n.length;
      continue;
    }
    const found = firstTier(h.o, lines, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let at = found.occ[0]!;
    let best = Math.abs(at - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        at = p;
      }
    }
    const touchesEnd = at + h.o.length === lines.length;
    const repl = buildReplacement(lines, at, h.o, h.n, found.tier);
    lines = [...lines.slice(0, at), ...repl, ...lines.slice(at + h.o.length)];
    if (touchesEnd) finalBr = !h.noNl;
    d += h.n.length - h.o.length;
  }
  return joinFile(lines, br, finalBr);
}

function uniSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = !isCreate && (sec.isDelete || newP === null);
    if (isCreate) {
      if (newP === null) return; // both paths /dev/null: nothing to write to
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const e of h.n) if (!e.ctx) plus.push(e.text);
      let noNl = false;
      for (let i = sec.hunks.length - 1; i >= 0; i--) {
        if (sec.hunks[i]!.hasPlus) {
          noNl = sec.hunks[i]!.plusNoNl;
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyUnifiedHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyUnifiedHunks(before, sec.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Draft {
    gitOld: string | null;
    gitNew: string | null;
    oldPath: string | null;
    newPath: string | null;
    hasPair: boolean;
    renameOld: string | null;
    renameNew: string | null;
    isCreate: boolean;
    isDelete: boolean;
    inHeader: boolean;
    hunks: Hunk[];
  }
  const sections: Draft[] = [];
  let cur: Draft | null = null;
  const startSection = (gitOld: string | null, gitNew: string | null): Draft => {
    const d: Draft = { gitOld, gitNew, oldPath: null, newPath: null, hasPair: false, renameOld: null, renameNew: null, isCreate: false, isDelete: false, inHeader: true, hunks: [] };
    sections.push(d);
    cur = d;
    return d;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.inHeader && !cur.hasPair) {
        cur.oldPath = uniPath(l);
        cur.newPath = uniPath(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      const d = startSection(null, null);
      d.oldPath = uniPath(l);
      d.newPath = uniPath(lines[i + 1]!);
      d.hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = parseHunkHeader(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(l, body));
      cur.inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l === 'new file mode' || l.startsWith('new file mode ')) cur.isCreate = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur.isDelete = true;
      else if (l.startsWith('rename from ')) cur.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice('rename to '.length).trim();
      // every other header line is ignored
      i++;
      continue;
    }
    // outside any section header: prose, ignored
    i++;
  }
  return sections.map((d) => {
    const sec: UniSection = {
      oldPath: d.hasPair ? d.oldPath : d.renameOld ?? d.gitOld,
      newPath: d.hasPair ? d.newPath : d.renameNew ?? d.gitNew,
      isCreate: d.isCreate,
      isDelete: d.isDelete,
      hunks: d.hunks,
    };
    return uniSectionEdit(sec, strict);
  });
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // index of the previous block's `>>>>>>> REPLACE` line
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    // The path is the nearest line before SEARCH, after the previous block's end,
    // that is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    // A SEARCH line with no `=======` and then `>>>>>>> REPLACE` after it is a parse fault.
    let sep = -1;
    let j = searchLine + 1;
    while (j < n) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      j++;
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    let k = sep + 1;
    while (k < n) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
      k++;
    }
    if (end === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const { lines: fl, br, finalBr } = splitFile(before);
      const found = firstTier(oldLines, fl, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const at = found.occ[0]!;
      const repl = buildReplacement(fl, at, oldLines, newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 })), found.tier);
      const out = [...fl.slice(0, at), ...repl, ...fl.slice(at + oldLines.length)];
      tree.now.set(p, joinFile(out, br, finalBr));
    });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/* ---- Section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionStart = (l: string): { kind: string; path: string } | null => {
    const m = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(l);
    return m === null ? null : { kind: m[1]!, path: m[2]!.trim() };
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const sec = sectionStart(l);
    if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    const body: number[] = [];
    while (j < last) {
      if (sectionStart(lines[j]!) !== null) break;
      body.push(j);
      j++;
    }
    // Blank lines at the end of a section are not part of it.
    while (body.length > 0 && blank(lines[body[body.length - 1]!]!)) body.pop();
    if (sec.kind === 'Add File') {
      const fileLines: string[] = [];
      for (const idx of body) {
        const b = lines[idx]!;
        if (b.startsWith('+')) fileLines.push(b.slice(1));
        else if (b === '') fileLines.push('');
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      const p = sec.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (sec.kind === 'Delete File') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]! + 1}`);
      const p = sec.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      // Update File
      const updateLine = i;
      let moveTo: string | null = null;
      let k = 0;
      if (body.length > 0 && lines[body[0]!]!.startsWith('*** Move to: ')) {
        moveTo = lines[body[0]!]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const startChunk = (anchor: string | null): void => {
        cur = { anchor, eof: false, o: [], n: [] };
        chunks.push(cur);
      };
      for (let t = k; t < body.length; t++) {
        const idx = body[t]!;
        const b = lines[idx]!;
        if (b.startsWith('@@')) {
          const anchor = b.slice(2).trim();
          startChunk(anchor === '' ? null : anchor);
          continue;
        }
        if (b === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (cur === null) {
          // Only the first chunk may start at a body line.
          if (chunks.length > 0) throw new Exit2(`error: parse ${idx + 1}`);
          startChunk(null);
        }
        const c = b[0];
        if (c === ' ') {
          cur.o.push(b.slice(1));
          cur.n.push({ text: b.slice(1), ctx: true, oIdx: cur.o.length - 1 });
        } else if (c === '-') {
          cur.o.push(b.slice(1));
        } else if (c === '+') {
          cur.n.push({ text: b.slice(1), ctx: false, oIdx: -1 });
        } else if (b === '') {
          cur.o.push('');
          cur.n.push({ text: '', ctx: true, oIdx: cur.o.length - 1 });
        } else {
          throw new Exit2(`error: parse ${idx + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      const p = sec.path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const { lines: fl, br, finalBr } = splitFile(before);
        let fileLines = fl;
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null) {
            let found = -1;
            for (const t of tiers(strict)) {
              for (let x = cursor; x < fileLines.length; x++) {
                if (lineEq(ch.anchor, fileLines[x]!, t)) {
                  found = x;
                  break;
                }
              }
              if (found >= 0) break;
            }
            if (found < 0) throw new Fail('no-match', p);
            cursor = found + 1;
          }
          if (ch.o.length === 0) {
            const pos = ch.eof ? fileLines.length : cursor;
            const ins = ch.n.map((e) => e.text);
            fileLines = [...fileLines.slice(0, pos), ...ins, ...fileLines.slice(pos)];
            cursor = pos + ins.length;
            continue;
          }
          // The first occurrence at or after the cursor, at the first tier with one;
          // an end-of-file chunk takes only an occurrence ending at the last line.
          let hit: { tier: Tier; at: number } | null = null;
          for (const t of tiers(strict)) {
            const occ = occurrences(ch.o, fileLines, t, cursor).filter((at) => !ch.eof || at + ch.o.length === fileLines.length);
            if (occ.length > 0) {
              hit = { tier: t, at: occ[0]! };
              break;
            }
          }
          if (hit === null) throw new Fail('no-match', p);
          const repl = buildReplacement(fileLines, hit.at, ch.o, ch.n, hit.tier);
          fileLines = [...fileLines.slice(0, hit.at), ...repl, ...fileLines.slice(hit.at + ch.o.length)];
          cursor = hit.at + repl.length;
        }
        const out = joinFile(fileLines, br, finalBr);
        if (mt !== null) {
          tree.now.set(p, null);
          tree.now.set(mt, out);
          tree.moves.push([p, mt]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  // A move that succeeded replaces its pair's D and A lines with one R line, sorted by the new path.
  const pairedOld = new Set<string>();
  const pairedNew = new Set<string>();
  const outRows: { key: string; text: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      pairedOld.add(o);
      pairedNew.add(n);
      outRows.push({ key: n, text: `R ${o} -> ${n}` });
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (pairedOld.has(p) || pairedNew.has(p)) continue;
    outRows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  outRows.sort((a, b) => byteCmp(a.key, b.key) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  const rows = outRows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
