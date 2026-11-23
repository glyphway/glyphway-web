// Reports raw / gzip / brotli sizes and enforces the budgets
// (core without autocapture <= 10 KB gzip, with autocapture <= 14 KB gzip; the full bundle keeps autocapture's room
// above the core). The budget is a ceiling, not room to fill: new code goes in a lazy module unless it can't, and a
// change that grows core says how many bytes and why.
import { readFileSync } from 'node:fs'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'

const KB = 1024
const files = [
  ['dist/glyphway.core.js', 'IIFE core (no autocapture)', 10 * KB],
  ['dist/glyphway.js', 'IIFE full (with autocapture)', 14 * KB],
  ['dist/core.mjs', 'ESM core (glyphway/core)', 10 * KB],
  ['dist/index.mjs', 'ESM full (glyphway)', 14 * KB],
  ['dist/exceptions.mjs', 'ESM exceptions (lazy)', 2 * KB],
  ['dist/flags.mjs', 'ESM flags (lazy)', 2 * KB],
  ['dist/surveys.mjs', 'ESM surveys (lazy)', 5 * KB],
  ['dist/messages.mjs', 'ESM messages (lazy)', 4 * KB],
  ['dist/remote-config.mjs', 'ESM remote config (lazy)', 2.25 * KB], // was 2 KB (2042 B used); the features gate added ~110 B
  ['dist/push.mjs', 'ESM web push (lazy)', 2 * KB],
  ['dist/nocode.mjs', 'ESM no-code experiments (lazy)', 2 * KB],
  // The toolbar: loaded only for a page opened from the app, never counted in the core.
  ['dist/toolbar.mjs', 'ESM toolbar (lazy)', 9 * KB],
  ['dist/glyphway.toolbar.js', 'IIFE toolbar (lazy)', 9 * KB],
  ['dist/vitals.mjs', 'ESM vitals (lazy)', 5 * KB],
  // Lazy recorder: rrweb `record` plus ours, loaded on demand and not counted in the core budgets.
  ['dist/replay.mjs', 'ESM replay recorder (glyphway/replay, lazy)', 72 * KB],
  ['dist/glyphway.replay.js', 'IIFE replay recorder (lazy)', 72 * KB],
]
let fail = false
const rows = files.map(([f, label, budget]) => {
  const buf = readFileSync(new URL('../' + f, import.meta.url))
  const gz = gzipSync(buf, { level: 9 }).length
  const br = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length
  const ok = gz <= budget
  if (!ok) fail = true
  return { file: f, build: label, raw: buf.length, gzip: gz, brotli: br, budget_gzip: budget, ok }
})
console.table(rows)
if (fail) {
  console.error('size budget exceeded')
  process.exit(1)
}
