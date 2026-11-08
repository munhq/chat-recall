/**
 * `chat-recall-watch`. The login that the kit keeps in sealkeep is readable only in a process that `sealkeep run`
 * starts, so the daemon starts itself again under it before it loads anything. The indexer loads after that, in
 * the process that holds the token.
 */
import { adoptSealkeepSecrets } from '@chat-recall/engine/core/stored-token.js';

await adoptSealkeepSecrets();
await import('./indexer.js');
