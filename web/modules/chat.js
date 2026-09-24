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
  let pending = [];                 // images waiting to go with the next message
  let phase = null, phaseSince = 0, tick = null;

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
        <div class="path">${esc(home(s.dir))} <span class="ch-live" id="ch-model"></span></div>
      </div>
      <div class="ch-tools">
        <label class="ch-sel">${t('ch.model')}
          <select id="ch-model-sel" class="in"></select>
        </label>
        <label class="ch-sel">${t('ch.mode')}
          <select id="ch-mode" class="in"></select>
        </label>
        <span class="ch-cost num" id="ch-cost"></span>
        <button class="btn danger" id="ch-stop" hidden>${ICON.stop}${t('ch.stop')}</button>
      </div>
    </div>
    <div class="ch-log" id="ch-log" tabindex="0"></div>
    <div class="ch-status" id="ch-status" hidden>
      <span id="ch-mascot"></span>
      <span class="st-text" id="ch-phase"></span>
      <span class="st-sum" id="ch-what"></span>
      <span class="st-time num" id="ch-elapsed"></span>
    </div>
    <form class="ch-compose" id="ch-form">
      <div class="ch-shots" id="ch-shots" hidden></div>
      <div class="ch-row">
        <button type="button" class="icon-btn" id="ch-clip" title="${esc(t('ch.attach'))}" aria-label="${esc(t('ch.attach'))}">${ICON.clip}</button>
        <textarea id="ch-in" rows="1" placeholder="${esc(t('ch.ph'))}" spellcheck="false"></textarea>
        <button class="btn primary" id="ch-send" type="submit">${t('ch.send')}</button>
      </div>
      <input type="file" id="ch-file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
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

  // ------------------------------------------------------------ images --
  // The API takes an image up to a few megabytes and stops gaining from one
  // wider than ~1568px, so anything bigger is scaled down here rather than
  // pushed over the wire to be refused.
  const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const IMG_EDGE = 1568, IMG_PLAIN = 3.5e6, MAX_SHOTS = 6;

  const toBase64 = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => rej(new Error('read failed'));
    r.readAsDataURL(blob);
  });

  async function prepare(file) {
    if (!IMG_TYPES.includes(file.type)) throw new Error(t('ch.img.type'));
    // A small file of a supported type goes as it is; re-encoding it would
    // only cost quality. GIFs always do, because a canvas would flatten them.
    if (file.size <= IMG_PLAIN || file.type === 'image/gif') {
      return { media_type: file.type, data: await toBase64(file), name: file.name || '' };
    }
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, IMG_EDGE / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.85);
    return { media_type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), name: file.name || '' };
  }

  async function attachFiles(files) {
    for (const f of [...files].slice(0, MAX_SHOTS - pending.length)) {
      try { pending.push(await prepare(f)); }
      catch (e) { toast(e.message || t('ch.img.fail'), { kind: 'bad' }); }
    }
    paintShots();
  }

  function paintShots() {
    const box = $('#ch-shots'); if (!box) return;
    box.hidden = !pending.length;
    box.innerHTML = pending.map((im, i) => `
      <span class="shot">
        <img src="data:${esc(im.media_type)};base64,${im.data}" alt="${esc(im.name || t('ch.img'))}">
        <button type="button" class="shot-x" data-drop="${i}" aria-label="${esc(t('ed.row.rm'))}">✕</button>
      </span>`).join('');
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
    if (ty === 'rate_limit_event') return D3v.setUsage({ at: Date.now() / 1000, info: ev.rate_limit_info });
    if (ty === 'control_request') return onPermission(ev);
    if (ty === 'result') return onResult(ev);
  }

  function onNk(ev) {
    if (ev.event === 'ask') {
      // The pictures come back by id, not by value: the stream carries the
      // reference and the browser fetches the file.
      const shots = (ev.images || []).map((im) =>
        `<a href="/api/chatimg/${encodeURIComponent(streamFor)}/${encodeURIComponent(im.id)}" target="_blank" rel="noopener">
          <img class="shot-img" src="/api/chatimg/${encodeURIComponent(streamFor)}/${encodeURIComponent(im.id)}" alt="${esc(im.name || t('ch.img'))}"></a>`).join('');
      return add(el('msg me', (ev.text ? md(ev.text) : '') + (shots ? `<div class="shots">${shots}</div>` : '')));
    }
    if (ev.event === 'started') return add(el('note', esc(t('ch.started', { dir: home(ev.cwd), mode: ev.mode }))));
    if (ev.event === 'exited') { setBusy(false); setPhase(null); return add(el('note', esc(t('ch.exited')))); }
    if (ev.event === 'answered') {
      const card = root.querySelector(`[data-perm="${attrEsc(ev.request_id)}"]`);
      if (card) {
        card.classList.add('done', ev.allow ? 'ok' : 'no');
        card.querySelector('.perm-act').innerHTML =
          `<span class="perm-said">${esc(t(ev.allow ? 'ch.allowed' : 'ch.denied'))}</span>`;
      }
      // Answering does not end the turn — work carries on from here.
      if (phase === 'wait') setPhase('thinking');
    }
  }

  function onInit(ev) {
    const m = $('#ch-model');
    if (m) m.textContent = ev.model || '';
  }

  function onAssistant(ev) {
    for (const c of ev.message?.content || []) {
      if (c.type === 'text' && c.text.trim()) { setPhase('writing'); add(el('msg claude', md(c.text))); }
      else if (c.type === 'thinking' && c.thinking?.trim()) {
        setPhase('thinking');
        add(el('fold think', `<details><summary>${esc(t('ch.thinking'))}</summary><div>${esc(c.thinking)}</div></details>`));
      } else if (c.type === 'tool_use') {
        setPhase('tool', c.name);
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
      setPhase('thinking');
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
    setPhase('wait', summary(r.tool_name, r.input));
    add(card);
  }

  function onResult(ev) {
    setBusy(false);
    setPhase(null);
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

  // ------------------------------------------------------------ status --
  // The events already say what stage a turn is at, so the strip says it too
  // rather than showing one spinner for everything between "sent" and
  // "waiting on you to decide".
  function setPhase(kind, what = '') {
    phase = kind;
    const bar = $('#ch-status'); if (!bar) return;
    if (!kind) {
      bar.hidden = true;
      delete bar.dataset.kind;
      clearInterval(tick); tick = null;
      return;
    }
    if (bar.hidden) { bar.hidden = false; phaseSince = Date.now(); }
    bar.classList.toggle('wait', kind === 'wait');
    // Redrawn only when the state changes, so the mascot's animation does not
    // start over every second along with the clock.
    if (bar.dataset.kind !== kind) {
      bar.dataset.kind = kind;
      $('#ch-mascot').innerHTML = D3v.mascot(kind === 'sent' ? 'thinking' : kind);
    }
    $('#ch-phase').textContent = kind === 'tool' ? t('ch.busy.tool', { tool: what }) : t(`ch.busy.${kind}`);
    $('#ch-what').textContent = kind === 'tool' ? '' : what;
    if (!tick) {
      const paint = () => {
        const e = $('#ch-elapsed'); if (!e) return;
        const n = Math.round((Date.now() - phaseSince) / 1000);
        e.textContent = n >= 60 ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}` : `${n}s`;
      };
      paint();
      tick = setInterval(paint, 1000);
    }
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

  async function send(text, images) {
    if (!selected || (!text.trim() && !images.length)) return;
    try {
      await api(`/api/chat/${encodeURIComponent(selected)}`, 'POST', { text, images });
      setBusy(true);
      setPhase('sent');
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
    if (!s) return void (main.innerHTML = `<div class="welcome">${D3v.mascot('idle')}<p>${t('ch.pick')}</p></div>`);
    if (main.dataset.for === s.name) return;
    main.dataset.for = s.name;
    clearInterval(tick); tick = null; phase = null;
    main.innerHTML = PANE(s);
    wirePane();
    attach(s.name);
    loadState(s.name);
  }

  async function loadState(name) {
    try {
      state = await api(`/api/chat/${encodeURIComponent(name)}`);
      if (name !== selected) return;
      $('#ch-mode').innerHTML = (state.modes || []).map((m) =>
        `<option value="${esc(m)}" ${m === state.mode ? 'selected' : ''}>${esc(t(`ch.mode.${m}`))}</option>`).join('');
      // An alias is a product name, so it is shown as one; the empty option is
      // "whatever this machine is set to", which is not the same as "opus".
      $('#ch-model-sel').innerHTML = (state.models || []).map((m) =>
        `<option value="${esc(m)}" ${m === (state.model || '') ? 'selected' : ''}>${
          m ? esc(m[0].toUpperCase() + m.slice(1)) : esc(t('ch.model.default'))}</option>`).join('');
      $('#ch-cost').textContent = state.cost ? money(state.cost) : '';
      setBusy(!!state.busy);
      if (!state.claude) add(el('note bad', esc(t('ch.noclaude'))));
      // A tab that joins in the middle of a turn should not look idle.
      if (state.busy) setPhase(state.pending?.length ? 'wait' : 'thinking');
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
      if (!text.trim() && !pending.length) return;
      const images = pending;
      pending = []; paintShots();
      box.value = ''; grow();
      send(text, images);
    });

    // Three ways in, because a screenshot arrives differently every time:
    // paste it, drop it on the page, or pick it from the button.
    $('#ch-clip').onclick = () => $('#ch-file').click();
    $('#ch-file').onchange = (e) => { attachFiles(e.target.files); e.target.value = ''; };
    box.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); attachFiles(files); }
    });
    for (const kind of ['dragover', 'drop']) {
      root.addEventListener(kind, (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        root.classList.toggle('dropping', kind === 'dragover');
        if (kind === 'drop') attachFiles(e.dataTransfer.files);
      });
    }
    root.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) root.classList.remove('dropping');
    });
    $('#ch-stop').onclick = async () => {
      try { await api(`/api/chatstop/${encodeURIComponent(selected)}`, 'POST'); setBusy(false); setPhase(null); }
      catch (e) { toast(t('ch.stop.fail'), { detail: e.message, kind: 'bad' }); }
    };
    // Both are fixed when the process starts, so either restarts the session.
    // The conversation is kept by its id, which is why that is safe to do.
    const setOpts = async (body, okMsg, failKey) => {
      try {
        await api(`/api/chatopts/${encodeURIComponent(selected)}`, 'POST', body);
        toast(okMsg, { kind: 'good' });
      } catch (e) { toast(t(failKey), { detail: e.message, kind: 'bad' }); }
    };
    $('#ch-mode').onchange = (ev) =>
      setOpts({ mode: ev.target.value }, t('ch.mode.set', { mode: t(`ch.mode.${ev.target.value}`) }), 'ch.mode.fail');
    $('#ch-model-sel').onchange = (ev) => {
      const m = ev.target.value;
      setOpts({ model: m }, t('ch.model.set', { model: m || t('ch.model.default') }), 'ch.model.fail');
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
    const drop = ev.target.closest('[data-drop]');
    if (drop) { pending.splice(+drop.dataset.drop, 1); return paintShots(); }
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
      clearInterval(tick); tick = null; phase = null;
      streamFor = null; tools.clear(); state = null; pending = [];
      root = null; $ = null;
    },
  });
})();
