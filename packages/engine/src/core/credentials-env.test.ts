/**
 * The container path. Without env credentials the MCP server starts inside
 * Glama's or Docker's sandbox, finds no credentials.json, and answers every
 * tool call with "run `chat-recall login` first" — which reads as a broken
 * server to anyone evaluating it.
 */
import { describe, test, expect } from 'vitest';
import { envCredentials } from './credentials-env.js';

describe('envCredentials', () => {
  test('both variables present is a credential', () => {
    expect(envCredentials({ CHAT_RECALL_SERVER: 'https://chatrecall.dev', CHAT_RECALL_TOKEN: 'tok_1' }))
      .toEqual({ serverUrl: 'https://chatrecall.dev', token: 'tok_1' });
  });

  test('a trailing slash is stripped, so base + path never doubles it', () => {
    expect(envCredentials({ CHAT_RECALL_SERVER: 'https://chatrecall.dev///', CHAT_RECALL_TOKEN: 't' })?.serverUrl)
      .toBe('https://chatrecall.dev');
  });

  test('a server alone keeps its older meaning and is NOT a credential', () => {
    // CHAT_RECALL_SERVER already selects between logged-in targets. Treating it
    // as a login would re-point an existing session at a server it never
    // authenticated to.
    expect(envCredentials({ CHAT_RECALL_SERVER: 'https://chatrecall.dev' })).toBeNull();
  });

  test('a token alone has nowhere to go', () => {
    expect(envCredentials({ CHAT_RECALL_TOKEN: 'tok_1' })).toBeNull();
  });

  test('blank and whitespace values are absent, not empty credentials', () => {
    expect(envCredentials({ CHAT_RECALL_SERVER: '  ', CHAT_RECALL_TOKEN: 'tok' })).toBeNull();
    expect(envCredentials({ CHAT_RECALL_SERVER: 'https://x.dev', CHAT_RECALL_TOKEN: '   ' })).toBeNull();
  });

  test('a bare hostname is a config mistake, not a base URL', () => {
    expect(envCredentials({ CHAT_RECALL_SERVER: 'chatrecall.dev', CHAT_RECALL_TOKEN: 'tok' })).toBeNull();
  });

  test('http is accepted — a self-hoster on a LAN has no certificate', () => {
    expect(envCredentials({ CHAT_RECALL_SERVER: 'http://192.168.1.10:5000', CHAT_RECALL_TOKEN: 'tok' })?.serverUrl)
      .toBe('http://192.168.1.10:5000');
  });

  test('an empty environment reads as no credential', () => {
    expect(envCredentials({})).toBeNull();
  });
});
