#!/usr/bin/env tsx
const base = 'http://localhost:5000/api/memory/item/plan/ok-then-you-do-flickering-sunset';
for (const path of ['', '/content']) {
  const url = base + path;
  const res = await fetch(url);
  const body = await res.text();
  console.log(`${url}  → ${res.status}  ${res.headers.get('content-type')}  ${body.length} bytes`);
  console.log('  body head:', body.slice(0, 220).replace(/\n/g, '\\n'));
  console.log();
}
