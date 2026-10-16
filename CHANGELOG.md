# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow the extension's `manifest.json`.

## [2.2.0] - 2026-10-16

### Added
- Role and label locators (`locator_kit.js`, modelled on Playwright): `role`/`name`, `label`, `text`, `placeholder`,
  `testId`, `altText`, `title`, `hasText`, `exact`, `nth`, `includeHidden` and state filters, strict by default, for
  every targeting command; `find` lists candidates without acting.
- Real CDP mouse input (`Input.dispatchMouseEvent`) for click, double and right click, hover and drag, with the target
  point verified before acting and a trusted-event probe in the response; JavaScript fallback reported as
  `js_fallback`.
- Trusted typing for `fill`, `type`, `semantic_fill` and `type_keys`: real click to focus, real Ctrl+A, `Input.insertText`
  or per-key input, value read back. `press_key` accepts shortcuts; new `check` / `uncheck`.
- Cross-origin iframes: flat child sessions for out-of-process iframes (Chrome 125+), isolated worlds for same-process
  frames, points mapped back to the main viewport.
- Network log per tab (500 requests, sensitive headers masked), `network_requests`, `network_response`;
  `wait_download`.
- JavaScript dialogs never accepted automatically: `dialogOpened`, `pendingDialogs`, `handle_dialog`.
- Agent tab persisted in `chrome.storage.session`; commands that would otherwise target the user's tab are refused.
- `ping` reports the loaded feature list.
- `tests/browser.test.cjs`: 84 offline tests against simulated Chrome APIs, CDP input and DOM; `test.ps1`.

### Changed
- `type` now appends to the existing text; `fill` replaces.
- The debugger is detached after 30 s of inactivity and when the tab closes.
- `wait_network_idle` tracks requests by id and resets on navigation.

### Fixed
- First click lost in a background tab: page focus emulation is enabled before mouse input, and re-enabled after an
  idle detach.
- Text-based targeting could select `<html>` and report a false success on the whole page.

## [2.1.0] - 2026-10-12

Previous public release: background tabs, Chrome tab groups, status pill, cold-start keepalive, origin list.
