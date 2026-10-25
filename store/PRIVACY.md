# NexusBrowser privacy policy

Applies to the Chrome extension "NexusBrowser" and the rest of NexusBrowser (local bridge, native host, MCP
server). Last updated: 2026-10-25.

## In short

NexusBrowser runs entirely on your PC. It has no account, no telemetry, no analytics and no remote server. Nothing
is sent to the author or to any third party, and nothing is sold.

## What the extension reads, and when

Only when the AI agent you run on your PC asks for it, and only in the tabs that agent opened (or a tab of yours you
explicitly let it adopt):

- page text, accessibility tree, screenshots and PDFs, console logs;
- network requests and responses of that tab (cookie, authorization and token headers and secret fields masked);
- cookie names and attributes (values only on local development sites).

Password, one-time-code and card values are never returned: they are masked in reads and drawn as dots in
screenshots and PDFs. A script the agent explicitly asks to run in a page (`browser_eval`) has the access of that
page, like the DevTools console.

The optional **Gmail unread counter** (off by default, a box in the toolbar popup) reads Gmail's unread feed in your
own session once a minute and keeps only the number of unread messages: no sender, subject or content.

## Where it goes

The extension talks only to the bridge on your own PC (`127.0.0.1`), through authenticated, signed messages. The
bridge returns the results to the AI app you connected (Claude, Codex, Antigravity...), which may send them to its
model provider under that provider's own privacy policy. Pages are loaded by your own Chrome with your own sessions,
as if you browsed them.

## What is stored, and where

On your PC only:

- in Chrome's session storage, which agent session owns which tab (cleared when Chrome closes), and in its local
  storage, whether the Gmail counter is on;
- under `~/.nexus/nexus-browser/`: the bridge token, a bridge log (connection and emergency-stop events, rotated at
  1 MB), the install log, screenshots (at most 50, each kept under 24 hours), the exports you ask for and, when the
  Gmail counter is on, the unread number;
- under `%LOCALAPPDATA%\NexusJournal\browser\`: one line per tool call (calling AI, action, outcome, duration, the
  registrable domain of the tab such as `google.com`, never the address), never page text, typed value, title or
  image.

## Removing it

Remove the extension from Chrome, then follow "Removing it" in the
[README](https://github.com/pironjulien/NexusBrowser#privacy): scheduled task, native host key and the folders above.

## Contact

Questions or concerns: https://github.com/pironjulien/NexusBrowser/issues
