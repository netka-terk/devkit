// D3v · Performance — what the machine is doing, and which stack is doing it.
//
// The server hands back raw counters, never rates, so this keeps the previous
// sample and divides by the elapsed time. That also gives the page its history
// for free: the last two minutes live here, not on disk.
(() => {
  const { api, toast, esc, t } = D3v;

  let root = null, timer = null, prev = null, now = null;
  const KEEP = 60;                    // samples kept — two minutes at 2s
  const hist = { cpu: [], mem: [], disk: [], net: [] };

  // ------------------------------------------------------------ numbers --
  // bytes — one decimal is all a rate deserves; more digits read as precision
  // that a 2-second window does not have.
  function bytes(n) {
    const u = ['B', 'kB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  }
  const pct = (n) => `${n.toFixed(1)}%`;
  function duration(s) {
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }
  const push = (a, v) => { a.push(v); if (a.length > KEEP) a.shift(); };

  // ------------------------------------------------------------- rates --
  // Everything the page shows, derived from the two most recent samples. A
  // stack's CPU is its share of the whole machine, the same scale the CPU tile
  // uses, so a pane at "12.5%" on eight cores is one core busy.
  function derive(a, b) {
    const dt = Math.max(0.001, b.t - a.t);
    const dTotal = b.cpu.total - a.cpu.total;
    const share = (j) => 100 * (j / b.hz) / (dt * b.cores);
    const was = new Map(a.stacks.map((s) => [s.name, s]));
    const stacks = b.stacks.map((s) => {
      const old = was.get(s.name);
      const oldPane = new Map((old?.panes || []).map((p) => [p.label, p]));
      return {
        ...s,
        cpuPct: old ? share(Math.max(0, s.cpu - old.cpu)) : 0,
        panes: s.panes.map((p) => {
          const op = oldPane.get(p.label);
          return { ...p, cpuPct: op ? share(Math.max(0, p.cpu - op.cpu)) : 0 };
        }),
      };
    });
    return {
      cpu: dTotal > 0 ? 100 * (b.cpu.busy - a.cpu.busy) / dTotal : 0,
      diskRead: Math.max(0, b.disk.read - a.disk.read) / dt,
      diskWrite: Math.max(0, b.disk.written - a.disk.written) / dt,
      netRx: Math.max(0, b.net.rx - a.net.rx) / dt,
      netTx: Math.max(0, b.net.tx - a.net.tx) / dt,
      memUsed: b.mem.total - b.mem.available,
      swapUsed: b.mem.swapTotal - b.mem.swapFree,
      stacks: stacks.sort((x, y) => y.cpuPct - x.cpuPct || y.rss - x.rss),
    };
  }

  // ------------------------------------------------------------ markup --
  // One tile per measure. Each is the stat-tile contract: a label, the value,
  // a line of context, and the trend underneath.
  const TILES = [
    { id: 'cpu', labelKey: 'pf.cpu', fixed: 100 },
    { id: 'mem', labelKey: 'pf.mem', meter: true },
    { id: 'disk', labelKey: 'pf.disk' },
    { id: 'net', labelKey: 'pf.net' },
  ];

  const SHELL = () => `
    <div class="head">
      <h1>${t('menu.perf')}</h1>
      <div class="chips" id="pf-chips"></div>
    </div>
    <div class="tiles">
      ${TILES.map((c) => `
        <section class="tile" data-tile="${c.id}">
          <div class="t-label">${t(c.labelKey)}</div>
          <div class="t-value" data-v>—</div>
          <div class="t-sub" data-sub>${t('pf.wait')}</div>
          ${c.meter ? '<div class="meter" data-meter><i></i></div>' : `
          <div class="sparkbox" data-spark>
            <svg class="spark" preserveAspectRatio="none" aria-hidden="true">
              <path class="area"></path><path class="line"></path>
            </svg>
            <span class="spark-dot" hidden></span>
            <span class="crosshair" hidden></span>
          </div>`}
        </section>`).join('')}
    </div>
    <div class="panel">
      <div class="p-head">${t('pf.stacks')} <span class="p-note">${t('pf.ofmachine')}</span></div>
      <div class="wrap-x"><table class="tbl" id="pf-table"></table></div>
    </div>`;

  // spark — a 2px line over a wash of the same hue, with the newest sample
  // marked. The path is laid out in the element's real pixels: stretching a
  // fixed viewBox would flatten the stroke and squash the end dot into an oval.
  function paintSpark(box, values, fixedMax) {
    const svg = box.querySelector('svg');
    const dot = box.querySelector('.spark-dot');
    const w = box.clientWidth || 240, h = box.clientHeight || 44;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    if (values.length < 2) { dot.hidden = true; return; }
    const max = fixedMax || Math.max(...values, 1e-9);
    const x = (i) => (i / (values.length - 1)) * w;
    const y = (v) => h - 3 - Math.min(1, v / max) * (h - 8);
    const line = 'M' + values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L');
    svg.querySelector('.line').setAttribute('d', line);
    svg.querySelector('.area').setAttribute('d', `${line}L${w},${h}L0,${h}Z`);
    // The end dot is an element rather than a <circle> so it stays round
    // whatever width the tile ends up at.
    dot.hidden = false;
    dot.style.left = `${x(values.length - 1)}px`;
    dot.style.top = `${y(values[values.length - 1])}px`;
    box.dataset.max = max;
  }

  // ------------------------------------------------------------ render --
  function render() {
    if (!root || !now) return;
    const s = now, r = prev ? derive(prev, now) : null;

    root.querySelector('#pf-chips').innerHTML = [
      `<span class="chip"><b class="num">${s.cores}</b> ${t('pf.cores')}</span>`,
      `<span class="chip"><b class="num">${bytes(s.mem.total)}</b> ${t('pf.ram')}</span>`,
      `<span class="chip"><b class="num">${bytes(s.fs.free)}</b> ${t('pf.free')}</span>`,
      `<span class="chip">${t('pf.up')} <b class="num">${duration(s.uptime)}</b></span>`,
    ].join('');

    if (r) {
      push(hist.cpu, r.cpu);
      push(hist.mem, 100 * r.memUsed / Math.max(1, s.mem.total));
      push(hist.disk, r.diskRead + r.diskWrite);
      push(hist.net, r.netRx + r.netTx);
    }

    const set = (id, value, sub) => {
      const el = root.querySelector(`[data-tile="${id}"]`);
      el.querySelector('[data-v]').innerHTML = value;
      el.querySelector('[data-sub]').innerHTML = sub;
      return el;
    };

    if (r) {
      const cpu = set('cpu', `${r.cpu.toFixed(1)}<small>%</small>`,
        `${t('pf.load')} <span class="num">${s.load[0].toFixed(2)}</span> · <span class="num">${s.procs}</span> ${t('pf.procs')}`);
      paintSpark(cpu.querySelector('[data-spark]'), hist.cpu, 100);

      const memPct = 100 * r.memUsed / Math.max(1, s.mem.total);
      const mem = set('mem', bytes(r.memUsed),
        `${t('pf.of')} ${bytes(s.mem.total)} · ${Math.round(memPct)}%` +
        (r.swapUsed > 0 ? ` · ${t('pf.swap')} ${bytes(r.swapUsed)}` : ''));
      const meter = mem.querySelector('[data-meter]');
      meter.className = `meter ${memPct > 90 ? 'bad' : memPct > 75 ? 'warn' : ''}`;
      meter.querySelector('i').style.width = `${Math.min(100, memPct)}%`;

      const disk = set('disk', bytes(r.diskRead + r.diskWrite) + '<small>/s</small>',
        `${t('pf.read')} ${bytes(r.diskRead)}/s · ${t('pf.write')} ${bytes(r.diskWrite)}/s`);
      paintSpark(disk.querySelector('[data-spark]'), hist.disk);

      const net = set('net', bytes(r.netRx + r.netTx) + '<small>/s</small>',
        `${t('pf.in')} ${bytes(r.netRx)}/s · ${t('pf.out')} ${bytes(r.netTx)}/s`);
      paintSpark(net.querySelector('[data-spark]'), hist.net);
    }

    renderTable(r);
  }

  // The bar is scaled to the whole machine, not to the busiest stack: a stack
  // using a tenth of the box should look like a tenth of the box, even when it
  // is the only one running.
  function renderTable(r) {
    const rows = (r?.stacks || []);
    const head = `<thead><tr>
      <th>${t('pf.h.stack')}</th><th>${t('pf.h.pane')}</th>
      <th style="text-align:right">${t('pf.h.cpu')}</th><th style="width:120px"></th>
      <th style="text-align:right">${t('pf.h.mem')}</th>
      <th style="text-align:right">${t('pf.h.procs')}</th>
    </tr></thead>`;
    const bar = (v) => `<div class="meter flat"><i style="width:${Math.min(100, v).toFixed(1)}%"></i></div>`;
    const body = rows.length ? rows.map((s) => `
      <tr class="pf-stack">
        <td><a class="st" href="#/stacks/${encodeURIComponent(s.name)}">${esc(s.name)}</a></td>
        <td></td>
        <td class="num" style="text-align:right">${pct(s.cpuPct)}</td>
        <td>${bar(s.cpuPct)}</td>
        <td class="num" style="text-align:right">${bytes(s.rss)}</td>
        <td class="num" style="text-align:right">${s.procs}</td>
      </tr>` + s.panes.map((p) => `
      <tr class="pf-pane">
        <td></td>
        <td class="holder">${esc(p.label)}</td>
        <td class="num" style="text-align:right">${pct(p.cpuPct)}</td>
        <td>${bar(p.cpuPct)}</td>
        <td class="num" style="text-align:right">${bytes(p.rss)}</td>
        <td class="num" style="text-align:right">${p.procs}</td>
      </tr>`).join('')).join('')
      : `<tr><td colspan="6" class="empty">${t(prev ? 'pf.none' : 'pf.wait')}</td></tr>`;
    root.querySelector('#pf-table').innerHTML = head + `<tbody>${body}</tbody>`;
  }

  // ------------------------------------------------------------- hover --
  // Reading a point off the trend without a floating box: the hairline marks
  // where the pointer is and the tile's own context line says what was there.
  function onMove(ev) {
    const box = ev.target.closest('[data-spark]'); if (!box) return;
    const id = box.closest('[data-tile]').dataset.tile;
    const values = hist[id]; if (values.length < 2) return;
    const w = box.clientWidth || 240;
    const i = Math.max(0, Math.min(values.length - 1,
      Math.round(((ev.clientX - box.getBoundingClientRect().left) / w) * (values.length - 1))));
    const cross = box.querySelector('.crosshair');
    cross.hidden = false;
    cross.style.left = `${(i / (values.length - 1)) * w}px`;
    const ago = Math.round((values.length - 1 - i) * 2);
    const v = id === 'cpu' ? pct(values[i]) : `${bytes(values[i])}/s`;
    const sub = box.closest('[data-tile]').querySelector('[data-sub]');
    sub.dataset.held = sub.dataset.held || sub.innerHTML;
    sub.innerHTML = `<span class="num">${v}</span> · ${ago ? t('pf.ago', { s: ago }) : t('pf.nowish')}`;
  }

  function onLeave(ev) {
    const box = ev.target.closest('[data-spark]'); if (!box) return;
    box.querySelector('.crosshair').hidden = true;
    const sub = box.closest('[data-tile]').querySelector('[data-sub]');
    if (sub.dataset.held) { sub.innerHTML = sub.dataset.held; delete sub.dataset.held; }
  }

  // ------------------------------------------------------------ module --
  async function refresh() {
    if (!root) return;
    try {
      const s = await api('/api/stats');
      prev = now; now = s;
      render();
    } catch (e) {
      toast(t('pf.load.fail'), { detail: e.message, kind: 'bad' });
    }
  }

  D3v.register({
    id: 'perf',
    labelKey: 'menu.perf',
    icon: D3v.icons.gauge,
    mount(el) {
      root = el;
      root.innerHTML = SHELL();
      root.addEventListener('pointermove', onMove);
      root.addEventListener('pointerleave', onLeave, true);
      // Two seconds: fast enough to watch a build start, slow enough that the
      // reading costs less than what it measures.
      timer = setInterval(() => { if (!document.hidden) refresh(); }, 2000);
      refresh();
    },
    refresh,
    unmount() {
      clearInterval(timer); timer = null;
      prev = now = null;
      for (const k of Object.keys(hist)) hist[k].length = 0;
      root = null;
    },
  });
})();
