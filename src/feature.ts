import type { Glyphway } from './core'
import type { Feature, Props } from './types'

// Lazy modules reach the core through its public names only (internal `_` names are renamed per bundle).
// A stand-in without `getClient` or `features` counts as "everything on".
const left = (a: Glyphway, f: Feature): boolean => {
  const x = a.getClient?.().features
  return !!x && !x.includes(f)
}

/** True, with one debug warning per method, when `f` is left out of the client's `features`. */
export const isOff = (a: Glyphway, f: Feature, m: string): boolean => left(a, f) && (a.skip(f, m), true)

/** What a module returns when its feature is off: every method does nothing and returns `ret[name]` (called, if a function). */
export const disabled = <T>(a: Glyphway, f: Feature, name: string, ret: Record<string, unknown> = {}): T | undefined =>
  isOff(a, f, name + '()')
    ? (new Proxy({}, {
        get: (_, k: string) =>
          k === 'then'
            ? undefined
            : (...x: unknown[]): unknown => {
                a.skip(f, name + '().' + k)
                const r = ret[k]
                return typeof r === 'function' ? r(...x) : r
              },
      }) as T)
    : undefined

/** How a module sends its own events: through `capture()`, or around it when the app's `analytics` is off. */
export const emitter = (a: Glyphway): ((event: string, props?: Props) => void) => (left(a, 'analytics') ? (e, p) => a.emit(e, p) : (e, p) => a.capture(e, p))
