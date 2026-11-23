How this SDK works inside: design choices, tests, limits. For how to use it, see [README.md](README.md).

# glyphway

Browser SDK for the self-hosted Glyphway platform. It speaks a PostHog-capture
shaped wire contract (`POST /batch`) and has no runtime dependencies.

## Install

### `<script>` snippet (IIFE, global `glyphway`)

Calls made before the bundle loads are queued and replayed. Getters
(`getDistinctId`, `getSessionId`, `hasOptedOut`) only exist once it has loaded.

```html
<script>
!function(w,d,u){if(w.glyphway)return;var a=w.glyphway={_q:[]};"init capture identify setPersonProperties alias group reset register unregister optIn optOut flush".split(" ").forEach(function(m){a[m]=function(){a._q.push([m,[].slice.call(arguments)])}});var s=d.createElement("script");s.async=!0;s.src=u;d.head.appendChild(s)}(window,document,"YOUR_SCRIPT_ADDRESS");
glyphway.init("YOUR_WRITE_KEY", { host: "YOUR_EDGE_ADDRESS" });
</script>
```

Use `glyphway.core.js` instead of `glyphway.js` for the build without autocapture.
The snippet source is `snippet.js` (a test keeps this copy in sync).

### npm (ESM)

```ts
import glyphway from 'glyphway'          // with autocapture
// import glyphway from 'glyphway/core'  // without autocapture (smaller)

glyphway.init('YOUR_WRITE_KEY', { host: 'YOUR_EDGE_ADDRESS' })
glyphway.capture('signup_started', { plan: 'pro' })
```

`Glyphway` (the class) is also exported if you need a second instance. Guides for React, Next.js, Vue, Svelte and Angular are in [FRAMEWORKS.md](FRAMEWORKS.md).

## API

| Call | What it does |
|---|---|
| `init(writeKey, options)` | Starts the SDK. `options.host` is required. A second call is ignored. |
| `capture(event, props?)` | Queues an event. The name must be 1–200 chars. |
| `identify(id, set?, setOnce?)` | Anonymous → `id`: sends `$identify` with `$anon_distinct_id` (plus `$set` / `$set_once`). The session continues. With the current id again, only `$set` is sent. |
| `setPersonProperties(set?, setOnce?)` | `$set` event without changing identity. |
| `alias(alias)` | `$create_alias` with `properties.alias` (merges `alias` into the current id). |
| `group(type, key, props?)` | Later events carry `$groups: {type: key}`. Sends `$groupidentify` (`$group_type`, `$group_key`, `$group_set`) when the group is new or changed, or props are given. |
| `reset(resetDeviceId?)` | New anonymous id, new session, new `$window_id`; super properties and groups cleared. `$device_id` is kept unless `true`. With the flags module loaded, `reset()` also clears the flag values, their stored copy and the record of reported flags (`$feature_flag_called` can fire again), then reloads. |
| `register(props)` / `unregister(name)` | Super properties, persisted, sent with every event (event props win). |
| `optIn()` / `optOut()` | Consent, remembered in `an_<key>_c`. `optOut` stops capture and clears the queue, and the lazy modules stop too (see Privacy). `optIn` sends `$opt_in` and the page's `$pageview` if it was skipped, and the modules ask again (flags, surveys, messages; Remote Config reopens its stream). |
| `hasOptedOut()` | Current consent state. |
| `flush()` | Sends the queue now; resolves when the attempt finishes. |
| `getDistinctId()` / `getSessionId()` | Current ids. |

### Options

| Option | Default | Notes |
|---|---|---|
| `host` | (required) | Edge base URL; trailing slash ignored. |
| `debug` | `false` | `$debug: true` on every event + console logging. |
| `autocapture` | `true` | Needs the full build; ignored by `core`. |
| `capturePageview` | `true` | Load + SPA history changes. |
| `capturePageleave` | `= capturePageview` | `$pageleave` with `$engagement_ms`. |
| `persistence` | `'localStorage'` | `'memory'`: nothing touches storage; every load is a new visitor + session. |
| `optOutByDefault` | `false` | Start opted out until `optIn()`. Nothing is written to storage meanwhile. |
| `cookielessMode` | – | `'always'` or `'on_reject'`: nothing is stored, every page load is a new visitor, events carry `$cookieless_mode`. `'on_reject'` starts at `optOut()`. The project must allow it (Settings, Website tracking) or these events are dropped. |
| `projectSettings` | `true` | Reads the project's switches (clicks and forms, dead clicks, heatmaps, cookieless) from the edge once at start. |
| `flushIntervalMs` | `10000` | Plus a flush at 20 queued events and on page hide. |
| `maxQueue` | `1000` | Events; the byte bound is fixed at 1 MB. Oldest dropped first. |
| `compression` | `'gzip'` | Uses `CompressionStream` when the browser has it. `'none'` sends plain JSON. |
| `features` | all | Which parts run; see [Choosing features](#choosing-features). `['errors']`, `['analytics']`, or any list of `'analytics' \| 'errors' \| 'performance' \| 'replay' \| 'flags' \| 'remoteConfig' \| 'push' \| 'surveys' \| 'messages'`. |
| `beforeSend` | – | `(event) => event \| null`. Runs last; return `null` to drop. The result is re-validated. |

## Errors and web vitals

Both are separate modules, loaded when you want them. Set `release` so crash-free rates and regressions can go by version.

```js
import glyphway from 'glyphway'
glyphway.init('wk_...', { host: 'YOUR_EDGE_ADDRESS', release: '2.0.1' })

const { exceptions } = await import('glyphway/exceptions')
const errors = exceptions(glyphway) // window errors and unhandled rejections from here on
errors.captureException(new Error('payment failed'), { order: 42 })
errors.addExceptionStep('opened checkout')
errors.setCustomKey('plan', 'pro')
errors.log('retrying')

const { vitals } = await import('glyphway/vitals')
vitals(glyphway) // one `$perf_web_vitals` when the page hides
```

With a `<script>` tag, load `glyphway.exceptions.js` or `glyphway.vitals.js` and call `glyphwayExceptions.exceptions(glyphway)` or `glyphwayVitals.vitals(glyphway)`.

`exceptions(glyphway, { console: true })` also reports `console.error`. Each error type sends 10 at once, then one every 10 seconds.

## Choosing features

By default everything runs, as before. `features` limits it:

```js
// Error tracking only: no pageviews, no autocapture, no toolbar; capture() is ignored.
import glyphway from 'glyphway/core'
import { exceptions } from 'glyphway/exceptions'
glyphway.init('wk_...', { host: 'YOUR_EDGE_ADDRESS', release: '2.0.1', features: ['errors'] })
const errors = exceptions(glyphway)

// Analytics only: errors, replay, flags and the rest are no-ops if something starts them.
import glyphway from 'glyphway'
glyphway.init('wk_...', { host: 'YOUR_EDGE_ADDRESS', features: ['analytics'] })
```

| Feature | What it covers on the web |
|---|---|
| `analytics` | `capture()`, `$pageview` / `$pageleave`, autocapture, heatmaps, dead and rage clicks, enhanced measurement, the toolbar and no-code actions. |
| `errors` | `exceptions()`: window errors, rejections, `captureException`, steps, custom keys, logs. |
| `performance` | `vitals()`. |
| `replay` | `startReplay()`. |
| `flags` | `flags()` and the `$feature_flag_called` events. |
| `remoteConfig` | `remoteConfig()`. |
| `push` | `registerPush()`. |
| `surveys` / `messages` | `surveys()` / `messages()`. |

Identity (`identify`, `alias`, `group`, `reset`, `register`, `optIn`, `optOut`, `flush`) is never a feature and always works.
A module started while its feature is off returns an object of the same type that does nothing: no listeners, requests or
storage writes, and default return values (flags `undefined`, Remote Config your `defaults`). With `debug` on it logs one
warning per method. The project's settings from the edge (`projectSettings`) apply inside `analytics`; they never turn a
feature on that `features` left off. An empty list warns and sends only what identity calls send.

**`$session_start`.** While `analytics` is off there are no pageviews to start a session, yet crash-free rates and release
adoption count sessions. So the SDK sends one `$session_start` (default properties only) each time a new session begins:
on a page load in a new session, when the page becomes visible after 30 minutes idle, when an event (an exception, a flag call)
arrives after the idle time or the 24 hour cap, and on `reset()`. In cookieless mode every page load is a new session, so
one per load. With `analytics` on it is never sent.

**Bundle size.** Not importing a module already keeps it out of your bundle, so the errors-only example above ships the
core plus `glyphway/exceptions`. `features` is for turning off what the core itself does and for the `<script>` snippet,
where `features` is passed to `init` like any other option.

## Events

| Event | When | Properties (besides the defaults) |
|---|---|---|
| `$pageview` | Load; SPA `pushState` / `replaceState` / `popstate` when the **pathname** changes; bfcache restore | `title` |
| `$pageleave` | `pagehide` (once per page view) and before each SPA `$pageview` | `$engagement_ms`; on SPA navigation also the left page's `$current_url` / `$pathname` |
| `$autocapture` | click on `a, button, form, input, select, textarea, label` (or inside one); `submit` on a form; `change` on `input, select, textarea` | `$event_type`, `$elements_chain`, `$el_text` (≤ 255), `$x` / `$y` (click, viewport-relative) |
| `$rageclick` | 3rd click, each within 30 px (Manhattan) and 1 s of the previous one, on any element | same as `$autocapture` |
| `$identify` | `identify()` from an anonymous id | `$anon_distinct_id`, `$set`, `$set_once` |
| `$set` | `identify()` with the current id + props, `setPersonProperties()` | `$set`, `$set_once` |
| `$create_alias` | `alias()` | `alias` |
| `$groupidentify` | `group()` | `$group_type`, `$group_key`, `$group_set` |
| `$opt_in` | `optIn()` | – |

### Default properties

Every event carries `$lib` (`"web"`), `$lib_version`, `$session_id`, `$window_id`, `$device_id`,
`$os`, `$os_version`, `$device_type` (Mobile / Tablet / Desktop), `$browser`, `$browser_version`,
`$screen_width`, `$screen_height`, `$viewport_width`, `$viewport_height`, `$locale`, `$timezone`,
`$current_url`, `$host`, `$pathname`, `$referrer`, `$referring_domain`. On the landing page it
also carries `utm_source|medium|campaign|term|content`, `gclid`, `fbclid`, `msclkid`, `ttclid`
(when present in the URL). Super properties, `$groups` and `$debug` are added when set.
`$lib`, `$lib_version`, `$session_id` and `$window_id` cannot be overridden by event properties.

Wire shape: `POST {host}/batch` with `Authorization: Bearer <writeKey>`, body
`{"batch":[{event, distinct_id, uuid, timestamp, properties}], "sent_at": "<ISO ms>"}`.

## Sessions and identity

- **Anonymous id:** UUIDv7, persisted in `an_<writeKey>`. `$device_id` = the first anonymous id (stable install id).
- **Session:** UUIDv7 `$session_id`, rotated after **30 min without a captured event** or **24 h** total, shared by all tabs. `identify()` keeps it; `reset()` starts a new one.
- **`$window_id`:** one per tab (sessionStorage `an_<writeKey>_w`). A duplicated tab gets a new one (a "primary" flag, cleared on `pagehide`, is detected), as in posthog-js.
- **Engagement:** `$engagement_ms` counts time the page is `visible` **and** the window has focus. It resets with each page view.

## Queue and transport

- In memory + mirrored to `localStorage` (one small key per event, `an_<writeKey>_q:<tab>:<uuid>`; events handed to the browser on page hide wait under `an_<writeKey>_qs` and the next page sends them again if nothing confirmed them), bounded at `maxQueue` events / 1 MB, dropping the oldest.
- Several tabs share the stored queue: each tab sends its own events. A tab adopts stored events that are its own after a reload, or that another tab has not refreshed for 120 s (closed or crashed tab). Any duplicate this produces has the same `uuid`, and the server dedupes on it.
- Requests carry up to 100 events / 512 KB. Every event's `uuid` (UUIDv7) is fixed at capture and reused on every retry.
- **Responses:** 2xx removes the events. 429 / 408 / 5xx / network errors retry with backoff 1 s → 60 s (equal jitter, `[d/2, d)`); the `online` event resets the backoff. On **400 or 413**, the batch is resent **one event at a time** and the events the edge still refuses are dropped with a console warning. 401 and other 4xx are dropped.
- **gzip:** with `compression: 'gzip'`, bodies go through `CompressionStream('gzip')` with `Content-Encoding: gzip`. If an edge answers a gzip body with 400 or 415, gzip is switched off for that page and the batch is resent uncompressed (so an edge without gzip can never trigger split-and-drop).
- **Page hide** (`visibilitychange` → hidden, `pagehide`): queued events are handed to `fetch(…, {keepalive: true})` as a *simple* request (`Content-Type: text/plain`, `api_key` in the body, no `Authorization`, so no preflight), in chunks under 60 KB. It falls back to `navigator.sendBeacon` when keepalive is unsupported or its 64 KiB budget is used up. Handed-off events leave storage at once; if the page survives and the request fails, they are re-queued. These sends are never gzipped (compression is async).

## Privacy

- `optOut()` stops capture and clears the queue (memory + storage). While opted out, nothing but the consent flag is written to storage. `optOutByDefault: true` starts in that state.
- Opt-out stops more than events. While `hasOptedOut()` is true the lazy modules send no request and show nothing: flags (`src/flags.ts:110`), Remote Config fetches and its stream (`src/remote-config.ts:76,148,175`), survey and message loads and display (`src/surveys.ts:233,333,369`, `src/messages.ts:155,218,239`), and replay, which drops what it holds and stops recording (`src/replay.ts:285,365`). `optIn()` brings them back: flags, surveys and messages reload, and Remote Config reopens the stream if a listener is waiting.
- Autocapture **never reads input values**. `input`, `select`, `textarea` and anything inside a `contenteditable` region contribute only `name`, `id`, `class`, `aria-label`, never text or `value`. Hidden fields, password fields and fields whose name/id looks sensitive (`cc…`, `pass`, `pwd`, `cvv`, `ssn`, …, the posthog-js list) never contribute text or `href`. Text tokens and attribute values that look like card numbers (13–19 digits) or US SSNs are dropped.
- Elements marked `.an-no-capture`, `[data-an-no-capture]` or posthog's `.ph-no-capture` (and all their descendants) produce no `$autocapture` and no `$rageclick`.
- `$el_text` is ≤ 255 chars: direct text of the element (and nested `<span>` text for `a` / `button`). `$elements_chain` is ≤ 2 KB; outer ancestors are dropped first.
- `beforeSend` can redact anything (for example `$current_url` query strings) or drop events.

### Storage keys

| Key | Where | Content |
|---|---|---|
| `an_<writeKey>` | localStorage | distinct id, device id, identified flag, super properties, groups, session id + start + last activity |
| `an_<writeKey>_q:<tab>:<uuid>`, `an_<writeKey>_q:<tab>` | localStorage | one pending event per key; the tab key is its last-alive time |
| `an_<writeKey>_qs` | localStorage | events handed to the browser on unload, not yet confirmed `[{t: ms, e: event}]`; resent after 30 s, dropped after 24 h |
| `an_<writeKey>_c` | localStorage | consent `'1'` / `'0'` |
| `an_<writeKey>_w`, `an_<writeKey>_wp` | sessionStorage | `$window_id`, primary-tab flag |

With `persistence: 'memory'` all of these live in memory only.

## Session replay (lazy module)

Replay is a separate bundle (rrweb `record` plus the chunker, about 61 KB gzip, its own budget in `scripts/size.mjs`), not part of the core. It records DOM changes, console lines and fetch/XHR timings, and uploads 10-second gzip chunks to the edge's `POST /replay`. There is no sampling and no duration limit. Inputs are always masked, and a filled input is recorded as a fixed 8 asterisks (`********`) whatever its length, so the length of a password is not given away (an empty input stays empty; `maskInputFn` in `src/replay.ts:377`). `.an-no-capture` / `.ph-no-capture` elements become same-size blocks.

```ts
import glyphway from 'glyphway'
import { startReplay } from 'glyphway/replay'
glyphway.init(KEY, { host })
const stop = startReplay(glyphway, { host, writeKey: KEY /* maskAllText, urlBlocklist, blockSelectors, recordCanvas, recordCrossOriginIframes, recordHeaders, recordBody */ })
```

With the script tag, load `glyphway.replay.js` after `glyphway.js` and call `glyphway.startReplay({ host, writeKey })`. It needs `CompressionStream` (no recording without it) and follows `optOut()`: it stops recording and discards unsent chunks, and starts again after `optIn()`. Failed chunks retry from IndexedDB with the same id, so the edge stores each once.

## Sizes

Minified (esbuild, ES2018) and measured by `pnpm size` (gzip level 9, brotli q11):

| Build | File | Raw | gzip | brotli | Budget (gzip) |
|---|---|---|---|---|---|
| IIFE core (no autocapture) | `dist/glyphway.core.js` | 13.9 KB | **5.9 KB** (6007 B) | 5.3 KB | 10 KB |
| IIFE full (with autocapture) | `dist/glyphway.js` | 22.7 KB | **9.5 KB** (9690 B) | 8.5 KB | 14 KB |
| ESM core (`glyphway/core`) | `dist/core.mjs` | 13.7 KB | 5.8 KB (5966 B) | 5.2 KB | 10 KB |
| ESM full (`glyphway`) | `dist/index.mjs` | 22.6 KB | 9.4 KB (9655 B) | 8.5 KB | 14 KB |

Internal members end in `_` and are renamed by esbuild's `mangleProps`. They are marked
`@internal` and stripped from `dist/types`.

## Choices where the spec is silent

These follow posthog-js unless marked **Our choice**:

1. `$referrer` / `$referring_domain` are `"$direct"` when there is no referrer.
2. `$browser` / `$os` names are posthog-js's (`Chrome`, `Mobile Safari`, `Microsoft Edge`, `Mac OS X`, …). `$browser_version` is a number (major.minor). Windows NT 10.0 is reported as `"10"`. **Our choice:** iPadOS's desktop UA (Macintosh + touch) is reported as `iOS` / `Tablet`.
3. `$device_id` is the first anonymous id and survives `reset()`; `reset(true)` renews it.
4. `identify()` links ids only from an anonymous state. Switching from one identified id to another changes the id without sending an event (call `reset()` between users). Junk ids such as `"undefined"`, `"null"` or `"anonymous"`, and ids over 200 chars, are rejected.
5. `$groupidentify` is sent when the group is new or changed, or props are given. posthog-js only sends it when props are given.
6. `optIn()` sends `$opt_in`.
7. SPA page views fire on **pathname** changes only (posthog-js `history_change`), and `$pageview` carries `title`.
8. **Our choice:** `$pageleave` fires on `pagehide` and on SPA navigation, not on `visibilitychange`, because a tab switch is not a leave. If a mobile OS kills a background tab without `pagehide`, the `$pageleave` is lost. Events captured before that were already flushed when the tab went hidden.
9. **Our choice:** UTMs and click ids are read from the URL at `init()` and attached until the first SPA pathname change, so a router that strips them with `replaceState` does not lose them. They are not persisted, and not sent as `$set_once`.
10. Session rotation counts captured events only. posthog-js also counts user activity. `$window_id` does not change when the session rotates (unlike posthog-js), but does change on `reset()`.
11. **Our choice:** 408 is retried like 429. 413 uses the split rule like 400. Other 4xx are dropped like 401. The per-request cap is 100 events / 512 KB.
12. The autocapture element rule is a fixed tag list (`a`, `button`, form fields and the like). posthog-js's `cursor: pointer` heuristic is not used, because it needs `getComputedStyle` on every click. `$rageclick` uses the posthog-js `RageClick` rule on **any** element, and also carries the chain.
13. Not in v1: `data-ph-capture-attribute-*`, `.ph-sensitive`, `$external_click_url`, `$ce_version`, dead clicks, copy autocapture.

## Edge requirements

The local edge now has CORS, gzip bodies and `sent_at` clock correction. Checked against it:

- `OPTIONS /batch` answers 204 with `access-control-allow-origin: *` and allows the `authorization, content-type, content-encoding` headers. Responses (including 401) carry `access-control-allow-origin`. The keepalive path needs this to tell failure from success.
- gzip bodies are accepted (integration test).
- The keepalive / beacon path uses the body `api_key` with a `text/plain` body; the edge accepts both.

Still worth changing on the edge:

- The body-`api_key` path has a **per-IP limit of 120 requests/min**. Every page hide uses that path, so offices behind one NAT can hit 429 there. Keepalive sends are re-queued if the page survives; beacon sends are lost. Consider a higher limit, or exempting requests whose key is valid.
- `sent_at` clock correction was not observable from the SDK side; the SDK always sends `sent_at`.
- Server-side dedupe on `uuid` is required. The multi-tab queue and keepalive re-queueing are at-least-once by design.

## Development

```sh
pnpm install
pnpm check        # typecheck (src as ES2018, tests as ES2022) + build + unit tests + size budgets
pnpm test         # vitest + happy-dom
pnpm build        # dist/: index.mjs, core.mjs, glyphway.js, glyphway.core.js (+ maps, types)
pnpm size
```

Unit tests (`test/*.test.ts`) cover:

- UUIDv7 and UA parsing.
- Session rotation (30 min / 24 h), tabs and window ids.
- identify / alias / group / reset / super properties.
- Transport: wire shape, flush triggers, backoff timings, 400/413 split-and-drop, 401, gzip and its fallback.
- Queue: persistence across a reload, crash adoption, the multi-tab lease, bounds.
- Page hide: keepalive + beacon, chunking, re-queue.
- Opt-out.
- Autocapture: chain format, privacy (no input values, no password fields), opt-out classes, the 2 KB cap.
- Rage click, `$pageview` / `$pageleave` / SPA, engagement timing, default properties, UTMs, debug, `beforeSend`, the snippet.
- The built bundles themselves (`test/dist.test.ts`: minified IIFE + ESM core, after `pnpm build`).

`test/integration.test.ts` posts real batches to a running edge from Node and is skipped unless
`EDGE_URL` and `WRITE_KEY` are set (see STATUS).

Not yet verified in a real browser; happy-dom and Node only. Count as of 2026-11-08: 229 unit tests.

## Feature flags

A lazy module of 1.7 KB gzip. Values come from the edge and the last ones stay in storage.

```ts
import { glyphway } from 'glyphway'
import { flags } from 'glyphway/flags'

const f = flags(glyphway, { bootstrap: { flags: { 'new-checkout': true } } })
f.onFeatureFlags(() => render())
if (f.isFeatureEnabled('new-checkout')) showIt()
f.getFeatureFlag('pricing-test') // 'control', 'test', true, false or undefined
f.getFeatureFlagPayload('pricing-test')
```

A read sends `$feature_flag_called`, once per flag and value in a session; pass `{ send_event: false }` to skip it. Flags reload after `identify`, `group` and `reset`. A request gives up after 3 s and keeps the last values. `posthog-js` also works against the edge unchanged.

## Remote Config

A lazy module of 1.8 KB gzip, on Firebase's model. `fetch` brings values down and `activate` makes them the ones you read, so a screen doesn't change under the user.

```ts
import { remoteConfig } from 'glyphway/remote-config'

const rc = remoteConfig(glyphway, { defaults: { welcome: 'Hello' } })
await rc.fetchAndActivate()
rc.getString('welcome')
rc.onConfigUpdate(() => rc.activate())
```

`onConfigUpdate` opens an `EventSource` stream while the page is visible. It closes on `optOut()` and reopens on `optIn()`. When the edge ends the stream (its connection limit), the module falls back to polling. There is no watchdog for a stream that stays open but goes silent. `getAll()` and `activate()` skip malformed stored entries.

Fetches wait 12 hours by default; set `minimumFetchIntervalMs` lower while developing. Values are public, so don't put secrets in them.

## Surveys

A lazy module of 3.7 KB gzip. Which survey shows is decided in the browser, by URL, device, selector, wait period and repeat rules. Pass the `flags` module for surveys with an audience.

```ts
import { surveys } from 'glyphway/surveys'

surveys(glyphway, { flags: f })
```

It draws in a shadow root, so your CSS and ours can't touch. `api` surveys never draw: read `getActiveSurveys()` and send `survey shown`, `survey sent` and `survey dismissed` yourself.

## In-app messages

A lazy module of 2.6 KB gzip. Messages load once a day and on app open, and frequency is kept on the device.

```ts
import { messages } from 'glyphway/messages'

const m = messages(glyphway, { flags: f, onAction: (link) => router.push(link) })
m.triggerMessage('42')
m.suppressMessages(true) // until a reload; m.isSuppressed() reads it back
```

A message that cannot be drawn does not block the next one that matches. Suppressed messages are ignored, so turning suppression off shows nothing until a trigger happens again.

To draw messages yourself, pass `display`. The module then draws nothing and counts a message only when you say it is on screen:

```ts
messages(glyphway, {
  display: ({ message, content, impression, click, dismiss, error }) => {
    if (!myUi.show(content)) return error('no room') // sends $message_display_error, no frequency record
    impression() // sends $message_impression and keeps the frequency record
    // later: click(action) or dismiss()
  },
})
```

A message that is a test for this device (Test devices on the message) shows at app open past its audience, trigger and frequency, and sends no events.

## Push notifications

A lazy module of 0.9 KB gzip, and a service worker you serve from your own origin (`push-sw.js` in this package; copy it to `/glyphway-push-sw.js`, or say where it is). Call `registerPush` from a click, since browsers refuse a permission prompt nobody asked for.

```ts
import { registerPush } from 'glyphway/push'

const { state, push } = await registerPush(glyphway, { vapidKey: '<the project VAPID public key>', topics: ['news'] })
// state: 'subscribed' | 'denied' | 'unsupported' | 'error'
await push?.unregister() // unsubscribes and tells the server
```

The subscription goes out as `$push_token` (platform `web`). The worker shows the notification and tells the open page, which sends `$push_received`, `$push_opened` and `$push_dismissed` with `$campaign_id` (and `$variant`). With no page open the reports wait in the worker's memory for the next page; a worker the browser stopped meanwhile loses them. The VAPID key is in the project's push settings (`GET /api/projects/{p}/push/settings`).
