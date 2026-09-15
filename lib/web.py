#!/usr/bin/env python3
"""nk web — a local dashboard for the nk stacks.

Binds to loopback only: the endpoints start and stop processes, so this must
never be reachable from the network. All state comes from the `nk` CLI itself,
which stays the single source of truth.
"""
import json
import os
import re
import shutil
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NK = str(ROOT / "bin" / "nk")
WEB = ROOT / "web"
STACK_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Strip the CLI's ANSI colouring; the browser renders its own.
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def run_nk(args, timeout=180):
    try:
        p = subprocess.run(
            [NK, *args],
            capture_output=True, text=True, timeout=timeout,
            cwd=os.environ.get("NK_CWD") or str(Path.home()),
        )
        return p.returncode, ANSI.sub("", p.stdout), ANSI.sub("", p.stderr)
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout: nk {' '.join(args)}"


class Handler(BaseHTTPRequestHandler):
    server_version = "nk-web"

    def log_message(self, fmt, *args):  # quieter than the default access log
        if os.environ.get("NK_WEB_VERBOSE"):
            super().log_message(fmt, *args)

    # ------------------------------------------------------------ helpers --
    def send(self, code, body, ctype="application/json; charset=utf-8"):
        raw = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def send_json(self, code, obj):
        self.send(code, json.dumps(obj))

    def stack_from(self, path, prefix):
        name = path[len(prefix):]
        if not STACK_RE.match(name):
            self.send_json(400, {"error": "ชื่อ stack ไม่ถูกต้อง"})
            return None
        return name

    # ----------------------------------------------------------------- GET --
    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path in ("/", "/index.html"):
            f = WEB / "index.html"
            return self.send(200, f.read_bytes(), "text/html; charset=utf-8")

        if path == "/api/stacks":
            rc, out, err = run_nk(["status", "--json"], timeout=30)
            if rc != 0:
                return self.send_json(500, {"error": err.strip() or "nk status ล้มเหลว"})
            try:
                return self.send_json(200, json.loads(out))
            except json.JSONDecodeError:
                return self.send_json(500, {"error": "nk status คืน JSON ไม่ถูกต้อง"})

        if path.startswith("/api/logs/"):
            name = self.stack_from(path, "/api/logs/")
            if not name:
                return
            rc, out, err = run_nk(["logs", name, "300"], timeout=30)
            return self.send_json(200, {"ok": rc == 0, "text": out or err})

        return self.send_json(404, {"error": "not found"})

    # ---------------------------------------------------------------- POST --
    def do_POST(self):
        path = self.path.split("?", 1)[0]
        for verb in ("up", "down", "restart"):
            prefix = f"/api/{verb}/"
            if path.startswith(prefix):
                name = self.stack_from(path, prefix)
                if not name:
                    return
                rc, out, err = run_nk([verb, name])
                return self.send_json(200, {
                    "ok": rc == 0,
                    "output": (out + err).strip() or f"nk {verb} {name} เสร็จแล้ว",
                })

        if path.startswith("/api/kill/"):
            port = path[len("/api/kill/"):]
            if not port.isdigit() or not (1 <= int(port) <= 65535):
                return self.send_json(400, {"error": "port ไม่ถูกต้อง"})
            rc, out, err = run_nk(["kill", port], timeout=60)
            return self.send_json(200, {"ok": rc == 0, "output": (out + err).strip()})

        return self.send_json(404, {"error": "not found"})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7777
    host = "127.0.0.1"
    if not shutil.which("tmux"):
        print("! ไม่พบ tmux — nk up จะใช้ไม่ได้", file=sys.stderr)
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"nk web → http://{host}:{port}  (ctrl-c เพื่อหยุด)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nหยุดแล้ว")
        srv.server_close()


if __name__ == "__main__":
    main()
