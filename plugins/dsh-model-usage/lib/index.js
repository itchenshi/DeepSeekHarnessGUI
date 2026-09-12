// dsh-model-usage — host half.
//
// Fetches per-account model usage / balance and serves it to the client half
// over a same-origin JSON route. The browser must never see a key or secret,
// so every upstream call happens here.
//
// Three independent sections, each gated on the session's active provider route:
//
//   1. opencode-go — plan usage percentages.
//      GET https://opencode.ai/zen/go/v1/usage
//      Authorization: Bearer <OPENCODE_GO_API_KEY>
//      200 {"usage":{"rolling":{"status":"ok","percent":13,"resetsAt":"..."},
//                    "weekly":{...},"monthly":{...}}}
//      401 without a valid key.
//
//   2. deepseek — account balance (DeepSeek's documented Get User Balance).
//      GET https://api.deepseek.com/user/balance
//      Authorization: Bearer <DEEPSEEK_API_KEY>
//      200 {"is_available":true,
//           "balance_infos":[{"currency":"CNY","total_balance":"110.00",
//                             "granted_balance":"10.00","topped_up_balance":"100.00"}]}
//
//   3. bailian — Alibaba Cloud Bailian (百炼) Token Plan quota usage. Bailian
//      exposes no "Bearer key → GET balance" endpoint like the two above: every
//      usage/quota API is console-authenticated. This section therefore
//      reproduces the official `bailian-cli` flow (modelstudioai/cli):
//
//      a. Exchange the Alibaba Cloud OpenAPI AK/SK for a CLI access token.
//         POST https://modelstudio.cn-beijing.aliyuncs.com/modelstudio/cli/generateAccessToken
//         action GenerateCLIAccessToken, ACS3-HMAC-SHA256 signed
//         200 {"cliAccessToken":"..."}
//         WITHOUT a valid AK/SK pair the gateway replies 401/Forbidden.
//
//      b. Ask the Bailian console gateway for Token Plan usage.
//         POST https://bailian-cs.console.aliyun.com/cli/api.json
//             ?action=BroadScopeAspnGateway&product=sfm_bailian
//             &api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage
//         Authorization: Bearer <cliAccessToken>
//         form body: params=<JSON>&region=cn-beijing
//         200 {"data":{"DataV2":{"data":{"data":{
//               "per5HourPercentage":0.5,"per5HourResetTime":1786000000000,
//               "per1WeekPercentage":0.25,"per1WeekResetTime":1786100000000}}}}}
//         (percentages are ratios in [0,1]; reset times are epoch milliseconds.
//         An expired token is answered with a NotLogined console error, which
//         this section degrades to reason "unauthorized".)
//
//      Credential refs: `BAILIAN_ACCESS_KEY_ID` / `BAILIAN_ACCESS_KEY_SECRET`
//      (+ optional `BAILIAN_SECURITY_TOKEN` for STS sessions). The ACS3 signing
//      algorithm is implemented inline (node:crypto only, no dependencies),
//      mirroring acs.ts from the MIT-licensed modelstudioai/cli.
//
// Keys are resolved through the engine's credential service by REFERENCE
// (`OPENCODE_GO_API_KEY` / `DEEPSEEK_API_KEY` / `BAILIAN_ACCESS_KEY_ID` / …),
// never read from a file: that is the same seam every provider uses, so a key
// the user rotates reaches the next request with no plugin restart.
//
// NOTE: the reference is passed as a plain string rather than importing
// `credentialRef` from `@deepseek-ai/dsh-credentials`. That helper only brands
// the value for TypeScript (`brandString` is a runtime no-op), while importing
// the package would make this plugin fail to load wherever the engine's
// dependency tree is not on the resolution path.

import { createHmac, createHash, randomUUID } from 'node:crypto'

export const name = 'model-usage'

// `credentials` for the API keys, `webServer` for the JSON route the page calls.
export const inject = ['credentials', 'webServer']

/**
 * Section key -> defaults. The section key is the wire/`sections` key; the
 * camelCase `configKey` is what the plugin row's `config` object uses (YAML
 * keys read better in camelCase). Also the display order.
 */
const SECTION_DEFAULTS = {
  'opencode-go': {
    configKey: 'opencodeGo',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiKeyRef: 'OPENCODE_GO_API_KEY',
    providers: ['opencode-go', 'opencode'],
  },
  deepseek: {
    configKey: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKeyRef: 'DEEPSEEK_API_KEY',
    // The engine's dsh-llm-deepseek adapter registers exactly this route
    // (`const PROVIDER = "deepseek-official"`).
    providers: ['deepseek-official'],
  },
  bailian: {
    configKey: 'bailian',
    // Bailian models surface through the engine's pi-ai catalog under these
    // provider route keys (qwen-token-plan* = 阿里云百炼 Token Plan):
    //   qwen-token-plan-cn        国内站 Token Plan（token-plan.cn-beijing.maas…）
    //   qwen-token-plan           国际站 Token Plan（token-plan.ap-southeast-1…）
    //   qwen-token-plan-individual个人版 Token Plan
    providers: [
      'qwen-token-plan',
      'qwen-token-plan-cn',
      'qwen-token-plan-individual',
    ],
    // Unlike the two Bearer-key sections, Bailian needs an Alibaba Cloud
    // OpenAPI AK/SK pair (optionally with an STS security token).
    accessKeyIdRef: 'BAILIAN_ACCESS_KEY_ID',
    accessKeySecretRef: 'BAILIAN_ACCESS_KEY_SECRET',
    securityTokenRef: 'BAILIAN_SECURITY_TOKEN',
  },
}

/** Host route the client half polls. */
const ROUTE_PATH = '/model-usage'

/** Buckets the OpenCode Go upstream reports, in display order. */
const BUCKETS = ['rolling', 'weekly', 'monthly']

/** Cache lifetime: an upstream is polled only this often, even on many page loads. */
const CACHE_TTL_MS = 60_000
/** Minimum gap between upstream calls after a failure (avoid hammering a 401). */
const FAILURE_TTL_MS = 30_000
/** Upstream request timeout. */
const REQUEST_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Bailian (Alibaba Cloud 百炼) — constants mirroring the official
// `bailian-cli` (modelstudioai/cli, MIT): refresh-token.ts + console/gateway.ts
// ---------------------------------------------------------------------------

/** ModelStudio OpenAPI host that mints CLI access tokens (cn region). */
const BAILIAN_OPENAPI_HOST = 'modelstudio.cn-beijing.aliyuncs.com'
/** GenerateCLIAccessToken request shape (see refresh-token.ts). */
const BAILIAN_TOKEN_PATH = '/modelstudio/cli/generateAccessToken'
const BAILIAN_TOKEN_ACTION = 'GenerateCLIAccessToken'
const BAILIAN_OPENAPI_VERSION = '2026-02-10'
/** Bailian console gateway that answers `zelda*` console APIs. */
const BAILIAN_GATEWAY_BASE = 'https://bailian-cs.console.aliyun.com'
const BAILIAN_GATEWAY_ACTION = 'BroadScopeAspnGateway'
const BAILIAN_GATEWAY_PRODUCT = 'sfm_bailian'
/** Token Plan personal usage console API (usage/token-plan.ts). */
const BAILIAN_USAGE_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'
/** Gateway region parameter (usage/token-plan.ts uses the console default). */
const BAILIAN_REGION = 'cn-beijing'

/** Bailian Token Plan quota windows mirrored from usage/token-plan.ts + quota-box.ts. */
const BAILIAN_WINDOWS = [
  { percentageKey: 'per5HourPercentage', resetKey: 'per5HourResetTime', bucketKey: 'fiveHour' },
  { percentageKey: 'per1WeekPercentage', resetKey: 'per1WeekResetTime', bucketKey: 'oneWeek' },
]

// --- ACS3-HMAC-SHA256 OpenAPI signing (pur et Node, no deps) -----------------

/** RFC 3986 percent-encoding, per Alibaba Cloud's ACS3 canonical query rules. */
function encodeRFC3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function sha256Hex(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function hmacSHA256Hex(secret, data) {
  return createHmac('sha256', secret).update(data, 'utf8').digest('hex')
}

/**
 * Build the ACS3 canonical query string from OpenAPI query parameters.
 * Mirrors `buildAcsCanonicalQuery` in modelstudioai/cli's acs.ts.
 */
export function buildAcsCanonicalQuery(params) {
  const pairs = []
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === '') continue
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const v = value[i]
        if (v !== '') pairs.push([`${key}.${i + 1}`, v])
      }
    } else {
      pairs.push([key, value])
    }
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return pairs
    .map(([key, value]) => `${encodeRFC3986(key)}=${encodeRFC3986(String(value))}`)
    .join('&')
}

/**
 * Sign an ACS3-HMAC-SHA256 request and return the headers to send.
 * Mirrors `signAcsRequest` in modelstudioai/cli's acs.ts.
 */
export function signAcsRequest({ accessKeyId, accessKeySecret, securityToken, action, version, body = '', host, pathname, queryString = '', method = 'POST' }) {
  const now = new Date()
  const dateISO = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const nonce = randomUUID()
  const hashedBody = sha256Hex(body)

  const headers = {
    host,
    'x-acs-action': action,
    'x-acs-version': version,
    'x-acs-date': dateISO,
    'x-acs-signature-nonce': nonce,
    'x-acs-content-sha256': hashedBody,
    'content-type': 'application/json',
  }
  if (securityToken) headers['x-acs-security-token'] = securityToken

  const signedHeaderKeys = Object.keys(headers)
    .filter((k) => k === 'host' || k === 'content-type' || k.startsWith('x-acs-'))
    .sort()
  const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${headers[k]}`).join('\n') + '\n'
  const signedHeadersStr = signedHeaderKeys.join(';')
  const canonicalRequest = [method, pathname, queryString, canonicalHeaders, signedHeadersStr, hashedBody].join('\n')

  const algorithm = 'ACS3-HMAC-SHA256'
  const hashedCanonical = sha256Hex(canonicalRequest)
  const stringToSign = `${algorithm}\n${hashedCanonical}`
  const signature = hmacSHA256Hex(accessKeySecret, stringToSign)

  headers.authorization = `${algorithm} Credential=${accessKeyId},SignedHeaders=${signedHeadersStr},Signature=${signature}`
  return headers
}

/**
 * Unwrap the DataV2 double-envelope the Bailian console gateway returns.
 * Mirrors `unwrapResponse` in modelstudioai/cli's console/models.ts.
 */
export function unwrapResponse(result) {
  const data = result?.data
  if (!data || typeof data !== 'object') return result
  const dataV2 = data.DataV2
  if (dataV2 && typeof dataV2 === 'object') {
    const inner = dataV2.data
    const innerData = inner && typeof inner === 'object' ? inner.data : undefined
    return innerData ?? inner ?? dataV2
  }
  const direct = data.data
  return direct ?? data
}

/**
 * Normalize a Bailian Token Plan usage body into our wire buckets, or null
 * when no usable window survived. Mirrors readUsage/readNumber from
 * usage/token-plan.ts + quota-box.ts: percentages are ratios in [0,1], reset
 * times are epoch milliseconds.
 * @returns `{ fiveHour: { percent, resetsAt }, oneWeek: { percent, resetsAt } }` or null.
 */
export function normalizeBailianUsage(body) {
  if (body === null || typeof body !== 'object') return null
  const response = unwrapResponse(body)
  const out = {}
  let any = false
  for (const { percentageKey, resetKey, bucketKey } of BAILIAN_WINDOWS) {
    const rawPercent = Number(response?.[percentageKey])
    if (!Number.isFinite(rawPercent)) continue
    const percent = Math.min(100, Math.max(0, Math.round(rawPercent * 100)))
    let resetsAt = null
    const rawReset = Number(response?.[resetKey])
    if (Number.isFinite(rawReset) && rawReset > 0) {
      const d = new Date(rawReset)
      if (!Number.isNaN(d.getTime())) resetsAt = d.toISOString()
    }
    out[bucketKey] = { percent, resetsAt }
    any = true
  }
  return any ? out : null
}

/**
 * Normalize one OpenCode Go bucket payload.
 * @returns `{ status, percent, resetsAt }` or null when unusable.
 */
export function normalizeBucket(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const percent = Number(raw.percent)
  if (!Number.isFinite(percent)) return null
  const status = typeof raw.status === 'string' && raw.status.length > 0 ? raw.status : 'ok'
  const resetsAt = typeof raw.resetsAt === 'string' && raw.resetsAt.length > 0 ? raw.resetsAt : null
  // Clamp: a hostile or buggy upstream must not produce a nonsense bar width.
  return { status, percent: Math.min(100, Math.max(0, percent)), resetsAt }
}

/** Normalize a whole OpenCode Go body into our wire shape, or null when unusable. */
export function normalizeUsage(body) {
  const usage = body?.usage
  if (usage === null || typeof usage !== 'object') return null
  const out = {}
  let any = false
  for (const key of BUCKETS) {
    const bucket = normalizeBucket(usage[key])
    if (bucket !== null) {
      out[key] = bucket
      any = true
    }
  }
  return any ? out : null
}

/**
 * A money amount the upstream reports as a decimal STRING (per DeepSeek's
 * contract). Accepts a finite number too, so a gateway that sends JSON numbers
 * still works; anything else is unusable.
 */
export function normalizeAmount(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * Normalize DeepSeek's Get User Balance body.
 *
 * Wire shape:
 *   { is_available: boolean,
 *     balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 *
 * `is_available: false` with no usable entry is still a REAL answer ("no balance
 * left"), so it is reported rather than degraded to bad-payload; only a body
 * that carries neither field is treated as unusable.
 *
 * @returns `{ isAvailable, infos: [{ currency, total, granted, toppedUp }] }` or null.
 */
export function normalizeBalance(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const hasFlag = typeof body.is_available === 'boolean'
  const rawInfos = Array.isArray(body.balance_infos) ? body.balance_infos : null
  if (!hasFlag && rawInfos === null) return null
  const infos = []
  for (const raw of rawInfos ?? []) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : ''
    const total = normalizeAmount(raw.total_balance)
    if (currency === '' || total === null) continue
    infos.push({
      currency,
      total,
      granted: normalizeAmount(raw.granted_balance),
      toppedUp: normalizeAmount(raw.topped_up_balance),
    })
  }
  return { isAvailable: body.is_available !== false, infos }
}

/** True when a provider route should show the widget. */
export function isTrackedProvider(provider, tracked) {
  if (typeof provider !== 'string' || provider.length === 0) return false
  return tracked.has(provider)
}

/** Shared upstream GET returning `{ ok, status, body }` or a classified failure. */
async function upstreamJson({ url, apiKey, fetchImpl, timeoutMs, log, label }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      log(`${label}: upstream responded`, res.status)
      return {
        ok: false,
        reason: res.status === 401 || res.status === 403 ? 'unauthorized' : 'upstream',
        status: res.status,
      }
    }
    const body = await res.json().catch(() => null)
    return { ok: true, body }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    log(`${label}: upstream request failed:`, error?.message ?? String(error))
    return { ok: false, reason: aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch OpenCode Go usage.
 * @returns `{ ok: true, usage, fetchedAt }` or `{ ok: false, reason, status? }`.
 */
export async function fetchUsage({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, log = () => {} }) {
  const res = await upstreamJson({
    url: `${baseUrl}/usage`,
    apiKey,
    fetchImpl,
    timeoutMs,
    log,
    label: 'model-usage/opencode-go',
  })
  if (!res.ok) return res
  const usage = normalizeUsage(res.body)
  if (usage === null) return { ok: false, reason: 'bad-payload' }
  return { ok: true, usage, fetchedAt: Date.now() }
}

/**
 * Fetch the DeepSeek account balance.
 * @returns `{ ok: true, balance, fetchedAt }` or `{ ok: false, reason, status? }`.
 */
export async function fetchBalance({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, log = () => {} }) {
  const res = await upstreamJson({
    url: `${baseUrl}/user/balance`,
    apiKey,
    fetchImpl,
    timeoutMs,
    log,
    label: 'model-usage/deepseek',
  })
  if (!res.ok) return res
  const balance = normalizeBalance(res.body)
  if (balance === null) return { ok: false, reason: 'bad-payload' }
  return { ok: true, balance, fetchedAt: Date.now() }
}

/**
 * Shared timed JSON request used by the Bailian flow (the Bearer sections use
 * `upstreamJson`). Returns `{ ok, body }` or a classified failure.
 */
async function timedJson({ url, init, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, log, label }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, ...init })
    if (!res.ok) {
      log(`${label}: upstream responded`, res.status)
      return {
        ok: false,
        reason: res.status === 401 || res.status === 403 ? 'unauthorized' : 'upstream',
        status: res.status,
      }
    }
    const body = await res.json().catch(() => null)
    return { ok: true, body }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    log(`${label}: upstream request failed:`, error?.message ?? String(error))
    return { ok: false, reason: aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Step 1 of the Bailian flow: exchange the Alibaba Cloud AK/SK for a temporary
 * CLI access token (ACS3-signed OpenAPI call).
 * @returns `{ ok: true, token }` or `{ ok: false, reason, status? }`.
 */
export async function fetchBailianAccessToken({ accessKeyId, accessKeySecret, securityToken, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, log = () => {} }) {
  if (typeof accessKeyId !== 'string' || accessKeyId.length === 0 || typeof accessKeySecret !== 'string' || accessKeySecret.length === 0) {
    return { ok: false, reason: 'no-key' }
  }
  const headers = signAcsRequest({
    accessKeyId,
    accessKeySecret,
    securityToken,
    action: BAILIAN_TOKEN_ACTION,
    version: BAILIAN_OPENAPI_VERSION,
    host: BAILIAN_OPENAPI_HOST,
    pathname: BAILIAN_TOKEN_PATH,
    method: 'POST',
  })
  const res = await timedJson({
    url: `https://${BAILIAN_OPENAPI_HOST}${BAILIAN_TOKEN_PATH}`,
    init: { method: 'POST', headers },
    fetchImpl,
    timeoutMs,
    log,
    label: 'model-usage/bailian/token',
  })
  if (!res.ok) return res
  const token = res.body?.cliAccessToken
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'bad-payload' }
  return { ok: true, token }
}

/**
 * Step 2 of the Bailian flow: ask the console gateway for Token Plan usage.
 * @returns `{ ok: true, usage, fetchedAt }` or `{ ok: false, reason, status? }`.
 */
export async function fetchBailianUsage({ accessKeyId, accessKeySecret, securityToken, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, log = () => {} }) {
  const tokenRes = await fetchBailianAccessToken({
    accessKeyId,
    accessKeySecret,
    securityToken,
    fetchImpl,
    timeoutMs,
    log,
  })
  if (!tokenRes.ok) return tokenRes

  const gatewayParams = JSON.stringify({
    Api: BAILIAN_USAGE_API,
    V: '1.0',
    Data: {
      cornerstoneParam: {
        protocol: 'V2',
        console: 'ONE_CONSOLE',
        productCode: 'p_efm',
        switchUserType: 3,
        consoleSite: 'BAILIAN_ALIYUN',
      },
    },
  })
  const endpoint =
    `${BAILIAN_GATEWAY_BASE}/cli/api.json?action=${BAILIAN_GATEWAY_ACTION}` +
    `&product=${BAILIAN_GATEWAY_PRODUCT}&api=${encodeURIComponent(BAILIAN_USAGE_API)}`
  const res = await timedJson({
    url: endpoint,
    init: {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Bearer ${tokenRes.token}`,
      },
      body: new URLSearchParams({ params: gatewayParams, region: BAILIAN_REGION }).toString(),
    },
    fetchImpl,
    timeoutMs,
    log,
    label: 'model-usage/bailian/usage',
  })
  if (!res.ok) return res

  // The gateway signals a failed business call inside the JSON body
  // (`{ data: { success: false, errorCode } }`) even on HTTP 200. A NotLogined
  // error means the AK/SK were fine but the minted token was rejected — that
  // is a credential problem, so classify it as unauthorized.
  const inner = res.body?.data
  if (inner && inner.success === false) {
    const errorCode = String(inner.errorCode ?? inner.code ?? '')
    log('model-usage/bailian/usage: gateway error', errorCode)
    return { ok: false, reason: errorCode.includes('NotLogined') ? 'unauthorized' : 'upstream' }
  }

  const usage = normalizeBailianUsage(res.body)
  if (usage === null) return { ok: false, reason: 'bad-payload' }
  return { ok: true, usage, fetchedAt: Date.now() }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  // Usage / balance is per-user data; never let a shared cache hold it.
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Per-section config with defaults, accepting the legacy flat shorthand. */
export function resolveSections(config = {}) {
  const legacy = {
    baseUrl: config.baseUrl,
    apiKeyRef: config.apiKeyRef,
    providers: config.providers,
  }
  const out = {}
  for (const [key, defaults] of Object.entries(SECTION_DEFAULTS)) {
    const configured = config[defaults.configKey]
    // The plugin used to be OpenCode-Go-only, so a flat top-level config is read
    // as that section; the deepseek section never inherits it.
    const raw = key === 'opencode-go' ? { ...legacy, ...(configured ?? {}) } : (configured ?? {})
    const providers = Array.isArray(raw.providers) && raw.providers.length > 0
      ? raw.providers.map((p) => String(p))
      : [...defaults.providers]
    const base = {
      providers,
      tracked: new Set(providers),
    }
    if (defaults.configKey === 'bailian') {
      out[key] = {
        ...base,
        accessKeyIdRef: typeof raw.accessKeyIdRef === 'string' && raw.accessKeyIdRef.length > 0 ? raw.accessKeyIdRef : defaults.accessKeyIdRef,
        accessKeySecretRef: typeof raw.accessKeySecretRef === 'string' && raw.accessKeySecretRef.length > 0 ? raw.accessKeySecretRef : defaults.accessKeySecretRef,
        securityTokenRef: typeof raw.securityTokenRef === 'string' && raw.securityTokenRef.length > 0 ? raw.securityTokenRef : (defaults.securityTokenRef ?? null),
      }
      continue
    }
    out[key] = {
      ...base,
      baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl.length > 0
        ? raw.baseUrl.replace(/\/+$/u, '')
        : defaults.baseUrl,
      apiKeyRef: typeof raw.apiKeyRef === 'string' && raw.apiKeyRef.length > 0 ? raw.apiKeyRef : defaults.apiKeyRef,
    }
  }
  return out
}

export function apply(ctx, config = {}) {
  const sections = resolveSections(config)
  const enabled = config.enabled !== false

  if (!enabled) {
    ctx.logger?.info?.('[model-usage] disabled by configuration')
    return
  }

  // One upstream poll per section serves every page load inside the TTL window.
  const caches = new Map()

  const readSection = async (key) => {
    const section = sections[key]
    const now = Date.now()
    const cached = caches.get(key)
    if (cached !== undefined && cached.inflight === null) {
      const ttl = cached.value.ok ? CACHE_TTL_MS : FAILURE_TTL_MS
      if (now - cached.at < ttl) return cached.value
    }
    if (cached !== undefined && cached.inflight !== null) return cached.inflight

    const run = (async () => {
      let value
      try {
        if (key === 'bailian') {
          const credentials = await Promise.all(
            [section.accessKeyIdRef, section.accessKeySecretRef, section.securityTokenRef]
              .filter((ref) => typeof ref === 'string' && ref.length > 0)
              .map(async (ref) => [ref, (await ctx.credentials.resolve(ref))?.value]),
          )
          const byRef = new Map(credentials)
          const accessKeyId = byRef.get(section.accessKeyIdRef)
          const accessKeySecret = byRef.get(section.accessKeySecretRef)
          if (typeof accessKeyId !== 'string' || accessKeyId.length === 0 || typeof accessKeySecret !== 'string' || accessKeySecret.length === 0) {
            value = { ok: false, reason: 'no-key' }
          } else {
            const log = (...a) => ctx.logger?.info?.(...a)
            value = await fetchBailianUsage({
              accessKeyId,
              accessKeySecret,
              securityToken: section.securityTokenRef ? byRef.get(section.securityTokenRef) : undefined,
              log,
            })
          }
        } else {
          const resolved = await ctx.credentials.resolve(section.apiKeyRef)
          const apiKey = resolved?.value
          if (typeof apiKey !== 'string' || apiKey.length === 0) {
            value = { ok: false, reason: 'no-key', apiKeyRef: section.apiKeyRef }
          } else {
            const log = (...a) => ctx.logger?.info?.(...a)
            value = key === 'deepseek'
              ? await fetchBalance({ baseUrl: section.baseUrl, apiKey, log })
              : await fetchUsage({ baseUrl: section.baseUrl, apiKey, log })
          }
        }
      } catch (error) {
        ctx.logger?.warn?.('[model-usage] resolve failed for %s: %s', key, error?.message ?? String(error))
        value = { ok: false, reason: 'credentials-error' }
      } finally {
        const entry = caches.get(key)
        if (entry !== undefined) entry.inflight = null
      }
      caches.set(key, { at: Date.now(), value, inflight: null })
      return value
    })()

    caches.set(key, { at: now, value: cached?.value ?? { ok: false, reason: 'pending' }, inflight: run })
    return run
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.setHeader('allow', 'GET')
            return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          }
          const keys = Object.keys(sections)
          const results = await Promise.all(keys.map((key) => readSection(key)))
          // Each section reports its own outcome, so a missing OpenCode Go key
          // never hides the DeepSeek balance (and vice versa).
          const payloadSections = {}
          for (const key of keys) {
            payloadSections[key] = {
              providers: sections[key].providers,
              // Diagnostic only — the browser never receives a value, just the
              // ref names, so an operator can see which credential is missing.
              keyRef: sections[key].apiKeyRef ?? sections[key].accessKeyIdRef ?? null,
              keyRefs: sections[key].apiKeyRef
                ? [sections[key].apiKeyRef]
                : [sections[key].accessKeyIdRef, sections[key].accessKeySecretRef, sections[key].securityTokenRef].filter((ref) => typeof ref === 'string' && ref.length > 0),
            }
          }
          const out = { ok: true, sections: payloadSections }
          keys.forEach((key, index) => {
            const value = results[index]
            out[key] = value.ok === true
              ? {
                  ok: true,
                  usage: value.usage,
                  balance: value.balance,
                  fetchedAt: value.fetchedAt,
                }
              : { ok: false, reason: value.reason }
          })
          // Never leak a key or an upstream body verbatim — only our shape.
          return sendJson(res, 200, out)
        } catch (error) {
          ctx.logger?.warn?.('[model-usage] request failed: %s', error?.message ?? String(error))
          return sendJson(res, 500, { ok: false, error: 'internal error' })
        }
      },
    })
    ctx.logger?.info?.(
      '[model-usage] active (%s)',
      Object.entries(sections)
        .map(([key, s]) => `${key}: providers=${s.providers.join('|')} credential=${s.apiKeyRef ?? s.accessKeyIdRef ?? '-'}`)
        .join('; '),
    )
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'model-usage.route')
}

export default { name, inject, apply }
