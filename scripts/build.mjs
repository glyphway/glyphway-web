// Builds ESM (index.mjs, core.mjs) and IIFE (<script>) bundles into dist/.
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true })

const common = {
  bundle: true,
  minify: true,
  sourcemap: true,
  target: 'es2018',
  platform: 'browser',
  define: { __VERSION__: JSON.stringify(pkg.version) },
  // Internal members end in `_` and are renamed to short names. Public API
  // names and persisted/wire keys never end in `_`.
  mangleProps: /_$/,
  legalComments: 'none',
  logLevel: 'warning',
}

// The recorder carries rrweb, whose property names must not be mangled.
const lazy = { ...common, mangleProps: undefined }
await Promise.all([
  build({ ...lazy, entryPoints: ['src/replay-entry.ts'], format: 'esm', outfile: 'dist/replay.mjs' }),
  build({ ...lazy, entryPoints: ['src/replay-iife.ts'], format: 'iife', outfile: 'dist/glyphway.replay.js' }),
  build({ ...common, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/index.mjs' }),
  build({ ...common, entryPoints: ['src/core-entry.ts'], format: 'esm', outfile: 'dist/core.mjs' }),
  build({ ...common, entryPoints: ['src/iife.ts'], format: 'iife', outfile: 'dist/glyphway.js' }),
  build({ ...common, entryPoints: ['src/iife-core.ts'], format: 'iife', outfile: 'dist/glyphway.core.js' }),
  build({ ...common, entryPoints: ['src/exceptions.ts'], format: 'esm', outfile: 'dist/exceptions.mjs' }),
  build({ ...common, entryPoints: ['src/vitals.ts'], format: 'esm', outfile: 'dist/vitals.mjs' }),
  build({ ...common, entryPoints: ['src/flags.ts'], format: 'esm', outfile: 'dist/flags.mjs' }),
  build({ ...common, entryPoints: ['src/surveys.ts'], format: 'esm', outfile: 'dist/surveys.mjs' }),
  build({ ...common, entryPoints: ['src/messages.ts'], format: 'esm', outfile: 'dist/messages.mjs' }),
  build({ ...common, entryPoints: ['src/surveys.ts'], format: 'iife', globalName: 'glyphwaySurveys', outfile: 'dist/glyphway.surveys.js' }),
  build({ ...common, entryPoints: ['src/messages.ts'], format: 'iife', globalName: 'glyphwayMessages', outfile: 'dist/glyphway.messages.js' }),
  build({ ...common, entryPoints: ['src/remote-config.ts'], format: 'esm', outfile: 'dist/remote-config.mjs' }),
  build({ ...common, entryPoints: ['src/push.ts'], format: 'esm', outfile: 'dist/push.mjs' }),
  build({ ...common, entryPoints: ['src/nocode.ts'], format: 'esm', outfile: 'dist/nocode.mjs' }),
  build({ ...common, entryPoints: ['src/nocode.ts'], format: 'iife', globalName: 'glyphwayNocode', outfile: 'dist/glyphway.nocode.js' }),
  build({ ...common, entryPoints: ['src/toolbar.ts'], format: 'esm', outfile: 'dist/toolbar.mjs' }),
  // the script the core loads when the page opens with #an_toolbar=...
  build({ ...common, entryPoints: ['src/toolbar.ts'], format: 'iife', globalName: 'glyphwayToolbar', outfile: 'dist/glyphway.toolbar.js' }),
  build({ ...common, entryPoints: ['src/push.ts'], format: 'iife', globalName: 'glyphwayPush', outfile: 'dist/glyphway.push.js' }),
  build({ ...common, entryPoints: ['src/flags.ts'], format: 'iife', globalName: 'glyphwayFlags', outfile: 'dist/glyphway.flags.js' }),
  build({ ...common, entryPoints: ['src/remote-config.ts'], format: 'iife', globalName: 'glyphwayRemoteConfig', outfile: 'dist/glyphway.remote-config.js' }),
  build({ ...common, entryPoints: ['src/exceptions.ts'], format: 'iife', globalName: 'glyphwayExceptions', outfile: 'dist/glyphway.exceptions.js' }),
  build({ ...common, entryPoints: ['src/vitals.ts'], format: 'iife', globalName: 'glyphwayVitals', outfile: 'dist/glyphway.vitals.js' }),
])
console.log('built dist/ (glyphway ' + pkg.version + ')')
