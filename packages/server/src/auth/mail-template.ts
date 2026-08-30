/**
 * One message, two renderings.
 *
 * ── Why a block model instead of two templates ─────────────────────────────
 *
 * Every message here has to exist twice: `text/plain` for the clients and the
 * humans who prefer it, and `text/html` for everyone else. Writing those as two
 * separate strings guarantees they drift — a price changes in one, a link is
 * fixed in the other, and nobody notices because nobody reads both. The version
 * that drifts is always the plain-text one, because it is the one the author
 * never looks at.
 *
 * So a message is authored ONCE as a list of blocks, and the two renderers are
 * total functions over that list. A new sentence cannot land in one format only.
 *
 * ── Why the HTML is written the way it is ──────────────────────────────────
 *
 * Mail clients are not browsers. The rules this file follows, each because
 * breaking it breaks a real client:
 *
 *   - Tables for layout, not flex or grid.
 *   - Every style inlined. Gmail keeps a <style> block in most contexts but not
 *     all, so the inline styles carry the LIGHT design on their own and the
 *     <style> block only adds dark mode and the mobile widths.
 *   - `background-color`, never the `background` shorthand (Outlook drops it).
 *   - No images at all. No logo to fail behind "display images", and no tracking
 *     pixel — for a product whose argument is care with your data, a pixel that
 *     reports when you opened your mail would be an odd thing to ship.
 *   - No web fonts. They load in Apple Mail and almost nowhere else, so the
 *     system stack IS the design rather than a fallback from it.
 *
 * The button is a table cell with `bgcolor` and a padded anchor inside. Outlook's
 * Word engine renders that as a solid rectangle with square corners instead of
 * the rounded one everyone else gets, which is the whole extent of the
 * degradation and does not need a VML shape to fix.
 *
 * ── Colour ─────────────────────────────────────────────────────────────────
 *
 * The palette is the app's own (client/src/index.css): apricot brand on deep
 * ink. Light is the default because a client that forces a white background must
 * still get a designed message rather than a broken dark one; dark mode is a
 * progressive enhancement through a media query.
 *
 * The button keeps ONE appearance in both schemes — ink background, apricot
 * label — because a button that restyles per scheme is the element most likely
 * to end up invisible in whichever scheme the author did not check.
 */

/** The app's palette, from client/src/index.css. */
const C = {
  pageLight: '#F4F5F7',
  cardLight: '#FFFFFF',
  lineLight: '#E4E7EC',
  inkLight: '#16181D',
  mutedLight: '#5B6472',
  codeLight: '#F7F8FA',
  brand: '#F5A97F',
  brandDeep: '#C9734A',
  buttonBg: '#101620',
  buttonFg: '#F5A97F',
} as const;

const SANS = "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

/**
 * A message is a list of these.
 *
 * `stats` carries BOTH forms on purpose: the HTML shows the numbers as figures,
 * which is the one thing HTML genuinely does better here, while plain text says
 * the same thing as a sentence. Same facts, and neither renderer invents them.
 */
export type Block =
  | { kind: 'lead'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'code'; lines: string[] }
  /**
   * A one-time code, which is NOT a `code` block.
   *
   * `code` indents its lines by two spaces so a command reads as a command. An
   * OTP must not be indented: iOS and Android offer one-tap autofill by matching
   * the code standing alone on its own line, and the plain-text rendering is what
   * they read. Two leading spaces are cheap to add and expensive to debug.
   */
  | { kind: 'otp'; code: string }
  | { kind: 'quote'; text: string }
  | { kind: 'cta'; label: string; url: string }
  | { kind: 'links'; items: Array<{ label: string; url: string }> }
  | { kind: 'stats'; text: string; items: Array<{ value: string; label: string }> }
  | { kind: 'small'; text: string }
  | { kind: 'rule' };

const WIDTH = 78;

/** Greedy wrap at 78 columns. A URL is one token and is never split, so a long
 *  link overhangs the margin — which every client handles, unlike a link broken
 *  across two lines, which stops being clickable. */
function wrap(text: string): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= WIDTH) line += ` ${w}`;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out;
}

/** Align a set of `Label: url` rows on the colon, the way the old hand-written
 *  copy did — it is the one piece of plain-text typography that survives every
 *  client and makes a list of links scannable. */
function alignedLinks(items: Array<{ label: string; url: string }>): string[] {
  const w = Math.max(...items.map((i) => i.label.length));
  return items.map((i) => `  ${i.label}:${' '.repeat(w - i.label.length + 2)}${i.url}`);
}

export function renderText(blocks: Block[]): string {
  const out: string[] = [];
  const gap = () => { if (out.length) out.push(''); };
  for (const b of blocks) {
    switch (b.kind) {
      case 'lead':
      case 'p':
        gap(); out.push(...wrap(b.text)); break;
      case 'stats':
        gap(); out.push(...wrap(b.text)); break;
      case 'code':
        // Never wrapped: a command broken across two lines cannot be pasted.
        gap(); out.push(...b.lines.map((l) => `  ${l}`)); break;
      case 'otp':
        // Column 0, nothing after it: see the block's own note.
        gap(); out.push(b.code); break;
      case 'quote':
        gap(); out.push(`  "${b.text}"`); break;
      case 'cta':
        gap(); out.push(...alignedLinks([{ label: b.label, url: b.url }])); break;
      case 'links':
        gap(); out.push(...alignedLinks(b.items)); break;
      case 'small':
        gap(); out.push(...wrap(b.text)); break;
      case 'rule':
        break; // the blank line between blocks already separates them
    }
  }
  return out.join('\n');
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** An em dash and the curly quotes survive every client; nothing else needs
 *  encoding once the text is escaped. */
function para(text: string, size: number, color: string, weight = '400', cls = 'cr-text'): string {
  return `<p class="${cls}" style="margin:0 0 18px;font-family:${SANS};font-size:${size}px;line-height:1.6;font-weight:${weight};color:${color};">${esc(text)}</p>`;
}

function htmlBlock(b: Block): string {
  switch (b.kind) {
    case 'lead':
      return `<p class="cr-text" style="margin:0 0 18px;font-family:${SANS};font-size:20px;line-height:1.45;font-weight:600;color:${C.inkLight};letter-spacing:-0.01em;">${esc(b.text)}</p>`;
    case 'p':
      return para(b.text, 16, C.inkLight);
    case 'small':
      return para(b.text, 13, C.mutedLight, '400', 'cr-muted');
    case 'stats': {
      const pills = b.items.map((i) => `
              <span class="cr-pill" style="display:inline-block;margin:0 8px 8px 0;padding:10px 14px;border:1px solid ${C.lineLight};border-radius:10px;background-color:${C.codeLight};">
                <span class="cr-stat-v" style="font-family:${MONO};font-size:19px;font-weight:700;color:${C.brandDeep};">${esc(i.value)}</span>
                <span class="cr-muted" style="font-family:${SANS};font-size:12px;color:${C.mutedLight};">&nbsp;${esc(i.label)}</span>
              </span>`).join('');
      // The prose sentence is NOT repeated here — the figures say it. Plain text
      // gets the sentence instead, from the same block.
      return `<div style="margin:0 0 14px;">${pills}
            </div>`;
    }
    case 'code':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;"><tr><td class="cr-code" style="padding:14px 16px;border:1px solid ${C.lineLight};border-radius:10px;background-color:${C.codeLight};font-family:${MONO};font-size:14px;line-height:1.7;color:${C.inkLight};white-space:nowrap;">${b.lines.map(esc).join('<br>')}</td></tr></table>`;
    case 'otp':
      // One element, literal text, never split across tags and never an image:
      // both the reader and the platform's autofill have to be able to take it.
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;"><tr><td class="cr-code" align="center" style="padding:20px 16px;border:1px solid ${C.lineLight};border-radius:12px;background-color:${C.codeLight};font-family:${MONO};font-size:34px;font-weight:700;letter-spacing:0.22em;text-indent:0.22em;line-height:1.2;color:${C.inkLight};">${esc(b.code)}</td></tr></table>`;
    case 'quote':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;"><tr><td class="cr-quote" style="padding:14px 18px;border-left:3px solid ${C.brand};background-color:${C.codeLight};font-family:${SANS};font-size:16px;font-style:italic;line-height:1.55;color:${C.inkLight};">&ldquo;${esc(b.text)}&rdquo;</td></tr></table>`;
    case 'cta':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;"><tr><td align="center" bgcolor="${C.buttonBg}" style="border-radius:10px;"><a href="${esc(b.url)}" style="display:inline-block;padding:14px 30px;font-family:${SANS};font-size:15px;font-weight:600;line-height:1;color:${C.buttonFg};text-decoration:none;border-radius:10px;">${esc(b.label)}</a></td></tr></table>`;
    case 'links':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;">${b.items.map((i) => `<tr><td style="padding:3px 0;font-family:${SANS};font-size:15px;line-height:1.5;"><a class="cr-a" href="${esc(i.url)}" style="color:${C.brandDeep};text-decoration:none;font-weight:600;">${esc(i.label)}</a><span class="cr-muted" style="color:${C.mutedLight};"> &rarr;</span></td></tr>`).join('')}</table>`;
    case 'rule':
      return `<hr class="cr-hr" style="border:0;border-top:1px solid ${C.lineLight};margin:26px 0;">`;
  }
}

/**
 * The preview line the inbox shows next to the subject.
 *
 * Worth its own field rather than letting the client take the first sentence:
 * the first sentence is written to be read AFTER the subject, so as a preview it
 * repeats it. This is the one string with a genuine second chance at getting the
 * message opened, and it is free.
 *
 * The run of &#8203;&nbsp; after it stops the client filling the rest of the
 * preview with whatever the body happens to start with.
 */
function preheaderHtml(text: string): string {
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:transparent;opacity:0;">${esc(text)}${'&#8203;&nbsp;'.repeat(60)}</div>`;
}

export interface Message {
  to: string;
  subject: string;
  /** The inbox preview line. Never a repeat of the subject. */
  preheader: string;
  blocks: Block[];
  /** Rendered under the rule at the end of every message. */
  footer?: Block[];
}

const SUPPORT_EMAIL = 'contact@chatrecall.dev';

function renderHtml(m: Message): string {
  const content = m.blocks.map(htmlBlock).join('\n            ');
  const footer = (m.footer ?? []).map(htmlBlock).join('\n            ');
  return `<!doctype html>
<html lang="en" style="color-scheme:light dark;">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(m.subject)}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .cr-page  { background-color:#090D14 !important; }
    .cr-card  { background-color:#101620 !important; border-color:#1B2433 !important; }
    .cr-text  { color:#EBF0F8 !important; }
    .cr-muted { color:#909CAF !important; }
    .cr-a     { color:#F5A97F !important; }
    .cr-hr    { border-top-color:#1B2433 !important; }
    .cr-code, .cr-quote, .cr-pill {
      background-color:#0B1119 !important; border-color:#243042 !important; color:#EBF0F8 !important;
    }
    .cr-stat-v { color:#F5A97F !important; }
    .cr-mark   { color:#EBF0F8 !important; }
  }
  @media only screen and (max-width:620px) {
    .cr-card { width:100% !important; }
    .cr-pad  { padding-left:22px !important; padding-right:22px !important; }
    .cr-code { font-size:13px !important; }
  }
</style>
</head>
<body class="cr-page" style="margin:0;padding:0;background-color:${C.pageLight};">
${preheaderHtml(m.preheader)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="cr-page" style="background-color:${C.pageLight};">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="cr-card" style="width:600px;max-width:600px;background-color:${C.cardLight};border:1px solid ${C.lineLight};border-radius:16px;">
        <tr>
          <td class="cr-pad" style="padding:28px 36px 0;">
            <span class="cr-mark" style="font-family:${MONO};font-size:14px;font-weight:700;letter-spacing:-0.02em;color:${C.inkLight};">chat<span style="color:${C.brandDeep};">-</span>recall</span>
          </td>
        </tr>
        <tr>
          <td class="cr-pad" style="padding:22px 36px 8px;">
            ${content}
          </td>
        </tr>
        <tr>
          <td class="cr-pad" style="padding:0 36px 30px;">
            <hr class="cr-hr" style="border:0;border-top:1px solid ${C.lineLight};margin:8px 0 20px;">
            ${footer}
            <p class="cr-muted" style="margin:0;font-family:${SANS};font-size:13px;line-height:1.6;color:${C.mutedLight};">
              Questions? Reply to this message, or write to
              <a class="cr-a" href="mailto:${SUPPORT_EMAIL}" style="color:${C.brandDeep};text-decoration:none;">${SUPPORT_EMAIL}</a>.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Build the `Mail` both renderers agree on. */
export function compose(m: Message): { to: string; subject: string; text: string; html: string } {
  const textBlocks = [...m.blocks, ...(m.footer ?? [])];
  const text = `${renderText(textBlocks)}\n\nQuestions: ${SUPPORT_EMAIL}\n`;
  return { to: m.to, subject: m.subject, text, html: renderHtml(m) };
}
