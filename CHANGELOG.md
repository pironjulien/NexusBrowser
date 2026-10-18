# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Published as NexusBrowser in the public repository `pironjulien/chrome-computer-use` (formerly
  `antigravity-chrome-sidepanel`, then `antigravity-browser-use`; GitHub redirects the old URLs). README rewritten in
  English for public use.

## [2.8.1] - 2026-10-18 — Screenshots of background tabs no longer freeze

Re-run `install.ps1`, then RELOAD the extension (capability `capture-screencast` advertised by ping).

### Fixed
- `browser_screenshot` and `browser_vision_inspect` froze for 12 to 20 s (bridge timeout) in a background tab:
  Chrome stops drawing frames for a hidden tab, so `Page.captureScreenshot` waited after any scroll or change.
  Measured on the real Chrome (October 18, 20 captures alternating with scrolls): 11 to 13 freezes out of 20 for the
  plain capture, `Emulation.setFocusEmulationEnabled` and `captureBeyondViewport` (still 7/12), forcing the device
  metrics (7/12); `fromSurface: false` is refused by Chrome ("Only screenshots from surface are allowed"). A tiny
  `Page.startScreencast` (16×16, never read) held only for the duration of the capture keeps the renderer drawing:
  0 freezes out of 40, about 0.1 s per capture, correct image of the scrolled view; the tab stays in the background.
  If Chrome refuses the screencast, the capture runs as before; it is always stopped, even when the capture fails.

### Changed
- Chrome relaunch (`launch_chrome`): only `--profile-directory=Default` by default. Extra flags are opt-in
  through the `NEXUS_CHROME_EXTRA_ARGS` environment variable (`--name` or `--name=value` separated by spaces);
  anything else, and flags that load or run code (`--load-extension`, `--remote-debugging-*`, command prefixes,
  `--user-data-dir`, `--no-sandbox`...), are ignored.
- Agent guide and docstrings: repository-relative paths instead of the author's folders.

### Removed
- Live validation: the 3 retries of `browser_vision_inspect` (`gels_de_capture`) are gone, a single capture is
  expected to succeed.

## [2.8.0] - 2026-10-18 — October 18 audit: masked passwords, corrected cookie promise, MCP SDK 2

Re-run `install.ps1` (with Antigravity closed), then RELOAD the extension in `chrome://extensions` (capabilities
`sensitive-field-masking`, `cdp-reload-no-script` and `ax-value-masking` advertised by ping), then open a new
conversation in each agent.

### Security
- Plaintext passwords (severe): `browser_content` (default interactive mode), `browser_vision_inspect`,
  `browser_find` and the read-back of `browser_fill` returned field values, passwords included; `browser_axtree`
  returned card numbers and codes (Chrome only masks passwords there, observed in a real run). The value is never
  returned for a `type=password` field or one whose `autocomplete` is current-password, new-password,
  one-time-code, cc-number, cc-csc or cc-exp (including a "show password" field switched to `type=text`):
  `[valeur masquée]` is returned instead. `browser_content(mode="html")`: the `value` attribute of these fields is
  masked in a copy of the DOM (React copies it from the input), the page itself is untouched. `browser_fill` still
  reads the real value back from the page (`verified` stays accurate); only the output is masked, including the
  expected value and the JavaScript fallback. A single definition of sensitive fields, in the localization kit,
  injected into every page script.
- Antigravity review (October 18): the rendered text of a sensitive field (textarea, contenteditable) was not
  masked; a "show password" field without a recognized autocomplete is now identified by its name or id (password,
  pwd, mot de passe, mdp, cvc...), never a container; non-input components carrying a sensitive autocomplete are
  masked in the accessibility tree and the HTML.
- `browser_cdp_send`: `Page.reload` accepted `scriptToEvaluateOnLoad` passed through unchanged (a script injected
  into the page world on load, like `Page.addScriptToEvaluateOnNewDocument`, which is refused). Now refused before
  reaching Chrome, with a clear message; a plain reload is still allowed.

### Fixed
- Incorrect promise: "cookies sealed outside localhost". `browser_eval` and `Runtime.evaluate` (both worlds share the
  document) can read `document.cookie` (non-HttpOnly cookies), localStorage, sessionStorage, IndexedDB and the result
  of a `fetch` sent with the user's session, without masking. Kept as is (maximum autonomy; pattern-based masking
  would be bypassed by the slightest `btoa`) and stated clearly in the tool, the server instructions, the skill and
  the README: masking applies to the dedicated tools, not to a script nor to raw `browser_cdp_send` responses
  (`DOM.getOuterHTML`, `Accessibility.getFullAXTree`).

### Changed
- MCP SDK 2.3.0 (instead of 1.30.0; the 1.x branch only receives security fixes): `MCPServer` (formerly
  `FastMCP`), advertised version read from `VERSION`.
- MCP annotations on all 47 tools (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`): page
  reads, local reads, tab management, navigation, and page actions marked destructive (in the user's real sessions, a
  click, an Enter key press, a checked box or a script can send, delete or confirm). A tool marked "read-only" only
  sends the bridge commands from its read list (tested), with one deliberate exception: `browser_get_cookies`, which
  modifies nothing but is still blocked by the emergency stop.
- Tools are typed exactly (the decorator no longer turned them into `Any`): mistyped test calls fixed.

### Tests
- Node: content, visual map, search, HTML and accessibility tree contain no sensitive value; typing into a password
  field, into a card field rewritten by the page, and through the JavaScript fallback returns no value;
  `Page.reload` with a script refused before reaching Chrome. Mutation checked: without masking, the three masking
  tests fail.
- Python: SDK 2, complete annotations consistent with the bridge read list, accurate wording about `browser_eval`
  (tool, instructions, both copies of the skill, README).
- Real-world validation (`--full-live`): password and card never read (content, HTML, visual map, search, Chrome
  accessibility tree), password entry verified and masked, `Page.reload` with a script refused.

### Known issues
- `Page.captureScreenshot` sometimes hangs for 12 to 20 s in a background tab (both `browser_screenshot` and
  `browser_vision_inspect`, measured on October 18, unrelated to this version): the real-world validation retries the
  visual map up to 3 times and counts the hangs. Root cause to be addressed separately.

## [Unpublished] - 2026-10-17 — Antigravity review: regressions fixed

Version 2.7.1. Re-run `install.ps1` (with Antigravity closed), then RELOAD the extension in `chrome://extensions`
(capabilities `orphan-tabs`, `cdp-page-world`, `local-cookie-values`, `body-masking-allowlist` advertised by ping),
then open a new conversation in each agent.

### Fixed
- Orphaned tabs (severe): after an MCP server restart, its tabs stayed attached to the old session and could not be
  driven, closed, released or adopted. The bridge and the extension now track live sessions: every command and an MCP
  server heartbeat (every 60 / 1.618 s) record the last sign of life; each MCP server announces its process (header
  `X-Nexus-Browser-Pid`), which the bridge checks. A session silent for 1.618 x 60 s, or whose process is gone, is
  dead: its tabs become orphaned. The same agent takes them back (`browser_adopt_tab` without `julien_asked`, and
  automatically on the first heartbeat if it has no tab), and can close or release them. Never another agent; a live
  session of the same agent stays protected (ownership is still held per session). `browser_list_tabs`: `state`
  (`mine`, `orphan`, `other`, `julien`); control panel: "orphelin" badge.
- `browser_cdp_send`: `Runtime.evaluate` forced into the isolated world prevented reading an application's state.
  Isolated world by default, page world on request (`world="page"`); the context is always enforced, without the
  console API; a dialog opened by the evaluation is reported instead of blocking.
- Cookies: `include_values=True` is back, ONLY for a local development origin (localhost, 127.0.0.1, [::1],
  *.localhost, *.test) and for cookies of those domains; clear refusal, before any call to Chrome, for any other
  origin. Never a value by default.
- Body masking: `token` without an anchor masked `nextPageToken`, `pageToken`, `total_tokens`, `prompt_tokens`,
  `max_tokens`, `tokenizer`... Allowlist added (pagination, `token_type`, `expires_*`, `tokenizer`), token counters
  left alone when the value is a number (OpenAI, Anthropic, Gemini), ambiguous keys masked only when the value looks
  like a secret (known formats: `ya29.`, `ghp_`, `sk-`, JWT... or a long opaque string). Unambiguous secret keys
  (`access_token`, `refresh_token`, `id_token`, `token`, `password`, `client_secret`...) always masked.

## [Unpublished] - 2026-10-17 — Default CLI identity

### Fixed
- Default CLI identifier `cli` (3 characters) was refused by the bridge (4 minimum): now `cli-local`. Test added.

## [Unpublished] - 2026-10-17 — Claude review: isolation and secrets in the extension

Version 2.7.0. Re-run `install.ps1` (with Antigravity closed), then RELOAD the extension in `chrome://extensions`
(the real-world validation and `verify.ps1 -Browser` refuse an outdated extension: version and features advertised by
ping), then open a new conversation in each agent. Tools that check the installation must read the fingerprint
through `scripts\empreinte.ps1`.

### Security
- `browser_cdp_send`: closed list of ALLOWED commands (DOM reads, `Accessibility.getFullAXTree`,
  `Runtime.evaluate` forced into the isolated world, screenshots, `Input.dispatch*`, display `Emulation.*`,
  `Network.enable/disable`, Log/Console); everything else refused before reaching Chrome
  (`Storage.clearDataForOrigin`, `Network.getRequestPostData`, `Network.loadNetworkResource`, `IO.read`,
  `Fetch.enable`, `Page.addScriptToEvaluateOnNewDocument`, `Page.navigate`...).
- Tab ownership enforced by the extension: each bridge client identifies itself (agent + session, headers
  `X-Nexus-Browser-Agent` / `X-Nexus-Browser-Client`, set by the bridge in the signed channel); the tab opened by
  `browser_new_tab` belongs to that session (`chrome.storage.session`, survives service worker restarts); any page
  command on another tab (the user's, another agent's, another session's) is refused. Adopting one of the user's tabs
  only through `browser_adopt_tab(tab_id, julien_asked=True)`, visible in the control panel.
- `tab_id` required in the schema of every page tool (no more "last tab" on the MCP side).
- Response bodies: secret fields masked at any depth (JSON, anti-XSSI prefix, forms, truncated JSON, patterns inside
  a script); no cookie value leaves the bridge anymore (`include_values` removed).
- Uploads also checked by the bridge (any HTTP client); folders added (`~\.gemini`, `~\.android`,
  `~\.git-credentials`, `~\.config\gcloud`, `%APPDATA%\gcloud`, Chrome profile, Credentials/Protect...); paths
  normalized (`\\?\`, `\\.\`, `\\localhost\C$\`, `\\127.0.0.1\C$\`, machine name, junctions and links, trailing
  dots, case).
- Isolated world for all extension scripts (main frame included, `chrome.scripting` fallback in ISOLATED): markers,
  click probes and AX registry invisible to the page and not replaceable by it. Only `browser_eval` and the YouTube
  transcript (the page's player) run in the page world.
- Navigation and new tab: http, https, data:, about:blank only (never file://, chrome://, javascript:).
- Badge and click dot: extension messages only (a page can no longer display fake ones).

### Added
- Control panel (side panel, neutral style): tabs driven per agent, debugger state, STOP (shared stop file
  `~\.nexus\stop` set by the bridge, debuggers detached), "Rendre l'onglet" (release tab), bridge state.
- Tools `browser_adopt_tab`, `browser_release_tab`, `browser_network_record` (debugger kept attached, 600 s at most),
  `browser_network_stop`.
- Emergency stop: the bridge cancels in-flight commands (423 response) and notifies the extension, which interrupts
  key-by-key typing, dragging (button released) and waits, detaches all debuggers and refuses any action.
- `VERSION`; `scripts\empreinte.ps1` (installed.stamp includes `installer-hote-natif.ps1` and `runtime.ps1`);
  `scripts\doublon-antigravity.ps1`, `scripts\ancienne-extension.ps1`.

### Changed
- Debugger: per-tab command counter (replaces the global counter that prevented any detach).
- Element capture in page coordinates (scrolling added, beyond the viewport); debugging session resumed after a
  service worker restart (iframe tracking restarted).
- `windows.create` fallback: id of the created tab, never that of the window.
- Panel shortcut: Alt+Shift+N (Ctrl+Shift+A is Chrome's "Search tabs").
- Antigravity: nexus-browser declared by its plugin only (the `mcp_config.json` entry is removed, after a backup);
  `verify.ps1` reports a duplicate.
- Skill also copied for Claude Code (`~\.claude\skills`) and Codex (`~\.codex\skills`).
- `browser_cli.py`: version read from the code, French help, `--tab-id` required, new commands.

### Removed
- Panel chat (text box, bridge queue, `browser_sidepanel_requests` / `browser_sidepanel_reply`) and its four
  buttons; dead `popup.html/js`; SoM display from the content script that was never triggered.

### Migration
- `install.ps1` removes (log `~\.nexus\nexus-browser\install.log`) the old token `~\.nexusagy\bridge-token` and the
  files of the old native host; `verify.ps1` checks they are gone and reports the old "Antigravity Browser Bridge"
  extension if a Chrome profile loads it (preferences read, never modified).
- No caches in the source tree: ruff `cache-dir` and pytest `-p no:cacheprovider` in `pyproject.toml`,
  `sys.dont_write_bytecode` in the client and bridge modules; `.ruff_cache`, `client\__pycache__` and
  `native-host\__pycache__` deleted.

## [2.6.0] - 2026-10-16 — Neutral repository, shared by the three agents

Reload the extension (new folder, new identifier) and re-run `install.ps1` on each machine.

### Added
- Standalone repository, extracted from the former Antigravity package: extension, local bridge, native host,
  `nexus-browser` MCP server, CLI, Antigravity skill and plugin, tests (Python, Node, real-world validation).
- `install.ps1`: environment outside the source tree (`~\.nexus\nexus-browser`), native host, "Nexus Browser Bridge"
  task with no trigger, registration of `nexus-browser` with Claude Code, Codex and Antigravity (plugin and skill
  included), installation fingerprint.
- Agent name per registration (`NEXUS_BROWSER_AGENT`: Antigravity, Claude, Codex): default tab group named after it,
  to see at a glance which agent opened what.
- Fixed extension identifier (`blcgddmjdkobmgakjffjpgiicjlflgjf`), derived from the public `key` in the manifest: the
  same on every machine and whatever folder is loaded; the only origin accepted by the bridge and the native host (six
  identifiers tied to the old folders previously).
- `verify.ps1`: task, native host, absence of the old task; `-Browser`: bridge reachable and extension loaded and up
  to date.

### Changed
- Neutral names: "Nexus Browser Bridge" extension, native host `com.nexus.browser_auth`, protocol `nexus-browser/1`,
  header `X-Nexus-Browser-Token`, token `~\.nexus\nexus-browser\bridge-token`, exports in
  `Téléchargements\nexus-browser-exports`, default tab group "Nexus" when no registration is set.
- MCP server reduced to the browser (Computer Use stays in the former Antigravity package); screenshot cleanup with
  no dependency on the desktop client.
- Uploads also refused under `~\.nexus` (bridge token, emergency stop).

### Verified
- Real-world validation in the user's Chrome: `--mouse` 11/11, `--full-live` 29/29 (`test.ps1 -Full` green four
  times in a row). First three runs right after loading the extension: 27/29, empty network log for the `/api/data`
  request (cause not found, not reproduced since); the failure now prints the log and the click response.

### Migration
- `install.ps1` stops and removes the "NexusAGY Browser Bridge" task (same ports 9224/9225) and the native host
  `com.nexusagy.bridge_auth`. The old "Antigravity Browser Bridge" extension must be removed from Chrome.

Versions up to 2.4.0 were published as "Antigravity Browser Bridge" in the same public repository; see its git history.
