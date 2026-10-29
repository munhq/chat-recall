/**
 * Ambient types for `@munhq/auth`, which is an OPTIONAL dependency.
 *
 * The package is private, like `@munhq/product-kit`: the hosted image installs
 * it, and the self-host image (`npm ci --omit=optional`) does not. This
 * declaration lets the server compile either way. util/auth-kit.ts loads the
 * package with a dynamic import, and auth/better-auth.ts builds the same
 * settings itself when it is absent. Only the parts the server uses are here.
 */
declare module '@munhq/auth' {
  import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';

  export interface MailBrand {
    name: string;
    url?: string;
    logo?: string;
    color?: string;
    supportEmail?: string;
  }

  export interface FleetAuthOptions {
    appName: string;
    database: BetterAuthOptions['database'];
    baseURL?: string;
    basePath?: string;
    secret?: string;
    trustedOrigins?: BetterAuthOptions['trustedOrigins'];
    brand?: Partial<MailBrand>;
    mailFrom?: string;
    verification?: 'code' | 'link';
    minPasswordLength?: number;
    resetCallbackPath?: string;
    extend?: Partial<BetterAuthOptions>;
  }

  export interface DeviceSettings {
    expiresIn: `${number}m`;
    interval: `${number}s`;
    verificationUri: string;
    validateClient: (id: string) => boolean;
  }

  export function fleetAuth(o: FleetAuthOptions): BetterAuthOptions;
  export function fleetEmailOTP(o?: { verifyOnSignUp?: boolean }): BetterAuthPlugin;
  export function fleetTwoFactor(issuer: string): { issuer: string };
  export function fleetDevice(clientId: string | undefined): DeviceSettings;
  export function fleetRateLimit(storage?: 'memory' | 'database'): NonNullable<BetterAuthOptions['rateLimit']>;
  export function isAdminEmail(email: string | null | undefined, admins?: readonly string[]): boolean;
  export function adminEmailsFromEnv(value?: string): string[];
  export function resetLinkFor(url: string, callbackPath: string): string;
}
