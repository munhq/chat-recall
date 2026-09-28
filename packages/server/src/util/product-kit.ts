/**
 * The seam between this server and `@munhq/product-kit`.
 *
 * The kit is the fleet's shared growth insert, mail transport with its
 * per-mail record, and auth funnel. It is a private package and an optional
 * dependency, like `@munhq/mailkit`: the hosted image installs it, and the
 * public self-host image (`npm ci --omit=optional`) does not. So everything
 * here works when it is absent: growth becomes a no-op, and mail reports that
 * this build cannot send.
 *
 * Loaded once at boot, before the auth instance is built, because the funnel is
 * a better-auth plugin and the plugin list is fixed when the instance is made.
 */
import { createLogger } from '@chat-recall/engine/core/logger.js';

const log = createLogger('product-kit');

type Kit = typeof import('@munhq/product-kit');
type FunnelModule = typeof import('@munhq/product-kit/funnel');

let kit: Kit | null = null;
let funnelModule: FunnelModule | null = null;
let loading: Promise<void> | null = null;

/** Load the kit. Safe to call more than once; later calls await the first. */
export function loadProductKit(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        kit = await import('@munhq/product-kit');
        kit.setGrowthLogger({ debug: (o, m) => log.debug(o, m) });
        kit.setMailLogger({
          info: (o, m) => log.info(o, m), warn: (o, m) => log.warn(o, m), error: (o, m) => log.error(o, m),
        });
        log.info({ measuring: kit.growthEnabled() }, 'product-kit loaded');
      } catch {
        kit = null;
        log.info('product-kit is not installed: no growth events, and no mail from this build');
      }
      try {
        funnelModule = await import('@munhq/product-kit/funnel');
      } catch {
        funnelModule = null;
      }
    })();
  }
  return loading;
}

/** The kit, or null on a build that does not carry it. */
export function productKit(): Kit | null { return kit; }

/** The funnel plugin module, or null. */
export function funnelKit(): FunnelModule | null { return funnelModule; }

/** TESTS ONLY: install a kit directly, or put back "not installed" with null. */
export function __setProductKit(k: Kit | null, f: FunnelModule | null = null): void {
  kit = k;
  funnelModule = f;
  loading = Promise.resolve();
}
