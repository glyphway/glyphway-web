// What surveys and in-app messages draw with.
//
// Everything lives in a shadow root, so the page's CSS can't reach in and ours
// can't leak out. Text from the server goes through `textContent` only.
export interface Theme {
  background?: string
  color?: string
  accent?: string
}

const CSS = `
:host{all:initial}
.box{font:14px/1.45 system-ui,sans-serif;background:var(--bg,#fff);color:var(--fg,#1f1f1f);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.28);padding:16px;box-sizing:border-box;max-width:360px;width:calc(100vw - 32px);position:relative}
.wrap{position:fixed;z-index:2147483000}
.corner{right:16px;bottom:16px}
.top{left:0;right:0;top:0}.top .box{max-width:none;width:100%;border-radius:0}
.center{inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}
h2{font-size:16px;margin:0 24px 8px 0}
p{margin:0 0 12px}
img{display:block;max-width:100%;border-radius:8px;margin-bottom:12px}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid transparent;padding:8px 12px}
.go{background:var(--accent,#1a73e8);color:#fff}
.plain{background:transparent;color:inherit;border-color:rgba(127,127,127,.5)}
.x{position:absolute;right:8px;top:8px;background:transparent;color:inherit;padding:2px 8px}
.row{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}
.scale{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px}
.scale button{flex:1 0 28px;padding:6px 0}
.pick{background:var(--accent,#1a73e8);color:#fff}
label{display:block;margin-bottom:6px}
textarea{font:inherit;width:100%;box-sizing:border-box;min-height:72px;margin-bottom:12px;border:1px solid rgba(127,127,127,.5);border-radius:8px;padding:8px;background:transparent;color:inherit}
`

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: { text?: string; class?: string } = {}, ...kids: Node[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (props.text !== undefined) e.textContent = props.text
  if (props.class) e.className = props.class
  e.append(...kids)
  return e
}

export interface Overlay {
  box: HTMLElement
  close(): void
}

/** Draws an empty box in a shadow root; the caller fills it. */
export function overlay(place: 'corner' | 'top' | 'center', theme: Theme, onClose: () => void): Overlay {
  const host = document.createElement('div')
  host.setAttribute('data-glyphway-overlay', '')
  const root = host.attachShadow({ mode: 'open' })
  const style = el('style', { text: CSS })
  const box = el('div', { class: 'box' })
  box.setAttribute('role', 'dialog')
  // only values a colour can be, since these go into a style
  const safe = (v?: string): string | undefined => (v && /^[#\w(),.%\s-]{1,40}$/.test(v) ? v : undefined)
  for (const [name, v] of [['--bg', theme.background], ['--fg', theme.color], ['--accent', theme.accent]] as const) {
    const c = safe(v)
    if (c) box.style.setProperty(name, c)
  }
  const wrap = el('div', { class: `wrap ${place}` }, box)
  root.append(style, wrap)
  document.body.append(host)
  return {
    box,
    close: () => {
      host.remove()
      onClose()
    },
  }
}

export const closeButton = (label: string, fn: () => void): HTMLButtonElement => {
  const b = el('button', { class: 'x', text: '×' })
  b.setAttribute('aria-label', label)
  b.onclick = fn
  return b
}

/** `http` and `https` only: a `javascript:` URL from a payload must not run. */
export const safeUrl = (u: unknown): string | undefined => {
  if (typeof u !== 'string') return undefined
  try {
    const p = new URL(u, location.href)
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : undefined
  } catch {
    return undefined
  }
}
