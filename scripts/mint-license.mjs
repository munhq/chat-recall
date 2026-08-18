#!/usr/bin/env node
/**
 * Mint a chat-recall licence key.
 *
 * Requires the issuer PRIVATE key, which lives outside the repo and must never
 * be committed. Default location ~/.chat-recall-issuer-key.pem, override with
 * CHAT_RECALL_ISSUER_KEY.
 *
 *   node scripts/mint-license.mjs "ACME GmbH"                # perpetual, team
 *   node scripts/mint-license.mjs "ACME GmbH" --months 12     # expires
 *   node scripts/mint-license.mjs "ACME GmbH" --note "INV-42"
 *
 * The customer sets the printed key as CHAT_RECALL_LICENSE on their server.
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const holder = args[0];
if (!holder) {
  console.error('usage: mint-license.mjs "<holder>" [--months N] [--note TEXT]');
  process.exit(1);
}
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
const months = Number(flag('--months')) || 0;
const note = flag('--note');

const keyPath = process.env.CHAT_RECALL_ISSUER_KEY || join(homedir(), '.chat-recall-issuer-key.pem');
let priv;
try {
  priv = createPrivateKey(readFileSync(keyPath));
} catch (e) {
  console.error(`cannot read issuer key at ${keyPath}: ${e.message}`);
  process.exit(1);
}

const iat = Math.floor(Date.now() / 1000);
const payload = { holder, features: ['team'], iat };
if (months > 0) payload.exp = iat + months * 30 * 24 * 3600;
if (note) payload.note = note;

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const seg = b64url(JSON.stringify(payload));
const key = `CR1.${seg}.${b64url(sign(null, Buffer.from(seg, 'utf8'), priv))}`;

console.log(`\nholder:   ${holder}`);
console.log(`features: ${payload.features.join(', ')}`);
console.log(`expires:  ${payload.exp ? new Date(payload.exp * 1000).toISOString().slice(0, 10) : 'never'}`);
console.log(`\nCHAT_RECALL_LICENSE=${key}\n`);
