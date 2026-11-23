// In-app messages. A lazy module: `messages(glyphway)` after init.
//
// Fetched once a day and on app open. Triggers and frequency live on the device,
// the audience in a generated flag, so pass the `flags` module for messages with one.
import type { Glyphway } from './core'
import type { FeatureFlags } from './flags'
import { closeButton, el, overlay, safeUrl, type Overlay, type Theme } from './overlay'
import { memKV, webKV, type KV } from './storage'
import { disabled, emitter } from './feature'
import type { Props } from './types'

const DAY = 86_400_000

export interface MessageAction {
  label: string
  /** `dismiss`, or a URL or deep link. */
  action?: string
}

export interface MessageContent {
  title?: string
  body?: string
  image_url?: string
  primary?: MessageAction
  secondary?: MessageAction
  colors?: Theme
  metadata?: Props
}

export interface Message {
  id: number | string
  name: string
  layout: 'card' | 'modal' | 'image' | 'banner'
  /** By locale, with `default` as the fallback. */
  content: Record<string, MessageContent>
  targeting?: { flag_key?: string; experiment_flag?: string; experiment_variant?: string }
  /** `{ event }`: `app_open` by default, any event name, or `manual` for `triggerMessage`. */
  trigger?: { event?: string }
  schedule?: { start?: number; end?: number }
  /** `{ every_days }`, or once per device. */
  frequency?: { every_days?: number }
  /** Set by the edge when this device is a test device of the message. */
  test?: boolean
}

/** `bn-BD` finds `bn-BD`, then `bn`, then `default`. */
export function contentFor(m: Message, locale: string): MessageContent | undefined {
  return m.content[locale] ?? m.content[locale.split('-')[0]!] ?? m.content.default
}

/** Once per device, or every N days. */
export function due(m: Message, lastShown: number | undefined, now: number): boolean {
  if (lastShown === undefined) return true
  const days = m.frequency?.every_days
  return !!days && now - lastShown >= days * DAY
}

/** Whether this event shows this message: only its own trigger does. */
export function triggered(m: Message, event: string): boolean {
  return (m.trigger?.event ?? 'app_open') === event
}

/** A message handed to `display`: draw it, then say what happened. */
export interface ActiveMessage {
  message: Message
  /** The content for the page's language. */
  content: MessageContent
  /** It is really on screen: sends `$message_impression` and keeps the frequency record, once. */
  impression(): void
  /** A button was used: sends `$message_click` and closes. */
  click(action: string): void
  dismiss(): void
  /** It could not be shown: sends `$message_display_error`, keeps no frequency record, and closes. */
  error(reason: string): void
}

export interface MessageOptions {
  flags?: FeatureFlags
  /** Draw messages yourself. The module then draws nothing and counts nothing until `impression()`. */
  display?: (m: ActiveMessage) => void
  locale?: string
  storage?: KV
  fetch?: typeof fetch
  /** Handles a deep link; URLs open in a new tab otherwise. */
  onAction?: (action: string, m: Message) => void
}

export interface Messages {
  /** Shows a message whose trigger is `manual`, past its frequency. */
  triggerMessage(id: Message['id']): void
  /** Stops messages until this is called again or the page reloads (F7). */
  suppressMessages(on: boolean): void
  isSuppressed(): boolean
  stop(): void
}

export function messages(a: Glyphway, o: MessageOptions = {}): Messages {
  const off = disabled<Messages>(a, 'messages', 'messages', { isSuppressed: () => false })
  if (off) return off
  const emit = emitter(a)
  const c = a.getClient()
  const kv = o.storage ?? (typeof localStorage === 'undefined' ? memKV() : webKV('localStorage'))
  const send = o.fetch ?? fetch.bind(globalThis)
  const key = `an_messages_${c.writeKey}`
  let list: Message[] = []
  let suppressed = false
  let open: Overlay | undefined
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const locale = o.locale ?? (typeof navigator === 'undefined' ? 'default' : navigator.language)

  const shown = (): Record<string, number> => {
    try {
      return (JSON.parse(kv.get(key) ?? '{}') as Record<string, number> | null) ?? {}
    } catch {
      return {}
    }
  }

  // a test message leaves no trace: no frequency record, no events
  const record = (m: Message): void => {
    if (m.test) return
    const all = shown()
    all[String(m.id)] = Date.now()
    kv.set(key, JSON.stringify(all))
    emit('$message_impression', { $message_id: String(m.id), $message_name: m.name })
  }

  const custom = (m: Message, content: MessageContent): void => {
    const id = String(m.id)
    let counted = false
    const note = (event: string, props: Props): void => {
      if (!m.test) emit(event, props)
    }
    const slot = { box: undefined as never, close: (): void => { open = undefined } } as Overlay
    open = slot
    const end = (event: string, props: Props): void => {
      if (open !== slot) return
      note(event, props)
      slot.close()
    }
    o.display!({
      message: m,
      content,
      impression: () => {
        if (counted || open !== slot) return
        counted = true
        record(m)
      },
      click: (action) => end('$message_click', { $message_id: id, $message_action: action }),
      dismiss: () => end('$message_dismiss', { $message_id: id }),
      error: (reason) => end('$message_display_error', { $message_id: id, $message_reason: reason.slice(0, 200) }),
    })
  }

  /** True when the message is now on screen (or with the app's `display`). */
  const render = (m: Message): boolean => {
    const body = contentFor(m, locale)
    if (!body || open || a.hasOptedOut()) return false
    if (o.display) {
      custom(m, body)
      return true
    }
    const id = String(m.id)
    const note = (event: string, props: Props): void => {
      if (!m.test) emit(event, props)
    }
    record(m)
    const ui = overlay(m.layout === 'banner' ? 'top' : m.layout === 'card' ? 'corner' : 'center', body.colors ?? {}, () => {
      open = undefined
    })
    open = ui
    const dismiss = (): void => {
      note('$message_dismiss', { $message_id: id })
      ui.close()
    }
    const act = (b: MessageAction): void => {
      if (b.action === 'dismiss' || !b.action) return dismiss()
      note('$message_click', { $message_id: id, $message_action: b.action })
      ui.close()
      if (o.onAction) return o.onAction(b.action, m)
      const url = safeUrl(b.action)
      if (url) window.open(url, '_blank', 'noopener')
    }
    const parts: Node[] = [closeButton('Dismiss', dismiss)]
    const src = safeUrl(body.image_url)
    if (src) {
      const img = el('img')
      img.src = src
      img.alt = body.title ?? ''
      parts.push(img)
    }
    if (body.title && m.layout !== 'image') parts.push(el('h2', { text: body.title }))
    if (body.body && m.layout !== 'image') parts.push(el('p', { text: body.body }))
    const row = el('div', { class: 'row' })
    for (const [b, cls] of [[body.secondary, 'plain'], [body.primary, 'go']] as const) {
      if (!b) continue
      const x = el('button', { class: cls, text: b.label })
      x.onclick = (): void => act(b)
      row.append(x)
    }
    if (row.children.length) parts.push(row)
    ui.box.replaceChildren(...parts)
    return true
  }

  const live = (m: Message, now: number): boolean => {
    const s = m.schedule ?? {}
    const flag = m.targeting?.flag_key
    if ((s.start && now < s.start) || (s.end && now >= s.end)) return false
    return !flag || !!o.flags?.isFeatureEnabled(flag, { send_event: false })
  }

  // Asked last, and with the exposure on: this is the moment the experiment's variant decides,
  // so a person whose variant has no message is counted too.
  const yours = (m: Message): boolean => {
    const x = m.targeting?.experiment_flag
    return !x || o.flags?.getFeatureFlag(x) === m.targeting?.experiment_variant
  }

  const fire = (event: string): void => {
    if (suppressed || open || stopped || a.hasOptedOut()) return
    const now = Date.now()
    const all = shown()
    // a test device is shown its test message at app open, past targeting, trigger, schedule and frequency
    // one that can't be drawn must not hold back the ones after it
    for (const x of list) {
      const mine = x.test ? event === 'app_open' : triggered(x, event) && live(x, now) && due(x, all[String(x.id)], now) && yours(x)
      if (mine && render(x)) return
    }
  }

  const capture = a.capture
  a.capture = (event: string, props?: Props): void => {
    capture.call(a, event, props)
    if (!event.startsWith('$message_')) fire(event)
  }

  const load = async (): Promise<void> => {
    clearTimeout(timer)
    try {
      // the request carries the device id, so an opted-out page asks nothing
      if (a.hasOptedOut() || stopped) return
      const r = await send(`${c.host}/messages?api_key=${encodeURIComponent(c.writeKey)}&device_id=${encodeURIComponent(c.deviceId)}`)
      if (r.ok && !stopped) {
        list = ((await r.json()) as { messages?: Message[] }).messages ?? []
        fire('app_open')
      }
    } catch {
      /* the next load tries again */
    } finally {
      if (!stopped) timer = setTimeout(() => void load(), DAY)
    }
  }
  void load()
  // what was held back while opted out runs now
  const optIn = a.optIn
  a.optIn = function (this: Glyphway): void {
    optIn.call(this)
    void load()
  }

  return {
    triggerMessage: (id) => {
      const m = list.find((x) => String(x.id) === String(id))
      if (m && !suppressed) void render(m)
    },
    suppressMessages: (on) => {
      suppressed = on
    },
    isSuppressed: () => suppressed,
    stop: () => {
      stopped = true
      clearTimeout(timer)
      a.capture = capture
      a.optIn = optIn
      open?.close()
    },
  }
}
