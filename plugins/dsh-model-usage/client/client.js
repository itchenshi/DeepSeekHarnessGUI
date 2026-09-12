// dsh-model-usage — client (browser) half.
//
// Shows model usage / account balance in the Session header, gated on the
// session's ACTIVE model selection:
//   - OpenCode Go models -> plan usage (rolling / weekly / monthly percentages)
//   - DeepSeek models    -> account balance (total / granted / topped-up)
//
// PLACEMENT
// ---------
// Slot: `conversation.session.header.actions` — the engine documents this as
// "Title-adjacent Session actions in ascending order". Verified against the
// engine's own header source:
//
//   titleRow
//     ├─ titleCluster
//     │    ├─ crumbs            <- the session title
//     │    └─ headerActions     <- THIS SLOT (right of title)
//     ├─ headerUtilities        <- "open feature" buttons (open-in-app, export)
//     └─ headerCorner           <- right-sidebar ExpandButton
//
// so the widget sits exactly right of the title and left of the open-feature
// controls.
//
// VERIFIED PROPS CONTRACT (measured on a live page, not assumed)
// -------------------------------------------------------------
// An occupant of this slot receives:
//   sessionId                        (string)   — the rendered session
//   useSessions/useSession/useChat/… (hooks)    — framework-provided
//   t                                (function) — ONLY when the registration
//                                                 passes `locale: NS`
//   …plus whatever `inject: () => ({...})` returns
// and NOT a `t` or model hook by default. This matters: the first draft
// assumed framework-injected `useModel`, which does not exist.
//
// Model detection reads `ctx.modelDirectories.directoryFor(sessionId).store`,
// whose verified snapshot shape is:
//   { current: { provider, model, … } | null, status, groups, … }
// and `current.provider` is the route key ("opencode-go", "deepseek-official").
//
// WHICH SECTION TO SHOW
// ---------------------
// The host half owns the provider->section mapping (it is configuration), and
// returns it on every poll as `sections`. The client therefore gates on the
// host's live configuration instead of duplicating it, so changing `providers`
// in cordis.patch.yml takes effect without touching this file.

window.__ModuleLoader__.load({
  id: 'dsh-model-usage',
  factory: (require) => {
    const React = require('react')
    const jsx = require('react/jsx-runtime')

    // --- constants ---------------------------------------------------------

    /** Host route serving the normalized usage/balance payload. */
    const ROUTE_PATH = '/model-usage'
    /** How often the widget re-polls while mounted. */
    const POLL_INTERVAL_MS = 60_000
    /** Locale namespace for our own strings. */
    const NS = 'model-usage'

    /** OpenCode Go buckets in display order. */
    const BUCKETS = [
      { key: 'rolling', zh: '滚动', en: 'Roll', titleZh: '滚动窗口', titleEn: 'Rolling window' },
      { key: 'weekly', zh: '周', en: 'Week', titleZh: '本周', titleEn: 'Weekly' },
      { key: 'monthly', zh: '月', en: 'Month', titleZh: '本月', titleEn: 'Monthly' },
    ]

    /**
     * Fallback provider mapping, used only until the first host response
     * arrives (the host's `sections` wins, because it reflects configuration).
     */
    const FALLBACK_SECTIONS = {
      'opencode-go': { providers: ['opencode-go', 'opencode'] },
      deepseek: { providers: ['deepseek-official'] },
    }

    // --- usage store -------------------------------------------------------

    /** Tiny external store consumed through React.useSyncExternalStore. */
    function createUsageStore() {
      let state = { status: 'idle', payload: null, reason: null }
      const listeners = new Set()
      return {
        get: () => state,
        subscribe: (l) => {
          listeners.add(l)
          return () => listeners.delete(l)
        },
        set: (next) => {
          state = { ...state, ...next }
          for (const l of listeners) l()
        },
      }
    }

    /** Poll the host route; every failure is non-fatal (the widget hides). */
    function startPolling(store, intervalMs) {
      let stopped = false
      let timer = null
      const tick = async () => {
        if (stopped) return
        try {
          const res = await fetch(ROUTE_PATH, { headers: { accept: 'application/json' } })
          const body = await res.json().catch(() => null)
          if (stopped) return
          if (body && body.ok === true) {
            store.set({ status: 'ready', payload: body, reason: null })
          } else {
            store.set({ status: 'error', payload: null, reason: (body && body.reason) || 'unknown' })
          }
        } catch {
          if (!stopped) store.set({ status: 'error', payload: null, reason: 'unreachable' })
        } finally {
          if (!stopped) timer = setTimeout(tick, intervalMs)
        }
      }
      tick()
      return () => {
        stopped = true
        if (timer !== null) clearTimeout(timer)
      }
    }

    // --- helpers -----------------------------------------------------------

    /**
     * Which section (if any) belongs to this provider route.
     * @returns the section key, or null when no section tracks it.
     */
    function pickSection(provider, sections) {
      if (typeof provider !== 'string' || provider === '') return null
      const map = sections && typeof sections === 'object' ? sections : FALLBACK_SECTIONS
      for (const [key, def] of Object.entries(map)) {
        const providers = Array.isArray(def?.providers) ? def.providers : []
        if (providers.includes(provider)) return key
      }
      return null
    }

    /** True when this provider route is tracked by any section. */
    function isTracked(provider, sections) {
      return pickSection(provider, sections) !== null
    }

    /** Colour by consumption: comfortable -> caution -> danger. */
    function percentColor(percent) {
      if (percent >= 90) return '#e5534b'
      if (percent >= 70) return '#e8a33d'
      return '#4d9fff'
    }

    /** Currency symbol for the account balance. */
    function currencySymbol(code) {
      const upper = typeof code === 'string' ? code.toUpperCase() : ''
      if (upper === 'CNY') return '¥'
      if (upper === 'USD') return '$'
      return upper === '' ? '' : `${upper} `
    }

    /** One balance entry rendered as `¥110.00`. */
    function formatAmount(info) {
      if (info === null || typeof info !== 'object') return ''
      return `${currencySymbol(info.currency)}${info.total ?? ''}`
    }

    /** Compact "resets in …" text. */
    function formatReset(iso, zh) {
      try {
        const d = new Date(iso)
        if (Number.isNaN(d.getTime())) return ''
        const hours = (d.getTime() - Date.now()) / 3_600_000
        if (hours > 0 && hours < 24) {
          const h = Math.floor(hours)
          const m = Math.floor((hours - h) * 60)
          return zh ? `${h}小时${m}分后重置` : `resets in ${h}h${m}m`
        }
        const date = d.toLocaleDateString(zh ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric' })
        return zh ? `${date} 重置` : `resets ${date}`
      } catch {
        return ''
      }
    }

    /** Bucket label in the active language. */
    function bucketLabel(bucket, zh) {
      return zh ? bucket.zh : bucket.en
    }

    // styles
    const S_WRAP = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '10px',
      fontSize: '11px',
      lineHeight: '16px',
      whiteSpace: 'nowrap',
      userSelect: 'none',
      padding: '0 2px',
    }
    const S_BUCKET = { display: 'inline-flex', alignItems: 'center', gap: '3px' }
    const S_DIM = { opacity: 0.6 }

    // --- locale dictionaries ----------------------------------------------

    // `__lang` is a self-describing sentinel the component reads through `t()`
    // to learn the active language. There is no `ctx.locale.current()` method
    // (verified at runtime: the locale service exposes dicts/bound/snapshot/…
    // but no current()), so the translator itself is the discriminator.
    const zhDict = {
      __lang: 'zh-CN',
      labelOc: 'OpenCode Go',
      labelDs: 'DeepSeek',
      noKey: '未配置密钥',
      unavailable: '用量不可用',
      balanceUnavailable: '余额不可用',
      insufficient: '余额不足',
      titleOcUsage: 'OpenCode Go 套餐用量（仅在使用 OpenCode Go 模型时显示）',
      titleOcUnavailable: '暂时取不到 OpenCode Go 用量',
      titleDsBalance: 'DeepSeek 账户余额（仅在使用 DeepSeek 模型时显示）',
      titleDsUnavailable: '暂时取不到 DeepSeek 余额',
      total: '总',
      granted: '赠送',
      toppedUp: '充值',
      insufficientHint: '余额不足，API 调用可能失败',
    }
    const enDict = {
      __lang: 'en-US',
      labelOc: 'OpenCode Go',
      labelDs: 'DeepSeek',
      noKey: 'no key',
      unavailable: 'usage n/a',
      balanceUnavailable: 'balance n/a',
      insufficient: 'insufficient',
      titleOcUsage: 'OpenCode Go plan usage (shown only while an OpenCode Go model is active)',
      titleOcUnavailable: 'OpenCode Go usage is temporarily unavailable',
      titleDsBalance: 'DeepSeek account balance (shown only while a DeepSeek model is active)',
      titleDsUnavailable: 'DeepSeek balance is temporarily unavailable',
      total: 'total',
      granted: 'granted',
      toppedUp: 'topped up',
      insufficientHint: 'Balance is insufficient; API calls may fail',
    }

    // --- component ---------------------------------------------------------

    /** The "cannot read it" face shared by both sections. */
    function renderUnavailable(t, reason, title) {
      const label = reason === 'no-key' ? t('noKey') : t('unavailable')
      return jsx.jsx('span', {
        className: 'model-usage',
        title,
        style: S_WRAP,
        children: jsx.jsx('span', { style: S_DIM, children: label }),
      })
    }

    /** OpenCode Go: rolling / weekly / monthly percentages. */
    function renderOpenCodeGo(section, t, zh) {
      if (!section || section.ok !== true || !section.usage) {
        return renderUnavailable(t, section?.reason, t('titleOcUnavailable'))
      }
      const parts = []
      for (const bucket of BUCKETS) {
        const b = section.usage[bucket.key]
        if (!b) continue
        const tip =
          `${zh ? bucket.titleZh : bucket.titleEn} · ${b.percent}%` +
          (b.resetsAt ? ` · ${formatReset(b.resetsAt, zh)}` : '')
        parts.push(
          jsx.jsxs(
            'span',
            {
              key: bucket.key,
              title: tip,
              style: S_BUCKET,
              children: [
                jsx.jsx('span', { style: S_DIM, children: bucketLabel(bucket, zh) }),
                jsx.jsx('span', { style: { color: percentColor(b.percent), fontWeight: 600 }, children: `${b.percent}%` }),
              ],
            },
            bucket.key,
          ),
        )
      }
      if (parts.length === 0) return renderUnavailable(t, 'bad-payload', t('titleOcUnavailable'))
      return jsx.jsxs('span', {
        className: 'model-usage',
        title: t('titleOcUsage'),
        style: S_WRAP,
        children: [jsx.jsx('span', { style: S_DIM, children: t('labelOc') }), ...parts],
      })
    }

    /** DeepSeek: account balance amounts. */
    function renderDeepSeek(section, t, zh) {
      if (!section || section.ok !== true || !section.balance) {
        return renderUnavailable(t, section?.reason, t('titleDsUnavailable'))
      }
      const balance = section.balance
      const infos = Array.isArray(balance.infos) ? balance.infos : []
      const insufficient = balance.isAvailable === false

      if (infos.length === 0) {
        // Documented shape: is_available:false with an empty balance_infos list.
        return jsx.jsx('span', {
          className: 'model-usage',
          title: t('insufficientHint'),
          style: S_WRAP,
          children: jsx.jsx('span', { style: { color: '#e5534b', fontWeight: 600 }, children: t('insufficient') }),
        })
      }

      const tipParts = []
      for (const info of infos) {
        const bits = [`${t('total')} ${formatAmount(info)}`]
        if (info.granted) bits.push(`${t('granted')} ${currencySymbol(info.currency)}${info.granted}`)
        if (info.toppedUp) bits.push(`${t('toppedUp')} ${currencySymbol(info.currency)}${info.toppedUp}`)
        tipParts.push(bits.join(' · '))
      }
      const title = insufficient
        ? `${t('titleDsBalance')} · ${t('insufficientHint')}`
        : `${t('titleDsBalance')} · ${tipParts.join(' | ')}`

      const amounts = infos.map((info, index) =>
        jsx.jsx(
          'span',
          {
            title: tipParts[index],
            style: { color: insufficient ? '#e5534b' : '#4d9fff', fontWeight: 600 },
            children: formatAmount(info),
          },
          `${info.currency}-${index}`,
        ),
      )

      const children = [jsx.jsx('span', { style: S_DIM, children: t('labelDs') }), ...amounts]
      if (insufficient) {
        children.push(jsx.jsx('span', { style: { color: '#e5534b' }, children: t('insufficient') }, 'insufficient'))
      }
      return jsx.jsxs('span', {
        className: 'model-usage',
        title,
        style: S_WRAP,
        children,
      })
    }

    /**
     * The header widget. Returns null (renders nothing) unless the session's
     * current model belongs to a section the host tracks — that is the whole
     * gating rule.
     */
    function ModelUsage(props) {
      const { sessionId, useUsage, readModel, t } = props
      const lang = t('__lang')
      const zh = lang.startsWith('zh')

      // Model selection for this session (verified snapshot shape).
      const modelSnapshot = React.useSyncExternalStore(
        React.useCallback(
          (onChange) => {
            if (!readModel || !sessionId) return () => {}
            try {
              const dir = readModel(sessionId)
              if (!dir || !dir.store) return () => {}
              const unsub = dir.store.subscribe(onChange)
              return typeof unsub === 'function' ? unsub : () => {}
            } catch {
              return () => {}
            }
          },
          [sessionId, readModel],
        ),
        React.useCallback(() => {
          if (!readModel || !sessionId) return null
          try {
            const dir = readModel(sessionId)
            return dir && dir.store ? dir.store.getSnapshot() : null
          } catch {
            return null
          }
        }, [sessionId, readModel]),
        () => null,
      )

      const state = useUsage()
      const provider = modelSnapshot && modelSnapshot.current ? modelSnapshot.current.provider : undefined

      if (!state || state.status === 'idle') return null
      const payload = state.payload
      // Before the first successful poll we still gate on the fallback mapping,
      // so a tracked provider shows "unavailable" instead of flickering in/out.
      const sectionKey = pickSection(provider, payload?.sections)
      if (sectionKey === null) return null

      const section = payload ? payload[sectionKey] : null
      if (state.status !== 'ready' && state.status !== 'error') return null

      if (sectionKey === 'deepseek') return renderDeepSeek(section, t, zh)
      return renderOpenCodeGo(section, t, zh)
    }

    // --- plugin face -------------------------------------------------------

    const name = 'model-usage'

    /** SERVICE names read off ctx (the fiber inject). */
    const inject = ['slots', 'locale', 'modelDirectories']

    function apply(ctx) {
      const store = createUsageStore()
      const stopPolling = startPolling(store, POLL_INTERVAL_MS)
      ctx.effect(() => () => stopPolling(), 'model-usage:poll')

      ctx.effect(
        () => ctx.locale.register(NS, { zh: zhDict, en: enDict }),
        'model-usage:dict',
      )

      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'model-usage',
            // Negative order keeps us closest to the title (actions ascend).
            order: -10,
            locale: NS,
            inject: () => ({
              useUsage: () => React.useSyncExternalStore(store.subscribe, store.get, store.get),
              // Returns the per-session model directory (throws for unknown
              // sessions; the component catches and hides).
              readModel: (sessionId) => ctx.modelDirectories.directoryFor(sessionId),
            }),
          },
          ModelUsage,
        ),
      )
    }

    return {
      name,
      inject,
      apply,
      // Exported for unit tests.
      pickSection,
      isTracked,
      percentColor,
      currencySymbol,
      formatAmount,
      formatReset,
      createUsageStore,
    }
  },
})
