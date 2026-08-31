/**
 * The two renderings, and the properties that keep them honest.
 *
 * The point of the block model is that a message cannot exist in one format
 * only. These assertions are what make that a guarantee rather than an
 * intention — above all the parity test, which fails the moment a link is added
 * to the HTML and forgotten in the text.
 */
import { describe, test, expect } from 'vitest';
import { compose, renderText, type Block } from './mail-template.js';
import { verifyOtpMail, resetPasswordMail, trialEndingMail, licenceSerialMail } from './mailer.js';
import { trialReminderMail, type TrialUsage } from '../services/trial-reminders.js';

const ACTIVE: TrialUsage = { sessions: 11004, projects: 65, oldestMs: Date.UTC(2025, 4, 7) };
const IDLE: TrialUsage = { sessions: 0, projects: 0, oldestMs: null };

/** Every message the product sends, in one list, so a new one cannot skip the
 *  whole-set assertions below by simply not being added to a test. */
const EVERY_MESSAGE = [
  ['otp: verification', verifyOtpMail('a@b.test', '481923', 'email-verification')],
  ['otp: reset', verifyOtpMail('a@b.test', '481923', 'forget-password')],
  ['password reset link', resetPasswordMail('a@b.test', 'https://chatrecall.dev/reset?t=x', 60)],
  ['stripe pre-charge', trialEndingMail('a@b.test', new Date('2026-09-05'))],
  ['licence serial', licenceSerialMail('a@b.test', 'CR-TEST-0000', 'year')],
  ['reminder half/active', trialReminderMail('a@b.test', 'half', 3, ACTIVE)],
  ['reminder final/active', trialReminderMail('a@b.test', 'final', 1, ACTIVE)],
  ['reminder ended/active', trialReminderMail('a@b.test', 'ended', 0, ACTIVE)],
  ['reminder half/idle', trialReminderMail('a@b.test', 'half', 3, IDLE)],
  ['reminder final/idle', trialReminderMail('a@b.test', 'final', 1, IDLE)],
  ['reminder ended/idle', trialReminderMail('a@b.test', 'ended', 0, IDLE)],
] as const;

describe('every message the product sends', () => {
  test('has both a plain-text and an HTML body', () => {
    for (const [name, m] of EVERY_MESSAGE) {
      expect(m.text, name).toBeTruthy();
      expect(m.html, name).toMatch(/^<!doctype html>/);
    }
  });

  test('LINK PARITY: every URL in the HTML also appears in the text', () => {
    // The plain-text body is the one nobody proofreads, so it is the one that
    // silently loses a link. This is the assertion that stops that.
    for (const [name, m] of EVERY_MESSAGE) {
      const urls = new Set((m.html!.match(/https?:\/\/[^"'\s<>]+/g) ?? []));
      for (const url of urls) {
        if (url.startsWith('mailto:')) continue;
        expect(m.text, `${name} is missing ${url}`).toContain(url);
      }
    }
  });

  test('NO EM-DASH anywhere in the rendered copy', () => {
    // The em-dash is the single clearest tell that a machine wrote the copy, and
    // it was in 13 places across these ten messages. A hyphen doing an em-dash's
    // job reads as a typo, so each one was fixed by restructuring the sentence:
    // a period, a comma, a colon or parentheses, whichever the clause wanted.
    for (const [name, m] of EVERY_MESSAGE) {
      const found = `${m.subject}\n${m.text}`.match(/[\u2014\u2013]/g) ?? [];
      expect(found, `${name} contains ${found.length} em/en-dash(es)`).toEqual([]);
      expect(m.html!.match(/[\u2014\u2013]/g) ?? [], `${name} html`).toEqual([]);
    }
  });

  test('carries no image of any kind — no logo to block, no tracking pixel', () => {
    // A pixel reporting when you opened your mail would be an odd thing to ship
    // in a product whose argument is care with your data.
    for (const [name, m] of EVERY_MESSAGE) {
      expect(m.html, name).not.toMatch(/<img\b/i);
      expect(m.html, name).not.toMatch(/background-image/i);
    }
  });

  test('has a preheader that is not just the subject again', () => {
    for (const [name, m] of EVERY_MESSAGE) {
      const preheader = m.html!.match(/color:transparent;opacity:0;">([^<]*?)&#8203;/)?.[1] ?? '';
      expect(preheader.length, name).toBeGreaterThan(10);
      expect(preheader.trim(), name).not.toBe(m.subject);
    }
  });

  test('declares both colour schemes and defines the dark one', () => {
    for (const [name, m] of EVERY_MESSAGE) {
      expect(m.html, name).toContain('name="color-scheme" content="light dark"');
      expect(m.html, name).toContain('@media (prefers-color-scheme: dark)');
    }
  });

  test('is responsive rather than fixed at 600px', () => {
    for (const [name, m] of EVERY_MESSAGE) {
      expect(m.html, name).toContain('@media only screen and (max-width:620px)');
    }
  });

  test('always offers a way to reach a person', () => {
    for (const [name, m] of EVERY_MESSAGE) {
      expect(m.text, name).toContain('contact@chatrecall.dev');
      expect(m.html, name).toContain('contact@chatrecall.dev');
    }
  });
});

describe('renderText', () => {
  test('wraps prose at 78 columns but never a command', () => {
    const blocks: Block[] = [
      { kind: 'p', text: 'x'.repeat(40) + ' ' + 'y'.repeat(40) + ' ' + 'z'.repeat(10) },
      { kind: 'code', lines: ['chat-recall sync --full'] },
    ];
    const lines = renderText(blocks).split('\n');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(78);
    expect(lines).toContain('  chat-recall sync --full');
  });

  test('never breaks a URL across two lines', () => {
    const url = 'https://chatrecall.dev/app?view=account&something=quite-long-indeed';
    const text = renderText([{ kind: 'p', text: `Go to ${url} now.` }]);
    expect(text).toContain(url);
  });

  test('an OTP sits at column 0, a command is indented', () => {
    // Autofill on iOS and Android matches the code standing alone on its line.
    expect(renderText([{ kind: 'otp', code: '481923' }]).split('\n')).toContain('481923');
    expect(renderText([{ kind: 'code', lines: ['481923'] }]).split('\n')).toContain('  481923');
  });

  test('aligns a set of links on the colon', () => {
    const text = renderText([{
      kind: 'links',
      items: [{ label: 'Subscribe', url: 'https://a.test' }, { label: 'Your account', url: 'https://b.test' }],
    }]);
    const cols = text.split('\n').map((l) => l.indexOf('https'));
    expect(cols[0]).toBe(cols[1]);
  });
});

describe('renderHtml', () => {
  test('escapes text rather than letting it become markup', () => {
    const m = compose({
      to: 'a@b.test',
      subject: 'x',
      preheader: 'y',
      blocks: [{ kind: 'p', text: '<script>alert(1)</script> & "quoted"' }],
    });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('&amp;');
  });

  test('the stat row shows figures while the text says the same thing in prose', () => {
    const m = compose({
      to: 'a@b.test',
      subject: 'x',
      preheader: 'y',
      blocks: [{
        kind: 'stats',
        text: 'chat-recall has indexed 11,004 sessions from 65 projects.',
        items: [{ value: '11,004', label: 'sessions' }, { value: '65', label: 'projects' }],
      }],
    });
    expect(m.html).toContain('>11,004<');
    expect(m.html).toContain('65');
    expect(m.text).toContain('chat-recall has indexed 11,004 sessions from 65 projects.');
  });

  test('uses tables and inline styles, not flex or grid', () => {
    const m = trialReminderMail('a@b.test', 'half', 3, ACTIVE);
    expect(m.html).toContain('role="presentation"');
    expect(m.html).not.toMatch(/display:\s*flex/);
    expect(m.html).not.toMatch(/display:\s*grid/);
    // Outlook drops the `background` shorthand.
    expect(m.html).not.toMatch(/[^-]background:\s*#/);
  });

  test('the button is a bgcolor cell, so Outlook still renders a solid button', () => {
    const m = trialReminderMail('a@b.test', 'half', 3, ACTIVE);
    expect(m.html).toMatch(/<td align="center" bgcolor="#[0-9A-Fa-f]{6}"/);
  });
});
