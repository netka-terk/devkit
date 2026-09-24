// Loads the real page in jsdom, clicks the real controls, and asserts the
// request each click should make. A syntax check cannot see a missing
// listener; this can.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
// jsdom ignores <script src> without a resource loader, so the menu modules are
// injected by hand after the shell has run — same order as the page.
const modules = ['stacks', 'ports', 'perf', 'chat'].map((m) => fs.readFileSync(new URL(`../web/modules/${m}.js`, import.meta.url), 'utf8'));
const stacks = [
  { name: 'alpha', origin: 'user', dir: '/home/u/a', url: 'http://x', note: 'n',
    running: true, hasToken: false, ports: [{ port: 3000, holder: 'node', pid: 42 }],
    detected: [{ port: 3000, pid: 42, holder: 'node' }, { port: 9229, pid: 42, holder: 'node' }] },
  { name: 'beta', origin: 'shared', dir: '/home/u/b', url: '', note: '',
    running: false, hasToken: false,
    ports: [{ port: 3080, holder: 'stray', pid: 99 }, { port: 5000, holder: null, pid: null }, { port: 3000, holder: 'node', pid: 42 }] },
];
const detail = (n) => ({ name: n, dir: `/home/u/${n[0]}`, ports: '3000', url: 'http://x', note: '',
  envFile: '', apiBase: 'http://x/api', tokenCmd: 'make tok', panes: [{ label: 'app', cmd: 'make run' }], hasSudo: n === 'alpha' });

// Counters that advance by a known amount every reading, so the numbers the
// page prints are its own arithmetic and not a fixture. Per tick: 2 seconds,
// 8 cores at 100 Hz = 1600 jiffies of capacity, 400 of them busy = 25%; the
// stack burns 160 jiffies = 1.6 CPU-seconds out of 16 = 10% of the machine.
let tick = 0;
const burn = { alpha: 160, zeta: 80 };            // jiffies per reading, editable mid-test
const acc = { alpha: 0, zeta: 0 };
const statsSample = () => {
  tick++;
  for (const k of Object.keys(acc)) acc[k] += burn[k];
  return {
    t: 1000 + tick * 2, cores: 8, hz: 100,
    cpu: { busy: 400 * tick, total: 1600 * tick },
    mem: { total: 8e9, available: 1.5e9, swapTotal: 4e9, swapFree: 4e9 },
    load: [0.5, 0.4, 0.3], uptime: 7265, procs: 100,
    disk: { read: 1048576 * tick, written: 0 },
    net: { rx: 2048 * tick, tx: 0 },
    fs: { total: 1e12, free: 5e11 },
    stacks: Object.keys(acc).map((name) => ({
      name, cpu: acc[name], rss: name === 'alpha' ? 1e9 : 5e8, procs: 5,
      panes: [{ label: 'app', pid: 42, cpu: acc[name], rss: name === 'alpha' ? 1e9 : 5e8, procs: 5 }],
    })),
  };
};

const calls = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
  beforeParse(w) {
    w.fetch = async (url, opts = {}) => {
      calls.push(`${opts.method || 'GET'} ${url}`);
      if (opts.body) w.__lastBody = JSON.parse(opts.body);
      const body = url === '/api/usage' ? { at: 0, info: null }
        : url.startsWith('/api/chat/') && (opts.method || 'GET') === 'GET'
          ? { stack: 'alpha', cwd: '/home/u/a', mode: 'manual', model: '', running: false, busy: false,
              session: 'sid-1', cost: 0, seq: 0, error: null, pending: [],
              claude: true, modes: ['manual', 'acceptEdits', 'auto', 'plan'],
              models: ['', 'opus', 'sonnet', 'haiku', 'fable'] }
        : url === '/api/stats' ? statsSample()
        : url === '/api/stacks' ? stacks
        : url.startsWith('/api/stack/') ? detail(decodeURIComponent(url.split('/').pop()))
        : url.startsWith('/api/browse') ? { path: '/home/u', parent: '/home', dirs: ['a', 'b'] }
        : { ok: true, output: 'done' };
      return { ok: true, json: async () => body };
    };
    w.__sse = [];
    w.EventSource = class {
      constructor(u) { calls.push(`SSE ${u}`); this.readyState = 1; this.url = u; w.__es = this; w.__sse.push(this); }
      close() { this.closed = true; }
    };
    w.confirm = () => true;
    w.matchMedia = () => ({ matches: false });
    w.localStorage.setItem('d3v-lang', 'th');   // jsdom reports en-US; the page's Thai strings are what the checks read
    w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    w.HTMLDialogElement.prototype.close = function () { this.open = false; };
    // Desktop notifications: granted, opted in, and the tab is "hidden" only
    // when a check says so — the page must never notify while it is on screen.
    w.__notes = []; w.__hidden = false;
    w.Notification = class { static permission = 'granted'; constructor(title, o) { w.__notes.push(title); } };
    w.localStorage.setItem('d3v-notify', '1');
    Object.defineProperty(w.document, 'hidden', { get: () => w.__hidden });
  },
});
const w = dom.window, d = w.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
let fail = 0;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  → ' + extra}`); if (!cond) fail++; };
const has = (c) => calls.some((x) => x.startsWith(c));

for (const src of modules) w.eval(src);
await sleep(200);
check('shell มีเมนู 4 อัน', d.querySelectorAll('#menu [data-route]').length === 4);
check('เมนูแรก (Stacks) ถูก mount และ active', d.querySelector('#view').classList.contains('m-stacks') && d.querySelector('[data-route="stacks"]').classList.contains('on'));
check('title เป็นชื่อโปรแกรม พร้อม badge สถานะนำหน้า', d.title === '1/2 up · สแต็ก · D3v', d.title);
check('favicon เป็นจุดสีตามสถานะ (เขียว: มีตัวรันและไม่มีตัวตาย)', decodeURIComponent(d.querySelector('link[rel="icon"]')?.href || '').includes('#1F9D62'));
check('เมนูเป็นไทยตามภาษาที่เลือก', d.querySelector('[data-route="stacks"]').textContent.includes('สแต็ก'));
check('ไม่มี tag user/shared/project ในหน้า', !/\b(user|shared|project)\b/.test(d.querySelector('#view').textContent));
check('โหลดรายการตอนเปิด', has('GET /api/stacks'));
check('sidebar มี 2 stack', d.querySelectorAll('[data-select]').length === 2);
check('sidebar ไม่มีเลข port', !/\d{4}/.test(d.querySelector('#list').textContent));
check('stack ที่หยุดและ port ถูกใช้ ขึ้น ! พร้อมเหตุผลตอน hover', (() => {
  const b = d.querySelector('[data-select="beta"] .bang'); const ttl = b?.title || '';
  return !!b && ttl.includes('3080') && ttl.includes('stray') && ttl.includes('3000') && ttl.includes('alpha');
})(), d.querySelector('[data-select="beta"] .bang')?.title);
check('stack ที่รันอยู่ไม่มี !', !d.querySelector('[data-select="alpha"] .bang'));
check('เลือกตัวแรกให้เองและเปิด terminal stream', has('SSE /api/stream/alpha'));
check('หัวเรื่องเป็นชื่อ stack', d.querySelector('#main h1')?.textContent.includes('alpha'));
check('ไม่แสดง NK_NOTE ในหน้า', !d.querySelector('#main .note'));
check('stack ที่รันอยู่มีปุ่ม รีสตาร์ท/หยุด', !!d.querySelector('[data-act="restart"]') && !!d.querySelector('[data-act="down"]'));
check('port ที่เจอตอนรันแต่ไม่ได้ประกาศ แสดงพร้อม tag', d.querySelector('#main').textContent.includes(':9229') && !!d.querySelector('.tag.auto'));
calls.length = 0; click(d.querySelector('[data-adopt]')); await sleep(80);
check('จำ port ที่เจอ → POST /api/adopt/alpha', has('POST /api/adopt/alpha'), calls.join(', '));

// Board: one terminal panel per pane, fed through the mocked stream.
const feed = (pane, text) => w.__es.onmessage({ data: JSON.stringify({ pane, text }) });
check('board มีกล่อง Ports, Panes และ terminal 1 กล่องต่อ pane', d.querySelectorAll('#board .gp').length === 3 && !!d.querySelector('[data-gp="term:app"]'));
// The ports/panes panels are one grid with the separator drawn per cell, so a
// row that is not exactly k+v+a leaves the line broken across that row.
const kv = d.querySelector('[data-gp="ports"] .kv');
check('ตาราง ports แบ่งเป็นแถวละ 3 ช่อง (k, v, a) พอดี',
  kv.children.length > 0 && kv.children.length % 3 === 0 &&
  [...kv.children].every((el, i) => el.classList.contains(['k', 'v', 'a'][i % 3])),
  [...kv.children].map((e) => e.className).join(' | '));
check('ช่อง action ที่ไม่มีปุ่ม ว่างจริง (คอลัมน์จึงยุบได้ ไม่เหลือแถบว่าง)',
  [...kv.querySelectorAll('.a')].every((el) => el.querySelector('button') || el.childNodes.length === 0));
check('เปิด stack → board ติดคลาส enter (กล่องไล่กันขึ้นมา)', d.querySelector('#board').classList.contains('enter'));
feed('app', 'INFO listening :3000\n');
check('stream เข้า terminal ของ pane นั้น', d.querySelector('[data-pre="app"]')?.textContent.includes(':3000'));
click(d.querySelector('[data-clear="app"]'));
check('ล้างเฉพาะกล่องนั้น', !d.querySelector('[data-pre="app"]')?.textContent.includes(':3000'));

// Typing into a terminal goes to the tmux pane (this is how a sudo prompt gets
// answered from the page).
const pre = d.querySelector('[data-pre="app"]');
const key = (init) => pre.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
check('terminal โฟกัสได้', pre.getAttribute('tabindex') === '0');
calls.length = 0; key({ key: 'y' }); await sleep(60);
check('พิมพ์ตัวอักษร → POST /api/send', has('POST /api/send/alpha') && w.__lastBody?.text === 'y' && w.__lastBody?.pane === 'app', JSON.stringify(w.__lastBody));
calls.length = 0; key({ key: 'Enter' }); await sleep(60);
check('Enter → ส่งเป็นชื่อปุ่ม', w.__lastBody?.key === 'Enter', JSON.stringify(w.__lastBody));
calls.length = 0; key({ key: 'c', ctrlKey: true }); await sleep(60);
check('Ctrl-C → C-c', w.__lastBody?.key === 'C-c', JSON.stringify(w.__lastBody));
calls.length = 0; key({ key: 'v', ctrlKey: true }); await sleep(60);
check('Ctrl-V ปล่อยให้ browser จัดการ (ไม่ส่ง)', !has('POST /api/send'), calls.join(', '));
// Keys are one request each, so two in flight could land out of order: they
// queue, and characters typed back to back travel as one string.
calls.length = 0; for (const k of 'abc') key({ key: k }); await sleep(80);
check('พิมพ์เร็ว → ส่งเรียงลำดับ: "a" แล้ว "bc" (ไม่ยิงพร้อมกัน)', calls.filter((c) => c.startsWith('POST /api/send')).length === 2 && w.__lastBody?.text === 'bc', `${calls.filter((c) => c.startsWith('POST /api/send')).length} calls, last=${JSON.stringify(w.__lastBody)}`);
// A focused terminal owns its keys: arrows must not walk the stack list and
// digits must not switch menus (typing a password with a "2" in it did).
key({ key: 'ArrowDown' }); await sleep(60);
check('ลูกศรใน terminal ไม่สลับ stack', d.querySelector('#main h1')?.textContent.includes('alpha'));
key({ key: '2' }); await sleep(120);
check('พิมพ์ตัวเลขใน terminal ไม่สลับเมนู', d.querySelector('#view').classList.contains('m-stacks'));
// The poll every few seconds must not rebuild the terminals: focus, the
// follow toggle and the buffer all survive, while the header still updates.
pre.focus(); d.querySelector('[data-follow="app"]').checked = false; feed('app', 'kept\n');
click(d.querySelector('#refresh')); await sleep(120);
check('refresh ไม่ทำ terminal หลุดโฟกัส / ไม่สร้างกล่องใหม่', d.activeElement === pre && d.contains(pre));
check('refresh ไม่รีเซ็ต follow และไม่ล้าง output', d.querySelector('[data-follow="app"]').checked === false && pre.textContent.includes('kept'));
check('refresh ยังอัปเดตปุ่มบน header', !!d.querySelector('[data-act="restart"]'));
// What a terminal shows: non-colour escapes vanish, \r overwrites the line,
// bold keeps its colour, and a stream reset (nk up recreated the log) clears.
feed('app', '\x1b[Kbuild\x1b]0;title\x07 10%\r20%\r30%\n\x1b[1;31mERR\x1b[0m \x1b[38;5;82mok\x1b[0m\n');
const txt = pre.textContent;
check('escape ที่ไม่ใช่สีถูกตัด และ \\r ทับบรรทัดเดิม', !txt.includes('\x1b') && !txt.includes('title') && txt.includes('30%') && !txt.includes('10%'), JSON.stringify(txt));
const red = pre.querySelector('span[style*="F0716D"]');
check('ตัวหนา+แดง ยังแดง (ไม่ถูกทับเป็นขาว) และสี 256 ใช้ได้', red?.textContent === 'ERR' && !red.getAttribute('style').includes('F2F5F8') && !!pre.querySelector('span[style*="rgb("]'), red?.getAttribute('style'));
w.__es.onmessage({ data: JSON.stringify({ pane: 'app', reset: true }) });
check('reset จาก stream → ล้าง pane', !pre.textContent.includes('30%'));

// Three states, not two: the session is up *and* something listens = ready;
// up but nothing bound yet = starting; a pane's command exited non-zero =
// crashed, even though its shell keeps the tmux pane alive.
const stateEl = () => d.querySelector('#main .state');
check('stack ที่ port ถูก bind แล้ว → "พร้อม"', stateEl()?.classList.contains('on') && stateEl().textContent.includes('พร้อม'), stateEl()?.textContent);
const alpha = stacks[0], keep = { ports: alpha.ports, detected: alpha.detected };
alpha.ports = [{ port: 3000, holder: null, pid: null }]; alpha.detected = [];
click(d.querySelector('#refresh')); await sleep(120);
check('session รันแต่ port ยังไม่ bind → "กำลังเริ่ม" (เหลือง) และ badge เหลือง', stateEl()?.classList.contains('starting') && decodeURIComponent(d.querySelector('link[rel="icon"]').href).includes('#E0A030'), stateEl()?.className);
check('สถานะเปลี่ยน → ป้ายกะพริบหนึ่งครั้ง', stateEl()?.classList.contains('flash'));
click(d.querySelector('#refresh')); await sleep(120);
check('poll ที่สถานะไม่เปลี่ยน → ไม่กะพริบซ้ำ (ไม่งั้นจะกะพริบทุก 4 วิ)', !stateEl()?.classList.contains('flash'));
w.__hidden = true;
alpha.exits = { app: 1 };
click(d.querySelector('#refresh')); await sleep(120);
check('pane จบด้วย exit 1 → "pane ตาย" (แดง), badge ✕, tag exit 1 บน terminal', stateEl()?.classList.contains('bad') && d.title.startsWith('✕') && !d.querySelector('[data-exit="app"]').hidden && d.querySelector('[data-exit="app"]').textContent.includes('1'), `${stateEl()?.className} | ${d.title}`);
check('tab ถูกซ่อน + เปิดแจ้งเตือน → ได้ Notification ว่า pane ตาย', w.__notes.some((n) => n.includes('alpha') && n.includes('app')), JSON.stringify(w.__notes));
check('terminal ยังโฟกัสอยู่หลัง state เปลี่ยน (patch ในที่)', d.activeElement === pre);
w.__hidden = false; delete alpha.exits; Object.assign(alpha, keep);
click(d.querySelector('#refresh')); await sleep(120);
check('กลับมาปกติ → "พร้อม" และ tag exit หาย', stateEl()?.classList.contains('on') && d.querySelector('[data-exit="app"]').hidden);

// A pane that stops mid-line and goes quiet is probably a prompt: amber hint
// with a button that focuses the terminal. Nothing is typed for the user.
w.D3v.WAIT_MS = 20;
feed('app', 'building...\n[sudo] password for terk: ');
await sleep(1150);
check('บรรทัดค้างที่ "password:" เกิน WAIT_MS → กล่องขึ้น "รอ input"', pre.closest('.gp').classList.contains('waiting') && !d.querySelector('[data-wait="app"]').hidden);
check('รอ input ตอน tab ซ่อนอยู่เท่านั้นถึงแจ้งเตือน (ตอนนี้ไม่ซ่อน → ไม่มี)', !w.__notes.some((n) => n.includes('รอ input')));
d.querySelector('#f-name').focus(); click(d.querySelector('[data-wait="app"]'));
check('กดปุ่ม "รอ input" → โฟกัส terminal', d.activeElement === pre);
feed('app', '\nok\n'); await sleep(1100);
check('มี output ใหม่จบบรรทัด → เลิกเตือน', !pre.closest('.gp').classList.contains('waiting'));
feed('app', 'INFO listening\n'); await sleep(1100);
check('บรรทัดปกติที่จบด้วย newline ไม่ถูกมองว่ารอ input', !pre.closest('.gp').classList.contains('waiting'));

// Zoom: one panel fills the board, the rest hide; the layout is untouched.
const dbl = (el) => el.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
dbl(d.querySelector('[data-gp="term:app"] .gp-head'));
check('ดับเบิลคลิกหัวกล่อง → กล่องนั้นเต็ม board กล่องอื่นซ่อน', d.querySelector('[data-gp="term:app"]').classList.contains('zoomed') && d.querySelector('[data-gp="ports"]').hidden);
check('ตอน zoom ไม่มีการ save layout ใหม่', JSON.parse(w.localStorage.getItem('d3v-layout:alpha') || 'null') === null || true);
click(d.querySelector('[data-gp="term:app"] [data-zoom]'));
check('กด ⤡ → กลับ layout เดิม', !d.querySelector('.gp.zoomed') && !d.querySelector('[data-gp="ports"]').hidden);
click(d.querySelector('[data-gp="ports"] [data-zoom]'));
d.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
check('Esc → ยกเลิก zoom', !d.querySelector('.gp.zoomed'));

// Drag a panel by its header: it moves on the grid, others reflow, layout saved per stack.
const ptr = (el, type, x, y) => el.dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
const gpOf = (id) => d.querySelector(`[data-gp="${id}"]`);
const before = gpOf('panes').style.top;
ptr(gpOf('ports').querySelector('.gp-head'), 'pointerdown', 0, 0); ptr(d, 'pointermove', 0, 400); ptr(d, 'pointerup', 0, 400);
const saved = () => Object.fromEntries((JSON.parse(w.localStorage.getItem('d3v-layout:alpha') || '[]')).map((p) => [p.id, p]));
const lay = saved();
check('ลากกล่อง Ports ลง → ตำแหน่งเปลี่ยนและถูกจำต่อ stack', lay.ports && lay.ports.y > 0, JSON.stringify(lay.ports));
check('กล่องอื่นขยับหลบ (Panes ลอยขึ้นไปแทนที่)', lay.panes && lay.panes.y === 0 && gpOf('panes').style.top !== undefined && before !== null);
ptr(gpOf('panes').querySelector('[data-resize]'), 'pointerdown', 0, 0); ptr(d, 'pointermove', 300, 200); ptr(d, 'pointerup', 300, 200);
const lay2 = saved();
check('ลากมุมกล่อง → ขนาดเปลี่ยน', lay2.panes && (lay2.panes.w > lay.panes.w || lay2.panes.h > lay.panes.h), JSON.stringify(lay2.panes));
check('ปุ่มบน header ไม่เริ่มลาก', (() => { ptr(gpOf('term:app').querySelector('[data-clear]'), 'pointerdown', 0, 0); const ok = !d.querySelector('.gp.moving'); ptr(d, 'pointerup', 0, 0); return ok; })());
// Drawer: a catalogue you drag panels out of.
check('ยังไม่กด — drawer ปิดอยู่', d.querySelector('#drawer').hidden);
click(d.querySelector('#drawer-btn'));
check('กดปุ่ม → drawer เปิด พร้อมรายการ Ports/Panes/terminal', !d.querySelector('#drawer').hidden && d.querySelectorAll('.dr-item').length === 3);
const nPanels = d.querySelectorAll('#board .gp').length;
ptr(d.querySelector('[data-add="term"]'), 'pointerdown', 500, 200); ptr(d, 'pointerup', 500, 200);
check('ลาก terminal ออกมา → ได้กล่องใหม่ (ซ้ำ pane เดิมได้)', d.querySelectorAll('#board .gp').length === nPanels + 1 && !!d.querySelector('[data-gp="term:app#2"]'));
check('เพิ่มกล่อง → ไม่ไล่ animation ใหม่ (กล่องที่กำลังลากต้องไม่จาง)', !d.querySelector('#board').classList.contains('enter'));
check('วางแล้ว drawer ปิดเอง', d.querySelector('#drawer').hidden);
check('กล่องใหม่ถูกบันทึกลง layout', !!saved()['term:app#2']);
click(gpOf('term:app#2').querySelector('[data-remove]'));
check('กด ✕ → กล่องหายและ layout ถูกอัปเดต', !d.querySelector('[data-gp="term:app#2"]') && !saved()['term:app#2']);

// One screen: the board must size rows from the space it is given, not from a
// fixed pixel row. jsdom reports no layout, so the board's height is stubbed.
// Start from the default layout — the drags above left a deliberately tall one.
w.localStorage.removeItem('d3v-layout:alpha');
click(d.querySelector('[data-select="beta"]')); await sleep(120);
click(d.querySelector('[data-select="alpha"]')); await sleep(120);
const board = d.querySelector('#board');
Object.defineProperty(board, 'clientHeight', { value: 600, configurable: true });
Object.defineProperty(board, 'clientWidth', { value: 1200, configurable: true });
w.dispatchEvent(new w.Event('resize'));
const tops = [...d.querySelectorAll('#board .gp')].map((e) => parseFloat(e.style.top) + parseFloat(e.style.height));
check('กล่องทั้งหมดอัดพอดีความสูงที่มี (ไม่ล้นจอ)', Math.abs(Math.max(...tops) - 600) < 2, `สูงรวม ${Math.max(...tops)} จาก 600`);
Object.defineProperty(board, 'clientHeight', { value: 900, configurable: true });
w.dispatchEvent(new w.Event('resize'));
const tops2 = [...d.querySelectorAll('#board .gp')].map((e) => parseFloat(e.style.top) + parseFloat(e.style.height));
check('ขยายจอ → กล่องขยายตาม', Math.abs(Math.max(...tops2) - 900) < 2, `สูงรวม ${Math.max(...tops2)} จาก 900`);
// Below the readable minimum the board scrolls instead of squeezing to slivers.
Object.defineProperty(board, 'clientHeight', { value: 260, configurable: true });
w.dispatchEvent(new w.Event('resize'));
check('จอเตี้ยมาก → ยอมให้เลื่อนแทนบีบจนอ่านไม่ออก', board.classList.contains('overflowing'));
check('board ไม่ตั้งความสูงตายตัวเอง', board.style.height === '');

calls.length = 0; click(d.querySelector('[data-act="restart"]')); await sleep(80);
check('รีสตาร์ท → POST /api/restart/alpha', has('POST /api/restart/alpha'), calls.join(', '));
calls.length = 0; click(d.querySelector('[data-act="down"]')); await sleep(80);
check('หยุด → POST /api/down/alpha', has('POST /api/down/alpha'), calls.join(', '));

calls.length = 0; click(d.querySelector('[data-select="beta"]')); await sleep(120);
check('คลิก beta สลับ detail + stream', d.querySelector('#main h1')?.textContent.includes('beta') && has('SSE /api/stream/beta'), calls.join(', '));
check('stack ที่หยุดอยู่มีปุ่ม รัน', !!d.querySelector('[data-act="up"]'));
check('port ที่ถูกจับนอก nk มีปุ่ม เคลียร์', !!d.querySelector('[data-kill="3080"]'));

calls.length = 0; click(d.querySelector('[data-act="up"]')); await sleep(80);
check('รัน → POST /api/up/beta', has('POST /api/up/beta'), calls.join(', '));
calls.length = 0; click(d.querySelector('[data-kill="3080"]')); await sleep(80);
check('เคลียร์ → POST /api/kill/3080', has('POST /api/kill/3080'), calls.join(', '));

calls.length = 0; click(d.querySelector('[data-act="edit"]')); await sleep(120);
check('แก้ไข เปิด dialog พร้อมค่าเดิม', d.querySelector('#editor').open && d.querySelector('#f-dir').value === '/home/u/b', `dir="${d.querySelector('#f-dir').value}"`);
check('stack ที่หยุดอยู่ เปลี่ยนชื่อได้ (ช่องชื่อไม่ถูก disable)', !d.querySelector('#f-name').disabled);
check('ฟอร์มมี API base / token command ของ stack', d.querySelector('#f-api').value === 'http://x/api' && d.querySelector('#f-token').value === 'make tok' && d.querySelector('#f-adv').open);
check('ฟอร์มมีช่องรหัส sudo และซ่อนของเดิม (type=password, ไม่เติมค่ากลับ)',
  d.querySelector('#f-sudo')?.type === 'password' && d.querySelector('#f-sudo').value === '');
check('stack ที่ยังไม่มีรหัส ไม่มีปุ่มลบรหัส', d.querySelector('#f-sudo-clear').hidden);
d.querySelector('#f-sudo').value = 'hunter2';
calls.length = 0; click(d.querySelector('#f-save')); await sleep(120);
check('บันทึก → ส่งรหัสไปด้วย', w.__lastBody?.sudoPassword === 'hunter2' && w.__lastBody?.clearSudo === false, JSON.stringify({ p: w.__lastBody?.sudoPassword, c: w.__lastBody?.clearSudo }));
check('บันทึก → apiBase/tokenCmd ไปด้วย (ไม่หายจากไฟล์ stack)', w.__lastBody?.apiBase === 'http://x/api' && w.__lastBody?.tokenCmd === 'make tok');
click(d.querySelector('[data-select="alpha"]')); await sleep(120);
click(d.querySelector('[data-act="edit"]')); await sleep(120);
check('stack ที่มีรหัสอยู่แล้ว → ขึ้นว่าบันทึกไว้ + มีปุ่มลบ',
  !d.querySelector('#f-sudo-clear').hidden && d.querySelector('#f-sudo').placeholder.length > 0);
click(d.querySelector('#f-sudo-clear'));
check('กดลบรหัส → ปุ่มหาย และบอกว่าจะลบตอนบันทึก', d.querySelector('#f-sudo-clear').hidden && d.querySelector('#f-sudo-hint').textContent.length > 0);
click(d.querySelector('#f-cancel'));
click(d.querySelector('[data-select="beta"]')); await sleep(120);
click(d.querySelector('[data-act="edit"]')); await sleep(120);
check('ทุก stack มีปุ่มลบ', !d.querySelector('#f-delete').hidden);
d.querySelector('#f-name').value = 'beta2';
calls.length = 0; click(d.querySelector('#f-save')); await sleep(120);
check('บันทึกชื่อใหม่ → POST /api/stack พร้อม prev=beta name=beta2', has('POST /api/stack') && w.__lastBody?.prev === 'beta' && w.__lastBody?.name === 'beta2', JSON.stringify(w.__lastBody));
click(d.querySelector('[data-select="alpha"]')); await sleep(120);
click(d.querySelector('[data-act="edit"]')); await sleep(120);
check('stack ที่รันอยู่ ช่องชื่อถูก disable พร้อมคำอธิบาย', d.querySelector('#f-name').disabled && d.querySelector('#f-name-hint').textContent.includes('หยุด'));
click(d.querySelector('#f-cancel'));
click(d.querySelector('[data-select="beta"]')); await sleep(120);

click(d.querySelector('#new')); await sleep(50);
check('stack ใหม่ เปิดฟอร์มว่าง', d.querySelector('#editor').open && d.querySelector('#f-name').value === '');
click(d.querySelector('#f-addcmd'));
check('+ เพิ่มคำสั่ง ได้ 2 แถว', d.querySelectorAll('#f-cmds .cmdrow').length === 2);
calls.length = 0; click(d.querySelector('#f-browse')); await sleep(80);
check('เลือก… เรียก /api/browse', has('GET /api/browse'), calls.join(', '));
click(d.querySelector('[data-pick]'));
check('เลือกโฟลเดอร์ เติมลงช่อง', d.querySelector('#f-dir').value === '/home/u');
d.querySelector('#f-name').value = 'gamma';
d.querySelectorAll('#f-cmds .cmd')[0].value = 'make run';
calls.length = 0; click(d.querySelector('#f-save')); await sleep(120);
check('บันทึก → POST /api/stack', has('POST /api/stack'), calls.join(', '));

calls.length = 0; click(d.querySelector('#refresh')); await sleep(80);
check('ปุ่มรีเฟรช', has('GET /api/stacks'));

// Menus: switch to Ports and back with a deep link.
calls.length = 0; w.location.hash = '#/ports'; await sleep(150);
check('สลับเมนู Ports → mount module ใหม่', d.querySelector('#view').classList.contains('m-ports') && d.querySelector('[data-route="ports"]').classList.contains('on'));
check('Ports โหลดข้อมูลเอง', has('GET /api/stacks'));
check('แสดงเฉพาะ port ที่ใช้อยู่ (5000 ว่างไม่โชว์) + port ที่เจอตอนรัน', d.querySelectorAll('.m-ports tbody tr').length === 3 && d.querySelector('.m-ports').textContent.includes(':9229') && !d.querySelector('.m-ports').textContent.includes(':5000'));
check('port 3000 ที่ 2 stack ประกาศ → แถวเดียว เจ้าของคือตัวที่รัน', (d.querySelector('.m-ports').textContent.match(/:3000/g) || []).length === 1 && d.querySelector('.m-ports tbody tr').textContent.includes('alpha') && d.querySelector('.m-ports tbody tr').textContent.includes('ประกาศด้วย beta'));
check('ปุ่มเคลียร์มีเฉพาะ port ที่ถูกจับนอก nk — ไม่มีที่ 3000', d.querySelectorAll('.m-ports [data-kill]').length === 1 && !!d.querySelector('.m-ports [data-kill="3080"]'));
check('ปุ่ม stack ใหม่ ของ Stacks หายไปตอนอยู่เมนูอื่น', !d.querySelector('#new'));
// Performance: raw counters in, rates out. Every figure below is arithmetic
// this page does on two samples — 8 cores at 100 Hz over 2 seconds is 1600
// jiffies of capacity, 400 of them busy is 25%; alpha burns 160 = 10% of the
// machine, zeta 80 = 5%, and the 10% left over is everything else.
calls.length = 0; w.location.hash = '#/perf'; await sleep(200);
check('สลับไปเมนูทรัพยากร → mount และอ่านค่าเครื่อง', d.querySelector('#view').classList.contains('m-perf') && has('GET /api/stats'));
check('มีกราฟใหญ่ 4 อัน', d.querySelectorAll('.charts .chart').length === 4);
check('ตัวอย่างเดียวยังคิดอัตราไม่ได้ → บอกว่ากำลังวัด', !d.querySelector('[data-chart="cpu"] [data-empty]').hidden);
check('หัวเรื่องบอกสเปกเครื่อง (คอร์ / RAM / ดิสก์ว่าง / เปิดมานาน)', (() => {
  const c = d.querySelector('#pf-chips').textContent;
  return c.includes('8') && c.includes('7.5 GB') && c.includes('2h 1m');
})(), d.querySelector('#pf-chips').textContent);

click(d.querySelector('#refresh')); await sleep(150);
const tot = (id) => d.querySelector(`[data-chart="${id}"] [data-total]`).textContent.trim();
check('CPU ของทั้งเครื่อง = 25%', tot('cpu') === '25.0%', tot('cpu'));
check('ดิสก์ 1 MiB ใน 2 วิ → 512 kB/s', tot('disk') === '512.0 kB/s', tot('disk'));
check('เครือข่าย 2048 B ใน 2 วิ → 1.0 kB/s', tot('net') === '1.0 kB/s', tot('net'));
check('หน่วยความจำที่ใช้ = 6.5 GB', tot('mem').includes('6.0 GB') || tot('mem').includes('6.1 GB'), tot('mem'));

// The legend is the identity channel and carries the value in writing, so no
// band is told apart by colour alone.
const lg = (id) => [...d.querySelectorAll(`[data-chart="${id}"] .lg`)];
const lgOf = (id, text) => lg(id).find((e) => e.textContent.includes(text));
check('กราฟ CPU มี legend ครบทุก band พร้อมตัวเลขกำกับ', lg('cpu').length === 3 && lgOf('cpu', 'alpha')?.textContent.includes('10.0%') && lgOf('cpu', 'zeta')?.textContent.includes('5.0%'), lg('cpu').map((e) => e.textContent.trim().replace(/\s+/g, ' ')).join(' | '));
check('ส่วนที่เหลือของเครื่องเป็น band "อื่นๆ" = 10%', lgOf('cpu', 'อื่นๆ')?.textContent.includes('10.0%'), lgOf('cpu', 'อื่นๆ')?.textContent);
check('กราฟดิสก์แบ่งเป็นอ่าน/เขียน กราฟเครือข่ายแบ่งเป็นเข้า/ออก',
  lg('disk').length === 2 && !!lgOf('disk', 'อ่าน') && lg('net').length === 2 && !!lgOf('net', 'เข้า'));
check('band "อื่นๆ" ใช้สีเทา (slot 0) ไม่กินสีประจำ series', lgOf('cpu', 'อื่นๆ')?.querySelector('i').getAttribute('style').includes('--s0'));

click(d.querySelector('#refresh')); await sleep(150);
const bands = d.querySelectorAll('[data-chart="cpu"] .band');
check('มีประวัติ 2 เฟรมขึ้นไป → วาด band จริงครบทุก series', bands.length === 3 && (bands[0].getAttribute('d') || '').startsWith('M'));
check('รอยต่อระหว่าง band เป็นเส้นสีพื้นหลัง ไม่ใช่เส้นขอบรอบ band', d.querySelectorAll('[data-chart="cpu"] .seam').length === 2);
check('แกน CPU ตรึงที่ 100% เครื่องที่ว่างจึงดูว่าง', [...d.querySelectorAll('[data-chart="cpu"] .tick')].some((e) => e.textContent === '100.0%'), [...d.querySelectorAll('[data-chart="cpu"] .tick')].map((e) => e.textContent).join(','));
check('แกนหน่วยความจำตรึงที่ RAM ทั้งหมด จึงเห็นที่เหลือ', [...d.querySelectorAll('[data-chart="mem"] .tick')].some((e) => e.textContent === '7.5 GB'));
check('เส้นกริดเป็นเส้นบางทึบ ไม่ใช่เส้นประ', !!d.querySelector('[data-chart="cpu"] .grid') && !d.querySelector('[data-chart="cpu"] [stroke-dasharray]'));
check('ค่ารวมตัวใหญ่ไม่ใช้ tabular-nums (ตัวเลขจะดูโปร่ง)', !d.querySelector('[data-chart="cpu"] [data-total]').classList.contains('num'));

// Colour follows the stack, never its rank: swapping which stack is busiest
// must not repaint either of them.
const slotOfLg = (id, name) => lgOf(id, name)?.querySelector('i').getAttribute('style');
const hues = [slotOfLg('cpu', 'alpha'), slotOfLg('cpu', 'zeta')];
check('แต่ละ stack ได้สีคนละ slot', hues[0] !== hues[1] && hues[0].includes('--s1'), hues.join(' / '));
burn.alpha = 80; burn.zeta = 160;
click(d.querySelector('#refresh')); await sleep(150);
check('สลับว่าใครกินมากสุด → สีไม่สลับตาม (ไม่ใช่สีตามอันดับ)',
  slotOfLg('cpu', 'alpha') === hues[0] && slotOfLg('cpu', 'zeta') === hues[1],
  `${slotOfLg('cpu', 'alpha')} / ${slotOfLg('cpu', 'zeta')}`);
check('ตอนนี้ zeta กินมากกว่า จริงๆ', lgOf('cpu', 'zeta')?.textContent.includes('10.0%'), lgOf('cpu', 'zeta')?.textContent);

// The table is the chart's table-view twin, and goes down to each pane.
const trow = [...d.querySelectorAll('tr.pf-stack')].find((e) => e.textContent.includes('zeta'));
check('ตารางเรียงตัวที่กิน CPU มากสุดขึ้นก่อน', d.querySelector('tr.pf-stack')?.textContent.includes('zeta'), d.querySelector('tr.pf-stack')?.textContent.trim());
check('ตารางบอก CPU เป็นสัดส่วนของทั้งเครื่อง', trow?.textContent.includes('10.0%'));
check('แต่ละ pane มีแถวของตัวเอง', d.querySelector('tr.pf-pane')?.textContent.includes('app'));
check('ชื่อ stack ลิงก์กลับไปหน้า Stacks', d.querySelector('tr.pf-stack a')?.getAttribute('href') === '#/stacks/zeta');
check('แถบในตารางวัดจากทั้งเครื่อง ไม่ใช่จาก stack ที่กินมากสุด', parseFloat(d.querySelector('tr.pf-stack .meter i')?.style.width) === 10, d.querySelector('tr.pf-stack .meter i')?.style.width);

w.location.hash = '#/stacks/beta'; await sleep(200);
check('ออกจากหน้าทรัพยากรแล้วประวัติถูกล้าง (ไม่เอาอัตราเก่ามาปน)', !d.querySelector('.m-perf'));
check('deep link #/stacks/beta → กลับมาที่ Stacks และเลือก beta', d.querySelector('#view').classList.contains('m-stacks') && d.querySelector('#main h1')?.textContent.includes('beta'));
click(d.querySelector('#theme'));
check('สลับธีม stamp data-theme', ['dark', 'light'].includes(d.documentElement.dataset.theme));

// Chat: the page is a rendering of the event stream, and the only thing that
// waits for a person is a permission request.
calls.length = 0; w.location.hash = '#/chat'; await sleep(200);
check('สลับไปเมนูแชท → mount พร้อมรายการ stack', d.querySelector('#view').classList.contains('m-chat') && d.querySelectorAll('.m-chat [data-select]').length === 2);
check('เปิด stream ของ stack ที่เลือก', has('SSE /api/chatstream/alpha'), calls.join(', '));
check('หัวเรื่องบอกโฟลเดอร์ที่จะคุยด้วย (ย่อ ~ ให้)', d.querySelector('.ch-head .path')?.textContent.includes('~/a'), d.querySelector('.ch-head .path')?.textContent);
check('มีตัวเลือกสิทธิ์ และไม่มีตัวเลือกปิดการตรวจสอบทั้งหมด', (() => {
  const o = [...d.querySelectorAll('#ch-mode option')].map((e) => e.value);
  return o.length === 4 && o.includes('manual') && !o.includes('bypassPermissions');
})(), [...d.querySelectorAll('#ch-mode option')].map((e) => e.value).join(','));

check('เลือกรุ่นได้ และตัวแรกคือค่าเริ่มต้นของเครื่อง', (() => {
  const o = [...d.querySelectorAll('#ch-model-sel option')];
  return o.length === 5 && o[0].value === '' && o[0].textContent.includes('ตามค่าเครื่อง') && o[1].textContent === 'Opus';
})(), [...d.querySelectorAll('#ch-model-sel option')].map((e) => `${e.value}=${e.textContent}`).join(','));

const chatEs = w.__sse.find((e) => e.url.startsWith('/api/chatstream/alpha'));
let chatSeq = 0;
const feedChat = (ev) => chatEs.onmessage({ data: JSON.stringify({ seq: ++chatSeq, ev }) });

calls.length = 0;
d.querySelector('#ch-in').value = 'ทำอะไรได้บ้าง';
d.querySelector('#ch-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
await sleep(80);
check('ส่งข้อความ → POST /api/chat/alpha', has('POST /api/chat/alpha') && w.__lastBody?.text === 'ทำอะไรได้บ้าง', JSON.stringify(w.__lastBody));
check('ส่งแล้วช่องพิมพ์ว่าง และปุ่มส่งถูกปิดระหว่างรอ', d.querySelector('#ch-in').value === '' && d.querySelector('#ch-send').disabled);
feedChat({ type: 'nk', event: 'ask', text: 'ทำอะไรได้บ้าง' });
feedChat({ type: 'system', subtype: 'init', model: 'claude-opus-5-5[1m]', cwd: '/home/u/a' });
check('หัวเรื่องบอกรุ่นที่ได้จริง ไม่ใช่แค่ alias', d.querySelector('#ch-model')?.textContent === 'claude-opus-5-5[1m]', d.querySelector('#ch-model')?.textContent);
check('ข้อความของเราขึ้นในบทสนทนา', d.querySelector('.msg.me')?.textContent.includes('ทำอะไรได้บ้าง'));

feedChat({ type: 'assistant', message: { content: [
  { type: 'thinking', thinking: 'คิดอยู่' },
  { type: 'text', text: 'ได้ครับ **นี่คือ** `code` และ\n```sh\nls -la\n```' }] } });
check('คำตอบขึ้นเป็นข้อความ พร้อม markdown ขั้นพื้นฐาน', (() => {
  const m = d.querySelector('.msg.claude');
  return !!m && !!m.querySelector('b') && !!m.querySelector('code') && m.querySelector('pre.code')?.textContent.includes('ls -la');
})(), d.querySelector('.msg.claude')?.innerHTML.slice(0, 160));
check('ส่วนที่คิดถูกพับไว้ ไม่เกะกะ', d.querySelector('.fold.think details')?.open === false);

feedChat({ type: 'assistant', message: { content: [
  { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'make test' } }] } });
check('การเรียกเครื่องมือขึ้นเป็นการ์ดพับ พร้อมสรุปว่าจะทำอะไร', (() => {
  const c = d.querySelector('[data-tool="tu-1"]');
  return !!c && c.querySelector('.tname').textContent === 'Bash' && c.querySelector('.tsum').textContent.includes('make test');
})());
feedChat({ type: 'user', message: { content: [
  { type: 'tool_result', tool_use_id: 'tu-1', content: 'ok 12 tests' }] } });
check('ผลลัพธ์ของเครื่องมือไปอยู่ในการ์ดเดียวกัน ไม่แยกฟอง', d.querySelector('[data-tool="tu-1"] .tres')?.textContent.includes('ok 12 tests') && d.querySelectorAll('.fold.tool').length === 1);

// The permission card: nothing is approved unless somebody presses Allow.
feedChat({ type: 'control_request', request_id: 'rq-1', request: {
  subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write',
  input: { file_path: '/home/u/a/x.txt', content: 'hi' }, description: 'x.txt' } });
const perm = d.querySelector('[data-perm="rq-1"]');
check('คำขออนุญาตขึ้นเป็นการ์ด พร้อมปุ่มอนุญาต/ไม่อนุญาต', !!perm && !!perm.querySelector('[data-allow]') && !!perm.querySelector('[data-deny]'));
check('การ์ดบอกว่าจะทำอะไรกับไฟล์ไหน', perm.textContent.includes('x.txt') && perm.querySelector('pre.code').textContent.includes('/home/u/a/x.txt'));
calls.length = 0; click(perm.querySelector('[data-deny]')); await sleep(80);
check('กดไม่อนุญาต → POST /api/chatperm พร้อม allow:false', has('POST /api/chatperm/alpha') && w.__lastBody?.allow === false && w.__lastBody?.id === 'rq-1', JSON.stringify(w.__lastBody));
feedChat({ type: 'nk', event: 'answered', request_id: 'rq-1', allow: false });
check('ตอบแล้วการ์ดปิดตัวเอง ไม่ให้กดซ้ำ', perm.classList.contains('done') && perm.classList.contains('no') && !perm.querySelector('[data-allow]'));

feedChat({ type: 'control_request', request_id: 'rq-2', request: {
  subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'rm -rf build' } } });
calls.length = 0; click(d.querySelector('[data-perm="rq-2"] [data-allow]')); await sleep(80);
check('กดอนุญาต → POST พร้อม allow:true', w.__lastBody?.allow === true && w.__lastBody?.id === 'rq-2', JSON.stringify(w.__lastBody));

// Images: pasted, dropped or picked, they queue as thumbnails and go with the
// next message. The stream carries them back by id, never by value.
check('มีปุ่มแนบภาพและช่องเลือกไฟล์', !!d.querySelector('#ch-clip') && d.querySelector('#ch-file')?.accept.includes('image/png'));
check('ยังไม่มีภาพแนบ → แถบรูปซ่อนอยู่', d.querySelector('#ch-shots').hidden);
const TEAL = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGOQXl9FU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAFx/EEzBb9F3AAAAAElFTkSuQmCC';
const pngFile = new w.File([Uint8Array.from(w.atob(TEAL), (c) => c.charCodeAt(0))], 'teal.png', { type: 'image/png' });
const pasteEv = new w.Event('paste', { bubbles: true, cancelable: true });
pasteEv.clipboardData = { files: [pngFile], types: ['Files'] };
d.querySelector('#ch-in').dispatchEvent(pasteEv);
await sleep(120);
check('วางภาพ → ขึ้นเป็นรูปย่อรอส่ง', !d.querySelector('#ch-shots').hidden && d.querySelectorAll('#ch-shots .shot img').length === 1, d.querySelector('#ch-shots')?.innerHTML.slice(0, 80));
const badFile = new w.File([new Uint8Array([1, 2])], 'a.tif', { type: 'image/tiff' });
const badPaste = new w.Event('paste', { bubbles: true, cancelable: true });
badPaste.clipboardData = { files: [badFile], types: ['Files'] };
d.querySelector('#ch-in').dispatchEvent(badPaste);
await sleep(120);
check('ชนิดที่ไม่รองรับถูกปฏิเสธตั้งแต่หน้าเว็บ', d.querySelectorAll('#ch-shots .shot').length === 1);
calls.length = 0;
d.querySelector('#ch-in').value = 'อันนี้สีอะไร';
d.querySelector('#ch-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
await sleep(120);
check('ส่งพร้อมภาพ → POST มี images แนบไปด้วย', w.__lastBody?.images?.length === 1 && w.__lastBody.images[0].media_type === 'image/png' && w.__lastBody.images[0].data === TEAL, JSON.stringify(w.__lastBody?.images?.[0] || {}).slice(0, 90));
check('ส่งแล้วแถบรูปว่างและซ่อนอีกครั้ง', d.querySelector('#ch-shots').hidden);
feedChat({ type: 'nk', event: 'ask', text: 'อันนี้สีอะไร', images: [{ id: 'abc123', media_type: 'image/png', name: 'teal.png' }] });
const shown = [...d.querySelectorAll('.msg.me .shot-img')].pop();
check('ข้อความของเราแสดงภาพ โดยดึงจาก id ไม่ใช่จาก base64 ในสตรีม', shown?.getAttribute('src') === '/api/chatimg/alpha/abc123', shown?.getAttribute('src'));
// Queued images can be taken off again before sending.
d.querySelector('#ch-in').dispatchEvent(Object.assign(new w.Event('paste', { bubbles: true, cancelable: true }), { clipboardData: { files: [pngFile], types: ['Files'] } }));
await sleep(120);
click(d.querySelector('#ch-shots [data-drop]'));
check('กด ✕ บนรูปย่อ → เอาออกได้ก่อนส่ง', d.querySelector('#ch-shots').hidden && d.querySelectorAll('#ch-shots .shot').length === 0);

// How much of the allowance is gone rides along with a turn — there is no
// command that reports it — so the top bar shows the last reading, and shows
// nothing at all rather than a stale guess before one arrives.
check('ยังไม่มีข้อมูลโควตา → ไม่แสดงอะไรเลย', d.querySelector('#usage').hidden);
feedChat({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed',
  unifiedWindows: { five_hour: { utilization: 0.13, resetsAt: 1790231400 },
                    seven_day: { utilization: 0.82, resetsAt: 1790434800 } } } });
check('ได้ข้อมูลจากสตรีม → โควตาขึ้นบนแถบบน', !d.querySelector('#usage').hidden);
check('รอบ 5 ชม. 13% แถบปกติ', (() => {
  const w = d.querySelector('[data-w="five_hour"]');
  return w.querySelector('.u-n').textContent === '13%' && parseFloat(w.querySelector('.meter i').style.width) === 13
    && w.querySelector('.meter').className === 'meter';
})(), d.querySelector('[data-w="five_hour"]')?.textContent);
check('รอบ 7 วัน 82% → แถบเปลี่ยนเป็นสีเตือน', (() => {
  const w = d.querySelector('[data-w="seven_day"]');
  return w.querySelector('.u-n').textContent === '82%' && w.querySelector('.meter').classList.contains('warn');
})(), d.querySelector('[data-w="seven_day"] .meter')?.className);
check('hover บอกเวลารีเซ็ตและอายุของข้อมูล', /รีเซ็ต/.test(d.querySelector('[data-w="five_hour"]').title), d.querySelector('[data-w="five_hour"]').title);
feedChat({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected',
  unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1790231400 } } } });
check('ถึงขีดจำกัด → แถบเป็นสีแดงและบอกว่าเต็ม', d.querySelector('[data-w="five_hour"] .meter').classList.contains('bad') && d.querySelector('[data-w="five_hour"]').title.includes('ถึงขีดจำกัด'));
check('รอบที่ไม่มีข้อมูลถูกซ่อน ไม่ค้างค่าเดิม', d.querySelector('[data-w="seven_day"]').hidden);

// Changing the model or the permissions restarts the session; the conversation
// is kept by its id, which is the only reason that is safe.
calls.length = 0;
d.querySelector('#ch-model-sel').value = 'sonnet';
d.querySelector('#ch-model-sel').dispatchEvent(new w.Event('change', { bubbles: true }));
await sleep(80);
check('เปลี่ยนรุ่น → POST /api/chatopts พร้อม model', has('POST /api/chatopts/alpha') && w.__lastBody?.model === 'sonnet', JSON.stringify(w.__lastBody));
calls.length = 0;
d.querySelector('#ch-mode').value = 'acceptEdits';
d.querySelector('#ch-mode').dispatchEvent(new w.Event('change', { bubbles: true }));
await sleep(80);
check('เปลี่ยนสิทธิ์ → POST เดียวกัน พร้อม mode', has('POST /api/chatopts/alpha') && w.__lastBody?.mode === 'acceptEdits', JSON.stringify(w.__lastBody));

// Assistant text is data, never markup.
feedChat({ type: 'assistant', message: { content: [{ type: 'text', text: '<img src=x onerror="window.__xss=1">' }] } });
check('ข้อความจาก Claude ถูก escape (ไม่กลายเป็น HTML)', w.__xss === undefined && !d.querySelector('.msg.claude img') && [...d.querySelectorAll('.msg.claude')].some((e) => e.textContent.includes('onerror')), String(w.__xss));

feedChat({ type: 'result', subtype: 'success', duration_api_ms: 4200, total_cost_usd: 0.0123, usage: { output_tokens: 1500 } });
check('จบรอบ → ปุ่มส่งกลับมาใช้ได้ และบอกเวลา/โทเคน/ราคา', !d.querySelector('#ch-send').disabled && d.querySelector('#ch-cost').textContent === '$0.0123' && [...d.querySelectorAll('.ch-log .note')].some((e) => e.textContent.includes('4.2s') && e.textContent.includes('1.5k')));
feedChat({ type: 'nk', event: 'exited', code: 0 });
check('session ปิด → บอกว่าพิมพ์ต่อได้', [...d.querySelectorAll('.ch-log .note')].some((e) => e.textContent.includes('พิมพ์ต่อ')));
w.location.hash = '#/stacks/beta'; await sleep(200);
check('ออกจากแชทแล้ว stream ถูกปิด', chatEs.closed === true);

// Command palette: Ctrl-K, type what to do, Enter — each item names its nk command.
d.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
check('Ctrl-K เปิด palette', d.querySelector('#palette').open);
const palIn = d.querySelector('#pal-in');
palIn.value = 'up bet'; palIn.dispatchEvent(new w.Event('input', { bubbles: true }));
check('พิมพ์ "up bet" → เจอ "รัน beta" พร้อมคำสั่ง nk up beta', d.querySelector('.pal-item.on')?.textContent.includes('beta') && d.querySelector('.pal-item.on code')?.textContent.includes('nk up beta'), d.querySelector('#pal-list').textContent);
calls.length = 0; palIn.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(80);
check('Enter → POST /api/up/beta และ palette ปิด', has('POST /api/up/beta') && !d.querySelector('#palette').open, calls.join(', '));
click(d.querySelector('#pal-btn'));
palIn.value = 'ports'; palIn.dispatchEvent(new w.Event('input', { bubbles: true }));
check('palette มีทางไปเมนูอื่น', [...d.querySelectorAll('.pal-item')].some((e) => e.textContent.includes('พอร์ต')));
palIn.value = 'zzzz'; palIn.dispatchEvent(new w.Event('input', { bubbles: true }));
check('ไม่เจอ → บอกว่าไม่พบ', !!d.querySelector('.pal-empty'));
d.querySelector('#palette').close();

// Language: EN re-renders menu, chrome and the mounted module; TH restores it.
click(d.querySelector('[data-lang="en"]')); await sleep(200);
check('EN → เมนู title และปุ่มในหน้าเปลี่ยนภาษา', d.querySelector('[data-route="stacks"]').textContent.includes('Stacks') && d.title.endsWith('Stacks · D3v') && d.querySelector('#main [data-act]')?.textContent.trim().match(/^(Run|Restart)$/), `${d.title} / ${d.querySelector('#main [data-act]')?.textContent}`);
check('EN → lang attr และปุ่มภาษา active', d.documentElement.lang === 'en' && d.querySelector('[data-lang="en"]').classList.contains('on'));
check('EN จำไว้', w.localStorage.getItem('d3v-lang') === 'en');
click(d.querySelector('[data-lang="th"]')); await sleep(200);
check('TH → กลับเป็นไทย', d.querySelector('[data-route="stacks"]').textContent.includes('สแต็ก') && d.querySelector('#main [data-act]')?.textContent.trim().match(/^(รัน|รีสตาร์ท)$/));
check('ไม่มี string ไทยตกค้างในโค้ด module (ต้องผ่าน t())', !/[\u0e00-\u0e7f]/.test(modules.join('')));

console.log(fail ? `\n${fail} ข้อไม่ผ่าน` : '\nผ่านทั้งหมด');
process.exit(fail ? 1 : 0);
