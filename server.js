// Parallel Chat: 複数の Claude を並列チャットで動かすローカルサーバー
// 各ペインが独立した `claude -p` セッションを持ち、Claude の契約枠で動く。
// 単体では `node server.js`、Mac アプリでは electron/main.js から start() を呼ぶ。
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');

const ROOT = __dirname;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 6;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// Finder から起動した GUI アプリはシェルの PATH を持たないので claude を探す
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local/bin/claude'),
    path.join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(sh, ['-ilc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 });
    const p = out.trim().split('\n').pop();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return 'claude';
}

function start({ dataDir = path.join(ROOT, 'data'), port = Number(process.env.PORT || 4317), host = '127.0.0.1' } = {}) {
  const WORK = path.join(dataDir, 'workspaces');
  const UPLOADS = path.join(dataDir, 'uploads');
  const STATE_FILE = path.join(dataDir, 'state.json');
  const CLAUDE_BIN = findClaude();
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(UPLOADS, { recursive: true });

  // ---- state ----------------------------------------------------------
  let state = { panes: [] };
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  const newPane = (title) => ({ id: crypto.randomUUID().slice(0, 8), title, sessionId: null, model: '', folder: null, messages: [] });
  const MODELS = ['', 'opus', 'sonnet', 'haiku']; // '' は Claude Code の既定
  const READONLY_FOLDER_TOOLS = 'Read,Glob,Grep,WebSearch,WebFetch'; // 読み取り専用（Bash/Edit/Write なし）
  if (!state.panes.length) for (let i = 1; i <= 3; i++) state.panes.push(newPane(`チャット ${i}`));
  const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  const pane = (id) => state.panes.find((p) => p.id === id);
  const workdir = (id) => {
    const d = path.join(WORK, id);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  const running = new Map(); // paneId -> child

  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size <= 60 * 1024 * 1024) chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          resolve({});
        }
      });
    });

  const stopPane = (id) => {
    const c = running.get(id);
    if (c) {
      c.stopped = true;
      c.kill('SIGTERM');
    }
  };

  // 画像を保存して、メッセージ用のファイル名と claude 用の content block を返す
  function storeImages(raw) {
    const files = [];
    const blocks = [];
    for (const img of (Array.isArray(raw) ? raw : []).slice(0, MAX_IMAGES)) {
      const ext = IMAGE_TYPES[img?.mediaType];
      if (!ext || typeof img.data !== 'string') continue;
      const buf = Buffer.from(img.data, 'base64');
      if (!buf.length || buf.length > MAX_IMAGE_BYTES) continue;
      const name = `${crypto.randomUUID()}.${ext}`;
      fs.writeFileSync(path.join(UPLOADS, name), buf);
      files.push(name);
      blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    }
    return { files, blocks };
  }

  function chat(req, res, body) {
    const p = pane(body.paneId);
    const text = String(body.text || '').trim();
    const { files, blocks } = storeImages(body.images);
    if (!p || (!text && !blocks.length)) return json(res, 400, { error: 'bad request' });
    if (running.has(p.id)) return json(res, 409, { error: 'このペインは応答中です' });

    // 作業フォルダが選ばれていればそこで読み取り専用、なければ空の専用フォルダ
    let cwd;
    if (p.folder) {
      try {
        if (!fs.statSync(p.folder).isDirectory()) throw new Error();
      } catch {
        return json(res, 400, { error: `フォルダが見つかりません: ${p.folder}` });
      }
      cwd = p.folder;
    } else {
      cwd = workdir(p.id);
    }

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // 軽量・安全化: 設定ファイルは一切読み込まない（選んだフォルダの hook が動かないように空指定）、MCP/スラッシュコマンドも無効
      '--setting-sources', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--tools', p.folder ? READONLY_FOLDER_TOOLS : 'WebSearch,WebFetch',
    ];
    if (p.model) args.push('--model', p.model);
    if (p.sessionId) args.push('--resume', p.sessionId);

    const content = [...blocks];
    content.push({ type: 'text', text: text || '（画像を添付しました）' });

    p.messages.push({ role: 'user', text, images: files.length ? files : undefined });
    save();

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    const send = (o) => res.write(JSON.stringify(o) + '\n');

    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${process.env.PATH || ''}:${path.join(os.homedir(), '.local/bin')}:/opt/homebrew/bin:/usr/local/bin` },
    });
    running.set(p.id, child);
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');

    let acc = '';
    let buf = '';
    let errText = '';
    let finished = false;

    const finish = (err) => {
      if (finished) return;
      finished = true;
      running.delete(p.id);
      if (acc || err) {
        p.messages.push({ role: 'assistant', text: acc, error: err || undefined, stopped: child.stopped || undefined });
        save();
      }
      send(err ? { type: 'error', message: err } : { type: 'done' });
      res.end();
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        if (d.type === 'system' && d.subtype === 'init' && d.session_id) p.sessionId = d.session_id;
        if (d.type === 'stream_event') {
          const ev = d.event || {};
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            acc += ev.delta.text;
            send({ type: 'delta', text: ev.delta.text });
          } else if (ev.type === 'message_start' && acc) {
            // ツール使用後の新しいメッセージ: 段落を区切る
            acc += '\n\n';
            send({ type: 'delta', text: '\n\n' });
          }
        } else if (d.type === 'result' && d.is_error && !acc) {
          errText = String(d.result || 'エラーが発生しました');
        }
      }
    });
    child.stderr.on('data', (c) => (errText += c));
    child.on('error', (e) => finish(`claude を起動できません: ${e.message}`));
    child.on('close', (code) => {
      if (child.stopped) return finish(null);
      if (code !== 0 && !acc) return finish(errText.trim().slice(0, 500) || `終了コード ${code}`);
      finish(null);
    });
    // ブラウザが切断されたらプロセスも止める
    res.on('close', () => {
      if (!finished) {
        child.stopped = true;
        child.kill('SIGTERM');
      }
    });
  }

  const VENDOR = {
    '/vendor/marked.js': path.join(ROOT, 'node_modules/marked/lib/marked.umd.js'),
    '/vendor/purify.js': path.join(ROOT, 'node_modules/dompurify/dist/purify.js'),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'GET /') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
      }
      if (req.method === 'GET' && VENDOR[url.pathname]) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(fs.readFileSync(VENDOR[url.pathname]));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
        const name = path.basename(url.pathname);
        const ext = name.split('.').pop();
        if (!/^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/.test(name)) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': MIME_BY_EXT[ext], 'Cache-Control': 'max-age=31536000' });
        return res.end(fs.readFileSync(path.join(UPLOADS, name)));
      }
      if (route === 'GET /api/state') {
        return json(res, 200, { panes: state.panes.map((p) => ({ ...p, busy: running.has(p.id) })) });
      }
      if (route === 'POST /api/chat') return chat(req, res, await readBody(req));
      if (route === 'POST /api/stop') {
        stopPane((await readBody(req)).paneId);
        return json(res, 200, { ok: true });
      }
      if (route === 'POST /api/panes') {
        const { title } = await readBody(req);
        const p = newPane(title || `チャット ${state.panes.length + 1}`);
        state.panes.push(p);
        save();
        return json(res, 200, p);
      }
      if (route === 'POST /api/reset') {
        const p = pane((await readBody(req)).paneId);
        if (p && !running.has(p.id)) {
          p.sessionId = null;
          p.messages = [];
          save();
        }
        return json(res, 200, { ok: true });
      }
      if (route === 'POST /api/settings') {
        // モデルと作業フォルダの変更。フォルダを変えると Claude のセッションは別物になるので会話を新規にする。
        const { paneId, model, folder } = await readBody(req);
        const p = pane(paneId);
        if (!p) return json(res, 404, { error: 'pane not found' });
        if (running.has(p.id)) return json(res, 409, { error: '応答中は変更できません' });
        if (model !== undefined) {
          if (!MODELS.includes(model)) return json(res, 400, { error: 'unknown model' });
          p.model = model;
        }
        let reset = false;
        if (folder !== undefined) {
          let next = null;
          if (folder) {
            next = path.resolve(String(folder));
            try {
              if (!path.isAbsolute(next) || !fs.statSync(next).isDirectory()) throw new Error();
            } catch {
              return json(res, 400, { error: `フォルダが見つかりません: ${folder}` });
            }
          }
          if (next !== p.folder) {
            p.folder = next;
            p.sessionId = null;
            p.messages = [];
            reset = true;
          }
        }
        save();
        return json(res, 200, { ok: true, model: p.model, folder: p.folder, reset });
      }
      if (route === 'POST /api/rename') {
        const { paneId, title } = await readBody(req);
        const p = pane(paneId);
        if (p && title) {
          p.title = String(title).slice(0, 60);
          save();
        }
        return json(res, 200, { ok: true });
      }
      if (route === 'POST /api/delete') {
        const { paneId } = await readBody(req);
        stopPane(paneId);
        state.panes = state.panes.filter((p) => p.id !== paneId);
        save();
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: String(e.message || e) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://${host}:${actual}`,
        claudeBin: CLAUDE_BIN,
        close: () => {
          for (const id of running.keys()) stopPane(id);
          server.close();
        },
      });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then((s) => {
    console.log(`Parallel Chat: ${s.url}  (claude: ${s.claudeBin})`);
    process.on('SIGINT', () => {
      s.close();
      process.exit(0);
    });
  });
}
