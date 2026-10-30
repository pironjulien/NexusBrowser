# Chrome Web Store submission

Everything the Chrome Web Store dashboard asks for, ready to paste. Only the developer account (one-time
registration fee, the author's Google account) and the upload itself are left to the author.

## Package

```powershell
pwsh -NoProfile -File scripts/store-package.ps1 -OutDir dist
```

- `dist/nexus-browser-extension-<version>.zip`: `extension/` as Chrome loads it, without the manifest's `key` (the
  store signs the package with its own key). The store gives the extension **its own ID**, different from the
  unpacked one (`blcgddmjdkobmgakjffjpgiicjlflgjf`): `fjapmaccbgdfneoccclmlpgknbbfkaco`, already in
  `native/resources/bridge_config.json` (`store_id` and `allowed_origins`, a test checks both), so `install.ps1` declares
  the native host for both IDs and the bridge accepts both. Once the extension is published, set `store_public` to
  `true` and release: the installer's last step becomes "Add to Chrome" on the store page instead of developer mode.
  Keep only one of the two installed in a Chrome profile (both would connect to the same bridge).
- `store/assets/`: two screenshots 1280x800 and the small promo tile 440x280 (PNG); the 128x128 icon is
  `extension/icons/icon128.png`.

## Listing

- **Name** (from the manifest): NexusBrowser
- **Summary** (from the manifest, 132 characters at most): Chrome bridge shared by Antigravity, Claude and Codex
  (NexusBrowser): each agent in its own background tabs.
- **Category**: Developer Tools. **Language**: English.
- **Homepage**: https://julienpiron.fr/nexusbrowser/ · **Support**: https://github.com/pironjulien/NexusBrowser/issues
- **Privacy policy**: https://julienpiron.fr/en/nexusbrowser/confidentialite/ (from `store/PRIVACY.md`: tell the site session when it changes)
- **Visibility**: Public. **Regions**: all. **Price**: free.

### Description

```text
NexusBrowser lets the AI agents on your PC (Claude, Codex, Antigravity) use your own Chrome, with your sessions, in
background tabs: each agent works in its own tabs, grouped under its name, while you keep browsing in yours.

This extension is one of three pieces that run on your PC only: the extension, a local bridge (127.0.0.1) and an
MCP server that your AI app starts. Install them all with one command (Windows 10/11):
https://github.com/pironjulien/NexusBrowser#install

What the agent can do in its own tabs:
- open pages, click and type with trusted input, fill whole forms, pick options, upload files;
- read pages cheaply (interactive map, Markdown export), take screenshots and PDFs;
- answer alert/confirm/prompt dialogs, work inside cross-origin iframes;
- inspect network requests and response bodies (secret headers and fields masked);
- export Google Docs, Sheets and Slides, YouTube transcripts, wait for downloads.

Guard rails held by the extension and the bridge, not by the agent:
- an agent only touches the tabs it opened; your tabs only if you ask it to adopt one;
- sending, paying, publishing or submitting a form with your data needs your explicit yes, for that exact action;
- password, one-time-code and card values are never returned; the bridge accepts only this extension, with
  authenticated, signed messages;
- emergency stop for every agent: Ctrl+Alt+Shift+Esc.

No account, no telemetry, no remote server: nothing is sent to the author or to any third party.
Open source (MIT): https://github.com/pironjulien/NexusBrowser
```

## Single purpose

```text
Let the user's local AI agents drive Chrome in their own background tabs, through a local bridge on the same PC.
```

## Permission justifications

| Permission | Justification to paste |
| --- | --- |
| `debugger` | The agent's clicks and keystrokes are trusted input events sent with the Chrome DevTools Protocol to the agent's own background tab, so pages react as to a person and the user's window is never activated. It also answers JavaScript dialogs, reads network requests and responses the agent asked for, and takes screenshots and PDFs of that tab. The debugger is attached only to tabs the agent opened (or a tab the user explicitly lets it adopt), with an allowlist of commands, and detached after 30 s of inactivity. |
| `nativeMessaging` | Talks to the local native host `com.nexus.browser_auth`, installed by the user with NexusBrowser, which computes the authentication proofs for the local bridge: the bridge's secret token never enters Chrome. |
| `tabs` | Opens, closes and lists the agent's background tabs, and reads their URL and title to report them to the agent. The user's own tabs are reported with their domain only. |
| `tabGroups` | Groups each agent's tabs under its name (Claude, Codex, Antigravity) so the user sees which agent works where. |
| `webNavigation` | A tab that the agent's tab opens (a `target=_blank` link, a popup, a sign-in window) belongs to that agent too: the extension learns of it from `onCreatedNavigationTarget`. |
| `scripting` | Runs the extension's own packaged scripts (element locator, page map, Markdown export) in the agent's tab, in an isolated world. |
| `downloads` | Reports and waits for a download started by the agent's tab, and erases only that entry when the agent asks. |
| `offscreen` | Keeps the connection to the local bridge alive while the service worker sleeps (an offscreen document holds the WebSocket to 127.0.0.1). |
| `storage` | Remembers which agent session owns which tab (session storage, cleared when Chrome closes) and the popup's one setting, the optional Gmail unread counter (local storage). |
| `alarms` | A once-a-minute check that the connection to the local bridge is still up, without keeping the service worker awake. |
| Host permission `<all_urls>` and the content script | The agent may be asked to work on any site the user names. The content script only answers requests for the agent's own tab (locators, dialogs, cross-origin frames) and does nothing on other tabs. |

## Remote code

```text
No. All of the extension's code is in the package. The local bridge sends commands (open a tab, click, read), not
code. When the user's agent explicitly asks to evaluate a script in a page (browser_eval), that script runs in the
page through the DevTools protocol, as in the DevTools console, never in the extension's own context.
```

## Data usage (dashboard checkboxes)

- **Website content**: yes, handled locally: page text and screenshots of the agent's tabs are returned to the
  user's own AI app on the same PC, only when it asks.
- **Personal communications**: only if the user turns on the optional Gmail unread counter (off by default): the
  extension reads Gmail's unread feed and keeps only the number; no sender, subject or content.
- Not collected: personally identifiable information, health, financial, authentication information (password, code
  and card values are masked), location, web history, user activity tracking.
- Certifications to tick: data is not sold, not used or transferred for purposes unrelated to the single purpose,
  not used for creditworthiness or lending.

## Test instructions for the reviewer

```text
The extension needs its local bridge (Windows 10/11): install NexusSystem from the Microsoft Store
(https://apps.microsoft.com/detail/9NSH2P3QLWT1) and pick NexusBrowser, or in PowerShell:
  Invoke-WebRequest https://github.com/pironjulien/NexusBrowser/releases/latest/download/get.ps1 -OutFile get.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\get.ps1
With an AI client it declared (Claude Code, Codex, Antigravity), ask: "Open https://example.com in a background tab
and give me the page as Markdown." With no AI client at all, the command line does the same:
  '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_new_tab","arguments":{"url":"https://example.com"}}}' | & (Get-Content "$env:LOCALAPPDATA\NexusBrowser\current.json" | ConvertFrom-Json).exe --mcp | Out-String
A tab opens in the background, in a tab group named after the agent; the toolbar popup shows the bridge state and
each agent's tabs. No account is needed.
```
