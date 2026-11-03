# NexusBrowser

**Your real Chrome, with your sessions, driven by Antigravity in background tabs.** The agent navigates, fills
forms, clicks, reads pages and network, handles dialogs and cross-origin iframes, exports pages, Google Docs,
Sheets, Slides and YouTube transcripts, and follows downloads, while you keep browsing in your own tabs.

- **Isolated**: the agent only touches the tabs it opened; one of yours only when you ask it to adopt it.
- **Masked**: passwords, codes and card numbers are masked in reads and screenshots; secret headers in network logs.
- **Safe by default**: sending, paying, ordering or publishing requires your explicit instruction or approval for
  that operation and a matching, single-use gesture token.

## Requirements

Windows 10 or 11 and Google Chrome 116+. The plugin talks to the NexusBrowser service installed on the PC (local
bridge on `127.0.0.1`, authenticated by the local token of `%USERPROFILE%\.nexus\mcp-token.txt`) and its Chrome
extension. If they are missing, ask Antigravity to install NexusBrowser (its skill gives the steps), or follow
[installation](https://github.com/pironjulien/NexusBrowser#install): no administrator rights.

## Privacy

Everything runs on your PC: no account, no telemetry, no remote server. Pages are loaded by your own Chrome with
your own sessions. Tool results go to Antigravity, which may send them to Google under its own privacy policy;
NexusBrowser sends nothing to the author or to any third party. Details:
[privacy](https://github.com/pironjulien/NexusBrowser#privacy).

## Links

- Source and releases: [github.com/pironjulien/NexusBrowser](https://github.com/pironjulien/NexusBrowser) (MIT)
- Project page: [julienpiron.fr/nexusbrowser](https://julienpiron.fr/nexusbrowser/)
- Support: [GitHub issues](https://github.com/pironjulien/NexusBrowser/issues)
