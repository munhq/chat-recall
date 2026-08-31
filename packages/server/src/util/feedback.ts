/**
 * Storing what people say, so it can be counted rather than only replied to.
 *
 * Two routes write here: the pricing page's enquiry form, and the CLI's
 * `feedback` command. Both used to end at an inbox, which meant a sentence like
 * "I could not work out what this does" existed only in a mail thread — not
 * countable, not joinable to whether that person later signed up, and not
 * findable six weeks later when it would have explained everything.
 *
 * NEVER THROWS. Feedback is the one thing a user offers voluntarily, and losing
 * their submission because a database is briefly unavailable is worse than
 * losing the row: they will not type it twice. The caller sends the mail
 * regardless, so a failure here degrades a record, never a reply.
 */
import { openPgPool } from '@chat-recall/engine/core/store/pg-pool.js';
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('feedback');

export interface FeedbackInput {
  /** 'contact' for the web form, 'cli' for the terminal command. */
  source: 'contact' | 'cli';
  topic?: string | null;
  email?: string | null;
  company?: string | null;
  message: string;
  /** Set only when the sender was authenticated; anonymous is the normal case. */
  tenant?: string | null;
  cliVersion?: string | null;
  os?: string | null;
}

/** Store one message. Returns its id, or null if it could not be stored. */
export async function storeFeedback(input: FeedbackInput): Promise<number | null> {
  try {
    // The pool directly, not tenantQuery: `feedback` carries no tenant column
    // and is not RLS-walled, because most of what lands here comes from people
    // who have no account — which is exactly the population worth hearing from.
    const pool = await openPgPool(process.env.DATABASE_URL || '');
    const { rows } = await pool.query(
        `INSERT INTO feedback (created_at, source, topic, email, company, message,
                               tenant, cli_version, os)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          Date.now(),
          input.source,
          input.topic ?? null,
          input.email ?? null,
          input.company ?? null,
          input.message,
          input.tenant ?? null,
          input.cliVersion ?? null,
          input.os ?? null,
        ],
    );
    return rows[0] ? Number(rows[0].id) : null;
  } catch (err) {
    log.error({ err, source: input.source }, 'feedback could not be stored');
    return null;
  }
}

/**
 * Mark that the notification went out.
 *
 * A row left at `mailed = false` is one nobody was told about — somebody has to
 * open it by hand. That distinction is the whole reason the flag exists rather
 * than assuming delivery.
 */
export async function markFeedbackMailed(id: number): Promise<void> {
  try {
    const pool = await openPgPool(process.env.DATABASE_URL || '');
    await pool.query('UPDATE feedback SET mailed = true WHERE id = $1', [id]);
  } catch (err) {
    log.debug({ err, id }, 'could not mark feedback as mailed');
  }
}
