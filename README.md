# Using the Web SDK

Glyphway is a product of [Zanaf Lab LLC](https://zanaflabs.com). More information: https://glyphway.com

How to add Glyphway to a website or web app, step by step. For how the SDK works inside, its design choices, tests and limits, see [DEVELOPMENT.md](DEVELOPMENT.md).

The SDK (`glyphway`) runs in the browser, has no dependencies and doesn't use any third-party service. You can add it with a `<script>` tag or as an ES module. It does nothing on a server (there is no `window`), so a server render is safe.

## 1. What you need

- **The project's write key.** In the console: Project settings → the write key (starts with `wk_`). It's public by design: it can only send data.
- **The edge address.** It comes with your Glyphway access; ask whoever gave you access.
- **A package manager** (npm, pnpm or yarn) to get the package.
- **A modern browser.** Gzip of request bodies and session replay need `CompressionStream`; without it events are sent as plain JSON and replay doesn't record.

## 2. Install

The SDK is the npm package `glyphway`:

```bash
npm install glyphway
```

Its built files are in `node_modules/glyphway/dist/`. Pick one of the two ways in.

### A. A `<script>` tag (no build step on your site)

Copy `dist/glyphway.js` to a folder your site already serves, for example `/glyphway/glyphway.js`. (`dist/glyphway.core.js` is the same without autocapture, heatmaps, dead clicks and enhanced measurement, and is smaller.) Then paste this into every page, as high in `<head>` as you can, and change the address in the last line to where you put the file:

```html
<script>
!function(w,d,u){if(w.glyphway)return;var a=w.glyphway={_q:[]};"init capture identify setPersonProperties alias group reset register unregister optIn optOut flush".split(" ").forEach(function(m){a[m]=function(){a._q.push([m,[].slice.call(arguments)])}});var s=d.createElement("script");s.async=!0;s.src=u;d.head.appendChild(s)}(window,document,"YOUR_SCRIPT_ADDRESS");
glyphway.init("YOUR_WRITE_KEY", { host: "YOUR_EDGE_ADDRESS" });
</script>
```

`YOUR_SCRIPT_ADDRESS` is a placeholder: replace it with the address of the file you copied (for example `"/glyphway/glyphway.js"`). Calls made before the file has loaded are queued and replayed. The getters (`getDistinctId`, `getSessionId`, `hasOptedOut`) only exist once it has loaded.

The extra modules (errors, flags, replay and the rest, sections 8 to 14) are separate files in `dist/` named `glyphway.<module>.js`. Copy the ones you use to the same folder.

### B. An ES module (a project with a bundler)

After `npm install glyphway`:

```ts
import glyphway from 'glyphway'           // with autocapture
// import glyphway from 'glyphway/core'   // without autocapture (smaller)
```

`Glyphway` (the class) is also exported from both, if you need a second instance. Guides for React, Next.js, Vue, Svelte and Angular are in [FRAMEWORKS.md](FRAMEWORKS.md).

The extra modules are separate imports: `glyphway/exceptions`, `/vitals`, `/flags`, `/remote-config`, `/surveys`, `/messages`, `/push`, `/replay`, `/nocode`. A module you don't import is not in your bundle.

## 3. Start it

Call `init` once, in the browser, as early as you can:

```ts
import glyphway from 'glyphway'

glyphway.init('wk_your_write_key', {
  host: 'YOUR_EDGE_ADDRESS',
  release: '1.4.0', // your build's version, so errors and crash-free rates can go by it
})
```

That is enough for page views, clicks and form events to start. `init` ignores a second call (and says so in the console), so React's double effects in development do no harm. Page views follow the browser's history, so a client-side router needs no extra code.

## 4. Check that it works

1. Start with `debug: true` and open the browser's console: each event logs a line starting with `[glyphway]`, and every event is marked as debug.

   ```ts
   glyphway.init('wk_your_write_key', { host: 'YOUR_EDGE_ADDRESS', debug: true })
   ```

2. Call `await glyphway.flush()` (or run it in the console as `glyphway.flush()`) to send right away instead of waiting. In the browser's Network tab you should see a `POST` to `YOUR_EDGE_ADDRESS/batch` that answers 200.
3. In the console, **Analytics → DebugView** shows events from debug-mode devices within seconds, kept out of reports. **Analytics → Realtime** shows normal events as they arrive.
4. Turn `debug` off before you ship.

If nothing arrives, see section 17.

## 5. Track what people do

```ts
glyphway.capture('signup_started', { plan: 'pro' })
```

The event name must be 1 to 200 characters. Names and properties are yours to choose; names that start with `$` are the SDK's own.

By default the full build also sends, by itself:

| Event | When |
|---|---|
| `$pageview` | The page loads, and in a single-page app when the path changes (the address bar's path, not the query or hash). Carries `title`. |
| `$pageleave` | The page is closed or left, with `$engagement_ms` (the time it was visible and focused). |
| `$autocapture` | A click on a link, button, form, input, select, textarea or label (or inside one), a form submit, and a change in an input, select or textarea. |
| `$rageclick` | Three fast clicks close together. |
| `$dead_click` | A click that changed nothing on the page. |
| `$$heatmap` | Click and mouse-move positions, for heatmaps. |

Every event also carries the page's address, referrer, browser, operating system, screen size, language, time zone and, on the landing page, the UTM and ad click ids in the address.

**Autocapture** needs the full build (`glyphway`, not `/core`). To limit it, pass options instead of `true`:

```ts
glyphway.init('wk_your_write_key', {
  host: 'YOUR_EDGE_ADDRESS',
  autocapture: {
    urlIgnorelist: ['/admin'],             // never on these URLs (strings or regular expressions)
    domEventAllowlist: ['click'],          // only these DOM events: click, change, submit
    elementAllowlist: ['a', 'button'],     // only inside these tags
    cssSelectorAllowlist: ['.track'],      // only inside elements matching these
    elementAttributeIgnorelist: ['data-id'], // attributes left out of the element chain
  },
})
```

`urlAllowlist` is the opposite of `urlIgnorelist`. Turn autocapture off with `autocapture: false`; `capturePageview: false` turns page views off (and `$pageleave` with them, unless you set `capturePageleave: true`).

To keep one element and everything inside it out of autocapture, rage clicks and dead clicks, give it the class `an-no-capture` or the attribute `data-an-no-capture` (`ph-no-capture` works too).

**Heatmaps, dead clicks and rage clicks.** Heatmaps and dead clicks are on by default (`heatmaps: false`, `deadClicks: false` turn them off). Rage clicks are part of autocapture. Draw the maps in the console under **Product → Heatmaps**. The project can also switch autocapture, dead clicks and heatmaps off in Project settings → Website tracking; the SDK reads that once when it starts (`projectSettings: false` stops it from asking).

**Enhanced measurement** (on by default, `enhancedMeasurement: false` turns it off) adds events you would otherwise write yourself:

| Event | When |
|---|---|
| `$outbound_click` | A click on a link to another site. |
| `$file_download` | A click on a link to a file such as a PDF, spreadsheet, archive or video (`$file_name`, `$file_extension`). |
| `$form_start`, `$form_submit` | A person starts or submits a form. |
| `$scroll` | The page is scrolled to 90 percent (`$percent_scrolled`). |
| `$video_start`, `$video_progress`, `$video_complete` | A `<video>` plays, passes 10, 25, 50 and 75 percent, and ends. |
| `$view_search_results` | The page opens with a search term in `q`, `s`, `search`, `query` or `keyword`. |

**The toolbar.** The console's **Product → Heatmaps → Open toolbar** opens your site with the toolbar on top, to draw heatmaps on the live page and make actions by clicking elements. The SDK loads `glyphway.toolbar.js` for that. With the `<script>` tag it looks for it beside `glyphway.js`, so copy `dist/glyphway.toolbar.js` to the same folder. With the ES module it can't tell where your files are, so copy it somewhere public and give its address:

```ts
glyphway.init('wk_your_write_key', {
  host: 'YOUR_EDGE_ADDRESS',
  toolbarUrl: '/glyphway/glyphway.toolbar.js',
})
```

**No-code experiments.** A feature flag (section 10) whose payload is `{ "an_web": [{ "selector": "...", "text": "..." }] }` can change the page without a deploy. Start the module after the flags:

```ts
import glyphway from 'glyphway'
import { flags } from 'glyphway/flags'
import { nocode } from 'glyphway/nocode'

nocode(flags(glyphway)) // returns a function that stops it and undoes the changes
```

Each change has a `selector` and one of `text`, `css` or `html`. Scripts, iframes, `on...` attributes and `javascript:` links are refused and skipped with a console warning.

## 6. Know who they are

```ts
// after login
glyphway.identify('user-42', { plan: 'pro' }, { signed_up_on: 'web' }) // set, then set-once

// change person properties without changing who they are
glyphway.setPersonProperties({ plan: 'team' })

// link another id to this person
glyphway.alias('old-id-7')

// a company, team or other group
glyphway.group('company', 'acme', { name: 'Acme' })

// sent with every event from now on
glyphway.register({ app_theme: 'dark' })
glyphway.unregister('app_theme')

// after logout
glyphway.reset()
```

Before `identify`, a person is an anonymous id. `identify` joins what they did before logging in to their account, and the session carries on. Calling it with a different id while someone is already identified only switches the id: call `reset()` between two people. Ids over 200 characters and obvious mistakes such as `"undefined"`, `"null"` or `"anonymous"` are refused.

`reset()` starts a new anonymous person and a new session, and clears super properties and groups, so the next user in the same browser isn't mixed with the last one. The device id stays unless you call `reset(true)`. It also clears feature flag values at once (section 10).

`glyphway.getDistinctId()` and `glyphway.getSessionId()` read the current ids.

## 7. Privacy and consent

```ts
glyphway.optOut() // stop sending and drop what is queued
glyphway.optIn()
glyphway.hasOptedOut() // true or false
```

The choice is remembered in the browser. While opted out, the SDK makes no request that names the person: no flag or Remote Config request, no survey or message list, no replay upload, and no survey or message shows. `optIn()` sends `$opt_in` (and the page's `$pageview` if it was skipped) and starts all of those again.

- **Ask for consent first:** `glyphway.init(key, { host, optOutByDefault: true })`, then `glyphway.optIn()` once the person agrees. Nothing is stored until then.
- **Count people without storing anything on their device:** `cookielessMode: 'always'` (or `'on_reject'`, which starts when you call `optOut()`). Nothing is written to cookies or storage, every page load is a new visitor, and events carry `$cookieless_mode`. The project must allow it in Project settings → Website tracking, or these events are dropped.
- **Store nothing at all:** `persistence: 'memory'`. Every load is a new visitor and session.
- **Text typed into input fields is never sent.** Autocapture reads only an input's `name`, `id`, `class` and `aria-label`. Hidden and password fields, fields whose name looks sensitive (card, password, CVV, SSN), and text that looks like a card number or a US social security number never contribute text. Session replay masks all inputs.
- **Redact or drop an event** before it is queued with `beforeSend`:

  ```ts
  glyphway.init('wk_your_write_key', {
    host: 'YOUR_EDGE_ADDRESS',
    beforeSend: (event) => {
      if (event.event === 'internal_test') return null // drop it
      const url = event.properties.$current_url
      if (typeof url === 'string') event.properties.$current_url = url.split('?')[0] // no query strings
      return event
    },
  })
  ```

- The IP address is kept on events by default. A project can turn that off in Project settings → **Store IP addresses**. Location (country, region, city) is worked out from it either way.

## 8. Errors

Errors are a separate module, so you load it when you want it. Set `release` in `init` so crash-free rates and regressions can go by version.

```ts
import glyphway from 'glyphway'
import { exceptions } from 'glyphway/exceptions'

glyphway.init('wk_your_write_key', { host: 'YOUR_EDGE_ADDRESS', release: '2.0.1' })

const errors = exceptions(glyphway) // window errors and unhandled promise rejections, from here on

try {
  await pay()
} catch (e) {
  errors.captureException(e, { order: 42 }) // a handled error
}

errors.setCustomKey('plan', 'pro')       // sent with every error from now on
errors.log('retrying payment')           // the last lines before an error
errors.addExceptionStep('opened checkout') // what the person did before it
```

`exceptions(glyphway, options)` takes `errors` and `rejections` (both `true` by default), `console` (`false` by default; `true` also reports `console.error`) and `inApp`, a function that says whether a file is your own code (by default, files from the page's own address, outside `node_modules`). Each error type sends 10 at once, then one every 10 seconds, so a loop of errors can't flood you.

With a `<script>` tag, load `glyphway.exceptions.js` after `glyphway.js` and call `glyphwayExceptions.exceptions(glyphway)`.

**Upload source maps** so stack traces show your code's names and lines, not minified ones. Build with source maps on (`.map` files next to your scripts) and use the same `release` as in `init`. Set these once. From anywhere, a CI runner included, the upload goes through the edge with a project upload token (console: Settings → **Symbol upload tokens**):

```bash
export GLYPHWAY_EDGE=YOUR_EDGE_ADDRESS
export GLYPHWAY_PROJECT=<project id>
export GLYPHWAY_UPLOAD_TOKEN=<the token, starts with aup_>
```

On the same network as the Glyphway server you can send straight to it instead, with a personal API key: `GLYPHWAY_HOST=<the console's address>`, `GLYPHWAY_PROJECT` and `GLYPHWAY_API_KEY`.

Then, for each release, before you deploy:

```bash
glyphway-cli sourcemaps upload --release 2.0.1 --dir dist --base /assets
```

`glyphway-cli` is a single script from https://github.com/glyphway/glyphway-cli (it needs bash, curl and find; its README has every option). It uploads every `.map` file under `--dir`. The script's path on your site is taken from the file's place under `--dir` (without `.map`), after `--base`: `dist/app.js.map` with `--base /assets` is matched to scripts served at `/assets/app.js`. Leave `--base` out if `dist` is your site's root. Never commit the token or key.

Without a map, errors still arrive; they just show minified frames.

## 9. Performance

Page speed is a separate module:

```ts
import { vitals } from 'glyphway/vitals'

vitals(glyphway) // one `$perf_web_vitals` per page, when the page is hidden
```

It sends the Core Web Vitals (largest contentful paint, interaction to next paint, layout shift, first contentful paint) with their elements, the page's load timings, and `$perf_trace` events for the time the tab was in the foreground and background. With a `<script>` tag: `glyphway.vitals.js` and `glyphwayVitals.vitals(glyphway)`.

## 10. Feature flags

```ts
import glyphway from 'glyphway'
import { flags } from 'glyphway/flags'

const f = flags(glyphway, { bootstrap: { flags: { 'new-checkout': true } } })
f.onFeatureFlags(() => render())      // on every load, and at once if there are any
if (f.isFeatureEnabled('new-checkout')) showNewCheckout()
const variant = f.getFeatureFlag('pricing-test') // 'control', 'test', true, false or undefined
const payload = f.getFeatureFlagPayload('pricing-test')
const result = f.getFeatureFlagResult('pricing-test') // { key, enabled, variant, payload }
```

Flags load from the edge when you start the module, and the last values are kept in the browser. `bootstrap` gives values to use before the first answer. A request gives up after 3 seconds (`timeoutMs`) and keeps the last values. Flags reload after `identify`, `group` and `reset`; call `await f.reloadFeatureFlags()` to reload by hand.

Reading a flag sends `$feature_flag_called`, once per flag and value in a session, for experiments. Pass `{ send_event: false }` to skip it.

Other options: `evaluationContexts`, `flagKeys` (ask for these flags only), `manual: true` (skip the first request when you call `reloadFeatureFlags` yourself). More calls: `overrideFeatureFlags({ 'new-checkout': true })` (`false` clears it), `setPersonPropertiesForFlags({...})` and `setGroupPropertiesForFlags({ company: {...} })`.

With a `<script>` tag: `glyphway.flags.js` and `glyphwayFlags.flags(glyphway)`.

## 11. Remote Config

```ts
import { remoteConfig } from 'glyphway/remote-config'

const rc = remoteConfig(glyphway, { defaults: { welcome: 'Hello', max_items: 5 } })
await rc.fetchAndActivate()
const text = rc.getString('welcome')
const max = rc.getNumber('max_items')
const on = rc.getBool('banner')
const all = rc.getAll()
rc.onConfigUpdate(() => rc.activate()) // live updates while the page is visible
```

`fetch` brings new values down and `activate` makes them the ones you read, so a screen doesn't change under the person. Fetches wait 12 hours by default; while developing, pass `minimumFetchIntervalMs: 0`. Also `getJSON(key)`, `setDefaults({...})` and `setCustomSignals({...})` for targeting; the options `appId`, `appBuild`, `userProperties` and `timeoutMs` (10 seconds). Values are public: no secrets in them.

`onConfigUpdate` opens a live stream while the page is visible. It closes on `optOut()` and reopens on `optIn()`. When the edge ends the stream, the module falls back to polling. A stored entry that is malformed is skipped, not fatal. With a `<script>` tag: `glyphway.remote-config.js` and `glyphwayRemoteConfig.remoteConfig(glyphway)`.

## 12. Surveys and in-app messages

```ts
import { flags } from 'glyphway/flags'
import { surveys } from 'glyphway/surveys'
import { messages } from 'glyphway/messages'

const f = flags(glyphway)
const s = surveys(glyphway, { flags: f }) // pass flags for surveys that have an audience
const m = messages(glyphway, { flags: f, onAction: (action) => router.push(action) })
```

Surveys and messages made in the console then show by themselves when their conditions match (page, device, selector, wait period, repeat rules). They draw inside a shadow root, so your CSS and ours can't touch each other.

For surveys: keep what `surveys()` returns in `s`: `s.getActiveSurveys()` lists the ones that apply and `s.showSurvey(id)` shows one now. Pass `manual: true` to draw your own: the module then shows nothing, and you read `getActiveSurveys()` and send `survey shown`, `survey sent` and `survey dismissed` yourself. Surveys of type `api` are never drawn by the module either. `language` sets the language of translated surveys (the browser's by default).

For messages: `m.triggerMessage('42')` shows a message whose trigger is manual. `m.suppressMessages(true)` holds messages back (during checkout, say) until you call `m.suppressMessages(false)` or the page reloads; `m.isSuppressed()` reads it. Turning suppression off shows nothing until a trigger happens again. `onAction` handles a deep link; URLs open in a new tab when you don't pass it. Messages load once a day and when the app opens, and how often one shows is kept in the browser.

To draw messages yourself, pass `display`. The module then draws nothing and counts a message only when you say it is on screen:

```ts
messages(glyphway, {
  display: ({ content, impression, click, dismiss, error }) => {
    if (!myUi.show(content)) return error('no room') // sends $message_display_error
    impression() // sends $message_impression
    // later: click('action') or dismiss()
  },
})
```

A message marked as a test for this device in the console shows regardless of its audience, trigger and frequency, and sends no events. With a `<script>` tag: `glyphway.surveys.js` (`glyphwaySurveys.surveys`) and `glyphway.messages.js` (`glyphwayMessages.messages`).

## 13. Push notifications

Web push needs a service worker served from your own site. Copy `push-sw.js` from the package (`node_modules/glyphway/push-sw.js`) to your site as `/glyphway-push-sw.js`, then call `registerPush` from a click, since browsers refuse a permission prompt nobody asked for:

```ts
import { registerPush } from 'glyphway/push'

button.addEventListener('click', async () => {
  const { state, push } = await registerPush(glyphway, {
    vapidKey: 'the project VAPID public key',
    topics: ['news'],
    // serviceWorker: '/some/other/path.js', // if you put the worker somewhere else
  })
  // state: 'subscribed' | 'denied' | 'unsupported' | 'error'
  // later: await push?.unregister() unsubscribes this browser
})
```

The VAPID public key is in the project's push settings. The page tells the console when a notification is received, opened or dismissed (`$push_received`, `$push_opened`, `$push_dismissed`, with the campaign id). If no page is open when that happens, the reports wait in the worker for the next page; a worker the browser stopped in the meantime loses them.

## 14. Session replay

Replay is its own bundle (it carries the recorder, so it is the largest module). It records DOM changes, console lines and network timings and uploads 10-second chunks to the edge.

```ts
import glyphway from 'glyphway'
import { startReplay } from 'glyphway/replay'

glyphway.init('wk_your_write_key', { host: 'YOUR_EDGE_ADDRESS' })
const stop = startReplay(glyphway, { host: 'YOUR_EDGE_ADDRESS', writeKey: 'wk_your_write_key' })
```

With a `<script>` tag, load `glyphway.replay.js` after `glyphway.js` and call `glyphway.startReplay({ host, writeKey })`.

Inputs are always masked, and a filled input is recorded as eight asterisks whatever was typed (an empty one stays empty), so the length of a password isn't given away. Elements with `an-no-capture` (or `ph-no-capture`, or `data-an-no-capture`) become same-size blocks. More options:

| Option | What it does |
|---|---|
| `maskAllText` | Mask the text of every element. Default `false`. |
| `maskTextSelector` | Mask the text of elements matching this selector. |
| `blockSelectors` | Replace elements matching these selectors with a block. |
| `urlBlocklist` | No recording on pages whose address matches (strings or regular expressions). |
| `recordCanvas` / `canvasFps` | Record canvas elements; frames per second, 0 to 12, default 4. |
| `recordCrossOriginIframes` | Record iframes from other origins; their page must start replay with this option too. Default `false`. |
| `recordHeaders` / `recordBody` | Include network headers and bodies (bodies cut at 1 MB). Default `false`. |
| `chunkMs` / `chunkBytes` | Chunk interval (10000 ms) and size (512 KB). |
| `snapshotMs` | Full snapshot interval. Default 5 minutes. |
| `maxQueueBytes` | Bound of the offline queue. Default 50 MB. |

Replay needs `CompressionStream` (there is no recording without it). It follows `optOut()`: it stops recording and drops what it hasn't sent, and starts again after `optIn()`. Chunks that fail to send are kept in the browser and retried. Call the function `startReplay` returned to stop recording.

## 15. Choosing features

By default everything runs. `features` limits it to the parts you list: `'analytics'`, `'errors'`, `'performance'`, `'replay'`, `'flags'`, `'remoteConfig'`, `'push'`, `'surveys'` and `'messages'`.

```ts
// Error tracking only: no pageviews, no autocapture, no toolbar; capture() is ignored.
import glyphway from 'glyphway/core'
import { exceptions } from 'glyphway/exceptions'

glyphway.init('wk_your_write_key', { host: 'YOUR_EDGE_ADDRESS', release: '2.0.1', features: ['errors'] })
const errors = exceptions(glyphway)
```

```ts
// Analytics only: errors, replay, flags and the rest do nothing if something starts them.
import glyphway from 'glyphway'

glyphway.init('wk_your_write_key', { host: 'YOUR_EDGE_ADDRESS', features: ['analytics'] })
```

| Feature | What it covers |
|---|---|
| `analytics` | `capture()`, `$pageview` and `$pageleave`, autocapture, heatmaps, dead and rage clicks, enhanced measurement, the toolbar and no-code actions. |
| `errors` | `exceptions()`. |
| `performance` | `vitals()`. |
| `replay` | `startReplay()`. |
| `flags` | `flags()` and the `$feature_flag_called` events. |
| `remoteConfig` | `remoteConfig()`. |
| `push` | `registerPush()`. |
| `surveys`, `messages` | `surveys()`, `messages()`. |

Identity (`identify`, `alias`, `group`, `reset`, `register`, `optIn`, `optOut`, `flush`) is never a feature and always works.

A module started while its feature is off returns an object of the same type that does nothing: no listeners, requests or storage writes, and default return values (flags give `undefined`, Remote Config gives your `defaults`). With `debug: true` it logs one warning per method. The project's settings from the edge never turn a feature on that `features` left off. An empty list warns and sends only what identity calls send.

**`$session_start`.** Crash-free rates and release adoption count sessions. With `analytics` off there are no pageviews to start a session, so the SDK sends one `$session_start` (with the default properties only) each time a new session begins: on a page load in a new session, when the page becomes visible after 30 minutes idle, when an event arrives after the idle time or the 24 hour cap, and on `reset()`. With `analytics` on it is never sent.

**Bundle size.** Not importing a module already keeps it out of your bundle, so the errors-only example above ships the core plus `glyphway/exceptions`. `features` is for turning off what the core itself does, and for the `<script>` snippet, where it is passed to `init` like any other option.

## 16. Settings (`init` options)

`glyphway.init(writeKey, options)`. Only `host` is required.

| Option | Default | What it does |
|---|---|---|
| `host` | required | The edge address. A trailing slash is ignored. |
| `release` | none | Your build's version, sent as `$app_version`. |
| `debug` | `false` | Logs `[glyphway]` lines and marks events as debug. |
| `autocapture` | `true` | Clicks, form submits and changes, and rage clicks. `false`, or an object (section 5). Full build only. |
| `heatmaps` | `true` | Click and mouse-move positions. Full build only. |
| `deadClicks` | `true` | Clicks that changed nothing. Full build only. |
| `enhancedMeasurement` | `true` | Outbound clicks, downloads, forms, scroll, video, site search. Full build only. |
| `capturePageview` | `true` | A page view on load and on single-page navigation. |
| `capturePageleave` | same as `capturePageview` | `$pageleave` with the time on the page. |
| `persistence` | `'localStorage'` | `'memory'` stores nothing: every load is a new visitor and session. |
| `cookielessMode` | none | `'always'` or `'on_reject'`: nothing is stored, every page load is a new visitor. The project must allow it. |
| `projectSettings` | `true` | Read the project's switches (autocapture, dead clicks, heatmaps, cookieless) from the edge once at start. |
| `optOutByDefault` | `false` | Start opted out until `optIn()`. |
| `flushIntervalMs` | `10000` | Send at least this often. A send also happens at 20 queued events and when the page is hidden. |
| `maxQueue` | `1000` | Events kept while offline; the oldest goes first. The queue is also capped at 1 MB. |
| `compression` | `'gzip'` | `'none'` sends plain JSON. Gzip is used when the browser has `CompressionStream`. |
| `toolbarUrl` | beside the SDK script | Where `glyphway.toolbar.js` is (section 5). |
| `features` | all | Which parts run (section 15). |
| `beforeSend` | none | `(event) => event or null`. Runs last; return `null` to drop the event. |

Events that can't be sent stay in the browser (shared between tabs) and are retried with a growing pause, so closing the tab or losing the network doesn't lose them. An event can't be larger than 1 MB.

## 17. Troubleshooting

- **Nothing arrives.** Turn on `debug: true` and read the console. No `[glyphway] capture` lines means `init` didn't run or ran with a missing key or host (`init(writeKey, { host })` needs both). Lines but no events in the console means the sends are failing: check the Network tab.
- **A request to `/batch` fails with 401.** The write key is wrong, or belongs to another project. Copy it again from Project settings.
- **The request can't reach the host.** Check the `host` spelling (no path, no trailing text) and that it is the edge, not the console.
- **Ad blockers.** Extensions can block requests to known analytics-tool addresses and file names. Use an edge name of your own (section 1) and serve the script under a neutral name.
- **`init` runs too late.** Calls made before `init` in an ES module are ignored (the console says `call init() first`). Call it first, as early as you can. With the snippet, calls made before the file loads are queued.
- **You're opted out.** `glyphway.hasOptedOut()` returns `true` after `optOut()`, or from the start with `optOutByDefault: true`. Nothing is sent, and flags, Remote Config, surveys, messages and replay are off until `optIn()`.
- **Cookieless events are dropped.** `cookielessMode` also needs Project settings → Website tracking to allow it. With `debug: true` the console says so.
- **No autocapture, heatmaps or dead clicks.** You imported `glyphway/core` (use `glyphway`), the option is off, the element has `an-no-capture`, or the project switched them off under Website tracking.
- **Everything is a new visitor.** `persistence: 'memory'` or cookieless mode is on, or the browser blocks storage.
- **Errors show minified frames.** The source maps weren't uploaded, or the `--release`/`--base` don't match the `release` in `init` and the scripts' addresses (section 8).
- **Heatmap toolbar doesn't open.** `glyphway.toolbar.js` isn't where the SDK looks (section 5), or the `analytics` feature is off.
- **Nothing in DebugView.** Only events sent with `debug: true` show there. Other events are under Realtime.
- **Events missing after the page was closed.** Events still queued when a tab closes are sent as the page hides; a mobile browser that kills a background tab can lose the last few.

## 18. Working on the SDK itself

How the SDK works inside (design choices, the wire format, the queue and transport, tests, sizes and limits): [DEVELOPMENT.md](DEVELOPMENT.md). To check your changes: `pnpm install && pnpm check` in this folder.

## 19. License

MIT, copyright Zanaf Lab LLC. See [LICENSE](LICENSE).
