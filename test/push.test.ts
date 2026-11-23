// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { keyBytes, registerPush, report } from '../src/push'
import type { Glyphway } from '../src/core'

describe('push reports', () => {
  it('names the campaign and the variant', () => {
    expect(report({ type: 'glyphway_push', kind: 'opened', data: { campaign_id: '12', variant: 'b' } })).toEqual({ event: '$push_opened', props: { $campaign_id: '12', $variant: 'b' } })
    expect(report({ type: 'glyphway_push', kind: 'received', data: { campaign_id: 7 } })).toEqual({ event: '$push_received', props: { $campaign_id: '7' } })
    expect(report({ type: 'glyphway_push', kind: 'dismissed', data: { campaign_id: '1' } })?.event).toBe('$push_dismissed')
  })

  it('ignores whatever is not from a campaign', () => {
    expect(report({ type: 'glyphway_push', kind: 'opened', data: {} })).toBeUndefined()
    expect(report({ type: 'glyphway_push', kind: 'opened' })).toBeUndefined()
    expect(report({ type: 'glyphway_push', kind: 'clicked', data: { campaign_id: '1' } })).toBeUndefined()
    expect(report({ type: 'other', kind: 'opened', data: { campaign_id: '1' } })).toBeUndefined()
    expect(report(null)).toBeUndefined()
  })

  it('turns a VAPID key into its bytes', () => {
    // 65 bytes, the first 0x04: the uncompressed point RFC 8292 §3.2 sends
    const k = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
    const b = keyBytes(k)
    expect([b.length, b[0]]).toEqual([65, 4])
  })
})

function rig(permission: NotificationPermission = 'granted') {
  const events: { name: string; props: Record<string, unknown> }[] = []
  const a = { capture: (name: string, props: Record<string, unknown>) => events.push({ name, props }) } as unknown as Glyphway
  const listeners: ((e: MessageEvent) => void)[] = []
  const posted: unknown[] = []
  const unsubscribe = vi.fn(async () => true)
  let subscribed: PushSubscriptionOptionsInit | undefined
  const registration = {
    active: { postMessage: (m: unknown) => posted.push(m) },
    pushManager: {
      subscribe: async (o: PushSubscriptionOptionsInit) => {
        subscribed = o
        return { toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'P', auth: 'A' } }), unsubscribe }
      },
    },
  }
  const registered: string[] = []
  const navigator = {
    serviceWorker: {
      register: async (u: string) => registered.push(u),
      ready: Promise.resolve(registration),
      addEventListener: (_: string, f: (e: MessageEvent) => void) => listeners.push(f),
      removeEventListener: (_: string, f: (e: MessageEvent) => void) => listeners.splice(listeners.indexOf(f), 1),
    },
  } as unknown as Navigator
  const Notif = { requestPermission: async () => permission }
  return { a, events, listeners, posted, unsubscribe, registered, navigator, Notif, subscribed: () => subscribed }
}

describe('registerPush', () => {
  it('subscribes with the VAPID key and sends the subscription as $push_token', async () => {
    const r = rig()
    const key = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
    const out = await registerPush(r.a, { vapidKey: key, topics: ['news'] }, { navigator: r.navigator, Notification: r.Notif })
    expect(out.state).toBe('subscribed')
    expect(r.registered).toEqual(['/glyphway-push-sw.js'])
    expect(r.subscribed()?.userVisibleOnly).toBe(true)
    expect((r.subscribed()?.applicationServerKey as Uint8Array).length).toBe(65)
    expect(r.events).toEqual([{ name: '$push_token', props: { $push_token: JSON.stringify({ endpoint: 'https://push.example/abc', keys: { p256dh: 'P', auth: 'A' } }), $push_platform: 'web', $push_topics: ['news'] } }])
    expect(r.posted).toEqual([{ type: 'glyphway_push_ready' }])
  })

  it('reports what the worker says, until stopped', async () => {
    const r = rig()
    const out = await registerPush(r.a, { vapidKey: 'BA', serviceWorker: '/sw.js' }, { navigator: r.navigator, Notification: r.Notif })
    expect(r.registered).toEqual(['/sw.js'])
    r.events.length = 0
    r.listeners[0]!({ data: { type: 'glyphway_push', kind: 'opened', data: { campaign_id: '3' } } } as MessageEvent)
    r.listeners[0]!({ data: { type: 'glyphway_push', kind: 'opened', data: {} } } as MessageEvent)
    expect(r.events).toEqual([{ name: '$push_opened', props: { $campaign_id: '3' } }])
    out.push!.stop()
    expect(r.listeners).toHaveLength(0)
  })

  it('does not subscribe without permission', async () => {
    const r = rig('denied')
    const out = await registerPush(r.a, { vapidKey: 'BA' }, { navigator: r.navigator, Notification: r.Notif })
    expect(out.state).toBe('denied')
    expect(r.events).toEqual([])
    expect(r.registered).toEqual([])
  })

  it('says so where push does not exist', async () => {
    const r = rig()
    expect((await registerPush(r.a, { vapidKey: 'BA' }, { navigator: {} as Navigator, Notification: r.Notif })).state).toBe('unsupported')
    expect((await registerPush(r.a, { vapidKey: 'BA' }, { navigator: r.navigator, Notification: undefined })).state).not.toBe('subscribed')
  })

  it('unregisters: unsubscribes and tells the server the device is gone', async () => {
    const r = rig()
    const out = await registerPush(r.a, { vapidKey: 'BA' }, { navigator: r.navigator, Notification: r.Notif })
    r.events.length = 0
    await out.push!.unregister()
    expect(r.unsubscribe).toHaveBeenCalled()
    expect(r.events).toEqual([{ name: '$push_token', props: { $push_token: '', $push_platform: 'web' } }])
  })

  it('reports an error rather than throwing', async () => {
    const r = rig()
    const bad = { ...r.navigator, serviceWorker: { ...r.navigator.serviceWorker, register: async () => { throw new Error('no') } } } as unknown as Navigator
    expect((await registerPush(r.a, { vapidKey: 'BA' }, { navigator: bad, Notification: r.Notif })).state).toBe('error')
  })
})
