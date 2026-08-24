/**
 * Strip inline credentials from anything about to be uploaded.
 *
 * ENV IS NOT THE ONLY PLACE SECRETS LIVE, and neither is a session transcript.
 * A Postgres MCP is configured as
 * `npx …/server-postgres postgres://user:PASSWORD@host/db` — the password is an
 * ARGUMENT. A skill file can paste an API key into an example command. Both are
 * uploaded, so both need the same pass.
 *
 * It keeps the shape and loses the value, so the artifact stays recognisable
 * and stays rebuildable once the user supplies the secret locally.
 *
 * This lives in one module because it is applied in four places (MCP commands,
 * MCP args, skill bodies, agent bodies) and four copies would be four things to
 * keep correct, with the rarest one rotting first.
 */
export function redactInlineSecrets(value: string): { text: string; redacted: boolean } {
  let redacted = false;
  let out = value;

  // scheme://user:password@host — the password, not the username.
  out = out.replace(/(\w+:\/\/[^:/@\s]+:)([^@\s]{1,512})(@)/g, (_m, head, _pw, tail) => {
    redacted = true;
    return `${head}__SECRET_NOT_SYNCED__${tail}`;
  });

  // Provider-shaped bearer tokens.
  const tokenShapes: RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,          // OpenAI-style
    /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,     // GitHub
    /\bAIza[0-9A-Za-z_-]{20,}\b/g,         // Google
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,   // Slack
  ];
  for (const re of tokenShapes) {
    out = out.replace(re, () => { redacted = true; return '__SECRET_NOT_SYNCED__'; });
  }
  return { text: out, redacted };
}
