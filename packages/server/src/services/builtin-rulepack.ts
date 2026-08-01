/**
 * The curated redaction rule pack chat-recall ships to every tenant.
 *
 * GENERATED FILE — regenerate with `node scripts/gen-builtin-rulepack.mjs`.
 * Do not hand-edit the rule list; change the generator's selection rules instead.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * Detection has to run on the CLIENT: the server only ever receives text that
 * has already been redacted, so it cannot find what the client missed. But the
 * RULES do not have to ship with the client. They are served from here, pulled
 * at the start of every sync, and compiled in-process — so a shape discovered
 * on a Tuesday protects every customer on that Tuesday, with no CLI release, no
 * install, and no dependence on what the user happens to have on their PATH.
 *
 * Until this existed the mechanism was real but empty: a fresh tenant's rule
 * pack was literally `version: "empty"`, and improving coverage meant asking
 * each customer to hand-write regex in the dashboard. That is not a product.
 *
 * ── Provenance ───────────────────────────────────────────────────────────
 * Ported from the gitleaks default rule corpus (v8.30.1, MIT,
 * Copyright (c) 2019 Zachary Rice — https://github.com/gitleaks/gitleaks).
 * Upstream rule ids are preserved so `pack:twitter-api-key` can be looked up
 * against the upstream definition. MIT permits this; trufflehog's detectors are
 * AGPL-3.0 and are deliberately NOT represented here.
 *
 * Only VENDOR-ANCHORED rules were taken. gitleaks' entropy-gated generic rules
 * (130 of them) were dropped wholesale: without its Shannon-entropy
 * thresholds and per-rule allowlists they match ordinary tokens, and a false
 * positive in a redactor does not produce a noisy report — it silently destroys
 * the user's own content.
 *
 * Each pattern also has gitleaks' leading `[\w.-]{0,50}?` removed. RE2 is
 * linear; JavaScript backtracks, and that lazy prefix forces a match attempt at
 * every position — measured at 60x the builtin cost (0.6 MB/s) with it, 2x
 * (17 MB/s) without, on a 2.1MB real transcript. It only existed so gitleaks
 * could report the variable name beside the secret; removing it cannot lose a
 * detection.
 *
 * Also excluded, deliberately:
 *   kubernetes-secret-yaml         matches any k8s manifest data: block — shreds ordinary config pastes
 *   asana-client-id                public identifier, not a credential
 *   bitbucket-client-id            public identifier, not a credential
 *   looker-client-id               public identifier, not a credential
 *   messagebird-client-id          public identifier, not a credential
 *   sendbird-access-id             public identifier, not a credential
 *   new-relic-user-api-id          public identifier, not a credential
 *   new-relic-browser-api-token    shipped in browser bundles — public by design
 *   mailgun-pub-key                publishable key — public by design
 *   lob-pub-api-key                publishable key — public by design
 *   private-key                    covered by builtin private-key
 *   anthropic-api-key              covered by builtin anthropic-key (broader)
 *
 * ── Contract ─────────────────────────────────────────────────────────────
 * ADD-ONLY relative to the client's compiled-in builtins: a pack can make a
 * client redact more, never less (see installServerRulePack). Every rule is
 * validated on both ends — here at serve time, and again on the client, which
 * drops any individual rule that fails and logs it.
 */

import { validateRedactionRule } from '@chat-recall/engine/core/secret-redactor.js';
import { createHash } from 'node:crypto';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('builtin-rulepack');

export interface BuiltinPackRule {
  name: string;
  regex: string;
  flags?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

/** Human-readable revision of this list. The wire version clients see is a
 *  content hash that also folds in the tenant's own redact rules. */
export const BUILTIN_RULEPACK_REVISION = '2026-08-01';

/** Upstream corpus this was ported from — for attribution, and for diffing on
 *  the next re-port. */
export const BUILTIN_RULEPACK_SOURCE = 'gitleaks v8.30.1 (MIT)';

const RULES: BuiltinPackRule[] = [
  { name: 'adafruit-api-key', regex: '(?:adafruit)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9_-]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'age-secret-key', regex: 'AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}', severity: 'high' },
  { name: 'airtable-api-key', regex: '(?:airtable)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{17})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'algolia-api-key', regex: '(?:algolia)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'anthropic-admin-api-key', regex: '\\b(sk-ant-admin01-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60\'"\\s;]|\\\\[nr]|$)', severity: 'medium' },
  { name: 'asana-client-secret', regex: '(?:asana)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'high' },
  { name: 'beamer-api-token', regex: '(?:beamer)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(b_[a-z0-9=_\\-]{44})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'bitbucket-client-secret', regex: '(?:bitbucket)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'high' },
  { name: 'bittrex-access-key', regex: '(?:bittrex)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'bittrex-secret-key', regex: '(?:bittrex)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'high' },
  { name: 'codecov-access-token', regex: '(?:codecov)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'coinbase-access-token', regex: '(?:coinbase)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9_-]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'confluent-access-token', regex: '(?:confluent)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{16})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'confluent-secret-key', regex: '(?:confluent)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'high' },
  { name: 'contentful-delivery-api-token', regex: '(?:contentful)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{43})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'datadog-access-token', regex: '(?:datadog)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'defined-networking-api-token', regex: '(?:dnkey)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(dnkey-[a-z0-9=_\\-]{26}-[a-z0-9=_\\-]{52})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'digitalocean-refresh-token', regex: '\\b(dor_v1_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'discord-api-token', regex: '(?:discord)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'droneci-access-token', regex: '(?:droneci)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'dropbox-api-token', regex: '(?:dropbox)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{15})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'dropbox-long-lived-api-token', regex: '(?:dropbox)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{11}(AAAAAAAAAA)[a-z0-9\\-_=]{43})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'dropbox-short-lived-api-token', regex: '(?:dropbox)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(sl\\.[a-z0-9\\-=_]{135})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'fastly-api-token', regex: '(?:fastly)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'finicity-api-token', regex: '(?:finicity)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'finicity-client-secret', regex: '(?:finicity)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{20})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'high' },
  { name: 'finnhub-access-token', regex: '(?:finnhub)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{20})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'flickr-access-token', regex: '(?:flickr)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'freemius-secret-key', regex: '["\']secret_key["\']\\s*=>\\s*["\'](sk_[\\S]{29})["\']', flags: 'i', severity: 'high' },
  { name: 'freshbooks-access-token', regex: '(?:freshbooks)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'gitter-access-token', regex: '(?:gitter)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9_-]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'heroku-api-key', regex: '(?:heroku)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'hubspot-api-key', regex: '(?:hubspot)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'intercom-api-key', regex: '(?:intercom)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{60})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'jfrog-api-key', regex: '(?:jfrog|artifactory|bintray|xray)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{73})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'jfrog-identity-token', regex: '(?:jfrog|artifactory|bintray|xray)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'kraken-access-token', regex: '(?:kraken)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9\\/=_\\+\\-]{80,90})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'kucoin-access-token', regex: '(?:kucoin)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{24})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'kucoin-secret-key', regex: '(?:kucoin)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'high' },
  { name: 'launchdarkly-access-token', regex: '(?:launchdarkly)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'lob-api-key', regex: '(?:lob)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}((live|test)_[a-f0-9]{35})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'looker-client-secret', regex: '(?:looker)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{24})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'high' },
  { name: 'mailchimp-api-key', regex: '(?:MailchimpSDK.initialize|mailchimp)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{32}-us\\d\\d)(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'mailgun-private-api-token', regex: '(?:mailgun)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(key-[a-f0-9]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'high' },
  { name: 'mailgun-signing-key', regex: '(?:mailgun)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-h0-9]{32}-[a-h0-9]{8}-[a-h0-9]{8})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'mapbox-api-token', regex: '(?:mapbox)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(pk\\.[a-z0-9]{60}\\.[a-z0-9]{22})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'mattermost-access-token', regex: '(?:mattermost)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{26})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'messagebird-api-token', regex: '(?:message[_-]?bird)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{25})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'microsoft-teams-webhook', regex: 'https://[a-z0-9]+\\.webhook\\.office\\.com/webhookb2/[a-z0-9]{8}-([a-z0-9]{4}-){3}[a-z0-9]{12}@[a-z0-9]{8}-([a-z0-9]{4}-){3}[a-z0-9]{12}/IncomingWebhook/[a-z0-9]{32}/[a-z0-9]{8}-([a-z0-9]{4}-){3}[a-z0-9]{12}', severity: 'medium' },
  { name: 'netlify-access-token', regex: '(?:netlify)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{40,46})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'new-relic-insert-key', regex: '(?:new-relic|newrelic|new_relic)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(NRII-[a-z0-9-]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'new-relic-user-api-key', regex: '(?:new-relic|newrelic|new_relic)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(NRAK-[a-z0-9]{27})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'nytimes-access-token', regex: '(?:nytimes|new-york-times,|newyorktimes)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9=_\\-]{32})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'plaid-api-token', regex: '(?:plaid)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(access-(?:sandbox|development|production)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'rapidapi-access-token', regex: '(?:rapidapi)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9_-]{50})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'sendbird-access-token', regex: '(?:sendbird)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'sidekiq-secret', regex: '(?:BUNDLE_ENTERPRISE__CONTRIBSYS__COM|BUNDLE_GEMS__CONTRIBSYS__COM)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-f0-9]{8}:[a-f0-9]{8})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'high' },
  { name: 'sidekiq-sensitive-url', regex: '\\bhttps?://([a-f0-9]{8}:[a-f0-9]{8})@(?:gems.contribsys.com|enterprise.contribsys.com)(?:[\\/|\\#|\\?|:]|$)', flags: 'i', severity: 'medium' },
  { name: 'slack-webhook-url', regex: '(?:https?://)?hooks.slack.com/(?:services|workflows|triggers)/[A-Za-z0-9+/]{43,56}', severity: 'medium' },
  { name: 'snyk-api-token', regex: '(?:snyk[_.-]?(?:(?:api|oauth)[_.-]?)?(?:key|token))(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'sonar-api-token', regex: '(?:sonar[_.-]?(login|token))(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}((?:squ_|sqp_|sqa_)?[a-z0-9=_\\-]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'squarespace-access-token', regex: '(?:squarespace)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'travisci-access-token', regex: '(?:travis)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{22})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'twitch-api-token', regex: '(?:twitch)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{30})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'twitter-access-secret', regex: '(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{45})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'high' },
  { name: 'twitter-access-token', regex: '(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([0-9]{15,25}-[a-zA-Z0-9]{20,40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'twitter-api-key', regex: '(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{25})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'twitter-api-secret', regex: '(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{50})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'high' },
  { name: 'twitter-bearer-token', regex: '(?:twitter)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(A{22}[a-zA-Z0-9%]{80,100})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'typeform-api-token', regex: '(?:typeform)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(tfp_[a-z0-9\\-_\\.=]{59})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'yandex-access-token', regex: '(?:yandex)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(t1\\.[A-Z0-9a-z_-]+[=]{0,2}\\.[A-Z0-9a-z_-]{86}[=]{0,2})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'yandex-api-key', regex: '(?:yandex)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(AQVN[A-Za-z0-9_\\-]{35,38})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'yandex-aws-access-token', regex: '(?:yandex)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}(YC[a-zA-Z0-9_\\-]{38})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'medium' },
  { name: 'zendesk-secret-key', regex: '(?:zendesk)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60\'"\\s=]{0,5}([a-z0-9]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)', flags: 'i', severity: 'high' },
];

/** The list as generated, BEFORE serve-time validation. Exposed so a test can
 *  assert that validation drops nothing: comparing against the filtered list
 *  would be a tautology, and that is precisely how a rule using RE2-only syntax
 *  once reached production and was dropped by every consumer. */
export function _rawBuiltinPackRules(): BuiltinPackRule[] { return RULES; }

let validated: BuiltinPackRule[] | null = null;

/**
 * The pack as served — every rule re-validated through the SAME check the
 * client applies. A rule that the client would drop must not be advertised
 * here: that reads as coverage the operator does not actually have. A rejection
 * is logged at error level because it means this file is wrong.
 */
export function builtinPackRules(): BuiltinPackRule[] {
  if (validated) return validated;
  const ok: BuiltinPackRule[] = [];
  for (const r of RULES) {
    const v = validateRedactionRule({ name: r.name, regex: r.regex, flags: r.flags });
    if (v.ok) ok.push(r);
    else log.error({ rule: r.name, reason: v.reason }, 'builtin pack rule rejected — it will not be served');
  }
  validated = ok;
  return ok;
}

/** Content hash of the served pack, so a client can skip an unchanged pack and
 *  an operator can answer "which rules was that device running?". */
export function builtinPackHash(): string {
  const material = builtinPackRules()
    .map((r) => `${r.name} ${r.regex} ${r.flags || ''}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

/** Test seam. */
export function _resetBuiltinPackCache(): void { validated = null; }
