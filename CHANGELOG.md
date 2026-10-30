# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.33.0] - 2026-10-30

The native engine (`NexusBrowser.exe`, C# .NET 10) is now the only one: no Python, no uv, anywhere.

### Added
- Releases carry the self-contained engine for each Windows architecture, `NexusBrowser-win-x64.zip` and
  `NexusBrowser-win-arm64.zip` (engine, extension, installer), with `SHA256SUMS.txt`, the Chrome Web Store package of
  the extension and a Sigstore build provenance (`gh attestation verify <file> --repo pironjulien/NexusBrowser`, or the
  attached `NexusBrowser-<version>.intoto.jsonl`). A `vX.Y.Z` tag builds and publishes them (`release.yml`).
- `get.ps1` (attached to the release, run as a file, never piped into PowerShell) installs that package without Python or .NET: it picks the zip for the PC's architecture, checks it
  against `SHA256SUMS.txt` before unpacking, then runs `install.ps1 -Register`. Test variables: `NEXUS_BROWSER_SOURCE`
  (local zip or folder), `NEXUS_BROWSER_TAG`, `NEXUS_BROWSER_ROOT` (unpack into a test folder, nothing registered).
- Public install without the Nexus supervisor: the shared MCP daemon (`127.0.0.1:16182`) runs as the task
  "Nexus Browser MCP" (at logon). Its bearer token is the one shared by every Nexus daemon: the file
  `NEXUS_MCP_TOKEN_FILE`, else `~\.nexus\mcp-token.txt`, reused when present and created exclusively otherwise, mirrored
  in the user variable `NEXUS_MCP_TOKEN`.
- Each engine build is installed once in `%LOCALAPPDATA%\NexusBrowser\versions\<fingerprint>` and never overwritten
  while it runs. On a Nexus workstation the daemon spec names it with the `exe` key and declares a `restart_request`:
  the running daemon restarts on the new build as soon as no tool call is running, instead of being stopped by the
  installer. Builds no process uses any more are removed.
- Engine commands that replace the Python scripts: `--register` (declares the server to Claude Code, Claude Desktop,
  Codex and Antigravity; former Python entries are replaced in place), `--refresh-extension` (installer check and
  reload of the extension), `--version`, `--fingerprint`. `scripts/store-package.ps1` builds the Chrome Web Store zip.
- Registry: `server.json` again, now with an `mcpb` package (the release's `nexus-browser.mcpb`, its SHA-256), published
  by the release workflow over GitHub OIDC.
- CI: `Security` workflow with gitleaks (whole history) and zizmor on every push and pull request.

### Fixed
- A pause of more than 161.8 s expired the client's session in the shared HTTP daemon: its next call got 404, the
  client reconnected with a new session, and the tabs it had just opened stayed refused ("driven by Claude in another
  session") until the extension's silence delay. Daemon sessions now live 1618 s idle, and a session closed by its
  client (DELETE) or expired releases its tabs at once: the daemon tells the bridge (`X-Nexus-Browser-Gone`), the
  extension makes them orphans the same agent can adopt. The daemon logs each session opened, closed, expired or
  unknown (404) on stderr, kept by the supervisor in `~\.nexus\daemons\nexus-browser.log`.
- The last session of an agent also announces its closure immediately, using a daemon identity that never owns or
  reclaims tabs. Failed announcements are retried when the bridge becomes available; a heartbeat already in flight
  cannot revive an explicitly closed session.
- Token initialization holds one stable sibling lock across reading and writing, so concurrent installers share
  one token even when the existing file is empty. Existing daemon readers remain compatible and a non-empty token
  is never replaced.
- `--bridge --port 0` lets Windows bind available WebSocket and HTTP ports atomically; the subprocess integration
  test reads its bound addresses instead of racing other tests for previously probed ports.
- The Chrome lifetime test shares heartbeat reads with writes, preventing the observer itself from crashing the
  child it checks for survival after the launcher's job closes.
- Session test fixtures dispose HTTP requests and partially started daemons when readiness checks fail.
- A refused tool argument (`timeout_ms` above the bridge limit) is refused before the page is read, so an accord is
  never spent on a call that cannot run.
- `get.ps1` leaves no download folder behind when a package is refused.
### Changed
- `nexus-browser-win-x64.mcpb` and `nexus-browser-win-arm64.mcpb` (Claude Desktop) carry the self-contained engine (server type `binary`) instead of installing
  the Python package with uv. The Gemini CLI extension uses the shared local daemon (`NEXUS_MCP_TOKEN`) instead of uvx.
- Tests are C#: xUnit v3 (`dotnet test`, Microsoft Testing Platform, `global.json`) for the engine, the former
  self-test, client registration, scripts and repository checks; `node --test` for the extension. `test.ps1` runs
  just these two; the CI runs the same on Windows. Build and test outputs stay in `~\.nexus\build\nexus-browser`.
- The Install CI checks the release package on a clean Windows under Windows PowerShell 5.1: client entries, the
  daemon with its token, a real round trip through the bridge and the extension, a tampered package refused, a failed
  update rolled back.
- Policy and page probes moved to `native/resources/` (`garde-fous.json`, `trigger_probe.js`, `webmcp_probe.js`,
  `bridge_config.json`).

### Removed
- The Python engine and everything around it: `client/`, `native-host/`, `packaging/`, `pyproject.toml`, `uv.lock`,
  the Python scripts, the Python tests and fuzz targets (with ClusterFuzzLite), the `--selftest` option (now xUnit
  tests), the `-Runtime` switch of `install.ps1` and the Linux startup job. The benchmark harness `compare.py` went
  with it; its results stay.
- PyPI and Glama publishing (`publish.yml`, `glama.json`): installation goes through NexusSystem. Earlier PyPI
  packages stay available.

## [2.32.0] - 2026-10-30

### Fixed
- A stand-alone install (one-line installer, `-Register`) on a PC without the Nexus supervisor no longer fails waiting
  for a shared native daemon that only the supervisor starts.
- Tabs of a dead shared (HTTP daemon) session are taken back right after the daemon restarts. Daemon sessions now
  report the daemon's own process id, so the bridge declares them gone as soon as that process dies; before, they
  looked alive for `SESSION_DEAD_MS` while the one-shot reclaim had already run, and the agent's own tabs stayed
  "other" (refused). The native daemon no longer auto-reclaims orphans on a session's first heartbeat: several
  conversations of the same agent share it, and the first one to beat (often an idle one) took the tabs of another.
  Orphans stay "orphan" until the conversation that needs them adopts or closes them.
- Common journal now in `%USERPROFILE%\.nexus\journal` instead of AppData: launched by Claude Desktop (an MSIX app), the engine's AppData writes went to a private copy the review and NexusSystem never saw.
- Native cold-start Chrome is launched by the interactive Explorer desktop broker, outside the MCP supervisor's
  process lifetime. Direct startup (including `UseShellExecute=true`) had attached Chrome to its kill-on-close job.
  There is no inherited-process fallback or retry after an uncertain launch. An invisible WinExe fixture reproduces
  the old failure and verifies the real startup branch survives caller/job closure, then exits normally.
- Native `browser_new_tab` recovery now starts the installed Chrome on its real Default profile when Chrome has been closed,
  then resends the command only after the extension reconnects. This startup/recovery path existed in Python
  and was missing from the native port. Safe opt-in Chrome flags retain Python's allowlist; existing Chrome
  processes are preserved. Read tools and idle heartbeats never reopen a browser that the user closed;
  `/api/status` includes `chrome_running` so a closed browser is distinct from a disconnected extension.
- Native Chrome authentication preserves inherited stdin/stdout pipes when Chrome launches the WinExe through
  `cmd.exe`; attaching the wrapper's console had left hosts waiting forever and Chrome disconnected.
- Windows deployment builds and self-tests a separate candidate, drains the supervised Browser daemon before
  replacing its binaries, and registers one native engine for authentication, bridge and shared MCP HTTP. The
  bridge keeps its log, native extension origins come from the shared configuration, and `verify.ps1` checks the
  selected runtime and authenticated Chrome connection. `install.ps1 -Runtime Auto` preserves the installed
  runtime; `-Runtime Native` explicitly selects the qualified native engine and `-Runtime Python` provides an
  explicit, visible rollback without discarding the native fixes.
- Native MCP parity: exact outward-action accords and session isolation, input/output schema checks, form
  prevalidation and final readback, WebMCP discovery/calls, bridge startup and reconnection, and native inline
  WebP images (size limits, deduplication, coordinates and regions) and Google export files. SkiaSharp is pinned
  with a NuGet lock file. Native tests always build current sources instead of testing an old installed binary.
- Native HTTP sessions expire after the same 161.8 seconds of inactivity as Python; active requests keep their
  lease, closed sessions cancel their requests, and a request body arriving after closure cannot recreate a
  session. Stdio/HTTP cancellation is observed before a late action reaches Chrome. An occupied MCP port reports
  an error and exits cleanly instead of opening a Windows crash dialog.
- Native validation runs the existing Chrome mouse and full fixtures through a native HTTP MCP session on an
  isolated port, preserving the installed endpoint and closing all fixture tabs and downloads.
- The native install confirms the replacement daemon through its health response and actual executable/PID.
  It no longer attempts a redundant second restart using an unreliable TCP listener owner lookup after a
  successful transactional deployment.

### Added
- Native C# (.NET 10) unified engine (`native/NexusBrowser.csproj` -> `NexusBrowser.exe`), compiled outside OneDrive
  (`%LOCALAPPDATA%\NexusBrowser\build\`) and published to `%LOCALAPPDATA%\NexusBrowser\native\NexusBrowser.exe`,
  combining `--auth-host` (`com.nexus.browser_auth`), `--bridge` (WebSocket 9224 + HTTP 9225 with `nexus-browser/1`
  mutual authentication, pairing, session liveness, emergency stop and secret-folder upload refusal), `--mcp` / `--http`
  (all 49 `browser_*` tools, MCP `2026-07-28` `server/discover`, guardrails and shared JSONL journal), `--rotate` and
  `--selftest`.

## [2.31.6] - 2026-10-28

### Changed
- Public agent guide: progress updates use ordinary commentary; question tools are reserved for actual questions
  that require a user answer. The guide remains independent of private profiles and local paths.
- Antigravity plugin manifest: `displayName` « NexusBrowser », so Antigravity shows the product name instead of the technical id.

## [2.31.5] - 2026-10-28

### Fixed
- Extension, the four open CodeQL findings: a Markdown table cell ending with `\` no longer escapes the next column
  bar (backslashes of the cell's text escaped, code spans left as they are); YouTube VTT captions decode `&amp;lt;`
  once, as `&lt;`, never as `<`, and nested cue tags (`<<c>c>`) are removed in one linear pass; a refusal reason sent
  by the bridge server is logged on one line, never as an extra log line.

## [2.31.4] - 2026-10-27

### Security
- Shared guardrail policy (NexusWindows): the lowercase Cyrillic and Greek look-alike letters (в к м н т β η) are
  read as Latin again, so `Coмmander` or `Posтer` still asks for the user's accord (a common-policy change had dropped
  them; 2.31.3 was not affected). Format characters and look-alikes now count only for detection: the text shown and
  the accord fingerprints are unchanged.

## [2.31.3] - 2026-10-27

### Added
- Fuzzing: ClusterFuzzLite runs Atheris fuzzers (`fuzz/`) on every push and pull request, and longer every week, on
  the code that reads what a web page or an agent sends, each with a safety property: WebMCP schemas and calls
  (bounded check, refusal only as "nothing was called"), page text (instruction and outward-word detection),
  addresses and error messages (only a domain or a fixed category reaches the shared journal), upload paths (anything
  under a secrets folder is refused). The same targets also run offline in `test.ps1` on seeds and random bytes.

### Security
- Shared guardrail policy (from NexusWindows): format characters (zero-width space, direction marks, soft hyphen)
  are removed and common Cyrillic and Greek look-alike letters are read as Latin before matching, so an outward
  word written `Env\u200boyer` or with a Cyrillic `Е` no longer escapes the accord check.
- The public `main` branch requires a pull request with an approved review and green checks (tests, Linux startup,
  CodeQL) for anyone but the repository admin; a workflow token can no longer write to it.

## [2.31.2] - 2026-10-27

### Fixed
- A call cancelled by the AI app while the server waited for the extension to reconnect could still send its action
  once the extension came back (the SDK runs tools in a worker thread that cancellation does not interrupt). The wait
  now checks for cancellation, before every resend too: a cancelled command is never sent.

## [2.31.1] - 2026-10-27

### Security
- Release files are signed: `nexus-browser.mcpb` and `get.ps1` carry a build provenance attestation (Sigstore,
  GitHub), and its bundle is attached as `nexus-browser.sigstore.json`. Check a download with
  `gh attestation verify nexus-browser.mcpb --repo pironjulien/NexusBrowser`. PyPI files were already attested.
- CodeQL code scanning on the public repository: Python (MCP server, bridge), JavaScript (extension) and the
  workflows, on every push, pull request and weekly.

### Changed
- CI: setup-uv 10.3.2, pypi-publish 1.14.3, codeql-action 4.39.1 (pinned by commit), Node 24 LTS for the extension
  tests.

## [2.31.0] - 2026-10-27

### Changed
- Seven more data tools publish their output schema and answer in `structuredContent`: `browser_content`
  (elements, or the page's text or HTML as a string), `browser_axtree` (full and snapshot modes),
  `browser_network_response`, `browser_check_handoff`, `browser_export`, `browser_export_gsuite` and
  `browser_youtube_transcript`. 19 tools are typed; the others (actions, captures, `browser_eval`,
  `browser_cdp_send` whose result is free) answer in text only. Same rules as 2.30.0: only `status` and `data`
  required, unknown keys allowed, masked values unchanged. Checked for real on example.com through the SDK's client.

## [2.30.0] - 2026-10-27

### Changed
- Typed tool outputs. The data tools publish their real output schema (`outputSchema`) and return their answer as
  `structuredContent`, an object clients and scripts read directly: `browser_list_tabs`, `browser_active_tab`,
  `browser_new_tab`, `browser_find`, `browser_network_requests`, `browser_download_status`, `browser_wait_download`,
  `browser_get_cookies`, `browser_interactive_map`, `browser_logs`, `browser_webmcp_tools`, `browser_wait_for`. Until
  now 46 of the 49 tools declared a false schema (`{result: string}`) and sent their JSON twice, once as text and once
  as that escaped string. The schema is the usual envelope (`status`, `data`, optional `untrusted_note` / `warning`):
  only `status` and `data` are required and unknown keys are allowed, so an older or newer extension never gets a real
  answer rejected. Masked values stay masked: the structured answer is exactly the text answer.
- Action and capture tools no longer declare any output schema and no longer echo their text in
  `structuredContent`: text (and images) only.
- A failed call (bridge error, invalid argument, accord refusal, stopped batch) is now an MCP tool error (`isError`),
  its JSON reason unchanged in the text. A bridge answer that does not fit a tool's schema is reported the same way,
  with the answer kept and the mismatch named, instead of the SDK's generic error.
- A client that kept the tool list of an earlier version (from before this server restarted) must list the tools
  again: reconnecting does it, and the list is announced fresh for one minute.

### Added
- `tests/test_output_schemas.py`: schemas checked against the bridge's real answer shapes (dialog interruptions and
  optional fields included), and a run through the SDK's official client (`mcp.client.client.Client`, `auto` and
  `legacy` modes), which validates every `structuredContent` against the announced schema.

## [2.29.0] - 2026-10-27

### Added
- The MCP server sends its icon and website to clients when they connect (`serverInfo`, the same as in
  `server.json`), and announces how long its tool list stays fresh (one minute, private cache: MCP protocol
  2026-07-28).

### Planned
- Chrome Web Store: the 2.24.3 review in progress is kept; once approved, an update with the Nexus family icon is
  sent and the listing's 128 px icon is replaced by `extension/icons/icon128.png`.

## [2.28.1] - 2026-10-27

### Fixed
- `install.ps1`: the shared MCP daemon (port 16182) runs on the same venv and locks its native modules, so a package
  update while it ran left the venv half-installed (27/10: websockets 17.3 without `asyncio/server.py`, bridge down).
  When `uv sync --dry-run` reports changes, the daemon's supervisor spec is set aside (the supervisor stops it without
  restarting it), packages are synced, then the spec is restored and the daemon restarts on the new code. Nothing to
  change: the daemon stays up. Checked for real: package reinstalled, daemon restarted, extension verified.
- `browser_wait_load`: a navigation that LEAVES the Chrome Web Store for an allowed page was refused as protected,
  because Chrome still reports the old `url` while `pendingUrl` holds the destination. The page is now judged on its
  destination (`pendingUrl || url`).
- `browser_axtree` (`mode="snapshot"`): a snapshot with no numbered control left the previous number table and mark
  roots in place, so `browser_click(mark=1)` clicked an element of the old page. The table and roots are now always
  reset, even when the list is empty.

## [2.28.0] - 2026-10-27

### Changed
- `browser_screenshot` / `browser_vision_inspect` with `inline=True`: images sent to the AI follow the common Nexus
  image rule of 27/10: long side up to 2000 px and 2.56 MP (was 1568 px and 1.15 MP), lossless WebP while it fits
  500 KB (was 200 KB, so a real screen went lossy), then quality 90, 80, 70…; never over 500 KB. Small text is read
  better (98.8 % of characters instead of 92 % in our benchmark).

### Added
- `server.json`: `icons` (Nexus family medallion, PNG and SVG) so the MCP Registry and its clients show the
  product icon.

## [2.27.0] - 2026-10-27

### Added
- Compact accessibility snapshot, like Playwright MCP's ARIA snapshot: `browser_axtree(tab_id, mode="snapshot")`
  returns the whole page as indented lines (`- role "name" [states] [#N]: value`), layout wrappers flattened and text
  already given by a name not repeated. Every enabled control gets a reference `[#N]`, registered in the extension's
  isolated world as a mark: `browser_click(mark=N)`, `browser_fill(mark=N)`, `browser_fill_form`... use it directly.
  Card numbers and codes are masked as in the full tree; `max_lines` caps the output (400 by default). Main frame
  only; `mode="full"` (default) still returns the raw AX nodes.
- Benchmark: Playwright MCP 0.0.83 next to Chrome DevTools MCP 1.12.0, and NexusBrowser observing with the snapshot
  as well as with the interactive map. Results for 2.27.0 in `benchmarks/README.md` (5 rounds, every engine 5/5): the
  snapshot brings the form task from 1,312 to 799 tokens, level with Playwright MCP; Chrome DevTools MCP stays the
  lightest there (380).

### Changed
- Pages protected by Chrome (Chrome Web Store gallery, `chrome://` and other internal pages) are recognised at once:
  `browser_wait_load` answers immediately instead of waiting until its timeout (30 s seen), `browser_new_tab` and
  `browser_navigate` flag them (`protected_page`, `warning`), and Chrome's raw errors ("The extensions gallery cannot
  be scripted", "Cannot access a chrome:// URL") become one clear message pointing to a desktop screenshot.
- Dependencies: websockets 17.3 (allowed `<18`) and, for the benchmark, tiktoken 0.14.0 (replaces Dependabot PRs).
- The extension's only non-local CSP entry, `connect-src https://mail.google.com`, is now explained in the README: it
  serves the optional Gmail unread counter (off by default); a test keeps the CSP to the bridge and that one feed.

### Security
- The shared HTTP daemon no longer accepts WebSocket upgrades (uvicorn `ws="none"`): such a request reached the MCP
  app without the token check (the app had no WebSocket route), and the daemon kept websockets' compiled module
  loaded, which made `uv sync` fail ("access denied") when websockets was upgraded.

## [2.26.8] - 2026-10-27

### Added
- Antigravity plugin logo: the Nexus family icon (`plugins/nexus-browser/logo.png`, 256 px, `logo` key of
  `plugin.json`), copied with the plugin by the installer, like the other Nexus products.

## [2.26.7] - 2026-10-27

### Changed
- Small icons (Chrome toolbar 16 and 32 px, popup logo shown at 26 px, spinning working indicator) are the
  julienpiron.fr medallion cut round (`docs/assets/nexusbrowser-round.svg`, transparent corners) instead of the window
  pictogram alone, which is no longer shown anywhere; 48 px and up keep the full medallion. `notes/icons.mjs` names
  the variant of each icon.

## [2.26.6] - 2026-10-26

### Changed
- Nexus family icon: the NexusBrowser window pictogram set in the julienpiron.fr medallion (clean silver ring, inner
  circuits faded), the same on the site and in every Nexus product. 48 px and up (extension icons 48 and 128, popup
  and pairing logo, `.mcpb` bundle icon) use the medallion `docs/assets/nexusbrowser-mark.svg`; 16 and 32 px keep the
  pictogram alone (`docs/assets/nexusbrowser-icon.svg`), still readable in the toolbar. `notes/icons.mjs` now renders
  every icon, the bundle's included.

## [2.26.5] - 2026-10-26

### Fixed
- Outward-action check bypassed on web components: on a button whose label is rendered by a web component (text
  passed through a `<slot>` or written in its shadow root, as on Partner Center), a click by `mark` or `selector` read
  an empty label and went out WITHOUT asking for the accord. The trigger is now read as rendered (shadow roots, slot
  contents, the inner button of a custom element) whatever the targeting (mark, selector, text, locator).
- A click by text on such a button hit the card that contains it (`<he-card>`, centre of the card) instead of the
  button: the nearest control is now found in the rendered tree (through the slot), and a custom element counts as its
  inner button.
- An accord is spent only when the gesture really goes out. A click refused before any event was sent (element
  covered, not found, ambiguous) used up the token, and the user had to be asked again; the token now stays valid
  (`accord_kept: true`, same token, same expiry). A gesture whose outcome is unknown still spends it.
- Elements covered by an empty layer or a sticky bar (X's transparent full-screen layer `r-1p0dtai`, its bottom bar
  over the Reply button): after scrolling the element to the centre, an empty layer (no text, no media, no role, no
  interactive content, transparent background, no open modal dialog elsewhere) is crossed for the gesture only
  (`pointer-events: none`, restored right after; `passed_layers` in the response), and a fixed or sticky bar is
  scrolled away from. The click must still land on the element itself; a real modal, a darkened backdrop or an
  interactive element on top is still refused, with no mouse action. Refusals now end with "Nothing was sent.".
- A `beforeunload` dialog in an agent's tab no longer takes the user's view: Chrome brings the tab to the front to
  show it, and the tab the user was on is now made active again, the dialog staying open in the background tab
  (answered with `browser_handle_dialog`, checked in Chrome). `browser_navigate` attaches the debugger first so that
  this dialog is seen.

## [2.26.4] - 2026-10-26

### Fixed
- Infinite and lazy-loaded feeds now load in a background tab. `browser_scroll` scrolled, but the page stayed
  hidden (`visibilityState` "hidden"): Chrome suspended rendering, `requestAnimationFrame` and
  `IntersectionObserver`, so X, Reddit, LinkedIn or YouTube never fetched the next items. Scrolling now turns on
  the tab's focus emulation first (as clicks already did), which makes the page visible and active without
  selecting the tab or touching the user's window. Measured in a real Chrome, tab kept in the background: an X
  profile went from 5 posts after 8 scrolls to 21, a Reddit feed from 3 posts after 6 scrolls to 24.

## [2.26.3] - 2026-10-26

### Added
- `benchmarks/`: a reproducible benchmark against Chrome DevTools MCP 1.12.0 (read a page, fill a form, click a
  link; 5 rounds, tokens of the tool responses). Both succeed 15/15; NexusBrowser uses about 74 % fewer tokens to
  read and 63 % fewer to click, Chrome DevTools MCP is lighter on the form (380 against 1,318: NexusBrowser reads
  every field back). Method, results and how to run it isolated in `benchmarks/README.md`.
- `NEXUS_BROWSER_HTTP_PORT` (client) and `bridge_server.py --port` (bridge): a test bridge on other ports, for
  isolated runs such as the benchmark. Defaults unchanged (9224/9225).

## [2.26.2] - 2026-10-26

### Changed
- Lighter tool list for the AI app, same names, parameters, schemas and behavior: `tab_id` is described in one
  sentence on the 42 tools that take it (the rule, this session's tabs only, stays in the server instructions), and
  the descriptions of `browser_click`, `browser_fill` and `browser_drag_and_drop` are tightened without dropping
  what the model needs. `tools/list`: 68,501 to 64,033 characters (compact JSON), 16,355 to 15,492 tokens
  (o200k_base).

### Fixed
- Claude Desktop with the `nexus-browser.mcpb` extension installed (`Claude Extensions/<id>/manifest.json`): the
  installer adds no entry to `claude_desktop_config.json` and removes its own (the extension already starts the
  server; the tools came twice). An entry written by the user is left alone.

## [2.26.1] - 2026-10-26

### Fixed
- A failed update keeps the working version. `get.ps1` prepares the new version beside the current one
  (`app.next`) and installs its Python dependencies once in a throwaway environment before changing anything: a
  failed download or an unavailable dependency leaves the install untouched. Each folder is then switched by a single
  rename; if the installation fails, the previous folder comes back, is installed again and its bridge restarted.
  `install.ps1` deferred by an agent at work now exits with code 3, and only the folders go back. Tested with
  injected faults: locally (unavailable dependency, failing installer, deferral) and on a fresh Windows in the public
  CI (a lock pointing to an unreachable host without cache, an installer failing after it stopped the bridge).

### Added
- `NEXUS_PACK_TARGETS` (the Nexus pack's `-Only` / `-Skip`, e.g. `claude-code,codex`): only these AI apps are
  configured, the others are not touched and reported as `skipped` (an empty list: none); an unknown name is refused.
- Install without `irm | iex`: `get.ps1` and `get.ps1.sha256` are attached to every release, first in the README
  (download, check the SHA-256, right-click > Run with PowerShell); the window stays open when started from Explorer,
  also on an error.
- Chrome Web Store, prepared and not submitted: `store/SINGLE_PURPOSE.md` (the single purpose and the optional Gmail
  counter, a reply to paste) and `scripts/store_package.py --without-gmail-counter` (the same package without the
  counter: no checkbox, never read, `https://mail.google.com` out of the CSP), in case Google objects. The version
  under review is unchanged.

## [2.26.0] - 2026-10-26

### Added
- Self-update, the contract shared by the Nexus products (an app from the Microsoft Store copies nothing itself): the
  bridge writes `~\.nexus\status\browser.json` (`product`, `version`, `latest` from the redirect of
  `releases/latest` at most once a day, without the GitHub API, `state` idle/checking/updating/done/failed,
  `checked_at`, `message`). `GET /api/update` returns it; `POST /api/update` (bridge token) answers 202 and starts the
  "Nexus Browser Update" task (no trigger), which runs `scripts/self-update.ps1`: `get.ps1` with `-File` outside the
  bridge, so the bridge and the extension come to the new release. Deferred while an agent works in Chrome; a failure
  keeps the current version and says why in `message`. Public install only (`%LOCALAPPDATA%\NexusBrowser\app`, the
  task is registered there only): a clone answers 409 and updates with git. Nothing changes for a clone.

## [2.25.0] - 2026-10-25

### Added
- Pairing without the native host, for installs where `com.nexus.browser_auth` cannot be declared to Chrome (an app
  from the Microsoft Store, whose HKCU writes are virtualized): `scripts/pair-extension.ps1` (or `-Print` for a code to
  paste) asks the bridge for a single-use 256-bit secret (5 minutes, 5 wrong proofs end it; `POST /api/pair` with the
  bridge token) and opens the extension's new `pair.html` page. Both sides derive the extension's key from the secret
  and the handshake that consumed it; the extension keeps it as a non-extractable WebCrypto key in its IndexedDB, the
  bridge in `paired-extensions.json` next to its token. The extension then authenticates as `paired` with the same
  proofs and signed messages. The native host stays first whenever it is installed: nothing changes for current
  installs. The popup links to the pairing page while the bridge is not connected. Revocation: `POST /api/pair/revoke`.
  Measured end to end in a test Chromium 151 (separate profile, extension without `nativeMessaging`): page opened
  from the command line, pairing, service worker and offscreen authenticated, a command answered; no Local Network
  Access prompt for the extension's connection to 127.0.0.1.

### Fixed
- A refused handshake now closes the extension's WebSocket at once (code 4008): browsers refuse code 1008 from a
  client, so the socket stayed open until the bridge's 10 s handshake timeout.

## [2.24.6] - 2026-10-25

### Added
- Claude Desktop extension `nexus-browser.mcpb` (MCPB, server type "uv": this exact version of the server from PyPI),
  attached to every release under a fixed name
  (`https://github.com/pironjulien/NexusBrowser/releases/latest/download/nexus-browser.mcpb`). Install it by dropping
  it on Claude Desktop's window or from Settings > Extensions.

### Changed
- The test of `get.ps1` runs its latest-release probe from a file (`-File`), never a download passed in `-Command`.

## [2.24.5] - 2026-10-25

### Fixed
- `get.ps1` reads the latest release from the redirect of `github.com/pironjulien/NexusBrowser/releases/latest`
  instead of the GitHub API, which refuses unauthenticated callers past 60 requests an hour per IP ("API rate limit
  exceeded" on shared IPs and CI runners). The API stays as a fallback only.
- Claude Desktop from the Microsoft Store: the server is declared where it reads its configuration
  (`%LOCALAPPDATA%\Claude-Data\<package>`) and in `Packages\AnthropicPBC.Claude_*` (the old pattern missed the
  publisher prefix); a folder it left (`.user-data-left.*`) is skipped.
- `browser_wait_load` no longer returns on the `about:blank` of a tab still loading its first page.
- `browser_interactive_map` names fields by their label (`aria-label`, `aria-labelledby`, `<label>`) before their
  placeholder, title or technical name.
- Date, time, month, week, color and range inputs can be filled (`browser_fill`, `browser_fill_form`).
- Page export no longer picks a references or bibliography block as the main content (Wikipedia articles).

### Changed
- Extension icon (16, 32, 48, 128) back to the julienpiron.fr π medallion of 2.16.1 to 2.24.2; the popup already
  shows it.
- Tool results are compact JSON (no indentation): fewer tokens for the same content.
- Gemini CLI extension (`gemini-extension.json`) and one-click install badges for VS Code and VS Code Insiders.
- The public English skill lives in `skills/nexus-browser/SKILL.md`.

## [2.24.4] - 2026-10-25

### Added
- Nexus pack mode (`NEXUS_PACK=1`, used by the pack's `get-nexus.ps1`): no question, no wait, no window (Chrome, guide
  and clipboard left out), exit code 0 on success and a last line `NEXUS_PACK_RESULT Claude Code=...; Codex=...;
  Antigravity=...`. The pack shows the guide itself at the end:
  `%LOCALAPPDATA%\NexusBrowser\app\scripts\guide-extension.ps1 -WaitSeconds 0`. CI job "pack" on a clean Windows.

### Changed
- Antigravity gets a `nexus-browser` plugin (`plugins/nexus-browser`: the stdio server and the English skill
  `skills/nexus-browser/SKILL.md`, enabled in its `config.json` while it is closed) instead of an entry in its global
  `mcp_config.json`; a global entry left by 2.24.0-2.24.3 is removed. A plugin of the user's own is left alone.

## [2.24.3] - 2026-10-25

### Changed
- Extension icon (16, 32, 48, 128): the NexusBrowser icon of the project page (a violet browser window), readable at
  16 px, replaces the π medallion. Source: `docs/assets/nexusbrowser-icon.svg`. Chrome Web Store screenshots and promo
  tile redrawn in the same art direction (Claude, Codex and Antigravity; dark full-frame demo).

## [2.24.2] - 2026-10-25

### Added
- Chrome Web Store extension accepted: its ID (`fjapmaccbgdfneoccclmlpgknbbfkaco`, `store_id` in
  `native-host/bridge_config.json`) is in `allowed_origins`, so the bridge and the native host accept it as well as
  the unpacked one (a test checks both). `store_public`, false until the extension is published, then makes the
  installer's last step open the store page ("Add to Chrome") instead of developer mode.

### Changed
- The extension is named "NexusBrowser" (was "Nexus Browser Bridge"), the public name, in Chrome and on the store;
  messages naming it follow. The scheduled task keeps its name.

## [2.24.1] - 2026-10-25

### Added
- Chrome Web Store submission prepared (`store/`): listing text, single purpose, a justification for each
  permission (`debugger` first), remote-code and data-usage answers, reviewer test steps, privacy policy
  (`store/PRIVACY.md`), screenshots and promo tile. `scripts/store_package.py` builds the package (the extension
  without the manifest's `key`); a test keeps the listing in line with the manifest's permissions, name and summary.

### Fixed
- One-line install then the Claude Code or Antigravity `nexus-browser` plugin: running the installer again now removes
  its own earlier entry (the plugin provides the server; two entries meant every tool twice). An entry the user wrote
  is still never touched.
- The error shown by every tool before the one-time install now gives the one-line install command.

## [2.24.0] - 2026-10-25

### Added
- One-line install for Windows (`irm https://raw.githubusercontent.com/pironjulien/NexusBrowser/main/get.ps1 | iex`),
  no admin rights and no prerequisite: installs uv if needed, downloads the latest release into
  `%LOCALAPPDATA%\NexusBrowser\app` (the same folder on every update, so Chrome keeps the extension) and runs
  `install.ps1 -Register`.
- `install.ps1 -Register`: the server is declared over stdio to the AI clients found (Claude Code, Claude Desktop,
  Codex, Antigravity; `scripts/register_clients.py`), with the client's name as its tab group. An entry the user wrote,
  or a `nexus-browser` plugin that already provides the server, is left alone; each file is backed up and written
  atomically. Then a guide for the one manual step: `chrome://extensions` opened, the extension folder copied to the
  clipboard, three steps shown, and a wait until the extension is connected.
- CI "Install": the one-line installer on a fresh Windows runner under Windows PowerShell 5.1, then every client
  entry and a real MCP round trip through the bridge and the extension (Chrome for Testing).

### Fixed
- `install.ps1` runs under Windows PowerShell 5.1, the only PowerShell of a new Windows (the install log was written
  with a pwsh-only encoding; the script is now plain ASCII, which 5.1 reads right without a BOM). A test checks that
  every install script is ASCII and parses under 5.1.
- With `-Register`, Chrome open without the extension yet (a first install) no longer stops the installer.

## [2.23.5] - 2026-10-25

### Security
- Pillow 13.0.0 at least (`pillow>=13,<14`): the lock still resolved Pillow 12.3.0 for Python 3.10, affected by the
  advisories fixed in 13.0.0 (heap overflows in JPEG, FlashPix and TIFF decoding, among others).

### Changed
- Python 3.11 or later (`requires-python = ">=3.11"`): Pillow 13 no longer supports 3.10, which reaches its end of
  life this month. Ruff and Pyright target 3.11 (`datetime.UTC`, `TimeoutError`).

## [2.23.4] - 2026-10-25

### Fixed
- `verify.ps1` reported the native host as "not aligned" when `install.ps1` had run under the other PowerShell
  edition (Windows PowerShell 5.1 and pwsh 7 format `ConvertTo-Json` differently): the host manifest is now compared
  by its content, the launcher still byte for byte.

## [2.23.3] - 2026-10-25

### Fixed
- Gmail unread counter: a profile moving from 2.23.1 (no identifier, stored as `defaut`) to 2.23.2 was counted twice
  for up to 3 minutes; the `defaut` entry is now dropped as soon as a profile sends its identifier.

## [2.23.2] - 2026-10-25

### Fixed
- Gmail unread counter with several Chrome profiles: each profile now has its own entry (a random identifier, nothing
  personal) in `compteurs.json` (`{"sources": {...}}`), and the pad adds them up. Unticking the box in one profile
  removes only that profile's entry; the file is deleted when none is left, and entries older than a day are dropped.
- Unticking the box while the feed was being read could write the number back afterwards: each send is numbered and
  the box is read again after the feed, so a late result is dropped.

## [2.23.1] - 2026-10-25

### Fixed
- Gmail unread counter for the pad (new in 2.23.0) never got a number: the extension's content security policy only
  allowed the local bridge (`connect-src`), so the request to Gmail's feed was blocked. `https://mail.google.com` is
  added to `connect-src` (that origin only). The counter reads `https://mail.google.com/mail/feed/atom` and follows its
  redirect; a signed-out session lands on a page without `<fullcount>`, so the count stays unknown.
- When the number is unknown, the counter file says why, as one word of a fixed list (`deconnecte`, `reseau`,
  `http-<code>`), never any mail content.
- The counter is declared among the extension's features (`gmail-counter`).

## [2.23.0] - 2026-10-25

### Added
- Gmail unread counter for the MX Keypad AI Agents pad (off by default, a box in the toolbar popup): when ticked, the
  extension reads Gmail's official unread feed once a minute in the user's session and the bridge writes only the
  number to `~/.nexus/nexus-browser/compteurs.json` (deleted when unticked). Tests: `tests/test_compteurs.py`, popup
  test.

### Changed
- Workspace reorganisation: the shared guardrail policy, the log and the comparison benchmark moved to their new
  locations; paths updated accordingly.
- Outward accord: submitting a form now counts as outward when its button says Submit, Soumettre, Transmettre,
  Postuler or Valider ma demande (...) and the form carries typed text, an email address, a number or a file, or
  could not be read (caution). Still free: sign-in (password field, typed by the user alone), search, filter, empty
  form, a wizard's "Next" / "OK". Rule specific to the browser (`client/outward_gate.py`, the only tool that reads
  the trigger's form): the shared policy `garde-fous.json` is unchanged. A Typeform support form's "Submit" (email,
  identifier, free text) went out without an accord.
- CI: a newer push cancels the running test (Windows minutes count double on private repositories).
- `install.ps1`: the shared MCP daemon and the Antigravity registration are optional. When the daemon token is
  missing (another machine, secrets vault not synced yet), it warns and skips them instead of stopping; the bridge,
  native host and task are still installed. The token is still never created by the installer.
- README: states what `install.ps1` really registers (Antigravity through its plugin, when the daemon token is
  present; Claude Code and Codex are configured separately).
- Skill: version number removed from its title; the emergency stop section describes the current extension (shared
  shortcut, read-only toolbar popup, working indicator) instead of the removed side panel, STOP button and status
  pill.
- Extension and Antigravity plugin descriptions in English.
- README, Privacy: documents the per-call journal (`%LOCALAPPDATA%\NexusJournal\browser\`) and how to delete it.
- Skill: `inline`, `region` and `force` of `browser_screenshot` and `browser_vision_inspect`.
- The installer's extension refresh introduces itself to the bridge as `Installer` instead of borrowing `Codex`.
- Changelog: subtitles removed from the 2.6.0 to 2.9.0 headings; links to the tagged releases.

### Fixed
- `browser_fill` refused an `<input>` with an unknown type ("<input> is not an input field"): Typeform writes
  `type="short_text"`, which the browser treats as a text field (HTML: missing, empty or unknown type = text). The
  type is now normalised as HTML does in the extension (typing, focus target) and in the accord's read script
  (`client/trigger_probe.js`), which did not see that field either (Enter in that field escaped the check).
- Bridge error message: the install link points to the README's `#install` anchor (was `#installation`).
- README and skill: `readOnlyHint` exempts a WebMCP tool from nothing (true since 2.18); the installation fingerprint
  removed in 2.19 is no longer mentioned.
- `install.ps1`: the shared MCP daemon is reloaded once, at the end and after the driven-tabs check, never with
  `-SkipLaunch` (a warning says the new code waits for its next restart). It used to stop every `mcp_server.py --http`
  process early, even with `-SkipLaunch`.
- The warning "emergency stop not guaranteed" (no running agent holds Ctrl+Alt+Shift+Esc) now reaches the AI in tool
  results (`warning`); it was written but never shown.
- Live validation types a reserved address (`user@example.invalid`) instead of one on a real domain.

### Security
- `reload_extension` is reserved to the installer (`Installer` identity of `scripts/refresh_extension.py`) and refused
  while any agent works in Chrome (running command, or tab held by a live session). Any client holding the token
  could reload the extension and cut every agent's running commands.
- `download_erase` only erases a download attributed to one of the caller's tabs by `browser_wait_download`
  (attribution kept in `chrome.storage.session`). Any client could erase the user's or another agent's downloads.
- `browser_list_tabs` and `browser_active_tab` give the full title and URL only of the caller's own tabs (opened or
  adopted). The user's and other agents' tabs show their origin only (`title` null, `redacted: true`), so tokens or
  identifiers in their URLs no longer leak; a user tab can still be designated by id and domain for
  `browser_adopt_tab`.
- `browser_webmcp_call`: a WebMCP tool that presents itself as a submission (Submit, Soumettre, Transmettre,
  Postuler, Valider ma demande...) and receives entered data needs the user's accord, as a form submitted by a click
  or a key now does (see Changed). Empty calls, choices and searches stay free.

## [2.22.0] - 2026-10-24

Rest of the common image rule of the Nexus tools (points 3 to 5; point 2, text first, was already the default here:
an image is attached only when the agent asks for it with `inline=True`).

### Added
- No duplicate image: the fingerprint of every attached image (64 × 64 grey levels) is kept per MCP session, tab and
  target; when the view has not changed since the last image sent, the answer says `image.unchanged` with a note and
  attaches nothing (`force=True` resends it). Never shared between the sessions of the shared daemon.
- Zoom: `browser_screenshot(region=[x1, y1, x2, y2])`, in pixels of the last whole-view image attached for the tab,
  captures that area enlarged (Chrome `clip.scale`, up to 4×) within the same limits, to read small text without
  sending the whole view in large.
- Numbers and coordinates: each marker of `browser_vision_inspect(inline=True)` gets `image_box` [x1, y1, x2, y2] in
  pixels of the attached image (the badge numbers are drawn on it); `box_2d` (0-1000) stays for Gemini.
- Common journal of the Nexus tools (product `browser`): one line per tool call in
  `%LOCALAPPDATA%\NexusJournal\browser\<agent>\<YYYY-MM>.jsonl`, with the calling AI (identity of the MCP session),
  the action, the outcome (`✓`, `=`, `~`, `✗`, `refus`, `arrêt`), the duration and the technique. `app` is the
  registrable domain of the tab only (`google.com`, `bbc.co.uk`; `ip`, `localhost`, `local`, or the scheme for
  `data:`/`about:`), taken from the address the browser returns (WHATWG parsing: a backslash counts as a slash), never
  the address; never page text, typed value, title or image; the error is a category from a fixed list (`timeout`,
  `not found`, `refused`...), never a piece of the message. A batch refused before any step still gets its line.
  Writing never blocks an action; lines already queued are written at a normal shutdown (1.6 s at most).
  `NEXUS_JOURNAL_HOME` moves it.
- `browser_batch` attaches the images of its capture steps (`inline=True`), in step order.

### Fixed
- A view seen again at another size or device pixel ratio is never reported as unchanged, and the zoom uses the scale
  of the last image actually attached.

## [2.21.0] - 2026-10-24

### Changed
- `browser_screenshot(inline=True)` and `browser_vision_inspect(inline=True)` attach a real MCP image block instead
  of a base64 PNG inside the JSON text (which no model sees as an image, and which was never reduced). The image
  follows the common rule of the Nexus tools: long side at most 1568 px and 1.15 megapixels (Claude's standard limit,
  read as is by GPT-5.x and Gemini 3, so positions on the image stay exact), lossless WebP, quality 85 above 200 KB,
  never more than 500 KB (Antigravity answers HTTP 400 above). `data.image` gives the sent and source sizes, `scale`,
  and `css_per_image_px` with `css_origin` to turn a position on the image into page CSS pixels (the extension now
  returns `devicePixelRatio` for the viewport and the marked capture). Files written to disk keep the full-resolution
  PNG.
- New dependency: Pillow.

### Fixed
- Element screenshot: `captureBeyondViewport` (which removes the scrollbar space and shifted the page during the
  capture, so the crop landed beside the element and the page stayed shifted) is used only for an element larger
  than the view. Such an element is then measured with the scrollbar hidden, the geometry the capture uses (same
  element, Shadow DOM included), and only `scrollbar-width` is restored afterwards; a fallback restore runs by itself
  if a dialog blocks the normal one. A dialog opened during a capture is reported (`dialogOpened`), never accepted,
  in file mode too (it raised a bare `'dataUrl'` error).
- A capture too large to attach (over 40 megapixels) is refused cleanly before decoding.

## [2.20.0] - 2026-10-24

Second anti-bloat step, decided by the user: duplicated tools are entropy.

### Removed
- Three public tools that duplicated `browser_click` and `browser_fill` (52 -> 49 tools, so fewer tool descriptions
  loaded into every agent's context):
  - `browser_click_mark(mark)`: use `browser_click(mark=N)`;
  - `browser_semantic_click(role, name)`: use `browser_click(locator={"role": ..., "name": ...})`, strict. The legacy
    path without a locator (most specific element, not strict) is gone with it, in the extension and in the outward
    accord check;
  - `browser_semantic_fill(label, value)`: use `browser_fill(locator={"label": ...})` or `{"placeholder": ...}`.
- The matching extension actions (`click_mark`, `semantic_click`, `semantic_fill`) and CLI commands (`click-mark`,
  `semantic-click`, `semantic-fill`; `click --selector "#N"` clicks a mark).
- Outward accord check: targets given as a list of alternatives (label then placeholder), used only by
  `browser_semantic_fill`.

### Fixed
- Live validation: no field is focused during the PDF masking check; the blinking caret of the password field
  ended up in one PDF out of two.

## [2.19.0] - 2026-10-24

Anti-bloat pass by the three agents (Claude, Codex, Antigravity): what all of them, or two with proof, found unused
is removed; public tools are unchanged.

### Security
- Tab ownership: a command carrying several tabs (`tabIds`) has every one of them checked whatever its action name.
  The `tabs_group` alias skipped that check: with one of its own tabs as `tab_id`, an agent could group the user's
  or another agent's tabs (found by Codex). Owned `tabIds` never exempt the `tab_id` target from its own check.
- Tab ids are read once and strictly (integer, or a string of digits only) before authorization, and the same value
  is used to act: `"1e2"` meant tab 100 to the ownership check and tab 1 to the action (found by Codex, present
  since the ownership checks). Conflicting `tab_id`/`tabId` or malformed `tabIds` are refused.
- Upload: the secret-folder check applies to any command carrying `files`, whatever its action name, in the client
  and in the bridge.

### Removed
- One name per bridge action: the alias table of the bridge and about 35 aliases in the extension (`get_dom`,
  `evaluate`, `print_pdf`, `upload_file`, `take_screenshot`, `tabs_group`...) that no client sends. Each alias had to
  be copied into every guard-rail list (emergency stop, retry of read-only commands, uploads).
- Extension actions sent by no client: `form_fields`, `type`/`type_text`, `uncheck` (`fill` with `replace=false`
  and `check` with `checked=false` do the same); tab id read from `params.id`; click mark read from `number` or `id`.
- Former names of the adoption consent (`julienAsked`, `julien_asked`, CLI `--julien-asked`): only `userAsked` is
  sent and read (renamed in 2.11).
- `installed.stamp` and `scripts/empreinte.ps1`: nothing read them any more (the machine sync computes its own
  stamp).
- The copy of the skill in `plugins/nexus-browser/`: `skills/nexus-browser/SKILL.md` is the only source, copied into
  Antigravity's plugin by `install.ps1`.
- Dead code: an unused outward-label helper, an unused reconnection delay override, an unused protocol export, an
  unused test helper; stale comments about the removed status pill.

## [2.18.0] - 2026-10-23

### Added
- `browser_webmcp_call` checks the input against the tool's `inputSchema` before anything is called (or any accord
  token issued): a wrong type, a value outside an enum or `const`, a missing required field, a number or length out
  of bounds, an unexpected property when `additionalProperties` is false are refused with the exact problems. Chrome
  passes such input to the page's handler unchecked (seen on Chrome's pizza-maker demo). The schema is page text, so
  only keywords with a linear cost are applied, without regular expressions or references: `$ref`, `allOf`/`anyOf`/
  `oneOf`, `pattern`, `format` and the like are left to the page. A full JSON Schema validator would download remote
  `$ref`s from the PC (localhost included), and could be frozen for days by a 2 KB chain of references or by a
  catastrophic regular expression. A schema the checker does not understand never blocks a call; neither does an
  older or unknown dialect (`$schema` other than draft-06, draft-07, 2019-09 or 2020-12).

### Security
- `browser_webmcp_call`: `readOnlyHint` no longer exempts a tool from the outward-word check. It is the page's own
  claim: a tool named `send_email` declared read-only ran without the user's accord. Only a tool with no outward
  word, consequential hint or outward submit button runs freely.

### Changed
- `browser_webmcp_call` and `browser_webmcp_tools`: the main status is `error` when the page's handler failed or
  timed out, or when a dialog interrupted the read or the call (`dialogOpened`, never accepted); it was `success`
  with the failure only inside `data`.
- Development dependency: pyright 1.1.407 → 1.1.414.
- Working indicator: the breathing blue-violet glow behind the logo is removed; only the spinning logo and its drop
  shadow remain.
- Shared guard rails (`client/garde_fous.py`): copy aligned on the common policy, an unused French refusal removed.

- CI: the Scorecard job only runs on the public repository (it cannot score a private copy).

### Removed
- In-tab status pill (« agent · action », bottom right): noise next to the working indicator and the agents' tab
  groups, which already show which tab belongs to whom.

### Fixed
- `browser_new_tab`: a tab opened but whose ownership could not be saved is closed and the error reported; before, the
  window fallback opened a second tab and the first one was left behind (same fix as chrome-devtools-mcp 1.12 for
  `new_page`). Only a failure of `chrome.tabs.create` itself leads to the window fallback. If Chrome refuses to close
  it, the error says so and the tab stays the agent's (to close with `browser_close_tab`), never reported as closed.
- `install.ps1` no longer creates the daemons' shared token when it is missing: it stops and points to the machine
  sync, the only place where the token is born (once the secrets vault has been synced). Run too early on a new PC,
  it created a second token that broke the other PC.
- Outward-action summary: the text of a field (contenteditable or input) is captured up to 128 KiB instead of being
  cut at 4,000 characters, so the summary shown before a send covers the whole message.
- Emergency stop: the remaining time is now bounded to [0, HOLD_S]; floating-point rounding could report
  120.00000000000003 s, above the 120 s hold.

## [2.17.0] - 2026-10-20

### Added
- Working indicator: while an agent runs a page command or opens a tab, the NexusBrowser logo spins on itself
  (72 px, like a game loading screen, with a breathing glow) in the bottom right corner of the tab the user is
  looking at (agents work in background tabs), and follows the user across tabs and windows. Drawn by
  `chrome.scripting` in the isolated world and a closed shadow root, click-through, so it also shows in tabs opened
  before an extension update (their content script no longer receives messages); the logo is passed as a data URL,
  no resource is exposed to pages. A dot on the toolbar icon says the same on Chrome pages where nothing can be
  drawn. Hidden 1.6 s after the last command; heartbeats and tab lists never show it.

### Changed
- Popup: the emergency stop line reads "Tout arrêter 2 min : Ctrl+Alt+Maj+Échap". The tab status pill sits left of
  the spinning logo.

## [2.16.1] - 2026-10-20

### Changed
- Extension icon: the julienpiron.fr π emblem (the bridge serves the three agents) instead of the Antigravity glyph,
  which is removed.
- Toolbar popup redrawn after Gemini's home screen: dark background with a soft blue glow, Google Sans, the bridge
  state as a centred headline, the agents in one rounded surface.

## [2.16.0] - 2026-10-20

### Added
- Toolbar popup (click on the NexusBrowser icon), read only: bridge state (connected or not, with the reason),
  how many tabs each agent drives (its named tab group), and the emergency stop shortcut. Gemini-like look, light or
  dark with the system. Nothing in it acts on pages or agents.

## [2.15.0] - 2026-10-20

### Removed
- Chrome side panel ("control station", Alt+Shift+Y): it duplicated what already exists. STOP is the shared
  emergency stop (Ctrl+Alt+Shift+Esc, `~\.nexus\stop`), and the tabs each agent drives are shown by its named Chrome
  tab group. Removed end to end: the panel page, its view and style, the `sidePanel` permission and shortcut, the
  `getControlState` / `panelStop` / `panelRelease` messages, the bridge event `emergency_stop` sent from Chrome and its
  relay through the offscreen document. The toolbar button is now titled "NexusBrowser" (it still said "Antigravity").

### Fixed
- Shared daemon: a client on the stateless MCP protocol (2026-07-28, no `mcp-session-id` header, as Claude Code
  now connects) fell back to the process identity "Nexus", so its tabs were not grouped or isolated under its own
  agent. Such a client now gets one identity per agent for the daemon's life, heartbeated like an open session (its
  orphan tabs are taken back after a daemon restart).

## [2.14.0] - 2026-10-20

### Removed
- Antigravity side panel chat ("Discussion" view, built on 2026-10-18): it never carried a single message. Removed
  end to end: the panel's thread, composer and suggestion chips (`agy_chat.js`), the `agy_ask` bridge event and the
  bridge-reserved `agy_panel_update` command, the bridge's Nexus Relay mailbox polling (`agy_panel.py`), and the
  consent bound to a panel request (`panel_request` of `browser_adopt_tab`, with the hand-back of a panel-adopted tab
  when the user navigated it himself). Nexus Relay is simplified: only Claude opens exchanges with the other AIs. The
  old thread is erased from `chrome.storage.local` when the extension starts.
- Kept as is: the side panel (Alt+Shift+Y), now opening straight on the control station (piloted tabs, "Rendre
  l'onglet", bridge state, no view switcher), and the STOP button and banner, always visible in the header.

### Fixed
- `install.ps1` no longer refuses to run when Chrome is open and the on-demand bridge has simply not started yet: it starts the bridge task, then checks again.

### Added
- OpenSSF Scorecard badge in the README (the Scorecard workflow already runs on every push).

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

### Added
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
- Shared daemon mode: `client/mcp_server.py --http [port]` serves MCP Streamable HTTP on 127.0.0.1 (port 16182), one
  process for every Claude, Codex and Antigravity session instead of one per session. Bearer token required
  (`NEXUS_MCP_TOKEN` or `NEXUS_MCP_TOKEN_FILE`); the agent comes from the URL (`?agent=codex`, refused otherwise);
  each MCP session gets its own identity (its tabs), is heartbeaten by the daemon while open and goes silent once
  closed, so its tabs become orphans for its agent. `install.ps1` declares the daemon to the Nexus supervisor and
  registers the three clients by URL. A session idle for 161.8 s (no request, no open stream) is closed, so a client
  that left without a DELETE frees its tabs in ~3 min instead of 30; a new session beats (and reclaims) within a
  second (review by Antigravity).
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
- PyPI package `nexus-browser` (the MCP server, command `nexus-browser`): the wheel mirrors `client/` and
  `native-host/` unchanged under `nexus_browser/` (hatchling force-include); `install.ps1` and the three agents keep
  running from the repository (`[tool.uv] package = false`). Published by Trusted Publishing
  (`.github/workflows/publish.yml`), checked from the built wheel (initialize, 47 tools).
- README: animated demo recorded from the real tool; install from PyPI.
- `SECURITY.md`: private vulnerability reporting.

### Changed
- Server instructions sent to every MCP client are now in English and neutral ("the user"), no personal name.
  Tool descriptions, parameter descriptions and messages returned to the model (server, bridge, extension) say
  « l'utilisateur » too; they stay in French. Same rules and flow. A test checks that `initialize` and
  `tools/list` name nobody.
- `browser_adopt_tab(tab_id, user_asked=True)`: neutral name for the consent flag. `julien_asked`, its former name,
  still works as an alias; the bridge sends `userAsked` (read by the extension from this version) and `julienAsked`
  (read by older extensions). CLI: `adopt-tab --user-asked` (`--julien-asked` kept).
- Side panel greeting is « Bonjour »; a tab nobody drives is labelled « Utilisateur » in the control panel.
- `install.ps1` no longer writes `[mcp_servers.nexus-browser]` to Codex's `config.toml` nor copies the skill to
  `~\.codex\skills`: Codex gets both from a personal Codex plugin.
- `install.ps1` no longer registers the server with Claude Code nor copies the skill to `~\.claude\skills`, and never
  calls a Claude CLI: Claude Code gets both from a Claude Code plugin. Codex and Antigravity are unchanged.
- `browser_export_youtube_transcript` is renamed `browser_youtube_transcript`: Antigravity publishes each tool as
  `mcp_nexus-browser_nexus-browser_<tool>` and silently drops any name over 64 characters, so it never saw this one
  (65). No client used the old name; the bridge action `export_youtube_transcript` is unchanged. A test now checks
  that every tool name fits once prefixed.
- `browser_new_tab(group)` and `browser_group_tabs(title)` default to the current session's agent name
  (`group=""`: no group).
- Bridge not reachable and no token: the error now points to the one-time install (install.ps1).
- Repository renamed to `pironjulien/NexusBrowser`; GitHub redirects the old address.

### Fixed
- Native messaging host registered in the real `HKCU` registry (`scripts\registre-reel.ps1`: `reg.exe` run by a
  one-shot hidden scheduled task). Run from a packaged (MSIX) app such as the Claude desktop app, the write went to the
  app's private registry and Chrome reported « native messaging host not found »: the extension never connected.
- `is_chrome_running`: `tasklist` output read as bytes; with `PYTHONUTF8=1` its OEM code page (French « Numéro »)
  crashed every tool call made while the extension was offline. `icacls` output decoded with the OEM code page too.
- Antigravity showed the nexus-browser skill twice (global copy + plugin): `install.ps1` keeps it in the plugin only
  and moves the old global copy to a local backup.
- A sensitive field's state masks every representation of its value, not only `value`: `text`, `selectedValue` and
  `selectedText` too (a card-expiry `<select>` or a password `contenteditable` leaked them through `select_option`).
- Side panel shortcut is now Alt+Shift+Y: Chrome took Alt+Shift+N for split view ("Select a tab") and silently
  dropped the extension's key. The shortcut handler also opens the panel at once with the tab Chrome gives it:
  waiting for a tab query first lost the keyboard gesture `sidePanel.open` requires, so the panel never opened.
  An existing install keeps its old setting: set the key in chrome://extensions/shortcuts.
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
- A navigation by Julien DURING a panel adoption is no longer lost: each tab keeps a navigation generation, bumped
  before any wait even when no marked owner exists yet; the adoption reads it at the end and hands the tab back. A
  panel adoption writes ownership once, already marked (no second write that could undo a hand-back), and a late
  refusal restores the previous owner only if nobody changed it meanwhile. Both interleavings Codex ran (event during
  the final consent read; event during the reclaim save) are tests now.
- Nexus Relay missing or impossible to launch is "retenue" too, never "non transmise": it says nothing about an
  earlier filing of the same request, so the panel keeps the reservation and resends the same id.
- A panel adoption compares against the ownership object IT wrote (returned by `rememberTabOwner` before any wait),
  never the one found in the map after the save: if Julien handed the tab back and another agent adopted it in the
  meantime, the old adoption now refuses without restoring, releasing or overwriting the newer owner.
- Handing a tab back checks ownership again AFTER detaching the debugger, right before removing it: a late hand-back
  (two hand-backs of the same navigation, another agent adopting the tab in between) leaves the newer ownership
  intact. The control station's "Rendre l'onglet" still hands back whoever owns the tab when it is clicked.

## [2.9.0] - 2026-10-18

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

## [2.8.1] - 2026-10-18

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

## [2.8.0] - 2026-10-18

Re-run `install.ps1` (with Antigravity closed), then RELOAD the extension in `chrome://extensions` (capabilities
`sensitive-field-masking`, `cdp-reload-no-script` and `ax-value-masking` advertised by ping), then open a new
conversation in each agent.

Known issue: `Page.captureScreenshot` sometimes hangs for 12 to 20 s in a background tab (both `browser_screenshot`
and `browser_vision_inspect`, measured on October 18, unrelated to this version): the real-world validation retries
the visual map up to 3 times and counts the hangs. Root cause to be addressed separately (fixed in 2.8.1).

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

### Added
- Tests (Node): content, visual map, search, HTML and accessibility tree contain no sensitive value; typing into a password
  field, into a card field rewritten by the page, and through the JavaScript fallback returns no value;
  `Page.reload` with a script refused before reaching Chrome. Mutation checked: without masking, the three masking
  tests fail.
- Tests (Python): SDK 2, complete annotations consistent with the bridge read list, accurate wording about `browser_eval`
  (tool, instructions, both copies of the skill, README).
- Real-world validation (`--full-live`): password and card never read (content, HTML, visual map, search, Chrome
  accessibility tree), password entry verified and masked, `Page.reload` with a script refused.

## [2.7.1] - 2026-10-17

Re-run `install.ps1` (with Antigravity closed), then RELOAD the extension in `chrome://extensions`
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
- Default CLI identifier `cli` (3 characters) was refused by the bridge (4 minimum): now `cli-local`. Test added.

## [2.7.0] - 2026-10-17

Re-run `install.ps1` (with Antigravity closed), then RELOAD the extension in `chrome://extensions`
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
- No caches in the source tree: ruff `cache-dir` and pytest `-p no:cacheprovider` in `pyproject.toml`,
  `sys.dont_write_bytecode` in the client and bridge modules; `.ruff_cache`, `client\__pycache__` and
  `native-host\__pycache__` deleted.

### Removed
- Panel chat (text box, bridge queue, `browser_sidepanel_requests` / `browser_sidepanel_reply`) and its four
  buttons; dead `popup.html/js`; SoM display from the content script that was never triggered.
- Migration: `install.ps1` removes (log `~\.nexus\nexus-browser\install.log`) the old token `~\.nexusagy\bridge-token` and the
  files of the old native host; `verify.ps1` checks they are gone and reports the old "Antigravity Browser Bridge"
  extension if a Chrome profile loads it (preferences read, never modified).

## [2.6.0] - 2026-10-16

Reload the extension (new folder, new identifier) and re-run `install.ps1` on each machine.

Verified: real-world validation in the user's Chrome: `--mouse` 11/11, `--full-live` 29/29 (`test.ps1 -Full` green four
times in a row). First three runs right after loading the extension: 27/29, empty network log for the `/api/data`
request (cause not found, not reproduced since); the failure now prints the log and the click response.

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

### Removed
- Migration: `install.ps1` stops and removes the "NexusAGY Browser Bridge" task (same ports 9224/9225) and the native host
  `com.nexusagy.bridge_auth`. The old "Antigravity Browser Bridge" extension must be removed from Chrome.

Versions up to 2.4.0 were published as "Antigravity Browser Bridge" in the same public repository; see its git history.

[Unreleased]: https://github.com/pironjulien/NexusBrowser/compare/v2.33.0...HEAD
[2.33.0]: https://github.com/pironjulien/NexusBrowser/compare/v2.32.0...v2.33.0
[2.26.3]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.26.3
[2.26.2]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.26.2
[2.26.1]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.26.1
[2.26.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.26.0
[2.25.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.25.0
[2.24.6]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.24.6
[2.24.5]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.24.5
[2.24.4]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.24.4
[2.24.3]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.24.3
[2.24.2]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.24.2
[2.24.1]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.24.1
[2.24.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.24.0
[2.23.5]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.23.5
[2.23.4]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.23.4
[2.23.3]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.23.3
[2.23.2]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.23.2
[2.23.1]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.23.1
[2.23.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.23.0
[2.22.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.22.0
[2.21.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.21.0
[2.20.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.20.0
[2.19.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.19.0
[2.18.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.18.0
[2.17.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.17.0
[2.16.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.16.0
[2.15.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.15.0
[2.13.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.13.0
[2.12.1]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.12.1
[2.11.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.11.0
[2.10.1]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.10.1
[2.10.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.10.0
[2.9.0]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.9.0
[2.8.1]: https://github.com/pironjulien/NexusBrowser/releases/tag/v2.8.1
