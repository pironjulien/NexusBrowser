# Benchmark: NexusBrowser, Chrome DevTools MCP and Playwright MCP

A reproducible comparison of what an agent pays in tool responses (tokens) and whether the task succeeds, on three
everyday tasks with public pages. No model is called: the harness played the agent with a fixed sequence of tool
calls (observe, then act), so the numbers measure the tools, not a model's choices.

## Tasks

| Task | Page | Success when |
| --- | --- | --- |
| read | <https://en.wikipedia.org/wiki/Chromium_(web_browser)> | the content read contains the article's key facts |
| form | <https://httpbin.org/forms/post> | the 7 fields (text, tel, e-mail, radio, checkbox, time, textarea) read back as filled, nothing submitted |
| click | <https://news.ycombinator.com> | the "new" link was clicked and the tab is on `/newest` |

Each engine uses its own tools the way an agent would:

- NexusBrowser (interactive map):
  - read: `browser_new_tab`, `browser_wait_load`, then `browser_export` (Markdown of the main content);
  - form: `browser_interactive_map(viewport_only=False)` for the whole form, then one `browser_fill_form`;
  - click: `browser_interactive_map`, `browser_click(mark=N)`, `browser_wait_load`.
- NexusBrowser (snapshot): the same, but observing with the compact accessibility snapshot
  `browser_axtree(mode="snapshot")` (whole page, `[#N]` references passed as `mark=N`).
- Chrome DevTools MCP:
  - read: `new_page`, then `take_snapshot` (it has no Markdown export);
  - form: `take_snapshot`, then `fill_form`;
  - click: `take_snapshot`, then `click(uid)`.
- Playwright MCP:
  - read: `browser_navigate`, then `browser_snapshot` (its ARIA snapshot; no Markdown export);
  - form: `browser_snapshot`, then `browser_fill_form` with the `[ref=eN]` references;
  - click: `browser_snapshot`, then `browser_click(target=ref)`.
  Since 0.0.8x, the snapshot that follows an action is saved to a file and only linked in the response, so its
  action responses are short; the agent reads the page with `browser_snapshot`.

The check of the result (each engine's own script tool reads the page state) is not counted.

## Results (2026-10-27, NexusBrowser 2.27.0, Chrome DevTools MCP 1.12.0, Playwright MCP 0.0.83)

5 rounds per task, medians; tokens of the tool responses with the public o200k_base tokenizer (a proxy: Claude's
tokenizer gives other absolute numbers, the ratio between engines is what matters). Run isolated (test bridge,
test Chromium for NexusBrowser; Chrome DevTools MCP and Playwright MCP each in their own isolated headless Chrome).

| Engine | Task | Success | Tokens | Calls | Seconds |
| --- | --- | --- | ---: | ---: | ---: |
| NexusBrowser (map) | read | 5/5 | 14,875 | 3 | 0.3 |
| NexusBrowser (map) | form | 5/5 | 1,312 | 4 | 1.3 |
| NexusBrowser (map) | click | 5/5 | 3,802 | 5 | 2.6 |
| NexusBrowser (snapshot) | read | 5/5 | 14,874 | 3 | 0.4 |
| NexusBrowser (snapshot) | form | 5/5 | 799 | 4 | 0.7 |
| NexusBrowser (snapshot) | click | 5/5 | 5,061 | 5 | 2.6 |
| Chrome DevTools MCP | read | 5/5 | 57,542 | 2 | 0.6 |
| Chrome DevTools MCP | form | 5/5 | 380 | 3 | 1.0 |
| Chrome DevTools MCP | click | 5/5 | 10,265 | 3 | 1.9 |
| Playwright MCP | read | 5/5 | 63,491 | 2 | 0.6 |
| Playwright MCP | form | 5/5 | 812 | 3 | 0.8 |
| Playwright MCP | click | 5/5 | 13,958 | 3 | 2.6 |

Raw data: [results/results-2026-10-27.json](results/results-2026-10-27.json) (previous run, without Playwright MCP:
[results/results-2026-10-26.json](results/results-2026-10-26.json)).

What it says, honestly:

- **Reading a page**: about 74 % fewer tokens than Chrome DevTools MCP and 77 % fewer than Playwright MCP. NexusBrowser
  returns the article as Markdown; the other two return the whole accessibility tree, they have no reading mode.
- **Clicking a link**: the interactive map is the lightest (63 % under Chrome DevTools MCP, 73 % under Playwright
  MCP): it lists the visible actionable elements only. The snapshot costs a third more than the map, because it
  describes the whole page, and stays about half of Chrome DevTools MCP. NexusBrowser takes two more calls (the
  explicit waits for the page load).
- **Filling a form**: Chrome DevTools MCP is the lightest, at 380 tokens. The snapshot brings NexusBrowser from 1,312
  down to 799, level with Playwright MCP (812); the rest is NexusBrowser reading every field back after typing (value,
  `verified`, trusted input), which proves the result to the agent.
- Every engine succeeded on every round. Seconds are wall time on one PC, for orientation only.

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

The harness (`compare.py`, Python) was removed with the Python engine in 2.33.0: the results above are kept as a
record of version 2.31 (same 49 tools and wire format as the native engine). Its method stays valid: the same
fixed sequence of tool calls per engine, tokens counted with `tiktoken` on what the agent receives.

Chrome DevTools MCP (`--isolated --headless`) and Playwright MCP (`--isolated --headless`) always start their own
browser.
