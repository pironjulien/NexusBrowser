"""Token and reliability benchmark: NexusBrowser against Chrome DevTools MCP on three real tasks.

Each engine runs the same tasks the way an agent would use its tools (observe, then act), on public pages:

- read:  open a Wikipedia article and read its content;
- form:  open https://httpbin.org/forms/post, observe it, fill 7 fields (text, tel, e-mail, radio, checkbox, time,
         textarea) without submitting;
- click: open https://news.ycombinator.com, observe it, click the "new" link.

Counted: every tool call the agent makes and the size of every response (characters, and tokens with the o200k_base
tokenizer, a public proxy: Claude's own tokenizer gives different absolute numbers, the ratio between engines is what
matters). Not counted: the independent check of the result (each engine's own script tool reads the page state).
A task succeeds only when that check passes. No model is called: the "agent" is this deterministic script, so the
numbers measure the tools, not a model's choices.

Engines differ by design: NexusBrowser drives the user's real Chrome in a background tab (its extension and bridge
must be installed); Chrome DevTools MCP starts its own isolated headless Chrome. Claude in Chrome cannot be driven
from a plain MCP client and BrowserOS is a browser of its own to install: both left out (see benchmarks/README.md).

Usage (from the repository root, Windows, Node.js for npx):
    uv run --no-project --with "mcp==2.3.0" --with "tiktoken==0.12.0" benchmarks/compare.py --rounds 5 --out benchmarks/results
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import os
import re
import shutil
import statistics
import sys
import time
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

import tiktoken
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[1]
DEVTOOLS_VERSION = "1.12.0"
ENCODING = tiktoken.get_encoding("o200k_base")

ARTICLE = "https://en.wikipedia.org/wiki/Chromium_(web_browser)"
FORM = "https://httpbin.org/forms/post"
NEWS = "https://news.ycombinator.com/"
FORM_VALUES = {
    "custname": "Ada Lovelace",
    "custtel": "0100000000",
    "custemail": "ada@example.com",
    "size": "medium",
    "topping": "cheese",
    "delivery": "11:30",
    "comments": "Leave it at the door",
}
FORM_CHECK = """(() => {
  const f = document.forms[0];
  return JSON.stringify({
    custname: f.custname.value, custtel: f.custtel.value, custemail: f.custemail.value,
    size: (f.querySelector('[name=size]:checked') || {}).value || '',
    topping: [...f.querySelectorAll('[name=topping]:checked')].map(e => e.value).join(','),
    delivery: f.delivery.value, comments: f.comments.value });
})()"""


def text_of(result: Any) -> str:
    return "".join(getattr(block, "text", "") for block in result.content)


class Meter:
    """Every call the agent makes, with the size of what it reads back."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def add(self, tool: str, response: str) -> None:
        self.calls.append({"tool": tool, "chars": len(response), "tokens": len(ENCODING.encode(response))})


class Engine:
    name = ""

    def __init__(self, session: ClientSession) -> None:
        self.session = session

    async def call(self, meter: Meter | None, tool: str, arguments: dict) -> str:
        result = await self.session.call_tool(tool, arguments)
        response = text_of(result)
        if meter is not None:
            meter.add(tool, response)
        if result.is_error:
            raise RuntimeError(f"{tool}: {response[:300]}")
        return response

    # The tasks, each engine with its own tools; a handle is the engine's tab or page id.
    async def open(self, meter: Meter, url: str) -> int:
        raise NotImplementedError

    async def close(self, handle: int) -> None:
        raise NotImplementedError

    async def check(self, handle: int, script: str) -> str:
        raise NotImplementedError

    async def read(self, meter: Meter, handle: int) -> str:
        raise NotImplementedError

    async def fill_form(self, meter: Meter, handle: int) -> None:
        raise NotImplementedError

    async def click_new(self, meter: Meter, handle: int) -> None:
        raise NotImplementedError


class Nexus(Engine):
    name = "NexusBrowser"

    @staticmethod
    def data(response: str) -> Any:
        payload = json.loads(response)
        if payload.get("status") != "success":
            raise RuntimeError(response[:300])
        return payload["data"]

    async def open(self, meter: Meter, url: str) -> int:
        tab = self.data(await self.call(meter, "browser_new_tab", {"url": url}))["id"]
        await self.call(meter, "browser_wait_load", {"tab_id": tab})
        return tab

    async def close(self, handle: int) -> None:
        await self.call(None, "browser_close_tab", {"tab_id": handle})

    async def check(self, handle: int, script: str) -> str:
        return str(self.data(await self.call(None, "browser_eval", {"tab_id": handle, "script": script})))

    async def read(self, meter: Meter, handle: int) -> str:
        return self.data(await self.call(meter, "browser_export", {"tab_id": handle}))["content"]

    async def fill_form(self, meter: Meter, handle: int) -> None:
        # The whole form, not only the visible part (the map's default): its last fields are below the fold.
        arguments = {"tab_id": handle, "viewport_only": False}
        elements = self.data(await self.call(meter, "browser_interactive_map", arguments))["elements"]
        mark = {e["label"].strip().rstrip(":").lower(): e["mark"] for e in elements}
        fields = [
            {"mark": mark["customer name"], "value": FORM_VALUES["custname"]},
            {"mark": mark["telephone"], "value": FORM_VALUES["custtel"]},
            {"mark": mark["e-mail address"], "value": FORM_VALUES["custemail"]},
            {"mark": mark["medium"], "checked": True},
            {"mark": mark["extra cheese"], "checked": True},
            {"mark": mark["preferred delivery time"], "value": FORM_VALUES["delivery"]},
            {"mark": mark["delivery instructions"], "value": FORM_VALUES["comments"]},
        ]
        self.data(await self.call(meter, "browser_fill_form", {"tab_id": handle, "fields": fields}))

    async def click_new(self, meter: Meter, handle: int) -> None:
        elements = self.data(await self.call(meter, "browser_interactive_map", {"tab_id": handle}))["elements"]
        target = next(e["mark"] for e in elements if e["label"].strip() == "new")
        self.data(await self.call(meter, "browser_click", {"tab_id": handle, "mark": target}))
        await self.call(meter, "browser_wait_load", {"tab_id": handle})


class DevTools(Engine):
    name = f"Chrome DevTools MCP {DEVTOOLS_VERSION}"

    async def open(self, meter: Meter, url: str) -> int:
        pages = await self.call(meter, "new_page", {"url": url})
        line = next(line for line in pages.splitlines() if line.rstrip().endswith("[selected]"))
        return int(line.split(":", 1)[0])

    async def close(self, handle: int) -> None:
        await self.call(None, "close_page", {"pageId": handle})

    async def check(self, handle: int, script: str) -> str:
        response = await self.call(None, "evaluate_script", {"pageId": handle, "function": f"() => {script}"})
        match = re.search(r"```json\s*(.*?)```", response, re.S)
        value = json.loads(match.group(1)) if match else response
        return value if isinstance(value, str) else json.dumps(value)

    async def snapshot(self, meter: Meter, handle: int) -> str:
        return await self.call(meter, "take_snapshot", {"pageId": handle})

    async def read(self, meter: Meter, handle: int) -> str:
        return await self.snapshot(meter, handle)

    @staticmethod
    def uid(snapshot: str, role: str, name: str) -> str:
        pattern = rf'uid=(\S+) {role} "{re.escape(name)}'
        match = re.search(pattern, snapshot)
        if not match:
            raise RuntimeError(f"no {role} {name!r} in the snapshot")
        return match.group(1)

    async def fill_form(self, meter: Meter, handle: int) -> None:
        snap = await self.snapshot(meter, handle)
        elements = [
            {"uid": self.uid(snap, "textbox", "Customer name"), "value": FORM_VALUES["custname"]},
            {"uid": self.uid(snap, "textbox", "Telephone"), "value": FORM_VALUES["custtel"]},
            {"uid": self.uid(snap, "textbox", "E-mail address"), "value": FORM_VALUES["custemail"]},
            {"uid": self.uid(snap, "radio", "Medium"), "value": "true"},
            {"uid": self.uid(snap, "checkbox", "Extra Cheese"), "value": "true"},
            {"uid": self.uid(snap, "InputTime", "Preferred delivery time"), "value": FORM_VALUES["delivery"]},
            {"uid": self.uid(snap, "textbox", "Delivery instructions"), "value": FORM_VALUES["comments"]},
        ]
        await self.call(meter, "fill_form", {"pageId": handle, "elements": elements})

    async def click_new(self, meter: Meter, handle: int) -> None:
        snap = await self.snapshot(meter, handle)
        await self.call(meter, "click", {"pageId": handle, "uid": self.uid(snap, "link", "new")})


async def task(engine: Engine, name: str) -> dict:
    meter = Meter()
    started = time.perf_counter()
    handle = None
    ok, detail = False, ""
    try:
        if name == "read":
            handle = await engine.open(meter, ARTICLE)
            content = await engine.read(meter, handle)
            ok = "Chromium" in content and "open-source" in content and "Google" in content
            detail = f"{len(content)} chars read"
        elif name == "form":
            handle = await engine.open(meter, FORM)
            await engine.fill_form(meter, handle)
            state = json.loads(await engine.check(handle, FORM_CHECK))
            wrong = {k: state.get(k) for k, v in FORM_VALUES.items() if state.get(k) != v}
            ok, detail = not wrong, f"wrong fields: {wrong}" if wrong else "all 7 fields read back"
        else:
            handle = await engine.open(meter, NEWS)
            await engine.click_new(meter, handle)
            await asyncio.sleep(1)  # navigation settles (not counted: no call)
            url = await engine.check(handle, "location.href")
            ok, detail = "/newest" in url, url
    except Exception as error:  # noqa: BLE001 - a failed task is a measured result, not a crash
        detail = f"{type(error).__name__}: {str(error)[:200]}"
    finally:
        if handle is not None:
            try:
                await engine.close(handle)
            except Exception:  # noqa: BLE001
                pass
    return {
        "task": name,
        "ok": ok,
        "detail": detail,
        "seconds": round(time.perf_counter() - started, 2),
        "calls": len(meter.calls),
        "chars": sum(c["chars"] for c in meter.calls),
        "tokens": sum(c["tokens"] for c in meter.calls),
        "steps": meter.calls,
    }


def servers(nexus_command: list[str]) -> dict[str, tuple[type[Engine], StdioServerParameters]]:
    npx = shutil.which("npx") or "npx"
    devtools = [
        "--yes",
        f"chrome-devtools-mcp@{DEVTOOLS_VERSION}",
        "--isolated",
        "--headless",
        "--no-usage-statistics",
        "--no-performance-crux",
    ]
    env = {**os.environ, "NEXUS_BROWSER_AGENT": "Bench"}
    return {
        "nexus": (Nexus, StdioServerParameters(command=nexus_command[0], args=nexus_command[1:], env=env)),
        "devtools": (DevTools, StdioServerParameters(command=npx, args=devtools, env=dict(os.environ))),
    }


async def run_engine(kind: type[Engine], params: StdioServerParameters, rounds: int) -> list[dict]:
    results = []
    async with AsyncExitStack() as stack:
        read, write = await stack.enter_async_context(stdio_client(params))
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        engine = kind(session)
        for round_index in range(rounds):
            for name in ("read", "form", "click"):
                result = await task(engine, name)
                result["round"] = round_index + 1
                results.append(result)
                print(
                    f"{engine.name:34} {name:6} round {round_index + 1}: "
                    f"{'ok ' if result['ok'] else 'FAIL'} {result['tokens']:>7} tokens {result['calls']} calls  "
                    f"{result['detail'][:80]}",
                    flush=True,
                )
    return results


def summary(engine: str, results: list[dict]) -> list[dict]:
    rows = []
    for name in ("read", "form", "click"):
        runs = [r for r in results if r["task"] == name]
        rows.append(
            {
                "engine": engine,
                "task": name,
                "success": f"{sum(r['ok'] for r in runs)}/{len(runs)}",
                "tokens_median": int(statistics.median(r["tokens"] for r in runs)),
                "calls_median": int(statistics.median(r["calls"] for r in runs)),
                "seconds_median": round(statistics.median(r["seconds"] for r in runs), 1),
            }
        )
    return rows


def markdown(rows: list[dict], meta: dict) -> str:
    lines = [
        f"# NexusBrowser benchmark, {meta['date']}",
        "",
        f"{meta['rounds']} rounds per task, tokens with the {meta['tokenizer']} tokenizer (proxy), "
        "tool responses only, medians.",
        "",
        "| Engine | Task | Success | Tokens | Calls | Seconds |",
        "| --- | --- | --- | ---: | ---: | ---: |",
    ]
    lines += [
        f"| {r['engine']} | {r['task']} | {r['success']} | {r['tokens_median']} | {r['calls_median']} | "
        f"{r['seconds_median']} |"
        for r in rows
    ]
    return "\n".join(lines) + "\n"


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--engines", default="nexus,devtools")
    parser.add_argument(
        "--nexus",
        default=f"{sys.executable} -B {ROOT / 'client' / 'mcp_server.py'}",
        help='command that starts the NexusBrowser MCP server (default: this checkout; "uvx nexus-browser" also works)',
    )
    parser.add_argument("--out", type=Path, help="folder for results-<date>.json and results-<date>.md")
    args = parser.parse_args()
    table = servers(args.nexus.split())
    all_results, rows = {}, []
    for key in args.engines.split(","):
        kind, params = table[key]
        results = await run_engine(kind, params, args.rounds)
        all_results[kind.name] = results
        rows += summary(kind.name, results)
    meta = {
        "date": dt.date.today().isoformat(),
        "rounds": args.rounds,
        "tokenizer": "o200k_base",
        "devtools_version": DEVTOOLS_VERSION,
        "nexus_version": (ROOT / "VERSION").read_text(encoding="utf-8").strip(),
        "tasks": {"read": ARTICLE, "form": FORM, "click": NEWS},
    }
    report = markdown(rows, meta)
    print("\n" + report)
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        stem = f"results-{meta['date']}"
        (args.out / f"{stem}.json").write_text(
            json.dumps({"meta": meta, "summary": rows, "runs": all_results}, indent=1), encoding="utf-8"
        )
        (args.out / f"{stem}.md").write_text(report, encoding="utf-8")
    return 0 if all(r["success"].split("/")[0] == r["success"].split("/")[1] for r in rows) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
