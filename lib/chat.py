#!/usr/bin/env python3
"""chat.py — a Claude Code conversation per stack folder, driven over pipes.

One `claude` process per stack, started in that stack's NK_DIR and kept alive:
`--input-format stream-json` takes a user turn per line, `--output-format
stream-json` gives back one NDJSON event per line, and `--permission-prompt-tool
stdio` turns every approval into a request on the same stream that somebody has
to answer. That last part is the point — the page shows the request and a person
presses Allow or Deny. Nothing here bypasses a permission check.

The session id is ours: one UUID per stack, kept in ~/.config/nk/chat, so the
conversation is the same one tomorrow and `claude --resume <id>` in a terminal
opens exactly what the page was showing.
"""
import json
import os
import queue
import subprocess
import threading
import time
import uuid
from pathlib import Path

HOME = Path(os.environ.get("NK_HOME") or (
    Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "nk"))
STATE = HOME / "chat"
KEEP = 400                      # events kept per session for a late viewer

# Permission modes this is willing to start with. bypassPermissions is
# deliberately absent: the console has no login, and a button that turns off
# every check does not belong behind no login.
MODES = ("manual", "acceptEdits", "auto", "plan")

# Model aliases, which track the newest model in each family rather than pinning
# a name that goes stale. "" means: pass no --model and take whatever the
# machine is configured for, which is not the same thing as "opus" — on this
# machine the configured default carries the 1M context window and the bare
# alias does not.
MODELS = ("", "opus", "sonnet", "haiku", "fable")


def load_state(name):
    """What is remembered about a stack's conversation between runs."""
    try:
        d = json.loads((STATE / f"{name}.json").read_text())
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(name, **fields):
    d = load_state(name)
    d.update(fields)
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / f"{name}.json").write_text(json.dumps(d))


def session_id(name, create=True):
    """(uuid, started) for a stack's conversation, minted on first ask.

    The id is ours rather than claude's so it is stable from the first turn:
    `claude --resume <id>` in a terminal opens exactly what the page shows.
    """
    d = load_state(name)
    sid = d.get("session")
    if not sid and create:
        sid = str(uuid.uuid4())
        save_state(name, session=sid, started=False)
        return sid, False
    return sid, bool(d.get("started"))


def find_claude():
    """The claude binary: an override, then PATH, then the usual install spots."""
    env = os.environ.get("NK_CLAUDE_BIN")
    if env and os.access(env, os.X_OK):
        return env
    from shutil import which
    found = which("claude")
    if found:
        return found
    cands = [Path.home() / ".local/bin/claude", Path.home() / ".claude/local/claude"]
    # The VS Code extension ships its own copy; the newest one wins, because the
    # directory name carries the version.
    for root in (Path.home() / ".vscode-server/extensions", Path.home() / ".vscode/extensions"):
        if root.is_dir():
            cands += sorted(root.glob("anthropic.claude-code-*/resources/native-binary/claude"),
                            reverse=True)
    for c in cands:
        if os.access(c, os.X_OK):
            return str(c)
    return None


class Session:
    """One live conversation. Events are numbered so a viewer can catch up."""

    def __init__(self, name, cwd, mode="manual", model=None):
        self.name, self.cwd, self.mode, self.model = name, cwd, mode, model
        self.proc = None
        self.events = []            # [(seq, obj)]
        self.seq = 0
        self.lock = threading.Lock()
        self.waiters = []           # queue per live viewer
        self.pending = {}           # request_id -> the tool request awaiting an answer
        self.busy = False           # a turn is in flight
        self.session_id = None
        self.cost = 0.0
        self.error = None

    # ---------------------------------------------------------- plumbing --
    def _emit(self, obj):
        with self.lock:
            self.seq += 1
            self.events.append((self.seq, obj))
            del self.events[:-KEEP]
            for q in self.waiters:
                try:
                    q.put_nowait((self.seq, obj))
                except queue.Full:
                    pass

    def _write(self, obj):
        if not self.proc or self.proc.poll() is not None:
            return False
        try:
            self.proc.stdin.write(json.dumps(obj) + "\n")
            self.proc.stdin.flush()
            return True
        except (BrokenPipeError, OSError):
            return False

    # ------------------------------------------------------------- start --
    def start(self):
        if self.proc and self.proc.poll() is None:
            return True, ""
        binary = find_claude()
        if not binary:
            self.error = "ไม่พบคำสั่ง claude — ตั้ง NK_CLAUDE_BIN ให้ชี้ไปที่ไฟล์"
            return False, self.error
        if self.mode not in MODES:
            self.mode = "manual"

        sid, started = session_id(self.name)
        self.session_id = sid

        args = [binary, "-p",
                "--output-format", "stream-json",
                "--input-format", "stream-json",
                "--verbose",
                "--permission-mode", self.mode,
                # Approvals come back on this stream for a person to answer.
                "--permission-prompt-tool", "stdio"]
        # A session that has run before is resumed; a fresh one is created under
        # the id we already chose, so the id is stable from the very first turn.
        args += ["--resume", sid] if started else ["--session-id", sid]
        if self.model:
            args += ["--model", self.model]

        try:
            self.proc = subprocess.Popen(
                args, cwd=self.cwd, text=True, bufsize=1,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as e:
            self.error = f"เริ่ม claude ไม่สำเร็จ: {e}"
            return False, self.error

        save_state(self.name, session=sid, started=True)
        self.error = None
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        self._emit({"type": "nk", "event": "started", "cwd": self.cwd,
                    "mode": self.mode, "session": sid})
        return True, ""

    def _read_stdout(self):
        proc = self.proc
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            self._on_event(obj)
        code = proc.wait()
        self.busy = False
        # Clear anything still waiting: nobody is left to answer it.
        self.pending.clear()
        self._emit({"type": "nk", "event": "exited", "code": code})

    def _read_stderr(self):
        proc = self.proc
        tail = []
        for line in proc.stderr:
            tail.append(line.rstrip())
            del tail[:-20]
        if tail:
            self.error = "\n".join(tail[-5:])

    def _on_event(self, obj):
        ty = obj.get("type")
        if ty == "system" and obj.get("subtype") == "init":
            self.session_id = obj.get("session_id") or self.session_id
        elif ty == "control_request":
            req = obj.get("request") or {}
            if req.get("subtype") == "can_use_tool":
                self.pending[obj.get("request_id")] = req
        elif ty == "rate_limit_event":
            info = obj.get("rate_limit_info")
            if isinstance(info, dict):
                _limits["info"], _limits["at"] = info, time.time()
        elif ty == "result":
            self.busy = False
            if isinstance(obj.get("total_cost_usd"), (int, float)):
                self.cost = obj["total_cost_usd"]
        self._emit(obj)

    # -------------------------------------------------------------- turns --
    def ask(self, text):
        ok, msg = self.start()
        if not ok:
            return False, msg
        if self.busy:
            return False, "กำลังตอบอยู่ — รอให้จบก่อน หรือกดหยุด"
        # Echoed back so every viewer sees the turn, including the tab that did
        # not send it.
        self._emit({"type": "nk", "event": "ask", "text": text, "at": time.time()})
        self.busy = True
        if not self._write({"type": "user", "message": {"role": "user", "content": text}}):
            self.busy = False
            return False, "ส่งข้อความไม่สำเร็จ — session ปิดไปแล้ว"
        return True, ""

    def answer(self, request_id, allow, note=""):
        """Answer one permission request. This is the only path to approval."""
        req = self.pending.pop(request_id, None)
        if req is None:
            return False, "ไม่มีคำขอนี้ค้างอยู่ (อาจตอบไปแล้ว หรือ session ปิด)"
        if allow:
            body = {"behavior": "allow", "updatedInput": req.get("input") or {}}
        else:
            body = {"behavior": "deny", "message": note or "ผู้ใช้ไม่อนุญาต"}
        ok = self._write({"type": "control_response", "response": {
            "subtype": "success", "request_id": request_id, "response": body}})
        if not ok:
            return False, "ตอบกลับไม่สำเร็จ — session ปิดไปแล้ว"
        self._emit({"type": "nk", "event": "answered", "request_id": request_id,
                    "allow": bool(allow)})
        return True, ""

    def configure(self, mode=None, model=None):
        """Set the permission mode or the model, and remember both.

        Both are fixed when the process starts, so the caller restarts the
        session; the conversation survives because its id does.
        """
        if mode in MODES:
            self.mode = mode
        if model is not None and model in MODELS:
            self.model = model
        save_state(self.name, mode=self.mode, model=self.model or "")

    def stop(self):
        p = self.proc
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        self.busy = False
        self.pending.clear()
        return True, ""

    # -------------------------------------------------------------- views --
    def running(self):
        return bool(self.proc) and self.proc.poll() is None

    def state(self):
        return {
            "stack": self.name, "cwd": self.cwd, "mode": self.mode,
            "running": self.running(), "busy": self.busy,
            "session": self.session_id, "cost": self.cost, "model": self.model or "",
            "seq": self.seq, "error": self.error,
            "pending": [{"id": k, **v} for k, v in self.pending.items()],
        }

    def backlog(self, since):
        with self.lock:
            return [e for e in self.events if e[0] > since]

    def watch(self):
        q = queue.Queue(maxsize=1000)
        with self.lock:
            self.waiters.append(q)
        return q

    def unwatch(self, q):
        with self.lock:
            if q in self.waiters:
                self.waiters.remove(q)


# How much of the account's allowance is gone. It is an account fact rather
# than a stack one, so the newest reading wins whichever conversation it came
# from. It rides along with every turn, which is the only reason this is here:
# there is no command that reports it, and asking for one would mean starting a
# turn to find out what a turn costs.
_limits = {"at": 0.0, "info": None}


def limits():
    return dict(_limits)


_sessions = {}
_lock = threading.Lock()


def session(name, cwd=None, mode=None, model=None):
    """The conversation for a stack, made on first use."""
    with _lock:
        s = _sessions.get(name)
        if s is None:
            if not cwd:
                return None
            # What was chosen last time, so a restart does not silently move
            # the conversation to a different model.
            kept = load_state(name)
            s = _sessions[name] = Session(name, cwd, mode or kept.get("mode") or "manual",
                                          model or kept.get("model") or None)
        if cwd:
            s.cwd = cwd
        if mode and mode in MODES and not s.running():
            s.mode = mode
        return s


def known():
    with _lock:
        return list(_sessions.values())


# The CLI side of this file: `nk chat` asks it where claude is and which
# conversation a stack owns, then runs claude itself.
if __name__ == "__main__":
    import sys
    argv = sys.argv[1:]
    if argv[:1] == ["--which"]:
        found = find_claude()
        print(found or "")
        sys.exit(0 if found else 1)
    if argv[:1] == ["--id"] and len(argv) > 1:
        sid, started = session_id(argv[1])
        print(sid, 1 if started else 0)
        sys.exit(0)
    if argv[:1] == ["--model"] and len(argv) > 1:
        print(load_state(argv[1]).get("model") or "")
        sys.exit(0)
    if argv[:1] == ["--started"] and len(argv) > 1:
        sid, _ = session_id(argv[1])
        save_session_id(argv[1], sid, True)
        sys.exit(0)
    print("ใช้: chat.py --which | --id <stack> | --model <stack> | --started <stack>", file=sys.stderr)
    sys.exit(2)
