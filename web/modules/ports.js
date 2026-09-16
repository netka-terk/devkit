// D3v · Ports — every port the stacks declare or were seen using, who holds it now.
(() => {
  const { api, toast, esc, t } = D3v;
  let root = null, timer = null;

  // rowsFrom — one row per port that is actually in use. A port declared by
  // several stacks but held by one running stack belongs to that stack; the
  // others are only noted, so "clear" never points at a process nk started.
  function rowsFrom(stacks) {
    const byPort = new Map();
    const add = (port, s, p, kind) => {
      const r = byPort.get(port) || { port, pid: null, holder: null, owner: null, declared: [], kind: 'declared' };
      if (kind === 'declared') r.declared.push(s.name);
      if (p.pid != null) { r.pid = p.pid; r.holder = p.holder; }
      // The running stack that declares or was seen using the port owns it.
      if (s.running && p.pid != null && !r.owner) { r.owner = s.name; r.kind = kind; }
      byPort.set(port, r);
    };
    for (const s of stacks) {
      for (const p of s.ports) add(p.port, s, p, 'declared');
      for (const p of (s.detected || [])) add(p.port, s, p, 'detected');
    }
    return [...byPort.values()]
      .filter((r) => r.pid != null)
      .map((r) => ({ ...r, stack: r.owner || r.declared[0] || null,
                     others: r.declared.filter((n) => n !== (r.owner || r.declared[0])) }))
      .sort((a, b) => a.port - b.port);
  }

  function state(r) {
    if (r.owner) return `<span class="st-pill good"><span class="dot"></span>${t('po.bynk')}</span>`;
    return `<span class="st-pill warn"><span class="dot"></span>${t('po.held')}</span>`;
  }

  function render(stacks) {
    const rows = rowsFrom(stacks);
    const held = rows.filter((r) => !r.owner).length;

    root.innerHTML = `
      <div class="head">
        <h1>${t('po.title')}</h1>
        <div class="chips">
          <span class="chip"><b class="num">${rows.length}</b> ${t('po.inuse')}</span>
          ${held ? `<span class="chip warn"><b class="num">${held}</b> ${t('po.held')}</span>` : ''}
        </div>
      </div>
      <div class="panel"><div class="wrap-x"><table class="tbl">
        <thead><tr><th>${t('po.h.port')}</th><th>${t('po.h.stack')}</th><th>${t('po.h.state')}</th><th>${t('po.h.proc')}</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map((r) => `
          <tr>
            <td class="port num">:${r.port}</td>
            <td>${r.stack ? `<a class="st" href="#/stacks/${encodeURIComponent(r.stack)}">${esc(r.stack)}</a>` : '<span style="color:var(--faint)">—</span>'}
                ${r.kind === 'detected' ? `<span class="tag auto">${t('st.detected')}</span>` : ''}
                ${r.others.length ? `<span class="tag" title="${esc(t('po.also.title'))}" style="margin-left:6px">${esc(t('po.also', { names: r.others.join(', ') }))}</span>` : ''}</td>
            <td>${state(r)}</td>
            <td class="holder">${esc(r.holder)} <span class="num">· pid ${r.pid}</span></td>
            <td style="text-align:right">${!r.owner ? `<button class="btn sm danger" data-kill="${r.port}">${t('st.clear')}</button>` : ''}</td>
          </tr>`).join('') : `<tr><td colspan="5" class="empty">${t('po.empty')}</td></tr>`}
        </tbody>
      </table></div></div>`;
  }

  async function refresh() {
    if (!root) return;
    try { render(await api('/api/stacks')); }
    catch (e) { toast(t('po.load.fail'), { detail: e.message, kind: 'bad' }); }
  }

  async function onClick(ev) {
    const k = ev.target.closest('[data-kill]'); if (!k) return;
    const port = k.dataset.kill;
    try {
      const r = await api(`/api/kill/${port}`, 'POST');
      toast(t('st.kill.ok', { port }), { cli: `nk kill ${port}`, kind: r.ok ? 'good' : 'bad', detail: r.ok ? '' : r.output });
    } catch (e) { toast(t('st.kill.fail', { port }), { detail: e.message, kind: 'bad' }); }
    refresh();
  }

  D3v.register({
    id: 'ports',
    labelKey: 'menu.ports',
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
