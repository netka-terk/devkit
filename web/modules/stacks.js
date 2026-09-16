// D3v · Stacks — start, stop and watch the local dev stacks (nk's core).
// The stack page is a board: every panel (ports, commands, one terminal per
// tmux pane) sits on a 12-column grid and can be dragged and resized, Grafana
// style. Layouts are kept per stack in localStorage.
(() => {
  const { api, toast, esc, home, icons: ICON, t } = D3v;

  let root = null, $ = null;
  let stacks = [], selected = null, pendingSelect = null;
  const busy = new Set();
  let timer = null, onKey = null, onResize = null;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const saved = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const store = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

  // ------------------------------------------------------------- markup --
  const SHELL = () => `
    <div class="shell">
      <aside class="side">
        <div class="side-head"><span>${t('menu.stacks')}</span><span class="count" id="count"></span></div>
        <nav class="list" id="list" aria-label="stacks"></nav>
        <div class="side-foot">${t('st.foot')} <code>nk up grafana</code></div>
      </aside>
      <div class="gutter v" id="side-gutter" title="${esc(t('ui.drag'))}"></div>
      <main class="main" id="main"></main>
    </div>

    <dialog id="editor">
      <form method="dialog">
        <div class="dlg-head" id="dlgtitle"></div>
        <div class="dlg-body">
          <div class="field">
            <label for="f-name">${t('ed.name')}</label>
            <input type="text" id="f-name" class="in mono" placeholder="my-api" autocomplete="off" spellcheck="false">
            <div class="hint" id="f-name-hint">${t('ed.name.hint')}</div>
          </div>
          <div class="field">
            <label for="f-dir">${t('ed.dir')}</label>
            <div class="row2">
              <input type="text" id="f-dir" class="in mono" placeholder="/home/terk/myproject" autocomplete="off" spellcheck="false">
              <button type="button" class="btn" id="f-browse">${t('ed.browse')}</button>
            </div>
            <div class="browser" id="browser" hidden></div>
          </div>
          <div class="field">
            <label>${t('ed.cmds')}</label>
            <div id="f-cmds"></div>
            <button type="button" class="btn sm" id="f-addcmd">${t('ed.cmds.add')}</button>
            <div class="hint">${t('ed.cmds.hint')}</div>
          </div>
          <div class="field">
            <label for="f-ports">${t('ed.ports')}</label>
            <input type="text" id="f-ports" class="in mono" placeholder="3000 8080" autocomplete="off" spellcheck="false">
            <div class="hint">${t('ed.ports.hint')}</div>
          </div>
          <div class="field">
            <label for="f-url">${t('ed.url')}</label>
            <input type="text" id="f-url" class="in mono" placeholder="http://localhost:3000" autocomplete="off" spellcheck="false">
          </div>
          <div class="field">
            <label for="f-env">${t('ed.env')}</label>
            <input type="text" id="f-env" class="in mono" placeholder=".env" autocomplete="off" spellcheck="false">
          </div>
          <div class="field">
            <label for="f-sudo">${t('ed.sudo')}</label>
            <div class="row2">
              <input type="password" id="f-sudo" class="in" autocomplete="new-password" spellcheck="false">
              <button type="button" class="btn danger" id="f-sudo-clear" hidden>${t('ed.sudo.clear')}</button>
            </div>
            <div class="hint" id="f-sudo-hint">${t('ed.sudo.hint')}</div>
          </div>
        </div>
        <div class="dlg-foot">
          <button type="button" class="btn danger" id="f-delete" hidden>${t('ed.delete')}</button>
          <span class="grow"></span>
          <button type="button" class="btn" id="f-cancel">${t('ed.cancel')}</button>
          <button type="button" class="btn primary" id="f-save">${t('ed.save')}</button>
        </div>
      </form>
    </dialog>`;

  // ------------------------------------------------------------- render --
  function render() {
    if (drag) return;   // never rebuild the DOM under a drag in progress
    $('#count').textContent = stacks.length || '';
    D3v.setActions(`<button class="btn primary" id="new">${ICON.plus} ${t('st.new')}</button>`);
    document.getElementById('new').onclick = () => openEditor(null);

    // A stopped stack whose port is already taken gets a "!" with the reason on
    // hover: which port, which process, and what pressing Run would do to it.
    const ownerOf = (port) => stacks.find((o) => o.running &&
      (o.ports.some((p) => p.port === port) || (o.detected || []).some((p) => p.port === port)));
    $('#list').innerHTML = stacks.map((s) => {
      const held = s.running ? [] : s.ports.filter((p) => p.pid != null);
      const reason = held.map((p) => {
        const owner = ownerOf(p.port);
        return t('st.port.busy', { port: p.port, holder: p.holder, pid: p.pid }) + ' ' +
          (owner ? t('st.port.busy.by', { stack: owner.name, me: s.name }) : t('st.port.busy.ext', { me: s.name }));
      }).join('\n');
      const bang = held.length ? `<span class="bang" title="${esc(reason)}" aria-label="${esc(reason)}">!</span>` : '';
      return `<button class="item ${s.name === selected ? 'on' : ''}" data-select="${esc(s.name)}">
        <span class="dot ${s.running ? 'on' : ''}"></span>
        <span class="nm"><span>${esc(s.name)}</span></span>
        ${bang}
      </button>`;
    }).join('');

    renderDetail();
  }

  function renderDetail() {
    const main = $('#main');
    const s = stacks.find((x) => x.name === selected);

    if (!stacks.length) {
      main.innerHTML = `<div class="welcome">
        <div class="mark">D3v</div>
        <h2>${t('st.empty.title')}</h2>
        <p>${t('st.empty.body')}</p>
        <button class="btn primary" data-new>${t('st.empty.cta')}</button>
      </div>`;
      return;
    }
    if (!s) { main.innerHTML = `<div class="welcome"><p>${t('st.pick')}</p></div>`; return; }

    const isBusy = busy.has(s.name);
    const act = (verb, label, icon, cls = '') =>
      `<button class="btn ${cls}" data-act="${verb}" ${isBusy ? 'disabled' : ''}>${isBusy ? ICON.spin : icon}${label}</button>`;
    const actions = s.running
      ? act('restart', t('st.restart'), ICON.cycle) + act('down', t('st.stop'), ICON.stop, 'danger')
      : act('up', t('st.run'), ICON.play, 'primary');

    main.innerHTML = `
      <section class="detail">
        <div class="d-head">
          <div class="d-title">
            <h1>${esc(s.name)}
              <span class="state ${s.running ? 'on' : ''}"><span class="dot"></span>${s.running ? t('st.running') : t('st.stopped')}</span>
            </h1>
            <div class="path">${esc(home(s.dir))}${s.url ? ` &nbsp;·&nbsp; <a class="link" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)} ${ICON.ext}</a>` : ''}</div>
          </div>
          <div class="d-actions">
            ${actions}
            <button class="btn" data-act="edit">${ICON.edit}${t('st.edit')}</button>
            <button class="icon-btn" id="drawer-btn" title="${esc(t('ui.add.panel'))}" aria-label="${esc(t('ui.add.panel'))}">${ICON.grid}</button>
          </div>
        </div>
      </section>
      <div class="board" id="board"></div>
      <aside class="drawer" id="drawer" hidden>
        <div class="drawer-head">${t('ui.add.panel')}<button class="icon-btn sm" id="drawer-close" aria-label="${esc(t('ed.cancel'))}">✕</button></div>
        <div class="drawer-hint">${t('ui.add.hint')}</div>
        <div class="drawer-list">${catalog(s).map((c) => `
          <button class="dr-item" data-add="${esc(c.type)}" data-pane="${esc(c.pane || '')}">
            <span class="dr-ico">${c.icon}</span>
            <span class="dr-txt"><b>${esc(c.label)}</b><small>${esc(c.desc)}</small></span>
          </button>`).join('')}</div>
      </aside>`;

    renderBoard(s);
    wireDrawer(s);
    attachTerm(s.name);
  }

  // -------------------------------------------------------------- board --
  // The board always fills the viewport: the row unit is derived from the space
  // actually available, so however many rows the layout has, they add up to one
  // screen. ROW_MIN is the safety valve — below it the board scrolls rather
  // than squeezing panels into unreadable slivers.
  const COLS = 12, GAP = 10, ROW_MIN = 22, ROW_FALLBACK = 32;
  let rowH = ROW_FALLBACK;
  let layout = [];          // [{ id, x, y, w, h, minW, minH }]
  let drag = null;          // { kind: 'move'|'resize', item, el, x0, y0, orig, colW }

  const layoutKey = (name) => `d3v-layout:${name}`;

  // defaultLayout — ports and commands on top, one terminal per pane below,
  // two terminals per row when there are several.
  // catalog — the panels a board can hold. The drawer lists these; the board
  // holds instances of them, so the same kind can appear more than once (a
  // second view of one terminal, say).
  function catalog(s) {
    return [
      { type: 'ports', label: t('st.ports'), desc: t('ui.cat.ports'), icon: ICON.port, w: 6, h: 4, minW: 3, minH: 3 },
      { type: 'panes', label: t('st.panes'), desc: t('ui.cat.panes'), icon: ICON.list, w: 6, h: 4, minW: 3, minH: 3 },
      ...(s.panes || []).map((p) => ({
        type: 'term', pane: p.label, label: t('ui.cat.term', { pane: p.label }),
        desc: p.cmd, icon: ICON.term, w: 6, h: 8, minW: 3, minH: 3,
      })),
    ];
  }

  const specOf = (s, type, pane) =>
    catalog(s).find((c) => c.type === type && (type !== 'term' || c.pane === pane));

  // uid — a readable instance id, suffixed when the same panel is added twice.
  function uid(type, pane) {
    const base = type === 'term' ? `term:${pane}` : type;
    if (!layout.some((it) => it.id === base)) return base;
    for (let n = 2; ; n++) if (!layout.some((it) => it.id === `${base}#${n}`)) return `${base}#${n}`;
  }

  // Rows are relative, not pixels: the board scales whatever total it gets to
  // the viewport. Info panels take a quarter of the height, terminals the rest.
  function defaultLayout(s) {
    const items = [
      { id: 'ports', type: 'ports', x: 0, y: 0, w: 6, h: 4, minW: 3, minH: 3 },
      { id: 'panes', type: 'panes', x: 6, y: 0, w: 6, h: 4, minW: 3, minH: 3 },
    ];
    const names = (s.panes || []).map((p) => p.label);
    const rows = Math.max(1, Math.ceil(names.length / 2));
    const two = names.length >= 2;
    const h = Math.max(4, Math.round(12 / rows));
    names.forEach((n, i) => items.push({
      id: `term:${n}`, type: 'term', pane: n, minW: 3, minH: 3,
      w: two ? 6 : 12, h,
      x: two ? (i % 2) * 6 : 0,
      y: 4 + (two ? Math.floor(i / 2) : i) * h,
    }));
    return items;
  }

  function loadLayout(s) {
    let sv = null;
    try { sv = JSON.parse(saved(layoutKey(s.name)) || 'null'); } catch {}
    if (!Array.isArray(sv)) return compact(defaultLayout(s), null);
    const items = [];
    for (const p of sv) {
      const spec = specOf(s, p.type, p.pane);
      if (!spec) continue;               // a pane that no longer exists
      const x = clamp(p.x | 0, 0, COLS - 1);
      items.push({
        id: p.id || `${p.type}${p.pane ? ':' + p.pane : ''}`, type: p.type, pane: p.pane,
        minW: spec.minW, minH: spec.minH,
        x, w: clamp(p.w | 0, spec.minW, COLS - x),
        y: Math.max(0, p.y | 0), h: Math.max(spec.minH, p.h | 0),
      });
    }
    return items.length ? compact(items, null) : compact(defaultLayout(s), null);
  }

  function saveLayout() {
    store(layoutKey(selected), JSON.stringify(layout.map(
      ({ id, type, pane, x, y, w, h }) => ({ id, type, pane, x, y, w, h }))));
  }

  function removePanel(id) {
    layout = layout.filter((it) => it.id !== id);
    saveLayout();
    renderBoard(stacks.find((x) => x.name === selected));
    attachTerm(selected);
  }

  // addPanel — drop a catalogue entry onto the board at a pointer position,
  // then hand it straight to the move-drag so it can be placed by hand.
  function addPanel(s, type, pane, ev) {
    const spec = specOf(s, type, pane); if (!spec) return;
    const board = $('#board');
    const r = board.getBoundingClientRect();
    const colW = (board.clientWidth || 1200) / COLS;
    const rowU = rowH + GAP;
    const x = clamp(Math.round(((ev?.clientX ?? 0) - r.left) / colW - spec.w / 2), 0, COLS - spec.w);
    const y = Math.max(0, Math.round(((ev?.clientY ?? 0) - r.top) / rowU));
    const it = { id: uid(type, pane), type, pane, x, y, w: spec.w, h: spec.h, minW: spec.minW, minH: spec.minH };
    layout.push(it);
    compact(layout, it);
    // renderBoard reloads the layout from storage, so persist before rendering.
    saveLayout();
    closeDrawer();
    renderBoard(s);
    attachTerm(selected);
    return it.id;
  }

  const collides = (a, b) => a !== b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // compact — Grafana-style vertical packing. The pinned item (the one being
  // dragged) stays exactly where it is; everything else floats up as far as
  // it can and is pushed down out of any overlap, in reading order.
  function compact(items, pinned) {
    const order = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    if (pinned) { order.splice(order.indexOf(pinned), 1); order.unshift(pinned); }
    const placed = [];
    for (const it of order) {
      if (it !== pinned) {
        while (it.y > 0) { it.y--; if (placed.some((p) => collides(it, p))) { it.y++; break; } }
      }
      while (placed.some((p) => collides(it, p))) it.y++;
      placed.push(it);
    }
    return items;
  }

  // place — grid cell → box. Sized by left/right rather than a width with
  // calc(), so the gap is a plain margin and there is no calc to parse.
  function place(el, it) {
    el.style.left = `${(it.x / COLS) * 100}%`;
    el.style.right = `${(1 - (it.x + it.w) / COLS) * 100}%`;
    el.style.width = 'auto';
    el.style.top = `${it.y * (rowH + GAP)}px`;
    el.style.height = `${it.h * rowH + (it.h - 1) * GAP}px`;
  }

  // fitRows — the row unit that makes `rows` rows exactly fill the board.
  function fitRows(rows) {
    const board = $('#board');
    const avail = board ? board.clientHeight : 0;
    if (!avail || !rows) return ROW_FALLBACK;
    return Math.max(ROW_MIN, (avail - (rows - 1) * GAP) / rows);
  }

  function applyPositions() {
    const board = $('#board'); if (!board) return;
    const rows = layout.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    rowH = fitRows(rows);
    for (const it of layout) {
      const el = board.querySelector(`[data-gp="${CSS_escape(it.id)}"]`);
      if (el && !(drag && drag.item === it && drag.kind === 'move')) place(el, it);
    }
    // Only when the rows hit ROW_MIN can the content outgrow one screen.
    board.classList.toggle('overflowing', rows * (rowH + GAP) - GAP > board.clientHeight + 1);
  }
  const CSS_escape = (s) => s.replace(/["\\]/g, '\\$&');

  function panelHtml(s, it) {
    const isBusy = busy.has(s.name);
    const tools = (html) => `<span class="gp-tools">${html}</span>`;
    let title = '', body = '', cls = '', extra = '';

    if (it.type === 'ports') {
      title = t('st.ports');
      const ports = s.ports.map((p) => {
        const heldByOther = p.pid != null && !s.running;
        const v = p.pid == null
          ? `<div class="v muted">${t('st.free')}</div>`
          : `<div class="v ${heldByOther ? 'held' : ''}">${esc(p.holder)} <span class="num">· pid ${p.pid}</span></div>`;
        const a = heldByOther
          ? `<div class="a"><button class="btn sm danger" data-kill="${p.port}" ${isBusy ? 'disabled' : ''}>${t('st.clear')}</button></div>`
          : `<div class="a"></div>`;
        return `<div class="k num">:${p.port}</div>${v}${a}`;
      }).join('');
      const declared = new Set(s.ports.map((p) => p.port));
      const extraPorts = (s.detected || []).filter((p) => !declared.has(p.port));
      const detectedRows = extraPorts.map((p) =>
        `<div class="k num">:${p.port}</div>
         <div class="v">${esc(p.holder)} <span class="num">· pid ${p.pid}</span> <span class="tag auto">${t('st.detected')}</span></div>
         <div class="a"></div>`).join('');
      const empty = !s.ports.length && !extraPorts.length
        ? `<div class="empty">${s.running ? t('st.ports.none.running') : t('st.ports.none.stopped')}</div>` : '';
      extra = extraPorts.length
        ? `<button class="btn sm" data-adopt ${isBusy ? 'disabled' : ''} title="${esc(t('st.adopt.title'))}">${t('st.adopt', { n: extraPorts.length })}</button>` : '';
      body = `<div class="kv">${ports}${detectedRows}${empty}</div>`;
    } else if (it.type === 'panes') {
      title = `${t('st.panes')} <span class="num" style="font-weight:500">${(s.panes || []).length}</span>`;
      body = `<div class="kv">${(s.panes || []).map((p) =>
        `<div class="k">${esc(p.label)}</div><div class="v">${esc(p.cmd)}</div><div class="a"></div>`).join('') || `<div class="empty">${t('st.panes.none')}</div>`}</div>`;
    } else {
      const pane = it.pane;
      cls = 'term';
      title = `<span class="mono">${esc(pane)}</span>`;
      extra = `<span class="live"><span class="dot"></span><span class="livetext">${t('term.connecting')}</span></span>
               <label><input type="checkbox" data-follow="${esc(pane)}" checked> ${t('term.follow')}</label>
               <button class="tbtn" data-clear="${esc(pane)}" title="${esc(t('term.clear.pane'))}">${t('term.clear')}</button>`;
      body = `<pre class="term" data-pre="${esc(pane)}" tabindex="0" role="textbox"
        aria-label="${esc(t('term.input.aria', { pane }))}" title="${esc(t('term.input.hint'))}"></pre>`;
    }
    return `<section class="gp ${cls}" data-gp="${esc(it.id)}">
      <header class="gp-head" title="${esc(t('ui.drag.panel'))}"><span class="gp-title">${title}</span>${tools(extra +
        `<button class="gp-x" data-remove="${esc(it.id)}" title="${esc(t('ui.remove.panel'))}" aria-label="${esc(t('ui.remove.panel'))}">✕</button>`)}</header>
      <div class="gp-body">${body}</div>
      <span class="gp-resize" data-resize title="${esc(t('ui.drag'))}"></span>
    </section>`;
  }

  function renderBoard(s) {
    const board = $('#board');
    layout = loadLayout(s);
    board.innerHTML = layout.map((it) => panelHtml(s, it)).join('') + `<div class="gp-ph" id="gp-ph" hidden></div>`;
    applyPositions();
    // addEventListener, not .onpointerdown: the property form is not an event
    // handler in every DOM. The board element is rebuilt on each render, so
    // this cannot stack up duplicate listeners.
    board.addEventListener('pointerdown', onBoardPointerDown);
  }

  // Drag to move (from a panel header) or resize (from the corner handle).
  // Pointer maths uses the board's real width, falling back to a nominal one
  // where there is no layout engine (tests), so the grid snapping still works.
  function onBoardPointerDown(ev) {
    if (ev.button != null && ev.button !== 0) return;
    const gp = ev.target.closest('.gp'); if (!gp) return;
    const resize = ev.target.closest('[data-resize]');
    const head = ev.target.closest('.gp-head');
    if (!resize && (!head || ev.target.closest('button, input, a, label'))) return;
    const item = layout.find((it) => it.id === gp.dataset.gp); if (!item) return;
    ev.preventDefault();
    startDrag(resize ? 'resize' : 'move', item, gp, ev);
  }

  function startDrag(kind, item, gp, ev) {
    const board = $('#board');
    drag = {
      kind, item, el: gp,
      x0: ev.clientX, y0: ev.clientY, orig: { ...item },
      colW: (board.clientWidth || 1200) / COLS, rowU: rowH + GAP,
      px: { left: gp.offsetLeft, top: gp.offsetTop, w: gp.offsetWidth, h: gp.offsetHeight },
    };
    gp.classList.add('moving');
    const ph = $('#gp-ph'); ph.hidden = false; place(ph, item);
    document.addEventListener('pointermove', onBoardPointerMove);
    document.addEventListener('pointerup', onBoardPointerUp);
  }

  function onBoardPointerMove(ev) {
    if (!drag) return;
    const dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
    const { item, orig, colW, el } = drag;
    if (drag.kind === 'move') {
      el.style.right = 'auto'; el.style.width = `${drag.px.w}px`;
      el.style.left = `${drag.px.left + dx}px`; el.style.top = `${Math.max(0, drag.px.top + dy)}px`;
      item.x = clamp(orig.x + Math.round(dx / colW), 0, COLS - item.w);
      item.y = Math.max(0, orig.y + Math.round(dy / drag.rowU));
    } else {
      el.style.right = 'auto';
      el.style.width = `${Math.max(120, drag.px.w + dx)}px`; el.style.height = `${Math.max(80, drag.px.h + dy)}px`;
      item.w = clamp(orig.w + Math.round(dx / colW), item.minW, COLS - item.x);
      item.h = Math.max(item.minH, orig.h + Math.round(dy / drag.rowU));
    }
    compact(layout, item);
    place($('#gp-ph'), item);
    applyPositions();
  }

  function onBoardPointerUp() {
    if (!drag) return;
    const { el, item } = drag;
    document.removeEventListener('pointermove', onBoardPointerMove);
    document.removeEventListener('pointerup', onBoardPointerUp);
    el.classList.remove('moving');
    $('#gp-ph').hidden = true;
    drag = null;
    compact(layout, item);
    applyPositions();
    place(el, item);
    saveLayout();
  }

  function openDrawer() { const d = $('#drawer'); if (d) d.hidden = false; }
  function closeDrawer() { const d = $('#drawer'); if (d) d.hidden = true; }

  // A drawer item is dragged, not clicked: pointerdown places the panel under
  // the cursor and the board's own move-drag takes over from there.
  function wireDrawer(s) {
    const list = $('#drawer .drawer-list'); if (!list) return;
    list.addEventListener('pointerdown', (ev) => {
      const b = ev.target.closest('[data-add]'); if (!b) return;
      ev.preventDefault();
      const id = addPanel(s, b.dataset.add, b.dataset.pane || undefined, ev);
      if (!id) return;
      // renderBoard rebuilt the items, so pick the fresh one up by id.
      const it = layout.find((x) => x.id === id);
      const el = $('#board').querySelector(`[data-gp="${CSS_escape(id)}"]`);
      if (it && el) startDrag('move', it, el, ev);
    });
  }

  // ------------------------------------------------------------ refresh --
  async function refresh() {
    if (!root) return;
    try {
      const list = await api('/api/stacks');
      const prev = Object.fromEntries(stacks.map((s) => [s.name, s.panes]));
      stacks = list.map((s) => ({ ...s, panes: prev[s.name] }));
      if (pendingSelect && stacks.some((s) => s.name === pendingSelect)) selected = pendingSelect;
      pendingSelect = null;
      if (!selected || !stacks.some((s) => s.name === selected)) selected = stacks[0]?.name ?? null;
      if (selected) await ensurePanes(selected);
      render();
    } catch (e) {
      toast(t('st.load.fail'), { detail: e.message, kind: 'bad' });
    }
  }

  async function ensurePanes(name) {
    const s = stacks.find((x) => x.name === name);
    if (!s || s.panes) return;
    try {
      const d = await api(`/api/stack/${encodeURIComponent(name)}`);
      s.panes = d.panes || []; s.envFile = d.envFile; s.file = d.file;
    } catch { s.panes = []; }
  }

  async function select(name) {
    if (name === selected) return;
    selected = name;
    history.replaceState(null, '', `#/stacks/${encodeURIComponent(name)}`);
    await ensurePanes(name);
    render();
  }

  // ------------------------------------------------------------ actions --
  const DONE = { up: 'st.done.up', down: 'st.done.down', restart: 'st.done.restart' };
  async function act(name, verb) {
    busy.add(name); render();
    try {
      const r = await api(`/api/${verb}/${encodeURIComponent(name)}`, 'POST');
      toast(`${t(DONE[verb])} · ${name}`, { cli: `nk ${verb} ${name}`, kind: r.ok ? 'good' : 'bad', detail: r.ok ? '' : r.output });
    } catch (e) {
      toast(t('st.fail', { verb, name }), { detail: e.message, kind: 'bad' });
    } finally { busy.delete(name); await refresh(); }
  }
  async function adoptPorts(name) {
    busy.add(name); render();
    try {
      const r = await api(`/api/adopt/${encodeURIComponent(name)}`, 'POST');
      toast(r.output, { kind: 'good', cli: `nk ports ${name}` });
      const s = stacks.find((x) => x.name === name); if (s) s.panes = undefined;
    } catch (e) { toast(t('st.adopt.fail'), { detail: e.message, kind: 'bad' }); }
    finally { busy.delete(name); await refresh(); }
  }
  async function killPort(port) {
    try {
      const r = await api(`/api/kill/${port}`, 'POST');
      toast(t('st.kill.ok', { port }), { cli: `nk kill ${port}`, kind: r.ok ? 'good' : 'bad', detail: r.ok ? '' : r.output });
    } catch (e) { toast(t('st.kill.fail', { port }), { detail: e.message, kind: 'bad' }); }
    refresh();
  }

  // ----------------------------------------------------------- terminal --
  // tmux pipe-pane mirrors each pane into a file; the server tails those over
  // SSE, so this only appends and renders ANSI into that pane's panel.
  let es = null, termFor = null, panes = new Map();

  const SGR = {
    30:'#5E6875',31:'#F0716D',32:'#3CCB85',33:'#F0B44A',34:'#5B93FF',35:'#C792EA',
    36:'#56C8D8',37:'#C8D0DA',90:'#7C8794',91:'#FF8A85',92:'#5FE3A1',93:'#FFD27A',
    94:'#82AEFF',95:'#DDB0FF',96:'#7FDCE9',97:'#F2F5F8',
  };
  function ansiToHtml(text) {
    let out = '', open = false, st = {};
    const parts = text.split(/\x1b\[([0-9;]*)m/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        if (!parts[i]) continue;
        const body = esc(parts[i]);
        if (!open) { out += body; continue; }
        const css = [st.color && `color:${st.color}`, st.bold && 'font-weight:500;color:#F2F5F8', st.dim && 'opacity:.6', st.ul && 'text-decoration:underline'].filter(Boolean).join(';');
        out += css ? `<span style="${css}">${body}</span>` : body;
      } else {
        for (const c of (parts[i] || '0').split(';')) {
          const n = parseInt(c || '0', 10);
          if (n === 0) { st = {}; open = false; }
          else if (n === 1) { st.bold = true; open = true; }
          else if (n === 2) { st.dim = true; open = true; }
          else if (n === 4) { st.ul = true; open = true; }
          else if (n === 22) { st.bold = st.dim = false; }
          else if (n === 39) { st.color = null; }
          else if (SGR[n]) { st.color = SGR[n]; open = true; }
        }
      }
    }
    return out.replace(/\r(?!\n)/g, '\n');
  }

  function attachTerm(name) {
    if (termFor !== name) {
      if (es) es.close();
      panes = new Map(); termFor = name;
      es = new EventSource(`/api/stream/${encodeURIComponent(name)}`);
      es.onopen = () => setLive(true);
      es.onerror = () => setLive(false, t('term.retry'));
      es.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        let buf = (panes.get(m.pane) || '') + m.text;
        if (buf.length > 400000) buf = buf.slice(-300000);
        panes.set(m.pane, buf);
        paint(m.pane);
      };
    }
    const s = stacks.find((x) => x.name === name);
    setLive(!!es && es.readyState === 1, s?.running ? undefined : t('term.last'));
    paint();
  }

  function setLive(on, msg) {
    for (const el of root.querySelectorAll('.gp .live')) {
      el.classList.toggle('on', on);
      el.querySelector('.livetext').textContent = msg ?? (on ? t('term.live') : t('term.off'));
    }
  }

  function paint(only) {
    const s = stacks.find((x) => x.name === termFor);
    for (const pre of root.querySelectorAll('[data-pre]')) {
      const pane = pre.dataset.pre;
      if (only && pane !== only) continue;
      const buf = panes.get(pane);
      if (buf == null) {
        pre.innerHTML = `<div class="term-empty">${s?.running ? t('term.wait') : esc(t('term.none', { name: termFor || '' }))}</div>`;
        continue;
      }
      pre.innerHTML = ansiToHtml(buf);
      const follow = root.querySelector(`[data-follow="${CSS_escape(pane)}"]`)?.checked ?? true;
      if (follow) pre.scrollTop = pre.scrollHeight;
    }
  }

  // -------------------------------------------------------------- input --
  // A pane can stop and wait for input — sudo asks for a password, a script
  // asks y/n — and a read-only view leaves it stuck there. Focus a terminal
  // and keystrokes go to the tmux pane through nk send.
  const KEYMAP = {
    Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'BSpace',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  };
  const CTRL = { c: 'C-c', d: 'C-d', z: 'C-z', l: 'C-l', u: 'C-u' };

  async function send(pane, payload) {
    try {
      await api(`/api/send/${encodeURIComponent(termFor)}`, 'POST', { pane, ...payload });
    } catch (e) { toast(t('term.input.fail'), { detail: e.message, kind: 'bad' }); }
  }

  function onTermKey(ev) {
    const pre = ev.target.closest('[data-pre]'); if (!pre) return;
    const pane = pre.dataset.pre;
    const s = stacks.find((x) => x.name === termFor);
    if (!s?.running) return;

    if (ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      const k = CTRL[ev.key.toLowerCase()];
      // Ctrl-C with a selection is a copy, not an interrupt.
      if (k && !(k === 'C-c' && !getSelection()?.isCollapsed)) {
        ev.preventDefault(); return send(pane, { key: k });
      }
      return;                       // leave Ctrl-V, Ctrl-A and friends alone
    }
    if (ev.metaKey || ev.altKey) return;
    if (KEYMAP[ev.key]) { ev.preventDefault(); return send(pane, { key: KEYMAP[ev.key] }); }
    if (ev.key.length === 1) { ev.preventDefault(); return send(pane, { text: ev.key }); }
  }

  function onTermPaste(ev) {
    const pre = ev.target.closest('[data-pre]'); if (!pre) return;
    const text = ev.clipboardData?.getData('text'); if (!text) return;
    ev.preventDefault();
    send(pre.dataset.pre, { text });
  }

  // ------------------------------------------------------------- resize --
  // The sidebar edge is the one drag outside the board.
  function wireSideGutter() {
    const handle = $('#side-gutter'), shell = $('.shell');
    root.style.setProperty('--side-w', saved('d3v-side-w') ? `${saved('d3v-side-w')}px` : '');
    handle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); handle.classList.add('dragging');
      const move = (e) => {
        const w = clamp(e.clientX - shell.getBoundingClientRect().left, 180, 560);
        store('d3v-side-w', Math.round(w)); root.style.setProperty('--side-w', `${Math.round(w)}px`);
      };
      const up = () => { handle.classList.remove('dragging'); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    });
    handle.addEventListener('dblclick', () => { store('d3v-side-w', null); root.style.setProperty('--side-w', ''); });
  }

  // ------------------------------------------------------------- editor --
  let dlg = null, editing = null, clearSudo = false;

  function cmdRow(label = '', cmd = '') {
    const row = document.createElement('div');
    row.className = 'cmdrow';
    row.innerHTML = `
      <input type="text" class="in mono lbl" placeholder="${esc(t('ed.pane.ph'))}" value="${esc(label)}" spellcheck="false">
      <input type="text" class="in mono cmd" placeholder="${esc(t('ed.cmd.ph'))}" value="${esc(cmd)}" spellcheck="false">
      <button type="button" title="${esc(t('ed.row.rm'))}">✕</button>`;
    row.querySelector('button').onclick = () => {
      row.remove();
      if (!$('#f-cmds').children.length) $('#f-cmds').append(cmdRow());
    };
    return row;
  }

  function openEditor(stack) {
    editing = stack ? stack.name : null;
    $('#dlgtitle').textContent = stack ? t('ed.title.edit', { name: stack.name }) : t('ed.title.new');
    $('#f-name').value = stack ? stack.name : '';
    // A running stack has its name baked into the tmux session and log paths.
    const running = !!stack && !!stacks.find((x) => x.name === stack.name)?.running;
    $('#f-name').disabled = running;
    $('#f-name-hint').innerHTML = running ? esc(t('ed.name.running')) : t('ed.name.hint');
    $('#f-dir').value = stack ? stack.dir : '';
    $('#f-ports').value = stack ? (stack.ports || '') : '';
    $('#f-url').value = stack ? (stack.url || '') : '';
    $('#f-env').value = stack ? (stack.envFile || '') : '';
    clearSudo = false;
    $('#f-sudo').value = '';
    $('#f-sudo').placeholder = stack?.hasSudo ? t('ed.sudo.kept') : '';
    $('#f-sudo-clear').hidden = !stack?.hasSudo;
    $('#f-sudo-hint').innerHTML = t('ed.sudo.hint');
    $('#f-delete').hidden = !stack;
    $('#browser').hidden = true;
    const host = $('#f-cmds'); host.innerHTML = '';
    const rows = stack?.panes?.length ? stack.panes : [{ label: 'app', cmd: '' }];
    rows.forEach((r) => host.append(cmdRow(r.label, r.cmd)));
    dlg.showModal();
    if (!stack) $('#f-name').focus();
  }

  async function editStack(name) {
    try {
      const d = await api(`/api/stack/${encodeURIComponent(name)}`);
      if (d.error) throw new Error(d.error);
      openEditor(d);
    } catch (e) { toast(t('ed.open.fail'), { detail: e.message, kind: 'bad' }); }
  }

  async function browse(path) {
    const b = $('#browser');
    try {
      const r = await api(`/api/browse?path=${encodeURIComponent(path)}`);
      b.innerHTML =
        (r.parent ? `<div data-go="${esc(r.parent)}">${t('ed.up')}</div>` : '') +
        `<div class="pick" data-pick="${esc(r.path)}">${t('ed.pick')} ${esc(home(r.path))}</div>` +
        r.dirs.map((d) => `<div data-go="${esc(r.path.replace(/\/$/, '') + '/' + d)}">${esc(d)}/</div>`).join('');
    } catch (e) { b.innerHTML = `<div>${esc(e.message)}</div>`; }
  }

  function wireEditor() {
    dlg = $('#editor');
    $('#f-addcmd').onclick = () => $('#f-cmds').append(cmdRow());
    $('#f-cancel').onclick = () => dlg.close();
    $('#f-sudo-clear').onclick = () => {
      clearSudo = true;
      $('#f-sudo').value = ''; $('#f-sudo').placeholder = '';
      $('#f-sudo-clear').hidden = true;
      $('#f-sudo-hint').textContent = t('ed.sudo.willclear');
    };
    $('#f-browse').onclick = () => {
      const b = $('#browser');
      if (!b.hidden) { b.hidden = true; return; }
      b.hidden = false; browse($('#f-dir').value || '');
    };
    $('#browser').onclick = (ev) => {
      const pick = ev.target.closest('[data-pick]');
      if (pick) { $('#f-dir').value = pick.dataset.pick; $('#browser').hidden = true; return; }
      const go = ev.target.closest('[data-go]');
      if (go) browse(go.dataset.go);
    };
    $('#f-save').onclick = async () => {
      const spec = {
        prev: editing || '',
        name: $('#f-name').value.trim(), dir: $('#f-dir').value.trim(),
        ports: $('#f-ports').value.trim(), url: $('#f-url').value.trim(), envFile: $('#f-env').value.trim(),
        sudoPassword: $('#f-sudo').value, clearSudo,
        panes: [...$('#f-cmds').querySelectorAll('.cmdrow')].map((r) => ({
          label: r.querySelector('.lbl').value.trim(), cmd: r.querySelector('.cmd').value.trim(),
        })).filter((r) => r.cmd),
      };
      try {
        const r = await api('/api/stack', 'POST', spec);
        toast(r.output, { kind: 'good' });
        dlg.close();
        const s = stacks.find((x) => x.name === spec.name); if (s) s.panes = undefined;
        selected = spec.name;
        await refresh();
      } catch (e) { toast(t('ed.save.fail'), { detail: e.message, kind: 'bad' }); }
    };
    $('#f-delete').onclick = async () => {
      if (!editing || !confirm(t('ed.confirm.del', { name: editing }))) return;
      try {
        const r = await api(`/api/stack/${encodeURIComponent(editing)}`, 'DELETE');
        toast(r.output, { kind: 'good' });
        dlg.close(); selected = null; await refresh();
      } catch (e) { toast(t('ed.del.fail'), { detail: e.message, kind: 'bad' }); }
    };
  }

  // ------------------------------------------------------------- wiring --
  function onClick(ev) {
    const sel = ev.target.closest('[data-select]');
    if (sel) return select(sel.dataset.select);
    if (ev.target.closest('[data-new]')) return openEditor(null);
    if (ev.target.closest('#drawer-btn')) return $('#drawer').hidden ? openDrawer() : closeDrawer();
    if (ev.target.closest('#drawer-close')) return closeDrawer();
    const rm = ev.target.closest('[data-remove]');
    if (rm) return removePanel(rm.dataset.remove);
    const clear = ev.target.closest('[data-clear]');
    if (clear) { panes.set(clear.dataset.clear, ''); return paint(clear.dataset.clear); }
    const kill = ev.target.closest('[data-kill]');
    if (kill) return killPort(kill.dataset.kill);
    if (ev.target.closest('[data-adopt]') && selected) return adoptPorts(selected);
    const btn = ev.target.closest('[data-act]');
    if (!btn || !selected) return;
    const verb = btn.dataset.act;
    if (verb === 'edit') return editStack(selected);
    if (verb === 'down' && !confirm(t('st.confirm.stop', { name: selected }))) return;
    act(selected, verb);
  }

  // ------------------------------------------------------------- module --
  D3v.register({
    id: 'stacks',
    labelKey: 'menu.stacks',
    icon: D3v.icons.stack,
    mount(el, param) {
      root = el; $ = (s) => root.querySelector(s);
      root.innerHTML = SHELL();
      pendingSelect = param || null;
      wireSideGutter();
      wireEditor();
      root.addEventListener('click', onClick);
      onKey = (ev) => {
        if (dlg.open || ev.target.matches('input')) return;
        const i = stacks.findIndex((s) => s.name === selected);
        if (ev.key === 'ArrowDown' && i < stacks.length - 1) select(stacks[i + 1].name);
        if (ev.key === 'ArrowUp' && i > 0) select(stacks[i - 1].name);
      };
      document.addEventListener('keydown', onKey);
      root.addEventListener('keydown', onTermKey);
      root.addEventListener('paste', onTermPaste);
      onResize = () => applyPositions();
      addEventListener('resize', onResize);
      timer = setInterval(() => { if (!document.hidden && !dlg.open && !drag) refresh(); }, 4000);
      refresh();
    },
    navigate(param) { if (param && param !== selected) select(param); },
    refresh,
    unmount() {
      clearInterval(timer); timer = null;
      document.removeEventListener('keydown', onKey);
      removeEventListener('resize', onResize);
      document.removeEventListener('pointermove', onBoardPointerMove);
      document.removeEventListener('pointerup', onBoardPointerUp);
      if (es) { es.close(); es = null; }
      termFor = null; panes = new Map(); drag = null;
      D3v.setActions('');
      root = null; $ = null;
    },
  });
})();
