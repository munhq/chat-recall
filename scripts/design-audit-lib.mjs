// The single audit payload, shared by .shot-app.mjs (the nav sweep) and
// .shot-gated.mjs (the auth/billing screens). ONE definition, so a screen
// behind a login is scored by exactly the same rules as the home page —
// two copies would drift and the gated half would quietly stop checking.
export const AUDIT = `(() => {
  const px = (v) => parseFloat(v) || 0;
  const parse = (c) => {
    const s = String(c);
    // color-mix() computes to color(srgb r g b / a) with 0-1 channels. Matching
    // only rgb()/rgba() silently returned null here, the background walk fell
    // through to the body ground, and every color-mix surface scored against
    // the wrong background — a whole class of invented failures.
    let m = s.match(/color\\(\\s*srgb\\s+([^)]+)\\)/);
    if (m) {
      const p = m[1].replace('/', ' ').trim().split(/\\s+/).map(parseFloat);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
    }
    m = s.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].replace(/\\//g, ' ').split(/[,\\s]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };
  const bgOf = (el) => {
    let acc = null;
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (!c || c.a === 0) continue;
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 0.999) return acc;
    }
    const body = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    return acc ? over(acc, body) : body;
  };

  const contrast = [], small = [], radius = [], shadow = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || px(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;

    // radius: square everywhere, except a real circle (avatar, dot, balloon).
    const rad = ['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius'].map((k) => px(cs[k]));
    const maxR = Math.max(...rad);
    const circle = rad.every((v) => v >= Math.min(r.width, r.height) / 2 - 0.6) || cs.borderRadius.includes('50%');
    if (maxR > 0.5 && !circle) radius.push({ tag: el.tagName.toLowerCase(), cls: el.className?.toString?.().slice(0, 50), r: cs.borderRadius, w: Math.round(r.width), h: Math.round(r.height) });

    if (cs.boxShadow && cs.boxShadow !== 'none' && !/inset/.test(cs.boxShadow)) shadow.push({ tag: el.tagName.toLowerCase(), cls: el.className?.toString?.().slice(0, 50), s: cs.boxShadow.slice(0, 70) });

    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own) continue;
    const fs = px(cs.fontSize);
    const fw = parseInt(cs.fontWeight, 10) || 400;
    const txt = el.textContent.trim().slice(0, 40);
    if (fs < 12) small.push({ fs, txt, tag: el.tagName.toLowerCase(), cls: el.className?.toString?.().slice(0, 40) });
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const c = ratio(fg.a < 1 ? over(fg, bg) : fg, bg);
    const large = fs >= 24 || (fs >= 18.66 && fw >= 700);
    const need = large ? 3 : 4.5;
    if (c < need - 0.02) contrast.push({ ratio: +c.toFixed(2), need, fs, txt, cls: el.className?.toString?.().slice(0, 40) });
  }
  const dedupe = (a, k) => [...new Map(a.map((x) => [k(x), x])).values()];
  // PER-CONTAINER overflow, not just the document's. A table that pans inside
  // its own scroll box leaves documentElement.scrollWidth untouched, so a
  // schedule with its last column parked off-screen scored "clean".
  const panning = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (!/auto|scroll/.test(cs.overflowX)) continue;
    if (el.scrollWidth - el.clientWidth < 4) continue;
    // Containers that are MEANT to pan: a tab strip wider than a phone, a
    // code block, a wide matrix. Flagging those is noise; the defect is a
    // container that pans by accident and takes the page's content with it.
    const cls = el.className?.toString?.() || '';
    if (/cr-segmented-scroll|cr-lens-bar|cr-hscroll|cr-tablescroll|cr-graph/.test(cls)) continue;
    // A nav strip wider than a phone pans on purpose, the same as a tab strip.
    if (el.closest('.acct-nav, .team-tabs, nav')) continue;
    if (el.closest('pre, code, .message')) continue;
    panning.push({ tag: el.tagName.toLowerCase(), cls: el.className?.toString?.().slice(0, 40), over: el.scrollWidth - el.clientWidth });
  }
  return {
    panning: panning.slice(0, 12),
    contrast: dedupe(contrast, (x) => x.cls + x.ratio).slice(0, 25),
    small: dedupe(small, (x) => x.cls + x.fs).slice(0, 25),
    radius: dedupe(radius, (x) => x.cls + x.r).slice(0, 20),
    shadow: dedupe(shadow, (x) => x.cls + x.s).slice(0, 20),
    scrollWidth: document.documentElement.scrollWidth,
    theme: document.documentElement.getAttribute('data-theme'),
  };
})()`;
