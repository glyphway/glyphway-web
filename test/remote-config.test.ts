import { describe, expect, it, vi } from 'vitest'
import { remoteConfig } from '../src/remote-config'
import { memKV } from '../src/storage'
import type { Glyphway } from '../src/core'

type Body = Record<string, unknown>

const client = () => {
  const events: { name: string; props: Body }[] = []
  let out = false
  const a = {
    hasOptedOut: () => out,
    optIn() { out = false },
    optOut() { out = true },
    getClient: () => ({ host: 'https://e.x', writeKey: 'k', deviceId: 'dev', groups: {}, identified: true, release: '2.0', device: { $os: 'Android', $os_version: 14, $browser: 'Chrome', $locale: 'bn-BD', $device_type: 'Mobile' } }),
    getDistinctId: () => 'u',
    capture: (name: string, p: Body) => events.push({ name, props: p }),
  } as unknown as Glyphway
  return { a, events }
}

const update = (version: number, values: Record<string, unknown>, rollouts?: unknown): Response =>
  new Response(JSON.stringify({ version, state: 'UPDATE', values: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value, type: 'String' }])), rollouts }))

describe('remote config', () => {
  it('sends nothing while opted out, and a bad stored entry does not break getAll', async () => {
    const { a } = client()
    a.optOut()
    const fetch = vi.fn(async () => update(3, { x: 'b' }))
    const storage = memKV()
    storage.set('an_rc_k_a', JSON.stringify({ version: 1, values: { bad: 'oops', good: { value: 'v', type: 'String' } } }))
    const rc = remoteConfig(a, { fetch: fetch as never, storage, minimumFetchIntervalMs: 0 })
    expect(await rc.fetch()).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    expect(rc.getAll()).toEqual({ good: 'v' })
    a.optIn()
    expect(await rc.fetch()).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('sends its facts, and only activate changes what get* returns', async () => {
    const { a } = client()
    const bodies: Body[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://e.x/config')
      bodies.push(JSON.parse(String(init.body)))
      return update(3, { x: 'b' })
    }) as never
    const rc = remoteConfig(a, { fetch, storage: memKV(), defaults: { x: 'a', y: 'd' } })
    rc.setCustomSignals({ tier: 'gold' })
    expect(await rc.fetch()).toBe(true)
    expect(bodies[0]).toMatchObject({ api_key: 'k', version: 0, distinct_id: 'u', identified: true, installation_id: 'dev', app_version: '2.0', os: 'Android', os_version: '14', browser: 'Chrome', language: 'bn-BD', device_type: 'Mobile', custom_signals: { tier: 'gold' } })
    expect(rc.getString('x')).toBe('a')
    expect(await rc.activate()).toBe(true)
    expect(rc.getString('x')).toBe('b')
    expect(rc.getString('y')).toBe('d')
    expect(rc.getAll()).toEqual({ x: 'b', y: 'd' })
    expect(await rc.activate()).toBe(false)
  })

  it('waits out the minimum interval', async () => {
    const { a } = client()
    const fetch = vi.fn(async () => update(1, {}))
    const rc = remoteConfig(a, { fetch: fetch as never, storage: memKV(), minimumFetchIntervalMs: 1000 })
    await rc.fetch()
    expect(await rc.fetch()).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('holds its version, so an unchanged template sends no values', async () => {
    const { a } = client()
    const storage = memKV()
    const seen: unknown[] = []
    const fetch = (async (_: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)).version)
      return seen.length === 1 ? update(4, { x: 'b' }) : new Response(JSON.stringify({ version: 4, state: 'NO_CHANGE' }))
    }) as never
    const rc = remoteConfig(a, { fetch, storage, minimumFetchIntervalMs: 0 })
    await rc.fetchAndActivate()
    expect(await rc.fetch()).toBe(false)
    expect(seen).toEqual([0, 4])
    expect(rc.getString('x')).toBe('b')
    const again = remoteConfig(client().a, { fetch, storage })
    expect(again.getString('x')).toBe('b')
  })

  it('reports rollouts when values activate, not when they arrive', async () => {
    const { a, events } = client()
    const rc = remoteConfig(a, { fetch: (async () => update(2, { x: 'b' }, [{ id: 7, group: 'control' }])) as never, storage: memKV() })
    await rc.fetch()
    expect(events).toEqual([])
    await rc.activate()
    expect(events).toEqual([{ name: '$rc_rollout', props: { $rollout_id: 7, $rollout_group: 'control' } }])
  })

  it('reports an experiment as exposure when its values activate', async () => {
    const { a, events } = client()
    const body = JSON.stringify({ version: 2, state: 'UPDATE', values: {}, experiments: [{ key: 'experiment-3', variant: 'test' }] })
    const rc = remoteConfig(a, { fetch: (async () => new Response(body)) as never, storage: memKV() })
    await rc.fetchAndActivate()
    expect(events).toEqual([{ name: '$feature_flag_called', props: { $feature_flag: 'experiment-3', $feature_flag_response: 'test' } }])
  })

  it('reads values as their types', async () => {
    const { a } = client()
    const rc = remoteConfig(a, { fetch: (async () => update(1, { b: 'true', n: '12.5', j: '{"a":1}', o: { a: 2 }, f: 0 })) as never, storage: memKV() })
    await rc.fetchAndActivate()
    expect([rc.getBool('b'), rc.getBool('f'), rc.getBool('none')]).toEqual([true, false, false])
    expect([rc.getNumber('n'), rc.getNumber('b'), rc.getNumber('none')]).toEqual([12.5, 0, 0])
    expect([rc.getJSON('j'), rc.getJSON('o'), rc.getString('o'), rc.getString('none')]).toEqual([{ a: 1 }, { a: 2 }, '{"a":2}', ''])
  })

  it('fetches on a newer version from the stream and tells the listener', async () => {
    const { a } = client()
    const sources: { url: string; onmessage?: (e: { data: string }) => void; close: () => void }[] = []
    class ES {
      url: string
      onmessage?: (e: { data: string }) => void
      onerror?: () => void
      readyState = 1
      close = vi.fn()
      constructor(url: string) { this.url = url; sources.push(this as never) }
    }
    const fetch = vi.fn(async () => update(5, { x: 'b' }))
    const rc = remoteConfig(a, { fetch: fetch as never, storage: memKV(), minimumFetchIntervalMs: 0, eventSource: ES as never })
    const told: number[] = []
    const off = rc.onConfigUpdate((v) => told.push(v))
    expect(sources[0]!.url).toBe('https://e.x/config/stream?api_key=k')
    sources[0]!.onmessage!({ data: '{"version":0}' })
    await new Promise((r) => setTimeout(r, 0))
    expect(fetch).not.toHaveBeenCalled()
    sources[0]!.onmessage!({ data: '{"version":5}' })
    await new Promise((r) => setTimeout(r, 0))
    expect(told).toEqual([5])
    off()
    expect(sources[0]!.close).toHaveBeenCalled()
  })
})
