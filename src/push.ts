// Web Push. A lazy module: `registerPush(glyphway, { vapidKey })`.
//
// The app serves a service worker (`push-sw.js` in this package is one to copy) from its own origin,
// since that is where a worker must live. This module subscribes the browser with the project's VAPID
// public key and sends the subscription as `$push_token`; the worker tells the page when a notification
// arrives, is opened or is dismissed, and the page reports each with the campaign it came from.
import type { Glyphway } from './core'
import { emitter, isOff } from './feature'
import type { Props } from './types'

export interface PushOptions {
  /** The project's VAPID public key (base64url), from the push settings. */
  vapidKey: string
  /** Where the app serves the worker. */
  serviceWorker?: string
  /** What campaigns can target. */
  topics?: string[]
}

export type PushState = 'subscribed' | 'denied' | 'unsupported' | 'error'

export interface Push {
  /** Stops reporting and unsubscribes this browser. */
  unregister(): Promise<void>
  stop(): void
}

/** What the worker posts to a page. */
export interface PushMessage {
  type: 'glyphway_push'
  kind: 'received' | 'opened' | 'dismissed'
  /** The notification's data: `campaign_id`, and `variant` in an experiment. */
  data?: Record<string, unknown>
}

/** A VAPID key as the bytes `subscribe` wants. */
export function keyBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** The report for a worker message, or none when it isn't from a campaign. */
export function report(m: unknown): { event: string; props: Props } | undefined {
  const x = m as Partial<PushMessage> | null
  if (!x || x.type !== 'glyphway_push' || !x.kind || !['received', 'opened', 'dismissed'].includes(x.kind)) return undefined
  const id = x.data?.campaign_id
  if (id === undefined || id === null || id === '') return undefined
  const variant = x.data?.variant
  const props: Props = { $campaign_id: String(id) }
  if (variant !== undefined && variant !== null && variant !== '') props.$variant = String(variant)
  return { event: '$push_' + x.kind, props }
}

export interface Env {
  navigator?: Navigator
  Notification?: Pick<typeof Notification, 'requestPermission'>
}

/**
 * Asks permission, subscribes and registers the browser. Call it from a click or similar, since
 * browsers refuse a permission prompt that nobody asked for.
 */
export async function registerPush(a: Glyphway, o: PushOptions, env: Env = {}): Promise<{ state: PushState; push?: Push }> {
  if (isOff(a, 'push', 'registerPush()')) return { state: 'unsupported' }
  const emit = emitter(a)
  const nav = env.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator)
  const N = env.Notification ?? (typeof Notification === 'undefined' ? undefined : Notification)
  const pushManager = !!env.navigator || (typeof window !== 'undefined' && 'PushManager' in window)
  if (!nav || !N || !pushManager || !('serviceWorker' in nav)) return { state: 'unsupported' }
  try {
    if ((await N.requestPermission()) !== 'granted') return { state: 'denied' }
    await nav.serviceWorker.register(o.serviceWorker ?? '/glyphway-push-sw.js')
    const reg = await nav.serviceWorker.ready
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(o.vapidKey) })
    const props: Props = { $push_token: JSON.stringify(sub.toJSON()), $push_platform: 'web' }
    if (o.topics?.length) props.$push_topics = o.topics
    emit('$push_token', props)

    const onMessage = (e: MessageEvent): void => {
      const r = report(e.data)
      if (r) emit(r.event, r.props)
    }
    nav.serviceWorker.addEventListener('message', onMessage)
    // the worker holds what happened while no page was open, until a page says it is here
    reg.active?.postMessage({ type: 'glyphway_push_ready' })
    return {
      state: 'subscribed',
      push: {
        stop: () => nav.serviceWorker.removeEventListener('message', onMessage),
        unregister: async () => {
          nav.serviceWorker.removeEventListener('message', onMessage)
          await sub.unsubscribe()
          emit('$push_token', { $push_token: '', $push_platform: 'web' })
        },
      },
    }
  } catch {
    return { state: 'error' }
  }
}
