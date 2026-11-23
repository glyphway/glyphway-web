import { setAutocapture } from './core'
import glyphway from './core-entry'
import { full } from './enhanced'

setAutocapture(full)

export default glyphway
export { Glyphway, VERSION, uuidv7 } from './core-entry'
export type { GlyphwayEvent, AutocaptureOptions, Feature, Options, Props } from './types'
