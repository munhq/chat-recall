/**
 * Ambient types for `@munhq/mailkit`, which is an OPTIONAL dependency.
 *
 * The package is private and mail is a hosted-service feature, so the
 * self-host image installs with `--omit=optional` and never fetches it. This
 * declaration is what lets the server compile either way: a type is a schema,
 * not a word anybody reads, so it may live in a public repository while the
 * renderer and the copy do not.
 *
 * Every call site loads the package with a dynamic import and treats failure as
 * "this deployment does not send mail".
 */
declare module '@munhq/mailkit' {
  export type Block =
    | { kind: 'lead'; text: string }
    | { kind: 'p'; text: string }
    | { kind: 'code'; lines: string[] }
    | { kind: 'otp'; code: string }
    | { kind: 'quote'; text: string }
    | { kind: 'cta'; label: string; url: string }
    | { kind: 'links'; items: Array<{ label: string; url: string }> }
    | { kind: 'stats'; text: string; items: Array<{ value: string; label: string }> }
    | { kind: 'small'; text: string }
    | { kind: 'rule' };

  export interface Message {
    to: string;
    subject: string;
    preheader: string;
    blocks: Block[];
    footer?: Block[];
  }

  export type CopyVars = Record<string, string | number | undefined>;
  export type PackMessage = Message & { from?: string; replyTo?: string };

  export function compose(m: Message): { to: string; subject: string; text: string; html: string };
  export function copy(id: string, to: string, vars?: CopyVars): PackMessage | null;
  export function word(key: string, vars?: CopyVars): string;
  export function withFigures(m: PackMessage | null, figures: Array<{ value: string; label: string }>): PackMessage | null;
  export function withBlocks(m: PackMessage | null, extra: Block[], at?: 'start' | 'end'): PackMessage | null;
  export function hasCopy(): boolean;
  export function hasMessage(id: string): boolean;
  export function supportEmail(): string | null;
  export function reloadCopy(): void;
  export function setLogger(l: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void }): void;
}
