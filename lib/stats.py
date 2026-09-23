#!/usr/bin/env python3
"""stats.py — one sample of what the machine, and each running stack, is using.

Run by `nk stats`, and through it by the D3v Performance page.

A sample is raw counters, never rates: the caller keeps the previous sample and
divides by the elapsed time. That keeps this stateless, makes one reading cost a
single /proc scan, and lets several readers sample at their own pace.

Attribution to a stack comes from tmux: every pane of an `nk-` session is a root,
and everything below it in the process tree is that pane's. So a stack's CPU is
what its commands and their children actually cost, not what the stack declared.
"""
import json
import os
import subprocess
import sys
import time

HZ = os.sysconf("SC_CLK_TCK")
PAGE = os.sysconf("SC_PAGE_SIZE")
PREFIX = "nk-"
# Interfaces and devices that would double-count or report traffic that never
# left the machine.
SKIP_IF = ("lo", "veth", "docker", "br-", "virbr", "tun", "tap")
SKIP_DEV = ("ram", "loop", "zram", "dm-", "sr")


def _read(path, default=""):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


def cpu_totals():
    """(busy, total) jiffies over every core. iowait counts as idle, as top does."""
    for line in _read("/proc/stat").splitlines():
        if line.startswith("cpu "):
            v = [int(x) for x in line.split()[1:]]
            idle = v[3] + (v[4] if len(v) > 4 else 0)
            return sum(v) - idle, sum(v)
    return 0, 0


def meminfo():
    want = {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}
    out = {}
    for line in _read("/proc/meminfo").splitlines():
        key, _, rest = line.partition(":")
        if key in want:
            out[key] = int(rest.split()[0]) * 1024
    return out


def processes():
    """{pid: (ppid, cpu_jiffies, rss_bytes)} for every process, in one scan."""
    procs = {}
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        raw = _read(entry.path + "/stat")
        # comm sits in parentheses and may contain spaces or ')', so the fields
        # after it are found from the LAST ')' rather than by splitting the line.
        close = raw.rfind(")")
        if close < 0:
            continue
        f = raw[close + 2:].split()
        if len(f) < 22:
            continue
        try:
            procs[int(entry.name)] = (int(f[1]), int(f[11]) + int(f[12]), int(f[21]) * PAGE)
        except ValueError:
            continue
    return procs


def disk_io():
    """(bytes read, bytes written) over the real block devices.

    /sys/block lists whole devices and not their partitions, which is what keeps
    sda and sda1 from being added together.
    """
    try:
        devs = {d for d in os.listdir("/sys/block") if not d.startswith(SKIP_DEV)}
    except OSError:
        devs = None
    read = written = 0
    for line in _read("/proc/diskstats").splitlines():
        f = line.split()
        if len(f) < 10:
            continue
        name = f[2]
        if devs is None:
            if name.startswith(SKIP_DEV):
                continue
        elif name not in devs:
            continue
        read += int(f[5]) * 512
        written += int(f[9]) * 512
    return read, written


def net_io():
    """(bytes in, bytes out) over the interfaces that reach outside this machine."""
    rx = tx = 0
    for line in _read("/proc/net/dev").splitlines()[2:]:
        name, _, rest = line.partition(":")
        name = name.strip()
        if not rest or name.startswith(SKIP_IF):
            continue
        f = rest.split()
        rx += int(f[0])
        tx += int(f[8])
    return rx, tx


def tmux_panes():
    """{stack: [(label, pane pid)]} for every running nk session."""
    fmt = "#{session_name}\t#{pane_pid}\t#{@nk_label}\t#{pane_title}"
    try:
        out = subprocess.run(["tmux", "list-panes", "-a", "-F", fmt],
                             capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    stacks = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 4 or not parts[0].startswith(PREFIX) or not parts[1].isdigit():
            continue
        # The label is the pane option nk sets; the title is the fallback for a
        # session started before that existed, and programs overwrite it.
        stacks.setdefault(parts[0][len(PREFIX):], []).append((parts[2] or parts[3], int(parts[1])))
    return stacks


def subtree(procs, children, root):
    """Every live pid under root, root included. Guarded against a pid cycle."""
    seen, pending = set(), [root]
    while pending:
        pid = pending.pop()
        if pid in seen or pid not in procs:
            continue
        seen.add(pid)
        pending.extend(children.get(pid, ()))
    return seen


def sample():
    procs = processes()
    children = {}
    for pid, (ppid, _, _) in procs.items():
        children.setdefault(ppid, []).append(pid)

    busy, total = cpu_totals()
    mem = meminfo()
    read, written = disk_io()
    rx, tx = net_io()
    try:
        fs = os.statvfs(os.path.expanduser("~"))
        fs_total, fs_free = fs.f_blocks * fs.f_frsize, fs.f_bavail * fs.f_frsize
    except OSError:
        fs_total = fs_free = 0

    stacks = []
    for name, panes in sorted(tmux_panes().items()):
        rows, cpu, rss, n = [], 0, 0, 0
        for label, pid in panes:
            pids = subtree(procs, children, pid)
            p_cpu = sum(procs[p][1] for p in pids)
            p_rss = sum(procs[p][2] for p in pids)
            rows.append({"label": label, "pid": pid, "cpu": p_cpu, "rss": p_rss, "procs": len(pids)})
            cpu += p_cpu
            rss += p_rss
            n += len(pids)
        stacks.append({"name": name, "cpu": cpu, "rss": rss, "procs": n, "panes": rows})

    return {
        "t": time.time(),
        "cores": os.cpu_count() or 1,
        "hz": HZ,
        "cpu": {"busy": busy, "total": total},
        "mem": {"total": mem.get("MemTotal", 0), "available": mem.get("MemAvailable", 0),
                "swapTotal": mem.get("SwapTotal", 0), "swapFree": mem.get("SwapFree", 0)},
        "load": [float(x) for x in _read("/proc/loadavg", "0 0 0").split()[:3]],
        "uptime": float((_read("/proc/uptime", "0").split() or ["0"])[0]),
        "procs": len(procs),
        "disk": {"read": read, "written": written},
        "net": {"rx": rx, "tx": tx},
        "fs": {"total": fs_total, "free": fs_free},
        "stacks": stacks,
    }


# ------------------------------------------------------------------ human ----

def human_bytes(n):
    for unit in ("B", "kB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def rates(a, b):
    """The percentages and per-second rates between two samples."""
    dt = max(1e-6, b["t"] - a["t"])
    dtot = b["cpu"]["total"] - a["cpu"]["total"]
    cpu = 100.0 * (b["cpu"]["busy"] - a["cpu"]["busy"]) / dtot if dtot > 0 else 0.0
    # A stack's share of the whole machine, so the stacks and the host tile are
    # on one scale: jiffies -> seconds of CPU, over the seconds every core had.
    def share(j):
        return 100.0 * (j / b["hz"]) / (dt * b["cores"])
    prev = {s["name"]: s for s in a["stacks"]}
    stacks = []
    for s in b["stacks"]:
        was = prev.get(s["name"])
        panes = []
        for p in s["panes"]:
            old = next((x for x in (was or {}).get("panes", []) if x["label"] == p["label"]), None)
            panes.append({**p, "cpuPct": share(max(0, p["cpu"] - old["cpu"])) if old else 0.0})
        stacks.append({**s, "panes": panes,
                       "cpuPct": share(max(0, s["cpu"] - was["cpu"])) if was else 0.0})
    return {
        "cpu": cpu, "dt": dt, "stacks": stacks,
        "diskRead": (b["disk"]["read"] - a["disk"]["read"]) / dt,
        "diskWrite": (b["disk"]["written"] - a["disk"]["written"]) / dt,
        "netRx": (b["net"]["rx"] - a["net"]["rx"]) / dt,
        "netTx": (b["net"]["tx"] - a["net"]["tx"]) / dt,
    }


def main():
    if "--json" in sys.argv[1:]:
        json.dump(sample(), sys.stdout)
        print()
        return 0

    a = sample()
    time.sleep(0.5)
    b = sample()
    r = rates(a, b)
    used = b["mem"]["total"] - b["mem"]["available"]
    up = int(b["uptime"])
    print(f"CPU     {r['cpu']:5.1f}%  ({b['cores']} cores, load {b['load'][0]:.2f})")
    print(f"RAM     {human_bytes(used)} / {human_bytes(b['mem']['total'])}"
          f"  ({100 * used / max(1, b['mem']['total']):.0f}%)")
    print(f"Disk    read {human_bytes(r['diskRead'])}/s  write {human_bytes(r['diskWrite'])}/s"
          f"  (ว่าง {human_bytes(b['fs']['free'])})")
    print(f"Net     in {human_bytes(r['netRx'])}/s  out {human_bytes(r['netTx'])}/s")
    print(f"Uptime  {up // 3600}h {up % 3600 // 60}m  ({b['procs']} processes)")
    if not r["stacks"]:
        print("\nไม่มี stack รันอยู่")
        return 0
    print(f"\n{'STACK':<14}{'PANE':<14}{'CPU':>7}{'RAM':>11}{'PROC':>6}")
    for s in sorted(r["stacks"], key=lambda x: -x["cpuPct"]):
        print(f"{s['name']:<14}{'':<14}{s['cpuPct']:6.1f}%{human_bytes(s['rss']):>11}{s['procs']:>6}")
        for p in sorted(s["panes"], key=lambda x: -x["cpuPct"]):
            print(f"{'':<14}{p['label']:<14}{p['cpuPct']:6.1f}%{human_bytes(p['rss']):>11}{p['procs']:>6}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
