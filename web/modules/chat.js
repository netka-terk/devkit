// D3v · Chat — a Claude Code conversation per stack folder.
//
// The server keeps one `claude` process per stack, started in that stack's
// folder, and streams its events here. Everything on this page is a rendering
// of those events: what Claude said, what it wants to run, and what it needs
// permission for. Approval is a button a person presses — the page never
// answers a permission request on anyone's behalf.
(() => {
  const { api, toast, esc, home, icons: ICON, t } = D3v;

  let root = null, $ = null;
  let stacks = [], selected = null, pendingSelect = null;
  let es = null, seq = 0, state = null, streamFor = null;
  const tools = new Map();          // tool_use_id -> its card, so a result lands in it

  const attrEsc = (v) => String(v).replace(/["\\]/g, '\\$&');
  const saved = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const store = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  // ------------------------------------------------------------- markup --
  const SHELL = () => `
    <div class="shell">
      <aside class="side">
        <div class="side-head"><span>${t('menu.chat')}</span></div>
        <nav class="list" id="list" aria-label="stacks"></nav>
        <div class="side-foot">${t('ch.foot')}</div>
      </aside>
      <div class="gutter v" id="side-gutter" title="${esc(t('ui.drag'))}"></div>
      <main class="main" id="main"></main>
    </div>`;

  const PANE = (s) => `
    <div class="ch-head">
      <div class="d-title">
        <h1>${esc(s.name)}</h1>
        <div class="path">${esc(home(s.dir))}</div>
      </div>
      <div class="ch-tools">
        <label class="ch-mode">${t('ch.mode')}
          <select id="ch-mode" class="in"></select>
        </label>
        <span class="ch-cost num" id="ch-cost"></span>
        <button class="btn danger" id="ch-stop" hidden>${ICON.stop}${t('ch.stop')}</button>
      </div>
    </div>
    <div class="ch-log" id="ch-log" tabindex="0"></div>
    <form class="ch-compose" id="ch-form">
      <textarea id="ch-in" rows="1" placeholder="${esc(t('ch.ph'))}" spellcheck="false"></textarea>
      <button class="btn primary" id="ch-send" type="submit">${t('ch.send')}</button>
    </form>`;

  // --------------------------------------------------------- formatting --
  // A deliberately small markdown: escape first, then fenced code, inline code,
  // bold and links. Anything else stays as written, because the log is
  // pre-wrapped — better plain than wrong.
  function md(text) {
    const blocks = [];
    let out = esc(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, body) =>
      `\u0000${blocks.push(`<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ''}>${body.replace(/\n$/, '')}</pre>`) - 1}\u0000`);
    out = out
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  }

  const bytes = (n) => n > 1e6 ? `${(n / 1e6).toFixed(1)}M` : n > 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;
  // Four decimals under a dollar: a turn often costs less than a cent, and
  // rounding that to $0.01 would say the wrong thing.
  const money = (n) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

  // summary — the one line that says what a tool call is about, so the card is
  // readable without opening it.
  function summary(name, input) {
    const i = input || {};
    if (i.command) return String(i.command);
    if (i.file_path) return home(String(i.file_path));
    if (i.path) return home(String(i.path));
    if (i.pattern) return String(i.pattern);
    if (i.prompt) return String(i.prompt).slice(0, 120);
    if (i.url) return String(i.url);
    const keys = Object.keys(i);
    return keys.length ? `${keys[0]}: ${String(i[keys[0]]).slice(0, 80)}` : '';
  }

  // --------------------------------------------------------------- log --
  const logEl = () => $('#ch-log');
  function atBottom() {
    const l = logEl();
    return !l || l.scrollHeight - l.scrollTop - l.clientHeight < 60;
  }
  function add(node) {
    const l = logEl(); if (!l) return node;
    const stick = atBottom();
    l.append(node);
    if (stick) l.scrollTop = l.scrollHeight;
    return node;
  }
  function el(cls, html) {
    const d = document.createElement('div');
    d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
  }

  // --------------------------------------------------------- rendering --
  function onEvent(ev) {
    const ty = ev.type;
    if (ty === 'nk') return onNk(ev);
    if (ty === 'system' && ev.subtype === 'init') return onInit(ev);
    if (ty === 'assistant') return onAssistant(ev);
    if (ty === 'user') return onToolResult(ev);
    if (ty === 'control_request') return onPermission(ev);
    if (ty === 'result') return onResult(ev);
  }

  function onNk(ev) {
    if (ev.event === 'ask') return add(el('msg me', md(ev.text)));
    if (ev.event === 'started') return add(el('note', esc(t('ch.started', { dir: home(ev.cwd), mode: ev.mode }))));
    if (ev.event === 'exited') { setBusy(false); return add(el('note', esc(t('ch.exited')))); }
    if (ev.event === 'answered') {
      const card = root.querySelector(`[data-perm="${attrEsc(ev.request_id)}"]`);
      if (card) {
        card.classList.add('done', ev.allow ? 'ok' : 'no');
        card.querySelector('.perm-act').innerHTML =
          `<span class="perm-said">${esc(t(ev.allow ? 'ch.allowed' : 'ch.denied'))}</span>`;
      }
    }
  }

  function onInit(ev) {
    const m = $('#ch-model');
    if (m) m.textContent = ev.model || '';
  }

  function onAssistant(ev) {
    for (const c of ev.message?.content || []) {
      if (c.type === 'text' && c.text.trim()) add(el('msg claude', md(c.text)));
      else if (c.type === 'thinking' && c.thinking?.trim()) {
        add(el('fold think', `<details><summary>${esc(t('ch.thinking'))}</summary><div>${esc(c.thinking)}</div></details>`));
      } else if (c.type === 'tool_use') {
        const card = el('fold tool', `<details><summary><span class="tname">${esc(c.name)}</span>
          <span class="tsum">${esc(summary(c.name, c.input))}</span></summary>
          <pre class="code">${esc(JSON.stringify(c.input, null, 2))}</pre>
          <div class="tres"></div></details>`);
        card.dataset.tool = c.id;
        tools.set(c.id, card);
        add(card);
      }
    }
  }

  function onToolResult(ev) {
    for (const c of ev.message?.content || []) {
      if (c.type !== 'tool_result') continue;
      const card = tools.get(c.tool_use_id);
      const body = typeof c.content === 'string' ? c.content
        : Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n')
        : JSON.stringify(c.content);
      const short = (body || '').slice(0, 4000);
      if (card) {
        card.classList.toggle('failed', !!c.is_error);
        card.querySelector('.tres').innerHTML =
          `<div class="tres-h">${esc(t(c.is_error ? 'ch.tool.err' : 'ch.tool.out'))}</div><pre class="code">${esc(short)}</pre>`;
      } else {
        add(el('fold tool', `<details><summary>${esc(t('ch.tool.out'))}</summary><pre class="code">${esc(short)}</pre></details>`));
      }
    }
  }

  // A permission request is the one thing on this page that waits for a person.
  function onPermission(ev) {
    const r = ev.request || {};
    const card = el('perm', `
      <div class="perm-h">${ICON.shield}${esc(t('ch.perm', { tool: r.display_name || r.tool_name }))}</div>
      <div class="perm-sum">${esc(summary(r.tool_name, r.input))}</div>
      <details><summary>${esc(t('ch.perm.detail'))}</summary><pre class="code">${esc(JSON.stringify(r.input, null, 2))}</pre></details>
      <div class="perm-act">
        <button class="btn" data-deny="${esc(ev.request_id)}">${t('ch.deny')}</button>
        <button class="btn primary" data-allow="${esc(ev.request_id)}">${t('ch.allow')}</button>
      </div>`);
    card.dataset.perm = ev.request_id;
    add(card);
  }

  function onResult(ev) {
    setBusy(false);
    const u = ev.usage || {};
    const parts = [
      ev.subtype !== 'success' ? t('ch.failed', { why: ev.subtype || '' }) : '',
      typeof ev.duration_api_ms === 'number' ? `${(ev.duration_api_ms / 1000).toFixed(1)}s` : '',
      u.output_tokens ? t('ch.tokens', { n: bytes(u.output_tokens) }) : '',
      typeof ev.total_cost_usd === 'number' ? money(ev.total_cost_usd) : '',
    ].filter(Boolean);
    if (typeof ev.total_cost_usd === 'number') {
      const c = $('#ch-cost'); if (c) c.textContent = money(ev.total_cost_usd);
    }
    add(el('note' + (ev.subtype !== 'success' ? ' bad' : ''), esc(parts.join(' · '))));
  }

  // -------------------------------------------------------------- state --
  function setBusy(busy) {
    if (!root || !$('#ch-send')) return;
    $('#ch-send').disabled = busy;
    $('#ch-send').innerHTML = busy ? ICON.spin : t('ch.send');
    $('#ch-stop').hidden = !busy;
  }

  async function answer(id, allow) {
    try {
      await api(`/api/chatperm/${encodeURIComponent(selected)}`, 'POST', { id, allow });
    } catch (e) { toast(t('ch.perm.fail'), { detail: e.message, kind: 'bad' }); }
  }

  async function send(text) {
    if (!text.trim() || !selected) return;
    try {
      await api(`/api/chat/${encodeURIComponent(selected)}`, 'POST', { text });
      setBusy(true);
    } catch (e) { toast(t('ch.send.fail'), { detail: e.message, kind: 'bad' }); }
  }

  // ------------------------------------------------------------- stream --
  function attach(name) {
    if (streamFor === name && es) return;
    if (es) { es.close(); es = null; }
    streamFor = name; seq = 0; tools.clear();
    es = new EventSource(`/api/chatstream/${encodeURIComponent(name)}?since=0`);
    es.onmessage = (m) => {
      let d; try { d = JSON.parse(m.data); } catch { return; }
      if (d.seq <= seq) return;         // the backlog can overlap a reconnect
      seq = d.seq;
      onEvent(d.ev);
    };
    es.onerror = () => { /* EventSource reconnects on its own */ };
  }

  // ------------------------------------------------------------- render --
  function render() {
    $('#list').innerHTML = stacks.map((s) => `
      <button class="item ${s.name === selected ? 'on' : ''}" data-select="${esc(s.name)}">
        <span class="dot ${s.running ? 'on' : ''}"></span>
        <span class="nm"><span>${esc(s.name)}</span></span>
      </button>`).join('');
    renderPane();
  }

  function renderPane() {
    const main = $('#main');
    const s = stacks.find((x) => x.name === selected);
    if (!stacks.length) return void (main.innerHTML = `<div class="welcome"><p>${t('st.empty.title')}</p></div>`);
    if (!s) return void (main.innerHTML = `<div class="welcome"><p>${t('ch.pick')}</p></div>`);
    if (main.dataset.for === s.name) return;
    main.dataset.for = s.name;
    main.innerHTML = PANE(s);
    wirePane();
    attach(s.name);
    loadState(s.name);
  }

  async function loadState(name) {
    try {
      state = await api(`/api/chat/${encodeURIComponent(name)}`);
      if (name !== selected) return;
      const sel = $('#ch-mode');
      sel.innerHTML = (state.modes || []).map((m) =>
        `<option value="${esc(m)}" ${m === state.mode ? 'selected' : ''}>${esc(t(`ch.mode.${m}`))}</option>`).join('');
      $('#ch-cost').textContent = state.cost ? money(state.cost) : '';
      setBusy(!!state.busy);
      if (!state.claude) add(el('note bad', esc(t('ch.noclaude'))));
    } catch (e) { toast(t('ch.state.fail'), { detail: e.message, kind: 'bad' }); }
  }

  function wirePane() {
    const form = $('#ch-form'), box = $('#ch-in');
    // The box grows with the message instead of turning into a slot to peer
    // through; Enter sends, shift-Enter is a newline, as everywhere else.
    const grow = () => { box.style.height = 'auto'; box.style.height = `${Math.min(220, box.scrollHeight)}px`; };
    box.addEventListener('input', grow);
    box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey) { ev.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = box.value;
      if (!text.trim()) return;
      box.value = ''; grow();
      send(text);
    });
    $('#ch-stop').onclick = async () => {
      try { await api(`/api/chatstop/${encodeURIComponent(selected)}`, 'POST'); setBusy(false); }
      catch (e) { toast(t('ch.stop.fail'), { detail: e.message, kind: 'bad' }); }
    };
    $('#ch-mode').onchange = async (ev) => {
      const mode = ev.target.value;
      try {
        await api(`/api/chatmode/${encodeURIComponent(selected)}`, 'POST', { mode });
        toast(t('ch.mode.set', { mode: t(`ch.mode.${mode}`) }), { kind: 'good' });
      } catch (e) { toast(t('ch.mode.fail'), { detail: e.message, kind: 'bad' }); }
    };
    box.focus();
  }

  function wireSideGutter() {
    const handle = $('#side-gutter'), shell = $('.shell');
    root.style.setProperty('--side-w', saved('d3v-side-w') ? `${saved('d3v-side-w')}px` : '');
    handle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); handle.classList.add('dragging');
      const move = (e) => {
        const w = Math.min(560, Math.max(180, e.clientX - shell.getBoundingClientRect().left));
        store('d3v-side-w', Math.round(w)); root.style.setProperty('--side-w', `${Math.round(w)}px`);
      };
      const up = () => { handle.classList.remove('dragging'); removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
  }

  async function select(name) {
    if (name === selected) return;
    selected = name;
    history.replaceState(null, '', `#/chat/${encodeURIComponent(name)}`);
    render();
  }

  async function refresh() {
    if (!root) return;
    try {
      stacks = await api('/api/stacks');
      if (pendingSelect && stacks.some((s) => s.name === pendingSelect)) selected = pendingSelect;
      pendingSelect = null;
      if (!selected || !stacks.some((s) => s.name === selected)) selected = stacks[0]?.name ?? null;
      render();
    } catch (e) { toast(t('st.load.fail'), { detail: e.message, kind: 'bad' }); }
  }

  function onClick(ev) {
    const sel = ev.target.closest('[data-select]');
    if (sel) return select(sel.dataset.select);
    const a = ev.target.closest('[data-allow]');
    if (a) return answer(a.dataset.allow, true);
    const d = ev.target.closest('[data-deny]');
    if (d) return answer(d.dataset.deny, false);
  }

  // ------------------------------------------------------------- module --
  D3v.register({
    id: 'chat',
    labelKey: 'menu.chat',
    icon: D3v.icons.chat,
    mount(el_, param) {
      root = el_; $ = (s) => root.querySelector(s);
      root.innerHTML = SHELL();
      pendingSelect = param || null;
      wireSideGutter();
      root.addEventListener('click', onClick);
      refresh();
    },
    navigate(param) { if (param && param !== selected) select(param); },
    refresh,
    unmount() {
      if (es) { es.close(); es = null; }
      streamFor = null; tools.clear(); state = null;
      root = null; $ = null;
    },
  });
})();
