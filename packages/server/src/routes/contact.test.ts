/**
 * The Enterprise/reseller enquiry route.
 *
 * It is the only anonymous, unauthenticated endpoint that SENDS MAIL, which
 * makes it the most abusable surface on the server. These tests pin the three
 * properties that keep it from becoming a spam relay or a silent black hole:
 * it validates, it never claims to have sent what it did not, and it answers a
 * browser with a redirect and an API caller with JSON.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const sent: Array<{ to: string; subject: string; text: string }> = [];
let configured = true;
let throws = false;

vi.mock('../auth/mailer.js', () => ({
  mailerConfigured: () => configured,
  sendMail: async (m: { to: string; subject: string; text: string }) => {
    if (throws) throw new Error('smtp exploded');
    sent.push(m);
    return { sent: true };
  },
}));

let app: Express;
beforeAll(async () => {
  const { default: contactRouter } = await import('./contact.js');
  app = express();
  app.use('/api/contact', contactRouter);
});
afterAll(() => { sent.length = 0; });

const good = { email: 'ada@example.com', message: 'We are 40 engineers and want to self-host.' };

describe('POST /api/contact', () => {
  test('a valid enquiry is delivered, as text only', async () => {
    sent.length = 0;
    const r = await request(app).post('/api/contact').type('form').send(good);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('ada@example.com');
    expect(sent[0].text).toContain('40 engineers');
    // Never HTML: nothing an anonymous sender writes may be interpreted.
    expect(sent[0]).not.toHaveProperty('html');
  });

  test('a bad address is refused and sends nothing', async () => {
    sent.length = 0;
    for (const email of ['', 'not-an-email', 'a@b', 'a b@c.com']) {
      const r = await request(app).post('/api/contact').type('form').send({ ...good, email });
      expect(r.status, email).toBe(400);
    }
    expect(sent).toHaveLength(0);
  });

  test('an empty message is refused — an enquiry with no content is not a lead', async () => {
    sent.length = 0;
    const r = await request(app).post('/api/contact').type('form').send({ ...good, message: 'hi' });
    expect(r.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  test('the honeypot answers 200 but sends nothing', async () => {
    // 200 on purpose: a bot that can tell it was caught retries differently.
    sent.length = 0;
    const r = await request(app).post('/api/contact').type('form')
      .send({ ...good, website: 'http://spam.example' });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  test('an unconfigured mailer FAILS instead of pretending', async () => {
    // The worst outcome is a sender who believes they contacted you.
    sent.length = 0; configured = false;
    const r = await request(app).post('/api/contact').type('form').send(good);
    configured = true;
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test('a throwing mailer is caught and reported, not a 500 stack', async () => {
    sent.length = 0; throws = true;
    const r = await request(app).post('/api/contact').type('form').send(good);
    throws = false;
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });

  test('a browser gets a redirect; an API caller gets JSON', async () => {
    const html = await request(app).post('/api/contact').type('form')
      .set('accept', 'text/html').send(good);
    expect(html.status).toBe(303);
    expect(html.headers.location).toContain('sent=1');

    const json = await request(app).post('/api/contact').type('form').send(good);
    expect(json.status).toBe(200);
    expect(json.body.ok).toBe(true);
  });

  test('oversized fields are clipped, not rejected outright', async () => {
    sent.length = 0;
    const r = await request(app).post('/api/contact').type('form')
      .send({ ...good, message: 'x'.repeat(20_000), company: 'y'.repeat(1000) });
    expect(r.status).toBe(200);
    expect(sent[0].text.length).toBeLessThan(6000);
  });
});
