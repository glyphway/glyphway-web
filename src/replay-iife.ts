import type { Glyphway } from './core'
import { startReplay } from './replay'
import type { ReplayOptions } from './replay'

// Load after glyphway.js: adds `glyphway.startReplay({ host, writeKey })`.
const w = window as unknown as { glyphway?: Glyphway & { startReplay?: (o: ReplayOptions) => () => void } }
const a = w.glyphway
if (a) a.startReplay = (o) => startReplay(a, o)
