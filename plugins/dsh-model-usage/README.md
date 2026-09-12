# dsh-model-usage

Shows **model usage / account balance** in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
session header, gated on the session's **active model selection**:

| Active model route | Widget shows | Source |
|---|---|---|
| `opencode-go` / `opencode` | OpenCode Go plan usage — rolling / weekly / monthly **percentages** + reset time | `GET https://opencode.ai/zen/go/v1/usage` |
| `deepseek-official` | DeepSeek account **balance** — total / granted / topped-up | `GET https://api.deepseek.com/user/balance` |
| `qwen-token-plan` / `qwen-token-plan-cn` / `qwen-token-plan-individual` | Bailian (百炼) Token Plan quota — 5-hour / 1-week **percentages** + reset time | Alibaba Cloud console gateway (AK/SK → CLI access token) |

```
┌─ session header ─────────────────────────────────────────────────────┐
│  My conversation title  [OpenCode Go ┄⑃ 滚动 18% 周 82% 月 42%]  打开功能 ▾ │
│  Another conversation   [DeepSeek ¥110.00]                        打开功能 ▾ │
│  Qwen session           [百炼 5小时 50% 1周 25%]                  打开功能 ▾ │
└──────────────────────────────────────────────────────────────────────┘
        slot: conversation.session.header.actions
```

## Placement

The widget registers at `conversation.session.header.actions`, which the engine
documents as "Title-adjacent Session actions in ascending order" — verified in
the engine's own header source as:

```
titleRow
  ├─ titleCluster
  │    ├─ crumbs         ← the session title
  │    └─ headerActions  ← THIS widget (right of title)
  ├─ headerUtilities     ← "open feature" buttons
  └─ headerCorner        ← right-sidebar ExpandButton
```

## Gating rule

The widget renders only when the session's current model routes to a **tracked**
provider. The selection is read from
`ctx.modelDirectories.directoryFor(sessionId).store` — the same shared state the
model selector and composer seat use, so a model switch shows/hides the widget
immediately.

Which route belongs to which section is **configuration, owned by the host
half**: the host returns its live provider→section map (`sections`) on every
poll, and the client gates on that. Changing `providers` in `cordis.patch.yml`
therefore takes effect without touching client code.

## Two halves

| Half | File | Runs in | Job |
|---|---|---|---|
| Host | `lib/index.js` | Node | Fetches each section from its upstream and serves it over one same-origin JSON route. |
| Client | `client/client.js` | Browser | Registers the header widget, polls the host route, gates on the active model. |

API keys never reach the browser: the host half resolves them through
`ctx.credentials` by reference (`OPENCODE_GO_API_KEY`, `DEEPSEEK_API_KEY`,
`BAILIAN_ACCESS_KEY_ID`, `BAILIAN_ACCESS_KEY_SECRET`, `BAILIAN_SECURITY_TOKEN`)
and calls the upstream.

## Host route

```
GET /model-usage
{
  "ok": true,
  "sections": {
    "opencode-go": { "providers": ["opencode-go","opencode"], "keyRef": "OPENCODE_GO_API_KEY" },
    "deepseek":    { "providers": ["deepseek-official"],    "keyRef": "DEEPSEEK_API_KEY" },
    "bailian":     { "providers": ["qwen-token-plan","qwen-token-plan-cn","qwen-token-plan-individual"], "keyRefs": ["BAILIAN_ACCESS_KEY_ID","BAILIAN_ACCESS_KEY_SECRET","BAILIAN_SECURITY_TOKEN"] }
  },
  "opencode-go": { "ok": true, "usage":   { "rolling": {…}, "weekly": {…}, "monthly": {…} }, "fetchedAt": 1700000000000 },
  "deepseek":    { "ok": true, "balance": { "isAvailable": true, "infos": [ { "currency":"CNY", "total":"110.00", "granted":"10.00", "toppedUp":"100.00" } ] }, "fetchedAt": 1700000000000 },
  "bailian":     { "ok": true, "usage":   { "fiveHour": { "percent": 50, "resetsAt": "…" }, "oneWeek": { "percent": 25, "resetsAt": "…" } }, "fetchedAt": 1700000000000 }
}
```

The per-section entries are keyed by **section key** — the same keys as `sections`, which is what the page half indexes with (the camelCase `opencodeGo` / `deepseek` names are the *config* keys in `cordis.patch.yml`, not the wire keys).

Each section reports **its own** outcome, so a user with only one of the keys
still gets that half; the other halves degrade to a diagnostic label
(`{"ok":false,"reason":"no-key|unauthorized|network|timeout|bad-payload"}`)
instead of hiding the widget.

## Upstream APIs (verified)

**OpenCode Go usage**

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_API_KEY>
200 {"usage":{"rolling":{"status":"ok","percent":18,"resetsAt":"..."},
              "weekly":{...},"monthly":{...}}}
```

**DeepSeek account balance** ([official docs](https://api-docs.deepseek.com/api/get-user-balance/))

```
GET https://api.deepseek.com/user/balance
Authorization: Bearer <DEEPSEEK_API_KEY>
200 {"is_available":true,
     "balance_infos":[{"currency":"CNY","total_balance":"110.00",
                       "granted_balance":"10.00","topped_up_balance":"100.00"}]}
```

**Bailian (百炼) Token Plan quota** — Bailian has no "Bearer key → GET balance"
endpoint, so this section reproduces the official `bailian-cli`
([modelstudioai/cli](https://github.com/modelstudioai/cli), MIT) flow:

1. Exchange the Alibaba Cloud OpenAPI AK/SK for a temporary CLI access token
   (ACS3-HMAC-SHA256-signed request):
   ```
   POST https://modelstudio.cn-beijing.aliyuncs.com/modelstudio/cli/generateAccessToken
   x-acs-action: GenerateCLIAccessToken
   x-acs-version: 2026-02-10
   200 {"cliAccessToken":"..."}
   ```
2. Ask the Bailian console gateway for Token Plan usage:
   ```
   POST https://bailian-cs.console.aliyun.com/cli/api.json
        ?action=BroadScopeAspnGateway&product=sfm_bailian
        &api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage
   Authorization: Bearer <cliAccessToken>
   form: params=<JSON gateway body>&region=cn-beijing
   200 {"data":{"DataV2":{"data":{"data":{
         "per5HourPercentage":0.5,"per5HourResetTime":1786000000000,
         "per1WeekPercentage":0.25,"per1WeekResetTime":1786100000000}}}}}
   ```
   Percentages arrive as ratios in [0,1] (0.5 = 50% used); reset times are
   epoch milliseconds. A `NotLogined` gateway error (expired/rejected token)
   degrades to `reason:"unauthorized"`.

The host normalizes and clamps the usage payload (percent 0–100) and normalizes
the balance amounts (the upstream sends decimal **strings**; finite numbers are
accepted too). Each section is cached for 60s and re-polled after failures no
sooner than 30s.

## Install (local, no npm publication)

```sh
# from the directory that contains `plugins/dsh-model-usage`
dsh plugin --profile web add file:./plugins/dsh-model-usage
```

Or via the DSH GUI's bundled engine bin (the GUI stages and installs it
automatically when you check it in Settings → Third-party plugins).

## Configuration

The plugin row lives in `cordis.patch.yml`; every key is optional:

```yaml
- insert:
    - id: model-usage
      name: dsh-model-usage
      config:
        enabled: true

        opencodeGo:
          baseUrl: https://opencode.ai/zen/go/v1   # upstream root
          apiKeyRef: OPENCODE_GO_API_KEY           # credential reference
          providers: [opencode-go, opencode]       # routes treated as OpenCode Go

        deepseek:
          baseUrl: https://api.deepseek.com        # upstream root
          apiKeyRef: DEEPSEEK_API_KEY              # credential reference
          providers: [deepseek-official]           # the engine's DeepSeek route

        bailian:
          accessKeyIdRef: BAILIAN_ACCESS_KEY_ID      # Alibaba Cloud AccessKey ID
          accessKeySecretRef: BAILIAN_ACCESS_KEY_SECRET  # Alibaba Cloud AccessKey Secret
          securityTokenRef: BAILIAN_SECURITY_TOKEN   # optional STS token
          providers:                                  # routes treated as Bailian
            - qwen-token-plan          # 国际站 Token Plan
            - qwen-token-plan-cn       # 国内站 Token Plan
            - qwen-token-plan-individual  # 个人版 Token Plan
```

A top-level `baseUrl` / `apiKeyRef` / `providers` is still read as the
`opencodeGo` section (this plugin used to be OpenCode-Go-only).

> The Bailian section needs the engine's `dsh-credentials` service to know
> `BAILIAN_ACCESS_KEY_ID` / `BAILIAN_ACCESS_KEY_SECRET` (create the keys in the
> Alibaba Cloud console — RAM user with access to Bailian — and add them as
> credentials like the DeepSeek key). Without them the widget shows
> `未配置密钥` for live Bailian sessions; the other two sections are unaffected.

## Development

```sh
node --check lib/index.js
npm test        # local behaviour tests (no network, no engine)
```

`tests/e2e.cjs` is a full integration check against a real engine + browser
(it needs a running profile, so it is not part of `npm test`).

## License

MIT
