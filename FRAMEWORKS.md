# Using Glyphway with a framework

The SDK is plain browser code with no framework dependency. Four things hold in every framework:

- Start it once, in the browser, as early as you can. It does nothing on the server (no `window`), so a server render is safe; `init` simply returns.
- Page views follow the browser's history (`pushState`, `replaceState`, back and forward), so a client-side router needs no extra code. Leave `capturePageview` on.
- Call `identify(id)` after sign-in and `reset()` after sign-out.
- Pass the same write key and edge host everywhere; keep both in your public environment variables (they are not secrets).

The samples were written against the SDK's own API in [README.md](README.md). They were not run inside a framework app, so treat each as a starting point and check it against your framework's version.

## React (Vite, Create React App)

```tsx
// src/glyphway.ts
import glyphway from 'glyphway'

glyphway.init(import.meta.env.VITE_GLYPHWAY_KEY, { host: import.meta.env.VITE_GLYPHWAY_HOST })
export default glyphway
```

```tsx
// src/main.tsx: import it before the app renders
import './glyphway'
```

```tsx
// after sign-in and sign-out
import glyphway from './glyphway'

glyphway.identify(user.id, { email: user.email })
glyphway.reset()
```

`init` ignores a second call (and says so in the console), so React's double effects in development do no harm. If you prefer starting it inside a component, do it in a `useEffect(() => { glyphway.init(...) }, [])`.

## Next.js

Start it in a client file. In the App Router, a client component in the root layout:

```tsx
// app/glyphway-provider.tsx
'use client'
import glyphway from 'glyphway'
import { useEffect } from 'react'

export function GlyphwayProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    glyphway.init(process.env.NEXT_PUBLIC_GLYPHWAY_KEY!, { host: process.env.NEXT_PUBLIC_GLYPHWAY_HOST! })
  }, [])
  return children
}
```

```tsx
// app/layout.tsx
import { GlyphwayProvider } from './glyphway-provider'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <GlyphwayProvider>{children}</GlyphwayProvider>
      </body>
    </html>
  )
}
```

App Router navigation uses the history API, so page views are captured as the user moves. In the Pages Router, put the same `useEffect` in `pages/_app.tsx`. Import `glyphway` only from client code; `NEXT_PUBLIC_` variables are the ones the browser can read.

## Vue 3

```ts
// src/main.ts
import glyphway from 'glyphway'
import { createApp } from 'vue'
import App from './App.vue'
import router from './router'

glyphway.init(import.meta.env.VITE_GLYPHWAY_KEY, { host: import.meta.env.VITE_GLYPHWAY_HOST })
createApp(App).use(router).mount('#app')
```

Vue Router's history mode uses `pushState`, so page views follow. In hash mode (`createWebHashHistory`) the path does not change, so capture the route yourself:

```ts
router.afterEach(() => glyphway.capture('$pageview'))
```

and start with `capturePageview: false` so the first view is not counted twice.

## Svelte and SvelteKit

```ts
// src/hooks.client.ts (SvelteKit)
import glyphway from 'glyphway'
import { PUBLIC_GLYPHWAY_HOST, PUBLIC_GLYPHWAY_KEY } from '$env/static/public'

glyphway.init(PUBLIC_GLYPHWAY_KEY, { host: PUBLIC_GLYPHWAY_HOST })
```

`hooks.client.ts` runs only in the browser. In plain Svelte, call `init` in `main.ts` before `new App(...)`. SvelteKit's client router uses the history API, so page views follow.

## Angular

```ts
// src/main.ts
import { bootstrapApplication } from '@angular/platform-browser'
import glyphway from 'glyphway'
import { AppComponent } from './app/app.component'
import { appConfig } from './app/app.config'
import { environment } from './environments/environment'

glyphway.init(environment.glyphwayKey, { host: environment.glyphwayHost })
bootstrapApplication(AppComponent, appConfig)
```

With server-side rendering (Angular Universal), put the import in a browser-only entry or guard it with `isPlatformBrowser`. The Angular router uses the history API, so page views follow.

## Consent banners

To start without storing anything until a visitor agrees, pass `optOutByDefault: true` and call `glyphway.optIn()` from the banner. To count visitors who decline without storing anything on their device, pass `cookielessMode: 'on_reject'` and call `glyphway.optOut()` on decline; the project must also allow cookieless mode in Project settings, Website tracking (README, section 16). `optOut()` also stops flags, Remote Config, surveys, messages and replay until `optIn()`; `reset()` clears the flag values too (README, sections 7 and 10).

## Script tag without a bundler

For a site with no build step, use the snippet in [README.md](README.md) (`glyphway.js`); it exposes the same calls on `window.glyphway`.
