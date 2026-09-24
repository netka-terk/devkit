#!/usr/bin/env python3
"""D3v — the local web console for nk (served by `nk web` / `d3v`).

Binds to loopback only: the endpoints start and stop processes, so this must
never be reachable from the network. All state comes from the `nk` CLI itself,
which stays the single source of truth.
"""
import atexit
import json
import os
import queue
import signal
import re
import shutil
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chat  # noqa: E402  (same directory, not a package)

ROOT = Path(__file__).resolve().parent.parent
NK = str(ROOT / "bin" / "nk")
WEB = ROOT / "web"
STACK_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LABEL_RE = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")

# The one place stacks live (same default as nk's NK_STACKS_DIR).
STACKS_DIR = Path(os.environ.get("NK_STACKS_DIR") or (
    Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "nk" / "stacks"))
LOG_DIR = Path(
    os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")
) / "nk" / "logs"


def sh_quote(v):
    """Single-quote a value for the generated stack file."""
    return "'" + str(v).replace("'", "'\\''") + "'"


def render_stack(spec):
    """Validate a UI spec and build the stack file text. Returns (ok, text-or-message)."""
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

    body = [
        f"# {name} — สร้างจาก D3v ({time.strftime('%Y-%m-%d %H:%M')})",
        f"NK_DIR={sh_quote(d)}",
        f"NK_PORTS={sh_quote(' '.join(ports))}",
        f"NK_URL={sh_quote(str(spec.get('url', '')).strip())}",
        f"NK_NOTE={sh_quote(str(spec.get('note', '')).strip())}",
    ]
    # Optional fields are written only when set. apiBase and tokenCmd are what
    # nk curl / nk token read; the editor carries them so saving from the page
    # cannot silently drop them from a stack that had them.
    for key, var in (("envFile", "NK_ENV_FILE"), ("apiBase", "NK_API_BASE"), ("tokenCmd", "NK_TOKEN_CMD")):
        v = str(spec.get(key) or "").strip()
        if v:
            body.append(f"{var}={sh_quote(v)}")
    body.append("NK_PANES=(")
    body.extend(rows)
    body.append(")")
    return True, "\n".join(body) + "\n"


def write_stack(spec):
    """Write <name>.sh from a UI spec. Returns (ok, message)."""
    ok, text = render_stack(spec)
    if not ok:
        return False, text
    out = STACKS_DIR / f"{spec['name']}.sh"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    return True, f"บันทึก {out} แล้ว"

# Strip the CLI's ANSI colouring; the browser renders its own.
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def run_nk(args, timeout=180, stdin=None):
    try:
        p = subprocess.run(
            [NK, *args],
            input=stdin, capture_output=True, text=True, timeout=timeout,
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

    def read_json(self):
        """The request body as an object, or None (a reply is already sent)."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "body ไม่ใช่ JSON"})
            return None

    def chat_session(self, path, prefix, make=True):
        """The conversation for the stack named in the path, if there is one."""
        name = self.stack_from(path, prefix)
        if not name:
            return None
        spec = read_stack(name)
        if spec.get("error") or not spec.get("dir"):
            self.send_json(404, {"error": spec.get("error") or f"ไม่รู้จัก stack {name}"})
            return None
        s = chat.session(name, spec["dir"]) if make else chat.session(name)
        if s is None:
            self.send_json(404, {"error": "ยังไม่มีห้องแชทของ stack นี้"})
        return s

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

        if path == "/api/stats":
            rc, out, err = run_nk(["stats", "--json"], timeout=15)
            if rc != 0:
                return self.send_json(500, {"error": err.strip() or "nk stats ล้มเหลว"})
            try:
                return self.send_json(200, json.loads(out))
            except json.JSONDecodeError:
                return self.send_json(500, {"error": "nk stats คืน JSON ไม่ถูกต้อง"})

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

        if path.startswith("/api/chat/"):
            s = self.chat_session(path, "/api/chat/")
            return self.send_json(200, {**s.state(), "claude": bool(chat.find_claude()),
                                        "modes": list(chat.MODES),
                                        "models": list(chat.MODELS)}) if s else None

        if path.startswith("/api/chatstream/"):
            s = self.chat_session(path, "/api/chatstream/")
            if s:
                q = parse_qs(urlparse(self.path).query)
                try:
                    since = int(q.get("since", ["0"])[0])
                except ValueError:
                    since = 0
                self.chat_stream(s, since)
            return

        if path.startswith("/api/chatimg/"):
            parts = path[len("/api/chatimg/"):].split("/")
            if len(parts) != 2 or not STACK_RE.match(parts[0]):
                return self.send_json(404, {"error": "not found"})
            found = chat.image_path(parts[0], parts[1])
            if not found:
                return self.send_json(404, {"error": "not found"})
            f, ctype = found
            return self.send(200, f.read_bytes(), ctype)

        if path == "/api/usage":
            return self.send_json(200, chat.limits())

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

        handles = {}   # label -> open file
        event = lambda obj: self.wfile.write(b"data: " + json.dumps(obj).encode() + b"\n\n")

        def opened(f, from_tail):
            fh = f.open("r", errors="replace")
            if from_tail:
                # Start from the tail so a fresh viewer is not flooded.
                fh.seek(max(0, f.stat().st_size - 16384))
                fh.readline() if fh.tell() else None
            return fh

        try:
            deadline = time.time() + 3600
            last_write = 0.0
            while time.time() < deadline:
                seen = set()
                for f in sorted(LOG_DIR.glob(f"{name}--*.log")):
                    label = f.name[len(name) + 2:-4]
                    seen.add(label)
                    fh = handles.get(label)
                    if fh is None:
                        try:
                            fh = handles[label] = opened(f, from_tail=True)
                        except OSError:
                            continue        # gone between glob and open (nk up mid-way)
                    else:
                        # `nk up` deletes and recreates the log (new inode), and a
                        # truncation means the same. Either way the pane started
                        # over: reopen from the top and tell the page to clear.
                        try:
                            st = f.stat()
                            rotated = st.st_ino != os.fstat(fh.fileno()).st_ino or st.st_size < fh.tell()
                        except (OSError, ValueError):
                            rotated = True
                        if rotated:
                            fh.close()
                            handles.pop(label)
                            try:
                                fh = handles[label] = opened(f, from_tail=False)
                            except OSError:
                                continue
                            event({"pane": label, "reset": True})
                            last_write = time.time()
                    chunk = fh.read()
                    if chunk:
                        event({"pane": label, "text": chunk})
                        self.wfile.flush()
                        last_write = time.time()
                # A pane whose log vanished (stack deleted) is dropped, not tailed forever.
                for label in [l for l in handles if l not in seen]:
                    handles.pop(label).close()
                # A comment keeps the connection honest: a viewer that navigated
                # away is noticed within seconds instead of holding a thread until
                # the pane next prints.
                if time.time() - last_write > 5:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_write = time.time()
                time.sleep(0.4)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            for fh in handles.values():
                fh.close()

    # ----------------------------------------------------------- chat SSE --
    def chat_stream(self, session, since):
        """Every event of one conversation, from `since` onwards and then live."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        q = session.watch()
        try:
            # The backlog first, so a tab that joins late sees the conversation
            # rather than only what happens after it arrived.
            for seq, obj in session.backlog(since):
                self.wfile.write(b"data: " + json.dumps({"seq": seq, "ev": obj}).encode() + b"\n\n")
            self.wfile.flush()
            deadline = time.time() + 3600
            while time.time() < deadline:
                try:
                    seq, obj = q.get(timeout=5)
                    self.wfile.write(b"data: " + json.dumps({"seq": seq, "ev": obj}).encode() + b"\n\n")
                except queue.Empty:
                    # A comment every few seconds, so a tab that went away is
                    # noticed instead of holding a thread for an hour.
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            session.unwatch(q)

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

        if path.startswith("/api/send/"):
            name = self.stack_from(path, "/api/send/")
            if not name:
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
            except (ValueError, json.JSONDecodeError):
                return self.send_json(400, {"error": "body ไม่ใช่ JSON"})
            pane = str(body.get("pane", ""))
            if not LABEL_RE.match(pane):
                return self.send_json(400, {"error": "ชื่อ pane ไม่ถูกต้อง"})
            if "key" in body:
                args = ["send", name, pane, "--key", str(body["key"])]
            else:
                text = str(body.get("text", ""))
                if not text or len(text) > 4096:
                    return self.send_json(400, {"error": "ข้อความว่างหรือยาวเกินไป"})
                args = ["send", name, pane, "--text", text]
            rc, out, err = run_nk(args, timeout=20)
            return self.send_json(200 if rc == 0 else 400,
                                  {"ok": True} if rc == 0 else {"error": (err or out).strip()})

        if path.startswith("/api/chat/"):
            s = self.chat_session(path, "/api/chat/")
            if not s:
                return
            body = self.read_json()
            if body is None:
                return
            text = str(body.get("text", "")).strip()
            images = body.get("images") or []
            if not isinstance(images, list) or len(images) > chat.IMG_PER_TURN:
                return self.send_json(400, {"error": "แนบภาพได้ไม่เกิน 6 ภาพต่อครั้ง"})
            if (not text and not images) or len(text) > 100000:
                return self.send_json(400, {"error": "ข้อความว่างหรือยาวเกินไป"})
            ok, msg = s.ask(text, images)
            return self.send_json(200 if ok else 400, {"ok": True} if ok else {"error": msg})

        if path.startswith("/api/chatperm/"):
            s = self.chat_session(path, "/api/chatperm/", make=False)
            if not s:
                return
            body = self.read_json()
            if body is None:
                return
            # Allow has to be said in so many words; anything else is a deny.
            ok, msg = s.answer(str(body.get("id", "")), body.get("allow") is True,
                               str(body.get("note", ""))[:200])
            return self.send_json(200 if ok else 400, {"ok": True} if ok else {"error": msg})

        if path.startswith("/api/chatstop/"):
            s = self.chat_session(path, "/api/chatstop/", make=False)
            if not s:
                return
            s.stop()
            return self.send_json(200, {"ok": True})

        if path.startswith("/api/chatopts/"):
            s = self.chat_session(path, "/api/chatopts/")
            if not s:
                return
            body = self.read_json()
            if body is None:
                return
            mode, model = body.get("mode"), body.get("model")
            if mode is not None and mode not in chat.MODES:
                return self.send_json(400, {"error": "โหมดไม่ถูกต้อง"})
            if model is not None and model not in chat.MODELS:
                return self.send_json(400, {"error": "รุ่นไม่ถูกต้อง"})
            # Both are fixed when the process starts, so changing either
            # restarts the session; the conversation is kept by its id.
            s.stop()
            s.configure(mode, model)
            ok, msg = s.start()
            return self.send_json(200 if ok else 400,
                                  {"ok": True, "mode": s.mode, "model": s.model or ""} if ok else {"error": msg})

        if path == "/api/stack":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                spec = json.loads(self.rfile.read(length) or b"{}")
            except (ValueError, json.JSONDecodeError):
                return self.send_json(400, {"error": "body ไม่ใช่ JSON"})
            ok, msg = render_stack(spec)
            if not ok:
                return self.send_json(400, {"error": msg})
            prev = str(spec.get("prev") or "")
            if prev and prev != spec.get("name"):
                # Renaming is nk's job (file + pane logs + secret, refuses while
                # running). The spec was validated first, so a rename is never
                # followed by a failed write.
                if not STACK_RE.match(prev):
                    return self.send_json(400, {"error": "ชื่อเดิมไม่ถูกต้อง"})
                rc, out, err = run_nk(["rename", prev, str(spec.get("name", ""))], timeout=20)
                if rc != 0:
                    return self.send_json(400, {"error": (err or out).strip()})
            ok, msg = write_stack(spec)
            if not ok:
                return self.send_json(400, {"error": msg})
            # The sudo password is never part of the stack file: nk keeps it in
            # its own 0600 file, and it is read from stdin so it stays out of
            # any process list.
            name = str(spec.get("name", ""))
            if spec.get("clearSudo"):
                run_nk(["secret", name, "clear"], timeout=20)
            elif spec.get("sudoPassword"):
                rc, out, err = run_nk(["secret", name, "set"], timeout=20,
                                      stdin=str(spec["sudoPassword"]))
                if rc != 0:
                    return self.send_json(400, {"error": (err or out).strip()})
            return self.send_json(200, {"ok": True, "output": msg})

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
            f = STACKS_DIR / f"{name}.sh"
            if not f.exists():
                return self.send_json(404, {"error": f"ไม่มี stack {name}"})
            run_nk(["down", name], timeout=60)
            # The password file is nk's; it must not outlive the stack.
            run_nk(["secret", name, "clear"], timeout=20)
            f.unlink()
            for log in LOG_DIR.glob(f"{name}--*.log"):
                log.unlink(missing_ok=True)
            return self.send_json(200, {"ok": True, "output": f"ลบ {name} แล้ว"})
        return self.send_json(404, {"error": "not found"})


def read_stack(name):
    """A stack as the editor form needs it."""
    rc, out, _ = run_nk(["show", name], timeout=20)
    if rc != 0:
        return {"error": "อ่าน stack ไม่ได้"}
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return {"error": "nk show คืน JSON ไม่ถูกต้อง"}
    return data


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


def shutdown_chats(*_):
    """The chat sessions are our child processes; they go when we do."""
    for s in chat.known():
        s.stop()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7777
    host = "127.0.0.1"
    if not shutil.which("tmux"):
        print("! ไม่พบ tmux — nk up จะใช้ไม่ได้", file=sys.stderr)
    # Ctrl-C is one way this ends; `nk down`, a reboot or a stray kill is
    # another, and a claude left holding a terminal is nobody's idea of tidy.
    atexit.register(shutdown_chats)
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"D3v by terk → http://{host}:{port}  (ctrl-c เพื่อหยุด)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nหยุดแล้ว")
        shutdown_chats()
        srv.server_close()


if __name__ == "__main__":
    main()
