import { autocapture, capEl, elementsChain, elText, eventEl, isField, noCapture, path, rageCounter, tag } from './autocapture'
import type { Glyphway, Plugin } from './core'
import type { Props } from './types'

// Constants are posthog-js defaults and GA4's published lists.
const FLUSH_MS = 5000
const MOVE_MS = 500
const MUTATION_MS = 2500
const SCROLL_MS = 100
const SELECT_MS = 100
const LIVE_MS = 1000
const FILES = /\.(pdf|xlsx?|docx?|txt|rtf|csv|exe|key|pp(?:s|t|tx)|7z|pkg|rar|gz|zip|avi|mov|mp4|mpe?g|wmv|midi?|mp3|wav|wma)$/i
const SEARCH = ['q', 's', 'search', 'query', 'keyword']
const VIDEO_STEPS = [10, 25, 50, 75]

type On = (t: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions) => void
type Record_ = (e: MouseEvent, type: string) => void

const pinned = (el: Element | undefined): boolean => {
  for (let c: Element | null | undefined = el; c && tag(c) !== 'body'; c = c.parentElement)
    if (/^(fixed|sticky)$/.test(getComputedStyle(c).position)) return true
  return false
}

function heatmaps(a: Glyphway, on: On): { record: Record_; flush: () => void; stop: () => void } {
  let buf: Record<string, Props[]> = {}
  let move: ReturnType<typeof setTimeout> | undefined
  const rage = rageCounter()
  const record: Record_ = (e, type) => {
    const el = eventEl(e)
    if (!el || path(el).some(noCapture)) return
    const fixed = pinned(el)
    const url = location.href
    ;(buf[url] = buf[url] || []).push({
      x: e.clientX + (fixed ? 0 : window.scrollX),
      y: e.clientY + (fixed ? 0 : window.scrollY),
      target_fixed: fixed,
      type,
    })
  }
  const flush = (): void => {
    if (!Object.keys(buf).length) return
    const data = buf
    buf = {}
    a.capture_('$$heatmap', { $heatmap_data: data })
  }
  on(document, 'click', (e) => {
    const m = e as MouseEvent
    record(m, 'click')
    if (rage(m.clientX, m.clientY)) record(m, 'rageclick')
  })
  on(document, 'mousemove', (e) => {
    clearTimeout(move)
    move = setTimeout(() => record(e as MouseEvent, 'mousemove'), MOVE_MS)
  })
  const t = setInterval(() => {
    if (!document.hidden) flush()
  }, FLUSH_MS)
  return {
    record,
    flush,
    stop: () => {
      clearInterval(t)
      clearTimeout(move)
    },
  }
}

interface Click {
  t: number
  el: Element
  e: MouseEvent
  m?: number // ms to the first mutation
  s?: number // to the first scroll
  l?: number // to the first selection change
  v?: number // to the page being hidden or losing focus
}

function deadClicks(a: Glyphway, on: On, record: Record_ | undefined): () => void {
  let open: Click[] = []
  const mark = (k: 'm' | 's' | 'l' | 'v') => (): void => {
    const now = Date.now()
    for (const c of open) if (c[k] === undefined) c[k] = now - c.t
  }
  const mo = new MutationObserver(mark('m'))
  const within = (v: number | undefined, ms: number): boolean => v !== undefined && v < ms
  const check = (c: Click): void => {
    open = open.filter((x) => x !== c)
    if (!open.length) mo.disconnect()
    if (document.hidden || within(c.m, MUTATION_MS) || within(c.s, SCROLL_MS) || within(c.l, SELECT_MS) || within(c.v, LIVE_MS)) return
    const els = path(c.el)
    const text = elText(c.el)
    a.capture_('$dead_click', {
      $event_type: 'click',
      $elements_chain: elementsChain(els),
      ...(text && { $el_text: text }),
      $x: c.e.clientX,
      $y: c.e.clientY,
    })
    if (record) record(c.e, 'deadclick')
  }
  on(document, 'click', (e) => {
    const el = eventEl(e)
    if (!el || isField(el) || path(el).some(noCapture)) return
    const now = Date.now()
    if (open.some((x) => x.el === el && now - x.t < LIVE_MS)) return
    const c: Click = { t: now, el, e: e as MouseEvent }
    if (!open.length) mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    open.push(c)
    setTimeout(() => check(c), MUTATION_MS * 1.1)
  })
  on(window, 'scroll', mark('s'), { capture: true, passive: true })
  on(document, 'selectionchange', mark('l'))
  on(document, 'visibilitychange', mark('v'))
  on(window, 'blur', mark('v'))
  return () => mo.disconnect()
}

function measurement(a: Glyphway, on: On): void {
  on(document, 'click', (e) => {
    const el = eventEl(e)
    if (!el) return
    const els = path(el)
    const link = els.find((x) => tag(x) === 'a' && x.getAttribute('href')) as HTMLAnchorElement | undefined
    if (!link || els.some(noCapture) || !capEl(link)) return
    let u: URL
    try {
      u = new URL(link.getAttribute('href')!, location.href)
    } catch {
      return
    }
    if (!/^https?:$/.test(u.protocol)) return
    const p: Props = {
      $link_url: u.href,
      $link_domain: u.hostname,
      $link_text: elText(link),
      $link_id: link.id,
      $link_classes: link.getAttribute('class') || '',
    }
    const file = FILES.exec(u.pathname)
    if (file) a.capture_('$file_download', { ...p, $file_name: u.pathname, $file_extension: file[1]!.toLowerCase() })
    if (u.hostname !== location.hostname) a.capture_('$outbound_click', p)
  })

  const form = (f: Element): Props => ({
    $form_id: f.id,
    $form_name: f.getAttribute('name') || '',
    $form_destination: f.getAttribute('action') || '',
  })
  const started = new Set<string>()
  on(document, 'focusin', (e) => {
    const el = eventEl(e)
    const f = el && el.closest('form')
    if (!f || path(f).some(noCapture)) return
    const p = form(f)
    const key = [a.getSessionId(), p.$form_id, p.$form_name, p.$form_destination].join('|')
    if (started.has(key)) return
    started.add(key)
    a.capture_('$form_start', p)
  })
  on(document, 'submit', (e) => {
    const f = eventEl(e)
    if (f && tag(f) === 'form' && !path(f).some(noCapture)) a.capture_('$form_submit', form(f))
  })

  const video = (e: Event): HTMLVideoElement | undefined => {
    const v = e.target as HTMLVideoElement | null
    return v && v.nodeType === 1 && tag(v) === 'video' && !path(v).some(noCapture) ? v : undefined
  }
  const reached = new WeakMap<HTMLVideoElement, number>() // VIDEO_STEPS already sent
  const vp = (v: HTMLVideoElement, percent: number): Props => ({
    $video_url: v.currentSrc || v.getAttribute('src') || '',
    $video_title: v.title || v.getAttribute('aria-label') || '',
    $video_provider: 'html5',
    $video_duration: v.duration,
    $video_current_time: v.currentTime,
    $video_percent: percent,
  })
  on(document, 'play', (e) => {
    const v = video(e)
    if (!v || reached.has(v)) return
    reached.set(v, 0)
    a.capture_('$video_start', vp(v, 0))
  })
  on(document, 'timeupdate', (e) => {
    const v = video(e)
    if (!v || !v.duration) return
    let n = reached.get(v) || 0
    const at = (v.currentTime / v.duration) * 100
    for (; n < VIDEO_STEPS.length && at >= VIDEO_STEPS[n]!; n++) a.capture_('$video_progress', vp(v, VIDEO_STEPS[n]!))
    reached.set(v, n)
  })
  on(document, 'ended', (e) => {
    const v = video(e)
    if (!v) return
    a.capture_('$video_complete', vp(v, 100))
    reached.delete(v)
  })
}

/** Scroll depth of the current page, and everything that happens as a page changes. */
function pages(a: Glyphway, on: On, flush: () => void, enhanced: boolean): () => void {
  let path_: string | undefined
  let start = 0
  let lastY = 0
  let maxY = 0
  let maxH = 0
  let lastC = 0
  let maxC = 0
  let maxCH = 0
  let sent = false
  const read = (): void => {
    const s = document.scrollingElement || document.documentElement
    const y = s.scrollTop
    const c = y + s.clientHeight
    lastY = y
    maxY = Math.max(maxY, y)
    maxH = Math.max(maxH, s.scrollHeight - s.clientHeight)
    lastC = c
    maxC = Math.max(maxC, c)
    maxCH = Math.max(maxCH, s.scrollHeight)
  }
  const pct = (v: number, h: number): number => (h <= 1 ? 1 : Math.min(1, Math.max(0, Math.ceil(v) / Math.ceil(h))))
  on(
    window,
    'scroll',
    () => {
      read()
      if (enhanced && !sent && maxCH > 0 && maxC / maxCH >= 0.9) {
        sent = true
        a.capture_('$scroll', { $percent_scrolled: 90 })
      }
    },
    { capture: true, passive: true },
  )
  a.pg_ = {
    leave: () =>
      path_ === undefined
        ? {}
        : {
            $prev_pageview_pathname: path_,
            $prev_pageview_duration: (Date.now() - start) / 1000,
            $prev_pageview_last_scroll: Math.ceil(lastY),
            $prev_pageview_last_scroll_percentage: pct(lastY, maxH),
            $prev_pageview_max_scroll: Math.ceil(maxY),
            $prev_pageview_max_scroll_percentage: pct(maxY, maxH),
            $prev_pageview_last_content: Math.ceil(lastC),
            $prev_pageview_last_content_percentage: pct(lastC, maxCH),
            $prev_pageview_max_content: Math.ceil(maxC),
            $prev_pageview_max_content_percentage: pct(maxC, maxCH),
          },
    enter: () => {
      path_ = location.pathname
      start = Date.now()
      lastY = maxY = maxH = lastC = maxC = maxCH = 0
      sent = false
      read()
      if (!enhanced) return
      const q = new URLSearchParams(location.search)
      const term = SEARCH.map((k) => q.get(k)).find(Boolean)
      if (term) a.capture_('$view_search_results', { $search_term: term })
    },
    flush,
  }
  return () => {
    a.pg_ = undefined
  }
}

/** Everything the full build adds. Returns the teardown. */
export const full: Plugin = (a) => {
  const c = a.cfg_
  const stops: (() => void)[] = []
  const on: On = (t, type, fn, opts = { capture: true }) => {
    t.addEventListener(type, fn, opts)
    stops.push(() => t.removeEventListener(type, fn, opts))
  }
  stops.push(autocapture(a))
  const heat = c.heatmaps ? heatmaps(a, on) : undefined
  if (heat) stops.push(heat.stop)
  if (c.deadClicks) stops.push(deadClicks(a, on, heat && heat.record))
  if (c.enhancedMeasurement) measurement(a, on)
  stops.push(pages(a, on, heat ? heat.flush : () => {}, c.enhancedMeasurement))
  return () => stops.forEach((s) => s())
}
