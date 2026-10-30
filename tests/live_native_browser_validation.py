"""Run the real Chrome mouse/full fixtures through the native MCP HTTP engine, on an isolated port.

Chrome and the installed shared MCP endpoint are kept open. Only fixture tabs are created and closed.
"""

from __future__ import annotations

import base64
import inspect
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import live_browser_validation as live  # noqa: E402
from test_native_csharp import _published_exe  # noqa: E402


def main() -> int:
    port = live.get_free_port()
    token = secrets.token_urlsafe(43)
    env = {**os.environ, "NEXUS_MCP_TOKEN": token}
    process = subprocess.Popen(
        [str(_published_exe()), "--http", str(port)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    endpoint = f"http://127.0.0.1:{port}/mcp?agent=codex"
    session = ""
    call_id = 0

    def rpc(method, params):
        nonlocal session, call_id
        call_id += 1
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        if session:
            headers["Mcp-Session-Id"] = session
        request = urllib.request.Request(
            endpoint,
            data=json.dumps({"jsonrpc": "2.0", "id": call_id, "method": method, "params": params}).encode(),
            headers=headers,
        )
        with urllib.request.urlopen(request, timeout=130) as response:
            session = response.headers.get("Mcp-Session-Id", session)
            result = json.load(response)
        if "error" in result:
            raise RuntimeError(result["error"])
        return result["result"]

    def tool_proxy(name, original):
        signature = inspect.signature(original)

        def invoke(*args, **kwargs):
            arguments = dict(signature.bind(*args, **kwargs).arguments)
            result = rpc("tools/call", {"name": name, "arguments": arguments})
            return next(block["text"] for block in result["content"] if block["type"] == "text")

        return invoke

    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                    health = json.load(response)
                    assert health["runtime"] == "native" and health["pid"] == process.pid
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("Native MCP HTTP did not start")
        rpc(
            "initialize",
            {
                "protocolVersion": "2026-07-28",
                "capabilities": {},
                "clientInfo": {"name": "native-live-validation", "version": "1"},
            },
        )
        live.bridge_client._SESSION_IDENTITY.set(live.bridge_client.session_identity("Codex", session))
        live.mcp.AGENT_NAME = "Codex"
        for name, original in list(vars(live.mcp).items()):
            if name.startswith("browser_") and callable(original):
                setattr(live.mcp, name, tool_proxy(name, original))
        live.preflight()
        results = {}
        if "--images-only" not in sys.argv:
            results.update({f"mouse:{k}": v for k, v in live.run_mouse_validation().items()})
            results.update({f"full:{k}": v for k, v in live.run_full_validation().items()})
        tab = None
        try:
            created = rpc(
                "tools/call",
                {
                    "name": "browser_new_tab",
                    "arguments": {
                        "url": "data:text/html;charset=utf-8,<title>Native image fixture</title><h1>Capture Nexus</h1>",
                        "background": True,
                    },
                },
            )
            tab = json.loads(created["content"][0]["text"])["data"]["id"]
            rpc("tools/call", {"name": "browser_wait_load", "arguments": {"tab_id": tab}})
            # Attaching Chrome's debugger shows an info bar and changes the viewport.
            # Activate rendering in this background fixture and await layout before comparing images.
            rpc("tools/call", {"name": "browser_scroll", "arguments": {"tab_id": tab, "y": 0}})
            rpc(
                "tools/call",
                {
                    "name": "browser_cdp_send",
                    "arguments": {
                        "tab_id": tab,
                        "method": "Runtime.evaluate",
                        "params": {
                            "expression": "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
                            "awaitPromise": True,
                        },
                    },
                },
            )

            def capture(name="browser_screenshot", **arguments):
                result = rpc("tools/call", {"name": name, "arguments": {"tab_id": tab, "inline": True, **arguments}})
                text = json.loads(result["content"][0]["text"])
                images = [block for block in result["content"] if block["type"] == "image"]
                return text, images

            text, images = capture()
            meta = text.get("data", {}).get("image", {})
            results["inline:webp_limits"] = (
                bool(images)
                and images[0]["mimeType"] == "image/webp"
                and len(base64.b64decode(images[0]["data"])) <= 500_000
                and max(meta.get("width", 9999), meta.get("height", 9999)) <= 2000
            )
            unchanged, images = capture()
            results["inline:unchanged"] = (
                unchanged.get("data", {}).get("image", {}).get("unchanged") is True and not images
            )
            if not results["inline:unchanged"]:
                print(json.dumps({"first_image": meta, "next_image": unchanged.get("data", {}).get("image")}))
            forced, images = capture(force=True)
            results["inline:force"] = forced.get("status") == "success" and bool(images)
            region, images = capture(region=[10, 10, 100, 100])
            results["inline:region"] = (
                region.get("status") == "success"
                and bool(images)
                and region["data"]["image"].get("css_origin", {}).get("x", 0) > 0
            )
            vision, images = capture("browser_vision_inspect")
            results["inline:vision"] = vision.get("status") == "success" and bool(images)
        finally:
            if tab:
                rpc("tools/call", {"name": "browser_close_tab", "arguments": {"tab_id": tab}})
        failed = [name for name, ok in results.items() if not ok]
        print(
            json.dumps({"engine": "native", "passed": sum(results.values()), "total": len(results), "failed": failed})
        )
        return int(bool(failed))
    finally:
        if session:
            request = urllib.request.Request(
                endpoint, method="DELETE", headers={"Authorization": f"Bearer {token}", "Mcp-Session-Id": session}
            )
            try:
                urllib.request.urlopen(request, timeout=3).close()
            except OSError:
                pass  # best effort: the daemon may already have dropped the session; terminate() follows
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


if __name__ == "__main__":
    raise SystemExit(main())
