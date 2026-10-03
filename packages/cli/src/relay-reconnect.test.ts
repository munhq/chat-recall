/**
 * A relay's session survives its daemon.
 *
 * THE FAILURE: when a daemon went away (an upgrade, a kill), each relay on it
 * exited, and the AI tool showed chat-recall as disconnected until a person
 * reconnected it. On 2026-10-02 stopping five stale daemons disconnected every
 * open session on the machine.
 */
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { Duplex } from 'node:stream';
import { resilientBridge, DAEMON_RESTART_ERROR } from './relay-lifecycle.js';

/** One end of an in-memory socket pair. */
function pair(): [Duplex, Duplex] {
  const a2b = new PassThrough();
  const b2a = new PassThrough();
  const a = Duplex.from({ readable: b2a, writable: a2b });
  const b = Duplex.from({ readable: a2b, writable: b2a });
  return [a, b];
}

/** A daemon connection that answers initialize and tools/call, except calls named "hang". */
function fakeDaemon(name: string) {
  const [relaySide, daemonSide] = pair();
  const seen: Array<{ id?: unknown; method?: string }> = [];
  // Destroying one end of the pair aborts the shared streams; a real daemon's
  // socket server handles that 'error', and so does this one.
  daemonSide.on('error', () => {});
  let rest = '';
  daemonSide.on('data', (d: Buffer) => {
    rest += d.toString();
    let nl;
    while ((nl = rest.indexOf('\n')) >= 0) {
      const m = JSON.parse(rest.slice(0, nl));
      rest = rest.slice(nl + 1);
      seen.push(m);
      if (m.method === 'initialize') daemonSide.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name } } }) + '\n');
      if (m.method === 'tools/call' && m.params?.name !== 'hang') {
        daemonSide.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { from: name } }) + '\n');
      }
    }
  });
  return { relaySide, daemonSide, seen, kill: () => daemonSide.destroy() };
}

function client() {
  const input = new PassThrough();
  const output = new PassThrough();
  const got: Array<Record<string, any>> = [];
  let rest = '';
  output.on('data', (d: Buffer) => {
    rest += d.toString();
    let nl;
    while ((nl = rest.indexOf('\n')) >= 0) { got.push(JSON.parse(rest.slice(0, nl))); rest = rest.slice(nl + 1); }
  });
  const send = (m: object) => input.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  return { input, output, got, send };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('resilientBridge', () => {
  it('THE FAILURE: a daemon that goes away is replaced, and the session goes on', async () => {
    const a = fakeDaemon('A');
    const b = fakeDaemon('B');
    const c = client();
    const exits: number[] = [];
    resilientBridge(c.input, c.output, a.relaySide, async () => b.relaySide, (code) => exits.push(code), { parentPollMs: 60_000 });

    c.send({ id: 0, method: 'initialize', params: {} });
    c.send({ method: 'notifications/initialized' });
    c.send({ id: 1, method: 'tools/call', params: { name: 'search' } });
    c.send({ id: 2, method: 'tools/call', params: { name: 'hang' } });
    await tick();
    expect(c.got.map((m) => m.id)).toEqual([0, 1]);

    a.kill();
    await tick();
    // The call that was running gets an error that says to call again.
    expect(c.got[2]).toEqual({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: DAEMON_RESTART_ERROR } });
    // The new daemon got the handshake, and the client did not see its reply.
    expect(b.seen.map((m) => m.method)).toEqual(['initialize', 'notifications/initialized']);
    expect(c.got).toHaveLength(3);

    c.send({ id: 3, method: 'tools/call', params: { name: 'search' } });
    await tick();
    expect(c.got[3]).toEqual({ jsonrpc: '2.0', id: 3, result: { from: 'B' } });
    expect(exits).toEqual([]);
  });

  it('a call sent while the relay reconnects is held, then delivered', async () => {
    const a = fakeDaemon('A');
    const b = fakeDaemon('B');
    const c = client();
    let release!: (d: Duplex) => void;
    const later = new Promise<Duplex>((r) => { release = r; });
    resilientBridge(c.input, c.output, a.relaySide, () => later, () => {}, { parentPollMs: 60_000 });
    c.send({ id: 0, method: 'initialize', params: {} });
    await tick();
    a.kill();
    await tick();
    c.send({ id: 5, method: 'tools/call', params: { name: 'search' } });
    await tick();
    release(b.relaySide);
    await tick();
    expect(b.seen.map((m) => m.id ?? m.method)).toEqual([0, 5]);
    expect(c.got.at(-1)).toEqual({ jsonrpc: '2.0', id: 5, result: { from: 'B' } });
  });

  it('no daemon to reach again ends the session with a failure code', async () => {
    const a = fakeDaemon('A');
    const c = client();
    const exits: number[] = [];
    resilientBridge(c.input, c.output, a.relaySide, async () => null, (code) => exits.push(code), { parentPollMs: 60_000 });
    a.kill();
    await tick();
    expect(exits).toEqual([1]);
  });

  it('the client closing its input ends the session normally', async () => {
    const a = fakeDaemon('A');
    const c = client();
    const exits: number[] = [];
    let reconnects = 0;
    resilientBridge(c.input, c.output, a.relaySide, async () => { reconnects++; return null; }, (code) => exits.push(code), { parentPollMs: 60_000, drainMs: 50 });
    c.input.end();
    await tick(100);
    expect(exits).toEqual([0]);
    expect(reconnects).toBe(0);
  });
});
