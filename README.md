# D3v by terk

Local dev tooling: the `nk` CLI and the D3v web console on top of it. Lives in
git so scripts stop disappearing into per-session scratchpad directories.

## nk — stack runner

Works in any project. Every `nk up` frees the stack's ports first, which
removes the `make run` → error → `lsof -i :PORT` → `kill -9` → `make run` loop.

    nk up grafana          # free port 3000, start `make run` + `yarn start` in tmux
    nk restart corr
    nk status              # what's up, who holds which port
    nk attach mdm
    nk logs corr 100
    nk down all
    nk kill 3000           # free a port without touching a stack
    nk ports grafana       # what the running stack actually listens on

    nk init                # scaffold .nk/<name>.sh for the current project
    nk list                # stacks visible from here, and where each came from
    nk web                 # dashboard on http://127.0.0.1:7777

    nk token mdm           # cached token from the stack's NK_TOKEN_CMD
    nk curl /api/health
    nk curl -s mdm POST /api/v1/hosts/1/remote-sessions
    nk mk -s mdm remote-session HOST=1

## D3v console

    d3v                    # same as: nk web [port]   (default 7777)

D3v is a shell with menus; each menu is one file in `web/modules/` that calls
`D3v.register({ id, label, icon, mount(el, param), unmount, refresh, navigate })`.
The shell owns the brand, the menu bar, theme, language (TH/EN, remembered),
the refresh button, toasts, a hash router (`#/<menu>/<param>`) and the `1..9`
keys to switch menus. Adding a menu is adding a file and one `<script src>`
line in `web/index.html`.

Strings go through `D3v.t('key', vars)`; the dictionary in the shell holds Thai
and English side by side, and a module's `labelKey` names its menu entry.
Switching language remounts the current menu, so nothing needs its own
re-render logic. Replies from `nk` itself are shown as sent (Thai).

Menus today:

- **Stacks** — the nk console: define, run, stop, watch.
- **Ports** — every port the stacks declare or were seen using, who holds it
  now, conflicts between stacks, and a clear button for anything held outside nk.

Stacks in detail:

- **Define a stack from the page**: name, a path (with a directory picker), one
  or more commands, and the ports to free first. Edit, rename (while stopped)
  and delete work on every stack alike.
- **Run it**: up, restart, down, and freeing an individual port, over live status.
- **Port discovery**: while a stack runs, nk walks the process tree under each
  tmux pane and asks `lsof` what it listens on. Ports that `NK_PORTS` omits show
  up tagged "เจอตอนรัน" with a one-click "จำไว้" that saves them, so the next
  `nk up` frees them first. `nk ports <stack>` and `nk status` show the same.
- **Live terminal**: `nk up` points `tmux pipe-pane` at a file per pane, and the
  page streams those over SSE with ANSI colour, one terminal panel per pane.
  Output is not polled.
- **Board layout**: the stack page is a 12-column grid. Every panel — ports,
  commands, each pane's terminal — drags by its header and resizes from its
  corner, neighbours reflow around it, and the layout is remembered per stack.
  The grid button in the header resets it.

Loopback only: the endpoints start and stop processes, there is no auth, and it
must not be exposed. Stacks resolve from the directory `nk web` was started in,
so a project's `.nk/` stacks show up.

## Where stacks live

One directory: `~/.config/nk/stacks/` (override with `NK_STACKS_DIR`). One
`.sh` file per stack; `nk list` shows exactly what is in that folder. The
console reads and writes the same files, so there is nothing to shadow or
override. `examples/` holds the stacks this checkout ships with — `install.sh`
copies any that are missing, once, and never overwrites.

    nk init [name]           # scaffold a stack for the current folder (git root if in a repo)
    nk rename old new        # rename a stopped stack (file + pane logs)

## Stack file contract

    NK_DIR="$HOME/nkss"       # optional inside .nk/ (defaults to project root)
    NK_PORTS="443 8443"       # freed before start, checked by nk status
    NK_URL="https://mdm.local"
    NK_API_BASE="https://mdm.local"     # optional: base for nk curl
    NK_TOKEN_CMD="make -s admin-token"  # optional: how nk token mints one
    NK_ENV_FILE=".env"                  # optional: sourced before each pane
    NK_PANES=(                          # required: one tmux pane each
      "nksmdm|make run-nksmdm"
    )
    NK_NOTE="..."                       # optional: printed after start

`bin/nk` needs no changes to gain a stack.

## Example stacks (`examples/`)

| example | repo                | ports     |
|---------|---------------------|-----------|
| grafana | `~/grafana`         | 3000      |
| corr    | `~/nlg-correlation` | 3080      |
| mdm     | `~/nkss` (nksmdm)   | 443, 8443 |
| glx     | `~/nkss` (nksglx)   | 3000      |

`grafana` and `glx` both bind 3000, so `nk up` stops one before starting the
other instead of leaving a port conflict behind.

## Testing the page

`web/index.html` has no build step, so a syntax check proves nothing about
whether the buttons are wired. `test/dom.mjs` loads the real page in jsdom,
clicks the real buttons, and asserts the request each click should make:

    npm install jsdom@24        # once, anywhere on the path
    node test/dom.mjs

## Install

    ./install.sh && exec bash

## Notes

- Panes run under `bash -ic`: `~/.bashrc` returns early for non-interactive
  shells, and that is where nvm (node/yarn) is set up.
- A pane keeps its shell after the process exits, so a crash stays readable.
- `mdm` binds 443 via `sudo setcap` during `make build-nksmdm`, so the pane may
  ask for a sudo password on first start.
- Ports held by a root-owned process are swept with `sudo -n`; if that is not
  permitted, run `sudo nk kill <port>`.
