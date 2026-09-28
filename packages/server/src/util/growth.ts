/**
 * Growth events and mail records.
 *
 * The insert, its pool and its fire-and-forget contract live in
 * `@munhq/product-kit`, which every product in the fleet shares; see its
 * `growth.ts` for the reasons behind each rule. This module keeps the names
 * the server already calls, and makes every call a no-op on a build without
 * the kit, such as the public self-host image.
 */
import { productKit } from './product-kit.js';
import type { GrowthEvent, GrowthProps, MailSent } from '@munhq/product-kit';

export type { GrowthEvent, GrowthProps, MailSent };

/** Record one growth event. Returns at once; never throws. */
export function growth(event: GrowthEvent, props: GrowthProps = {}): void {
  try { productKit()?.growth(event, props); } catch { /* measurement never fails a request */ }
}

/** Record that a mail went out. */
export function recordMailSent(m: MailSent): void {
  try { productKit()?.recordMailSent(m); } catch { /* measurement never fails a request */ }
}

/** For `chat-recall doctor` and tests: is measurement on? */
export function growthEnabled(): boolean {
  return productKit()?.growthEnabled() ?? false;
}

/** Close the pool on shutdown. */
export async function closeGrowth(): Promise<void> {
  await productKit()?.closeGrowth();
}
