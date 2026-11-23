import { describe, expect, it, vi } from 'vitest'
import { kill, make, mockFetch, queued, useEnv } from './helpers'

const MIN = 60_000
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('sessions', () => {
  useEnv()

  it('puts a UUIDv7 $session_id and $window_id on every event', () => {
    mockFetch()
    const a = make()
    a.capture('one')
    a.capture('two')
    const [e1, e2] = queued(a)
    expect(e1!.properties.$session_id).toMatch(UUID7)
    expect(e1!.properties.$session_id).toBe(e2!.properties.$session_id)
    expect(e1!.properties.$window_id).toMatch(UUID7)
    expect(a.getSessionId()).toBe(e1!.properties.$session_id)
  })

  it('keeps the session while events are at most 30 min apart, rotates after 30 min idle', () => {
    mockFetch()
    const a = make()
    a.capture('a')
    const s1 = a.getSessionId()
    vi.advanceTimersByTime(30 * MIN) // exactly 30 min: same session (ts - last <= 30 min)
    a.capture('b')
    expect(a.getSessionId()).toBe(s1)
    vi.advanceTimersByTime(30 * MIN + 1)
    a.capture('c')
    const s2 = a.getSessionId()
    expect(s2).not.toBe(s1)
    const ids = queued(a).map((e) => e.properties.$session_id)
    expect(ids).toEqual([s1, s1, s2])
  })

  it('only captured events count as activity (reading the id does not extend it)', () => {
    mockFetch()
    const a = make()
    a.capture('a')
    const s1 = a.getSessionId()
    vi.advanceTimersByTime(20 * MIN)
    a.getSessionId()
    vi.advanceTimersByTime(11 * MIN)
    expect(a.getSessionId()).not.toBe(s1)
  })

  it('caps a session at 24 h even when it is never idle', () => {
    mockFetch()
    const a = make()
    a.capture('start')
    const s1 = a.getSessionId()
    for (let i = 0; i < 24 * 4; i++) {
      vi.advanceTimersByTime(15 * MIN)
      a.capture('tick')
    }
    // 24 h after the start: still the same session (<= 24 h)
    expect(queued(a).at(-1)!.properties.$session_id).toBe(s1)
    vi.advanceTimersByTime(1)
    a.capture('over')
    expect(queued(a).at(-1)!.properties.$session_id).not.toBe(s1)
  })

  it('shares the session across tabs and a reload, but each tab has its own $window_id', () => {
    mockFetch()
    const a = make()
    a.capture('x')
    const sid = a.getSessionId()
    const wid = queued(a)[0]!.properties.$window_id
    window.dispatchEvent(new Event('pagehide'))
    kill(a)
    // reload of the same tab: same window id, same session
    const b = make()
    b.capture('y')
    expect(queued(b).at(-1)!.properties.$session_id).toBe(sid)
    expect(queued(b).at(-1)!.properties.$window_id).toBe(wid)
    // a second tab (sessionStorage copied while the first is open, primary flag set)
    const c = make()
    c.capture('z')
    expect(queued(c).at(-1)!.properties.$session_id).toBe(sid)
    expect(queued(c).at(-1)!.properties.$window_id).not.toBe(wid)
  })

  it('treats a load that finds the primary flag still set as a duplicated tab (new window id)', () => {
    mockFetch()
    const a = make()
    a.capture('x')
    const wid = queued(a)[0]!.properties.$window_id
    kill(a) // no pagehide: the flag is still set, as in a tab duplicated from a live one
    const b = make()
    b.capture('y')
    expect(queued(b).at(-1)!.properties.$window_id).not.toBe(wid)
  })

  it('identify() keeps the session; reset() starts a new one', () => {
    mockFetch()
    const a = make()
    a.capture('x')
    const s1 = a.getSessionId()
    a.identify('user-1')
    expect(queued(a).at(-1)!.properties.$session_id).toBe(s1)
    a.reset()
    expect(a.getSessionId()).not.toBe(s1)
    a.capture('after')
    expect(queued(a).at(-1)!.properties.$session_id).not.toBe(s1)
  })

  it('memory persistence: a reload starts a new session and anon id', () => {
    mockFetch()
    const a = make({ persistence: 'memory' })
    a.capture('x')
    const sid = a.getSessionId()
    const did = a.getDistinctId()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    kill(a)
    const b = make({ persistence: 'memory' })
    expect(b.getSessionId()).not.toBe(sid)
    expect(b.getDistinctId()).not.toBe(did)
  })
})
