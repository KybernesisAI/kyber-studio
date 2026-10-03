#!/usr/bin/env node
// Drive the KYBER Studio dev build over the Chrome DevTools Protocol (launched with
// --remote-debugging-port=9333). Used by the orchestrator/workers to verify Studio as David.
//   node scripts/cdp-drive.mjs shot <out.png> | eval "<js>" | type "<text>"   (type = insert + Enter)
import { writeFileSync } from "node:fs";
const [cmd, arg] = process.argv.slice(2);
const port = process.env.CDP_PORT || "9333";
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("index.html"));
if (!page) throw new Error("no Studio page target on :" + port);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) pending.get(m.id)(m); };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => (ws.onopen = r));
if (cmd === "shot") { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(arg, Buffer.from(r.result.data, "base64")); console.log("saved", arg); }
else if (cmd === "type") {
  await send("Runtime.evaluate", { expression: 'document.querySelector("[contenteditable=true]").focus()' });
  await send("Input.insertText", { text: arg });
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  console.log("typed + enter");
} else if (cmd === "eval") { const r = await send("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true }); console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2)); }
else console.log("usage: cdp-drive.mjs shot <png> | eval <js> | type <text>");
ws.close();
