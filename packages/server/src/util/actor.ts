import type express from 'express';

/** The user a request acts for: the real user sub, else the userId. */
export function actor(req: express.Request): string {
  return (req.authorSub || req.userId || 'unknown') as string;
}
