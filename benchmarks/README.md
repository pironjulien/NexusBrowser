# Benchmark: NexusBrowser and Chrome DevTools MCP

A reproducible comparison of what an agent pays in tool responses (tokens) and whether the task succeeds, on three
everyday tasks with public pages. No model is called: `compare.py` plays the agent with a fixed sequence of tool
calls (observe, then act), so the numbers measure the tools, not a model's choices.

## Tasks

| Task | Page | Success when |
| --- | --- | --- |
| read | <https://en.wikipedia.org/wiki/Chromium_(web_browser)> | the content read contains the article's key facts |
| form | <https://httpbin.org/forms/post> | the 7 fields (text, tel, e-mail, radio, checkbox, time, textarea) read back as filled, nothing submitted |
| click | <https://news.ycombinator.com> | the "new" link was clicked and the tab is on `/newest` |

Each engine uses its own tools the way an agent would:

- NexusBrowser:
  - read: `browser_new_tab`, `browser_wait_load`, then `browser_export` (Markdown of the main content);
  - form: `browser_interactive_map(viewport_only=False)` for the whole form, then one `browser_fill_form`;
  - click: `browser_interactive_map`, `browser_click(mark=N)`, `browser_wait_load`.
- Chrome DevTools MCP:
  - read: `new_page`, then `take_snapshot` (it has no Markdown export);
  - form: `take_snapshot`, then `fill_form`;
  - click: `take_snapshot`, then `click(uid)`.

The check of the result (each engine's own script tool reads the page state) is not counted.

## Results (2026-10-26, NexusBrowser 2.26.2, Chrome DevTools MCP 1.12.0)

5 rounds per task, medians; tokens of the tool responses with the public o200k_base tokenizer (a proxy: Claude's
tokenizer gives other absolute numbers, the ratio between engines is what matters).

| Engine | Task | Success | Tokens | Calls | Seconds |
| --- | --- | --- | ---: | ---: | ---: |
| NexusBrowser | read | 5/5 | 14,874 | 3 | 0.4 |
| NexusBrowser | form | 5/5 | 1,318 | 4 | 1.7 |
| NexusBrowser | click | 5/5 | 3,794 | 5 | 2.7 |
| Chrome DevTools MCP | read | 5/5 | 57,542 | 2 | 0.7 |
| Chrome DevTools MCP | form | 5/5 | 380 | 3 | 0.9 |
| Chrome DevTools MCP | click | 5/5 | 10,155 | 3 | 1.9 |

Raw data: [results/results-2026-10-26.json](results/results-2026-10-26.json).

What it says, honestly:

- **Reading a page**: about 74 % fewer tokens with NexusBrowser. It returns the article as Markdown, while Chrome
  DevTools MCP returns the whole accessibility tree.
- **Clicking a link**: about 63 % fewer tokens, because the interactive map lists actionable elements only. It takes
  two more calls (the explicit waits for the page load).
- **Filling a form**: Chrome DevTools MCP is lighter, at 380 tokens against 1,318. NexusBrowser maps the whole form,
  then reads every field back after typing (value, `verified`, trusted input). That read-back proves the result to
  the agent, and it is the cost of this task.
- Both engines succeeded on every round.

Earlier runs of this benchmark found real NexusBrowser bugs, all fixed in 2.24.5:
- `browser_wait_load` returned on the `about:blank` of a new tab;
- the map gave fields their technical names;
- tool responses carried indented JSON;
- the export picked Wikipedia's reference list;
- a time input could not be filled.

## Not compared

- **Claude in Chrome**: it cannot be driven from an ordinary MCP client, so it cannot be measured the same way.
- **BrowserOS**: it is a browser of its own to install; left out of this run.

## Run it

Windows, Node.js (for `npx`), [uv](https://docs.astral.sh/uv/). NexusBrowser needs its bridge and extension.

On your own Chrome, with NexusBrowser installed:

```powershell
uv run --no-project --with "mcp==2.3.0" --with "tiktoken==0.12.0" benchmarks/compare.py --rounds 5 --out benchmarks/results
```

Isolated, without touching your Chrome or your bridge (as for the numbers above):

1. Start a test bridge on other ports with a disposable token:
   `python -B native-host/bridge_server.py --port 19224 --token-file <tmp>\token`.
2. Copy `extension/` with its WebSocket address set to `ws://127.0.0.1:19224`, and load it in a test Chromium with
   its own profile.
3. Pair the copy (`POST http://127.0.0.1:19225/api/pair`, then open `pair.html#<secret>`).
4. Run the benchmark with `NEXUS_BROWSER_HTTP_PORT=19225` and `NEXUS_BROWSER_TOKEN_FILE=<tmp>\token`.

Chrome DevTools MCP always starts its own isolated headless Chrome (`--isolated --headless`).
