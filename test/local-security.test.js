const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable, Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const ROOT = path.resolve(__dirname, '..');
const realRequire = createRequire(path.join(ROOT, 'server.js'));
const helpers = realRequire('./test/helpers');

// Run the actual HTTP handler with in-memory requests. No socket, browser,
// external network, user data, or media decoder is needed for these checks.
function handlerFixture(t) {
  const dir = helpers.makeDataDir(t);
  const old = process.env.FABLECUT_DATA_DIR;
  process.env.FABLECUT_DATA_DIR = dir;
  delete require.cache[realRequire.resolve('./paths')];
  let handler;
  const fakeProcess = { on() {}, env: { PORT: '17777', HOST: '127.0.0.1', FABLECUT_NO_FS_WATCH: '1' } };
  const localRequire = (id) => {
    if (id === 'http') return { createServer: (fn) => { handler = fn; return { listen() {} }; } };
    if (id === 'child_process') return { spawnSync: () => ({ status: 1 }), spawn() { throw Error('unexpected spawn'); }, execFile() { throw Error('unexpected exec'); } };
    return realRequire(id);
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), {
    require: localRequire, process: fakeProcess, __dirname: ROOT, module: { exports: {} },
    console, Buffer, URL, URLSearchParams, AbortController, structuredClone,
    setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval() {},
  }, { filename: path.join(ROOT, 'server.js') });
  if (old === undefined) delete process.env.FABLECUT_DATA_DIR; else process.env.FABLECUT_DATA_DIR = old;
  async function request(url, method = 'GET', body = '', headers = {}) {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.url = url; req.method = method; req.headers = { host: '127.0.0.1:17777', ...headers };
    let status, responseHeaders = {}, chunks = [];
    const res = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    res.writeHead = (s, h = {}) => { status = s; responseHeaders = h; return res; };
    const finished = new Promise((resolve, reject) => { res.on('finish', resolve); res.on('error', reject); });
    await handler(req, res);
    await finished;
    return { status, headers: responseHeaders, body: Buffer.concat(chunks).toString() };
  }
  return { dir, request };
}

test('baseline: external Origin and dotfile requests are refused', async (t) => {
  const f = handlerFixture(t);
  assert.equal((await f.request('/api/project', 'GET', '', { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.request('/.git/config')).status, 403);
});

test('uploads reject HTML and do not publish it', async (t) => {
  const f = handlerFixture(t);
  const inert = '<!doctype html><script>/* inert audit marker, never opened */</script>';
  assert.equal((await f.request('/api/upload?name=audit.html', 'POST', inert)).status, 400);
  const r = await f.request('/media/audit.html');
  assert.equal(r.status, 404);
  assert.equal(fs.existsSync(path.join(f.dir, 'media', 'audit.html')), false);
});

test('cross-port localhost writes are rejected', async (t) => {
  const f = handlerFixture(t);
  const r = await f.request('/api/projects', 'POST', JSON.stringify({ action: 'new', name: 'Cross-origin audit', open: false }), {
    origin: 'http://127.0.0.1:9999', 'content-type': 'text/plain',
  });
  assert.equal(r.status, 403);
});

test('media symlinks cannot escape their root', async (t) => {
  const f = handlerFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fablecut-audit-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'canary.txt'), 'DUMMY_CANARY_NOT_A_SECRET');
  fs.symlinkSync(outside, path.join(f.dir, 'media', 'linked'));
  const r = await f.request('/media/linked/canary.txt');
  assert.equal(r.status, 403);
});

test('malformed URL encoding returns 400', async (t) => {
  const f = handlerFixture(t);
  assert.equal((await f.request('/%ZZ')).status, 400);
});

test('reference analysis rejects non-media before copying', async (t) => {
  const dir = helpers.makeDataDir(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fablecut-audit-input-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const file = path.join(outside, 'canary.txt');
  fs.writeFileSync(file, 'DUMMY_CANARY_NOT_A_SECRET');
  const mcp = helpers.startMcp(t, dir, { FABLECUT_NO_AUTOSTART: '1', FABLECUT_NO_FS_WATCH: '1', PATH: '/usr/bin:/bin' });
  const handshake = await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  assert.equal(handshake.result.serverInfo.name, 'fablecut');
  const r = await mcp.callTool('fablecut_analyze_reference', { path: file, registerMusic: false });
  assert.equal(r.isError, true);
  assert.equal(fs.existsSync(path.join(dir, 'media', 'canary.txt')), false);
  const catalog = await mcp.request('tools/list');
  console.log('Tool catalog:', catalog.result.tools.length, 'tools;', catalog.result.tools.filter(x => x.annotations).length, 'with annotations');
});

test('remote imports pin validated DNS addresses', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fablecut-audit-dns-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lookups = [];
  const dns = {
    promises: { lookup: async () => { lookups.push('validated 93.184.216.34'); return [{ address: '93.184.216.34', family: 4 }]; } },
    lookup: (host, cb) => { lookups.push('connected 127.0.0.1'); cb(null, '127.0.0.1', 4); },
  };
  const transport = { request(opts, callback) {
    assert.equal(typeof opts.lookup, 'function');
    const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {};
    req.end = () => opts.lookup(opts.hostname, {}, (err, address) => {
      assert.equal(address, '93.184.216.34');
      const response = Readable.from([Buffer.from('inert dummy bytes')]);
      response.statusCode = 200; response.headers = { 'content-type': 'video/mp4' };
      callback(response);
    });
    return req;
  }};
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'import-url.js'), 'utf8'), {
    require: id => id === 'dns' ? dns : (id === 'https' || id === 'http') ? transport : realRequire(id),
    module, URL, Buffer, console, process: {env: {}},
  });
  const result = await module.exports.downloadImportUrl('https://audit.example/canary.mp4', dir);
  assert.deepEqual(lookups, ['validated 93.184.216.34']);
  assert.equal(fs.readFileSync(result.target, 'utf8'), 'inert dummy bytes');
});


test('trial authentication protects HTTP and supports MCP', async t => {
  const dir = helpers.makeDataDir(t);
  const token = 'disposable-test-token';
  const { base, port } = await helpers.startServer(t, dir, { FABLECUT_TOKEN: token, FABLECUT_NO_FS_WATCH: '1' });
  assert.equal((await fetch(base + '/api/project')).status, 401);
  const auth = {Authorization: 'Bearer ' + token};
  assert.equal((await fetch(base + '/api/project', {headers: auth})).status, 200);
  const basic = {Authorization: 'Basic ' + Buffer.from('fablecut:' + token).toString('base64')};
  assert.equal((await fetch(base + '/', {headers: basic})).status, 200);
  assert.equal((await fetch(base + '/local-trial/private.env', {headers: auth})).status, 404);
  const mcp = helpers.startMcp(t, dir, {FABLECUT_TOKEN: token, FABLECUT_PORT: String(port), FABLECUT_NO_AUTOSTART: '1'});
  const status = await mcp.callTool('fablecut_status');
  assert.equal(status.isError, false);
  assert.match(status.text, /RUNNING/);
});

test('approved input roots reject outside files and symlinks', async t => {
  const dir = helpers.makeDataDir(t);
  const outside = helpers.makeDataDir(t);
  fs.mkdirSync(path.join(dir, 'inbox'));
  const dummy = path.join(outside, 'dummy.wav');
  fs.writeFileSync(dummy, 'dummy bytes');
  fs.symlinkSync(dummy, path.join(dir, 'inbox', 'escape.wav'));
  const mcp = helpers.startMcp(t, dir, {FABLECUT_INPUT_ROOTS: dir, FABLECUT_NO_AUTOSTART: '1'});
  for (const file of [dummy, path.join(dir, 'inbox', 'escape.wav')]) {
    const r = await mcp.callTool('fablecut_import_media', {path:file});
    assert.equal(r.isError, true); assert.match(r.text, /outside approved folders/);
  }
});


test('explicit public origin permits a tunnel and refuses other ports', async t => {
  const dir = helpers.makeDataDir(t);
  const {base} = await helpers.startServer(t, dir, {FABLECUT_PUBLIC_ORIGIN:'http://127.0.0.1:7787', FABLECUT_NO_FS_WATCH:'1'});
  for (const [origin, expected] of [['http://127.0.0.1:7787',200],['http://127.0.0.1:9999',403]]) {
    const r = await fetch(base+'/api/projects', {method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({action:'new',name:'Tunnel test',open:false})});
    assert.equal(r.status,expected); await r.text();
  }
});
