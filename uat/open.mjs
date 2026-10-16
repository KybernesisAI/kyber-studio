#!/usr/bin/env node
/**
 * Open the UAT build in the isolated home and leave it running — for signing
 * in once, and for looking around while writing stories. Ctrl-C stops exactly
 * the tree this script started.
 *
 *   node uat/open.mjs
 */
import { execSync } from 'node:child_process';
import * as config from './config.mjs';

const { home, notes } = config.makeHome();
console.log(`isolated home: ${home}`);
for (const n of notes) console.log(`  ${n}`);
const app = config.launchApp(home);
console.log(`app pid ${app.child.pid}; renderer CDP :${config.PORTS.renderer}, main inspector :${config.PORTS.main}`);
app.child.stdout.pipe(process.stdout);
app.child.stderr.pipe(process.stderr);

function stop() {
  const found = [app.child.pid];
  for (let i = 0; i < found.length; i++) {
    const kids = execSync(`pgrep -P ${found[i]} || true`).toString().trim().split('\n').filter(Boolean).map(Number);
    for (const k of kids) if (!found.includes(k)) found.push(k);
  }
  for (const pid of found.reverse()) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  console.log(`stopped ${found.join(', ')}`);
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
app.child.on('exit', (code) => { console.log(`app exited ${code}`); process.exit(0); });
