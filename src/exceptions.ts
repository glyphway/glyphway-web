import type { Glyphway } from './core'
import { disabled, emitter } from './feature'
import type { Props } from './types'

// Error tracking. A lazy module: it talks to the SDK through the public API only.
const MAX_VALUE = 8192
const MAX_FRAMES = 50
const MAX_CHAIN = 10
const MAX_KEYS = 64
const MAX_KEY_VALUE = 1024
const MAX_LOGS = 65536
const MAX_STEPS = 32768
const BUCKET = 10
const REFILL_MS = 10_000

export interface Frame {
  platform: string
  filename: string
  function: string
  lineno?: number
  colno?: number
  in_app: boolean
}

export interface ExceptionOptions {
  /** `window.onerror`. Default `true`. */
  errors?: boolean
  /** `unhandledrejection`. Default `true`. */
  rejections?: boolean
  /** `console.error`. Default `false`. */
  console?: boolean
  /** Whether a file is the app's own. Default: the page's origin, outside `node_modules`. */
  inApp?: (filename: string) => boolean
}

export interface ExceptionTracker {
  captureException(error: unknown, props?: Props): void
  /** A breadcrumb sent with the next exceptions. */
  addExceptionStep(message: string, props?: Props): void
  setCustomKey(key: string, value: string | number | boolean): void
  log(message: string): void
  stop(): void
}

const CHROME = /^\s*at (?:(.+?) )?\(?((?:[a-z][\w+.-]*:|\/).*?)(?::(\d+))?(?::(\d+))?\)?\s*$/i
const GECKO = /^\s*(.*?)@(.+?)(?::(\d+))?(?::(\d+))?\s*$/

const sameOrigin = (file: string): boolean => {
  try {
    return new URL(file, location.href).origin === location.origin && !file.includes('/node_modules/')
  } catch {
    return false
  }
}

/** Frames of a V8, Gecko or WebKit stack, the throwing call first. */
export function parseStack(stack: string, inApp: (f: string) => boolean = sameOrigin): Frame[] {
  const out: Frame[] = []
  for (const line of stack.split('\n')) {
    const m = CHROME.exec(line) || (line.includes('@') ? GECKO.exec(line) : null)
    if (!m || !m[2] || m[2] === '<anonymous>') continue
    const f: Frame = { platform: 'web:javascript', filename: m[2], function: m[1] || '?', in_app: inApp(m[2]) }
    if (m[3]) f.lineno = +m[3]
    if (m[4]) f.colno = +m[4]
    out.push(f)
    if (out.length === MAX_FRAMES) break
  }
  return out
}

interface Mechanism {
  handled: boolean
  type: string
  synthetic: boolean
}

const asError = (e: unknown): { name: string; message: string; stack?: string; cause?: unknown; synthetic: boolean } => {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack, cause: (e as { cause?: unknown }).cause, synthetic: false }
  if (typeof e === 'string') return { name: 'Error', message: e, synthetic: true }
  let text = ''
  try {
    text = JSON.stringify(e) ?? String(e)
  } catch {
    text = String(e)
  }
  return { name: 'Error', message: text, synthetic: true }
}

/** The exception and its causes: the one thrown first, each cause naming its parent. */
export function exceptionList(error: unknown, m: Mechanism, inApp?: (f: string) => boolean): Props[] {
  const list: Props[] = []
  const seen = new Set<unknown>()
  for (let e: unknown = error; e !== undefined && e !== null && !seen.has(e) && list.length < MAX_CHAIN; ) {
    seen.add(e)
    const x = asError(e)
    const id = list.length
    list.push({
      type: x.name,
      value: x.message.slice(0, MAX_VALUE),
      mechanism: { handled: m.handled, type: id ? 'chained' : m.type, synthetic: m.synthetic || x.synthetic, exception_id: id, ...(id && { parent_id: id - 1 }) },
      stacktrace: { type: 'raw', frames: x.stack ? parseStack(x.stack, inApp) : [] },
    })
    e = x.cause
  }
  return list
}

/** Per type: 10 at once, then one every 10 s (INV P9). */
export function rateLimiter(now: () => number = Date.now): (type: string) => boolean {
  const buckets = new Map<string, { n: number; at: number }>()
  return (type) => {
    const t = now()
    const b = buckets.get(type) || { n: BUCKET, at: t }
    const refill = Math.floor((t - b.at) / REFILL_MS)
    if (refill > 0) {
      b.n = Math.min(BUCKET, b.n + refill)
      b.at += refill * REFILL_MS
    }
    buckets.set(type, b)
    if (b.n < 1) return false
    b.n--
    return true
  }
}

/** Keep the newest entries that fit in `max` bytes of JSON. */
const newest = <T>(list: T[], max: number): T[] => {
  let size = 0
  let i = list.length
  while (i > 0) {
    size += JSON.stringify(list[i - 1]).length
    if (size > max) break
    i--
  }
  return list.slice(i)
}

/** Start capturing. Call it once, after `glyphway.init`. */
export function exceptions(a: Glyphway, o: ExceptionOptions = {}): ExceptionTracker {
  const off = disabled<ExceptionTracker>(a, 'errors', 'exceptions')
  if (off) return off
  const emit = emitter(a)
  const allowed = rateLimiter()
  const keys: Record<string, string | number | boolean> = {}
  let steps: Props[] = []
  let logs: string[] = []

  const send = (error: unknown, m: Mechanism, props?: Props): void => {
    const list = exceptionList(error, m, o.inApp)
    if (!allowed(String(list[0]?.type))) return
    emit('$exception', {
      $exception_list: list,
      $exception_level: 'error',
      ...(Object.keys(keys).length && { $exception_keys: { ...keys } }),
      ...(logs.length && { $exception_logs: logs }),
      ...(steps.length && { $exception_steps: steps }),
      ...props,
    })
  }

  const stops: (() => void)[] = []
  if (o.errors !== false) {
    const fn = (e: ErrorEvent): void => send(e.error ?? e.message, { handled: false, type: 'onerror', synthetic: !e.error })
    addEventListener('error', fn)
    stops.push(() => removeEventListener('error', fn))
  }
  if (o.rejections !== false) {
    const fn = (e: PromiseRejectionEvent): void => send(e.reason, { handled: false, type: 'onunhandledrejection', synthetic: false })
    addEventListener('unhandledrejection', fn)
    stops.push(() => removeEventListener('unhandledrejection', fn))
  }
  if (o.console) {
    const original = console.error
    console.error = (...args: unknown[]): void => {
      original.apply(console, args)
      send(args.find((x) => x instanceof Error) ?? args.map(String).join(' '), { handled: true, type: 'console', synthetic: false })
    }
    stops.push(() => {
      console.error = original
    })
  }

  return {
    captureException: (error, props) => send(error, { handled: true, type: 'generic', synthetic: false }, props),
    addExceptionStep: (message, props) => {
      steps = newest([...steps, { $message: message, $timestamp: new Date().toISOString(), ...props }], MAX_STEPS)
    },
    setCustomKey: (key, value) => {
      if (key in keys || Object.keys(keys).length < MAX_KEYS) keys[key] = typeof value === 'string' ? value.slice(0, MAX_KEY_VALUE) : value
    },
    log: (message) => {
      logs = newest([...logs, message], MAX_LOGS)
    },
    stop: () => stops.forEach((s) => s()),
  }
}
