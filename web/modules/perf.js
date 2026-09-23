// D3v · Performance — what the machine is doing, and which stack is doing it.
//
// Four charts, each a part-to-whole over time: the height is the total and the
// bands say what it is made of. The server hands back raw counters, never
// rates, so this keeps the previous sample and divides by the elapsed time —
// which is also where the two minutes of history come from. Nothing is stored.
(() => {
  const { api, toast, esc, t } = D3v;

  let root = null, timer = null, prev = null, last = null;
  const KEEP = 60;            // frames kept — two minutes at 2s
  const frames = [];          // derived samples, oldest first

  // Categorical slots, in the order that clears every colour-blindness gate on
  // this page's own surfaces (validated for adjacent marks, which is what the
  // bands of a stack are). A hue is never generated: past the fourth stack the
  // tail folds into "other", which is grey because it is context, not an
  // identity. Slot 0 is that grey.
  const SLOTS = 4;
  const slotOf = new Map();   // stack name -> slot, fixed for the session
  function slot(name) {
    if (!slotOf.has(name)) slotOf.set(name, slotOf.size < SLOTS ? slotOf.size + 1 : 0);
    return slotOf.get(name);
  }

  // ------------------------------------------------------------ numbers --
  function bytes(n) {
    const u = ['B', 'kB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  }
  const pct = (n) => `${n.toFixed(1)}%`;
  const rate = (n) => `${bytes(n)}/s`;
  function duration(s) {
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }
  // niceMax — an axis tops out at 1, 2 or 5 times a power of ten, so the ticks
  // between it and zero are numbers a reader can hold.
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
  }

  // -------------------------------------------------------------- frame --
  // One frame is everything the four charts need at one instant, already in
  // the units they display.
  function derive(a, b) {
    const dt = Math.max(0.001, b.t - a.t);
    const dTotal = b.cpu.total - a.cpu.total;
    const share = (j) => 100 * (j / b.hz) / (dt * b.cores);
    const was = new Map(a.stacks.map((s) => [s.name, s]));
    const stacks = b.stacks.map((s) => {
      const old = was.get(s.name);
      const oldPane = new Map((old?.panes || []).map((p) => [p.label, p]));
      return {
        name: s.name, rss: s.rss, procs: s.procs,
        cpuPct: old ? share(Math.max(0, s.cpu - old.cpu)) : 0,
        panes: s.panes.map((p) => ({
          ...p, cpuPct: oldPane.has(p.label) ? share(Math.max(0, p.cpu - oldPane.get(p.label).cpu)) : 0,
        })),
      };
    });
    const cpu = dTotal > 0 ? 100 * (b.cpu.busy - a.cpu.busy) / dTotal : 0;
    const memUsed = b.mem.total - b.mem.available;
    // What is left after the stacks is everything else on the machine. RSS
    // counts shared pages once per process, so the stacks can add up to more
    // than the total; the remainder is clamped rather than drawn negative.
    const sum = (f) => stacks.reduce((n, s) => n + f(s), 0);
    return {
      t: b.t, stacks,
      cpu, cpuOther: Math.max(0, cpu - sum((s) => s.cpuPct)),
      memUsed, memTotal: b.mem.total, memOther: Math.max(0, memUsed - sum((s) => s.rss)),
      swapUsed: b.mem.swapTotal - b.mem.swapFree,
      diskRead: Math.max(0, b.disk.read - a.disk.read) / dt,
      diskWrite: Math.max(0, b.disk.written - a.disk.written) / dt,
      netRx: Math.max(0, b.net.rx - a.net.rx) / dt,
      netTx: Math.max(0, b.net.tx - a.net.tx) / dt,
    };
  }

  // ------------------------------------------------------------- charts --
  // Each chart says how to read a frame. Bands are listed bottom to top, and
  // the order is stable so a band never swaps places as the numbers move.
  const CHARTS = [
    {
      id: 'cpu', labelKey: 'pf.cpu', fmt: pct,
      max: () => 100,                                   // a quiet machine looks quiet
      bands: (f) => byStack(f, (s) => s.cpuPct, f.cpuOther),
    },
    {
      id: 'mem', labelKey: 'pf.mem', fmt: bytes,
      max: (f) => f.memTotal,                           // headroom is part of the answer
      bands: (f) => byStack(f, (s) => s.rss, f.memOther),
    },
    {
      id: 'disk', labelKey: 'pf.disk', fmt: rate,
      bands: (f) => [
        { key: 'read', labelKey: 'pf.read', slot: 1, value: f.diskRead },
        { key: 'write', labelKey: 'pf.write', slot: 2, value: f.diskWrite },
      ],
    },
    {
      id: 'net', labelKey: 'pf.net', fmt: rate,
      bands: (f) => [
        { key: 'in', labelKey: 'pf.in', slot: 1, value: f.netRx },
        { key: 'out', labelKey: 'pf.out', slot: 2, value: f.netTx },
      ],
    },
  ];

  // total — always the sum of the bands actually drawn, so the headline figure
  // and the height of the stack can never tell different stories.
  const total = (chart, f) => chart.bands(f).reduce((n, b) => n + b.value, 0);

  // byStack — one band per stack that has a colour slot, then everything else.
  // Stacks sort by name, never by size: a band that changes place when the
  // numbers move is a band nobody can follow.
  function byStack(f, value, other) {
    const bands = [...f.stacks]
      .filter((s) => slot(s.name) > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ key: s.name, label: s.name, slot: slot(s.name), value: value(s) }));
    const folded = f.stacks.filter((s) => slot(s.name) === 0).reduce((n, s) => n + value(s), 0);
    bands.push({ key: '__other', labelKey: 'pf.other', slot: 0, value: other + folded });
    return bands;
  }

  // keysOf — every band a chart has shown in the window, so a stack that has
  // stopped still has its (now zero) band and the colours do not shift.
  function keysOf(chart) {
    const seen = new Map();
    for (const f of frames) for (const b of chart.bands(f)) if (!seen.has(b.key)) seen.set(b.key, b);
    return [...seen.values()];
  }

  // ------------------------------------------------------------- markup --
  const SHELL = () => `
    <div class="head">
      <h1>${t('menu.perf')}</h1>
      <div class="chips" id="pf-chips"></div>
    </div>
    <div class="charts">
      ${CHARTS.map((c) => `
        <section class="panel chart" data-chart="${c.id}">
          <div class="c-head">
            <span class="c-title">${t(c.labelKey)}</span>
            <span class="c-value" data-total>—</span>
          </div>
          <div class="c-legend" data-legend></div>
          <div class="c-plot" data-plot>
            <svg aria-hidden="true"></svg>
            <div class="c-empty" data-empty>${t('pf.wait')}</div>
            <span class="crosshair" hidden></span>
            <div class="ct" data-tip hidden></div>
          </div>
        </section>`).join('')}
    </div>
    <div class="panel">
      <div class="p-head">${t('pf.stacks')} <span class="p-note">${t('pf.ofmachine')}</span></div>
      <div class="wrap-x"><table class="tbl" id="pf-table"></table></div>
    </div>`;

  // ------------------------------------------------------------ drawing --
  const PAD = { l: 52, r: 10, t: 10, b: 20 };

  // paint — the bands of one chart, stacked from the baseline up. A 2px stroke
  // in the surface colour runs along each boundary: the gap is what separates
  // two fills, never a border drawn around one.
  function paint(el, chart) {
    const plot = el.querySelector('[data-plot]');
    const svg = plot.querySelector('svg');
    const keys = keysOf(chart);
    el.querySelector('[data-empty]').hidden = frames.length >= 2;
    if (frames.length < 2) { svg.innerHTML = ''; return; }

    const W = plot.clientWidth || 420, H = plot.clientHeight || 168;
    const pw = Math.max(1, W - PAD.l - PAD.r), ph = Math.max(1, H - PAD.t - PAD.b);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    // Each frame's bands, in the chart's fixed key order.
    const rows = frames.map((f) => {
      const m = new Map(chart.bands(f).map((b) => [b.key, b.value]));
      return keys.map((k) => Math.max(0, m.get(k.key) || 0));
    });
    const peak = Math.max(...rows.map((r) => r.reduce((a, b) => a + b, 0)), 0);
    const max = chart.max ? chart.max(frames[frames.length - 1]) : niceMax(peak) || 1;

    const x = (i) => PAD.l + (i / Math.max(1, frames.length - 1)) * pw;
    const y = (v) => PAD.t + ph - Math.min(1, v / max) * ph;

    // Gridlines and their ticks: hairline, solid, one step off the surface.
    let out = '';
    for (const frac of [0, 0.5, 1]) {
      const gy = PAD.t + ph - frac * ph;
      out += `<line class="grid" x1="${PAD.l}" y1="${gy.toFixed(1)}" x2="${W - PAD.r}" y2="${gy.toFixed(1)}"/>`;
      out += `<text class="tick" x="${PAD.l - 8}" y="${(gy + 3.5).toFixed(1)}" text-anchor="end">${esc(chart.fmt(max * frac))}</text>`;
    }

    // Bands, bottom to top. The boundary between two of them is drawn once, in
    // the surface colour, so neighbouring fills never touch.
    const below = new Array(frames.length).fill(0);
    keys.forEach((k, ki) => {
      const top = rows.map((r, i) => below[i] + r[ki]);
      const upper = top.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      const lower = below.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse();
      out += `<path class="band" style="fill:var(--s${k.slot})" d="M${upper.join('L')}L${lower.join('L')}Z"/>`;
      if (ki > 0) out += `<path class="seam" d="M${lower.slice().reverse().join('L')}"/>`;
      for (let i = 0; i < below.length; i++) below[i] = top[i];
    });

    // Time runs left to right; only the ends are labelled, because the points
    // between them are what the crosshair is for.
    const span = Math.round(frames[frames.length - 1].t - frames[0].t);
    out += `<text class="tick" x="${PAD.l}" y="${H - 6}">-${span >= 60 ? `${Math.round(span / 60)}m` : `${span}s`}</text>`;
    out += `<text class="tick" x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${esc(t('pf.nowish'))}</text>`;
    svg.innerHTML = out;
    plot.dataset.w = W;
  }

  // legend — always present, and each entry carries its current value. That is
  // also the relief for the two lighter hues, which sit under 3:1 on the light
  // surface: nothing here is identified by colour alone.
  function legend(el, chart, f) {
    const now = new Map(chart.bands(f).map((b) => [b.key, b]));
    el.querySelector('[data-legend]').innerHTML = keysOf(chart).map((k) => {
      const b = now.get(k.key);
      return `<span class="lg"><i style="background:var(--s${k.slot})"></i>${esc(k.label || t(k.labelKey))}
        <b class="num">${esc(chart.fmt(b ? b.value : 0))}</b></span>`;
    }).join('');
  }

  // ------------------------------------------------------------- render --
  function render() {
    if (!root || !last) return;
    root.querySelector('#pf-chips').innerHTML = [
      `<span class="chip"><b class="num">${last.cores}</b> ${t('pf.cores')}</span>`,
      `<span class="chip"><b class="num">${bytes(last.mem.total)}</b> ${t('pf.ram')}</span>`,
      `<span class="chip"><b class="num">${bytes(last.fs.free)}</b> ${t('pf.free')}</span>`,
      `<span class="chip">${t('pf.up')} <b class="num">${duration(last.uptime)}</b></span>`,
      `<span class="chip">${t('pf.load')} <b class="num">${last.load[0].toFixed(2)}</b></span>`,
      `<span class="chip"><b class="num">${last.procs}</b> ${t('pf.procs')}</span>`,
    ].join('');

    const f = frames[frames.length - 1];
    for (const chart of CHARTS) {
      const el = root.querySelector(`[data-chart="${chart.id}"]`);
      el.querySelector('[data-total]').textContent = f ? chart.fmt(total(chart, f)) : '—';
      if (f) { legend(el, chart, f); paint(el, chart); }
    }
    renderTable(f);
  }

  // The bar is measured against the whole machine, never against the busiest
  // stack: a tenth of the box should look like a tenth even when it is alone.
  function renderTable(f) {
    const rows = [...(f?.stacks || [])].sort((a, b) => b.cpuPct - a.cpuPct || b.rss - a.rss);
    const bar = (v) => `<div class="meter flat"><i style="width:${Math.min(100, v).toFixed(1)}%"></i></div>`;
    const head = `<thead><tr>
      <th>${t('pf.h.stack')}</th><th>${t('pf.h.pane')}</th>
      <th style="text-align:right">${t('pf.h.cpu')}</th><th style="width:110px"></th>
      <th style="text-align:right">${t('pf.h.mem')}</th>
      <th style="text-align:right">${t('pf.h.procs')}</th>
    </tr></thead>`;
    const body = rows.length ? rows.map((s) => `
      <tr class="pf-stack">
        <td><i class="lgd" style="background:var(--s${slot(s.name)})"></i><a class="st" href="#/stacks/${encodeURIComponent(s.name)}">${esc(s.name)}</a></td>
        <td></td>
        <td class="num" style="text-align:right">${pct(s.cpuPct)}</td>
        <td>${bar(s.cpuPct)}</td>
        <td class="num" style="text-align:right">${bytes(s.rss)}</td>
        <td class="num" style="text-align:right">${s.procs}</td>
      </tr>` + s.panes.map((p) => `
      <tr class="pf-pane">
        <td></td><td class="holder">${esc(p.label)}</td>
        <td class="num" style="text-align:right">${pct(p.cpuPct)}</td>
        <td>${bar(p.cpuPct)}</td>
        <td class="num" style="text-align:right">${bytes(p.rss)}</td>
        <td class="num" style="text-align:right">${p.procs}</td>
      </tr>`).join('')).join('')
      : `<tr><td colspan="6" class="empty">${t(frames.length ? 'pf.none' : 'pf.wait')}</td></tr>`;
    root.querySelector('#pf-table').innerHTML = head + `<tbody>${body}</tbody>`;
  }

  // -------------------------------------------------------------- hover --
  // A crosshair on the sample under the pointer and every band's value at that
  // moment. The whole plot is the target, so nothing has to be hit precisely.
  function onMove(ev) {
    const plot = ev.target.closest('[data-plot]'); if (!plot || frames.length < 2) return;
    const el = plot.closest('[data-chart]');
    const chart = CHARTS.find((c) => c.id === el.dataset.chart);
    const box = plot.getBoundingClientRect();
    const W = plot.clientWidth || +plot.dataset.w || 420;
    const pw = Math.max(1, W - PAD.l - PAD.r);
    const i = Math.max(0, Math.min(frames.length - 1,
      Math.round(((ev.clientX - box.left - PAD.l) / pw) * (frames.length - 1))));
    const f = frames[i];
    const cross = plot.querySelector('.crosshair');
    const px = PAD.l + (i / Math.max(1, frames.length - 1)) * pw;
    cross.hidden = false;
    cross.style.left = `${px}px`;

    const ago = Math.round(frames[frames.length - 1].t - f.t);
    const now = new Map(chart.bands(f).map((b) => [b.key, b]));
    const tip = plot.querySelector('[data-tip]');
    tip.innerHTML = `<div class="ct-t">${ago ? t('pf.ago', { s: ago }) : t('pf.nowish')}
        · <b class="num">${esc(chart.fmt(total(chart, f)))}</b></div>` +
      keysOf(chart).map((k) => {
        const b = now.get(k.key);
        return `<div class="ct-r"><i style="background:var(--s${k.slot})"></i>${esc(k.label || t(k.labelKey))}
          <b class="num">${esc(chart.fmt(b ? b.value : 0))}</b></div>`;
      }).join('');
    tip.hidden = false;
    // Flip to the other side of the crosshair rather than run off the plot.
    tip.style.left = `${px > W / 2 ? Math.max(4, px - tip.offsetWidth - 12) : px + 12}px`;
  }

  function onLeave(ev) {
    const plot = ev.target.closest('[data-plot]'); if (!plot) return;
    plot.querySelector('.crosshair').hidden = true;
    plot.querySelector('[data-tip]').hidden = true;
  }

  // ------------------------------------------------------------- module --
  async function refresh() {
    if (!root) return;
    try {
      const s = await api('/api/stats');
      prev = last; last = s;
      if (prev) {
        frames.push(derive(prev, last));
        if (frames.length > KEEP) frames.shift();
      }
      render();
    } catch (e) {
      toast(t('pf.load.fail'), { detail: e.message, kind: 'bad' });
    }
  }

  let onResize = null;

  D3v.register({
    id: 'perf',
    labelKey: 'menu.perf',
    icon: D3v.icons.gauge,
    mount(el) {
      root = el;
      root.innerHTML = SHELL();
      root.addEventListener('pointermove', onMove);
      root.addEventListener('pointerleave', onLeave, true);
      onResize = () => { if (last) render(); };
      addEventListener('resize', onResize);
      // Two seconds: fast enough to watch a build start, cheap enough that the
      // reading costs far less than what it is measuring.
      timer = setInterval(() => { if (!document.hidden) refresh(); }, 2000);
      refresh();
    },
    refresh,
    unmount() {
      clearInterval(timer); timer = null;
      removeEventListener('resize', onResize); onResize = null;
      prev = last = null;
      frames.length = 0;
      root = null;
    },
  });
})();
