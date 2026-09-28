/**
 * Ambient types for `@munhq/product-kit`, which is an OPTIONAL dependency.
 *
 * The package is private, like `@munhq/mailkit`: the hosted image installs it,
 * and the self-host image (`npm ci --omit=optional`) does not. This declaration
 * lets the server compile either way. The server loads the package with a
 * dynamic import in util/product-kit.ts, and treats its absence as "no growth
 * events, and no mail from this build".
 */
declare module '@munhq/product-kit' {
  export type GrowthEvent = 'install' | 'activate' | 'convert' | 'funnel' | 'funnel_fail';
  export interface GrowthProps {
    tenant?: string | null;
    source?: string | null;
    campaign?: string | null;
    anonId?: string | null;
    extra?: Record<string, unknown>;
    oncePerDay?: boolean;
  }
  export interface MailSent {
    kind: string;
    recipient: string;
    tenant?: string | null;
    messageId?: string | null;
  }
  export interface Mail {
    to: string; subject: string; text: string; html?: string;
    from?: string; replyTo?: string; kind?: string;
  }
  export type SendResult =
    | { sent: true; messageId: string | null }
    | { sent: false; reason: 'no-mail' | 'no-smtp' | 'no-sender' | 'send-failed' };
  export interface Logger { debug(obj: object, msg: string): void }
  export interface MailLogger {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
  }

  export function growth(event: GrowthEvent, props?: GrowthProps): void;
  export function recordMailSent(m: MailSent): void;
  export function growthEnabled(): boolean;
  export function closeGrowth(): Promise<void>;
  export function setGrowthLogger(l: Logger): void;
  export function sendMail(mail: Mail | null | Promise<Mail | null>, meta?: { tenant?: string | null }): Promise<SendResult>;
  export function setMailLogger(l: MailLogger): void;
}

declare module '@munhq/product-kit/funnel' {
  import type { BetterAuthPlugin } from 'better-auth';
  export function funnel(): BetterAuthPlugin;
}

declare module '@munhq/product-kit/growth' {
  export { growth } from '@munhq/product-kit';
}
