import type { Glyphway } from './core'

/**
 * Swap the `<script>` snippet's stub (`window.glyphway = { _q: [[method, args], …] }`)
 * for the real instance and replay the calls made before the bundle loaded.
 */
export function install(a: Glyphway): void {
  const w = window as unknown as { glyphway?: { _q?: [string, unknown[]][] } | Glyphway }
  const stub = w.glyphway as { _q?: [string, unknown[]][] } | undefined
  w.glyphway = a
  const q = stub && stub._q
  if (Array.isArray(q))
    for (const [m, args] of q) {
      const f = (a as unknown as Record<string, unknown>)[m]
      if (typeof f === 'function') f.apply(a, args)
    }
}
