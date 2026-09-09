# dsh-opencode-go-session

A security-hardened [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH) plugin that attaches a stable **`x-opencode-session`** request header on
model calls routed to **OpenCode / OpenCode Go** providers — one opaque session
value per DSH conversation.

This is a hardened rewrite of the third-party `dsh-opencode-session` plugin,
kept fully compatible with its purpose (fixes `400 MissingSessionID` and keeps
OpenCode session-affinity / prompt-cache routing) while closing the security
findings listed below.

## Security hardening (vs. `dsh-opencode-session`)

| Finding in the original | Fix in this plugin |
|---|---|
| **Default `mode: 'session-id'` sent the internal DSH session id verbatim to a third-party upstream** (identifier leakage / session-correlation risk). | Default mode is now **`uuid`**: each DSH session maps to an **opaque random UUID**, only that UUID is ever sent. `session-id` is opt-in only. |
| Header value passed through `String()` with no validation (potential header smuggling via control characters). | Header values are rejected unless they contain only safe visible characters (`/^[\x21-\x7e\x80-\u10ffff]+$/u`). |
| Global `globalThis.fetch` patch restoration could clobber another plugin's patch. | Restoration only occurs when this plugin is still the active patch; the patch is only *effective* inside an active OpenCode store. |
| `debugFile` accepted any arbitrary path and logged the raw DSH session id. | `debugFile` is honored **only** under `$DSH_HOME/logs` or the OS temp dir (fails closed otherwise), and the logged `session` field is a **one-way SHA-256 hash**, never the raw internal id. |
| In-memory session→uuid table could grow unbounded on long-running processes. | Table is capped (`UUID_TABLE_MAX = 4096`); oldest entry is evicted first. |

## Install (local, no npm publication)

This plugin is designed to be installed as a **local path** dependency so the
package never has to be published to the npm registry:

```sh
# from the directory that contains `plugins/dsh-opencode-go-session`
dsh plugin --profile web add file:./plugins/dsh-opencode-go-session
```

Or via the DSH GUI's bundled engine bin:

```sh
node "<engine>/lib/bin.js" plugin --profile web add file:./plugins/dsh-opencode-go-session
```

The engine's `plugin` command is a thin pnpm forwarder: a local `file:` spec is
installed by its **true package name** (`dsh-opencode-go-session`) and, because
the manifest declares `dsh.bundle.patch`, it joins the profile's bundle layer
stack automatically. Then **fully restart** your dsh profile (bundle layers are
read at boot). The startup log shows:

```
[opencode-go-session-header] active for providers [opencode, opencode-go] with mode uuid (debug=off)
```

## Configuration

The plugin row lives in the bundle's `cordis.patch.yml`; all keys are optional:

```yaml
- insert:
    - id: opencode-go-session-header
      name: dsh-opencode-go-session
      config:
        providers: [opencode, opencode-go]   # route keys to attach the header to
        mode: uuid                           # 'uuid' (default) | 'session-id'
        debug: false
        debugFile: null                      # optional path under $DSH_HOME/logs or temp
```

- `providers` — provider route keys whose requests get the header. Defaults cover
  the pi-ai catalog ids `opencode` and `opencode-go`; add your own route key when
  you serve OpenCode through a custom provider name.
- `mode`
  - `uuid` (**default, secure**) — a random opaque UUID derived once per DSH
    session id. The internal DSH session id is **never** sent to third parties.
  - `session-id` — **opt-in**: header value = the DSH session id of the model
    call (the same identity the official adapter sends as
    `x-deepseek-harness-session-id`). Only choose this if you fully trust the
    OpenCode upstream with your internal id.
- `debug` — log every streamed call that receives the header via `ctx.logger`.
- `debugFile` — optional. A relative path is anchored to `$DSH_HOME/logs`; an
  absolute path is honored only if it lies under `$DSH_HOME/logs` or the OS temp
  dir. Any other value is ignored (fails closed). Every streamed call appends one
  JSON line (`{"ts","provider","model","mode","session","header","value"}`) where
  `session` is a hashed (redacted) form of the DSH session id.

To override configuration in a profile without editing the package, add a row
with the same id in the profile's own `cordis.patch.yml` (it replaces the whole
`config`, so restate every key).

## How it works

1. Listens on the `llm/stream` waterfall. A call whose `options.provider` names a
   configured OpenCode route and which carries a `sessionId` is driven through an
   `AsyncLocalStorage` store holding the header value.
2. `globalThis.fetch` is patched once. While such a store is active, the outgoing
   request receives `x-opencode-session: <value>` (unless it already carries the
   header — an existing value always wins).
3. Both registrations are fiber-scoped ctx effects: stopping / updating / unloading
   the plugin restores the original `fetch` and removes the listener.

Non-OpenCode providers, requests without a `sessionId`, and model discovery
requests pass through untouched.

## Notes / limitations

- The header is attached to chat/streaming requests inside an `llm/stream` call;
  the one-shot model listing (`GET <baseURL>/models`) is a separate flow and does
  not receive the header.
- The plugin relies on DSH outbound LLM requests going through the Node global
  `fetch`. If a future DSH version swaps its network stack, injection stops
  (symptom: the 400 returns) — uninstall then.

## Development

```sh
node --check lib/index.js
npm test        # local behaviour tests (no network)
```

The package is plain ESM JavaScript with zero dependencies.

## License

MIT
