// Minimal DOM harness: loads the real page JS, clicks the real buttons, and
// asserts the request each click should make. Catches wiring that node --check
// cannot see.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync('/home/terk/devkit/web/index.html', 'utf8');
const stacks = [
  { name: 'alpha', origin: 'user', dir: '/tmp/a', url: 'http://x', note: '',
    running: true, hasToken: false, ports: [{ port: 3000, holder: 'node', pid: 42 }] },
  { name: 'beta', origin: 'shared', dir: '/tmp/b', url: '', note: '',
    running: false, hasToken: false, ports: [{ port: 3080, holder: null, pid: null }] },
];

const calls = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.fetch = async (url, opts = {}) => {
      calls.push(`${opts.method || 'GET'} ${url}`);
      const body = url === '/api/stacks' ? stacks
        : url.startsWith('/api/stack/') ? { name: 'alpha', dir: '/tmp/a', ports: '3000',
            url: 'http://x', note: '', envFile: '', panes: [{ label: 'app', cmd: 'make run' }],
            editable: true }
        : { ok: true, output: 'done' };
      return { ok: true, json: async () => body };
    };
    w.EventSource = class { constructor(u) { calls.push(`SSE ${u}`); } close() {} };
    w.confirm = () => true;
    w.HTMLDialogElement.prototype.showModal = function () { calls.push('dialog.open'); this.open = true; };
    w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  },
});

const w = dom.window, d = w.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

await sleep(150);
let fail = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  ' + extra}`);
  if (!cond) fail++;
};

check('โหลดตารางตอนเปิดหน้า', calls.includes('GET /api/stacks'));
check('เรนเดอร์ 2 stack', d.querySelectorAll('.row').length === 2,
      `เจอ ${d.querySelectorAll('.row').length}`);

const rowOf = (n) => d.querySelector(`.row[data-stack="${n}"]`);
const btn = (n, act) => rowOf(n).querySelector(`[data-act="${act}"]`);

check('stack ที่ยังไม่รันมีปุ่ม run', !!btn('beta', 'up'));
calls.length = 0; click(btn('beta', 'up')); await sleep(80);
check('กด run แล้วยิง POST /api/up', calls.includes('POST /api/up/beta'), calls.join(', '));

calls.length = 0; click(btn('alpha', 'restart')); await sleep(80);
check('กด restart', calls.includes('POST /api/restart/alpha'), calls.join(', '));

calls.length = 0; click(btn('alpha', 'down')); await sleep(80);
check('กด down', calls.includes('POST /api/down/alpha'), calls.join(', '));

calls.length = 0; click(btn('alpha', 'logs')); await sleep(80);
check('กด terminal เปิด SSE', calls.some((c) => c.startsWith('SSE /api/stream/alpha')), calls.join(', '));

calls.length = 0; click(btn('alpha', 'edit')); await sleep(120);
check('กด แก้ เปิด dialog', calls.includes('dialog.open'), calls.join(', '));
check('ฟอร์มเติมค่าเดิมให้', d.querySelector('#f-dir').value === '/tmp/a',
      `ได้ "${d.querySelector('#f-dir').value}"`);

calls.length = 0; click(d.querySelector('[data-kill]')); await sleep(80);
check('กด ✕ เคลียร์ port', calls.includes('POST /api/kill/3000'), calls.join(', '));

calls.length = 0; click(d.querySelector('#new')); await sleep(80);
check('กด + เพิ่ม stack', d.querySelector('#editor').open === true);
check('ฟอร์มใหม่ว่างเปล่า', d.querySelector('#f-name').value === '');

click(d.querySelector('#f-addcmd'));
check('กด + เพิ่มคำสั่ง ได้ 2 แถว', d.querySelectorAll('#f-cmds .cmdrow').length === 2,
      `ได้ ${d.querySelectorAll('#f-cmds .cmdrow').length}`);

calls.length = 0; click(d.querySelector('#f-browse')); await sleep(80);
check('กด เลือก… เรียก browse', calls.some((c) => c.startsWith('GET /api/browse')), calls.join(', '));

d.querySelector('#f-name').value = 'newstack';
d.querySelector('#f-dir').value = '/tmp';
d.querySelectorAll('#f-cmds .cmd')[0].value = 'make run';
calls.length = 0; click(d.querySelector('#f-save')); await sleep(80);
check('กด บันทึก ยิง POST /api/stack', calls.includes('POST /api/stack'), calls.join(', '));

calls.length = 0; click(d.querySelector('#refresh')); await sleep(80);
check('ปุ่ม รีเฟรช', calls.includes('GET /api/stacks'), calls.join(', '));

console.log(fail ? `\n${fail} ข้อไม่ผ่าน` : '\nผ่านทั้งหมด');
process.exit(fail ? 1 : 0);
