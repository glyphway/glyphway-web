import { describe, expect, it, vi } from 'vitest'
import { kill, make, queued, useEnv } from './helpers'

/** The edge's `/array/{token}/config`: `webSdk` is what the project saved (null before). */
function config(webSdk: unknown) {
  const f = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ token: 'wk_test', webSdk }) }) as unknown as Response)
  vi.stubGlobal('fetch', f)
  return f
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
const names = (a: ReturnType<typeof make>): string[] => queued(a).map((e) => e.event)

describe('project web SDK settings', () => {
  useEnv()

  it('reads the config from the edge once, with the write key', async () => {
    const f = config({ autocapture: true })
    make({ projectSettings: true })
    await flush()
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0]![0]).toBe('https://edge.test/array/wk_test/config')
  })

  it('drops autocapture, dead click and heatmap events a project switched off, and nothing else', async () => {
    config({ cookieless_mode: false, autocapture: false, dead_clicks: false, heatmaps: true })
    const a = make({ projectSettings: true })
    await flush()
    for (const e of ['$autocapture', '$rageclick', '$dead_click', '$$heatmap', 'plain']) a.capture(e)
    expect(names(a)).toEqual(['$$heatmap', 'plain'])
  })

  it('keeps everything when the project saved nothing or the edge cannot be reached', async () => {
    config(null)
    const a = make({ projectSettings: true })
    await flush()
    a.capture('$autocapture')
    expect(names(a)).toEqual(['$autocapture'])
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    const b = make({ projectSettings: true }, 'wk_other')
    await flush()
    b.capture('$dead_click')
    expect(names(b)).toEqual(['$dead_click'])
  })

  it('cookieless "always" writes nothing to storage and marks events once the project allows it', async () => {
    config({ cookieless_mode: true })
    const a = make({ projectSettings: true, cookielessMode: 'always' })
    a.capture('early') // before the answer: held
    expect(queued(a)).toHaveLength(0)
    await flush()
    a.capture('late')
    const q = queued(a)
    expect(q.map((e) => e.event)).toEqual(['early', 'late'])
    expect(q.every((e) => e.properties.$cookieless_mode === true)).toBe(true)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    kill(a)
    const b = make({ projectSettings: true, cookielessMode: 'always' })
    expect(b.getDistinctId()).not.toBe(a.getDistinctId())
  })

  it('drops cookieless events while the project has cookieless mode off', async () => {
    config({ cookieless_mode: false })
    const a = make({ projectSettings: true, cookielessMode: 'always' })
    a.capture('early')
    await flush()
    a.capture('late')
    expect(queued(a)).toHaveLength(0)
  })

  it('"on_reject" stores as usual until optOut(), then goes cookieless with a fresh identity', async () => {
    config({ cookieless_mode: true })
    const a = make({ projectSettings: true, cookielessMode: 'on_reject' })
    await flush()
    a.capture('before')
    expect(queued(a)[0]!.properties.$cookieless_mode).toBeUndefined()
    const before = a.getDistinctId()
    a.optOut()
    expect(a.hasOptedOut()).toBe(false)
    expect(a.getDistinctId()).not.toBe(before)
    a.capture('after')
    expect(queued(a).map((e) => [e.event, e.properties.$cookieless_mode])).toEqual([['after', true]])
    a.optIn()
    expect(a.getDistinctId()).toBe(before)
  })
})
