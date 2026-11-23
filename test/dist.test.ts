// Smoke test of the *built* bundles (minified, internal names mangled).
// Skipped until `pnpm build` has produced dist/. `pnpm check` builds first.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HOST, mockFetch, useEnv } from './helpers'

const ROOT = resolve(__dirname, '..')
const IIFE = resolve(ROOT, 'dist/glyphway.js')
const ESM_CORE = resolve(ROOT, 'dist/core.mjs')

describe.skipIf(!existsSync(IIFE) || !existsSync(ESM_CORE))('built bundles', () => {
  useEnv()

  it('dist/glyphway.js: snippet replay, pageview, autocapture, identify, flush, page-hide beacon', async () => {
    const f = mockFetch()
    const w = window as unknown as { glyphway?: unknown }
    w.glyphway = { _q: [['init', ['wk_dist', { host: HOST }]], ['capture', ['queued_early']]] }
    new Function(readFileSync(IIFE, 'utf8'))()
    const a = w.glyphway as {
      identify(id: string): void
      capture(e: string, p?: object): void
      flush(): Promise<void>
      getDistinctId(): string
      getSessionId(): string
    }
    expect(typeof a.capture).toBe('function')
    document.body.innerHTML = '<button id="b">Go</button>'
    document.getElementById('b')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 2 }))
    a.identify('dist-user')
    a.capture('after', { k: 1 })
    await a.flush()
    const evs = f.events()
    expect(evs.map((e) => e.event)).toEqual(['$pageview', 'queued_early', '$autocapture', '$identify', 'after'])
    expect(evs[2]!.properties.$elements_chain).toMatch(/^button:attr__id="b"/)
    expect(evs.at(-1)!.distinct_id).toBe('dist-user')
    expect(a.getSessionId()).toBe(evs[0]!.properties.$session_id)
    expect(f.sent[0]!.headers.Authorization).toBe('Bearer wk_dist')
    a.capture('on-hide')
    window.dispatchEvent(new Event('pagehide'))
    const body = JSON.parse(vi.mocked(navigator.sendBeacon).mock.calls[0]![1] as string)
    expect(body.api_key).toBe('wk_dist')
    expect(body.batch.map((e: { event: string }) => e.event).filter((e: string) => e !== '$$heatmap')).toEqual(['on-hide', '$pageleave'])
    expect(localStorage.getItem('an_wk_dist')).toContain('dist-user')
  })

  it('dist/core.mjs: ESM core works and has no autocapture', async () => {
    const f = mockFetch()
    const mod = await import(/* @vite-ignore */ ESM_CORE)
    const a = new mod.Glyphway()
    a.init('wk_esm', { host: HOST, capturePageview: false })
    document.body.innerHTML = '<button id="b">Go</button>'
    document.getElementById('b')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    a.capture('esm_event')
    await a.flush()
    expect(f.events().map((e) => e.event)).toEqual(['esm_event'])
    expect(mod.default).toBeInstanceOf(mod.Glyphway)
    expect(mod.VERSION).toBe('1.0.0')
  })
})
