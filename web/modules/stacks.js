// D3v · Stacks — start, stop and watch the local dev stacks (nk's core).
(() => {
  const { api, toast, esc, home, icons: ICON } = D3v;

  let root = null, $ = null;
  let stacks = [], selected = null, pendingSelect = null;
  const busy = new Set();
  let timer = null, onKey = null;

  // ------------------------------------------------------------- markup --
  const SHELL = `
    <div class="shell">
      <aside class="side">
        <div class="side-head"><span>Stacks</span><span class="count" id="count"></span></div>
        <nav class="list" id="list" aria-label="stacks"></nav>
        <div class="side-foot">ทุกปุ่มมีคำสั่งเทียบเท่า เช่น <code>nk up grafana</code></div>
      </aside>
      <main class="main" id="main"></main>
    </div>

    <dialog id="editor">
      <form method="dialog">
        <div class="dlg-head" id="dlgtitle">stack ใหม่</div>
        <div class="dlg-body">
          <div class="field">
            <label for="f-name">ชื่อ</label>
            <input type="text" id="f-name" class="in mono" placeholder="my-api" autocomplete="off" spellcheck="false">
            <div class="hint">ใช้เรียกใน <code>nk up &lt;ชื่อ&gt;</code> — a-z, 0-9, _ และ -</div>
          </div>
          <div class="field">
            <label for="f-dir">โฟลเดอร์ที่จะรัน</label>
            <div class="row2">
              <input type="text" id="f-dir" class="in mono" placeholder="/home/terk/myproject" autocomplete="off" spellcheck="false">
              <button type="button" class="btn" id="f-browse">เลือก…</button>
            </div>
            <div class="browser" id="browser" hidden></div>
          </div>
          <div class="field">
            <label>คำสั่ง</label>
            <div id="f-cmds"></div>
            <button type="button" class="btn sm" id="f-addcmd">+ เพิ่มคำสั่ง</button>
            <div class="hint">แต่ละแถวเปิดเป็น pane ของตัวเองใน tmux — ซ้ายชื่อ ขวาคำสั่ง</div>
          </div>
          <div class="field">
            <label for="f-ports">port ที่ต้องว่างก่อนรัน</label>
            <input type="text" id="f-ports" class="in mono" placeholder="3000 8080" autocomplete="off" spellcheck="false">
            <div class="hint">ปล่อยว่างได้ — ตอนรัน D3v จะบอกเองว่าใช้ port ไหน แล้วกด "จำไว้"</div>
          </div>
          <div class="field">
            <label for="f-url">URL ที่เปิดดู (ไม่บังคับ)</label>
            <input type="text" id="f-url" class="in mono" placeholder="http://localhost:3000" autocomplete="off" spellcheck="false">
          </div>
          <div class="field">
            <label for="f-env">ไฟล์ env ที่ source ก่อนรัน (ไม่บังคับ)</label>
            <input type="text" id="f-env" class="in mono" placeholder=".env" autocomplete="off" spellcheck="false">
          </div>
        </div>
        <div class="dlg-foot">
          <button type="button" class="btn danger" id="f-delete" hidden>ลบ stack</button>
          <span class="grow"></span>
          <button type="button" class="btn" id="f-cancel">ยกเลิก</button>
          <button type="button" class="btn primary" id="f-save">บันทึก</button>
        </div>
      </form>
    </dialog>`;

  // ------------------------------------------------------------- render --
  function render() {
    const running = stacks.filter((s) => s.running).length;
    const held = stacks.reduce((n, s) => n + s.ports.filter((p) => p.pid != null && !s.running).length, 0);
    $('#count').textContent = stacks.length || '';
    D3v.setActions(`<button class="btn primary" id="new">${ICON.plus} stack ใหม่</button>`);
    document.getElementById('new').onclick = () => openEditor(null);

    $('#list').innerHTML = stacks.map((s) => {
      const heldPorts = s.ports.filter((p) => p.pid != null);
      const all = [...new Set([...s.ports.map((p) => p.port), ...(s.detected || []).map((p) => p.port)])];
      const pt = all.length
        ? `<span class="pt ${heldPorts.length && !s.running ? 'held' : ''}">${esc(all.join(' '))}</span>` : '';
      return `<button class="item ${s.name === selected ? 'on' : ''}" data-select="${esc(s.name)}">
        <span class="dot ${s.running ? 'on' : ''}"></span>
        <span class="nm"><span>${esc(s.name)}</span><small>${esc(s.origin)}</small></span>
        ${pt}
      </button>`;
    }).join('');

    renderDetail();
    void running; void held;
  }

  function renderDetail() {
    const main = $('#main');
    const s = stacks.find((x) => x.name === selected);

    if (!stacks.length) {
      main.innerHTML = `<div class="welcome">
        <div class="mark">D3v</div>
        <h2>ยังไม่มี stack</h2>
        <p>stack คือโฟลเดอร์หนึ่ง + คำสั่งที่จะรันในนั้น กดปุ่มด้านล่างเพื่อสร้างอันแรก หรือใน terminal สั่ง <code>nk init</code> ในโปรเจคของคุณ</p>
        <button class="btn primary" data-new>สร้าง stack แรก</button>
      </div>`;
      return;
    }
    if (!s) { main.innerHTML = `<div class="welcome"><p>เลือก stack จากรายการด้านซ้าย</p></div>`; return; }

    const isBusy = busy.has(s.name);
    const act = (verb, label, icon, cls = '') =>
      `<button class="btn ${cls}" data-act="${verb}" ${isBusy ? 'disabled' : ''}>${isBusy ? ICON.spin : icon}${label}</button>`;
    const actions = s.running
      ? act('restart', 'รีสตาร์ท', ICON.cycle) + act('down', 'หยุด', ICON.stop, 'danger')
      : act('up', 'รัน', ICON.play, 'primary');

    const ports = s.ports.map((p) => {
      const heldByOther = p.pid != null && !s.running;
      const v = p.pid == null
        ? `<div class="v muted">ว่าง</div>`
        : `<div class="v ${heldByOther ? 'held' : ''}">${esc(p.holder)} <span class="num">· pid ${p.pid}</span></div>`;
      const a = heldByOther
        ? `<div class="a"><button class="btn sm danger" data-kill="${p.port}" ${isBusy ? 'disabled' : ''}>เคลียร์</button></div>`
        : `<div class="a"></div>`;
      return `<div class="k num">:${p.port}</div>${v}${a}`;
    }).join('');

    const declared = new Set(s.ports.map((p) => p.port));
    const extra = (s.detected || []).filter((p) => !declared.has(p.port));
    const detectedRows = extra.map((p) =>
      `<div class="k num">:${p.port}</div>
       <div class="v">${esc(p.holder)} <span class="num">· pid ${p.pid}</span> <span class="tag auto">เจอตอนรัน</span></div>
       <div class="a"></div>`).join('');
    const portsEmpty = !s.ports.length && !extra.length
      ? `<div class="empty">${s.running ? 'ยังไม่พบ TCP listener ใน pane — ถ้า service เพิ่ง start รอสักครู่' : 'ไม่ได้ประกาศ port — จะรู้ตอนรันว่าใช้ port ไหน'}</div>` : '';
    const adoptBtn = extra.length
      ? `<button class="btn sm" data-adopt ${isBusy ? 'disabled' : ''} title="บันทึก port ที่เจอลง stack — รอบหน้าจะเคลียร์ให้ก่อนรัน">จำ ${extra.length} port ที่เจอ</button>` : '';

    const panes = (s.panes || []).map((p) =>
      `<div class="k">${esc(p.label)}</div><div class="v">${esc(p.cmd)}</div><div class="a"></div>`
    ).join('') || `<div class="empty">ไม่มีคำสั่ง</div>`;

    main.innerHTML = `
      <section class="detail">
        <div class="d-head">
          <div class="d-title">
            <h1>${esc(s.name)}
              <span class="state ${s.running ? 'on' : ''}"><span class="dot"></span>${s.running ? 'กำลังรัน' : 'หยุดอยู่'}</span>
              <span class="tag">${esc(s.origin)}</span>
            </h1>
            <div class="path">${esc(home(s.dir))}${s.url ? ` &nbsp;·&nbsp; <a class="link" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)} ${ICON.ext}</a>` : ''}</div>
          </div>
          <div class="d-actions">
            ${actions}
            <button class="btn" data-act="edit">${ICON.edit}แก้ไข</button>
          </div>
        </div>
        <div class="grid">
          <div class="panel">
            <div class="p-head">Ports ${adoptBtn}</div>
            <div class="kv">${ports}${detectedRows}${portsEmpty}</div>
          </div>
          <div class="panel">
            <div class="p-head">Panes <span class="num" style="font-weight:500">${(s.panes || []).length}</span></div>
            <div class="kv">${panes}</div>
            ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}
          </div>
        </div>
      </section>

      <div class="term-wrap">
        <div class="term-bar">
          <span class="lbl">Terminal</span>
          <div class="tabs" id="tabs"></div>
          <span class="grow"></span>
          <span class="live" id="live"><span class="dot"></span><span id="livetext">กำลังต่อ…</span></span>
          <div class="seg" id="termmode" role="group" aria-label="รูปแบบ terminal">
            <button data-mode="tabs" title="แท็บ">${ICON.tabs}</button>
            <button data-mode="cols" title="แยกซ้าย-ขวา">${ICON.cols}</button>
            <button data-mode="rows" title="แยกบน-ล่าง">${ICON.rows}</button>
          </div>
          <label><input type="checkbox" id="follow" checked> follow</label>
          <button class="tbtn" id="logclear">ล้าง</button>
        </div>
        <div class="term-body" id="termbody"></div>
      </div>`;

    attachTerm(s.name);
  }

  // ------------------------------------------------------------ refresh --
  async function refresh() {
    if (!root) return;
    try {
      const list = await api('/api/stacks');
      const prev = Object.fromEntries(stacks.map((s) => [s.name, s.panes]));
      stacks = list.map((s) => ({ ...s, panes: prev[s.name] }));
      if (pendingSelect && stacks.some((s) => s.name === pendingSelect)) { selected = pendingSelect; }
      pendingSelect = null;
      if (!selected || !stacks.some((s) => s.name === selected)) selected = stacks[0]?.name ?? null;
      if (selected) await ensurePanes(selected);
      render();
    } catch (e) {
      toast('โหลดรายการ stack ไม่ได้', { detail: e.message, kind: 'bad' });
    }
  }

  async function ensurePanes(name) {
    const s = stacks.find((x) => x.name === name);
    if (!s || s.panes) return;
    try {
      const d = await api(`/api/stack/${encodeURIComponent(name)}`);
      s.panes = d.panes || []; s.envFile = d.envFile; s.editable = d.editable; s.file = d.file;
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
  const DONE = { up: 'รันแล้ว', down: 'หยุดแล้ว', restart: 'รีสตาร์ทแล้ว' };
  async function act(name, verb) {
    busy.add(name); render();
    try {
      const r = await api(`/api/${verb}/${encodeURIComponent(name)}`, 'POST');
      toast(`${DONE[verb]} · ${name}`, { cli: `nk ${verb} ${name}`, kind: r.ok ? 'good' : 'bad', detail: r.ok ? '' : r.output });
    } catch (e) {
      toast(`${verb} ${name} ไม่สำเร็จ`, { detail: e.message, kind: 'bad' });
    } finally { busy.delete(name); await refresh(); }
  }
  async function adoptPorts(name) {
    busy.add(name); render();
    try {
      const r = await api(`/api/adopt/${encodeURIComponent(name)}`, 'POST');
      toast(r.output, { kind: 'good', cli: `nk ports ${name}` });
      const s = stacks.find((x) => x.name === name); if (s) s.panes = undefined;
    } catch (e) { toast('จำ port ไม่ได้', { detail: e.message, kind: 'bad' }); }
    finally { busy.delete(name); await refresh(); }
  }
  async function killPort(port) {
    try {
      const r = await api(`/api/kill/${port}`, 'POST');
      toast(`เคลียร์ port ${port} แล้ว`, { cli: `nk kill ${port}`, kind: r.ok ? 'good' : 'bad', detail: r.ok ? '' : r.output });
    } catch (e) { toast(`เคลียร์ port ${port} ไม่สำเร็จ`, { detail: e.message, kind: 'bad' }); }
    refresh();
  }

  // ----------------------------------------------------------- terminal --
  // tmux pipe-pane mirrors each pane into a file; the server tails those over
  // SSE, so this only appends and renders ANSI.
  let es = null, termFor = null, panes = new Map(), activePane = null;
  let termMode = 'tabs';
  try { termMode = localStorage.getItem('d3v-term') || 'tabs'; } catch {}

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
      panes = new Map(); activePane = null; termFor = name;
      es = new EventSource(`/api/stream/${encodeURIComponent(name)}`);
      es.onopen = () => setLive(true);
      es.onerror = () => setLive(false, 'หลุด — กำลังต่อใหม่');
      es.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        const fresh = !panes.has(m.pane);
        let buf = (panes.get(m.pane) || '') + m.text;
        if (buf.length > 400000) buf = buf.slice(-300000);
        panes.set(m.pane, buf);
        if (fresh) renderTerm(); else paint(m.pane);
      };
    }
    const s = stacks.find((x) => x.name === name);
    setLive(!!es && es.readyState === 1, s?.running ? undefined : 'output ครั้งล่าสุด');
    renderTerm();

    $('#logclear').onclick = () => {
      if (termMode === 'tabs') panes.set(activePane, '');
      else for (const k of panes.keys()) panes.set(k, '');
      paint();
    };
    $('#tabs').onclick = (ev) => { const b = ev.target.closest('[data-pane]'); if (b) { activePane = b.dataset.pane; renderTerm(); } };
    $('#termmode').onclick = (ev) => {
      const b = ev.target.closest('[data-mode]'); if (!b) return;
      termMode = b.dataset.mode;
      try { localStorage.setItem('d3v-term', termMode); } catch {}
      renderTerm();
    };
    $('#termbody').onclick = (ev) => {
      const clear = ev.target.closest('[data-clear]');
      if (clear) { panes.set(clear.dataset.clear, ''); paint(clear.dataset.clear); return; }
      const max = ev.target.closest('[data-max]');
      if (max) { activePane = max.dataset.max; termMode = 'tabs'; try { localStorage.setItem('d3v-term', 'tabs'); } catch {} renderTerm(); }
    };
  }

  function setLive(on, msg) {
    const el = $('#live'); if (!el) return;
    el.classList.toggle('on', on);
    $('#livetext').textContent = msg ?? (on ? 'live' : 'ไม่ได้ต่อ');
  }

  function renderTerm() {
    const body = $('#termbody'); if (!body) return;
    const names = [...panes.keys()];
    if (!activePane && names.length) activePane = names[0];
    for (const b of root.querySelectorAll('#termmode [data-mode]')) b.classList.toggle('on', b.dataset.mode === termMode);
    const tabs = $('#tabs');
    if (termMode === 'tabs' || names.length < 2) {
      tabs.hidden = false;
      tabs.innerHTML = names.map((n) => `<button data-pane="${esc(n)}" class="${n === activePane ? 'on' : ''}">${esc(n)}</button>`).join('');
      body.innerHTML = `<pre class="term" id="logtext"></pre>`;
    } else {
      tabs.hidden = true;
      body.innerHTML = `<div class="split ${termMode}">` + names.map((n) => `
        <section class="pane" data-pane="${esc(n)}">
          <header><span>${esc(n)}</span><span class="grow"></span>
            <button data-clear="${esc(n)}" title="ล้าง pane นี้">ล้าง</button>
            <button data-max="${esc(n)}" title="ขยายเต็ม">⤢</button>
          </header>
          <pre class="term" data-pre="${esc(n)}"></pre>
        </section>`).join('') + `</div>`;
    }
    paint();
  }

  function paint(only) {
    const follow = $('#follow')?.checked ?? true;
    const s = stacks.find((x) => x.name === termFor);
    const empty = () => `<div class="term-empty">${s?.running ? 'รอ output…' : `ยังไม่มี output — กด "รัน" เพื่อเริ่ม ${esc(termFor || '')}`}</div>`;
    const draw = (pre, buf) => {
      if (!pre) return;
      if (buf == null) { pre.innerHTML = empty(); return; }
      pre.innerHTML = ansiToHtml(buf);
      if (follow) pre.scrollTop = pre.scrollHeight;
    };
    const single = $('#logtext');
    if (single) { if (!only || only === activePane) draw(single, panes.get(activePane)); return; }
    for (const pre of root.querySelectorAll('[data-pre]')) {
      if (!only || pre.dataset.pre === only) draw(pre, panes.get(pre.dataset.pre));
    }
  }

  // ------------------------------------------------------------- editor --
  let dlg = null, editing = null;

  function cmdRow(label = '', cmd = '') {
    const row = document.createElement('div');
    row.className = 'cmdrow';
    row.innerHTML = `
      <input type="text" class="in mono lbl" placeholder="ชื่อ pane" value="${esc(label)}" spellcheck="false">
      <input type="text" class="in mono cmd" placeholder="เช่น make run" value="${esc(cmd)}" spellcheck="false">
      <button type="button" title="ลบแถวนี้">✕</button>`;
    row.querySelector('button').onclick = () => {
      row.remove();
      if (!$('#f-cmds').children.length) $('#f-cmds').append(cmdRow());
    };
    return row;
  }

  function openEditor(stack) {
    editing = stack ? stack.name : null;
    $('#dlgtitle').textContent = stack ? `แก้ไข ${stack.name}` : 'stack ใหม่';
    $('#f-name').value = stack ? stack.name : '';
    $('#f-name').disabled = !!stack;
    $('#f-dir').value = stack ? stack.dir : '';
    $('#f-ports').value = stack ? (stack.ports || '') : '';
    $('#f-url').value = stack ? (stack.url || '') : '';
    $('#f-env').value = stack ? (stack.envFile || '') : '';
    $('#f-delete').hidden = !(stack && stack.editable);
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
    } catch (e) { toast('เปิดแก้ไขไม่ได้', { detail: e.message, kind: 'bad' }); }
  }

  async function browse(path) {
    const b = $('#browser');
    try {
      const r = await api(`/api/browse?path=${encodeURIComponent(path)}`);
      b.innerHTML =
        (r.parent ? `<div data-go="${esc(r.parent)}">↑ ../</div>` : '') +
        `<div class="pick" data-pick="${esc(r.path)}">✓ ใช้โฟลเดอร์นี้ · ${esc(home(r.path))}</div>` +
        r.dirs.map((d) => `<div data-go="${esc(r.path.replace(/\/$/, '') + '/' + d)}">${esc(d)}/</div>`).join('');
    } catch (e) { b.innerHTML = `<div>${esc(e.message)}</div>`; }
  }

  function wireEditor() {
    dlg = $('#editor');
    $('#f-addcmd').onclick = () => $('#f-cmds').append(cmdRow());
    $('#f-cancel').onclick = () => dlg.close();
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
        name: $('#f-name').value.trim(), dir: $('#f-dir').value.trim(),
        ports: $('#f-ports').value.trim(), url: $('#f-url').value.trim(), envFile: $('#f-env').value.trim(),
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
      } catch (e) { toast('บันทึกไม่ได้', { detail: e.message, kind: 'bad' }); }
    };
    $('#f-delete').onclick = async () => {
      if (!editing || !confirm(`ลบ stack ${editing}? ไฟล์นิยามจะถูกลบ (โค้ดในโฟลเดอร์ไม่ถูกแตะ)`)) return;
      try {
        const r = await api(`/api/stack/${encodeURIComponent(editing)}`, 'DELETE');
        toast(r.output, { kind: 'good' });
        dlg.close(); selected = null; await refresh();
      } catch (e) { toast('ลบไม่ได้', { detail: e.message, kind: 'bad' }); }
    };
  }

  // ------------------------------------------------------------- wiring --
  function onClick(ev) {
    const sel = ev.target.closest('[data-select]');
    if (sel) return select(sel.dataset.select);
    if (ev.target.closest('[data-new]')) return openEditor(null);
    const kill = ev.target.closest('[data-kill]');
    if (kill) return killPort(kill.dataset.kill);
    if (ev.target.closest('[data-adopt]') && selected) return adoptPorts(selected);
    const btn = ev.target.closest('[data-act]');
    if (!btn || !selected) return;
    const verb = btn.dataset.act;
    if (verb === 'edit') return editStack(selected);
    if (verb === 'down' && !confirm(`หยุด ${selected}?`)) return;
    act(selected, verb);
  }

  // ------------------------------------------------------------- module --
  D3v.register({
    id: 'stacks',
    label: 'Stacks',
    icon: D3v.icons.stack,
    mount(el, param) {
      root = el; $ = (s) => root.querySelector(s);
      root.innerHTML = SHELL;
      pendingSelect = param || null;
      wireEditor();
      root.addEventListener('click', onClick);
      onKey = (ev) => {
        if (dlg.open || ev.target.matches('input')) return;
        const i = stacks.findIndex((s) => s.name === selected);
        if (ev.key === 'ArrowDown' && i < stacks.length - 1) select(stacks[i + 1].name);
        if (ev.key === 'ArrowUp' && i > 0) select(stacks[i - 1].name);
      };
      document.addEventListener('keydown', onKey);
      timer = setInterval(() => { if (!document.hidden && !dlg.open) refresh(); }, 4000);
      refresh();
    },
    navigate(param) { if (param && param !== selected) select(param); },
    refresh,
    unmount() {
      clearInterval(timer); timer = null;
      document.removeEventListener('keydown', onKey);
      if (es) { es.close(); es = null; }
      termFor = null; panes = new Map(); activePane = null;
      D3v.setActions('');
      root = null; $ = null;
    },
  });
})();
