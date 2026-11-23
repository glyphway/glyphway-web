import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Glyphway } from '../src/core'

type Report = (m: { value: number; attribution: Record<string, string> }) => void
const hooks: Record<string, Report> = {}

vi.mock('web-vitals/attribution', () => ({
  onLCP: (f: Report) => { hooks.lcp = f },
  onINP: (f: Report) => { hooks.inp = f },
  onCLS: (f: Report) => { hooks.cls = f },
  onFCP: (f: Report) => { hooks.fcp = f },
}))

const { vitals } = await import('../src/vitals')

const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
}

describe('web vitals', () => {
  afterEach(() => setHidden(false))

  it('sends one event when the page hides, with the latest values', () => {
    const all: { name: string; props: Record<string, unknown> }[] = []
    const events = (): typeof all => all.filter((e) => e.name === '$perf_web_vitals')
    const flush = vi.fn(async () => {})
    const a = { capture: (name: string, props: Record<string, unknown>) => all.push({ name, props }), flush } as unknown as Glyphway
    const stop = vitals(a)
    hooks.lcp!({ value: 1200, attribution: { target: 'img.hero' } })
    hooks.lcp!({ value: 2500.1234, attribution: { target: 'h1' } })
    hooks.cls!({ value: 0.12, attribution: { largestShiftTarget: 'div.ad' } })
    hooks.inp!({ value: 180, attribution: { interactionTarget: 'button' } })
    hooks.fcp!({ value: 900, attribution: {} })

    dispatchEvent(new Event('visibilitychange'))
    expect(events()).toHaveLength(0)

    setHidden(true)
    dispatchEvent(new Event('visibilitychange'))
    dispatchEvent(new Event('pagehide'))
    expect(events()).toHaveLength(1)
    expect(events()[0]!.props).toMatchObject({
      $lcp: 2500.123, $lcp_element: 'h1', $cls: 0.12, $cls_target: 'div.ad', $inp: 180, $inp_target: 'button', $fcp: 900, $pathname: location.pathname,
    })
    expect(flush).toHaveBeenCalledOnce()
    stop()
  })

  it('reports the time the page was visible and hidden as automatic traces (E5)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-04T10:00:00Z'))
    const all: { name: string; props: Record<string, unknown> }[] = []
    const a = { capture: (name: string, props: Record<string, unknown>) => all.push({ name, props }), flush: vi.fn(async () => {}) } as unknown as Glyphway
    const stop = vitals(a)
    vi.advanceTimersByTime(90_000)
    setHidden(true)
    dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(30_000)
    setHidden(false)
    dispatchEvent(new Event('visibilitychange'))
    const traces = all.filter((e) => e.name === '$perf_trace').map((e) => [e.props.$trace_name, e.props.$duration_ms])
    expect(traces).toEqual([['_app_in_foreground', 90_000], ['_app_in_background', 30_000]])
    stop()
    vi.useRealTimers()
  })
})
