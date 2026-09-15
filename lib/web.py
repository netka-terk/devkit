#!/usr/bin/env python3
"""D3v — the local web console for nk (served by `nk web` / `d3v`).

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
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
NK = str(ROOT / "bin" / "nk")
WEB = ROOT / "web"
STACK_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LABEL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")

# Stacks created from the UI land here. It outranks devkit/stacks in nk's
# search order, so editing a shipped stack saves a user override rather than
# rewriting a file that is under git.
USER_STACKS = Path(
    os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")
) / "nk" / "stacks"
LOG_DIR = Path(
    os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")
) / "nk" / "logs"


def sh_quote(v):
    """Single-quote a value for the generated stack file."""
    return "'" + str(v).replace("'", "'\\''") + "'"


def write_stack(spec, target=None, omit_dir=False):
    """Write a stack file from a UI spec. Returns (ok, message).

    Default target is the user directory. A project stack passes its own
    <root>/.nk/<name>.sh and omit_dir=True, since NK_DIR defaults to the
    project root there and an absolute path would tie the file to this box.
    """
    name = spec.get("name", "")
    if not STACK_RE.match(name):
        return False, "ชื่อ stack ใช้ได้เฉพาะ a-z A-Z 0-9 _ - (ไม่เกิน 64 ตัว)"

    d = os.path.expanduser(str(spec.get("dir", "")).strip())
    if not d:
        return False, "ต้องระบุ path"
    if not os.path.isdir(d):
        return False, f"ไม่มีไดเรกทอรี: {d}"

    panes = spec.get("panes") or []
    rows = []
    for item in panes:
        label = str(item.get("label", "")).strip() or "app"
        cmd = str(item.get("cmd", "")).strip()
        if not cmd:
            continue
        if not LABEL_RE.match(label):
            return False, f"ชื่อ pane ไม่ถูกต้อง: {label}"
        if "|" in label:
            return False, "ชื่อ pane ห้ามมี |"
        rows.append(f"  {sh_quote(label + '|' + cmd)}")
    if not rows:
        return False, "ต้องมีคำสั่งอย่างน้อย 1 บรรทัด"

    ports = str(spec.get("ports", "")).split()
    for pt in ports:
        if not pt.isdigit() or not (1 <= int(pt) <= 65535):
            return False, f"port ไม่ถูกต้อง: {pt}"

    body = [f"# {name} — สร้างจาก D3v ({time.strftime('%Y-%m-%d %H:%M')})"]
    if not omit_dir:
        body.append(f"NK_DIR={sh_quote(d)}")
    body += [
        f"NK_PORTS={sh_quote(' '.join(ports))}",
        f"NK_URL={sh_quote(str(spec.get('url', '')).strip())}",
        f"NK_NOTE={sh_quote(str(spec.get('note', '')).strip())}",
    ]
    env_file = str(spec.get("envFile", "")).strip()
    if env_file:
        body.append(f"NK_ENV_FILE={sh_quote(env_file)}")
    body.append("NK_PANES=(")
    body.extend(rows)
    body.append(")")

    out = Path(target) if target else USER_STACKS / f"{name}.sh"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(body) + "\n")
    return True, f"บันทึก {out} แล้ว"

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

        # Menu modules. Name is whitelisted, so no traversal out of web/modules.
        if path.startswith("/modules/"):
            name = path[len("/modules/"):]
            f = WEB / "modules" / name
            if re.match(r"^[A-Za-z0-9_-]+\.js$", name) and f.is_file():
                return self.send(200, f.read_bytes(), "application/javascript; charset=utf-8")
            return self.send_json(404, {"error": "not found"})

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

        if path.startswith("/api/stream/"):
            name = self.stack_from(path, "/api/stream/")
            if name:
                self.stream(name)
            return

        if path.startswith("/api/stack/"):
            name = self.stack_from(path, "/api/stack/")
            if not name:
                return
            return self.send_json(200, read_stack(name))

        if path == "/api/browse":
            q = parse_qs(urlparse(self.path).query)
            return self.send_json(200, browse(q.get("path", [str(Path.home())])[0]))

        return self.send_json(404, {"error": "not found"})

    # ------------------------------------------------------------- stream --
    def stream(self, name):
        """Server-sent events: tail every pane log of a stack.

        tmux pipe-pane mirrors each pane into a file as it runs, so this only
        has to follow the files — no periodic scrollback capture.
        """
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        handles = {}   # label -> (file object, path)
        try:
            deadline = time.time() + 3600
            while time.time() < deadline:
                for f in sorted(LOG_DIR.glob(f"{name}--*.log")):
                    label = f.name[len(name) + 2:-4]
                    if label not in handles:
                        fh = f.open("r", errors="replace")
                        handles[label] = fh
                        # Start from the tail so a fresh viewer is not flooded.
                        fh.seek(max(0, f.stat().st_size - 16384))
                        fh.readline() if fh.tell() else None
                    chunk = handles[label].read()
                    if chunk:
                        self.wfile.write(b"data: " + json.dumps(
                            {"pane": label, "text": chunk}).encode() + b"\n\n")
                        self.wfile.flush()
                if not handles:
                    self.wfile.write(b": waiting\n\n")
                    self.wfile.flush()
                time.sleep(0.4)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            for fh in handles.values():
                fh.close()

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

        if path == "/api/stack":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                spec = json.loads(self.rfile.read(length) or b"{}")
            except (ValueError, json.JSONDecodeError):
                return self.send_json(400, {"error": "body ไม่ใช่ JSON"})
            ok, msg = write_stack(spec)
            return self.send_json(200 if ok else 400,
                                  {"ok": ok, "output": msg} if ok else {"error": msg})

        if path.startswith("/api/promote/"):
            name = self.stack_from(path, "/api/promote/")
            if not name:
                return
            return self.send_json(*promote(name))

        if path.startswith("/api/adopt/"):
            name = self.stack_from(path, "/api/adopt/")
            if not name:
                return
            return self.send_json(*adopt_ports(name))

        if path.startswith("/api/kill/"):
            port = path[len("/api/kill/"):]
            if not port.isdigit() or not (1 <= int(port) <= 65535):
                return self.send_json(400, {"error": "port ไม่ถูกต้อง"})
            rc, out, err = run_nk(["kill", port], timeout=60)
            return self.send_json(200, {"ok": rc == 0, "output": (out + err).strip()})

        return self.send_json(404, {"error": "not found"})

    # -------------------------------------------------------------- DELETE --
    def do_DELETE(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/stack/"):
            name = self.stack_from(path, "/api/stack/")
            if not name:
                return
            f = USER_STACKS / f"{name}.sh"
            if not f.exists():
                return self.send_json(400, {
                    "error": "ลบได้เฉพาะ stack ที่สร้างจากหน้าเว็บ "
                             f"(ไม่มี {f})"})
            run_nk(["down", name], timeout=60)
            f.unlink()
            for log in LOG_DIR.glob(f"{name}--*.log"):
                log.unlink(missing_ok=True)
            return self.send_json(200, {"ok": True, "output": f"ลบ {name} แล้ว"})
        return self.send_json(404, {"error": "not found"})


def read_stack(name):
    """The editable fields of a stack, for the UI form."""
    rc, out, _ = run_nk(["show", name], timeout=20)
    if rc != 0:
        return {"error": "อ่าน stack ไม่ได้"}
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return {"error": "nk show คืน JSON ไม่ถูกต้อง"}
    data["editable"] = (USER_STACKS / f"{name}.sh").exists()
    return data


def promote(name):
    """Move a stack's definition into <its dir>/.nk so it travels with the repo.

    Writes the project file, registers the project so it is visible from
    anywhere, and removes the user copy that would otherwise shadow it. A
    shared (devkit) file is left alone — the project file outranks it.
    """
    spec = read_stack(name)
    if spec.get("error"):
        return 400, {"error": spec["error"]}
    if spec.get("origin") == "project":
        return 200, {"ok": True, "output": f"{name} เป็น project อยู่แล้ว ({spec['file']})"}
    root = Path(spec["dir"])
    if not root.is_dir():
        return 400, {"error": f"ไม่มีไดเรกทอรี {root}"}
    target = root / ".nk" / f"{name}.sh"
    if target.exists():
        return 400, {"error": f"มีอยู่แล้ว: {target} — ลบหรือแก้ไฟล์นั้นเอง"}
    ok, msg = write_stack(spec, target=target, omit_dir=True)
    if not ok:
        return 400, {"error": msg}
    run_nk(["project", "add", str(root)], timeout=20)
    user_copy = USER_STACKS / f"{name}.sh"
    if user_copy.exists():
        user_copy.unlink()
    git = (root / ".git").exists()
    return 200, {"ok": True, "output":
                 f"ย้ายไป {target} แล้ว" + (" — commit โฟลเดอร์ .nk/ เพื่อให้ทีมได้ด้วย" if git else ""),
                 "file": str(target)}


def adopt_ports(name):
    """Merge the ports a running stack was seen listening on into NK_PORTS.

    Goes through write_stack, so a shipped stack gets a user override rather
    than an edit to a file under git.
    """
    spec = read_stack(name)
    if spec.get("error"):
        return 400, {"error": spec["error"]}
    rc, out, err = run_nk(["ports", name], timeout=20)
    if rc != 0:
        return 400, {"error": err.strip() or "ตรวจ port ไม่ได้ — stack ต้องรันอยู่"}
    found = [line.split()[0] for line in out.splitlines() if line[:1].isdigit()]
    declared = spec.get("ports", "").split()
    merged = declared + [pt for pt in found if pt not in declared]
    if merged == declared:
        return 200, {"ok": True, "output": "ไม่มี port ใหม่ให้จำ"}
    spec["ports"] = " ".join(merged)
    ok, msg = write_stack(spec)
    if not ok:
        return 400, {"error": msg}
    return 200, {"ok": True, "output": f"จำ port {' '.join(pt for pt in found if pt not in declared)} ไว้แล้ว — รอบหน้าจะเคลียร์ให้ก่อนรัน",
                 "ports": spec["ports"]}


def browse(path):
    """Subdirectories of a path, so the UI can pick one without typing it."""
    try:
        d = Path(os.path.expanduser(path or str(Path.home()))).resolve()
        if not d.is_dir():
            d = Path.home()
        entries = sorted(
            (e.name for e in d.iterdir() if e.is_dir() and not e.name.startswith(".")),
            key=str.lower,
        )
    except (PermissionError, OSError) as e:
        return {"path": str(path), "parent": None, "dirs": [], "error": str(e)}
    return {
        "path": str(d),
        "parent": None if d == d.parent else str(d.parent),
        "dirs": entries[:400],
    }


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7777
    host = "127.0.0.1"
    if not shutil.which("tmux"):
        print("! ไม่พบ tmux — nk up จะใช้ไม่ได้", file=sys.stderr)
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"D3v by terk → http://{host}:{port}  (ctrl-c เพื่อหยุด)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nหยุดแล้ว")
        srv.server_close()


if __name__ == "__main__":
    main()
