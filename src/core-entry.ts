import { Glyphway } from './core'

/** Core build: everything except autocapture / rage clicks. */
const glyphway = new Glyphway()
export default glyphway
export { Glyphway, VERSION } from './core'
export type { GlyphwayEvent, Feature, Options, Props } from './types'
export { uuidv7 } from './util'
