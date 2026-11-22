#!/usr/bin/env python3
"""OpenAI-compatible local proxy backed by the OpenCode CLI.

Why: opencode's free models only answer inside the OpenCode client (raw HTTP
returns FreeUsageLimitError), so anything that speaks OpenAI needs this bridge.
DSH (Settings -> Models -> custom provider) or any other tool can point at
http://127.0.0.1:8788/v1 with a dummy key.

Supports /v1/models and /v1/chat/completions (stream and non-stream).
Tool calling is not translated: requests' `tools` are dropped and the model is
told to answer in text.
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
ENV_FILE = os.path.join(HOME, ".dsh", "sector-board", "robot.env")
DEFAULT_BIN = "/Applications/OpenCode.app/Contents/Resources/opencode-cli"
DEFAULT_MODEL = "opencode/deepseek-v4.1-flash-free"
PORT = int(os.environ.get("OPENCODE_PROXY_PORT", "8788"))
MAX_PROMPT_CHARS = 14000
TIMEOUT = 240

CLI_LOCK = threading.Lock()


def load_env_file(path: str) -> None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    except FileNotFoundError:
        pass


def run_model(prompt: str) -> str:
    exe = os.environ.get("OPENCODE_BIN") or DEFAULT_BIN
    model = os.environ.get("OPENCODE_MODEL") or DEFAULT_MODEL
    cmd = [exe, "run"]
    if model:
        cmd += ["--model", model]
    cmd.append(prompt)
    sandbox = tempfile.mkdtemp(prefix="opencode-proxy-")
    with CLI_LOCK:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=TIMEOUT, cwd=sandbox)
    out = (proc.stdout or "").strip()
    if proc.returncode != 0 or not out:
        err = (proc.stderr or "").strip()[:400]
        raise RuntimeError(f"opencode failed rc={proc.returncode}: {err or out[:200]}")
    # Strip the CLI's leading banner lines if present.
    lines = out.splitlines()
    while lines and (lines[0].startswith(">") or lines[0].startswith("Build") or not lines[0].strip()):
        lines.pop(0)
    return "\n".join(lines).strip() or out


def flatten(messages) -> str:
    parts = []
    for m in messages or []:
        role = str(m.get("role", "user"))
        content = m.get("content")
        if isinstance(content, list):
            content = "\n".join(str(c.get("text", c)) if isinstance(c, dict) else str(c) for c in content)
        text = str(content or "").strip()
        if not text:
            continue
        label = {"system": "系统", "developer": "系统", "assistant": "助手"}.get(role, "用户")
        parts.append(f"[{label}] {text}")
    prompt = "\n\n".join(parts)
    prompt += "\n\n（只输出回答正文，不要输出工具调用；当前环境没有工具。）"
    return prompt[:MAX_PROMPT_CHARS]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _json(self, code: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            return self._json(200, {
                "object": "list",
                "data": [{
                    "id": os.environ.get("OPENCODE_MODEL") or DEFAULT_MODEL,
                    "object": "model",
                    "owned_by": "opencode-cli",
                }],
            })
        if self.path.rstrip("/") in ("/health", "/"):
            return self._json(200, {"ok": True})
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/chat/completions", "/chat/completions"):
            return self._json(404, {"error": {"message": "not found"}})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:
            return self._json(400, {"error": {"message": f"bad json: {exc}"}})

        prompt = flatten(payload.get("messages"))
        stream = bool(payload.get("stream"))
        model = payload.get("model") or os.environ.get("OPENCODE_MODEL") or DEFAULT_MODEL
        cid = "chatcmpl-local"
        created = int(time.time())

        if not stream:
            try:
                text = run_model(prompt)
            except Exception as exc:
                return self._json(502, {"error": {"message": str(exc)}})
            return self._json(200, {
                "id": cid, "object": "chat.completion", "created": created, "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                             "finish_reason": "stop"}],
                "usage": {"prompt_tokens": len(prompt) // 3, "completion_tokens": len(text) // 3,
                          "total_tokens": (len(prompt) + len(text)) // 3},
            })

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(obj) -> None:
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()

        try:
            emit({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                  "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})
            text = run_model(prompt)
            for i in range(0, len(text), 120):
                emit({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                      "choices": [{"index": 0, "delta": {"content": text[i:i + 120]},
                                   "finish_reason": None}]})
            emit({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                  "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except Exception as exc:
            try:
                emit({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                      "choices": [{"index": 0, "delta": {"content": f"[proxy error] {exc}"},
                                   "finish_reason": "stop"}]})
                self.wfile.write(b"data: [DONE]\n\n")
            except Exception:
                pass


def main() -> None:
    load_env_file(ENV_FILE)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(f"opencode proxy listening on http://127.0.0.1:{PORT}/v1 "
          f"(model {os.environ.get('OPENCODE_MODEL') or DEFAULT_MODEL})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
