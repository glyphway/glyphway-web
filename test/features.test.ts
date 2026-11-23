import { afterEach, describe, expect, it, vi } from 'vitest'
import { exceptions } from '../src/exceptions'
import { flags } from '../src/flags'
import { messages } from '../src/messages'
import { nocode } from '../src/nocode'
import { registerPush } from '../src/push'
import { remoteConfig } from '../src/remote-config'
import { startReplay } from '../src/replay'
import { surveys } from '../src/surveys'
import { vitals } from '../src/vitals'
import { memKV } from '../src/storage'
import { Glyphway } from '../src/core'
import { install } from '../src/snippet'
import type { Feature } from '../src/types'
import { HOST, KEY, kill, make, mockFetch, queued, setVisibility, useEnv } from './helpers'

const MIN = 60_000
const names = (a: Glyphway): string[] => queued(a).map((e) => e.event)
const ALL: Feature[] = ['analytics', 'errors', 'performance', 'replay', 'flags', 'remoteConfig', 'push', 'surveys', 'messages']
const without = (f: Feature): Feature[] => ALL.filter((x) => x !== f)

describe('features', () => {
  useEnv()
  afterEach(() => vi.restoreAllMocks())

  describe('default: every feature', () => {
    it('sends what it always did and no $session_start, with or without the setting', () => {
      for (const features of [undefined, ALL]) {
        localStorage.clear()
        const a = make({ capturePageview: true, features })
        a.capture('x')
        expect(names(a)).toEqual(['$pageview', 'x'])
        kill(a)
      }
    })

    it('a module started with features unset reaches the app capture', () => {
      const a = make()
      const t = exceptions(a)
      t.captureException(new Error('boom'))
      expect(names(a)).toEqual(['$exception'])
    })
  })

  describe('errors only', () => {
    it('sends $session_start first, then no pageview, pageleave or app events; capture() is ignored', () => {
      const a = make({ capturePageview: true, features: ['errors'] })
      a.capture('app event')
      expect(names(a)).toEqual(['$session_start'])
      const t = exceptions(a)
      t.captureException(new Error('boom'))
      expect(names(a)).toEqual(['$session_start', '$exception'])
      const e = queued(a)
      expect(e[0]!.properties.$session_id).toBe(e[1]!.properties.$session_id)
      expect(e[0]!.properties.$lib).toBe('web')
      expect(e[0]!.properties.$device_id).toBe(e[1]!.properties.$device_id)
    })

    it('an exception after the idle timeout gets a new session with its own $session_start first', () => {
      const a = make({ features: ['errors'] })
      const t = exceptions(a)
      const s1 = a.getSessionId()
      vi.advanceTimersByTime(30 * MIN + 1)
      t.captureException(new Error('late'))
      expect(names(a)).toEqual(['$session_start', '$session_start', '$exception'])
      const e = queued(a)
      expect(e[1]!.properties.$session_id).not.toBe(s1)
      expect(e[2]!.properties.$session_id).toBe(e[1]!.properties.$session_id)
    })

    it('the page becoming visible after the idle timeout starts a session; before it, not', () => {
      const a = make({ features: ['errors'] })
      vi.advanceTimersByTime(10 * MIN)
      setVisibility('hidden')
      setVisibility('visible')
      expect(names(a)).toEqual(['$session_start'])
      vi.advanceTimersByTime(30 * MIN + 1)
      setVisibility('hidden')
      setVisibility('visible')
      expect(names(a)).toEqual(['$session_start', '$session_start'])
    })

    it('a reload inside the session sends none; a reload after the idle timeout sends one', () => {
      const a = make({ features: ['errors'] })
      const s1 = a.getSessionId()
      kill(a)
      const b = make({ features: ['errors'] })
      expect(b.getSessionId()).toBe(s1)
      expect(names(b).filter((n) => n === '$session_start').length).toBe(0) // the first one was already queued by the page before
      kill(b)
      vi.advanceTimersByTime(30 * MIN + 1)
      const c = make({ features: ['errors'] })
      expect(c.getSessionId()).not.toBe(s1)
      // the earlier pages' queued events are adopted; the last one is this page's new session
      expect(queued(c).filter((e) => e.properties.$session_id === c.getSessionId()).map((e) => e.event)).toEqual(['$session_start'])
    })

    it('cookieless: every load is a new visitor and session, so one per load', () => {
      const a = make({ features: ['errors'], cookielessMode: 'always' })
      expect(names(a)).toEqual(['$session_start'])
      kill(a)
      const b = make({ features: ['errors'], cookielessMode: 'always' })
      expect(names(b)).toEqual(['$session_start'])
      expect(b.getSessionId()).not.toBe(a.getSessionId())
    })

    it('reset() starts a new session and says so', () => {
      const a = make({ features: ['errors'] })
      const s1 = a.getSessionId()
      a.reset()
      const e = queued(a)
      expect(e.map((x) => x.event)).toEqual(['$session_start', '$session_start'])
      expect(e[1]!.properties.$session_id).not.toBe(s1)
    })

    it('opted out: no $session_start', () => {
      const a = make({ features: ['errors'], optOutByDefault: true })
      expect(names(a)).toEqual([])
    })

    it('identity calls still send what they send today', () => {
      const a = make({ features: ['errors'] })
      a.identify('user-1', { plan: 'pro' })
      a.group('company', 'c1')
      expect(names(a)).toEqual(['$session_start', '$identify', '$groupidentify'])
    })

    it('adds $debug to $session_start when debug is on and warns once about capture()', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const a = make({ features: ['errors'], debug: true })
      a.capture('a')
      a.capture('b')
      expect(queued(a)[0]!.properties.$debug).toBe(true)
      expect(warn.mock.calls.filter((c) => String(c[1]).includes('capture() ignored: the analytics feature is off')).length).toBe(1)
    })

    it('no autocapture, heatmap, toolbar or navigation events', () => {
      const a = make({ autocapture: true, capturePageview: true, features: ['errors'] })
      document.body.innerHTML = '<button id="b">go</button>'
      document.getElementById('b')!.click()
      history.pushState(null, '', '/next')
      expect(names(a)).toEqual(['$session_start'])
    })

    it('pagehide sends no $pageleave', () => {
      const a = make({ capturePageview: true, features: ['errors'] })
      window.dispatchEvent(new Event('pagehide'))
      expect(names(a)).not.toContain('$pageleave')
    })

    it('the toolbar address is left alone', () => {
      history.replaceState(null, '', '/#an_toolbar=tok&an_api=x')
      make({ features: ['errors'] })
      expect(location.hash).toContain('an_toolbar=tok')
    })
  })

  describe('analytics only', () => {
    it('sends pageviews and app events, no $session_start; errors module is a no-op', () => {
      const a = make({ capturePageview: true, features: ['analytics'] })
      a.capture('x')
      const t = exceptions(a)
      t.captureException(new Error('no'))
      t.addExceptionStep('s')
      t.setCustomKey('k', 'v')
      t.log('l')
      t.stop()
      expect(names(a)).toEqual(['$pageview', 'x'])
    })

    it('the errors module adds no window listeners while off', () => {
      const add = vi.spyOn(window, 'addEventListener')
      const a = make({ features: ['analytics'] })
      add.mockClear()
      exceptions(a, { console: true })
      expect(add).not.toHaveBeenCalled()
    })
  })

  describe('every other feature off: no-op, default values, no request', () => {
    it('performance: vitals() starts nothing', () => {
      const a = make({ features: without('performance') })
      const add = vi.spyOn(window, 'addEventListener')
      const stop = vitals(a)
      expect(add).not.toHaveBeenCalled()
      expect(stop()).toBeUndefined()
    })

    it('flags: default values, no request, no $feature_flag_called, no storage', async () => {
      const f = mockFetch()
      const a = make({ features: without('flags') })
      const before = localStorage.length
      const fl = flags(a, { bootstrap: { flags: { x: true } } })
      expect(fl.isFeatureEnabled('x')).toBeUndefined()
      expect(fl.getFeatureFlag('x')).toBeUndefined()
      expect(fl.getFeatureFlagPayload('x')).toBeUndefined()
      expect(fl.getFeatureFlagResult('x')).toBeUndefined()
      expect(await fl.reloadFeatureFlags()).toBe(false)
      expect(fl.onFeatureFlags(() => {})).toBeTypeOf('function')
      fl.overrideFeatureFlags({ x: true })
      fl.stop()
      expect(f.fn).not.toHaveBeenCalled()
      expect(localStorage.length).toBe(before)
      expect(names(a)).toEqual([])
      expect(a.flagsModule).toBeUndefined()
    })

    it('remoteConfig: the defaults, no request, no storage', async () => {
      const f = mockFetch()
      const a = make({ features: without('remoteConfig') })
      const before = localStorage.length
      const rc = remoteConfig(a, { defaults: { s: 'hi', b: true, n: 3 } })
      expect(rc.getString('s')).toBe('hi')
      expect(rc.getBool('b')).toBe(true)
      expect(rc.getNumber('n')).toBe(3)
      expect(rc.getString('none')).toBe('')
      expect(rc.getAll()).toEqual({ s: 'hi', b: true, n: 3 })
      expect(await rc.fetchAndActivate()).toBe(false)
      expect(await rc.fetch()).toBe(false)
      expect(rc.onConfigUpdate(() => {})).toBeTypeOf('function')
      expect(f.fn).not.toHaveBeenCalled()
      expect(localStorage.length).toBe(before)
    })

    it('remoteConfig off: setDefaults answers as when on, and values stored by an earlier visit are not used', async () => {
      const f = mockFetch()
      const a = make({ features: without('remoteConfig') })
      const key = `an_rc_${a.getClient().writeKey}_a`
      localStorage.setItem(key, JSON.stringify({ version: 4, values: { s: { value: 'stored' } }, rollouts: [] }))
      const before = localStorage.length
      const rc = remoteConfig(a, { defaults: { s: 'hi' } })
      expect(rc.getString('s')).toBe('hi')
      rc.setDefaults({ s: 'later', b: 'yes', n: '7', j: '{"k":1}' })
      expect(rc.getString('s')).toBe('later')
      expect(rc.getBool('b')).toBe(true)
      expect(rc.getNumber('n')).toBe(7)
      expect(rc.getJSON('j')).toEqual({ k: 1 })
      expect(await rc.activate()).toBe(false)
      expect(f.fn).not.toHaveBeenCalled()
      expect(localStorage.length).toBe(before)
      localStorage.removeItem(key)
    })

    it('push: reports unsupported, asks for nothing', async () => {
      const a = make({ features: without('push') })
      const req = vi.fn()
      const r = await registerPush(a, { vapidKey: 'AAAA' }, { Notification: { requestPermission: req } as never, navigator: { serviceWorker: {} } as never })
      expect(r).toEqual({ state: 'unsupported' })
      expect(req).not.toHaveBeenCalled()
    })

    it('surveys and messages: nothing fetched or shown', () => {
      const f = mockFetch()
      const a = make({ features: without('surveys') })
      const s = surveys(a)
      expect(s.getActiveSurveys()).toEqual([])
      s.showSurvey('1')
      s.stop()
      const b = make({ features: without('messages') }, 'wk_other')
      const m = messages(b)
      expect(m.isSuppressed()).toBe(false)
      m.triggerMessage('1')
      m.suppressMessages(true)
      m.stop()
      expect(f.fn).not.toHaveBeenCalled()
      expect(document.body.innerHTML).toBe('')
    })

    it('replay: startReplay returns a stop function and records nothing', () => {
      const f = mockFetch()
      const a = make({ features: without('replay') })
      const stop = startReplay(a, { host: HOST, writeKey: KEY })
      expect(stop).toBeTypeOf('function')
      expect(f.fn).not.toHaveBeenCalled()
    })

    it('a module with its feature on still sends through the internal path while analytics is off', () => {
      const a = make({ features: ['flags'] })
      expect(names(a)).toEqual(['$session_start'])
      const fl = flags(a, { bootstrap: { flags: { x: true } }, manual: true, storage: memKV(), fetch: vi.fn() as never })
      expect(fl.getFeatureFlag('x')).toBe(true)
      expect(names(a)).toEqual(['$session_start', '$feature_flag_called'])
      expect(fl.analyticsOff).toBe(true)
    })

    it('no-code actions stay off with analytics', () => {
      const a = make({ features: ['flags'] })
      const fl = flags(a, { manual: true, storage: memKV(), fetch: vi.fn() as never })
      const onFlags = vi.spyOn(fl, 'onFeatureFlags')
      nocode(fl)()
      expect(onFlags).not.toHaveBeenCalled()
    })

    it('debug: one warning per method, naming the feature', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const a = make({ features: without('flags'), debug: true })
      const fl = flags(a)
      fl.getFeatureFlag('a')
      fl.getFeatureFlag('b')
      fl.isFeatureEnabled('a')
      const msgs = warn.mock.calls.map((c) => String(c[1]))
      expect(msgs.filter((m) => m.includes('flags().getFeatureFlag ignored: the flags feature is off')).length).toBe(1)
      expect(msgs.filter((m) => m.includes('flags().isFeatureEnabled ignored')).length).toBe(1)
    })
  })

  describe('rules', () => {
    it('rule 3: a feature on in `features` but off by its old switch stays off', () => {
      const a = make({ capturePageview: false, features: ['analytics'], autocapture: false })
      expect(names(a)).toEqual([])
    })

    it('rule 7: an empty set warns and sends nothing except identity', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const a = make({ features: [], capturePageview: true })
      a.capture('x')
      expect(warn).toHaveBeenCalled()
      exceptions(a).captureException(new Error('x'))
      expect(names(a)).toEqual([])
      a.identify('user-1')
      expect(names(a)).toEqual(['$identify'])
    })

    it('projectSettings never turn a feature on (it can only switch autocapture and friends off)', () => {
      mockFetch()
      const a = make({ features: ['errors'], projectSettings: true })
      expect(a.has_('analytics')).toBe(false)
      expect(a.ps_).toBeUndefined()
    })

    it('the snippet and the IIFE take `features` like the other options', () => {
      const w = window as unknown as { glyphway?: unknown }
      const stub = { _q: [['init', [KEY, { host: HOST, features: ['errors'], compression: 'none', projectSettings: false }]]] as [string, unknown[]][] }
      w.glyphway = stub
      const a = new Glyphway()
      install(a)
      expect(a.getClient().features).toEqual(['errors'])
      expect(queued(a).map((e) => e.event)).toEqual(['$session_start'])
      a.teardown_()
    })

    it('getClient() reports the features; unset means undefined', () => {
      expect(make().getClient().features).toBeUndefined()
    })
  })
})
