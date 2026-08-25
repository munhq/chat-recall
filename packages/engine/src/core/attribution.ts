/**
 * Signup attribution — turn a referrer into a bucket you can count.
 *
 * WHY A CLOSED SET: the useful question is "did r/ClaudeAI produce paying users
 * or only traffic". Raw referrer strings cannot answer it — `reddit.com`,
 * `old.reddit.com`, `out.reddit.com`, `www.reddit.com` and the Android app's
 * `android-app://com.reddit.frontpage` are five rows for one channel, and the
 * long tail is unreadable. So every referrer collapses into one of the buckets
 * below, and anything unrecognised becomes `other` with the raw host kept next
 * to it in `tenants.signup_referrer`.
 *
 * FIRST TOUCH, NEVER LAST: the cookie this reads is written once on the
 * marketing site and never overwritten. Somebody who arrives from Reddit, reads
 * for two days and then types the domain directly was earned by Reddit. Last
 * touch would credit `direct` and quietly tell you that Reddit does not work.
 *
 * WHAT THIS CANNOT DO: a CLI install has no referrer and no cookie. npm download
 * counts include mirrors and CI. So `npm` here only ever means "arrived at the
 * site from npmjs.com" — never "installed from npm". For CLI-first products the
 * honest measurement is the activate event, not a source.
 */

/** The closed set. Adding a member is a deliberate act — see the note above. */
export const SIGNUP_SOURCES = [
  'reddit',
  'hn',
  'x',
  'github',
  'npm',
  'google',
  'bing',
  'duckduckgo',
  'discord',
  'youtube',
  'linkedin',
  'producthunt',
  'mcp-registry',
  'direct',
  'other',
] as const;

export type SignupSource = (typeof SIGNUP_SOURCES)[number];

/**
 * Host suffix → bucket. Ordered longest-suffix-first at match time, so
 * `news.ycombinator.com` cannot be captured by a shorter `ycombinator.com`
 * entry if one is ever added.
 */
const HOST_MAP: ReadonlyArray<readonly [string, SignupSource]> = [
  ['reddit.com', 'reddit'],
  ['redd.it', 'reddit'],
  ['com.reddit.frontpage', 'reddit'], // the Android app's android-app:// referrer
  ['news.ycombinator.com', 'hn'],
  ['hckrnews.com', 'hn'],
  ['x.com', 'x'],
  ['twitter.com', 'x'],
  ['t.co', 'x'],
  ['github.com', 'github'],
  ['github.io', 'github'],
  ['npmjs.com', 'npm'],
  ['npmjs.org', 'npm'],
  ['google.', 'google'], // google.com, google.co.uk, google.de …
  ['bing.com', 'bing'],
  ['duckduckgo.com', 'duckduckgo'],
  ['discord.com', 'discord'],
  ['discord.gg', 'discord'],
  ['discordapp.com', 'discord'],
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
  ['linkedin.com', 'linkedin'],
  ['lnkd.in', 'linkedin'],
  ['producthunt.com', 'producthunt'],
  ['registry.modelcontextprotocol.io', 'mcp-registry'],
  ['smithery.ai', 'mcp-registry'],
  ['glama.ai', 'mcp-registry'],
];

/** A `utm_source` value that names a bucket directly wins over the referrer. */
const UTM_MAP: Readonly<Record<string, SignupSource>> = {
  reddit: 'reddit',
  hn: 'hn',
  hackernews: 'hn',
  'hacker-news': 'hn',
  x: 'x',
  twitter: 'x',
  github: 'github',
  npm: 'npm',
  discord: 'discord',
  youtube: 'youtube',
  linkedin: 'linkedin',
  producthunt: 'producthunt',
  ph: 'producthunt',
  smithery: 'mcp-registry',
  glama: 'mcp-registry',
  mcp: 'mcp-registry',
};

/** What the marketing site writes into the `cr_src` cookie. */
export interface FirstTouch {
  /** referrer hostname, already stripped of scheme, port and path */
  r?: string;
  /** utm_source */
  u?: string;
  /** utm_campaign */
  c?: string;
  /** first-seen epoch ms */
  t?: number;
  /**
   * Anonymous id, minted by the page on first touch and also handed to the
   * analytics session. It is the join key between "a visitor arrived from
   * reddit.com" and "a tenant was created" — without it those are two unrelated
   * records and the only answerable question is a count, not a path.
   *
   * An id we issue, never a fingerprint we compute.
   */
  a?: string;
}

export interface Attribution {
  source: SignupSource;
  /** Raw referrer host, so a mis-bucketed row stays debuggable. */
  referrer: string | null;
  campaign: string | null;
  /** Joins this signup to the analytics session that preceded it. */
  anonId: string | null;
}

/** Strip a hostname down to something matchable. Never throws. */
function hostOf(raw: string): string {
  let h = raw.trim().toLowerCase();
  if (!h) return '';
  // Accept a bare host, a full URL, or an android-app:// referrer.
  h = h.replace(/^[a-z-]+:\/\//, '');
  h = h.split('/')[0]!;
  h = h.split('?')[0]!;
  h = h.split('#')[0]!;
  h = h.split('@').pop()!;   // strip any user:pass@
  h = h.split(':')[0]!;      // strip the port
  return h.replace(/^www\./, '');
}

/**
 * Bucket one first-touch record.
 *
 * Precedence: an explicit `utm_source` we recognise, then the referrer host,
 * then `direct`. utm wins because it is the only signal we set ourselves — a
 * link posted with `?utm_source=reddit` is a claim by us, while a referrer is a
 * claim by the browser, and browsers lie about referrers constantly (privacy
 * modes, `Referrer-Policy`, in-app webviews).
 */
export function classifyFirstTouch(ft: FirstTouch | null | undefined): Attribution {
  const campaign = ft?.c?.trim().slice(0, 120) || null;
  // Bounded and character-restricted: it reaches a SQL parameter and a join, so
  // a hostile value must not be able to be long or strange, only useless.
  const anonId = (ft?.a && /^[A-Za-z0-9-]{8,64}$/.test(ft.a)) ? ft.a : null;
  const rawHost = ft?.r ? hostOf(ft.r) : '';
  const referrer = rawHost || null;

  const utm = ft?.u?.trim().toLowerCase();
  if (utm && UTM_MAP[utm]) return { source: UTM_MAP[utm]!, referrer, campaign, anonId };

  if (!rawHost) return { source: 'direct', referrer: null, campaign, anonId };

  // Longest suffix first, so a future shorter entry cannot shadow a longer one.
  const ordered = [...HOST_MAP].sort((a, b) => b[0].length - a[0].length);
  for (const [needle, bucket] of ordered) {
    if (rawHost === needle || rawHost.endsWith(`.${needle}`) || rawHost.includes(needle)) {
      return { source: bucket, referrer, campaign, anonId };
    }
  }
  return { source: 'other', referrer, campaign, anonId };
}

/**
 * Parse the `cr_src` cookie value. Hostile input is normal here — this is a
 * value a browser sent us, so a malformed or oversized one must produce
 * `direct`, never an exception on the signup path.
 */
export function parseFirstTouchCookie(value: string | null | undefined): FirstTouch | null {
  if (!value) return null;
  if (value.length > 600) return null; // the writer caps at 300; anything larger is not ours
  try {
    const decoded = decodeURIComponent(value);
    const o = JSON.parse(decoded) as unknown;
    // Arrays are objects in JS, so `[1,2,3]` would otherwise pass this check
    // and yield an all-undefined record that reads as a valid first touch.
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const r = (o as FirstTouch).r, u = (o as FirstTouch).u, c = (o as FirstTouch).c, t = (o as FirstTouch).t;
    return {
      r: typeof r === 'string' ? r.slice(0, 253) : undefined,   // max DNS name length
      u: typeof u === 'string' ? u.slice(0, 60) : undefined,
      c: typeof c === 'string' ? c.slice(0, 120) : undefined,
      t: typeof t === 'number' && Number.isFinite(t) ? t : undefined,
      a: typeof (o as FirstTouch).a === 'string' ? (o as FirstTouch).a!.slice(0, 64) : undefined,
    };
  } catch {
    return null;
  }
}

/** Read `cr_src` out of a raw Cookie header. */
export function firstTouchFromCookieHeader(header: string | null | undefined): Attribution {
  if (!header) return { source: 'direct', referrer: null, campaign: null, anonId: null };
  const m = /(?:^|;\s*)cr_src=([^;]*)/.exec(header);
  return classifyFirstTouch(parseFirstTouchCookie(m?.[1]));
}
