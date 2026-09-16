// Loads the real page in jsdom, clicks the real controls, and asserts the
// request each click should make. A syntax check cannot see a missing
// listener; this can.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
// jsdom ignores <script src> without a resource loader, so the menu modules are
// injected by hand after the shell has run — same order as the page.
const modules = ['stacks', 'ports'].map((m) => fs.readFileSync(new URL(`../web/modules/${m}.js`, import.meta.url), 'utf8'));
const stacks = [
  { name: 'alpha', origin: 'user', dir: '/home/u/a', url: 'http://x', note: 'n',
    running: true, hasToken: false, ports: [{ port: 3000, holder: 'node', pid: 42 }],
    detected: [{ port: 3000, pid: 42, holder: 'node' }, { port: 9229, pid: 42, holder: 'node' }] },
  { name: 'beta', origin: 'shared', dir: '/home/u/b', url: '', note: '',
    running: false, hasToken: false,
    ports: [{ port: 3080, holder: 'stray', pid: 99 }, { port: 5000, holder: null, pid: null }, { port: 3000, holder: 'node', pid: 42 }] },
];
const detail = (n) => ({ name: n, dir: `/home/u/${n[0]}`, ports: '3000', url: 'http://x', note: '',
  envFile: '', panes: [{ label: 'app', cmd: 'make run' }] });

const calls = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
  beforeParse(w) {
    w.fetch = async (url, opts = {}) => {
      calls.push(`${opts.method || 'GET'} ${url}`);
      if (opts.body) w.__lastBody = JSON.parse(opts.body);
      const body = url === '/api/stacks' ? stacks
        : url.startsWith('/api/stack/') ? detail(decodeURIComponent(url.split('/').pop()))
        : url.startsWith('/api/browse') ? { path: '/home/u', parent: '/home', dirs: ['a', 'b'] }
        : { ok: true, output: 'done' };
      return { ok: true, json: async () => body };
    };
    w.EventSource = class { constructor(u) { calls.push(`SSE ${u}`); this.readyState = 1; w.__es = this; } close() {} };
    w.confirm = () => true;
    w.matchMedia = () => ({ matches: false });
    w.localStorage.setItem('d3v-lang', 'th');   // jsdom reports en-US; the page's Thai strings are what the checks read
    w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    w.HTMLDialogElement.prototype.close = function () { this.open = false; };
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
check('shell มีเมนู 2 อัน', d.querySelectorAll('#menu [data-route]').length === 2);
check('เมนูแรก (Stacks) ถูก mount และ active', d.querySelector('#view').classList.contains('m-stacks') && d.querySelector('[data-route="stacks"]').classList.contains('on'));
check('title เป็นชื่อโปรแกรม', d.title === 'สแต็ก · D3v', d.title);
check('เมนูเป็นไทยตามภาษาที่เลือก', d.querySelector('[data-route="stacks"]').textContent.includes('สแต็ก'));
check('ไม่มี tag user/shared/project ในหน้า', !/\b(user|shared|project)\b/.test(d.querySelector('#view').textContent));
check('โหลดรายการตอนเปิด', has('GET /api/stacks'));
check('sidebar มี 2 stack', d.querySelectorAll('[data-select]').length === 2);
check('เลือกตัวแรกให้เองและเปิด terminal stream', has('SSE /api/stream/alpha'));
check('หัวเรื่องเป็นชื่อ stack', d.querySelector('#main h1')?.textContent.includes('alpha'));
check('stack ที่รันอยู่มีปุ่ม รีสตาร์ท/หยุด', !!d.querySelector('[data-act="restart"]') && !!d.querySelector('[data-act="down"]'));
check('port ที่เจอตอนรันแต่ไม่ได้ประกาศ แสดงพร้อม tag', d.querySelector('#main').textContent.includes(':9229') && !!d.querySelector('.tag.auto'));
calls.length = 0; click(d.querySelector('[data-adopt]')); await sleep(80);
check('จำ port ที่เจอ → POST /api/adopt/alpha', has('POST /api/adopt/alpha'), calls.join(', '));

// Terminal: feed two panes through the mocked stream, then split.
const feed = (pane, text) => w.__es.onmessage({ data: JSON.stringify({ pane, text }) });
feed('backend', 'INFO listening :3000\n'); feed('frontend', 'webpack compiled\n');
check('แท็บ 2 pane', d.querySelectorAll('#tabs [data-pane]').length === 2 && !!d.querySelector('#logtext'));
click(d.querySelector('[data-mode="cols"]'));
check('แยกซ้าย-ขวา → 2 pane พร้อมกัน', d.querySelectorAll('.split.cols .pane').length === 2);
check('แต่ละ pane มี output ของตัวเอง',
  d.querySelector('[data-pre="backend"]')?.textContent.includes(':3000') && d.querySelector('[data-pre="frontend"]')?.textContent.includes('webpack'));
feed('frontend', 'rebuilt\n');
check('stream ใหม่เข้า pane ที่ถูกต้องตอนแยกจอ', d.querySelector('[data-pre="frontend"]')?.textContent.includes('rebuilt') && !d.querySelector('[data-pre="backend"]')?.textContent.includes('rebuilt'));
click(d.querySelector('[data-mode="rows"]'));
check('แยกบน-ล่าง', d.querySelectorAll('.split.rows .pane').length === 2);
click(d.querySelector('[data-clear="backend"]'));
check('ล้างเฉพาะ pane เดียว', !d.querySelector('[data-pre="backend"]')?.textContent.includes(':3000') && d.querySelector('[data-pre="frontend"]')?.textContent.includes('rebuilt'));
click(d.querySelector('[data-max="frontend"]'));
check('ขยาย pane → กลับเป็นแท็บที่ pane นั้น', !!d.querySelector('#logtext') && d.querySelector('#tabs .on')?.dataset.pane === 'frontend' && d.querySelector('#logtext').textContent.includes('rebuilt'));
check('จำโหมดไว้', w.localStorage.getItem('d3v-term') === 'tabs');

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
w.location.hash = '#/stacks/beta'; await sleep(200);
check('deep link #/stacks/beta → กลับมาที่ Stacks และเลือก beta', d.querySelector('#view').classList.contains('m-stacks') && d.querySelector('#main h1')?.textContent.includes('beta'));
click(d.querySelector('#theme'));
check('สลับธีม stamp data-theme', ['dark', 'light'].includes(d.documentElement.dataset.theme));

// Language: EN re-renders menu, chrome and the mounted module; TH restores it.
click(d.querySelector('[data-lang="en"]')); await sleep(200);
check('EN → เมนู title และปุ่มในหน้าเปลี่ยนภาษา', d.querySelector('[data-route="stacks"]').textContent.includes('Stacks') && d.title === 'Stacks · D3v' && d.querySelector('#main [data-act]')?.textContent.trim().match(/^(Run|Restart)$/), `${d.title} / ${d.querySelector('#main [data-act]')?.textContent}`);
check('EN → lang attr และปุ่มภาษา active', d.documentElement.lang === 'en' && d.querySelector('[data-lang="en"]').classList.contains('on'));
check('EN จำไว้', w.localStorage.getItem('d3v-lang') === 'en');
click(d.querySelector('[data-lang="th"]')); await sleep(200);
check('TH → กลับเป็นไทย', d.querySelector('[data-route="stacks"]').textContent.includes('สแต็ก') && d.querySelector('#main [data-act]')?.textContent.trim().match(/^(รัน|รีสตาร์ท)$/));
check('ไม่มี string ไทยตกค้างในโค้ด module (ต้องผ่าน t())', !/[\u0e00-\u0e7f]/.test(modules.join('')));

console.log(fail ? `\n${fail} ข้อไม่ผ่าน` : '\nผ่านทั้งหมด');
process.exit(fail ? 1 : 0);
