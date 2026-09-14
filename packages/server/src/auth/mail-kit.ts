/**
 * The seam between this server and `@munhq/mailkit`.
 *
 * Mail is a hosted-service feature. The renderer and every word it renders live
 * in a private package, because this repository is public and the copy used to
 * be readable in it. The self-host image installs with `--omit=optional` and
 * never fetches that package, so everything here has to work when it is absent:
 * the load is dynamic, the failure is one log line, and the server runs on
 * without a mailer.
 *
 * Nothing else in the server imports `@munhq/mailkit` directly. One seam means
 * one place that knows mail can be missing.
 */
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('mail-kit');

type Kit = typeof import('@munhq/mailkit');

let loaded: Kit | null | undefined;

/**
 * The kit, or null on a build that does not carry it.
 *
 * Resolved once. A missing package is the normal state of a self-host install,
 * so it is reported at info and never as an error.
 */
export async function mailkit(): Promise<Kit | null> {
  if (loaded !== undefined) return loaded;
  try {
    const kit = await import('@munhq/mailkit');
    kit.setLogger({
      info: (o, m) => log.info(o as object, m),
      warn: (o, m) => log.warn(o as object, m),
      error: (o, m) => log.error(o as object, m),
    });
    loaded = kit;
    log.info('mailkit loaded — this deployment can send mail');
  } catch {
    loaded = null;
    log.info('mailkit is not installed — this deployment sends no mail');
  }
  return loaded;
}

/** Can this deployment send mail at all? */
export async function canSendMail(): Promise<boolean> {
  const kit = await mailkit();
  return !!kit && kit.hasCopy();
}

/**
 * Install a kit directly. TESTS ONLY.
 *
 * The package is an optional dependency of a private repository, so a test run
 * does not have it and `vi.mock` cannot mock a module that is not on disk. A
 * route that composes mail still has to be testable, so the seam takes an
 * injection. Passing null puts it back to "this build has no mailer", which is
 * the other state worth testing.
 */
export function setMailkit(kit: Kit | null): void { loaded = kit; }
