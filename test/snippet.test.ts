import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Glyphway } from '../src/core'
import { install } from '../src/snippet'
import { HOST, mockFetch, useEnv } from './helpers'

// happy-dom replaces the global URL, so resolve from the package root (vitest's cwd).
const ROOT = resolve(__dirname, '..')
const SNIPPET = readFileSync(resolve(ROOT, 'snippet.js'), 'utf8').trim()

describe('<script> snippet (snippet.js)', () => {
  useEnv()

  it('stubs every method, queues calls, injects the async script, and the bundle replays them', async () => {
    const f = mockFetch()
    const added: { src?: string; async?: boolean }[] = []
    const fakeDoc = { createElement: () => ({}), head: { appendChild: (s: object) => added.push(s) } }
    const w = window as unknown as { glyphway?: unknown }
    delete w.glyphway
    new Function('window', 'document', SNIPPET)(window, fakeDoc)
    expect(added).toEqual([{ async: true, src: 'YOUR_SCRIPT_ADDRESS' }])
    const stub = w.glyphway as Record<string, (...a: unknown[]) => void>
    stub.init!('wk_snippet', { host: HOST, capturePageview: false, autocapture: false })
    stub.identify!('u-1', { plan: 'pro' })
    stub.capture!('clicked', { n: 2 })
    // the bundle loads (iife.ts calls install)
    const a = new Glyphway()
    install(a)
    expect(w.glyphway).toBe(a)
    await a.flush()
    expect(f.events().map((e) => [e.event, e.distinct_id])).toEqual([
      ['$identify', 'u-1'],
      ['clicked', 'u-1'],
    ])
    a.teardown_()
    // loading the snippet twice is a no-op
    new Function('window', 'document', SNIPPET)(window, fakeDoc)
    expect(added).toHaveLength(1)
  })

  it('README embeds the same snippet', () => {
    const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8')
    expect(readme).toContain(SNIPPET)
  })
})
