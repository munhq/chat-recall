// Boot the globally installed chat-recall-mcp and assert it doesn't crash.
// Plain `timeout` is GNU-only — absent on macOS runners and wrong-semantics
// in Git bash on Windows — so the survive-5s check lives here instead.
// Pass: the server survives 5s, or exits 0 after stdin closes.
// Fail: it exits nonzero (e.g. crashes on import) or can't be spawned.
const { spawn } = require('node:child_process');

const child = spawn('chat-recall-mcp', [], {
  stdio: ['pipe', 'ignore', 'inherit'],
  shell: process.platform === 'win32', // resolve the npm .cmd shim
});

const timer = setTimeout(() => {
  console.log('MCP survived 5s — boot OK');
  child.kill();
  process.exit(0);
}, 5000);

child.on('error', (err) => {
  console.error('MCP failed to spawn:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (code === 0) {
    console.log('MCP exited cleanly on stdin close — boot OK');
    process.exit(0);
  }
  console.error(`MCP crashed: exit ${code ?? signal}`);
  process.exit(1);
});

child.stdin.end('');
