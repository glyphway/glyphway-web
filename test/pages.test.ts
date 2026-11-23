import { describe, expect, it, vi } from 'vitest'
import { make, queued, setVisibility, useEnv } from './helpers'

const names = (a: ReturnType<typeof make>) => queued(a).map((e) => e.event)
const last = (a: ReturnType<typeof make>, ev: string) => queued(a).filter((e) => e.event === ev).at(-1)!

describe('$pageview / $pageleave', () => {
  useEnv()

  it('captures $pageview with title on load', () => {
    history.replaceState(null, '', '/home?x=1')
    const a = make({ capturePageview: true })
    expect(names(a)).toEqual(['$pageview'])
    expect(queued(a)[0]!.properties).toMatchObject({ title: 'Test page', $pathname: '/home', $current_url: 'http://localhost:3000/home?x=1' })
  })

  it('SPA: a pathname change sends $pageleave for the old page, then $pageview for the new one', () => {
    history.replaceState(null, '', '/a?q=1')
    const a = make({ capturePageview: true })
    vi.advanceTimersByTime(4000)
    history.pushState(null, '', '/b')
    expect(names(a)).toEqual(['$pageview', '$pageleave', '$pageview'])
    const leave = last(a, '$pageleave')
    expect(leave.properties).toMatchObject({ $engagement_ms: 4000, $pathname: '/a', $current_url: 'http://localhost:3000/a?q=1' })
    expect(last(a, '$pageview').properties.$pathname).toBe('/b')
  })

  it('SPA: query/hash-only changes (same pathname) are not page views (posthog-js)', () => {
    const a = make({ capturePageview: true })
    history.replaceState(null, '', '/?tab=2')
    history.pushState(null, '', '/?tab=3#x')
    expect(names(a)).toEqual(['$pageview'])
  })

  it('SPA: popstate (back/forward) is a navigation too', () => {
    const a = make({ capturePageview: true })
    history.pushState(null, '', '/one')
    history.replaceState(null, '', '/two') // replaceState counts as well
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(names(a)).toEqual(['$pageview', '$pageleave', '$pageview', '$pageleave', '$pageview'])
  })

  it('pagehide sends one $pageleave and flushes via the unload path', () => {
    const a = make({ capturePageview: true })
    vi.advanceTimersByTime(1500)
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('pagehide'))
    expect(vi.mocked(navigator.sendBeacon)).toHaveBeenCalled()
    const body = JSON.parse(vi.mocked(navigator.sendBeacon).mock.calls[0]![1] as string)
    expect(body.batch.map((e: { event: string }) => e.event)).toEqual(['$pageview', '$pageleave'])
    expect(body.batch[1].properties.$engagement_ms).toBe(1500)
    expect(queued(a)).toHaveLength(0)
  })

  it('bfcache restore (pageshow persisted) starts a new page view', () => {
    const a = make({ capturePageview: true })
    window.dispatchEvent(new Event('pagehide'))
    const ev = new Event('pageshow') as PageTransitionEvent
    Object.defineProperty(ev, 'persisted', { value: true })
    window.dispatchEvent(ev)
    expect(names(a)).toEqual(['$pageview'])
    expect(vi.mocked(navigator.sendBeacon)).toHaveBeenCalledTimes(1)
  })

  it('capturePageview: false disables both (pageleave follows pageview by default); each can be set', () => {
    const a = make({ capturePageview: false })
    history.pushState(null, '', '/x')
    window.dispatchEvent(new Event('pagehide'))
    expect(names(a)).toEqual([])
    a.teardown_()
    const b = make({ capturePageview: false, capturePageleave: true })
    history.pushState(null, '', '/y')
    expect(names(b)).toEqual(['$pageleave'])
  })
})

describe('$engagement_ms: visible AND focused time', () => {
  useEnv()

  it('counts only time the page is visible and the window focused', () => {
    const a = make({ capturePageview: true })
    vi.advanceTimersByTime(5000) // engaged: 5 s
    window.dispatchEvent(new Event('blur'))
    vi.advanceTimersByTime(10_000) // unfocused
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(3000) // engaged: 3 s
    setVisibility('hidden')
    vi.advanceTimersByTime(20_000) // hidden
    window.dispatchEvent(new Event('blur'))
    setVisibility('visible')
    vi.advanceTimersByTime(7000) // visible but unfocused
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(2000) // engaged: 2 s
    history.pushState(null, '', '/next')
    expect(last(a, '$pageleave').properties.$engagement_ms).toBe(10_000)
    // the counter restarts for the next page
    vi.advanceTimersByTime(1234)
    window.dispatchEvent(new Event('pagehide'))
    const body = JSON.parse(vi.mocked(navigator.sendBeacon).mock.calls.at(-1)![1] as string)
    expect(body.batch.at(-1).event).toBe('$pageleave')
    expect(body.batch.at(-1).properties.$engagement_ms).toBe(1234)
  })

  it('starts at zero when the page loads hidden', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    const a = make({ capturePageview: true })
    vi.advanceTimersByTime(60_000)
    history.pushState(null, '', '/n')
    expect(last(a, '$pageleave').properties.$engagement_ms).toBe(0)
  })
})
