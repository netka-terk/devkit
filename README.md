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
    nk stats               # CPU/RAM of the machine, and of each running stack
    nk chat corr           # the console's conversation for a stack, in a terminal
    nk chat corr "why is the consumer lagging?"

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
- **Performance** — what the machine is doing and which stack is doing it.
- **Chat** — a Claude Code conversation per stack folder, without opening an editor.

Chat in detail:

- **One conversation per stack folder.** Pick a stack and talk about it; the
  `claude` process runs in that stack's `NK_DIR`, so the files it reads and
  writes are that project's. A conversation is remembered: come back tomorrow
  and it is still there.
- **The same conversation from the terminal.** The session id is nk's, not
  claude's — one UUID per stack under `~/.config/nk/chat/` — so `nk chat <stack>`
  opens in a terminal exactly what the page is showing, and `nk chat <stack>
  "question"` asks and prints the answer. Neither is a copy of the other.
- **Approval is a button a person presses.** The process runs with
  `--permission-prompt-tool stdio`, so every tool that needs permission arrives
  as a card saying which tool, on which file, with the full input one click
  away, and Allow / Deny underneath. Nothing is approved unless somebody says
  so; deny is what happens to anything else. The permission mode starts at "ask
  every time" and the selector offers *edits without asking*, *decide
  automatically* and *plan only* — but not `bypassPermissions`, because a button
  that turns off every check does not belong on a page with no login.
- **What Claude did is there when that is the question.** Tool calls and
  thinking are folded away with a one-line summary and open on click; a tool's
  output lands inside its own card rather than as another bubble. Each turn ends
  with how long it took, the tokens, and what the conversation has cost.
- **It reads the stream, it does not own state.** The page is a rendering of the
  event stream, so a second tab shows the same conversation, and a reload picks
  it up where it was.

It needs the `claude` binary. It looks on `PATH`, then `~/.local/bin`, then the
copy the VS Code extension ships; `NK_CLAUDE_BIN` overrides all of it.

Performance in detail:

- **A stack's share, not just the machine's load.** `htop` can tell you the box
  is busy; what it cannot tell you is that `grafana`'s webpack is the reason.
  Attribution comes from tmux: every pane of an `nk-` session is a root, and
  everything below it in the process tree belongs to that pane. So the figure is
  what a stack's commands and their children actually cost.
- **One scale throughout.** CPU is a share of the whole machine everywhere, host
  tile and stack rows alike, so they are comparable and they add up: one full
  core of eight is 12.5%. The bar beside each stack is measured against the whole
  machine too, so a stack using a tenth of the box looks like a tenth even when
  it is the only one running.
- **Rates are computed on the page.** `nk stats --json` returns raw counters and
  never rates, so the reading stays stateless and costs one `/proc` scan (about
  40ms). The page keeps the previous sample, divides by the elapsed time, and
  gets its two minutes of history for free — nothing is written to disk.
- **Four charts, each a part-to-whole over time.** The height is the total and
  the bands say what it is made of: CPU and memory break down by stack, with
  everything else on the machine as one grey band; disk splits into read and
  write, network into in and out. The headline figure is the sum of the bands
  drawn, so the number and the chart can never tell different stories.
- **Axes that tell the truth.** CPU is pinned to 0–100% and memory to the RAM
  installed, so a quiet machine looks quiet and headroom is visible. Disk and
  network have no natural ceiling, so they scale to what they have seen, rounded
  to a number worth reading. Gridlines are hairline and solid; the ticks carry
  the values the bands do not.
- **Colour follows the stack, not its rank.** A stack takes its slot the first
  time it is seen and keeps it, so the busiest one changing does not repaint the
  others. The slots are the eight-hue order validated for colour-blindness on
  this page's own light and dark surfaces, and a ninth stack is never given a
  generated hue — past the fourth it folds into the grey band and stays in the
  table. Nothing is identified by colour alone: the legend writes out every
  band's current value, and the table underneath is the whole thing in text.
- **Hovering** puts a hairline on the sample under the pointer and lists every
  band at that moment. The whole plot is the target, so nothing has to be hit
  precisely, and no value exists only inside the tooltip.

Stacks in detail:

- **Define a stack from the page**: name, a path (with a directory picker), one
  or more commands, and the ports to free first. `NK_API_BASE` and
  `NK_TOKEN_CMD` (what `nk curl` / `nk token` use) sit behind an "optional"
  fold, so saving from the page keeps them. Edit, rename (while stopped) and
  delete work on every stack alike; deleting also drops the stack's stored sudo
  password.
- **Run it**: up, restart, down, and freeing an individual port, over live status.
- **Port discovery**: while a stack runs, nk walks the process tree under each
  tmux pane and asks `lsof` what it listens on. Ports that `NK_PORTS` omits show
  up tagged "เจอตอนรัน" with a one-click "จำไว้" that saves them, so the next
  `nk up` frees them first. `nk ports <stack>` and `nk status` show the same.
- **Live terminal**: `nk up` points `tmux pipe-pane` at a file per pane, and the
  page streams those over SSE with ANSI colour, one terminal panel per pane.
  Output is not polled, and when `nk up` starts a pane over the panel clears
  with it. A terminal panel is also an input: focus it and keystrokes go to the
  tmux pane through `nk send`, in order (they queue, and a burst of characters
  travels as one string), so a pane waiting on a prompt can be answered from the
  page instead of stalling there. While a terminal has focus it owns the
  keyboard: the `1..9` menu keys and the stack list's arrows stay out of it.
  Panes are found by the label nk gave them (a tmux pane option), not by the
  pane title, which any program can overwrite with a title escape.
  The poll every few seconds updates the header and the info panels in place;
  terminals keep their focus, selection, scroll position and follow toggle.
- **sudo without watching**: a stack whose commands call `sudo` (nksmdm builds
  with `sudo setcap`) can hold a password. It is stored in its own 0600 file
  under `~/.config/nk/secrets/`, never in the stack file, and the pane gets a
  `sudo` shim on `PATH` plus `SUDO_ASKPASS`, so every `sudo` in that pane —
  including ones inside a Makefile, which runs under `sh` and cannot see a shell
  function — takes the password from there rather than prompting. Prompt
  scraping would be a guess; this is what sudo provides for the purpose.
  A `NOPASSWD` sudoers rule for just that command is safer and needs no stored
  password: `nk nopass setcap` installs one (`/etc/sudoers.d/nk-<user>-setcap`,
  checked with `visudo -c`, sudo asks once to write it) and the editor points
  there.
- **Three states, not two**: a stack is *starting* while its session is up but
  nothing listens on a port yet, *ready* once something does, and *pane died*
  when a pane's command exited non-zero — the wrapper records the exit code, so
  a crash no longer hides behind a shell that tmux keeps alive. The terminal
  shows an `exit N` tag, the sidebar dot pulses or turns red, and the tab title
  and favicon carry the summary (`2/4 up`, a coloured dot) for when another
  window has the attention. The bell in the top bar opts into desktop
  notifications — only while the tab is hidden — for a pane dying, a stack
  becoming ready, or a pane waiting for input.
- **A pane waiting for input** (stopped mid-line at `password:` or `y/n` and
  quiet for a few seconds) turns amber with a "waiting for input" button that
  focuses the terminal. It is a hint from the output, never an answer typed on
  the user's behalf.
- **tmux borders per stack**: `nk up` paints a session's pane borders and
  status bar in a hue hashed from the stack name, so `nk attach` shows which
  stack you are in. The page itself uses colour for status only.
- **Command palette** (`Ctrl-K`, or the "Commands" button): type what to do —
  `up grafana`, `kill 3080`, `ports` — and press Enter. Every item shows the
  `nk` command it stands for, so the palette doubles as the CLI cheat sheet.
- **Zoom**: double-click a panel header (or its ⤢) and it fills the board;
  again, or `Esc`, brings the layout back.
- **Motion with a job**: transitions confirm a click landed, panels fade up in
  sequence when a stack is opened, the drawer comes from its edge, a state that
  changed rings once. Only two things loop, and both mean "still going": the
  starting dot and the live dot. Opening a stack animates; the four-second poll
  does not, so nothing on the page moves on its own. `prefers-reduced-motion`
  turns the lot off in one rule.
- **Board layout**: the stack page is a 12-column grid that always fills one
  screen — the row unit is derived from the space available, so the panels scale
  with the window instead of the page scrolling. Every panel (ports, commands,
  each pane's terminal) drags by its header and resizes from its corner,
  neighbours reflow around it, and the layout is remembered per stack. The panel
  drawer in the header holds the catalogue — ports, commands, a terminal for
  each pane — and an item is dragged out of it onto the board; the same kind can
  be added more than once (a second view of one terminal), and each panel's ✕
  removes it. Only when rows would fall below a readable minimum does the board
  scroll instead.

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
    nk send <stack> <pane> --text "y" | --key Enter   # type into a running pane
    nk secret <stack> set    # store the sudo password (read from stdin)
    nk secret <stack> clear
    nk nopass setcap         # better: let `sudo setcap` run without a password at all

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

    npm install jsdom@24        # once, anywhere on the path (node ≥ 18)
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
