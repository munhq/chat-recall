/**
 * DossierView — editorial-styled markdown renderer for the per-project
 * dossier returned by GET /api/projects/:id/dossier.
 *
 * Aesthetic: "project file" — serif display headings, mono for
 * tech-stack chips and code blocks, hairline section rules, sticky
 * right-side table-of-contents linking to each section. Distinct from
 * the rest of the app's sans-only chrome so it reads as a generated
 * artifact rather than another settings page.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { getProjectDossier } from '../services/api';

interface Props {
  projectId: string;
}

interface Section {
  level: number;
  title: string;
  slug: string;
  body: string;
}

export default function DossierView({ projectId }: Props) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [activeSlug, setActiveSlug] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMarkdown(null);
    getProjectDossier(projectId, { sessions: 12 })
      .then(r => { if (!cancelled) { setMarkdown(r.markdown); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError((e as Error).message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectId]);

  const sections = useMemo<Section[]>(() => markdown ? splitSections(markdown) : [], [markdown]);

  // Scroll-spy the active section so the right-rail TOC highlights what
  // the user is currently reading.
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root || sections.length === 0) return;
    const headings = Array.from(root.querySelectorAll<HTMLElement>('[data-section-slug]'));
    const onScroll = () => {
      let current = headings[0]?.dataset.sectionSlug || '';
      const top = root.scrollTop + 80;
      for (const h of headings) {
        if (h.offsetTop <= top) current = h.dataset.sectionSlug || current;
      }
      setActiveSlug(current);
    };
    onScroll();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [sections]);

  if (loading) {
    return (
      <div style={{ padding: 40, color: 'var(--cr-fg-2)' }}>Loading dossier…</div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 40, color: 'var(--cr-err-500, #d33)' }}>
        Failed to load dossier: {error}
      </div>
    );
  }
  if (!markdown || sections.length === 0) {
    return (
      <div style={{ padding: 40, color: 'var(--cr-fg-2)' }}>
        No dossier yet for this project.
      </div>
    );
  }

  const tocItems = sections.filter(s => s.level === 2);

  return (
    <div
      ref={scrollerRef}
      style={{
        flex: 1,
        overflow: 'auto',
        background: 'var(--cr-ink-0, #0b0b0e)',
      }}
    >
      <div
        className="cr-stack-mobile"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 220px',
          gap: 40,
          maxWidth: 1100,
          margin: '0 auto',
          padding: '48px 32px 80px',
        }}
      >
        <article
          style={{
            color: 'var(--cr-fg-1)',
            lineHeight: 1.7,
            fontSize: 15,
          }}
        >
          {sections.map((s, i) => (
            <SectionBlock key={s.slug + i} section={s} />
          ))}
        </article>
        <aside
          style={{
            position: 'sticky',
            top: 24,
            alignSelf: 'start',
            paddingTop: 4,
            borderLeft: '1px solid var(--cr-line-1)',
            paddingLeft: 20,
            maxHeight: 'calc(100dvh - 120px)',
            overflow: 'auto',
          }}
        >
          <div
            style={{
              fontSize: 10,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--cr-fg-3)',
              marginBottom: 10,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            Contents
          </div>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {tocItems.map(s => {
              const on = s.slug === activeSlug;
              return (
                <a
                  key={s.slug}
                  href={`#${s.slug}`}
                  onClick={(e) => {
                    e.preventDefault();
                    const el = scrollerRef.current?.querySelector(`[data-section-slug="${s.slug}"]`) as HTMLElement | null;
                    if (el && scrollerRef.current) {
                      scrollerRef.current.scrollTo({ top: el.offsetTop - 24, behavior: 'smooth' });
                    }
                  }}
                  style={{
                    fontSize: 12,
                    color: on ? 'var(--cr-fg-1)' : 'var(--cr-fg-3)',
                    textDecoration: 'none',
                    borderLeft: `2px solid ${on ? 'var(--cr-brand-500, #6c8eff)' : 'transparent'}`,
                    paddingLeft: 10,
                    paddingTop: 2,
                    paddingBottom: 2,
                    transition: 'color var(--cr-dur-fast), border-color var(--cr-dur-fast)',
                  }}
                >
                  {s.title}
                </a>
              );
            })}
          </nav>
        </aside>
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Section rendering — minimal markdown subset matched to dossier output
 * --------------------------------------------------------------------- */

function SectionBlock({ section }: { section: Section }) {
  if (section.level === 1) {
    return (
      <header style={{ marginBottom: 28 }}>
        <h1
          data-section-slug={section.slug}
          style={{
            fontFamily: 'Fraunces, "Tiempos Headline", Georgia, serif',
            fontSize: 38,
            fontWeight: 600,
            margin: 0,
            letterSpacing: '-0.02em',
            color: 'var(--cr-fg-1)',
          }}
        >
          {section.title}
        </h1>
        <MarkdownBody text={section.body} />
      </header>
    );
  }
  return (
    <section
      data-section-slug={section.slug}
      style={{
        paddingTop: 28,
        marginTop: 28,
        borderTop: '1px solid var(--cr-line-1)',
      }}
    >
      <h2
        style={{
          fontFamily: 'Fraunces, "Tiempos Headline", Georgia, serif',
          fontSize: 22,
          fontWeight: 600,
          margin: '0 0 12px',
          letterSpacing: '-0.01em',
          color: 'var(--cr-fg-1)',
        }}
      >
        {section.title}
      </h2>
      <MarkdownBody text={section.body} />
    </section>
  );
}

function MarkdownBody({ text }: { text: string }) {
  // Render a minimal markdown subset that matches the dossier output:
  // paragraphs, fenced code, inline backticks, bold, italics, links,
  // bullet lists, and tables. Keeps things dependency-free (no marked,
  // remark, MDX) since the source is server-controlled.
  const nodes: React.ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const start = i + 1;
      let end = start;
      while (end < lines.length && !lines[end].startsWith('```')) end++;
      const code = lines.slice(start, end).join('\n');
      nodes.push(
        <pre
          key={key++}
          style={{
            margin: '14px 0',
            padding: 14,
            background: 'var(--cr-ink-1)',
            border: '1px solid var(--cr-line-1)',
            borderRadius: 6,
            overflow: 'auto',
            fontSize: 12,
            lineHeight: 1.55,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: 'var(--cr-fg-2)',
          }}
          data-lang={lang}
        >
          {code}
        </pre>
      );
      i = end + 1;
      continue;
    }

    // Table (pipe-delimited)
    if (line.includes('|') && lines[i + 1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(lines[i]);
        i++;
      }
      nodes.push(renderTable(rows, key++));
      continue;
    }

    // Bullet list
    if (/^\s*[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s/, ''));
        i++;
      }
      nodes.push(
        <ul key={key++} style={{ margin: '8px 0 14px', paddingLeft: 22 }}>
          {items.map((it, idx) => <li key={idx} style={{ marginBottom: 4 }}>{renderInline(it)}</li>)}
        </ul>
      );
      continue;
    }

    // Blank line → paragraph break
    if (!line.trim()) { i++; continue; }

    // Paragraph: accumulate until blank line
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('```')) {
      para.push(lines[i]);
      i++;
    }
    nodes.push(
      <p key={key++} style={{ margin: '8px 0 14px', color: 'var(--cr-fg-1)' }}>
        {renderInline(para.join(' '))}
      </p>
    );
  }

  return <>{nodes}</>;
}

function renderTable(rows: string[], key: number): React.ReactNode {
  const splitRow = (r: string) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  const header = splitRow(rows[0]);
  const bodyRows = rows.slice(2).map(splitRow);
  return (
    <table
      key={key}
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        margin: '14px 0',
        fontSize: 13,
        color: 'var(--cr-fg-1)',
      }}
    >
      <thead>
        <tr>
          {header.map((h, i) => (
            <th
              key={i}
              style={{
                textAlign: 'left',
                padding: '6px 10px',
                color: 'var(--cr-fg-2)',
                fontWeight: 500,
                fontSize: 11,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                borderBottom: '1px solid var(--cr-line-2)',
              }}
            >
              {renderInline(h)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {bodyRows.map((row, ri) => (
          <tr key={ri}>
            {row.map((cell, ci) => (
              <td
                key={ci}
                style={{
                  padding: '6px 10px',
                  borderBottom: '1px solid var(--cr-line-1)',
                }}
              >
                {renderInline(cell)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Render a minimal inline-markdown subset: backticks (mono), **bold**,
 * _italic_, [text](url). Walks the string once and emits React nodes.
 */
function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let buf = '';
  let i = 0;
  let k = 0;

  const flush = () => {
    if (buf) { out.push(buf); buf = ''; }
  };

  while (i < text.length) {
    const c = text[i];

    // Backtick mono
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        flush();
        const code = text.slice(i + 1, end);
        out.push(
          <code
            key={k++}
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '0.88em',
              background: 'var(--cr-ink-2)',
              padding: '1px 5px',
              borderRadius: 3,
              border: '1px solid var(--cr-line-1)',
            }}
          >
            {code}
          </code>
        );
        i = end + 1;
        continue;
      }
    }

    // Bold
    if (c === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end > i) {
        flush();
        out.push(<strong key={k++}>{text.slice(i + 2, end)}</strong>);
        i = end + 2;
        continue;
      }
    }

    // Link
    if (c === '[') {
      const close = text.indexOf(']', i);
      if (close > i && text[close + 1] === '(') {
        const paren = text.indexOf(')', close + 2);
        if (paren > close) {
          flush();
          const label = text.slice(i + 1, close);
          const url = text.slice(close + 2, paren);
          out.push(
            <a
              key={k++}
              href={url}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--cr-brand-500, #6c8eff)', textDecoration: 'underline' }}
            >
              {label}
            </a>
          );
          i = paren + 1;
          continue;
        }
      }
    }

    // Italic with single underscores — only if flanked by non-word chars
    // so we don't mangle filenames like foo_bar_baz.
    if (c === '_') {
      const end = text.indexOf('_', i + 1);
      const prev = i === 0 ? ' ' : text[i - 1];
      const after = end >= 0 ? text[end + 1] || ' ' : ' ';
      const looksItalic = end > i + 1 && /\W/.test(prev) && /\W/.test(after);
      if (looksItalic) {
        flush();
        out.push(<em key={k++}>{text.slice(i + 1, end)}</em>);
        i = end + 1;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

function splitSections(md: string): Section[] {
  const lines = md.split('\n');
  const sections: Section[] = [];
  let current: Section | null = null;
  const usedSlugs = new Set<string>();

  for (const line of lines) {
    const h1 = /^# (.+)$/.exec(line);
    const h2 = /^## (.+)$/.exec(line);
    if (h1 || h2) {
      if (current) sections.push(current);
      const title = (h1?.[1] ?? h2?.[1] ?? '').trim();
      const baseSlug = slugify(title);
      let slug = baseSlug;
      let n = 2;
      while (usedSlugs.has(slug)) slug = `${baseSlug}-${n++}`;
      usedSlugs.add(slug);
      current = { level: h1 ? 1 : 2, title, slug, body: '' };
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line;
    }
  }
  if (current) sections.push(current);
  return sections;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
