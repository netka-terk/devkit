// Loads the real page in jsdom, clicks the real controls, and asserts the
// request each click should make. A syntax check cannot see a missing
// listener; this can.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const stacks = [
  { name: 'alpha', origin: 'user', dir: '/home/u/a', url: 'http://x', note: 'n',
    running: true, hasToken: false, ports: [{ port: 3000, holder: 'node', pid: 42 }] },
  { name: 'beta', origin: 'shared', dir: '/home/u/b', url: '', note: '',
    running: false, hasToken: false, ports: [{ port: 3080, holder: 'stray', pid: 99 }] },
];
const detail = (n) => ({ name: n, dir: `/home/u/${n[0]}`, ports: '3000', url: 'http://x', note: '',
  envFile: '', panes: [{ label: 'app', cmd: 'make run' }], editable: true });

const calls = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.fetch = async (url, opts = {}) => {
      calls.push(`${opts.method || 'GET'} ${url}`);
      const body = url === '/api/stacks' ? stacks
        : url.startsWith('/api/stack/') ? detail(decodeURIComponent(url.split('/').pop()))
        : url.startsWith('/api/browse') ? { path: '/home/u', parent: '/home', dirs: ['a', 'b'] }
        : { ok: true, output: 'done' };
      return { ok: true, json: async () => body };
    };
    w.EventSource = class { constructor(u) { calls.push(`SSE ${u}`); this.readyState = 1; } close() {} };
    w.confirm = () => true;
    w.matchMedia = () => ({ matches: false });
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

await sleep(200);
check('โหลดรายการตอนเปิด', has('GET /api/stacks'));
check('sidebar มี 2 stack', d.querySelectorAll('[data-select]').length === 2);
check('เลือกตัวแรกให้เองและเปิด terminal stream', has('SSE /api/stream/alpha'));
check('หัวเรื่องเป็นชื่อ stack', d.querySelector('#main h1')?.textContent.includes('alpha'));
check('stack ที่รันอยู่มีปุ่ม รีสตาร์ท/หยุด', !!d.querySelector('[data-act="restart"]') && !!d.querySelector('[data-act="down"]'));

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
click(d.querySelector('#f-cancel'));

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
click(d.querySelector('#theme'));
check('สลับธีม stamp data-theme', ['dark', 'light'].includes(d.documentElement.dataset.theme));

console.log(fail ? `\n${fail} ข้อไม่ผ่าน` : '\nผ่านทั้งหมด');
process.exit(fail ? 1 : 0);
