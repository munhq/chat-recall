/**
 * System health — one page that answers "is chat-recall working?"
 *
 * ── Why it is a page ─────────────────────────────────────────────────────
 * The fleet panel already existed and was mounted inside AccountPage, which
 * nobody opens to ask whether their sync is healthy. Everything else about the
 * collector — the events it reports, the timings, whether telemetry is even
 * being collected — had no surface at all: it lived in a Postgres table, a log
 * file on the user's laptop, and `chat-recall doctor`.
 *
 * ── The order is the argument ────────────────────────────────────────────
 * Machines first, because a named problem on a named laptop is the thing a
 * reader can act on. The event log second, because it answers "what exactly"
 * — the question you only have once the answer to the first is yes. A reader
 * with nothing wrong should be able to stop after the first section.
 *
 * Deliberately NOT a metrics dashboard. There is no value in a wall of charts
 * for a two-service system; the numbers that matter ride along beside the
 * machine they describe (see FleetHealth), and the fleet-wide shape is one line.
 */
import React from 'react';
import FleetHealth from './FleetHealth';
import CollectorEvents from './CollectorEvents';

function SectionHeading({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <h2 style={{
        margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--cr-fg-1)',
        fontFamily: 'var(--cr-font-sans)',
      }}>{title}</h2>
      <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--cr-fg-3)', lineHeight: 1.5 }}>{sub}</p>
    </div>
  );
}

export default function SystemHealth() {
  return (
    <div style={{ padding: '18px 20px 40px', maxWidth: 980, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{
          margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--cr-fg-1)',
          fontFamily: 'var(--cr-font-sans)',
        }}>
          System health
        </h1>
        <p style={{ margin: '5px 0 0', fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.55 }}>
          Whether your machines are actually collecting and shipping. Healthy and broken
          look identical from a search box, so this page leads with problems in plain
          language rather than counters you have to interpret.
        </p>
      </div>

      <section style={{ marginBottom: 28 }}>
        <SectionHeading
          title="Your machines"
          sub="One row per machine. A machine with nothing wrong stays a single quiet line."
        />
        <FleetHealth />
      </section>

      <section>
        <SectionHeading
          title="What the collectors reported"
          sub="Timings, counts and failure classes — never transcript content, file paths or project names."
        />
        <CollectorEvents />
      </section>
    </div>
  );
}
