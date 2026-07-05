/**
 * Secret-classification knowledge — the single source of truth for "what
 * kind of credential is this, how bad is it, and where do I rotate it?"
 *
 * Pure and self-contained ON PURPOSE: it imports nothing, so it is safe to
 * consume from the Node server (SECURITY_TASKS.md generation) AND to bundle
 * into the browser client (the Security view) without dragging Node-only
 * engine deps into either boundary.
 *
 * Keyed off the (detector, rule) pair the scanner records. `rule` is the
 * detector's own rule id (e.g. gitleaks `aws-access-token`, secretlint
 * `@secretlint/secretlint-rule-aws`); classification is rule-driven so a new
 * detector emitting a known rule name is classified without code changes.
 */

export type SecretSeverity = 'critical' | 'high' | 'medium' | 'noise';

export interface SecretType {
  /** display label (e.g. "AWS Access Token") */
  label: string;
  /** plain-English impact — what does an attacker get with this? */
  impact: string;
  /** direct link to the issuer's rotation/management console */
  rotateUrl?: string;
  /** severity tier (drives sort + colour) */
  severity: SecretSeverity;
  /** brand glyph or emoji — kept simple, no extra deps */
  glyph: string;
}

/** Map a (detector, rule) pair to security-expert metadata. */
export function classifySecret(detector: string, rule: string): SecretType {
  const r = (rule || '').toLowerCase();
  // ── CRITICAL: full-account or root-equivalent credentials ─────
  if (r.includes('private-key') || r.includes('rsa') || r === 'ssh' || r.includes('ssh')) {
    return { label: 'Private key (SSH/RSA)', severity: 'critical', glyph: '🔑',
      impact: 'Full server access wherever this key is authorized. Treat as root credential.',
      rotateUrl: undefined };
  }
  if (r === 'aws-session-token' || r.includes('aws-session') || r === 'awssessionkey') {
    return { label: 'AWS session token', severity: 'critical', glyph: '☁️',
      impact: 'Temporary AWS session credentials — same blast radius as an access key until they expire. Invalidate the session and rotate the underlying access key.',
      rotateUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials' };
  }
  if (r === 'aws-access-token' || r === 'aws' || (r.includes('aws') && r.includes('secret'))) {
    return { label: 'AWS access key', severity: 'critical', glyph: '☁️',
      impact: 'Programmatic AWS access — IAM, S3, EC2, billing. Active keys can spin up paid resources or read every S3 bucket.',
      rotateUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials' };
  }
  if (r.includes('kucoin')) {
    return { label: 'KuCoin exchange API key', severity: 'critical', glyph: '💱',
      impact: 'Exchange API key — depending on its scope it can place trades or withdraw funds. Financial impact; revoke immediately.',
      rotateUrl: 'https://www.kucoin.com/account/api' };
  }
  // ── HIGH: named live-service tokens ───────────────────────────
  if (r.includes('github')) {
    return { label: 'GitHub token', severity: 'high', glyph: '🐙',
      impact: 'Repo read/write, workflow trigger, package publish. Scope depends on token type but classic PATs are usually broad.',
      rotateUrl: 'https://github.com/settings/tokens' };
  }
  if (r === 'gitlab' || r.includes('gitlab-pat')) {
    return { label: 'GitLab token', severity: 'high', glyph: '🦊',
      impact: 'GitLab repo and CI access.',
      rotateUrl: 'https://gitlab.com/-/profile/personal_access_tokens' };
  }
  if (r === 'jwt' || r === 'JWT'.toLowerCase()) {
    return { label: 'JWT', severity: 'high', glyph: '🎫',
      impact: 'Bearer token — whatever permissions the issuing service granted. Rotate the signing key on the issuer side.',
      rotateUrl: undefined };
  }
  if (r.includes('slack')) {
    return { label: 'Slack token / webhook', severity: 'high', glyph: '💬',
      impact: 'Read messages, post as bot/user, exfiltrate channel content.',
      rotateUrl: 'https://api.slack.com/apps' };
  }
  if (r.includes('telegram')) {
    return { label: 'Telegram bot token', severity: 'high', glyph: '📨',
      impact: 'Full control of the bot: read and send messages in every chat it belongs to. Rotate via @BotFather → /revoke.',
      rotateUrl: undefined };
  }
  if (r.includes('atlassian') || r.includes('jira') || r.includes('confluence')) {
    return { label: 'Atlassian (Jira/Confluence) API token', severity: 'high', glyph: '🧩',
      impact: 'Read/write to your Atlassian org — issues, pages, and (with admin scope) users.',
      rotateUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens' };
  }
  if (r.includes('juro')) {
    return { label: 'Juro API key', severity: 'high', glyph: '📝',
      impact: 'Access to your Juro contracts workspace — read/modify legal documents. Revoke in Juro settings.',
      rotateUrl: undefined };
  }
  if (r === 'gcp') {
    return { label: 'GCP service account key', severity: 'high', glyph: '🌥',
      impact: 'GCP project-level access scoped to the service account\'s roles. Often broad in practice.',
      rotateUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts' };
  }
  if (r === 'nvapi') {
    return { label: 'NVIDIA API key', severity: 'high', glyph: '🟩',
      impact: 'NVIDIA AI/build APIs. Quota theft and model access on your account.',
      rotateUrl: 'https://build.nvidia.com/' };
  }
  if (r === 'stripe' || r.includes('stripe')) {
    return { label: 'Stripe key', severity: 'critical', glyph: '💳',
      impact: 'Payment processing access — read customer data, issue charges/refunds. Live keys = financial impact.',
      rotateUrl: 'https://dashboard.stripe.com/apikeys' };
  }
  if (r.includes('basicauth')) {
    return { label: 'Basic auth credential', severity: 'high', glyph: '🔐',
      impact: 'Username + password embedded in a URL. Whatever the target service does, an attacker can do.',
      rotateUrl: undefined };
  }
  if (r === 'url-password' || r.includes('url-password')) {
    return { label: 'Credential in URL', severity: 'high', glyph: '🔗',
      impact: 'A username/password embedded in a URL — full access to whatever that URL points at (DB, registry, API). Rotate the account credential and scrub it from configs.',
      rotateUrl: undefined };
  }
  if (r === 'env-secret' || r.includes('env-secret')) {
    return { label: 'Environment secret', severity: 'high', glyph: '🗝',
      impact: 'A secret (API key / token / password) captured from an environment variable or .env assignment. Identify which service it belongs to and rotate it there.',
      rotateUrl: undefined };
  }
  // ── MEDIUM: connection strings, often legit examples ──────────
  if (r === 'postgres' || r.includes('database-connection-string') || r === 'jdbc') {
    return { label: 'Database connection string', severity: 'medium', glyph: '🛢',
      impact: 'Direct DB access (read + write). Can be a real production string OR a dev/example one — verify before action.',
      rotateUrl: undefined };
  }
  if (r === 'infura' || r === 'polygon' || r === 'alchemy') {
    return { label: 'Blockchain RPC key', severity: 'medium', glyph: '⛓',
      impact: 'RPC quota theft + read-only chain queries on your billing account.',
      rotateUrl: 'https://app.infura.io/' };
  }
  if (r === 'secret-context' || r.includes('secret-context')) {
    return { label: 'Context-flagged value', severity: 'medium', glyph: '🔎',
      impact: 'A value sitting next to a "key/token/secret/password" keyword — flagged by proximity, not by a known key shape. Verify whether it is a real credential before acting.',
      rotateUrl: undefined };
  }
  // ── NOISE: fuzzy detectors confirmed FP-prone on chat content ─
  if (r === 'generic-api-key' || r === 'curl-auth-header' || r === 'uri'
   || r === 'box' || r === 'dockerhub' || r === 'npmtoken'
   || r === 'shortcut' || r === 'privacy' || r === 'miro') {
    return { label: rule, severity: 'noise', glyph: '◇',
      impact: 'Fuzzy regex match — likely false positive on UUIDs, base64 blobs, or hex hashes in chat content.' };
  }
  return { label: rule, severity: 'medium', glyph: '◇',
    impact: 'Detected by the named rule. Manually verify whether the matched text is a real credential.' };
}

export function secretSeverityRank(s: SecretSeverity): number {
  return s === 'critical' ? 0 : s === 'high' ? 1 : s === 'medium' ? 2 : 3;
}
