/**
 * The instructions the MCP handshake gives every client.
 *
 * A client shows this text to its model whether or not the chat-recall skills
 * are installed or loaded. Agents that did not load the skill called the tools
 * from their one-line descriptions: they guessed line numbers for recall_show,
 * missed, and then read the raw transcript file.
 */
export const SERVER_INSTRUCTIONS = [
  'How to read past work with these tools:',
  '1. If your client has the chat-recall skill, load it before the first recall_* call.',
  '2. To find a past session, use recall_search or recall_memory_search.',
  '3. To find a message inside one session, call recall_show with query. It gives the line of each match.',
  '4. To read around a line, call recall_show with around_line. Use from_end for the newest messages, and expand_line for one message whole.',
  '5. If recall_show says that sync is behind, run recall_index and call recall_show again. Read the raw transcript file only if that fails.',
].join('\n');
