const { app, BrowserWindow, ipcMain, Menu, screen, dialog } = require('electron');

// 单实例锁：禁止重复启动
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 第二实例被启动时，聚焦已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { execFile, exec } = require('child_process');
const zlib = require('zlib');
// TTS 使用子进程，避免 Electron 环境兼容性问题
// edge-tts-universal 改为在 tts-worker.js 中通过系统 Node.js 调用
const storage = require('./storage');
const mcp = require('./mcp');

// TTS 合成结果内存缓存：相同文本直接复用，避免重复联网合成
const ttsCache = new Map();
const TTS_CACHE_MAX = 80;

// npm MCP 拓展工具搜索结果缓存（避免重复请求 registry）
const _mcpSearchCache = { ts: 0, key: '', data: null };

const MIME_MAP = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.moc3': 'application/octet-stream', '.zip': 'application/zip' };

let mainWindow, server, chatWindow, aiCfgWindow, skillsWindow, toolsWindow, instructionsWindow;
let _windowOnTop = true; // 跟踪窗口期望的置顶状态

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    const MAX_BODY = 5 * 1024 * 1024; // 5MB 限制
    // Content-Length 预检
    const cl = parseInt(req.headers['content-length'], 10);
    if (cl > MAX_BODY) { req.destroy(); resolve(''); return; }
    req.on('data', c => { b += c; if (b.length > MAX_BODY) { req.destroy(); resolve(''); } });
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(''));
  });
}
function ok(res) { res.writeHead(200); res.end('ok'); }

// ===== 数据读写路由（从 handler 映射表自动生成） =====
const DATA_NAMES = ['deco','chat-cfg','chat-archive','voice','ai-cfg','experiences','skills','instructions'];
const dataHandlers = {};
DATA_NAMES.forEach(n => {
  dataHandlers['POST /save-'+n] = (req, res) => readBody(req).then(b => storage.save(n, b, () => ok(res)));
  dataHandlers['GET /load-'+n]  = (req, res) => storage.load(n, res);
});

// 路径安全检查工具（提升到模块作用域，避免每次请求重新创建）
// 已放开目录限制：允许访问项目目录外的任意路径（含绝对路径与 .. 跳出）
function safePath(fp) {
  if (!fp) return null;
  let filePath = fp;
  if (!path.isAbsolute(filePath)) filePath = path.join(__dirname, filePath);
  return path.resolve(filePath);
}

// 命令安全检查：放开目录/路径/管道/重定向限制，仅在真正高危破坏性操作时拦截
// （防宠物被注入后破坏系统；普通的项目外执行、绝对路径、cd ..、管道符均允许）
function isCommandSafe(command) {
  if (!command) return false;
  const trimmed = command.trim();
  // 高危命令黑名单：递归删除、格式化、关机等破坏性操作，以及网络下载管道执行
  const dangerous = /\b(?:rm\s+-rf|rm\s+-fr|del\s+\/f|del\s+\/s|rd\s+\/s|format\s+[a-z]|mkfs|shutdown|poweroff|reboot|halt|curl\s+.*\|\s*(?:sh|bash)|wget\s+.*\|\s*(?:sh|bash)|curl\s+.*-o\s+.*\.sh|powershell\s+-(?:enc|e|ep)\b|certutil\s+-urlcache|iwr\b.*\|\s*iex|sudo\b|netsh\s+firewall|reg\s+delete\s+hklm|sc\s+delete|taskkill\s+\/f\s+\/im|mount\b|umount\b|dd\s+if=)\b/i;
  if (dangerous.test(trimmed)) return false;
  return true;
}

// ===== Word(.docx) 原地文本替换：保留原有格式（字体/颜色/加粗/表格等）=====
// docx 本质是 ZIP，文字在 word/document.xml 的 <w:t> 节点里。
// 只在 <w:t> 文本节点上做替换，<w:rPr>（run 格式）等结构原样保留，从而不破坏原文档排版。
function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function encodeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function makeWt(attrs, text) {
  let a = attrs ? attrs.trim() : '';
  // 去掉已有的 xml:space，避免与新加的重复导致 XML 非法
  a = a.replace(/xml:space\s*=\s*["'][^"']*["']/g, '').trim();
  const open = a ? ' ' + a : '';
  if (text === '') return `<w:t${open}/>`;
  return `<w:t${open} xml:space="preserve">${encodeXml(text)}</w:t>`;
}
// 在 document.xml 中把 oldText 原地替换为 newText（保留格式），仅替换首次出现
// 返回 { found, occurrences, result }
function xmlTextReplace(xml, oldText, newText) {
  if (!oldText) return { found: false, occurrences: 0 };
  // 匹配所有 <w:t ...>...</w:t> 与自闭合 <w:t .../>
  const re = /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(\s[^>]*)?\s*\/>/g;
  const nodes = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[2] !== undefined) nodes.push({ attrs: m[1] || '', text: decodeXml(m[2]), index: m.index, raw: m[0] });
    else nodes.push({ attrs: m[3] || '', text: '', index: m.index, raw: m[0] });
  }
  const plain = nodes.map(n => n.text).join('');
  const occurrences = plain.split(oldText).length - 1;
  if (occurrences === 0) return { found: false, occurrences: 0 };
  const start = plain.indexOf(oldText);
  const end = start + oldText.length;
  let pos = 0, startNode = -1, startOff = 0, endNode = -1, endOff = 0;
  for (let i = 0; i < nodes.length; i++) {
    const len = nodes[i].text.length;
    const ns = pos, ne = pos + len;
    if (startNode < 0 && start >= ns && start <= ne) { startNode = i; startOff = start - ns; }
    if (end >= ns && end <= ne) { endNode = i; endOff = end - ns; break; }
    pos = ne;
  }
  for (let i = 0; i < nodes.length; i++) {
    if (i < startNode || i > endNode) { nodes[i].newRaw = nodes[i].raw; continue; }
    if (i === startNode && i === endNode) {
      const before = nodes[i].text.slice(0, startOff);
      const after = nodes[i].text.slice(endOff);
      nodes[i].newRaw = makeWt(nodes[i].attrs, before + newText + after);
    } else if (i === startNode) {
      nodes[i].newRaw = makeWt(nodes[i].attrs, nodes[i].text.slice(0, startOff) + newText);
    } else if (i === endNode) {
      nodes[i].newRaw = makeWt(nodes[i].attrs, nodes[i].text.slice(endOff));
    } else {
      // 夹在中间的 run：清空文字但保留 run 结构（格式随之保留）
      nodes[i].newRaw = makeWt(nodes[i].attrs, '');
    }
  }
  let result = '', cursor = 0;
  for (const n of nodes) {
    result += xml.slice(cursor, n.index) + n.newRaw;
    cursor = n.index + n.raw.length;
  }
  result += xml.slice(cursor);
  return { found: true, occurrences, result };
}

// 当前正在执行的 bash 子进程引用集合，供"中断"按钮通过 /bash-abort 真正终止后台进程
let currentBashChild = null;
// 并行 bash 进程的完整集合（防止中断遗漏）
const _bashChildren = new Set();

function startServer() {
  return new Promise(r => {
    server = http.createServer((req, res) => {
      try {
        // 禁用缓存，确保聊天窗口/宠物窗口每次都加载最新代码（避免改动后仍是旧页面）
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      // 数据读写处理（去除查询参数再匹配）
      const pathOnly = req.url.split('?')[0];
      const h = dataHandlers[req.method + ' ' + pathOnly];
      if (h) { h(req, res); return; }

      // 文件读取（支持相对路径）
      if (req.method === 'GET' && req.url.startsWith('/read-file?path=')) {
        const q = new URL(req.url, 'http://x').searchParams;
        let fp = q.get('path') || '';
        const maxLines = parseInt(q.get('lines') || '99999', 10);
        const offset = parseInt(q.get('offset') || '0', 10);
        if (!fp) { res.writeHead(400); res.end('{"error":"empty path"}'); return; }
        const resolved = safePath(fp);
        if (!resolved) { res.writeHead(403); res.end('{"error":"forbidden path"}'); return; }
        fs.readFile(resolved, 'utf-8', (e, d) => {
          if (e) { res.writeHead(404); res.end('{"error":"文件不存在或无法读取"}'); return; }
          const lines = d.split('\n');
          const total = lines.length;
          const show = lines.slice(offset, offset + maxLines);
          const endLine = Math.min(offset + maxLines, total);
          const numbered = show.map((l, i) => `${String(i+1+offset).padStart(5)}:${l}`).join('\n');
          let result = numbered;
          // 提示放在最前面，AI 更容易注意到
          if (offset + maxLines < total)
            result = `⚠️ 文件共${total}行，本次仅显示第${offset+1}-${endLine}行，还有${total-endLine}行未读！请立即用 offset=${endLine} 调 read_file 继续读取剩余部分\n\n` + result;
          else
            result = `✅ 已读取全部${total}行（第${offset+1}-${endLine}行）\n\n` + result;
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(result);
        });
        return;
      }
      // 文档解析（PDF / DOCX）— 供 read_image / read_files 后端调用，提取文字供 AI 处理
      if (req.method === 'POST' && req.url === '/parse-document') {
        readBody(req).then(async body => {
          try {
            const { path: fp, asImage } = JSON.parse(body);
            if (!fp) { res.writeHead(400); res.end(JSON.stringify({ error: 'empty path' })); return; }
            const resolved = safePath(fp);
            if (!resolved) { res.writeHead(403); res.end(JSON.stringify({ error: 'forbidden' })); return; }
            const ext = path.extname(resolved).toLowerCase();
            // 图片文件 → 直接返回 base64 数据 URL
            if (['.png','.jpg','.jpeg','.gif','.webp','.bmp'].includes(ext)) {
              try {
                const buf = fs.readFileSync(resolved);
                const b64 = buf.toString('base64');
                const mime = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp' }[ext] || 'image/png';
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ type: 'image', data: `data:${mime};base64,${b64}` }));
              } catch(e) { res.writeHead(404); res.end(JSON.stringify({ error: '图片读取失败' })); }
              return;
            }
            // PDF
            if (ext === '.pdf') {
              try {
                const pdf = require('pdf-parse');
                const buf = fs.readFileSync(resolved);
                const data = await pdf(buf);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ type: 'text', content: data.text, pages: data.numpages }));
              } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: 'PDF 解析失败: ' + e.message })); }
              return;
            }
            // DOCX
            if (ext === '.docx') {
              try {
                const mammoth = require('mammoth');
                const buf = fs.readFileSync(resolved);
                const data = await mammoth.extractRawText({ buffer: buf });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ type: 'text', content: data.value }));
              } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: 'DOCX 解析失败: ' + e.message })); }
              return;
            }
            res.writeHead(400); res.end(JSON.stringify({ error: '不支持的格式: ' + ext }));
          } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid json' })); }
        });
        return;
      }
      // 代码搜索（支持 keyword / definition / reference / regex，可显示上下文，异步遍历避免阻塞）
      const SEARCH_EXTS = ['.js','.ts','.html','.json','.css','.py','.jsx','.tsx','.vue','.svelte'];
      if (req.method === 'GET' && req.url.startsWith('/search?')) {
        const u = new URL(req.url, 'http://x');
        const q = u.searchParams.get('q') || '';
        const mode = u.searchParams.get('mode') || 'keyword';
        const ctxLines = parseInt(u.searchParams.get('context') || '2', 10);
        const caseSensitive = u.searchParams.get('caseSensitive') === 'true';
        if (!q) { res.writeHead(400); res.end('{"error":"empty query"}'); return; }
        let matcher;
        try {
          if (mode === 'regex') {
            matcher = new RegExp(q, caseSensitive ? '' : 'i');
          } else if (mode === 'definition') {
            const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            matcher = new RegExp('(?:function|const|let|var|class|async\\s+function)\\s+' + esc + '|' + esc + '\\s*(?:[=:]|\\s*=>|\\s*\\{)', caseSensitive ? '' : 'i');
          } else if (mode === 'reference') {
            const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const defRe = new RegExp('(?:function|const|let|var|class)\\s+' + esc, caseSensitive ? '' : 'i');
            matcher = { test: (line) => !defRe.test(line) && new RegExp(esc, caseSensitive ? '' : 'i').test(line) };
          } else {
            const needle = caseSensitive ? q : q.toLowerCase();
            matcher = { test: (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle) };
          }
        } catch (e) {
          res.writeHead(400); res.end(JSON.stringify({ error: '正则无效: ' + e.message })); return;
        }
        (async () => {
          const results = [];
          async function walk(dir) {
            let entries;
            try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch(e) { return; }
            for (const e of entries) {
              if (e.name.startsWith('.') || e.name === 'node_modules') continue;
              const fp = path.join(dir, e.name);
              if (e.isDirectory()) { await walk(fp); if (results.length >= 50) return; }
              else if (SEARCH_EXTS.includes(path.extname(e.name).toLowerCase())) {
                try {
                  const content = await fs.promises.readFile(fp, 'utf-8');
                  const lines = content.split('\n');
                  const totalLines = lines.length;
                  for (let i = 0; i < lines.length; i++) {
                    if (!matcher.test(lines[i])) continue;
                    const context = ctxLines > 0
                      ? [...lines.slice(Math.max(0,i-ctxLines),i), '→'+lines[i], ...lines.slice(i+1, Math.min(lines.length,i+1+ctxLines))].join('\n')
                      : lines[i];
                    results.push({ file: path.relative(__dirname, fp), line: i+1, content: lines[i].trim(), context, lines: totalLines });
                    if (results.length >= 50) break;
                  }
                } catch(e) {}
                if (results.length >= 50) return;
              }
            }
          }
          await walk(__dirname);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results: results.slice(0,50), total: results.length, truncated: results.length >= 50 }));
        })();
        return;
      }
      // 列出目录内容
      if (req.method === 'GET' && req.url.startsWith('/list-dir?path=')) {
        let fp = decodeURIComponent(req.url.split('?path=')[1] || '').replace(/\\/g,'/');
        if (!fp) fp='.';
        const resolved = safePath(fp);
        if (!resolved) { res.writeHead(403); res.end('[]'); return; }
        try {
          const entries = fs.readdirSync(resolved, { withFileTypes: true });
          const list = entries.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules').map(e => {
            const isDir = e.isDirectory();
            let size;
            if (!isDir) { try { size = fs.statSync(path.join(resolved, e.name)).size; } catch (_) {} }
            return { name: e.name, isDir, size };
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(list));
        } catch(e) {
          res.writeHead(500); res.end('[]');
        }
        return;
      }
      // 递归目录树（一次看清项目骨架，避免逐层 list_dir 的多轮循环）
      if (req.method === 'GET' && req.url.startsWith('/tree?path=')) {
        const u = new URL(req.url, 'http://localhost');
        let fp = decodeURIComponent(u.searchParams.get('path') || '') || '.';
        const maxDepth = Math.min(parseInt(u.searchParams.get('maxDepth') || '3', 10) || 3, 6);
        const ignore = new Set((u.searchParams.get('ignore') || '').split(',').map(s => s.trim()).filter(Boolean));
        const DEFAULT_IGNORE = new Set(['node_modules', '.git', '.codebuddy', '.idea', '.vscode', 'dist', 'build']);
        const resolved = safePath(fp);
        if (!resolved) { res.writeHead(403); res.end('# 禁止访问的路径'); return; }
        const lines = [];
        let count = 0; const HARD_CAP = 600;
        function walk(dir, depth, prefix) {
          if (depth > maxDepth || count > HARD_CAP) return;
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
          entries = entries.filter(e => {
            if (e.name.startsWith('.')) return false;
            if (DEFAULT_IGNORE.has(e.name) || ignore.has(e.name)) return false;
            return true;
          });
          entries.sort((a, b) => (a.isDirectory() === b.isDirectory()) ? a.name.localeCompare(b.name) : (a.isDirectory() ? -1 : 1));
          entries.forEach((e, i) => {
            if (count > HARD_CAP) return;
            const isLast = i === entries.length - 1;
            lines.push(prefix + (isLast ? '└── ' : '├── ') + e.name + (e.isDirectory() ? '/' : ''));
            count++;
            if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1, prefix + (isLast ? '    ' : '│   '));
          });
        }
        try {
          lines.push(path.basename(resolved) + '/');
          walk(resolved, 1, '');
          if (count > HARD_CAP) lines.push('... (已达到显示上限 ' + HARD_CAP + ' 项，更深层请用更小的 maxDepth 或 list_dir 查看具体目录)');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(lines.join('\n'));
        } catch (e) {
          res.writeHead(500); res.end('# 读取失败: ' + e.message);
        }
        return;
      }
      // TTS（通过系统 Node.js 子进程调用 Edge TTS，避免 Electron 兼容问题）
      if (req.method === 'POST' && req.url.startsWith('/tts')) {
        readBody(req).then(raw => {
          const text = (raw || '').trim();
          if (!text) { res.writeHead(400); res.end(); return; }
          // 内存缓存：相同文本无需重复合成（语音为锦上添花，缓存可显著降低请求量）
          if (ttsCache.has(text)) {
            const audio = ttsCache.get(text);
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length.toString() });
            res.end(audio);
            return;
          }
          // asar 打包时，worker 和依赖被解包到 app.asar.unpacked/ 下
          const isPacked = __dirname.includes('app.asar');
          const workerPath = isPacked
            ? path.join(process.resourcesPath, 'app.asar.unpacked', 'tts-worker.js')
            : path.join(__dirname, 'tts-worker.js');
          const nodePath = isPacked
            ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
            : undefined;
          // 通过 shell 启动系统 Node（非 Electron 内置），文本通过 stdin 传入避免转义问题
          const runWorker = (cb) => {
            const child = execFile('node', [workerPath], {
              timeout: 120000,
              maxBuffer: 16 * 1024 * 1024,
              windowsHide: true,
              encoding: 'buffer',
              env: nodePath ? { ...process.env, NODE_PATH: nodePath } : undefined,
            }, (err, stdout, stderr) => {
              if (err || !stdout || stdout.length < 4) {
                cb(err || new Error('TTS failed'));
                return;
              }
              const len = stdout.readUInt32LE(0);
              if (len === 0) { cb(new Error('empty audio')); return; }
              cb(null, stdout.subarray(4, 4 + len));
            });
            child.stdin.write(text);
            child.stdin.end();
          };
          // 失败兜底：最多重试一次，仍失败则静默返回 204（前端已对 204/空音频静默跳过）
          const tryOnce = (attempt, cb) => {
            runWorker((err, audio) => {
              if (err && attempt < 1) { tryOnce(attempt + 1, cb); return; }
              cb(err, audio);
            });
          };
          tryOnce(0, (err, audio) => {
            if (err) {
              console.error('[TTS] 合成失败（已静默兜底）:', err.message);
              if (!res.headersSent) res.writeHead(204);
              res.end();
              return;
            }
            if (ttsCache.size >= TTS_CACHE_MAX) { const k = ttsCache.keys().next().value; ttsCache.delete(k); }
            ttsCache.set(text, audio);
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length.toString() });
            res.end(audio);
          });
        });
        return;
      }
      // 执行终端命令（bash）
      if (req.method === 'POST' && req.url === '/bash') {
        readBody(req).then(body => {
          try {
            const { command } = JSON.parse(body);
            if (!command) { res.writeHead(400); res.end('{"error":"empty command"}'); return; }
            if (!isCommandSafe(command)) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: 1, output: '⛔ 命令已阻止：存在危险操作' }));
              return;
            }
            const isWin = process.platform === 'win32';
            const cb = (err, stdout, stderr) => {
              currentBashChild = null;
              const output = (stdout||'') + (stderr||'');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: err ? (err.code||1) : 0, output: output.substring(0, 5000) }));
            };
            const child = isWin
              ? exec(command, { cwd: __dirname, timeout: 180000, maxBuffer: 1024*1024, shell: true }, cb)
              : execFile('/bin/sh', ['-c', command], { cwd: __dirname, timeout: 180000, maxBuffer: 1024*1024 }, cb);
            // 确保子进程退出时清理引用，包括超时/崩溃等非正常退出场景
            _bashChildren.add(child);
            const cleanupChild = () => { _bashChildren.delete(child); if (currentBashChild === child) currentBashChild = null; };
            child.on('exit', cleanupChild);
            child.on('error', cleanupChild);
            currentBashChild = child;
          } catch(e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
        });
        return;
      }
      // 中断当前正在执行的 bash 命令（供前端"中断"按钮调用，真正终止后台子进程）
      if (req.method === 'POST' && req.url === '/bash-abort') {
        if (currentBashChild) {
          try { currentBashChild.kill('SIGTERM'); } catch (e) {}
          currentBashChild = null;
        }
        // 杀死所有正在运行的 bash 子进程（含并行）
        for (const child of _bashChildren) {
          try { child.kill('SIGTERM'); } catch (e) {}
        }
        _bashChildren.clear();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // 应用 SEARCH/REPLACE 补丁（apply_patch）
      if (req.method === 'POST' && req.url === '/apply-patch') {
        readBody(req).then(body => {
          try {
            const { path: fp, patches } = JSON.parse(body);
            if (!fp || !patches || !patches.length) { res.writeHead(400); res.end(JSON.stringify({error:'missing params'})); return; }
            const resolved = safePath(fp);
            if (!resolved) { res.writeHead(403); res.end(JSON.stringify({error:'forbidden'})); return; }
            fs.readFile(resolved, 'utf-8', (e, content) => {
              if (e) { res.writeHead(404); res.end(JSON.stringify({error:'文件不存在'})); return; }
              // 先计算所有 patch 的位置（在原始内容中），再依次替换
              const originalLines = content.split('\n');
              let modified = content;
              let changes = [];
              let skipped = [];
              // 先统计每个 patch 的出现次数，不唯一则报错
              for (const p of patches) {
                if (!p.old) continue;
                const count = modified.split(p.old).length - 1;
                if (count === 0) { skipped.push(p.old.substring(0, 60)); continue; }
                if (count > 1) {
                  const lineNum = modified.substring(0, modified.indexOf(p.old)).split('\n').length;
                  res.writeHead(200, {'Content-Type':'application/json'});
                  res.end(JSON.stringify({count:0, error:`"${p.old.substring(0,60)}" 在文件中出现了 ${count} 次（如 L${lineNum} 等），匹配不唯一，请提供更多上下文以确保唯一匹配`}));
                  return;
                }
                const idx = modified.indexOf(p.old);
                const lineNum = modified.substring(0, idx).split('\n').length;
                const oldSnippet = p.old.length > 40 ? p.old.substring(0, 40)+'...' : p.old;
                const newSnippet = (p.new||'').length > 40 ? (p.new||'').substring(0, 40)+'...' : (p.new||'');
                // newFull 携带完整替换后内容（不截断），供前端回传给 AI 做自校验
                changes.push({line:lineNum, old:oldSnippet, new:newSnippet, newFull: p.new||''});
                modified = modified.replace(p.old, p.new || '');
              }
              if (changes.length === 0 && skipped.length === 0) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({count:0})); return; }
              fs.writeFile(resolved, modified, 'utf-8', (we) => {
                if (we) { res.writeHead(500); res.end(JSON.stringify({error:'写入失败'})); return; }
                res.writeHead(200, {'Content-Type':'application/json'});
                res.end(JSON.stringify({count:changes.length, changes, skipped}));
              });
            });
          } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:'invalid json'})); }
        });
        return;
      }

      // 创建文件（覆盖写入，若文件已存在则计算行级差异）
      if (req.method === 'POST' && req.url === '/create-file') {
        readBody(req).then(body => {
          try {
            const { path: fp, content } = JSON.parse(body);
            if (!fp || content === undefined) { res.writeHead(400); res.end('{"error":"missing params"}'); return; }
            const resolved = safePath(fp);
            if (!resolved) { res.writeHead(403); res.end('{"error":"forbidden path"}'); return; }
            // 计算差异
            let diff=null;
            try{
              const oldContent=fs.readFileSync(resolved,'utf-8');
              if(oldContent!==content){
                const oldLines=oldContent.split('\n'),newLines=content.split('\n');
                const added=[],removed=[];
                const maxLen=Math.max(oldLines.length,newLines.length);
                for(let i=0;i<maxLen;i++){
                  if(i<oldLines.length&&(i>=newLines.length||oldLines[i]!==newLines[i])){
                    if(i<newLines.length)diff={line:i+1,old:oldLines[i],new:newLines[i]};
                    else removed.push(i+1);
                  }else if(i<newLines.length&&i>=oldLines.length)added.push(i+1);
                }
                // 如果变化行太多只给摘要
                const changeCount=(added.length+removed.length+(diff?1:0));
                diff=changeCount>20?{summary:`${changeCount} 行变化（+${added.length} -${removed.length}）`,changeCount}:(diff||{summary:'仅行数变化',changeCount});
              }
            }catch(e){/* 新文件，无差异 */}
            fs.writeFile(resolved, content, 'utf-8', (we) => {
              if (we) { res.writeHead(500); res.end('{"error":"创建失败"}'); return; }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, diff }));
            });
          } catch(e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
        });
        return;
      }
      // 创建格式化文档（Word / PDF）— AI 将文字内容写入指定格式
      if (req.method === 'POST' && req.url === '/create-document') {
        readBody(req).then(body => {
          try {
            const { path: fp, content } = JSON.parse(body);
            if (!fp || content === undefined) { res.writeHead(400); res.end('{"error":"missing params"}'); return; }
            const resolved = safePath(fp);
            if (!resolved) { res.writeHead(403); res.end('{"error":"forbidden path"}'); return; }
            const ext = path.extname(resolved).toLowerCase();
            // Word (.docx)
            if (ext === '.docx') {
              try {
                const { Document: DocX, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
                const lines = content.split('\n');
                const children = lines.map(l => {
                  const t = l.trim();
                  if (!t) return new Paragraph({ spacing: { after: 60 } });
                  if (t.startsWith('## ')) return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t.slice(3), bold: true, size: 28 })] });
                  if (t.startsWith('# ')) return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t.slice(2), bold: true, size: 36 })] });
                  if (t.startsWith('- ') || t.startsWith('* ')) return new Paragraph({ spacing: { after: 40 }, indent: { left: 400 }, children: [new TextRun({ text: '• ' + t.slice(2), size: 21 })] });
                  return new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: l, size: 21 })] });
                });
                const doc = new DocX({ sections: [{ children }] });
                Packer.toBuffer(doc).then(buf => {
                  fs.writeFile(resolved, buf, (we) => {
                    if (we) { res.writeHead(500); res.end(JSON.stringify({ error: '写入失败' })); return; }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, lines: lines.length }));
                  });
                });
              } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: 'DOCX 生成失败: ' + e.message })); }
              return;
            }
            // PDF
            if (ext === '.pdf') {
              try {
                const PDFDocument = require('pdfkit');
                const doc = new PDFDocument({ size: 'A4', margin: 50 });
                const chunks = [];
                doc.on('data', c => chunks.push(c));
                doc.on('end', () => {
                  fs.writeFile(resolved, Buffer.concat(chunks), (we) => {
                    if (we) { res.writeHead(500); res.end(JSON.stringify({ error: '写入失败' })); return; }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, lines: content.split('\n').length }));
                  });
                });
                const lines = content.split('\n');
                for (const l of lines) {
                  const t = l.trim();
                  if (!t) { doc.moveDown(0.5); continue; }
                  if (t.startsWith('## ')) doc.font('Helvetica-Bold').fontSize(16).text(t.slice(3), { underline: true }).moveDown(0.3);
                  else if (t.startsWith('# ')) doc.font('Helvetica-Bold').fontSize(20).text(t.slice(2)).moveDown(0.3);
                  else if (t.startsWith('- ') || t.startsWith('* ')) doc.font('Helvetica').fontSize(11).text('  •  ' + t.slice(2), { indent: 20 }).moveDown(0.2);
                  else doc.font('Helvetica').fontSize(11).text(t).moveDown(0.3);
                }
                doc.end();
              } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: 'PDF 生成失败: ' + e.message })); }
              return;
            }
            res.writeHead(400); res.end(JSON.stringify({ error: '不支持的格式: ' + ext }));
          } catch(e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
        });
        return;
      }
      // 原地编辑 Word 文档（.docx）：仅替换文字，保留原文档全部格式
      if (req.method === 'POST' && req.url === '/edit-document') {
        readBody(req).then(async body => {
          try {
            const { path: fp, oldText, newText } = JSON.parse(body);
            if (!fp || oldText === undefined || newText === undefined) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing params' })); return; }
            const resolved = safePath(fp);
            if (!resolved) { res.writeHead(403); res.end(JSON.stringify({ error: 'forbidden' })); return; }
            const ext = path.extname(resolved).toLowerCase();
            if (ext !== '.docx') { res.writeHead(400); res.end(JSON.stringify({ error: 'edit_document 目前仅支持 .docx（PDF 暂不支持原地编辑，请用 create_document 新建）' })); return; }
            const JSZip = require('jszip');
            const buf = fs.readFileSync(resolved);
            const zip = await JSZip.loadAsync(buf);
            const docFile = zip.file('word/document.xml');
            if (!docFile) { res.writeHead(500); res.end(JSON.stringify({ error: '文档结构异常：缺少 word/document.xml' })); return; }
            const xml = await docFile.async('string');
            const r = xmlTextReplace(xml, oldText, newText);
            if (!r.found) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, found: false, message: `未在文档中找到文本：「${oldText}」，请先用 read_document 查看原文并复制完全一致的内容（区分大小写）` }));
              return;
            }
            zip.file('word/document.xml', r.result);
            const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
            fs.writeFile(resolved, out, (we) => {
              if (we) { res.writeHead(500); res.end(JSON.stringify({ error: '写入失败' })); return; }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: true,
                message: r.occurrences > 1
                  ? `已替换 1 处（文档中共有 ${r.occurrences} 处相同文本，如需全部替换请再次调用本工具）`
                  : '已替换 1 处',
                occurrences: r.occurrences,
              }));
            });
          } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: '编辑失败: ' + e.message })); }
        });
        return;
      }
      // 删除文件
      if (req.method === 'POST' && req.url === '/delete-file') {
        readBody(req).then(body => {
          try {
            const { path: fp } = JSON.parse(body);
            if (!fp) { res.writeHead(400); res.end('{"error":"missing params"}'); return; }
            const resolved = safePath(fp);
            if (!resolved) { res.writeHead(403); res.end('{"error":"forbidden path"}'); return; }
            fs.unlink(resolved, (we) => {
              if (we) { res.writeHead(500); res.end('{"error":"删除失败"}'); return; }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            });
          } catch(e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
        });
        return;
      }
      // 创建目录
      if (req.method === 'POST' && req.url === '/mkdir') {
        readBody(req).then(body => {
          try {
            const { path: fp } = JSON.parse(body);
            if (!fp) { res.writeHead(400); res.end('{"error":"missing params"}'); return; }
            const resolved = safePath(fp);
            if (!resolved) { res.writeHead(403); res.end('{"error":"forbidden path"}'); return; }
            fs.mkdir(resolved, { recursive: true }, (we) => {
              if (we) { res.writeHead(500); res.end('{"error":"创建失败"}'); return; }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            });
          } catch(e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
        });
        return;
      }
      // 重命名/移动文件
      if (req.method === 'POST' && req.url === '/rename') {
        readBody(req).then(body => {
          try {
            const { path: fp, newPath } = JSON.parse(body);
            if (!fp || !newPath) { res.writeHead(400); res.end('{"error":"missing params"}'); return; }
            const resolved = safePath(fp);
            const resolvedNew = safePath(newPath);
            if (!resolved || !resolvedNew) { res.writeHead(403); res.end('{"error":"forbidden path"}'); return; }
            fs.rename(resolved, resolvedNew, (we) => {
              if (we) { res.writeHead(500); res.end('{"error":"重命名失败"}'); return; }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            });
          } catch(e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
        });
        return;
      }
      // 语法检查（lint_file 工具）- 使用 execFile 参数化执行避免命令注入
      function jsonLint(fp, cb){
        try{
          const content=fs.readFileSync(fp,'utf8');
          JSON.parse(content);
          cb(null,'语法正确');
        }catch(e){
          const lines=content.split('\n');
          // V8 错误信息含 "at position N"，计算行列号
          const posMatch=e.message.match(/position\s+(\d+)/);
          if(posMatch){
            const pos=parseInt(posMatch[1],10);
            let lineNum=0,charCount=0;
            while(lineNum<lines.length&&charCount+lines[lineNum].length+1<=pos){charCount+=lines[lineNum].length+1;lineNum++;}
            const col=pos-charCount+1;
            cb(e,`第${lineNum+1}行第${col}列: ${e.message.substring(0,200)}`);
          }else{
            cb(e,e.message.substring(0,200));
          }
        }
      }
      function htmlLint(fp, cb){
        try{
          const content=fs.readFileSync(fp,'utf8');
          const errs=[];
          // 检查基本的标签闭合
          const selfClosing=new Set(['br','hr','img','input','meta','link','area','base','col','embed','source','track','wbr']);
          const stack=[];
          // 先剥掉注释、<script>、<style> 内的内容，避免把 JS/CSS 里的 < > 误判成标签
          // （例如 CSS 的 div > p 子选择器会被误认成 <p>，JS 字符串里的 '<div>' 会被误判为未闭合标签）
          const working=content
            .replace(/<!--[\s\S]*?-->/g,'')
            .replace(/<script\b[\s\S]*?<\/script>/gi,'')
            .replace(/<style\b[\s\S]*?<\/style>/gi,'');
          const tagRe=/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
          let match;
          while((match=tagRe.exec(working))!==null){
            const full=match[0],tag=match[1].toLowerCase();
            if(full.startsWith('</')){if(stack.length>0&&stack[stack.length-1]===tag)stack.pop();else if(!selfClosing.has(tag))errs.push(`多余的闭合标签 </${tag}>`);}
            else if(!full.endsWith('/>')&&!selfClosing.has(tag))stack.push(tag);
          }
          while(stack.length>0)errs.push(`未闭合的标签 <${stack.pop()}>`);
          // 检查 doctype：接受任意 <!DOCTYPE ...> 声明（大小写不敏感），不限死为 <!DOCTYPE html>
          if(!/<!DOCTYPE[\s\S]*?>/i.test(content))errs.push('缺少 <!DOCTYPE> 声明');
          if(errs.length>0)cb(new Error(errs.join('; ')),errs.join('\n'));
          else cb(null,'语法正确');
        }catch(e){cb(e,e.message);}
      }
      function cssLint(fp, cb){
        try{
          const content=fs.readFileSync(fp,'utf8');
          // 去掉注释和字符串内内容后检查花括号平衡
          const cleaned=content.replace(/\/\*[\s\S]*?\*\//g,'').replace(/['"][^'"]*['"]/g,'');
          let brace=0;
          for(const ch of cleaned){
            if(ch==='{')brace++;
            else if(ch==='}')brace--;
          }
          if(brace>0)cb(new Error(`有 ${brace} 个未闭合的花括号 {`),`有 ${brace} 个未闭合的花括号 {`);
          else if(brace<0)cb(new Error(`有 ${-brace} 个多余的花括号 }`),`有 ${-brace} 个多余的花括号 }`);
          else cb(null,'语法正确');
        }catch(e){cb(e,e.message);}
      }
      const lintChecks = {
        '.js': (fp, cb) => execFile('node', ['--check', fp], { timeout: 15000 }, (err, stdout, stderr) => cb(err, (stderr||stdout||'').trim())),
        '.jsx': (fp, cb) => execFile('node', ['--check', fp], { timeout: 15000 }, (err, stdout, stderr) => cb(err, (stderr||stdout||'').trim())),
        '.mjs': (fp, cb) => execFile('node', ['--check', fp], { timeout: 15000 }, (err, stdout, stderr) => cb(err, (stderr||stdout||'').trim())),
        '.cjs': (fp, cb) => execFile('node', ['--check', fp], { timeout: 15000 }, (err, stdout, stderr) => cb(err, (stderr||stdout||'').trim())),
        '.py': (fp, cb) => execFile('python', ['-m', 'py_compile', fp], { timeout: 15000 }, (err, stdout, stderr) => cb(err, (stderr||stdout||'').trim())),
        '.json': jsonLint,
        '.html': htmlLint,
        '.css': cssLint,
      };
      if (req.method === 'POST' && req.url === '/lint-file') {
        readBody(req).then(body => {
          try {
            const { path: fp } = JSON.parse(body);
            if (!fp) { res.writeHead(400); res.end('{"error":"missing path"}'); return; }
            const resolved = safePath(fp);
            if (!resolved) { res.writeHead(403); res.end('{"error":"forbidden path"}'); return; }
            const ext = path.extname(resolved).toLowerCase();
            const lintFn = lintChecks[ext];
            if (!lintFn) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:null,output:'该文件类型不支持语法检查，已跳过'})); return; }
            lintFn(resolved, (err, output) => {
              if (err && output) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,output:output.substring(0,1000)})); return; }
              if (err && !output) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,output:err.message})); return; }
              res.writeHead(200,{'Content-Type':'application/json'});
              res.end(JSON.stringify({ok:true,output:output||'语法正确'}));
            });
          } catch(e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
        });
        return;
      }
      // 网页抓取（web_fetch 工具）：支持重定向跟随、gzip/deflate 解压、charset 解码、超时中断、可选截断翻页
      if (req.method === 'POST' && req.url === '/web-fetch') {
        readBody(req).then(body => {
          try {
            const { url, maxLen, offset } = JSON.parse(body);
            if (!url) { res.writeHead(400); res.end('{"error":"empty url"}'); return; }
            const osStr = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : process.platform === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64';
            const UA = `Mozilla/5.0 (${osStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36`;
            const MAX_BYTES = 500000; // 最多下载 500KB 原始内容，避免大页面卡死
            const fetchUrl = (target, redirectsLeft) => {
              const mod = target.startsWith('https') ? https : http;
              const reqGet = mod.get(target, { timeout: 30000, headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } }, (resp) => {
                // 跟随重定向（301/302/303/307/308）
                if ([301,302,303,307,308].includes(resp.statusCode) && resp.headers.location && redirectsLeft > 0) {
                  resp.resume();
                  const next = new URL(resp.headers.location, target).href;
                  return fetchUrl(next, redirectsLeft - 1);
                }
                const chunks = [];
                let size = 0;
                resp.on('data', c => { chunks.push(c); size += c.length; if (size > MAX_BYTES) reqGet.destroy(); });
                resp.on('end', () => {
                  try {
                    let buf = Buffer.concat(chunks);
                    const enc = (resp.headers['content-encoding'] || '').toLowerCase();
                    if (enc === 'gzip') buf = zlib.gunzipSync(buf);
                    else if (enc === 'deflate') buf = zlib.inflateSync(buf);
                    const ct = resp.headers['content-type'] || '';
                    const cm = ct.match(/charset=([\w-]+)/i);
                    const charset = (cm && cm[1] ? cm[1].toLowerCase() : 'utf-8');
                    let html;
                    if (charset === 'utf-8' || charset === 'utf8') html = buf.toString('utf-8');
                    else if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') html = new TextDecoder('gbk').decode(buf);
                    else { try { html = new TextDecoder(charset).decode(buf); } catch(e) { html = buf.toString('utf-8'); } }
                    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'')
                      .replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
                    const cap = (maxLen && maxLen > 0) ? maxLen : 5000;
                    const start = (offset && offset > 0) ? offset : 0;
                    const sliced = text.slice(start, start + cap);
                    res.writeHead(200, {'Content-Type':'application/json'});
                    res.end(JSON.stringify({ content: sliced, truncated: text.length > start + cap }));
                  } catch(e) {
                    res.writeHead(500, {'Content-Type':'application/json'});
                    res.end(JSON.stringify({ error: '解析失败: ' + e.message }));
                  }
                });
              });
              reqGet.on('timeout', () => reqGet.destroy(new Error('请求超时')));
              reqGet.on('error', e => { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({ error: e.message })); });
            };
            fetchUrl(url, 5);
          } catch(e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
        });
        return;
      }
      // 获取项目根目录路径
      if (req.method === 'GET' && req.url === '/project-root') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(__dirname);
        return;
      }
      // 项目文件索引（2层深度）
      if (req.method === 'GET' && req.url === '/project-index') {
        const list=[];
        function scanDir(dir, depth){
          let entries;
          try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch(e){return;}
          for(const e of entries){
            if(e.name.startsWith('.')||e.name==='node_modules'||e.name==='data')continue;
            const rel=path.relative(__dirname,path.join(dir,e.name));
            if(e.isDirectory()){
              if(depth===0)list.push({path:rel+'/',size:0,lines:0,isDir:true});
              if(depth<1)scanDir(path.join(dir,e.name),depth+1);
            }else{
              list.push({path:rel,size:fs.statSync(path.join(dir,e.name)).size,lines:fs.readFileSync(path.join(dir,e.name),'utf-8').split('\n').length});
            }
          }
        }
        scanDir(__dirname,0);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify(list));
        return;
      }
      // MCP 工具列表（按需连接）
      if (req.method === 'GET' && req.url === '/mcp-tools') {
        console.log('[mcp] 收到工具列表请求');
        mcp.getToolDefinitions().then(tools => {
          console.log('[mcp] 返回', tools.length, '个工具');
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify(tools));
        }).catch(e => {
          console.warn('[mcp] 错误:', e.message);
          res.writeHead(200, {'Content-Type':'application/json'}); res.end('[]');
        });
        return;
      }
      // MCP 工具调用
      if (req.method === 'POST' && req.url === '/mcp-call') {
        readBody(req).then(async body => {
          try {
            const { name, args } = JSON.parse(body);
            if (!name) { res.writeHead(400); res.end('{"error":"empty name"}'); return; }
            const result = await mcp.callTool(name, args || {});
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ result }));
          } catch (e) {
            res.writeHead(500, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
      // MCP 添加单个技能（比全量重载更高效）
      if (req.method === 'POST' && req.url === '/mcp-add-skill') {
        readBody(req).then(async body => {
          try {
            const { id, cfg } = JSON.parse(body);
            if (!id || !cfg) { res.writeHead(400); res.end('{"error":"missing id or cfg"}'); return; }
            await mcp.addServer(id, cfg);
            res.writeHead(200); res.end();
          } catch (e) {
            res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
      // MCP 移除单个技能
      if (req.method === 'POST' && req.url === '/mcp-remove-skill') {
        readBody(req).then(async body => {
          try {
            const { id } = JSON.parse(body);
            if (!id) { res.writeHead(400); res.end('{"error":"missing id"}'); return; }
            await mcp.removeServer(id);
            res.writeHead(200); res.end();
          } catch (e) {
            res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
      // MCP 重载（添加/卸载技能后重新连接）
      if (req.method === 'POST' && req.url === '/mcp-reload') {
        mcp.reload().then(() => { res.writeHead(200); res.end(); }).catch(() => { res.writeHead(500); res.end(); });
        return;
      }
      // MCP 调试状态
      if (req.method === 'GET' && req.url === '/mcp-status') {
        mcp.getToolDefinitions().then(tools => {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({toolCount: tools.length}));
        }).catch(e => { res.writeHead(500); res.end(JSON.stringify({error: e.message})); });
        return;
      }
      // 搜索 npm 上的 MCP 拓展工具（用户可发现官方清单之外的任意拓展工具），带 30s 缓存
      if (req.method === 'GET' && req.url.startsWith('/search-mcp?')) {
        const u = new URL(req.url, 'http://localhost');
        const q = (u.searchParams.get('q') || '').trim() || 'mcp';
        const now = Date.now();
        if (_mcpSearchCache.data && _mcpSearchCache.key === q && now - _mcpSearchCache.ts < 30000) {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify(_mcpSearchCache.data));
          return;
        }
        const apiUrl = 'https://registry.npmjs.org/-/v1/search?text=' + encodeURIComponent(q + ' mcp') + '&size=25';
        https.get(apiUrl, resp => {
          let buf = '';
          resp.on('data', d => buf += d);
          resp.on('end', () => {
            try {
              const json = JSON.parse(buf);
              const items = (json.objects || []).map(o => ({
                name: o.package.name,
                version: o.package.version,
                description: o.package.description || '',
                links: o.package.links || {}
              }));
              _mcpSearchCache.key = q;
              _mcpSearchCache.ts = Date.now();
              _mcpSearchCache.data = items;
              res.writeHead(200, {'Content-Type':'application/json'});
              res.end(JSON.stringify(items));
            } catch (e) {
              res.writeHead(500, {'Content-Type':'application/json'});
              res.end(JSON.stringify({ error: '解析 npm 响应失败: ' + e.message }));
            }
          });
        }).on('error', e => {
          res.writeHead(500, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ error: e.message }));
        });
        return;
      }
      // 读取已安装拓展工具列表（skills.html 渲染已安装状态；重启后 mcp.js 也读此文件自动重连）
      if (req.method === 'GET' && req.url === '/load-skills') {
        storage.loadData('skills').then(raw => {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(raw);
        });
        return;
      }
      // 保存已安装拓展工具列表到 .skills.json（用户安装/卸载后持久化，重启自动恢复）
      if (req.method === 'POST' && req.url === '/save-skills') {
        readBody(req).then(body => {
          storage.saveData('skills', body).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }).catch(e => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          });
        });
        return;
      }
      // 读取内置工具开关配置（renderer 组装 tools 时过滤被取消的工具）
      if (req.method === 'GET' && req.url === '/load-tools-cfg') {
        storage.loadData('tools').then(raw => {
          try { const j = JSON.parse(raw); res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ disabled: j.disabled || [] })); }
          catch (e) { res.writeHead(200, {'Content-Type':'application/json'}); res.end('{"disabled":[]}'); }
        });
        return;
      }
      // 保存内置工具开关配置（页面勾选后写入 .tools.json）
      if (req.method === 'POST' && req.url === '/save-tools-cfg') {
        readBody(req).then(body => {
          try {
            const j = JSON.parse(body);
            const disabled = Array.isArray(j.disabled) ? j.disabled : [];
            storage.saveData('tools', JSON.stringify({ disabled })).then(() => {
              res.writeHead(200, {'Content-Type':'application/json'});
              res.end(JSON.stringify({ ok: true }));
            });
          } catch (e) {
            res.writeHead(400, {'Content-Type':'application/json'});
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
      let fn = req.url === '/' || req.url.startsWith('/?') ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
      // 禁止直接访问 data/ 目录下的敏感文件
      if (fn.startsWith('/data/') || fn.startsWith('/.')) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      let fp = path.join(__dirname, fn);
      // 防止路径遍历攻击：确保文件在项目目录内
      const resolved = path.resolve(fp);
      const b = path.resolve(__dirname);
      const r2 = path.relative(b, resolved);
      if (!r2 || r2.startsWith('..') || path.isAbsolute(r2)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      fs.readFile(fp, (e, d) => {
        if (e) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME_MAP[path.extname(fp)] || 'application/octet-stream' });
        res.end(d);
      });
    } catch(e) { console.error('[server] 异常:', e.message); try { res.writeHead(500); res.end(); } catch(ee) {} }
    });
    server.listen(0, '127.0.0.1', () => r(server.address().port));
  });
}

// 捕获任何未预期的错误，避免静默崩溃
process.on('uncaughtException', (err) => console.error('[CRASH] uncaughtException:', err.message, err.stack));
process.on('unhandledRejection', (reason) => console.error('[CRASH] unhandledRejection:', reason));

app.whenReady().then(async () => {
  // 尝试读取安装时写入的数据路径配置（安装目录下的 data-path.ini）
  // 如果不存在则回退到 app.getPath('userData')
  let dataPath = app.getPath('userData');
  const dataPathIni = path.join(path.dirname(app.getPath('exe')), 'data-path.ini');
  try {
    if (fs.existsSync(dataPathIni)) {
      const customPath = fs.readFileSync(dataPathIni, 'utf-8').trim();
      if (customPath) dataPath = customPath;
    }
  } catch (e) {
    console.warn('[main] 读取 data-path.ini 失败:', e.message);
  }
  // 确保用户数据目录在可写位置，避免 Program Files 下写入失败
  storage.init(dataPath);
  // 启动时主动写出状态文件（默认配置），便于用户直接查看与管理；不会覆盖已有内容
  const ensureCfg = (name, def) => {
    const p = storage.getPath(name);
    if (!fs.existsSync(p)) { try { fs.writeFileSync(p, def); } catch (e) { console.warn(`[main] 初始化 ${name} 配置失败:`, e.message); } }
  };
  ensureCfg('tools', JSON.stringify({ disabled: [] }));
  ensureCfg('skills', JSON.stringify({ installed: {} }));
  ensureCfg('instructions', JSON.stringify({ list: [] }));
  const port = await startServer();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: 280, height: 460, x: sw - 278, y: sh - 465,
    transparent: true, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    backgroundThrottling: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => console.error('[main] 渲染进程崩溃:', details.reason));
  mainWindow.webContents.on('did-fail-load', (event, code, desc) => console.error('[main] 页面加载失败:', code, desc));
  // 授予麦克风权限（语音输入使用 getUserMedia / MediaRecorder）
  mainWindow.webContents.session.setPermissionRequestHandler((_, permission, cb) => {
    if (permission === 'media' || permission === 'microphone' || permission === 'audioCapture') cb(true);
    else cb(false);
  });
  mainWindow.on('closed', () => { console.log('[main] 窗口已关闭'); mainWindow = null; });
  mainWindow.loadURL(`http://127.0.0.1:${port}`).then(() => {
    console.log('[main] 页面加载成功');
    mainWindow.webContents.openDevTools({mode:'detach'});
  }).catch(e => console.error('[main] 加载页面失败:', e.message));




  // 使用 Windows API 将窗口推到所有页面底层
  let _user32 = null;
  try {
    const koffi = require('koffi');
    _user32 = koffi.load('user32.dll');
    _user32.func('int SetWindowPos(void* hWnd, int hWndInsertAfter, int X, int Y, int cx, int cy, int flags)');
  } catch(e) { console.warn('[main] user32 加载失败:', e.message); }

  ipcMain.on('show-menu', (_, x, y, hasApi, voiceOn, pinOn) => {
    Menu.buildFromTemplate([
      {
        label: '😊 表情/手势/装饰',
        submenu: [
              { label: '😍 爱心眼', click: () => mainWindow.webContents.send('menu', 'expr', '爱心眼') },
              { label: '✨ 星星眼', click: () => mainWindow.webContents.send('menu', 'expr', '星星眼') },
              { label: '🥰 脸红', click: () => mainWindow.webContents.send('menu', 'expr', '脸红') },
              { label: '🖤 黑脸', click: () => mainWindow.webContents.send('menu', 'expr', '黑脸') },
              { label: '😊 卖萌', click: () => mainWindow.webContents.send('menu', 'expr', '卖萌') },
              { label: '❓ 问号', click: () => mainWindow.webContents.send('menu', 'expr', '问号') },
              { label: '😵 悲伤', click: () => mainWindow.webContents.send('menu', 'expr', '晕晕眼') },
              { label: '😢 生气', click: () => mainWindow.webContents.send('menu', 'expr', '哀怒') },
              { type: 'separator' },
              { label: '👋 左手势1', click: () => mainWindow.webContents.send('menu', 'gesture', '左手势1') },
              { label: '🖐️ 右手势1', click: () => mainWindow.webContents.send('menu', 'gesture', '右手势1') },
              { label: '✌️ 左手势2', click: () => mainWindow.webContents.send('menu', 'gesture', '左手势2') },
              { label: '✋ 右手势2', click: () => mainWindow.webContents.send('menu', 'gesture', '右手势2') },
              { type: 'separator' },
              { label: '🎀 丸子头', click: () => mainWindow.webContents.send('menu', 'deco', '丸子头') },
              { label: '👓 眼镜', click: () => mainWindow.webContents.send('menu', 'deco', '眼镜') },
              { label: '🧝 精灵耳', click: () => mainWindow.webContents.send('menu', 'deco', '精灵耳') },
            ]
          },
          {
            label: '💃 动作',
            submenu: [
          // ===== 😊 开心（20个） =====
          { label: '😊 开心', submenu: [
            { label: '爱心握拳L', click: () => mainWindow.webContents.send('menu', 'action', '开心爱心握拳L') },
            { label: '爱心握拳R', click: () => mainWindow.webContents.send('menu', 'action', '开心爱心握拳R') },
            { label: '爱心双拳', click: () => mainWindow.webContents.send('menu', 'action', '开心爱心双拳') },
            { label: '爱心伸左', click: () => mainWindow.webContents.send('menu', 'action', '开心爱心伸左') },
            { label: '爱心双指', click: () => mainWindow.webContents.send('menu', 'action', '开心爱心双指') },
            { label: '星星握拳L', click: () => mainWindow.webContents.send('menu', 'action', '开心星星握拳L') },
            { label: '星星握拳R', click: () => mainWindow.webContents.send('menu', 'action', '开心星星握拳R') },
            { label: '星星双拳', click: () => mainWindow.webContents.send('menu', 'action', '开心星星双拳') },
            { label: '星星伸左', click: () => mainWindow.webContents.send('menu', 'action', '开心星星伸左') },
            { label: '星星伸右', click: () => mainWindow.webContents.send('menu', 'action', '开心星星伸右') },
            { label: '卖萌握拳L', click: () => mainWindow.webContents.send('menu', 'action', '开心卖萌握拳L') },
            { label: '卖萌握拳R', click: () => mainWindow.webContents.send('menu', 'action', '开心卖萌握拳R') },
            { label: '卖萌伸左', click: () => mainWindow.webContents.send('menu', 'action', '开心卖萌伸左') },
            { label: '卖萌双指', click: () => mainWindow.webContents.send('menu', 'action', '开心卖萌双指') },
            { label: '脸红爱心握拳', click: () => mainWindow.webContents.send('menu', 'action', '开心脸红爱心握拳') },
            { label: '脸红星星握拳', click: () => mainWindow.webContents.send('menu', 'action', '开心脸红星星握拳') },
            { label: '脸红卖萌歪头', click: () => mainWindow.webContents.send('menu', 'action', '开心脸红卖萌歪头') },
            { label: '开心点头', click: () => mainWindow.webContents.send('menu', 'action', '开心点头') },
            { label: '摇头晃脑', click: () => mainWindow.webContents.send('menu', 'action', '开心摇头晃脑') },
            { label: '超级开心', click: () => mainWindow.webContents.send('menu', 'action', '开心超级开心') },
          ]},
          // ===== 😠 生气（20个） =====
          { label: '😠 生气', submenu: [
            { label: '黑脸握拳L', click: () => mainWindow.webContents.send('menu', 'action', '生气黑脸握拳L') },
            { label: '黑脸握拳R', click: () => mainWindow.webContents.send('menu', 'action', '生气黑脸握拳R') },
            { label: '黑脸双拳', click: () => mainWindow.webContents.send('menu', 'action', '生气黑脸双拳') },
            { label: '黑脸伸左', click: () => mainWindow.webContents.send('menu', 'action', '生气黑脸伸左') },
            { label: '黑脸伸右', click: () => mainWindow.webContents.send('menu', 'action', '生气黑脸伸右') },
            { label: '黑脸摇头', click: () => mainWindow.webContents.send('menu', 'action', '生气黑脸摇头') },
            { label: '黑脸持续摇头', click: () => mainWindow.webContents.send('menu', 'action', '生气黑脸持续摇头') },
            { label: '黑脸左偏', click: () => mainWindow.webContents.send('menu', 'action', '生气黑脸左偏') },
            { label: '黑脸右偏', click: () => mainWindow.webContents.send('menu', 'action', '生气黑脸右偏') },
            { label: '黑脸低头不理', click: () => mainWindow.webContents.send('menu', 'action', '生气黑脸低头不理') },
            { label: '哀怒握拳L', click: () => mainWindow.webContents.send('menu', 'action', '生气哀怒握拳L') },
            { label: '哀怒握拳R', click: () => mainWindow.webContents.send('menu', 'action', '生气哀怒握拳R') },
            { label: '哀怒双拳', click: () => mainWindow.webContents.send('menu', 'action', '生气哀怒双拳') },
            { label: '哀怒伸左', click: () => mainWindow.webContents.send('menu', 'action', '生气哀怒伸左') },
            { label: '哀怒伸右', click: () => mainWindow.webContents.send('menu', 'action', '生气哀怒伸右') },
            { label: '指前', click: () => mainWindow.webContents.send('menu', 'action', '生气指前') },
            { label: '持续低头', click: () => mainWindow.webContents.send('menu', 'action', '生气持续低头') },
            { label: '歪头', click: () => mainWindow.webContents.send('menu', 'action', '生气歪头') },
            { label: '转身', click: () => mainWindow.webContents.send('menu', 'action', '生气转身') },
            { label: '暴怒', click: () => mainWindow.webContents.send('menu', 'action', '生气暴怒') },
          ]},
          // ===== 😢 悲伤（20个） =====
          { label: '😢 悲伤', submenu: [
            { label: '低头握拳L', click: () => mainWindow.webContents.send('menu', 'action', '悲伤低头握拳L') },
            { label: '低头握拳R', click: () => mainWindow.webContents.send('menu', 'action', '悲伤低头握拳R') },
            { label: '低头双拳', click: () => mainWindow.webContents.send('menu', 'action', '悲伤低头双拳') },
            { label: '低头伸左', click: () => mainWindow.webContents.send('menu', 'action', '悲伤低头伸左') },
            { label: '低头伸右', click: () => mainWindow.webContents.send('menu', 'action', '悲伤低头伸右') },
            { label: '长低头', click: () => mainWindow.webContents.send('menu', 'action', '悲伤长低头') },
            { label: '摇头', click: () => mainWindow.webContents.send('menu', 'action', '悲伤摇头') },
            { label: '左歪头', click: () => mainWindow.webContents.send('menu', 'action', '悲伤左歪头') },
            { label: '右歪头', click: () => mainWindow.webContents.send('menu', 'action', '悲伤右歪头') },
            { label: '低头双指', click: () => mainWindow.webContents.send('menu', 'action', '悲伤低头双指') },
            { label: '晕眩握拳L', click: () => mainWindow.webContents.send('menu', 'action', '悲伤晕眩握拳L') },
            { label: '晕眩握拳R', click: () => mainWindow.webContents.send('menu', 'action', '悲伤晕眩握拳R') },
            { label: '晕眩双拳', click: () => mainWindow.webContents.send('menu', 'action', '悲伤晕眩双拳') },
            { label: '晕眩伸左', click: () => mainWindow.webContents.send('menu', 'action', '悲伤晕眩伸左') },
            { label: '晕眩伸右', click: () => mainWindow.webContents.send('menu', 'action', '悲伤晕眩伸右') },
            { label: '委屈摇头', click: () => mainWindow.webContents.send('menu', 'action', '悲伤委屈摇头') },
            { label: '委屈伸左', click: () => mainWindow.webContents.send('menu', 'action', '悲伤委屈伸左') },
            { label: '捂脸', click: () => mainWindow.webContents.send('menu', 'action', '悲伤捂脸') },
            { label: '抽泣', click: () => mainWindow.webContents.send('menu', 'action', '悲伤抽泣') },
            { label: '泪目', click: () => mainWindow.webContents.send('menu', 'action', '悲伤泪目') },
          ]},
          // ===== ❓ 疑问（20个） =====
          { label: '❓ 疑问', submenu: [
            { label: '握拳L歪头', click: () => mainWindow.webContents.send('menu', 'action', '疑问握拳L歪头') },
            { label: '握拳R歪头', click: () => mainWindow.webContents.send('menu', 'action', '疑问握拳R歪头') },
            { label: '双拳歪头', click: () => mainWindow.webContents.send('menu', 'action', '疑问双拳歪头') },
            { label: '伸左歪头', click: () => mainWindow.webContents.send('menu', 'action', '疑问伸左歪头') },
            { label: '伸右歪头', click: () => mainWindow.webContents.send('menu', 'action', '疑问伸右歪头') },
            { label: '双指歪头', click: () => mainWindow.webContents.send('menu', 'action', '疑问双指歪头') },
            { label: '持续歪头', click: () => mainWindow.webContents.send('menu', 'action', '疑问持续歪头') },
            { label: '左歪头', click: () => mainWindow.webContents.send('menu', 'action', '疑问左歪头') },
            { label: '右歪头', click: () => mainWindow.webContents.send('menu', 'action', '疑问右歪头') },
            { label: '低头', click: () => mainWindow.webContents.send('menu', 'action', '疑问低头') },
            { label: '抬头', click: () => mainWindow.webContents.send('menu', 'action', '疑问抬头') },
            { label: '握拳左歪', click: () => mainWindow.webContents.send('menu', 'action', '疑惑握拳左歪') },
            { label: '握拳右歪', click: () => mainWindow.webContents.send('menu', 'action', '疑惑握拳右歪') },
            { label: '双拳', click: () => mainWindow.webContents.send('menu', 'action', '疑惑双拳') },
            { label: '伸左', click: () => mainWindow.webContents.send('menu', 'action', '疑惑伸左') },
            { label: '伸右', click: () => mainWindow.webContents.send('menu', 'action', '疑惑伸右') },
            { label: '挠头', click: () => mainWindow.webContents.send('menu', 'action', '疑惑挠头') },
            { label: '左顾', click: () => mainWindow.webContents.send('menu', 'action', '疑问左顾') },
            { label: '右盼', click: () => mainWindow.webContents.send('menu', 'action', '疑问右盼') },
            { label: '疑惑不解', click: () => mainWindow.webContents.send('menu', 'action', '疑惑不解') },
          ]},
          // ===== 😲 惊讶（20个） =====
          { label: '😲 惊讶', submenu: [
            { label: '张嘴握拳', click: () => mainWindow.webContents.send('menu', 'action', '惊讶张嘴握拳') },
            { label: '张嘴双拳', click: () => mainWindow.webContents.send('menu', 'action', '惊讶张嘴双拳') },
            { label: '张嘴伸左', click: () => mainWindow.webContents.send('menu', 'action', '惊讶张嘴伸左') },
            { label: '张嘴伸右', click: () => mainWindow.webContents.send('menu', 'action', '惊讶张嘴伸右') },
            { label: '张嘴双指', click: () => mainWindow.webContents.send('menu', 'action', '惊讶张嘴双指') },
            { label: '惊喜握拳L', click: () => mainWindow.webContents.send('menu', 'action', '惊喜握拳L') },
            { label: '惊喜握拳R', click: () => mainWindow.webContents.send('menu', 'action', '惊喜握拳R') },
            { label: '惊喜双拳', click: () => mainWindow.webContents.send('menu', 'action', '惊喜双拳') },
            { label: '惊喜伸左', click: () => mainWindow.webContents.send('menu', 'action', '惊喜伸左') },
            { label: '惊喜伸右', click: () => mainWindow.webContents.send('menu', 'action', '惊喜伸右') },
            { label: '后退', click: () => mainWindow.webContents.send('menu', 'action', '惊讶后退') },
            { label: '低头', click: () => mainWindow.webContents.send('menu', 'action', '惊讶低头') },
            { label: '歪头', click: () => mainWindow.webContents.send('menu', 'action', '惊讶歪头') },
            { label: '摇头', click: () => mainWindow.webContents.send('menu', 'action', '惊讶摇头') },
            { label: '持续张嘴', click: () => mainWindow.webContents.send('menu', 'action', '惊讶持续张嘴') },
            { label: '惊喜脸红', click: () => mainWindow.webContents.send('menu', 'action', '惊喜脸红') },
            { label: '惊喜歪头', click: () => mainWindow.webContents.send('menu', 'action', '惊喜歪头') },
            { label: '目瞪口呆', click: () => mainWindow.webContents.send('menu', 'action', '目瞪口呆') },
            { label: '点头', click: () => mainWindow.webContents.send('menu', 'action', '惊讶点头') },
            { label: '超级惊讶', click: () => mainWindow.webContents.send('menu', 'action', '超级惊讶') },
          ]},
          // ===== 😳 害羞（20个） =====
          { label: '😳 害羞', submenu: [
            { label: '低头L', click: () => mainWindow.webContents.send('menu', 'action', '害羞低头L') },
            { label: '低头R', click: () => mainWindow.webContents.send('menu', 'action', '害羞低头R') },
            { label: '捂脸', click: () => mainWindow.webContents.send('menu', 'action', '害羞捂脸') },
            { label: '伸左低头', click: () => mainWindow.webContents.send('menu', 'action', '害羞伸左低头') },
            { label: '伸右低头', click: () => mainWindow.webContents.send('menu', 'action', '害羞伸右低头') },
            { label: '双指低头', click: () => mainWindow.webContents.send('menu', 'action', '害羞双指低头') },
            { label: '持续低头', click: () => mainWindow.webContents.send('menu', 'action', '害羞持续低头') },
            { label: '左歪头', click: () => mainWindow.webContents.send('menu', 'action', '害羞左歪头') },
            { label: '右歪头', click: () => mainWindow.webContents.send('menu', 'action', '害羞右歪头') },
            { label: '偷看', click: () => mainWindow.webContents.send('menu', 'action', '害羞偷看') },
            { label: '爱心眼', click: () => mainWindow.webContents.send('menu', 'action', '害羞爱心眼') },
            { label: '卖萌', click: () => mainWindow.webContents.send('menu', 'action', '害羞卖萌') },
            { label: '捂脸摇头', click: () => mainWindow.webContents.send('menu', 'action', '害羞捂脸摇头') },
            { label: '转身', click: () => mainWindow.webContents.send('menu', 'action', '害羞转身') },
            { label: '扭捏', click: () => mainWindow.webContents.send('menu', 'action', '害羞扭捏') },
            { label: '伸左歪头', click: () => mainWindow.webContents.send('menu', 'action', '害羞伸左歪头') },
            { label: '伸右歪头', click: () => mainWindow.webContents.send('menu', 'action', '害羞伸右歪头') },
            { label: '低头玩手指', click: () => mainWindow.webContents.send('menu', 'action', '害羞低头玩手指') },
            { label: '不敢看', click: () => mainWindow.webContents.send('menu', 'action', '害羞不敢看') },
            { label: '心动', click: () => mainWindow.webContents.send('menu', 'action', '害羞心动') },
          ]},
        ]
          },
      { type: 'separator' },
      { label: '🧰 内置工具', click: () => mainWindow.webContents.send('menu', 'tools', '') },
      { label: '🧩 拓展工具', click: () => mainWindow.webContents.send('menu', 'skills', '') },
      { label: '📋 自定义指令', click: () => mainWindow.webContents.send('menu', 'instructions', '') },
      { type: 'separator' },
      hasApi
        ? { label: '✅ 已配置AI', click: () => mainWindow.webContents.send('menu', 'config', '') }
        : { label: '⚙️ 配置AI', click: () => mainWindow.webContents.send('menu', 'config', '') },
      { type: 'separator' },
      { label: '💬 聊天', click: () => mainWindow.webContents.send('menu', 'chat', '') },
      { type: 'separator' },
      voiceOn
        ? { label: '🔊 关闭语音', click: () => mainWindow.webContents.send('menu', 'voice', 'off') }
        : { label: '🔇 开启语音', click: () => mainWindow.webContents.send('menu', 'voice', 'on') },
      { type: 'separator' },
      { label: '🔄 重置', click: () => mainWindow.webContents.send('menu', 'reset', '') },
      { type: 'separator' },
      pinOn
        ? { label: '🙈 隐藏', click: () => mainWindow.webContents.send('menu', 'pin', '') }
        : { label: '👁️ 显示', click: () => mainWindow.webContents.send('menu', 'pin', '') },
      { type: 'separator' },
      { label: '🚪 退出', click: () => app.quit() },
    ]).popup({ window: mainWindow, x, y });
  });
  // 聊天窗口
  ipcMain.on('open-chat-window', () => {
    if (chatWindow && !chatWindow.isDestroyed()) { if(chatWindow.isMinimized())chatWindow.restore(); chatWindow.focus(); return; }
    chatWindow = new BrowserWindow({
      width: 340, height: 480, resizable: false,
      transparent: false, frame: false, skipTaskbar: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
    });
    chatWindow.loadURL(`http://127.0.0.1:${port}/chat.html`);
    // 已移除语音输入功能
    chatWindow.on('closed', () => { chatWindow = null; });
  });
  // AI配置窗口
  ipcMain.on('open-ai-cfg-window', () => {
    if (aiCfgWindow && !aiCfgWindow.isDestroyed()) { if(aiCfgWindow.isMinimized())aiCfgWindow.restore(); aiCfgWindow.focus(); return; }
    aiCfgWindow = new BrowserWindow({
      width: 360, height: 360, resizable: false,
      transparent: false, frame: false, skipTaskbar: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
    });
    aiCfgWindow.loadURL(`http://127.0.0.1:${port}/ai-cfg.html`);
    aiCfgWindow.on('closed', () => { aiCfgWindow = null; if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('ai-cfg-window-closed'); });
  });
  // 技能管理窗口
  ipcMain.on('open-skills-window', () => {
    if (skillsWindow && !skillsWindow.isDestroyed()) { if(skillsWindow.isMinimized())skillsWindow.restore(); skillsWindow.focus(); return; }
    skillsWindow = new BrowserWindow({
      width: 380, height: 560, resizable: false,
      transparent: false, frame: false, skipTaskbar: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
    });
    skillsWindow.loadURL(`http://127.0.0.1:${port}/skills.html`);
    skillsWindow.on('closed', () => { skillsWindow = null; });
  });
  // 内置工具管理窗口
  ipcMain.on('open-tools-window', () => {
    if (toolsWindow && !toolsWindow.isDestroyed()) { if(toolsWindow.isMinimized())toolsWindow.restore(); toolsWindow.focus(); return; }
    toolsWindow = new BrowserWindow({
      width: 380, height: 460, resizable: false,
      transparent: false, frame: false, skipTaskbar: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
    });
    toolsWindow.loadURL(`http://127.0.0.1:${port}/tools.html`);
    toolsWindow.on('closed', () => { toolsWindow = null; });
  });
  // 自定义指令窗口
  ipcMain.on('open-instructions-window', () => {
    if (instructionsWindow && !instructionsWindow.isDestroyed()) { if(instructionsWindow.isMinimized())instructionsWindow.restore(); instructionsWindow.focus(); return; }
    instructionsWindow = new BrowserWindow({
      width: 380, height: 460, resizable: false,
      transparent: false, frame: false, skipTaskbar: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
    });
    instructionsWindow.loadURL(`http://127.0.0.1:${port}/instructions.html`);
    instructionsWindow.on('closed', () => { instructionsWindow = null; });
  });
  // 隐藏/显示宠物：隐藏时推到窗口最底层，显示时置顶
  ipcMain.on('toggle-pin', () => {
    _windowOnTop = !_windowOnTop;
    if (!_windowOnTop) {
      // 隐藏：取消置顶 + 推到窗口最底层
      mainWindow.setAlwaysOnTop(false);
      if (_user32) {
        try {
          const hWnd = mainWindow.getNativeWindowHandle();
          const HWND_BOTTOM = 1;
          const SWP_NOSIZE = 0x0001;
          const SWP_NOMOVE = 0x0002;
          const SWP_NOACTIVATE = 0x0010;
          _user32.SetWindowPos(hWnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
        } catch(e) { console.warn('[main] SetWindowPos 失败:', e.message); }
      }
      mainWindow.blur();
    } else {
      // 显示：先恢复窗口再置顶
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(true, 'floating');
      if (_user32) {
        try {
          const hWnd = mainWindow.getNativeWindowHandle();
          const HWND_TOPMOST = -1;
          const SWP_NOSIZE = 0x0001;
          const SWP_NOMOVE = 0x0002;
          const SWP_SHOWWINDOW = 0x0040;
          _user32.SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW);
        } catch(e) { console.warn('[main] SetWindowPos 失败:', e.message); }
      }
      // 延迟重试确保窗口进入顶层
      setTimeout(() => {
        try {
          if (!mainWindow.isDestroyed() && _windowOnTop) {
            mainWindow.setAlwaysOnTop(true, 'floating');
            if (_user32) {
              _user32.SetWindowPos(mainWindow.getNativeWindowHandle(), -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
            }
          }
        } catch(e) {}
      }, 100);
    }
  });
  // 窗口失焦后自动恢复置顶（防止 Windows 透明窗口点击后掉层级）
  mainWindow.on('focus', () => { if (_windowOnTop) mainWindow.setAlwaysOnTop(true, 'floating'); });
  mainWindow.on('blur', () => { if (_windowOnTop) setTimeout(() => { try { mainWindow.setAlwaysOnTop(true, 'floating'); } catch(e) {} }, 50); });


  // 全局 AI 调用锁
  let aiLock = { busy: false, type: null, webContents: null };
  ipcMain.handle('ai-start', (event, type) => {
    if (aiLock.busy) {
      // 聊天优先：抢断其他类型的调用
      if (type === 'chat' && aiLock.type !== 'chat') {
        const prev = aiLock.webContents;
        aiLock.webContents = event.sender;
        aiLock.type = 'chat';
        aiLock.busy = true;
        if (prev && !prev.isDestroyed()) { try { prev.send('ai-abort'); } catch(e) { /* 窗口可能已销毁 */ } }
        return true;
      }
      return false; // 忙，拒绝
    }
    aiLock.webContents = event.sender;
    aiLock.type = type;
    aiLock.busy = true;
    return true;
  });
  ipcMain.handle('ai-done', (event) => {
    if (aiLock.webContents === event.sender || !aiLock.webContents) {
      aiLock.busy = false; aiLock.type = null; aiLock.webContents = null;
    }
    return true;
  });
  ipcMain.handle('is-ai-busy', () => aiLock.busy);
  // 跨窗口通信
  ipcMain.on('pet-to-chat', (_, data) => { if(chatWindow&&!chatWindow.isDestroyed())chatWindow.webContents.send('from-pet-window', data); });
  ipcMain.on('chat-to-pet', (_, data) => { if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('from-chat-window', data); });
  // 子窗口最小化
  ipcMain.on('minimize-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
  });
  // 打开开发者工具
  ipcMain.on('open-devtools', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.webContents.openDevTools({mode:'detach'});
  });

});
app.on('window-all-closed', () => {
  mcp.disconnectAll();
  server?.close();
  if (process.platform !== 'darwin') app.quit();
});
