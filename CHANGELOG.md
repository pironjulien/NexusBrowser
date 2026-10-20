# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.13.0] - 2026-10-20

### Added
- Gaps closed after a tool-by-tool comparison with the most used browser MCP servers (Chrome DevTools MCP,
  Playwright MCP, browser-use, Claude in Chrome, Blueprint MCP, real-browser-mcp) on 2026-10-20. 52 tools with WebMCP.
- `browser_batch`: up to 30 tool calls in one round trip, in order, stopping at the first error. Each step is
  validated against its own tool's schema and goes through its own checks: an outward gesture without the user's
  accord stops the batch with its `accord_required` refusal; any unexpected failure of a step stops it cleanly.
  The optional `tab_id` applies to every step that does not give its own.
- Tabs opened BY an agent's own tab (target=_blank links, `window.open`, OAuth sign-in popups) belong to the same
  agent session (`openedBy` in its ownership): the agent no longer loses the rest of its task. Never from a tab
  adopted from the user or opened by the side panel, and never a tab that already has an owner.
- `browser_wait_for`: waits until a visible element shows a text (or matches a locator) in any frame, or with
  `gone=True` until none is left, polling the existing `find` (no new extension action). A page it cannot read
  (blocking dialog) is an error, never taken for "gone".
- `browser_navigate(url="back" | "forward")`: previous or next page of the agent's own tab history, read through
  CDP (`Page.getNavigationHistory`): `chrome.tabs.goBack` skipped pages left without a user gesture, which is most
  pages of an agent tab. The destination goes through the same address check as an explicit navigation: an adopted
  tab whose history holds `file://`, `chrome://` or `javascript:` cannot step back onto it.
- `browser_screenshot(full_page=True)`: the whole scrollable page (CSS content size, page zoom applied, height capped
  and width capped at 16384 px with `fullPage.truncated`), sensitive fields masked as in every capture; refused with
  `inline=True` (image too large for a response).
- Deliberately left out: performance tracing, Lighthouse, emulation and memory tools (developer debugging, covered by
  Chrome DevTools MCP), and coordinate clicks (Set-of-Mark marks already target what a vision model sees, with the
  covered-element and accord checks).

- **WebMCP: tools that a page exposes to agents itself** (`document.modelContext`, W3C Web Machine Learning CG
  draft; native in Chrome 149+ on sites enrolled in the origin trial). `browser_webmcp_tools` lists them (name,
  title, description, `inputSchema`, `readOnlyHint` / `consequentialHint` / `untrustedContentHint`, origin, frame,
  and for a declarative tool its form's submit buttons and target). `browser_webmcp_call` runs one through Chrome's
  own `getTools()` / `executeTool()` with a timeout that cancels it. Both go through the bridge's existing read
  path (`client/webmcp_probe.js` evaluated by `cdp-send` in the extension's isolated world, so the page cannot
  replace these functions): no new extension action, no Chrome flag, works with the extension already loaded.
  Chrome's CDP `WebMCP` domain, used by Chrome DevTools MCP (`--categoryExperimentalWebmcp`) and Stagehand, is not
  used: it needs Chrome started with `--enable-features=DevToolsWebMCPSupport`, which the user's own Chrome is not.
- Same accord as clicks for WebMCP calls: a tool the page marks `consequentialHint`, or whose name, title,
  description or form submit button carries an outward word of the shared policy (snake_case, camelCase and
  conjugated English verbs such as "Sends" or "Publishes" are normalised first), is refused with a summary of the
  exact call (tool, origin, input with sensitive values masked but bound to the token by a fingerprint, recipients,
  form target, page) and a one-time token. Read-only tools (`readOnlyHint`) run freely. The tool runs only if its
  definition is still the one that was checked. Tool lists and outputs are page text (`untrusted_note`). Both are
  refused during the emergency stop (the bridge counts `cdp-send` as an action).
- Tests: `tests/test_webmcp.py` (offline fake page: free read-only and neutral tools, accord flow, changed input or
  masked value voids the token, single use, definition swapped after the check, ambiguous and unknown tools, page
  injection, emergency stop) and a Node test of `webmcp_probe.js`.

### Changed
- README: images by absolute URL, so they also show on PyPI.
- README: the stale version line no longer hardcodes a number (the release and PyPI badges show it).

## [2.12.1] - 2026-10-20

### Security
- GitHub Actions pinned by commit SHA, checkouts without persisted credentials, release metadata passed through the environment (no template expansion in scripts), no build cache in the release workflow. The MCP registry upload is now a job of the PyPI workflow (no more `workflow_run` trigger). Dependabot (actions and uv, 7-day cooldown) and an OpenSSF Scorecard workflow added; `zizmor` reports no finding.

### Fixed
- Document five historical synthetic network-response fixtures using exact Gitleaks fingerprints; no global rule or path exemption. New changes and history remain scanned.
- Installation freshness includes extension and client sources. Existing connected extensions are checked and refreshed automatically; the supervised Browser MCP worker is reloaded independently. Installation defers while an agent owns tabs, waits for the bridge's reconnect, and does not record a successful update when refresh fails.
- Use Chromium's computed full accessibility tree for role/name matching before the existing `queryAXTree` fallback. The latter was measured waiting 1.5 seconds on the main document with iframes; computed accessible names and role filtering remain covered by regression tests.
- Resolve the outward-action probe in the isolated context that owns a mark, including cross-origin and out-of-process iframes. The existing mark registry selects the context; the accord check remains active. Live ambiguity checks accept both cases in the English error message.
- Acknowledge the temporary CDP screencast frames used for background screenshots. Unacknowledged frames could stall repeated captures; frame pixels are never retained by the event handler. Loaded-code detection includes `capture-screencast-ack`.
- Shared daemon (`--http`): a client that resets its connection no longer makes the Windows Proactor loop log a traceback (`ConnectionResetError` in `_call_connection_lost`); only that error is silenced, every other loop error is still logged.
- `scripts/registre-reel.ps1`: escape `%` as `%%` in generated `.cmd` batch scripts so arguments like `%1` are not swallowed by `cmd.exe` when setting registry values.

## [2.12.0] - 2026-10-19

### Added
- **Outward gestures need the user's accord for the exact action** (trinity agreement of 2026-10-19,
  "ameliorations-outils", priority 1). `browser_click`, `browser_semantic_click`, `browser_click_mark`,
  `browser_press_key` (Enter, Control+Enter, Space), `browser_type_keys` (line break or submitting keys),
  `browser_fill` and `browser_semantic_fill` (submitting `keys`) and `browser_drag_and_drop` take `confirm` and
  `accord`. Before the gesture, the server reads the trigger without any gesture, through the bridge's existing read
  paths only (`find`, and the read-only `client/trigger_probe.js` evaluated by `cdp-send` in the isolated world; no
  new extension action, works with the extension already loaded): label of the clicked control, or submit buttons of the focused field's form; that form's fields,
  sensitive values masked; recipients from email/tel/"to" fields and `email` chips; file attachments; tab origin,
  path and title). When the shared policy sees an outward word (send, pay, buy, order, publish, post, call, transfer,
  subscribe, book...), the gesture is refused with a summary of the exact action and a one-time token (10 min); it
  runs only when sent again with `confirm=true` and that token, unchanged. `confirm=true` alone, a token read in a
  page, a token for another action or a changed field, recipient, typed text or page are refused. Neutral links and
  buttons stay free. Fails closed only when the read really fails. One `Accords` object per server process.
- The CLI runs the same check; since each command is its own process it cannot carry a token, so it refuses outward
  gestures with the summary of the action and points to the MCP server (other gestures stay free).
- Page text outputs (`browser_content`, `browser_axtree`, `browser_export`, `browser_export_gsuite`,
  `browser_youtube_transcript`, `browser_network_response`) carry `untrusted_note` when the text looks like
  instructions aimed at an AI (signal only), and are recorded as text read (provenance of a recipient).
- The shared guardrail policy ships inside the package (`client/garde_fous.py`, `client/garde-fous.json`, identical
  copies of NexusHarness/shared; a test checks it when that folder exists).
- Tests: `tests/test_outward_accord.py` (offline mail page: send refused without confirm, token flow, changed field,
  Enter toward a Send button, neutral link, concurrent paths, page injection, CLI across processes, embedded policy)
  and a Node test of `trigger_probe.js` on a fake page (read-only, password never read).

### Changed
- `browser_eval` and `browser_cdp_send` keep full page access by choice; their descriptions, the server
  instructions, README and SECURITY.md now say plainly that they do not go through the accord and must never be used
  for an outward action.
- The real validation (`test.ps1 -Full`) clicks its "Valider la commande" and "Envoyer" buttons through the accord
  flow. Extension and bridge code are unchanged (version number only): no reload needed for the check to work.

## [2.11.0] - 2026-10-19

### Changed
- Everything an MCP client receives is now in English: the 48 tool descriptions, parameter descriptions and every
  message returned to the model (server, bridge, native host, extension: errors, refusals, warnings, reports).
  Same meaning, same guardrails. Texts shown only to the user (side panel, on-page notices) stay in French.
- Masked values read `[masked value]` (was a French placeholder).
- `browser_adopt_tab`: the former `julien_asked` alias is no longer exposed; use `user_asked=True`. A tab nobody
  drives has state `"user"` in `browser_list_tabs` (was `"julien"`).

### Added
- `tests/test_english.py`: `tools/list` (descriptions, titles, input schemas) and a series of offline error and
  refusal responses must contain no French. The anti-steering test now also covers parameter descriptions.

## [2.10.1] - 2026-10-19

### Changed
- Server instructions no longer compare this bridge with other tools ("Prefer this bridge to the client's own
  browser extension"): they now list what it is for, in neutral words, as the Anthropic directory requires (a server
  must not steer the model toward its tools or away from other ones). A test keeps such wording out.

### Added
- `.github/workflows/registry.yml`: after each release reaches PyPI, `server.json` is published to the official MCP
  registry by GitHub OIDC (no token, no manual login), as NexusAndroid does.

## [2.10.0] - 2026-10-19

### Changed (neutral texts for any client, 2026-10-19)
- Server instructions sent to every MCP client are now in English and neutral ("the user"), no personal name.
  Tool descriptions, parameter descriptions and messages returned to the model (server, bridge, extension) say
  « l'utilisateur » too; they stay in French. Same rules and flow. A test checks that `initialize` and
  `tools/list` name nobody.
- `browser_adopt_tab(tab_id, user_asked=True)`: neutral name for the consent flag. `julien_asked`, its former name,
  still works as an alias; the bridge sends `userAsked` (read by the extension from this version) and `julienAsked`
  (read by older extensions). CLI: `adopt-tab --user-asked` (`--julien-asked` kept).
- Side panel greeting is « Bonjour »; a tab nobody drives is labelled « Utilisateur » in the control panel.

### Changed (Codex plugin, 2026-10-19)
- `install.ps1` no longer writes `[mcp_servers.nexus-browser]` to Codex's `config.toml` nor copies the skill to
  `~\.codex\skills`: Codex gets both from a personal Codex plugin.

### Fixed (2026-10-19)
- Native messaging host registered in the real `HKCU` registry (`scripts\registre-reel.ps1`: `reg.exe` run by a
  one-shot hidden scheduled task). Run from a packaged (MSIX) app such as the Claude desktop app, the write went to the
  app's private registry and Chrome reported « native messaging host not found »: the extension never connected.
- `is_chrome_running`: `tasklist` output read as bytes; with `PYTHONUTF8=1` its OEM code page (French « Numéro »)
  crashed every tool call made while the extension was offline. `icacls` output decoded with the OEM code page too.
- Antigravity showed the nexus-browser skill twice (global copy + plugin): `install.ps1` keeps it in the plugin only
  and moves the old global copy to a local backup.

### Changed (Claude Code plugin, 2026-10-19)
- `install.ps1` no longer registers the server with Claude Code nor copies the skill to `~\.claude\skills`, and never
  calls a Claude CLI: Claude Code gets both from a Claude Code plugin. Codex and Antigravity are unchanged.

### Changed (YouTube transcript visible in Antigravity, 2026-10-19)
- `browser_export_youtube_transcript` is renamed `browser_youtube_transcript`: Antigravity publishes each tool as
  `mcp_nexus-browser_nexus-browser_<tool>` and silently drops any name over 64 characters, so it never saw this one
  (65). No client used the old name; the bridge action `export_youtube_transcript` is unchanged. A test now checks
  that every tool name fits once prefixed.

### Added (faster Antigravity panel, 2026-10-18)
- `browser_fill_form(tab_id, fields)`: fills a whole form in ONE call, field by field with the same gestures as the
  single-field tools (`browser_fill`, `browser_select_option`, `browser_check`): every
  field is validated before the first gesture, the emergency stop is checked before each field, it stops at the
  first field not confirmed (error, dialog opened by the page, value refused or put back), then reads the whole
  form back with no gesture (new read-only `field-state` bridge action, compared inside the page so a sensitive
  value never leaves it): `all_verified` only if every field still holds its value. It never submits. Measured
  on the real panel bench: 5 fills and a separate read-back took 6 model turns (~18 s) of the 61 s.
- Its fields are aimed at by their `mark` from `browser_interactive_map` only: a reference to the element itself, kept
  from the gesture to every read-back. A label or selector would be evaluated again at each read and could name
  another field after the page changed (Codex cross-review); those stay with the single-field tools. A field the page
  removed or replaced fails its read-back, and a multiple `<select>` must hold the wanted option alone.
  Each field is read back right after its gesture and again at the end; a mark on a label or a container (redirected
  to its current control), or on anything that is not an input (a label left without its control), is refused at
  read-back: the mark must be the field itself. A gesture's own refusal is never cleared by a later read-back.
  When a batch stops, the fields already filled are read back again with no gesture (their state when filled is never
  reported as their current state; unknown when a dialog blocks the page).
- `browser_interactive_map` also numbers rich editors (`contenteditable`, `plaintext-only` included, `role=textbox`), labelled by their
  `aria-label` or title only: their content is input, possibly sensitive, never a label.

### Fixed (Codex cross-review, 2026-10-18)
- A sensitive field's state masks every representation of its value, not only `value`: `text`, `selectedValue` and
  `selectedText` too (a card-expiry `<select>` or a password `contenteditable` leaked them through `select_option`).

### Added (shared daemon, 2026-10-19)
- Shared daemon mode: `client/mcp_server.py --http [port]` serves MCP Streamable HTTP on 127.0.0.1 (port 16182), one
  process for every Claude, Codex and Antigravity session instead of one per session. Bearer token required
  (`NEXUS_MCP_TOKEN` or `NEXUS_MCP_TOKEN_FILE`); the agent comes from the URL (`?agent=codex`, refused otherwise);
  each MCP session gets its own identity (its tabs), is heartbeaten by the daemon while open and goes silent once
  closed, so its tabs become orphans for its agent. `install.ps1` declares the daemon to the Nexus supervisor and
  registers the three clients by URL. A session idle for 161.8 s (no request, no open stream) is closed, so a client
  that left without a DELETE frees its tabs in ~3 min instead of 30; a new session beats (and reclaims) within a
  second (review by Antigravity).

### Changed
- `browser_new_tab(group)` and `browser_group_tabs(title)` default to the current session's agent name
  (`group=""`: no group).

### Fixed
- Side panel shortcut is now Alt+Shift+Y: Chrome took Alt+Shift+N for split view ("Select a tab") and silently
  dropped the extension's key. The shortcut handler also opens the panel at once with the tab Chrome gives it:
  waiting for a tab query first lost the keyboard gesture `sidePanel.open` requires, so the panel never opened.
  An existing install keeps its old setting: set the key in chrome://extensions/shortcuts.

### Added
- Antigravity side panel: Julien types a request in Chrome's side panel and Antigravity does the real work on the
  tab (read, click, fill forms) with its nexus-browser tools, then its answer shows up in the panel. Path agreed by
  Claude and Antigravity (blind debate "panneau-agy-chrome", 2026-10-18): panel -> service worker -> signed bridge
  link (`agy_ask` event) -> Nexus Relay mailbox, from "julien" to Antigravity (its sidecar wakes it at once) ->
  Antigravity adopts that tab (`julien_asked=True`: the typed request is Julien's explicit consent for that tab
  only), acts, releases it, replies -> mailbox "julien" -> bridge -> panel (`agy_panel_update`, reserved to the
  bridge: no agent can speak for Antigravity). Nothing is queued in the bridge's memory (what made the former chat
  panel unreliable); without Nexus Relay installed, the panel says so. Thread kept in `chrome.storage.local`.
- Panel look inspired by Google's assistants (greeting, suggestion chips, pill composer, light/dark), own palette and
  no brand. The control station stays (tab "Contrôle": piloted tabs, release a tab, bridge state) and STOP is always
  visible in the header.

### Fixed (Codex cross-review of the Antigravity panel, 2026-10-18: three passes, each "Accord : non", then fixed)
- One request identity end to end: the panel's `localId` is written INSIDE the Nexus Relay message and comes back
  with the reply. The relay files a request once per id, even if it died between filing and indexing (it finds the
  message again by that id), so the extension resends an unconfirmed request every 15 s for as long as needed,
  counting only sends that actually left Chrome, and never files it twice or restarts the work; a reply finds its
  request even if the "filed" confirmation was lost. An unknown relay outcome (crash, timeout, non-zero exit even with
  readable JSON) is never shown as "not sent"; only an explicit relay refusal is.
- One request at a time, enforced in the service worker's single queue (test and reservation in one step, shared by
  every panel of the profile); "Effacer l'affichage" keeps the active request; only an explicit "Abandonner" frees
  the panel. The relay's transcript fallback never attributes a final answer when two requests overlap in one
  conversation (neither of them gets one; only Antigravity's explicit reply does). Resends are scheduled by the
  service worker itself, so they go on with the panel closed (and the link alarm catches up after a sleep).
- Julien's consent is bound to HIS request: Antigravity adopts with `panel_request=<request id>`; the extension checks
  that this request exists, has not expired (30 min), targets that tab, and that the tab still shows the exact page
  (full address, fragment included: hash routers carry the record id), before any other path ("already adopted"
  included), and again after ownership is recorded (a navigation during the awaits is caught and ownership removed).
  Missing or expired consent means refusal. Adoptions Julien asked for elsewhere are unaffected. The target tab is
  frozen at the first keystroke (seen live: another agent switched the active tab while typing) and the page seen
  while typing travels with the request: if the tab moved to another page, nothing is sent. If Julien himself
  navigates a panel-adopted tab elsewhere (address bar, bookmark, back/forward: `webNavigation`), the tab is handed
  back to him; the work's own navigations (links, form submits, reloads) go on.
- The thread lives in `chrome.storage.local`, restricted to trusted extension contexts (`setAccessLevel`), so an
  acknowledged answer survives an extension reload or a Chrome restart. Each Chrome install has a stable instance id,
  created once even under concurrent first use: a reply only goes to the install that asked (waits in the mailbox
  while it is offline, never to another profile). The panel works with ONE Chrome profile linked to the bridge: with
  two, a request is refused with a clear message (Antigravity's page commands would go to the priority link).
- Only the page origin goes to the relay (no credentials, path or query); the page title is untrusted page data,
  separate from Julien's words. The relay only hands Antigravity's replies to panel requests to the panel; agents can
  no longer write to the "julien" mailbox. "Déposée" vs "Antigravity ne semble pas actif" from the sidecar heartbeat;
  statuses converge in any order ("answered" never goes back); screen-reader labels; reduced motion respected.
- Trust model, stated: "julien" names the panel's mailbox, not a proof of human origin; local processes of Julien's
  Windows account are trusted (they can read the bridge token too). "Nothing sent without your yes" is Antigravity's
  instruction, not a technical lock.

### Fixed (Codex cross-review, fourth pass: "Accord : non", 3 + 1 findings, all reproduced and fixed)
- The page frozen while typing is now a snapshot: a tab update no longer rewrites the expected address behind
  Julien's back (it did, so the worker accepted page B for a request typed on page A). The panel shows "(figé, page
  changée depuis)"; only a click on the tab chip retargets. Tested with the real panel script driving the real worker.
- The panel marker survives a session change: reclaiming an orphan tab (heartbeat after an MCP server restart, or
  explicit adoption) keeps it, and a panel request on a tab the agent already owns marks it too. Before, Julien
  navigating away no longer handed such a tab back.
- Same-document navigations are watched like the others (`onReferenceFragmentUpdated`, `onHistoryStateUpdated`):
  Julien typing `#/fiche/B` or going back between routes of a single-page app hands the tab back; the work's own
  route changes (link transitions, `pushState`) go on.
- Two Chrome profiles linked: the request is now "retenue" (held), never "non transmise": a resend may follow a
  filing made before the second profile appeared. The panel keeps the reservation and resends the same id, which the
  relay resolves to the earlier filing once only one profile is left.

### Fixed (Codex cross-review, fifth pass: "Accord : non", 1 + 1 findings, reproduced and fixed)
- A navigation by Julien DURING a panel adoption is no longer lost: each tab keeps a navigation generation, bumped
  before any wait even when no marked owner exists yet; the adoption reads it at the end and hands the tab back. A
  panel adoption writes ownership once, already marked (no second write that could undo a hand-back), and a late
  refusal restores the previous owner only if nobody changed it meanwhile. Both interleavings Codex ran (event during
  the final consent read; event during the reclaim save) are tests now.
- Nexus Relay missing or impossible to launch is "retenue" too, never "non transmise": it says nothing about an
  earlier filing of the same request, so the panel keeps the reservation and resends the same id.

### Fixed (Codex cross-review, sixth pass: "Accord : non", 1 finding, reproduced and fixed)
- A panel adoption compares against the ownership object IT wrote (returned by `rememberTabOwner` before any wait),
  never the one found in the map after the save: if Julien handed the tab back and another agent adopted it in the
  meantime, the old adoption now refuses without restoring, releasing or overwriting the newer owner.

### Fixed (Codex cross-review, seventh pass: "Accord : non", 1 finding, reproduced and fixed)
- Handing a tab back checks ownership again AFTER detaching the debugger, right before removing it: a late hand-back
  (two hand-backs of the same navigation, another agent adopting the tab in between) leaves the newer ownership
  intact. The control station's "Rendre l'onglet" still hands back whoever owns the tab when it is clicked.

### Added
- PyPI package `nexus-browser` (the MCP server, command `nexus-browser`): the wheel mirrors `client/` and
  `native-host/` unchanged under `nexus_browser/` (hatchling force-include); `install.ps1` and the three agents keep
  running from the repository (`[tool.uv] package = false`). Published by Trusted Publishing
  (`.github/workflows/publish.yml`), checked from the built wheel (initialize, 47 tools).
- README: animated demo recorded from the real tool; install from PyPI.

### Changed
- Bridge not reachable and no token: the error now points to the one-time install (install.ps1).

### Added

- `SECURITY.md`: private vulnerability reporting.

### Changed

- Repository renamed to `pironjulien/NexusBrowser`; GitHub redirects the old address.

## [2.9.0] - 2026-10-18 — Secrets masked in images and console logs

Re-run `install.ps1`, then RELOAD the extension (capabilities `capture-field-masking` and `console-masking`
advertised by ping).

### Security
- Screenshots, PDFs and Set-of-Mark captures no longer show a password revealed by a "show" button, a card number or
  a code: before `Page.captureScreenshot` / `Page.printToPDF` (also through `browser_cdp_send`), sensitive fields of
  every frame (shadow DOM, same-origin and cross-origin iframes) get `-webkit-text-security: disc`, and their own
  inline style is put back right after. A capture whose page cannot be masked (dialog open) is refused. Checked in
  the real Chrome (`test.ps1 -Full`): two values of the same length give the same image, the same field shown as an
  ordinary field gives a different one (screenshot, PDF, cross-origin iframe).
- Sensitive fields are also recognized by name or id, camelCase included: `cardNumber`, `cc_number`, `cardCvc`,
  `otp`, `pin`, `securityCode`, `iban`... (`cc` alone, `spinner`, `passenger`, `option` are not secrets).
- `browser_logs` masks console messages like network bodies: secret keys, URL parameters, object previews
  (`{name, value}`), tokens quoted in a text (`Bearer …`, `ghp_…`, JWT).
- Network log: card number, card code, one-time code, PIN and IBAN keys masked in bodies and URL parameters.
- `NEXUS_CHROME_EXTRA_ARGS` is now an allowlist (`--lang`, `--accept-lang`, `--variations-override-country`,
  `--disable-features` with `Glic*` features only, `--force-dark-mode`): the former blocklist let through flags that
  weaken Chrome (`--disable-web-security`, `--disable-features=IsolateOrigins`...).

### Fixed
- Element screenshots (`selector`, `mark`) were blank when Chrome's page zoom is not 100% (seen at 90%): the clip is
  now converted with the page zoom reported by `Page.getLayoutMetrics`.

### Added
- Real Chrome test of masking in a cross-origin iframe (reads and capture).
- Real Chrome check that Julien's tabs are left intact now ignores tabs of other agents (they may close theirs during
  the run).

- Every MCP tool has a readable `title` in its annotations, next to its four hints.
- Startup test: the MCP server answers `initialize` and `tools/list` with no Chrome, bridge or extension, on Windows
  and on Linux (as MCP directories such as Glama check it); outside Windows the emergency stop keeps watching its
  file and skips the global hotkey.
- GitHub Actions: `test.ps1` on Windows and the startup test on Linux, with a Tests badge; `glama.json`.
- README: Privacy section.

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
