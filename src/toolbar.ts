// The web toolbar. A lazy script the core loads only when the
// page was opened with `#an_toolbar=<token>`. It talks to the box with that read-only token, from this
// browser, and draws in a shadow root so the site's CSS can't reach it.
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals'
import type { Glyphway } from './core'
import { el } from './overlay'
import type { GlyphwayEvent } from './types'

export interface ToolbarOptions {
  token: string
  /** The console's address. */
  api: string
  /** What this page queued, newest last (the core keeps the last 100). */
  events: GlyphwayEvent[]
}

interface HeatResult {
  bin: number
  bins: [number, number, number][]
  fixed_bins: [number, number, number][]
  total: number
}
interface FlagRow {
  key: string
  active: boolean
  filters?: { multivariate?: { variants?: { key: string }[] } }
}

/** An action as `GET /actions` returns it (only what matching reads). */
export interface ActionRow {
  id: number
  name: string
  steps: { event?: string | null; url?: string | null; url_matching?: string; text?: string | null; selector?: string | null }[]
}
/** The step the app's action editor is filled with. */
export interface ActionStepOut {
  event: string
  url: string
  url_matching: 'contains'
  text: string | null
  selector: string
  properties: never[]
}

const STORE = 'an_toolbar_flags'
const MAX_CANVAS = 16384
const DAY = 86_400_000

const STYLE = `
:host{all:initial;position:absolute;top:0;left:0;z-index:2147483000}
canvas{position:absolute;top:0;left:0;pointer-events:none}
canvas.fix{position:fixed}
.panel{position:fixed;right:12px;bottom:12px;width:340px;max-height:70vh;overflow:auto;box-sizing:border-box;font:13px/1.4 system-ui,sans-serif;background:#fff;color:#1f1f1f;border:1px solid #c9c9c9;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.3);padding:10px}
.bar{display:flex;gap:4px;align-items:center;margin-bottom:8px}
.bar b{flex:1}
button,select{font:inherit}
.tabs{display:flex;gap:2px;margin-bottom:8px}
.tabs button{flex:1;padding:4px 2px;border:1px solid #c9c9c9;background:#f4f4f4;border-radius:6px;cursor:pointer}
.tabs button[aria-selected=true]{background:#1a73e8;color:#fff;border-color:#1a73e8}
.row{display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap}
.row select{max-width:150px}
.muted{color:#666}
.err{color:#b3261e}
pre{margin:2px 0 6px;white-space:pre-wrap;word-break:break-all;font-size:11px}
.good{color:#0b7a3b}.needs-improvement{color:#a65b00}.poor{color:#b3261e}
.hl{position:fixed;pointer-events:none;border:2px solid #1a73e8;background:rgba(26,115,232,.15);display:none}
.hl.on{border-color:#0b7a3b;background:rgba(11,122,59,.12);color:#0b7a3b;font:700 12px system-ui,sans-serif}
.sel{word-break:break-all;font-family:ui-monospace,monospace;font-size:12px}
`

const esc = (s: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'))

/** A selector that finds exactly this element: an id if unique, else a short path. */
export function selectorFor(target: Element, doc: Document = document): string {
  const parts: string[] = []
  for (let cur: Element | null = target; cur && cur !== doc.documentElement; cur = cur.parentElement) {
    if (cur.id && doc.querySelectorAll('#' + esc(cur.id)).length === 1) {
      parts.unshift('#' + esc(cur.id))
      break
    }
    let part = cur.tagName.toLowerCase()
    part += Array.from(cur.classList)
      .filter((c) => /^[a-z][\w-]{0,30}$/i.test(c) && !/\d{3,}/.test(c))
      .slice(0, 2)
      .map((c) => '.' + esc(c))
      .join('')
    const same = cur.parentElement ? Array.from(cur.parentElement.children).filter((s) => s.tagName === cur!.tagName) : []
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`
    parts.unshift(part)
    if (doc.querySelectorAll(parts.join(' > ')).length === 1) break
  }
  const sel = parts.join(' > ')
  try {
    if (doc.querySelector(sel) === target) return sel
  } catch {
    /* fall through to the plain path */
  }
  // the plain path: every level by position
  const path: string[] = []
  for (let cur: Element | null = target; cur && cur !== doc.documentElement; cur = cur.parentElement) {
    const sibs = cur.parentElement ? Array.from(cur.parentElement.children).filter((s) => s.tagName === cur!.tagName) : []
    path.unshift(cur.tagName.toLowerCase() + (sibs.length > 1 ? `:nth-of-type(${sibs.indexOf(cur) + 1})` : ''))
  }
  return path.join(' > ')
}

/** Heat on a canvas, the same red-green ramp as the app. Exported for the test. */
export function paint(canvas: HTMLCanvasElement, bins: [number, number, number][], bin: number, scale = 1): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  if (!bins.length) return
  const layer = document.createElement('canvas')
  layer.width = w
  layer.height = h
  const g = layer.getContext('2d')!
  const max = Math.max(1, ...bins.map((b) => b[2]))
  const r = bin * 2.4 * scale
  for (const [bx, by, n] of bins) {
    const cx = (bx + 0.5) * bin * scale
    const cy = (by + 0.5) * bin * scale
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r)
    grad.addColorStop(0, `rgba(0,0,0,${Math.max(0.12, Math.min(1, n / max))})`)
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grad
    g.fillRect(cx - r, cy - r, r * 2, r * 2)
  }
  const img = g.getImageData(0, 0, w, h)
  const px = img.data
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]!
    if (!a) continue
    const t = a / 255
    px[i] = t < 0.5 ? Math.round(30 + t * 2 * 225) : 235
    px[i + 1] = t < 0.5 ? 170 : Math.round(170 - (t - 0.5) * 2 * 140)
    px[i + 2] = 60
    px[i + 3] = Math.min(235, Math.round(70 + t * 190))
  }
  ctx.putImageData(img, 0, 0)
}

/** A selector the project's action rules accept: tags, #id and .class only, joined by `>`, at most four levels. */
export function actionSelector(target: Element, doc: Document = document): string {
  const parts: string[] = []
  for (let cur: Element | null = target; cur && cur !== doc.documentElement && parts.length < 4; cur = cur.parentElement) {
    if (/^[A-Za-z][\w-]*$/.test(cur.id) && doc.querySelectorAll('#' + cur.id).length === 1) {
      parts.unshift('#' + cur.id)
      break
    }
    const cls = Array.from(cur.classList).filter((c) => /^[A-Za-z][\w-]{0,30}$/.test(c) && !/\d{3,}/.test(c)).slice(0, 2)
    parts.unshift(cur.tagName.toLowerCase() + cls.map((c) => '.' + c).join(''))
  }
  return parts.join(' > ')
}

export const elementText = (t: Element): string => (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100)

/** An autocapture click step for this element: its selector, its text when it has no children, and this page's path. */
export function stepFor(t: Element, loc: Pick<Location, 'pathname'> = location): ActionStepOut {
  const text = elementText(t)
  return { event: '$autocapture', url: loc.pathname, url_matching: 'contains', text: text && !t.children.length ? text : null, selector: actionSelector(t), properties: [] }
}

/** The elements on this page the project's actions point at, with the action's 1-based place in the list. */
export function actionTargets(rows: ActionRow[], doc: Document = document, href: string = location.href): [Element, number][] {
  const out: [Element, number][] = []
  rows.forEach((r, i) => {
    for (const s of r.steps) {
      if (s.event && s.event !== '$autocapture') continue
      try {
        if (s.url && !(s.url_matching === 'exact' ? href === s.url : s.url_matching === 'regex' ? new RegExp(s.url).test(href) : href.includes(s.url))) continue
        if (s.selector) doc.querySelectorAll(s.selector).forEach((e) => (!s.text || elementText(e) === s.text) && out.push([e, i + 1]))
        else if (s.text) doc.querySelectorAll('a,button,summary,[role=button]').forEach((e) => elementText(e) === s.text && out.push([e, i + 1]))
      } catch {
        /* a step the browser cannot read matches nothing here */
      }
    }
  })
  return out
}

const select = (label: string, options: [string, string][], value: string, on: (v: string) => void): HTMLSelectElement => {
  const s = el('select')
  s.setAttribute('aria-label', label)
  for (const [v, t] of options) {
    const op = el('option', { text: t })
    op.value = v
    s.append(op)
  }
  s.value = value
  s.onchange = () => on(s.value)
  return s
}

/** Starts the toolbar on this page. Returns how to take it down. */
export function toolbar(a: Glyphway, o: ToolbarOptions): () => void {
  let origin: string
  try {
    const u = new URL(o.api)
    if (!/^https?:$/.test(u.protocol) || !/^at_\d+_/.test(o.token)) return () => {}
    origin = u.origin
  } catch {
    return () => {}
  }
  const base = `${origin}/api/projects/${o.token.split('_')[1]}`
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const r = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${o.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!r.ok) throw new Error(r.status === 401 ? 'The token ran out (1 hour). Open the toolbar from the app again.' : r.status === 403 ? 'This page is not an authorised URL of the project.' : `The box answered ${r.status}.`)
    return (await r.json()) as T
  }

  const host = document.createElement('div')
  host.setAttribute('data-glyphway-toolbar', '')
  const root = host.attachShadow({ mode: 'open' })
  const heat = el('canvas')
  const fix = el('canvas', { class: 'fix' })
  const hl = el('div', { class: 'hl' })
  const body = el('div')
  const panel = el('div', { class: 'panel' })
  panel.setAttribute('role', 'region')
  panel.setAttribute('aria-label', 'Glyphway toolbar')
  root.append(el('style', { text: STYLE }), heat, fix, hl, panel)
  document.body.append(host)

  // ---- heatmap
  const f = { type: 'click', days: '7', mode: 'total', fixed: 'keep', show: true }
  const note = el('div', { class: 'muted' })
  const size = (): void => {
    const d = document.documentElement
    const w = Math.min(MAX_CANVAS, Math.max(d.scrollWidth, innerWidth))
    const h = Math.min(MAX_CANVAS, Math.max(d.scrollHeight, innerHeight))
    heat.width = w
    heat.height = h
    heat.style.width = w + 'px'
    heat.style.height = h + 'px'
    fix.width = innerWidth
    fix.height = innerHeight
    fix.style.width = '100vw'
    fix.style.height = '100vh'
  }
  let last: HeatResult | null = null
  const draw = (): void => {
    size()
    heat.style.display = fix.style.display = f.show ? '' : 'none'
    if (last && f.show) {
      paint(heat, last.bins, last.bin)
      paint(fix, last.fixed_bins, last.bin)
    }
  }
  const load = async (): Promise<void> => {
    note.className = 'muted'
    note.textContent = 'Loading…'
    try {
      const now = Date.now()
      last = await call<HeatResult>('/heatmaps/query', {
        url: location.origin + location.pathname, type: f.type, from: now - Number(f.days) * DAY, to: now,
        width: Math.min(20000, Math.max(100, innerWidth)), tolerance: 0.1, mode: f.mode, fixed: f.fixed,
      })
      note.textContent = `${last.total} points, bins of ${last.bin} px`
      draw()
    } catch (e) {
      note.className = 'err'
      note.textContent = (e as Error).message
    }
  }
  const tabHeat = (): Node => {
    const show = el('input')
    show.type = 'checkbox'
    show.checked = f.show
    show.onchange = () => {
      f.show = show.checked
      draw()
    }
    const label = el('label', { text: ' Show heat' })
    label.prepend(show)
    return el('div', {}, el('div', { class: 'row' },
      select('Type', [['click', 'Clicks'], ['rageclick', 'Rage clicks'], ['deadclick', 'Dead clicks'], ['mousemove', 'Mouse moves']], f.type, (v) => ((f.type = v), void load())),
      select('Range', [['1', 'Last day'], ['7', 'Last 7 days'], ['30', 'Last 30 days']], f.days, (v) => ((f.days = v), void load()))),
    el('div', { class: 'row' },
      select('Mode', [['total', 'Total'], ['unique', 'Unique users']], f.mode, (v) => ((f.mode = v), void load())),
      select('Fixed elements', [['keep', 'Fixed: keep'], ['scroll', 'Fixed: as page'], ['hide', 'Fixed: hide']], f.fixed, (v) => ((f.fixed = v), void load()))),
    el('div', { class: 'row' }, label), note)
  }

  // ---- flag overrides, kept in this browser and applied only while the toolbar is open
  let overrides: Record<string, string> = {}
  try {
    overrides = JSON.parse(localStorage.getItem(STORE) || '{}') as Record<string, string>
  } catch {
    /* none */
  }
  const parseVal = (v: string): boolean | string => (v === 'true' ? true : v === 'false' ? false : v)
  const applyOverrides = (): void => {
    const map: Record<string, boolean | string> = {}
    for (const [k, v] of Object.entries(overrides)) map[k] = parseVal(v)
    a.flagsModule?.overrideFeatureFlags(Object.keys(map).length ? map : false)
    try {
      localStorage.setItem(STORE, JSON.stringify(overrides))
    } catch {
      /* private mode */
    }
  }
  // the page's flags module may start after the toolbar
  let tries = 0
  const wait = setInterval(() => {
    if (a.flagsModule || ++tries > 40) {
      clearInterval(wait)
      if (Object.keys(overrides).length) applyOverrides()
    }
  }, 500)
  const tabFlags = (): Node => {
    const box = el('div', {}, el('div', { class: 'muted', text: 'Loading…' }))
    void call<FlagRow[]>('/flags').then((rows) => {
      box.replaceChildren(el('div', { class: 'muted', text: 'Overrides stay in this browser and apply only while the toolbar is open.' }))
      for (const fl of rows) {
        const variants = fl.filters?.multivariate?.variants?.map((v) => v.key) ?? []
        const opts: [string, string][] = [['', 'No override'], ...(variants.length ? variants.map((k): [string, string] => [k, k]) : [['true', 'On'], ['false', 'Off']] as [string, string][])]
        box.append(el('div', { class: 'row' }, el('span', { text: fl.key + (fl.active ? '' : ' (off)') }),
          select(`Override ${fl.key}`, opts, overrides[fl.key] ?? '', (v) => {
            if (v) overrides[fl.key] = v
            else delete overrides[fl.key]
            applyOverrides()
          })))
      }
      if (!rows.length) box.append(el('div', { class: 'muted', text: 'No flags yet.' }))
    }).catch((e: Error) => box.replaceChildren(el('div', { class: 'err', text: e.message })))
    return box
  }

  // ---- what this page sends
  const tabEvents = (): Node => {
    const box = el('div')
    const render = (): void => {
      box.replaceChildren(el('div', { class: 'muted', text: `${o.events.length} events queued by this page (newest first).` }))
      for (const e of o.events.slice().reverse()) {
        const d = el('details', {}, el('summary', { text: `${e.event} · ${e.timestamp.slice(11, 23)}` }), el('pre', { text: JSON.stringify(e.properties, null, 1) }))
        box.append(d)
      }
    }
    render()
    const t = setInterval(() => (box.isConnected ? render() : clearInterval(t)), 1500)
    return box
  }

  // ---- this page's vitals
  const vit: Record<string, Metric> = {}
  const track = (m: Metric): void => void (vit[m.name] = m)
  for (const on of [onLCP, onINP, onCLS, onFCP, onTTFB]) on(track, { reportAllChanges: true })
  const tabVitals = (): Node => {
    const box = el('div')
    const render = (): void => {
      box.replaceChildren()
      for (const n of ['LCP', 'INP', 'CLS', 'FCP', 'TTFB']) {
        const m = vit[n]
        const v = m ? (n === 'CLS' ? m.value.toFixed(3) : Math.round(m.value) + ' ms') : 'waiting (INP needs an interaction)'
        box.append(el('div', { class: 'row' }, el('b', { text: n }), el('span', { class: m?.rating ?? 'muted', text: v })))
      }
    }
    render()
    const t = setInterval(() => (box.isConnected ? render() : clearInterval(t)), 1000)
    return box
  }

  // ---- the picker: one element, by hovering and clicking; Escape cancels
  const picked = el('div', { class: 'sel' })
  const stops = new Set<() => void>()
  const startPick = (done: (t: Element) => void, ended: () => void): (() => void) => {
    const mine = (e: Event): boolean => e.composedPath().includes(host)
    const over = (e: MouseEvent): void => {
      const t = e.target as Element
      if (mine(e) || !t.getBoundingClientRect) return
      const r = t.getBoundingClientRect()
      Object.assign(hl.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
    }
    const click = (e: MouseEvent): void => {
      if (mine(e)) return
      e.preventDefault()
      e.stopPropagation()
      const t = e.target as Element
      stop()
      done(t)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') stop()
    }
    const stop = (): void => {
      document.removeEventListener('mouseover', over, true)
      document.removeEventListener('click', click, true)
      document.removeEventListener('keydown', key, true)
      hl.style.display = 'none'
      stops.delete(stop)
      ended()
    }
    document.addEventListener('mouseover', over, true)
    document.addEventListener('click', click, true)
    document.addEventListener('keydown', key, true)
    stops.add(stop)
    return stop
  }
  let picking: (() => void) | null = null
  const pick = (): void => {
    if (picking) return picking()
    pickBtn.textContent = 'Cancel pick'
    picking = startPick((t) => {
      const sel = selectorFor(t)
      picked.textContent = sel
      // the app that opened this page fills it into the experiment
      if (window.opener) (window.opener as Window).postMessage({ type: 'an_selector', selector: sel }, origin)
    }, () => {
      picking = null
      pickBtn.textContent = 'Pick element'
    })
  }
  const pickBtn = el('button', { text: 'Pick element' })
  pickBtn.onclick = pick

  // ---- actions: inspect an element and make an action of it; show where the existing ones sit
  const badges = el('div')
  root.append(badges)
  let rows: ActionRow[] | null = null
  let shown = false
  const place = (): void => {
    badges.replaceChildren()
    if (!shown || !rows) return
    for (const [e, n] of actionTargets(rows)) {
      const r = e.getBoundingClientRect()
      const b = el('div', { class: 'hl on', text: String(n) })
      Object.assign(b.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
      badges.append(b)
    }
  }
  const tabActions = (): Node => {
    const out = el('div')
    const info = el('div', { class: 'muted' })
    const detail = el('div')
    const inspectBtn = el('button', { text: 'Inspect elements' })
    const showBtn = el('button', { text: shown ? 'Hide actions on page' : 'Show actions on page' })
    const load = async (): Promise<void> => {
      try {
        rows = await call<ActionRow[]>('/actions')
        info.textContent = `${rows.length} actions in this project.`
      } catch (e) {
        info.className = 'err'
        info.textContent = (e as Error).message
      }
    }
    inspectBtn.onclick = () => {
      if (inspecting) return inspecting()
      inspectBtn.textContent = 'Stop inspecting'
      inspecting = startPick((t) => {
        const step = stepFor(t)
        const hit = rows ? actionTargets(rows).filter(([e]) => e === t || e.contains(t)).map(([, n]) => rows![n - 1]!.name) : []
        detail.replaceChildren(
          el('div', { class: 'sel', text: step.selector }),
          el('div', { class: 'muted', text: `Text: ${step.text ?? '(none)'}` }),
          el('div', { class: 'muted', text: `Page: ${step.url}` }),
          el('div', { class: hit.length ? 'good' : 'muted', text: hit.length ? `Already in: ${[...new Set(hit)].join(', ')}` : 'Not in any action yet.' }),
        )
        const make = el('button', { text: 'Create action from this element' })
        make.onclick = () => {
          // the app that opened this page fills its action editor; without it the step is shown to copy
          if (window.opener) (window.opener as Window).postMessage({ type: 'an_action', step }, origin)
          else detail.append(el('pre', { text: JSON.stringify(step, null, 1) }))
          make.textContent = window.opener ? 'Sent to the app' : 'Copy the step above'
        }
        detail.append(make)
      }, () => {
        inspecting = null
        inspectBtn.textContent = 'Inspect elements'
      })
    }
    showBtn.onclick = () => {
      shown = !shown
      showBtn.textContent = shown ? 'Hide actions on page' : 'Show actions on page'
      place()
    }
    out.append(el('div', { class: 'row' }, inspectBtn, showBtn), info, detail)
    void load().then(place)
    return out
  }
  let inspecting: (() => void) | null = null

  // ---- frame
  const tabs: [string, () => Node][] = [['Heatmap', tabHeat], ['Actions', tabActions], ['Flags', tabFlags], ['Events', tabEvents], ['Vitals', tabVitals]]
  const strip = el('div', { class: 'tabs' })
  strip.setAttribute('role', 'tablist')
  const show = (i: number): void => {
    Array.from(strip.children).forEach((b, j) => b.setAttribute('aria-selected', String(i === j)))
    body.replaceChildren(tabs[i]![1]())
  }
  tabs.forEach(([name], i) => {
    const b = el('button', { text: name })
    b.setAttribute('role', 'tab')
    b.onclick = () => show(i)
    strip.append(b)
  })
  const close = el('button', { text: '×' })
  close.setAttribute('aria-label', 'Close the toolbar')
  const stopAll = (): void => {
    clearInterval(wait)
    removeEventListener('resize', draw)
    removeEventListener('scroll', place, true)
    stops.forEach((s) => s())
    host.remove()
  }
  close.onclick = stopAll
  panel.append(el('div', { class: 'bar' }, el('b', { text: 'Glyphway toolbar' }), pickBtn, close), picked, strip, body)
  addEventListener('resize', draw)
  addEventListener('scroll', place, true)
  show(0)
  void load()
  return stopAll
}
