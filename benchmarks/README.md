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

## Results (2026-11-03, NexusBrowser 2.35.1, Chrome DevTools MCP 1.12.0, Playwright MCP 0.0.84)

Run with the local harness `bench/compare.py` (see Run it), 5 rounds per task, medians, tokens of the tool responses (o200k_base proxy).
NexusBrowser in the real Chrome, background tab; the other two in their own isolated headless Chrome. NexusBrowser
reads with `browser_export(format="text")` and observes with `browser_axtree(mode="snapshot")`.

| Engine | Task | Success | Tokens | Calls | Seconds |
| --- | --- | --- | ---: | ---: | ---: |
| NexusBrowser | read | 5/5 | 6,792 | 3 | 0.5 |
| NexusBrowser | form | 5/5 | 727 | 4 | 0.8 |
| NexusBrowser | click | 5/5 | 5,192 | 5 | 0.8 |
| Chrome DevTools MCP | read | 5/5 | 56,078 | 2 | 0.5 |
| Chrome DevTools MCP | form | 5/5 | 380 | 3 | 0.8 |
| Chrome DevTools MCP | click | 5/5 | 10,029 | 3 | 0.8 |
| Playwright MCP | read | 5/5 | 62,672 | 2 | 0.4 |
| Playwright MCP | form | 5/5 | 802 | 3 | 0.7 |
| Playwright MCP | click | 5/5 | 13,709 | 3 | 1.5 |

Raw data: [results/results-2026-11-03.json](results/results-2026-11-03.json). The Markdown export of the same
article costs 14,626 tokens (its 417 link URLs), hence the `format="text"` advice for reading in 2.35.2.

### The AI apps' own browsers, same tasks (2026-11-03, one round each, rough sizes)

| Browser | Real profile | Read | Form | Click | Notes |
| --- | --- | --- | --- | --- | --- |
| NexusBrowser | yes | 6.8k tokens | 7/7, 4 calls | 5 calls | background tab, nothing visible |
| Claude, built-in browser (app pane) | no | about 7k tokens of page text | 7/7, 11 actions | 4 actions | its accessibility tree is empty while the pane is hidden (0x0 viewport); fields found by role only, without labels |
| Claude in Chrome | yes | not measured | not measured | not measured | installed but not connected after a Chrome restart |
| Codex, in-app browser | no | about 126k characters | 5/7 confirmed (capture failed hidden) | about 23k characters | separate profile |
| Codex, Chrome extension | yes | about 130k characters | 7/7 (confirmed by a capture) | about 1.7k characters | refuses `visible:false`; tel/e-mail values redacted in its reads |
| Antigravity, browser agent | yes | failed | not run | not run | uses chrome-devtools-mcp 1.9.0 on the running Chrome: Chrome's modal "allow remote debugging?" dialog blocks it |

The Codex and Antigravity rows were measured by those agents themselves on request, as characters, not tokens.

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

## Smaller answers (2026-10-31, NexusBrowser 2.34.0)

Same token count on the agent's side, in the real Chrome: `output_path` on an article export 14,786 → 423 tokens
(97 %), `json_path` on an API response 2,462 → 210 (91 %), `browser_logs(level="error")` 13,375 → 119 (99 %), and a
click with `include_changes=True` 101 tokens in one call instead of 2,707 in two (click, then a full snapshot).
Details: [results/results-2026-10-31.md](results/results-2026-10-31.md).

## Not compared

- **Claude in Chrome**: it cannot be driven from an ordinary MCP client, so it cannot be measured the same way
  (see the AI apps' browsers above).
- **BrowserOS**: it is a browser of its own to install; left out of this run.

## Run it

The harness is a local Python script, `bench/compare.py`, kept outside the published repository like the other
local benches (this repository tracks C# and the extension only). Its method is the one described above: the same
fixed sequence of tool calls per engine, tokens counted with `tiktoken` (o200k_base) on what the agent receives, each
result checked by the engine's own script tool.

```powershell
python -B bench\compare.py --rounds 5 --out results.json   # --engines nexus,devtools,playwright --tasks read,form,click
```

It needs Python with `mcp` and `tiktoken`, Node.js (`npx` fetches the pinned Chrome DevTools MCP and Playwright
MCP), NexusBrowser installed with its shared daemon and the `NEXUS_MCP_TOKEN` user variable. NexusBrowser opens and
closes its own background tabs only; the other two always start their own isolated headless browser.
