/** Minimal key/value store; never throws. */
export interface KV {
  get(k: string): string | null
  set(k: string, v: string): void
  del(k: string): void
  /** Keys that start with `prefix` (the queue lists its per-event keys). */
  keys(prefix: string): string[]
}

export function memKV(): KV {
  const m: Record<string, string> = {}
  return {
    get: (k) => (k in m ? m[k]! : null),
    set: (k, v) => {
      m[k] = v
    },
    del: (k) => {
      delete m[k]
    },
    keys: (p) => Object.keys(m).filter((k) => k.startsWith(p)),
  }
}

/**
 * localStorage / sessionStorage, falling back to memory when unavailable
 * (blocked storage, some private modes). Quota errors on write are swallowed:
 * the in-memory copies stay authoritative for this page.
 */
export function webKV(name: 'localStorage' | 'sessionStorage'): KV {
  let s: Storage | undefined
  try {
    s = window[name]
    s.setItem('an_t', '1')
    s.removeItem('an_t')
  } catch {
    return memKV()
  }
  const st = s
  return {
    get: (k) => {
      try {
        return st.getItem(k)
      } catch {
        return null
      }
    },
    set: (k, v) => {
      try {
        st.setItem(k, v)
      } catch {
        /* quota */
      }
    },
    del: (k) => {
      try {
        st.removeItem(k)
      } catch {
        /* ignore */
      }
    },
    keys: (p) => {
      const r: string[] = []
      try {
        for (let i = 0; i < st.length; i++) {
          const k = st.key(i)
          if (k && k.startsWith(p)) r.push(k)
        }
      } catch {
        /* ignore */
      }
      return r
    },
  }
}
