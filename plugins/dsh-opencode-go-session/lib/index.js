// dsh-opencode-go-session
//
// Hardened host plugin: attach a stable `x-opencode-session` header to model
// requests routed to an OpenCode / OpenCode Go provider.
//
// OpenCode's relay pins every request sharing the same `x-opencode-session`
// value to the same upstream backend, keeping its prompt cache warm across the
// turns of one conversation. The value only has to be opaque and stable per
// conversation.
//
// This plugin is a security-hardened rewrite of `dsh-opencode-session`. The
// changes that address the review findings:
//
//   1. DEFAULT MODE IS 'uuid', NOT 'session-id'.
//      Empirically verified class of issue: the original shipped with
//      `mode: 'session-id'` as default, which sends the *internal DSH session
//      id* verbatim to a third-party OpenCode upstream. That leaks an internal
//      identifier that can be used for session correlation / probing. We now
//      derive an opaque random UUID per DSH session and only ever send that.
//      `session-id` is still available explicitly for users who specifically
//      want it, but it is no longer the default.
//
//   2. Header VALUE sanitisation.
//      A session id passing through `Headers.set` is validated by the runtime,
//      but we additionally reject control characters / non-visible ASCII up
//      front so a hostile session id can never be abused to smuggle header
//      syntax into the outbound request.
//
//   3. fetch patch is minimally scoped and safely restored.
//      The global `globalThis.fetch` patch is only *active* while an
//      OpenCode stream is being driven inside our AsyncLocalStorage store, and
//      restoration guards against clobbering a patch installed by a
//      concurrently-loaded plugin (we only restore when we are still the
//      current patch).
//
//   4. debugFile is constrained and redacted.
//      The optional debug log accepts only an absolute path under an
//      allow-listed directory, and the logged "session" field is a HMAC-free
//      one-way SHA-256 hash, never the raw DSH session id.
//
//   5. Bounded uuid table.
//      The in-memory session->uuid map is capped to avoid unbounded growth on
//      long-running processes with many one-shot sessions.

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

export const name = 'opencode-go-session-header'

// Activate only after the abstract `llm` service exists, so the waterfall
// event we listen on is already registered by its provider.
export const inject = ['llm']

const SESSION_HEADER = 'x-opencode-session'
const HEADER_VALUE_RE = /^[\x21-\x7e\x80-\u10ffff]+$/u
const UUID_TABLE_MAX = 4096

// Provider routes OpenCode(Go) requests are served under.
const DEFAULT_PROVIDERS = ['opencode', 'opencode-go']

function resolveConfig(config = {}) {
  const providers = Array.isArray(config.providers) && config.providers.length > 0
    ? config.providers.map((value) => String(value))
    : [...DEFAULT_PROVIDERS]
  // Security: default is 'uuid' so the internal DSH session id is never sent
  // to third parties. 'session-id' is opt-in only.
  const mode = config.mode === 'session-id' ? 'session-id' : 'uuid'
  const debug = config.debug === true
  const debugFile = resolveSafeDebugFile(config.debugFile)
  return { providers: new Set(providers), mode, debug, debugFile }
}

/**
 * Resolve an optional debugFile under a constrained allow-list of directories.
 * Only a path inside `$DSH_HOME/logs` (preferred) or inside the OS temp dir is
 * accepted; anything else fails closed to `undefined` rather than writing to an
 * arbitrary location. A relative path is anchored to `$DSH_HOME/logs`.
 */
function resolveSafeDebugFile(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const home = (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0)
    ? process.env.DSH_HOME
    : process.cwd()
  const homeLogs = resolve(home, 'logs')
  const tempRoot = resolve(tempDir())
  let absolute
  try {
    if (isAbsolute(value)) {
      absolute = resolve(value)
    } else {
      // Relative spec is anchored to the approved home logs dir.
      absolute = resolve(homeLogs, value)
    }
  } catch {
    return undefined
  }
  for (const root of [homeLogs, tempRoot]) {
    try {
      if (absolute === root || absolute.startsWith(root + sep)) {
        return { file: absolute, root }
      }
    } catch {
      // path comparison failed; fall through
    }
  }
  return undefined
}

function tempDir() {
  return process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? '/tmp'
}

/** One-way hash of a session id used ONLY for debug logging (never sent). */
export function redactSessionId(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)
}

/** True when a value is a safe HTTP header value candidate. */
function safeHeaderValue(value) {
  const raw = String(value)
  return raw.length > 0 && HEADER_VALUE_RE.test(raw)
}

/** Derive the opaque header value for one DSH session id. */
export function headerValueFor(sessionId, mode, table) {
  if (typeof sessionId !== 'string' && typeof sessionId !== 'number') return undefined
  const raw = String(sessionId)
  if (raw.length === 0) return undefined
  if (!safeHeaderValue(raw)) return undefined
  if (mode !== 'session-id') {
    // uuid mode: never expose the internal id; emit a random opaque uuid.
    let value = table.get(raw)
    if (value === undefined) {
      value = randomUUID()
      if (table.size >= UUID_TABLE_MAX) {
        // Drop the oldest entry to keep the map bounded.
        const oldest = table.keys().next().value
        if (oldest !== undefined) table.delete(oldest)
      }
      table.set(raw, value)
    }
    return value
  }
  // Explicit session-id mode: still require a safe header value.
  return raw
}

/**
 * Wrap a downstream async iterable so every pull executes inside an
 * AsyncLocalStorage store. Async generators and the promises they create
 * inherit the store as long as the generator body is driven from a pull made
 * inside `als.run`, which is exactly what this wrapper does per `next()`.
 */
export function withStore(iterable, store, als) {
  const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : iterable
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      return als.run(store, () => iterator.next())
    },
    async return(value) {
      if (typeof iterator.return === 'function') {
        try {
          return await iterator.return(value)
        } catch {
          // The downstream stream may already be torn down; treat as done.
        }
      }
      return { done: true, value }
    },
    async throw(error) {
      if (typeof iterator.throw === 'function') {
        return als.run(store, () => iterator.throw(error))
      }
      throw error
    },
  }
}

/** True when the outgoing request already carries the session header. */
function hasSessionHeader(input, init) {
  const source = init?.headers
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
  if (source === undefined) return false
  try {
    return new Headers(source).has(SESSION_HEADER)
  } catch {
    return false
  }
}

/**
 * Build a patched fetch that injects the header while a store is active —
 * and only then. Header precedence mirrors native fetch: when `init.headers`
 * is present it wins; otherwise a Request's own headers are the base.
 */
export function patchFetch(original, als) {
  return function patchedFetch(input, init) {
    const state = als.getStore()
    if (state && !hasSessionHeader(input, init)) {
      const headers = new Headers(
        init?.headers
          ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
      )
      headers.set(SESSION_HEADER, state.value)
      return original.call(this, input, { ...init, headers })
    }
    return original.apply(this, arguments)
  }
}

export function apply(ctx, config) {
  const { providers, mode, debug, debugFile } = resolveConfig(config)
  const als = new AsyncLocalStorage()
  const uuidBySession = new Map()

  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') {
    ctx.logger.warn('[opencode-go-session-header] globalThis.fetch is unavailable; cannot inject x-opencode-session')
    return
  }

  const patched = patchFetch(originalFetch, als)

  ctx.effect(() => {
    globalThis.fetch = patched
    ctx.logger.info(
      '[opencode-go-session-header] active for providers [%s] with mode %s (debug=%s)',
      [...providers].join(', '),
      mode,
      debug ? 'on' : 'off',
    )
    return () => {
      // Restore only if we are still the active patch — never clobber a patch
      // installed later by a concurrently-loaded plugin.
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch
    }
  }, 'opencode-go-session-header.fetch-patch')

  ctx.on('llm/stream', (options, next) => {
    if (options === undefined || options === null || typeof options !== 'object') return next()
    if (!providers.has(String(options.provider))) return next()
    const sessionId = options.sessionId
    if (sessionId === undefined || sessionId === null) return next()
    const value = headerValueFor(sessionId, mode, uuidBySession)
    if (value === undefined) return next()

    // Reaching the adapter is the only way the actual HTTP request happens;
    // `next()` returns the downstream (lazy) stream. Call it exactly once,
    // then drive its iterator from inside the store.
    let downstream
    try {
      downstream = next()
    } catch (error) {
      // Let the caller handle an adapter dispatch failure as it normally would.
      throw error
    }
    if (downstream === undefined || downstream === null) return downstream
    if (typeof downstream[Symbol.asyncIterator] !== 'function') return downstream

    if (debug || debugFile !== undefined) {
      const entry = {
        ts: new Date().toISOString(),
        provider: options.provider,
        model: options.model,
        mode,
        session: redactSessionId(sessionId),
        header: SESSION_HEADER,
        value,
      }
      if (debugFile !== undefined) {
        recordDebug(ctx, debugFile.file, entry)
      }
      if (debug) {
        ctx.logger.info(
          '[opencode-go-session-header] streaming provider "%s" mode=%s with %s=%s',
          options.provider,
          mode,
          SESSION_HEADER,
          value,
        )
      }
    }
    return withStore(downstream, { value }, als)
  }, { prepend: true })
}

/** Fire-and-forget append of one debug record; failures only log a warning. */
function recordDebug(ctx, file, entry) {
  appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8').catch((error) => {
    ctx.logger.warn('[opencode-go-session-header] debugFile write failed: %s', error?.message ?? String(error))
  })
}

export default { name, inject, apply }
