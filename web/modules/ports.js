// D3v · Ports — every port the stacks declare or were seen using, who holds it now.
(() => {
  const { api, toast, esc } = D3v;
  let root = null, timer = null;

  function rowsFrom(stacks) {
    const rows = [];
    const declaredBy = new Map();
    for (const s of stacks) for (const p of s.ports) declaredBy.set(p.port, [...(declaredBy.get(p.port) || []), s.name]);

    for (const s of stacks) {
      const seen = new Set();
      for (const p of s.ports) {
        seen.add(p.port);
        rows.push({ port: p.port, stack: s.name, holder: p.holder, pid: p.pid, kind: 'declared',
          running: s.running, conflict: (declaredBy.get(p.port) || []).filter((n) => n !== s.name) });
      }
      for (const p of (s.detected || [])) {
        if (seen.has(p.port)) continue;
        rows.push({ port: p.port, stack: s.name, holder: p.holder, pid: p.pid, kind: 'detected', running: true, conflict: [] });
      }
    }
    return rows.sort((a, b) => a.port - b.port || a.stack.localeCompare(b.stack));
  }

  function state(r) {
    if (r.pid == null) return `<span class="st-pill muted">ว่าง</span>`;
    if (r.running) return `<span class="st-pill good"><span class="dot"></span>รันโดย nk</span>`;
    return `<span class="st-pill warn"><span class="dot"></span>ถูกจับนอก nk</span>`;
  }

  function render(stacks) {
    const rows = rowsFrom(stacks);
    const listening = rows.filter((r) => r.pid != null).length;
    const held = rows.filter((r) => r.pid != null && !r.running).length;
    const conflicts = new Set(rows.filter((r) => r.conflict.length).map((r) => r.port)).size;

    root.innerHTML = `
      <div class="head">
        <h1>Ports</h1>
        <div class="chips">
          <span class="chip"><b class="num">${listening}</b> กำลัง listen</span>
          <span class="chip"><b class="num">${rows.length}</b> รายการ</span>
          ${held ? `<span class="chip warn"><b class="num">${held}</b> ถูกจับนอก nk</span>` : ''}
          ${conflicts ? `<span class="chip warn"><b class="num">${conflicts}</b> port ประกาศซ้ำหลาย stack</span>` : ''}
        </div>
      </div>
      <div class="panel"><div class="wrap-x"><table class="tbl">
        <thead><tr><th>Port</th><th>Stack</th><th>สถานะ</th><th>Process</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map((r) => `
          <tr>
            <td class="port num">:${r.port}</td>
            <td><a class="st" href="#/stacks/${encodeURIComponent(r.stack)}">${esc(r.stack)}</a>
                ${r.kind === 'detected' ? `<span class="tag auto">เจอตอนรัน</span>` : ''}
                ${r.conflict.length ? `<span class="tag" title="ประกาศ port เดียวกัน" style="margin-left:6px;color:var(--warn)">ชนกับ ${esc(r.conflict.join(', '))}</span>` : ''}</td>
            <td>${state(r)}</td>
            <td class="holder">${r.pid != null ? `${esc(r.holder)} <span class="num">· pid ${r.pid}</span>` : '<span style="color:var(--faint)">—</span>'}</td>
            <td style="text-align:right">${r.pid != null && !r.running ? `<button class="btn sm danger" data-kill="${r.port}">เคลียร์</button>` : ''}</td>
          </tr>`).join('') : `<tr><td colspan="5" class="empty">ยังไม่มี stack ที่ประกาศหรือใช้ port</td></tr>`}
        </tbody>
      </table></div></div>`;
  }

  async function refresh() {
    if (!root) return;
    try { render(await api('/api/stacks')); }
    catch (e) { toast('โหลด port ไม่ได้', { detail: e.message, kind: 'bad' }); }
  }

  async function onClick(ev) {
    const k = ev.target.closest('[data-kill]'); if (!k) return;
    const port = k.dataset.kill;
    try {
      const r = await api(`/api/kill/${port}`, 'POST');
      toast(`เคลียร์ port ${port} แล้ว`, { cli: `nk kill ${port}`, kind: r.ok ? 'good' : 'bad', detail: r.ok ? '' : r.output });
    } catch (e) { toast(`เคลียร์ port ${port} ไม่สำเร็จ`, { detail: e.message, kind: 'bad' }); }
    refresh();
  }

  D3v.register({
    id: 'ports',
    label: 'Ports',
    icon: D3v.icons.port,
    mount(el) {
      root = el;
      root.addEventListener('click', onClick);
      timer = setInterval(() => { if (!document.hidden) refresh(); }, 4000);
      refresh();
    },
    refresh,
    unmount() { clearInterval(timer); root = null; },
  });
})();
