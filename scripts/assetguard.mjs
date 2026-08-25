#!/usr/bin/env node
/**
 * assetguard — refuse to publish an image or video that leaks.
 *
 * WHY THIS EXISTS: a grep polices generated text. It can say nothing about a
 * PNG. Screenshots taken by hand in one afternoon carried a private project name
 * in an MCP list, an all-time spend figure on a dashboard, and a session title
 * that would have read as astroturfing — none of which any text check could see.
 *
 * IT IS A FILTER, NOT A GATE. Its OCR missed a name that was plainly legible to
 * a human on the same image, so it lowers the cost of review rather than
 * replacing it. Keep requiring a person to open the file and write a line saying
 * what is in it (see chat-recall-site/assets/REVIEWED.txt).
 *
 *   node scripts/assetguard.mjs <path>...        files or directories
 *   node scripts/assetguard.mjs --json <path>    machine-readable
 *
 * Exit 0 clean, 1 findings, 2 could not run.
 *
 * The private-name list lives OUTSIDE every repository, because the same list is
 * read by a public repo's test, this script, and the site build — and three
 * copies of a secret is three chances to leak it:
 *   $CHAT_RECALL_PRIVATE_NAMES  (comma or newline separated), or
 *   $XDG_CONFIG_HOME/chat-recall/private-names.txt, or
 *   ~/.config/chat-recall/private-names.txt
 *
 * NEVER echoes a matched string. File and frame only. Build logs get pasted into
 * issues and chats, and reprinting the name there leaks the thing the check
 * exists to protect.
 */
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']);

/* ── rule set ──────────────────────────────────────────────────────────────
 * Each rule says what it protects against, because a finding somebody does not
 * understand is a finding somebody overrides. */
const RULES = [
  {
    id: 'profanity',
    why: 'your own prompts get quoted back verbatim by recall tools; a launch clip had three instances on the poster frame',
    re: /\b(fuck\w*|shit|bullshit|cunt|wank\w*)\b/i,
  },
  {
    id: 'money',
    why: 'a spend or revenue figure is a business disclosure, and dashboards show them by default',
    re: /(?:[$£€]\s?\d[\d,]{2,}(?:\.\d+)?|\b\d[\d,]{3,}\s?(?:USD|EUR|GBP)\b)/,
  },
  {
    id: 'home-path',
    why: 'a real home directory publishes your username and often a private project alongside it',
    re: /(?:\/home\/(?!user\b)[a-z][a-z0-9_-]{1,31}|\/Users\/(?!alice\b|user\b)[A-Za-z][A-Za-z0-9_-]{1,31}|C:\\Users\\(?!user\b)[A-Za-z][A-Za-z0-9_-]{1,31})/,
  },
  {
    id: 'credential',
    why: 'a key visible in a screenshot is a live key',
    re: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  },
  {
    id: 'private-key',
    why: 'an armoured key block with a body is unrecoverable once published',
    // Requires an actual base64 body — the phrase alone appears in prose.
    re: /BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE KEY-----[\s\S]{0,40}[A-Za-z0-9+/]{40,}/,
  },
  {
    id: 'astroturf',
    why: 'a session title about drafting replies for your own product reads as astroturfing infrastructure',
    re: /\b(?:drafting|generat\w+|automat\w+)\b[^\n]{0,40}\b(?:reddit|hacker ?news|forum)\b[^\n]{0,40}\b(?:repl\w+|comment\w+|post\w+)\b/i,
  },
];

function loadPrivateNames() {
  const env = process.env.CHAT_RECALL_PRIVATE_NAMES;
  let raw = null;
  if (env && env.trim()) {
    raw = env.replace(/,/g, '\n');
  } else {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    for (const p of [join(base, 'chat-recall', 'private-names.txt')]) {
      if (existsSync(p)) { raw = readFileSync(p, 'utf8'); break; }
    }
  }
  if (raw === null) return null;
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^\[[a-z]+\]$/.test(l))
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/**
 * Accepted risks, declared in .assetguard-allow as:  <path> <rule> <reason>
 *
 * An exemption you have to justify in writing is one you stop taking casually —
 * the same reason check-chart-conventions.sh makes you write a reason and
 * REVIEWED.txt makes a person say what is in an image. Weakening a rule hides
 * the finding from every future asset; allowing one file keeps it visible.
 */
function loadAllowlist(root) {
  const p = join(root, '.assetguard-allow');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [path, rule, ...reason] = l.split(/\s+/);
      if (!path || !rule || !reason.length) {
        console.error(`assetguard: .assetguard-allow line needs <path> <rule> <reason>: ${l.slice(0, 40)}`);
        process.exit(2);
      }
      return { path, rule };
    });
}

function isAllowed(allow, file, ruleId) {
  const name = basename(file);
  return allow.some((a) => a.rule === ruleId && (a.path === name || file.endsWith(a.path)));
}

function have(bin) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

function ocr(imagePath) {
  try {
    return execFileSync('tesseract', [imagePath, 'stdout', '--psm', '6'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  } catch { return ''; }
}

/** Every rule that matches, plus the private-name rule if a list is available. */
function scanText(text, nameRe) {
  const hits = [];
  for (const rule of RULES) if (rule.re.test(text)) hits.push(rule.id);
  if (nameRe && nameRe.test(text)) hits.push('private-name');
  return hits;
}

function collect(target) {
  const out = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) {
        // macOS AppleDouble sidecars are not real assets and OCR nothing.
        if (e.startsWith('._') || e === '.git' || e === 'node_modules') continue;
        walk(join(p, e));
      }
      return;
    }
    const ext = extname(p).toLowerCase();
    if (IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)) out.push(p);
  };
  walk(target);
  return out;
}

function scanAsset(file, nameRe, work) {
  const ext = extname(file).toLowerCase();
  const findings = [];
  if (IMAGE_EXT.has(ext) && ext !== '.gif') {
    for (const id of scanText(ocr(file), nameRe)) findings.push({ id, at: 'image' });
    return findings;
  }
  // Video and GIF: one frame per second. A leak visible for two seconds is a
  // leak, and sampling more coarsely is how the first pass missed 16 seconds of
  // startup errors.
  const dir = mkdtempSync(join(work, 'f-'));
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'fps=1', join(dir, 'f%04d.png')],
      { stdio: 'ignore' });
    const frames = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    frames.forEach((f, i) => {
      for (const id of scanText(ocr(join(dir, f)), nameRe)) findings.push({ id, at: `${i}s` });
    });
  } catch {
    findings.push({ id: 'unreadable', at: 'file' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return findings;
}

/* ── main ──────────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const targets = argv.filter((a) => !a.startsWith('--'));

if (!targets.length) {
  console.error('usage: assetguard.mjs [--json] <file-or-dir>...');
  process.exit(2);
}
for (const bin of ['tesseract', 'ffmpeg']) {
  if (!have(bin)) {
    console.error(`assetguard: ${bin} is not installed — refusing to report a clean scan it did not perform`);
    process.exit(2);
  }
}

const names = loadPrivateNames();
const nameRe = names && names.length ? new RegExp(`\\b(${names.join('|')})\\b`, 'i') : null;
if (!nameRe) {
  // Warn, do not fail: an outside contributor must not get a red build over a
  // list they do not have. The site build takes the opposite line and refuses,
  // because that repo publishes and has no contributors.
  console.error('assetguard: no private-name list found — scanning without it (set CHAT_RECALL_PRIVATE_NAMES)');
}

const allow = loadAllowlist(process.cwd());
if (allow.length) console.error(`assetguard: ${allow.length} accepted risk(s) from .assetguard-allow`);

const work = mkdtempSync(join(tmpdir(), 'assetguard-'));
const results = [];
try {
  for (const t of targets) {
    if (!existsSync(t)) { console.error(`assetguard: no such path: ${t}`); process.exit(2); }
    for (const file of collect(t)) {
      const findings = scanAsset(file, nameRe, work)
        .filter((fd) => !isAllowed(allow, file, fd.id));
      if (findings.length) results.push({ file, findings });
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (asJson) {
  console.log(JSON.stringify({ clean: results.length === 0, results }, null, 2));
  process.exit(results.length ? 1 : 0);
}

if (!results.length) {
  console.log('assetguard: clean');
  process.exit(0);
}

const byId = new Map(RULES.map((r) => [r.id, r.why]));
byId.set('private-name', 'a private project or client name must not appear on a public surface');
byId.set('unreadable', 'the file could not be decoded, so it was not checked');

for (const { file, findings } of results) {
  console.log(`\nFAIL  ${file}`);
  const grouped = new Map();
  for (const f of findings) {
    if (!grouped.has(f.id)) grouped.set(f.id, []);
    grouped.get(f.id).push(f.at);
  }
  for (const [id, wheres] of grouped) {
    const at = wheres.length > 4 ? `${wheres.slice(0, 4).join(', ')} … ${wheres.length} total` : wheres.join(', ');
    console.log(`        ${id.padEnd(13)} at ${at}`);
    console.log(`        ${' '.repeat(13)}    ${byId.get(id) ?? ''}`);
  }
}
console.log('\nThe matched text is deliberately not printed — open the file and look.');
process.exit(1);
