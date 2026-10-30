# Single purpose: the case, and the fallback (prepared, not submitted)

Written for a Chrome Web Store reviewer who questions the extension's single purpose because of the optional Gmail
unread counter (`https://mail.google.com` in the CSP's `connect-src`, next to `debugger` and `<all_urls>`). Nothing
here changes the version under review.

## The single purpose

> Let the user's local AI agents drive Chrome in their own background tabs, through a local bridge on the same PC.

Every permission serves it (store/README.md, "Permission justifications"): `debugger` for trusted input and the
agent's own tab state, `<all_urls>` because the agent works on whatever site the user asks for, `tabs`, `tabGroups`,
`webNavigation`, `scripting`, `downloads`, `offscreen`, `alarms`, `storage`, `nativeMessaging` for the local bridge's
authentication. The extension talks to no server: its only connections are `127.0.0.1` (the bridge) and, only when
the user turns it on, Gmail's own unread feed.

## Why the Gmail counter belongs to that purpose

- The local bridge serves the agents **and** the user's agent keypad (Logitech MX Creative Keypad "AI Agents"
  pad), which shows what the agents are doing and whether something waits for the user. The unread count is one of
  the signals that keypad shows next to the agents' state: it reaches the same local bridge, never anything else.
- **Off by default.** The popup has one setting, "Gmail unread messages for the pad", unticked on install. Until
  the user ticks it, the extension never contacts `mail.google.com`.
- **Minimal data.** It reads Gmail's official Atom feed (`/mail/feed/atom`) with the browser's own session, keeps
  only the `<fullcount>` number, and sends that number to `127.0.0.1`. No sender, subject, body or address is read
  or kept. Unticking it erases the number on the bridge.
- **No new permission.** The feed is reachable under `<all_urls>`, which the single purpose already needs; the CSP
  entry only allows the extension's own service worker to fetch it.
- Declared in the privacy fields: "Personal communications: only if the user turns on the optional Gmail unread
  counter (off by default); only the number is kept."

## Reply to paste if the reviewer still objects

```text
The Gmail unread counter is optional and off by default: until the user ticks it in the extension's popup, the
extension never contacts mail.google.com. When on, it reads only the unread count from Gmail's official Atom feed and
passes that number to the user's local NexusBrowser bridge on 127.0.0.1, which shows it on the user's agent keypad
next to the agents' state. No message content, sender or subject is read, kept or sent anywhere. If you prefer, we
will submit a version without this counter.
```

## Fallback: the package without the counter

`scripts/store-package.ps1 -OutDir dist -WithoutGmailCounter` builds
`dist/nexus-browser-extension-<version>-without-gmail-counter.zip`: the same extension without the popup's checkbox,
with the counter disabled in the service worker (`COMPTEUR_GMAIL_DISPONIBLE = false`) and `https://mail.google.com`
removed from the CSP. Everything else is byte for byte the default package (tests/NexusBrowser.Tests). The
unpacked extension installed by `get.ps1` keeps the counter, still off by default. If Google refuses: upload this
package, remove the "Personal communications" line from the privacy fields, and say so in the reply.
