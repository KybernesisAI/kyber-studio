#!/usr/bin/env node
/**
 * Look at the running UAT window: visible text, buttons, placeholders, and a
 * screenshot. Read-only. For writing stories, not for running them.
 *
 *   node uat/peek.mjs [out.png] [js-expression]
 */
import { writeFileSync } from 'node:fs';
import { attachRenderer } from './cdp.mjs';
import { PORTS } from './config.mjs';

const [out, expr] = process.argv.slice(2);
const r = await attachRenderer(PORTS.renderer);
if (expr) {
  console.log(JSON.stringify(await r.evaluate(expr), null, 2));
} else {
  const info = await r.evaluate(`JSON.stringify({
    text: document.body.innerText.slice(0, 3000),
    buttons: [...document.querySelectorAll('button,[role=button]')].map(b => (b.textContent||'').trim() || ('[aria] ' + (b.getAttribute('aria-label')||b.title||''))).slice(0, 120),
    editable: [...document.querySelectorAll('[contenteditable=true],textarea,input')].map(e => e.tagName + ' ' + (e.placeholder||e.getAttribute('aria-label')||e.dataset.placeholder||'')),
  })`);
  console.log(JSON.stringify(JSON.parse(info), null, 2));
}
if (out) {
  const shot = await r.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('saved', out);
}
r.close();
