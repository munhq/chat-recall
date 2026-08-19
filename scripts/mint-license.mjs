#!/usr/bin/env node
/**
 * Mint a chat-recall licence key.
 *
 * Requires the issuer PRIVATE key, which lives outside the repo and must never
 * be committed. Default location ~/.chat-recall-issuer-key.pem, override with
 * CHAT_RECALL_ISSUER_KEY.
 *
 *   node scripts/mint-license.mjs "ACME GmbH" --seats 25            # 25 members
 *   node scripts/mint-license.mjs "ACME GmbH" --seats 25 --months 12 # annual
 *   node scripts/mint-license.mjs "ACME GmbH"                        # unlimited
 *   node scripts/mint-license.mjs "ACME GmbH" --note "INV-42"
 *   node scripts/mint-license.mjs "ACME Agency" --features team,findings,alerts \
 *     --seats 200 --months 12 --note "OEM-2026-001"                  # an OEM deal
 *
 * Omitting --seats issues a SITE licence (unlimited members). Do that
 * deliberately, not by forgetting the flag.
 *
 * Omitting --features issues 'team' only, which is what every key minted before
 * the feature set widened carried. Name features explicitly for anything else.
 *
 * A KEY DOES NOT GRANT THE RIGHT TO RESELL. ELv2's hosting ban is absolute and
 * unbuyable: a partner running chat-recall as a service for THEIR customers needs
 * a signed commercial agreement granting that exception. The key only turns
 * features on. Never send one without the agreement.
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
const seats = Number(flag('--seats')) || 0;
const note = flag('--note');
if (flag('--seats') !== undefined && !(seats > 0)) {
  console.error('--seats must be a positive integer');
  process.exit(1);
}

// Must match LicenseFeature in packages/server/src/util/license.ts. Validated
// here rather than accepted blindly: a typo'd feature in a SIGNED key is worse
// than a usage error, because it verifies, grants nothing, and looks like a bug in
// the product rather than in the key.
const LICENSABLE = ['sync', 'alerts', 'findings', 'insights', 'team', 'toolkit', 'sso', 'audit'];
const featuresArg = flag('--features');
const features = featuresArg
  ? featuresArg.split(',').map((f) => f.trim()).filter(Boolean)
  : ['team'];
const unknown = features.filter((f) => !LICENSABLE.includes(f));
if (unknown.length) {
  console.error(`unknown feature(s): ${unknown.join(', ')}`);
  console.error(`licensable: ${LICENSABLE.join(', ')}`);
  console.error("note: 'memory' and 'scan' are always free and cannot be licensed.");
  process.exit(1);
}

const keyPath = process.env.CHAT_RECALL_ISSUER_KEY || join(homedir(), '.chat-recall-issuer-key.pem');
let priv;
try {
  priv = createPrivateKey(readFileSync(keyPath));
} catch (e) {
  console.error(`cannot read issuer key at ${keyPath}: ${e.message}`);
  process.exit(1);
}

const iat = Math.floor(Date.now() / 1000);
const payload = { holder, features, iat };
if (months > 0) payload.exp = iat + months * 30 * 24 * 3600;
if (seats > 0) payload.seats = seats;
if (note) payload.note = note;

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const seg = b64url(JSON.stringify(payload));
const key = `CR1.${seg}.${b64url(sign(null, Buffer.from(seg, 'utf8'), priv))}`;

console.log(`\nholder:   ${holder}`);
console.log(`features: ${payload.features.join(', ')}`);
console.log(`seats:    ${payload.seats ?? 'unlimited (site licence)'}`);
console.log(`expires:  ${payload.exp ? new Date(payload.exp * 1000).toISOString().slice(0, 10) : 'never'}`);
console.log(`\nCHAT_RECALL_LICENSE=${key}\n`);
