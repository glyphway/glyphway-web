import { onCLS, onFCP, onINP, onLCP } from 'web-vitals/attribution'
import type { Glyphway } from './core'
import { emitter, isOff } from './feature'
import type { Props } from './types'

// Web vitals. One `$perf_web_vitals` per page, sent when the page hides.
const round = (n: number): number => Math.round(n * 1000) / 1000

/** Start measuring. Call it once, after `glyphway.init`. Returns a stop function. */
export function vitals(a: Glyphway): () => void {
  if (isOff(a, 'performance', 'vitals()')) return () => {}
  const emit = emitter(a)
  const v: Props = {}
  let sent = false
  onLCP((m) => {
    v.$lcp = round(m.value)
    v.$lcp_element = m.attribution.target ?? ''
  }, { reportAllChanges: true })
  onINP((m) => {
    v.$inp = round(m.value)
    v.$inp_target = m.attribution.interactionTarget ?? ''
  }, { reportAllChanges: true })
  onCLS((m) => {
    v.$cls = round(m.value)
    v.$cls_target = m.attribution.largestShiftTarget ?? ''
  }, { reportAllChanges: true })
  onFCP((m) => {
    v.$fcp = round(m.value)
  }, { reportAllChanges: true })

  const timing = (): Props => {
    const out: Props = { $pathname: location.pathname }
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const paint = performance.getEntriesByName('first-paint')[0]
    if (paint) out.$first_paint = round(paint.startTime)
    if (nav) {
      out.$navigation_type = nav.type
      if (nav.domInteractive) out.$dom_interactive = round(nav.domInteractive)
      if (nav.domContentLoadedEventEnd) out.$dcl_end = round(nav.domContentLoadedEventEnd)
      if (nav.loadEventEnd) out.$load_end = round(nav.loadEventEnd)
    }
    return out
  }

  const send = (): void => {
    if (sent || document.visibilityState !== 'hidden') return
    sent = true
    emit('$perf_web_vitals', { ...timing(), ...v })
    void a.flush()
  }
  // the time the page was visible and hidden, as the automatic traces of a mobile app are
  let since = Date.now()
  const state = (): void => {
    const now = Date.now()
    if (now > since) emit('$perf_trace', { $trace_name: document.visibilityState === 'hidden' ? '_app_in_foreground' : '_app_in_background', $duration_ms: now - since })
    since = now
  }
  addEventListener('visibilitychange', send, true)
  addEventListener('pagehide', send, true)
  addEventListener('visibilitychange', state, true)
  return () => {
    removeEventListener('visibilitychange', send, true)
    removeEventListener('pagehide', send, true)
    removeEventListener('visibilitychange', state, true)
  }
}
