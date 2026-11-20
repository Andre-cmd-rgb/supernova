#!/usr/bin/env node
// Pokes a running Supernova (or Chrome) started with --remote-debugging-port.
//   node tools/cdp.mjs [--port 9333] list
//   node tools/cdp.mjs [--port 9333] eval <url-substring> '<expression>'
// The expression may return a promise; the value comes back as JSON.

const argv = process.argv.slice(2);
let port = 9333;
if (argv[0] === '--port') { port = Number(argv[1]); argv.splice(0, 2); }
const [cmd, match, expr] = argv;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
if (cmd === 'list') {
  for (const t of list) console.log(`${t.type.padEnd(8)} ${t.url}`);
  process.exit(0);
}
if (cmd !== 'eval' || !expr) {
  console.error('usage: cdp.mjs [--port N] list | eval <url-substring> <expression>');
  process.exit(2);
}
const t = list.find((x) => x.type === 'page' && x.url.includes(match));
if (!t) { console.error(`no page matching ${match}`); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== 1) return;
  const r = m.result || {};
  if (r.exceptionDetails) console.error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
  else console.log(JSON.stringify(r.result ? r.result.value : null, null, 1));
  ws.close();
  process.exit(r.exceptionDetails ? 1 : 0);
};
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true } }));
