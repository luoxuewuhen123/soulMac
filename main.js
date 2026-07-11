const { app, BrowserWindow, ipcMain, Menu, screen, dialog } = require('electron');
// 禁用安全策略警告（本地桌面宠物应用，非 Web 环境）
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

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
const os = require('os');
const zlib = require('zlib');
// TTS 使用子进程，避免 Electron 环境兼容性问题
// edge-tts-universal 改为在 tts-worker.js 中通过系统 Node.js 调用
const storage = require('./storage');
const mcp = require('./mcp');

// TTS 合成结果内存缓存：相同文本直接复用，避免重复联网合成
const ttsCache = new Map();
const TTS_CACHE_MAX = 80;

// 文本解码：自动检测 UTF-8/GBK，避免中文 Windows 文件乱码
function decodeText(buf) {
  // 先尝试 UTF-8（严格模式：无效字节直接抛异常）
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) {
    // UTF-8 失败 → 尝试 GB18030（GBK 超集，覆盖所有中文 Windows 编码）
    try { return new TextDecoder('gb18030', { fatal: false }).decode(buf); }
    catch (e2) { return buf.toString('latin1'); }
  }
}

// 工作空间：所有文件操作和 bash 命令只能在此目录（含子目录）内运行，默认项目目录
let WORKSPACE = __dirname;

// npm MCP 拓展工具搜索结果缓存（避免重复请求 registry）
const _mcpSearchCache = { ts: 0, key: '', data: null };

const MIME_MAP = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.moc3': 'application/octet-stream', '.zip': 'application/zip' };

let mainWindow, server, chatWindow, aiCfgWindow, skillsWindow, toolsWindow, instructionsWindow, petCfgWindow, workspaceWindow;
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
const DATA_NAMES = ['deco','chat-cfg','chat-archive','voice','ai-cfg','experiences','skills','instructions','pet-cfg','workspace','work-memory'];
const dataHandlers = {};
DATA_NAMES.forEach(n => {
  dataHandlers['POST /save-'+n] = (req, res) => readBody(req).then(b => storage.save(n, b, () => ok(res)));
  dataHandlers['GET /load-'+n]  = (req, res) => storage.load(n, res);
});

// 路径安全检查工具（提升到模块作用域，避免每次请求重新创建）
// 工作空间限制：所有文件操作只能在 WORKSPACE（含子目录）内进行，禁止访问外部路径
// 相对路径从 WORKSPACE 开始解析，绝对路径也会被检查是否在 WORKSPACE 内
// 符号链接会被解析到真实路径后再检查，防止符号链接逃逸
function safePath(fp) {
  if (!fp) return null;
  let filePath = fp;
  if (!path.isAbsolute(filePath)) filePath = path.join(WORKSPACE, filePath);
  // 先用 path.resolve 标准化，再用 realpath 解析符号链接
  const resolved = path.resolve(filePath);
  let real;
  try { real = fs.realpathSync(resolved); } catch (e) { real = resolved; }
  // 确保解析后的路径在工作空间内（含根目录本身）
  const rel = path.relative(WORKSPACE, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return real;
}

// 命令安全检查：放开目录/路径/管道/重定向限制，仅在真正高危破坏性操作时拦截
// （防宠物被注入后破坏系统；普通的项目外执行、绝对路径、cd ..、管道符均允许）
// 命令安全已交由工作空间限制保障：所有 bash 命令只能在 WORKSPACE 内执行
// ===== 语法检查（lint）：提取到模块顶层，供 edit_file / replace 写入后自动调用 =====
// 目的：写入即返回语法结果，省去 AI 单独调 lint_file 的一轮循环
function jsonLint(fp, cb){
  let content;
  try{
    content=fs.readFileSync(fp,'utf8');
    JSON.parse(content);
    cb(null,'语法正确');
  }catch(e){
    const lines=(content||'').split('\n');
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
// HTML 标签平衡检查（抽出为纯函数，供 .html 与 .vue 的 <template> 共用）
function htmlTagErrors(content){
  const errs=[];
  const selfClosing=new Set(['br','hr','img','input','meta','link','area','base','col','embed','source','track','wbr']);
  const stack=[];
  let working = content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, match => match.replace(/[^\n]/g, ''))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, match => match.replace(/[^\n]/g, ''))
    .replace(/`[^`]*`/g, match => match.replace(/[^\n]/g, ''))
    .replace(/'[^']*'/g, match => match.replace(/[^\n]/g, ''))
    .replace(/"[^"]*"/g, match => match.replace(/[^\n]/g, ''));
  for (let i = 0; i < 5; i++) {
    const before = working;
    working = working.replace(/<(svg|template|text|xmp|noembed|noframes)\b[^>]*>[\s\S]*?<\/\1>/gi, match => match.replace(/[^\n]/g, ''));
    if (working === before) break;
  }
  const tagRe=/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let match;
  while((match=tagRe.exec(working))!==null){
    const full=match[0],tag=match[1].toLowerCase();
    if(full.startsWith('</')){if(stack.length>0&&stack[stack.length-1]===tag)stack.pop();else if(!selfClosing.has(tag))errs.push(`多余的闭合标签 </${tag}>`);}
    else if(!full.endsWith('/>')&&!selfClosing.has(tag))stack.push(tag);
  }
  while(stack.length>0)errs.push(`未闭合的标签 <${stack.pop()}>`);
  return errs;
}
function htmlLint(fp, cb){
  try{
    const content=fs.readFileSync(fp,'utf8');
    const errs=htmlTagErrors(content);
    if(!/<!DOCTYPE[\s\S]*?>/i.test(content))errs.push('缺少 <!DOCTYPE> 声明');
    // 检查 <script> 内容的 JS 语法（vueLint 已支持，htmlLint 却一直跳过）
    let pending=1;
    const done=()=>{ if(--pending>0) return; if(errs.length>0) cb(new Error(errs.join('\n')), errs.join('\n')); else cb(null,'语法正确'); };
    const scriptMatch=content.match(/<script\b([^>]*)>([\s\S]*?)<\/script>/i);
    if(scriptMatch){
      const attrs=scriptMatch[1]||'', body=scriptMatch[2]||'';
      const isTS=/\blang\s*=\s*['"]ts['"]/i.test(attrs);
      if(isTS){
        const c=tsCheckContent(body);
        if(c) errs.push('[script] ' + c);
      } else if(body.trim()){
        pending++;
        runNodeCheck(body, /\bexport\s/.test(body) ? '.mjs' : '.js', (e, out)=>{ if(e) errs.push('[script] ' + out); done(); });
      }
    }
    // 检查 <style> 内容的花括号平衡
    const styleRe=/<style\b[^>]*>([\s\S]*?)<\/style>/gi; let sm; let si=0;
    while((sm=styleRe.exec(content))!==null){ si++; const se=cssBraceErrors(sm[1]||''); if(se) errs.push('[style'+(si>1?('#'+si):'')+'] '+se); }
    done();
  }catch(e){ cb(e, e.message); }
}
// CSS 花括号平衡检查（抽出为纯函数，供 .css 与 .vue 的 <style> 共用）
function cssBraceErrors(content){
  const cleaned=content.replace(/\/\*[\s\S]*?\*\//g,'').replace(/['"][^'"]*['"]/g,'');
  let brace=0;
  for(const ch of cleaned){
    if(ch==='{')brace++;
    else if(ch==='}')brace--;
  }
  if(brace>0)return `有 ${brace} 个未闭合的花括号 {`;
  if(brace<0)return `有 ${-brace} 个多余的花括号 }`;
  return '';
}
function cssLint(fp, cb){
  try{
    const content=fs.readFileSync(fp,'utf8');
    const e=cssBraceErrors(content);
    if(e)cb(new Error(e),e);
    else cb(null,'语法正确');
  }catch(e){cb(e,e.message);}
}
// ===== TypeScript 语法检查（接入 tsc 的 transpileModule，仅做语法校验，不报错类型） =====
let _tsMod, _tsTried=false;
function getTS(){ if(_tsTried) return _tsMod; _tsTried=true; try{ _tsMod=require('typescript'); }catch(e){ _tsMod=null; } return _tsMod; }
// 对 TS 源码做语法检查，返回 '' 表示通过，否则返回多行错误信息（已带行列号）
function tsCheckContent(content){
  const ts=getTS();
  if(!ts){
    // 退化方案：typescript 未安装时仅做括号/引号平衡粗检，无法捕获类型注解等语法细节
    return genericBalanceCheck(content, 'TypeScript');
  }
  const r=ts.transpileModule(content, { reportDiagnostics:true, compilerOptions:{ target:ts.ScriptTarget.ES2020, module:ts.ModuleKind.ESNext } });
  const errs=r.diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Error);
  if(errs.length===0) return '';
  return errs.map(d=>{
    let lc='';
    if(d.file && d.start!=null){ const p=ts.getLineAndCharacterOfPosition(d.file, d.start); lc=`(${p.line+1}:${p.character+1}) `; }
    return lc + ts.flattenDiagnosticMessageText(d.messageText,'\n');
  }).join('\n');
}
function tsLint(fp, cb){
  try{
    const content=fs.readFileSync(fp,'utf8');
    const msg=tsCheckContent(content);
    if(msg) cb(new Error(msg), msg);
    else cb(null,'语法正确');
  }catch(e){ cb(e, e.message); }
}
// 通用括号/引号平衡粗检（不限语言类型，所有不支持的文件也会执行此兜底检查）
function genericBalanceCheck(content, label){
  let paren=0, brace=0, bracket=0; const stack=[];
  const pairs={')':'(', '}':'{', ']':'['};
  for(const ch of content){
    if(ch==='(')paren++; else if(ch===')')paren--;
    else if(ch==='{')brace++; else if(ch==='}')brace--;
    else if(ch==='[')bracket++; else if(ch===']')bracket--;
    else if(ch==='"'||ch==="'"||ch==='`'){ if(stack.length&&stack[stack.length-1]===ch)stack.pop(); else stack.push(ch); }
  }
  const errs=[];
  if(paren!==0)errs.push(`圆括号不匹配(差${paren})`);
  if(brace!==0)errs.push(`花括号不匹配(差${brace})`);
  if(bracket!==0)errs.push(`方括号不匹配(差${bracket})`);
  if(stack.length)errs.push('引号未闭合');
  return errs.length? `[${label}粗检] ` + errs.join('; ') : '';
}
// 把一段 JS/ESM 内容写到临时文件用 node --check 校验（处理 export 等 ESM 语法）
function runNodeCheck(content, ext, cb){
  const tmp=path.join(os.tmpdir(), 'soul_lint_' + Date.now() + '_' + Math.random().toString(36).slice(2) + ext);
  fs.writeFile(tmp, content, err=>{
    if(err){ cb(err, err.message); return; }
    execFile('node', ['--check', tmp], { timeout: 15000 }, (e, stdout, stderr)=>{
      fs.unlink(tmp, ()=>{});
      const out=(stderr||stdout||'').trim();
      if(e && out) cb(e, out);
      else if(e) cb(e, e.message);
      else cb(null, '语法正确');
    });
  });
}
// ===== Vue 单文件组件语法检查（拆分 <script>/<template>/<style> 分别校验） =====
function vueLint(fp, cb){
  try{
    const content=fs.readFileSync(fp,'utf8');
    const errs=[];
    let pending=1; // 末尾 done() 占 1；若 script 为 JS 还需一次异步 node 检查
    const done=()=>{ if(--pending>0) return; if(errs.length>0) cb(new Error(errs.join('\n')), errs.join('\n')); else cb(null,'语法正确'); };
    // 1) <script>（含 <script setup>）：lang="ts" 走 tsc，否则走 node --check（ESM）
    const scriptMatch=content.match(/<script\b([^>]*)>([\s\S]*?)<\/script>/i);
    if(scriptMatch){
      const attrs=scriptMatch[1]||'', body=scriptMatch[2]||'';
      const isTS=/\blang\s*=\s*['"]ts['"]/i.test(attrs);
      if(isTS){
        const c=tsCheckContent(body);
        if(c) errs.push('[script] ' + c);
      } else if(body.trim()){
        pending++;
        runNodeCheck(body, /\bexport\s/.test(body) ? '.mjs' : '.js', (e, out)=>{ if(e) errs.push('[script] ' + out); done(); });
      }
    }
    // 2) <template>：标签平衡
    const tplMatch=content.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i);
    if(tplMatch){
      const te=htmlTagErrors(tplMatch[1]||'');
      if(te.length) errs.push('[template] ' + te.join('; '));
    }
    // 3) <style>（可能多个）：花括号平衡
    const styleRe=/<style\b[^>]*>([\s\S]*?)<\/style>/gi; let sm; let si=0;
    while((sm=styleRe.exec(content))!==null){ si++; const se=cssBraceErrors(sm[1]||''); if(se) errs.push('[style'+(si>1?('#'+si):'')+'] '+se); }
    done();
  }catch(e){ cb(e, e.message); }
}
// XML 标签平衡检查（复用 htmlTagErrors，但跳过 DOCTYPE 检查）
function xmlLint(fp, cb){
  try{
    const content=fs.readFileSync(fp,'utf8');
    const errs=htmlTagErrors(content);
    if(errs.length>0) cb(new Error(errs.join('\n')), errs.join('\n'));
    else cb(null,'语法正确');
  }catch(e){ cb(e, e.message); }
}
// YAML 语法检查（优先用 js-yaml，未安装则退化到通用平衡检查）
function yamlLint(fp, cb){
  try{
    const content=fs.readFileSync(fp,'utf8');
    let yaml;
    try{ yaml=require('js-yaml'); }catch(_){ yaml=null; }
    if(yaml){
      try{ yaml.load(content); cb(null,'语法正确'); }catch(e){ cb(new Error(e.message), e.message); }
    }else{
      const r=genericBalanceCheck(content, 'YAML');
      if(r) cb(new Error(r), r); else cb(null,'语法正确');
    }
  }catch(e){ cb(e, e.message); }
}
// Shell 语法检查（优先用 bash -n，退化到通用平衡检查）
function shellLint(fp, cb){
  if(process.platform==='win32'){
    // Windows 一般没有 bash，直接退化到通用检查
    try{
      const content=fs.readFileSync(fp,'utf8');
      const r=genericBalanceCheck(content, 'Shell');
      if(r) cb(new Error(r), r); else cb(null,'语法正确');
    }catch(e){ cb(e, e.message); }
  }else{
    execFile('bash', ['-n', fp], { timeout: 15000 }, (err, stdout, stderr) => {
      if(err) cb(err, (stderr||stdout||'').trim() || '语法错误');
      else cb(null,'语法正确');
    });
  }
}
const LINT_CHECKS = {
  '.js': (fp, cb) => execFile('node', ['--check', fp], { timeout: 15000 }, (err, stdout, stderr) => cb(err, (stderr||stdout||'').trim())),
  '.jsx': (fp, cb) => execFile('node', ['--check', fp], { timeout: 15000 }, (err, stdout, stderr) => cb(err, (stderr||stdout||'').trim())),
  '.mjs': (fp, cb) => execFile('node', ['--check', fp], { timeout: 15000 }, (err, stdout, stderr) => cb(err, (stderr||stdout||'').trim())),
  '.cjs': (fp, cb) => execFile('node', ['--check', fp], { timeout: 15000 }, (err, stdout, stderr) => cb(err, (stderr||stdout||'').trim())),
  '.py': (fp, cb) => {
    const pyCmds = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
    (function tryPy(i){
      if(i>=pyCmds.length){ cb(new Error('未找到 python 解释器'), '未找到 python 解释器'); return; }
      execFile(pyCmds[i], ['-m', 'py_compile', fp], { timeout: 15000 }, (err, stdout, stderr) => {
        if(err && err.code === 'ENOENT'){ tryPy(i+1); return; }
        cb(err, (stderr||stdout||'').trim());
      });
    })(0);
  },
  '.json': jsonLint,
  '.html': htmlLint,
  '.css': cssLint,
  // TypeScript（接入 tsc 的 transpileModule 做语法校验，仅捕获语法错误，不报类型错误）
  '.ts': tsLint,
  '.tsx': tsLint,
  '.mts': tsLint,
  '.cts': tsLint,
  // Vue 单文件组件（拆分 script/template/style 分段校验）
  '.vue': vueLint,
  // XML（复用 HTML 标签平衡检查器）
  '.xml': xmlLint,
  // YAML（优先 js-yaml 解析，未安装则退化到通用平衡检查）
  '.yaml': yamlLint,
  '.yml': yamlLint,
  // Shell（优先 bash -n，退化到通用平衡检查）
  '.sh': shellLint,
  '.bash': shellLint,
};
// 统一 lint 入口（供 edit_file / replace 写入后自动调用）：返回 cb(null, null) 表示跳过；cb(null, {ok, output}) 为结果
// 未注册的文件类型：用通用括号/引号平衡检查兜底，不再直接返回"不支持"
function lintFile(fp, cb){
  const ext = path.extname(fp).toLowerCase();
  const fn = LINT_CHECKS[ext];
  if(!fn){
    // 通用兜底：括号/引号平衡检查（所有文本文件都能查）
    try{
      const content=fs.readFileSync(fp,'utf8');
      const r=genericBalanceCheck(content, ext.slice(1).toUpperCase());
      if(r) cb(null, { ok:false, output:r.substring(0,1000) });
      else cb(null, { ok:true, output:'语法正确' });
    }catch(e){ cb(e, { ok:false, output:e.message }); }
    return;
  }
  fn(fp, (err, output) => {
    if(err && output) cb(null, { ok:false, output:output.substring(0,1000) });
    else if(err) cb(null, { ok:false, output:err.message });
    else cb(null, { ok:true, output:output||'语法正确' });
  });
}
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
        let maxLines = parseInt(q.get('lines') || '2000', 10);
        const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
        if (!fp) { res.writeHead(400); res.end('{"error":"empty path"}'); return; }
        const resolved = safePath(fp);
        if (!resolved) { res.writeHead(403); res.end(JSON.stringify({ error: '操作被拒绝：只能在「' + WORKSPACE + '」内操作' })); return; }
        // 文件大小预检：超过 50MB 拒绝读取，避免 OOM
        let st;
        try { st = fs.statSync(resolved); } catch(e) { res.writeHead(404); res.end(JSON.stringify({ error: '文件不存在: ' + e.message })); return; }
        if (st.isDirectory()) { res.writeHead(400); res.end(JSON.stringify({ error: '是一个文件夹，不是文件，请用 tree 查看目录内容' })); return; }
        if (st.size > 50 * 1024 * 1024) { res.writeHead(413); res.end(JSON.stringify({ error: '文件过大（' + (st.size/1024/1024).toFixed(1) + 'MB），超过50MB限制' })); return; }
        // lines=-1 表示读取全部行
        if (maxLines < 0) maxLines = Infinity;
        // 读取文件（不指定编码，自动处理 UTF-8/GBK 等编码，避免中文 Windows 乱码）
        fs.readFile(resolved, (e, buf) => {
          if (e) { res.writeHead(404); res.end(JSON.stringify({ error: '文件无法读取: ' + e.message })); return; }
          const d = decodeText(buf);
          const lines = d.split('\n');
          const total = lines.length;
          const endLine = Math.min(offset + maxLines, total);
          const show = lines.slice(offset, endLine);
          // 单行长度上限：压缩后的超大单行（如 bundle/lock 文件）截断，避免单条记录撑爆上下文
          const MAX_LINE_DISP = 8000;
          const numbered = show.map((l, i) => {
            const disp = l.length > MAX_LINE_DISP ? l.slice(0, MAX_LINE_DISP) + ' …(本行过长已截断，共 ' + l.length + ' 字符)' : l;
            return `${String(i+1+offset).padStart(5)}:${disp}`;
          }).join('\n');
          let result = numbered;
          // 整体回传上限：防止一次读取返回过大的内容（分页读取更稳妥）
          const MAX_READ_CHARS = 256 * 1024;
          if (result.length > MAX_READ_CHARS) {
            result = result.slice(0, MAX_READ_CHARS) + `\n⚠️ 本次读取内容过长（超过 ${(MAX_READ_CHARS/1024)|0}KB）已截断，请用更小的 lines 或更大的 offset 分段读取`;
          }
          // 提示放在最前面，AI 更容易注意到
          if (offset + maxLines < total && maxLines !== Infinity)
            result = `⚠️ 文件共${total}行，本次仅显示第${offset+1}-${endLine}行，还有${total-endLine}行未读！请立即用 offset=${endLine} 调 read_file 继续读取剩余部分\n\n` + result;
          else
            result = `✅ 已读取全部${total}行（第${offset+1}-${endLine}行）\n\n` + result;
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(result);
        });
        return;
      }
      // 文档解析（图片）— 供 read_files 后端调用，提取文字供 AI 处理
      if (req.method === 'POST' && req.url === '/parse-document') {
        readBody(req).then(async body => {
          try {
            const { path: fp, asImage } = JSON.parse(body);
            if (!fp) { res.writeHead(400); res.end(JSON.stringify({ error: 'empty path' })); return; }
            const resolved = safePath(fp);
            if (!resolved) { res.writeHead(403); res.end(JSON.stringify({ error: '操作被拒绝：只能在「' + WORKSPACE + '」内操作' })); return; }
            const ext = path.extname(resolved).toLowerCase();
            // 图片文件 → 直接返回 base64 数据 URL
            if (['.png','.jpg','.jpeg','.gif','.webp','.bmp'].includes(ext)) {
              try {
                const buf = fs.readFileSync(resolved);
                const b64 = buf.toString('base64');
                const mime = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp' }[ext] || 'image/png';
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ type: 'image', data: `data:${mime};base64,${b64}` }));
              } catch(e) { res.writeHead(404); res.end(JSON.stringify({ error: '图片读取失败: ' + e.message })); }
              return;
            }
            // PDF/DOCX 文档解析已移除，由 MCP 工具接管
            res.writeHead(400); res.end(JSON.stringify({ error: '不支持的格式（仅支持图片）: ' + ext }));
          } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid json' })); }
        });
        return;
      }
      // 代码搜索（支持 keyword / definition / reference / regex，可显示上下文，异步遍历避免阻塞）
      const SEARCH_EXTS = ['.js','.mjs','.cjs','.ts','.html','.htm','.json','.css','.scss','.less','.py','.jsx','.tsx','.vue','.svelte','.md','.markdown','.txt','.go','.rs','.java','.c','.h','.cpp','.cc','.hpp','.cs','.sh','.bash','.zsh','.ps1','.yml','.yaml','.xml','.sql','.php','.rb','.swift','.kt','.kts','.toml','.ini','.env','.dockerfile','.makefile'];
      if (req.method === 'GET' && req.url.startsWith('/search?')) {
        const u = new URL(req.url, 'http://x');
        const q = u.searchParams.get('q') || '';
        const ctxLines = parseInt(u.searchParams.get('context') || '2', 10);
        const caseSensitive = u.searchParams.get('caseSensitive') === 'true';
        const fileType = u.searchParams.get('type') || '';
        const searchPath = u.searchParams.get('path') || '.';
        if (!q) { res.writeHead(400); res.end('{"error":"empty query"}'); return; }
        const resolved = safePath(searchPath);
        if (!resolved) { res.writeHead(403); res.end('{"error":"path not allowed"}'); return; }
        // 自动判断：如果 q 是正则则用正则匹配，否则用 keyword 匹配
        // ReDoS 防护：拒绝"嵌套量词"危险模式（如 (a+)+、(.*)+、(x*)* 等会导致灾难性回溯的正则）。
        // 命中则退化为关键词搜索——因为正则匹配是同步阻塞事件循环的，定时器无法中断卡死，必须从源头拦截。
        let isRegex = false;
        const redosPattern = /\([^()]*[+*?][^()]*\)\s*[*+?{]/;
        if (!redosPattern.test(q)) { try { new RegExp(q); isRegex = true; } catch(e) { isRegex = false; } }
        const matcher = isRegex
          ? new RegExp(q, caseSensitive ? '' : 'i')
          : { test: (line) => (caseSensitive ? line : line.toLowerCase()).includes(caseSensitive ? q : q.toLowerCase()) };
        const MAX_RESULTS = 500;
        const MAX_FILE_SIZE = 10 * 1024 * 1024; // 超过10MB的文件跳过，避免OOM
        const CONCURRENT_LIMIT = 20; // 并发读取文件数
        // ReDoS 防护：为正则匹配设超时（3秒）
        const timedTest = (re, text, timeout = 3000) => {
          return new Promise(resolve => {
            let done = false;
            const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, timeout);
            try {
              // 在下一个微任务中执行正则，主线程可以响应超时
              setImmediate(() => {
                if (done) return;
                try { done = true; clearTimeout(timer); resolve(re.test(text)); }
                catch(e) { done = true; clearTimeout(timer); resolve(false); }
              });
            } catch(e) { done = true; clearTimeout(timer); resolve(false); }
          });
        };
        (async () => {
          const results = [];
          const fileMatchCount = {};
          const fileQueue = []; // 待扫描文件队列
          async function walk(dir) {
            let entries;
            try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch(e) { return; }
            for (const e of entries) {
              if (e.name.startsWith('.') || e.name === 'node_modules') continue;
              const fp = path.join(dir, e.name);
              if (e.isDirectory()) { if (results.length < MAX_RESULTS) await walk(fp); }
              else if ((!fileType || path.extname(e.name).toLowerCase() === '.' + fileType.replace(/^\./, '')) && SEARCH_EXTS.includes(path.extname(e.name).toLowerCase())) {
                fileQueue.push(fp);
              }
            }
          }
          await walk(resolved);
          // 并发读取文件，限制并发数
          async function processFile(fp) {
            if (results.length >= MAX_RESULTS) return;
            try {
              const st = fs.statSync(fp);
              if (st.size > MAX_FILE_SIZE) { fileMatchCount['⚠️ 跳过超大文件'] = (fileMatchCount['⚠️ 跳过超大文件'] || 0) + 1; return; }
              if (st.size === 0) return;
              const buf = await fs.promises.readFile(fp);
              const content = decodeText(buf);
              const lines = content.split('\n');
              const totalLines = lines.length;
              const relPath = path.relative(resolved, fp);
              const MAX_LINE_TEST = 65536; // 单行长上限：避免对超大行（如压缩后的单行文件）跑正则导致卡死
              const capLine = (s) => s.length > 2000 ? s.slice(0, 2000) + '…(本行过长已截断)' : s;
              let fileMatches = 0;
              for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
                const lineForTest = lines[i].length > MAX_LINE_TEST ? lines[i].slice(0, MAX_LINE_TEST) : lines[i];
                let matched;
                if (isRegex) {
                  matched = await timedTest(matcher, lineForTest); // ReDoS 防护（危险模式已退化为关键词）
                } else {
                  matched = matcher.test(lineForTest);
                }
                if (!matched) continue;
                fileMatches++;
                const context = ctxLines > 0
                  ? [...lines.slice(Math.max(0,i-ctxLines),i).map(capLine), '→'+capLine(lines[i]), ...lines.slice(i+1, Math.min(lines.length,i+1+ctxLines)).map(capLine)].join('\n')
                  : capLine(lines[i]);
                results.push({ file: relPath, line: i+1, content: capLine(lines[i].trim()), context, lines: totalLines });
              }
              if (fileMatches > 0) fileMatchCount[relPath] = fileMatches;
            } catch(e) {}
          }
          // 用简单并发池控制
          let idx = 0;
          async function worker() {
            while (idx < fileQueue.length && results.length < MAX_RESULTS) {
              const fp = fileQueue[idx++];
              await processFile(fp);
            }
          }
          const workers = Array.from({ length: Math.min(CONCURRENT_LIMIT, fileQueue.length || 1) }, () => worker());
          await Promise.all(workers);
          const fileStats = Object.entries(fileMatchCount)
            .map(([file, matches]) => ({ file, matches }))
            .sort((a, b) => b.matches - a.matches);
          const skippedLarge = fileStats.find(f => f.file === '⚠️ 跳过超大文件');
          const extraMsg = skippedLarge ? `（${skippedLarge.matches}个文件因超过10MB跳过）` : '';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results: results.slice(0, MAX_RESULTS), total: results.length, truncated: results.length >= MAX_RESULTS, fileStats: fileStats.filter(f => f.file !== '⚠️ 跳过超大文件'), skippedLarge: skippedLarge ? skippedLarge.matches : 0 }));
        })();
        return;
      }
      // 按文件名搜索文件
      // 按文件名搜索文件（异步遍历，避免阻塞事件循环）
      if (req.method === 'GET' && req.url.startsWith('/search-file?')) {
        const u = new URL(req.url, 'http://x');
        const pattern = u.searchParams.get('pattern') || '';
        const recursive = u.searchParams.get('recursive') !== 'false';
        const searchPath = u.searchParams.get('path') || '.';
        if (!pattern) { res.writeHead(400); res.end('{"error":"empty pattern"}'); return; }
        const resolved = safePath(searchPath);
        if (!resolved) { res.writeHead(403); res.end('{"error":"path not allowed"}'); return; }
        const re = new RegExp('^' + pattern.replace(/\//g,'\\/').replace(/\./g,'\\.').replace(/\*/g,'.*').replace(/\?/g,'.').replace(/\{([^}]+)\}/g, '($1)').replace(/,/g,'|') + '$', 'i');
        const list = [];
        const MAX_FILE_RESULTS = 5000;
        (async () => {
          async function walk(dir) {
            let entries;
            try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch(e) { return; }
            for (const e of entries) {
              if (e.name.startsWith('.') || e.name === 'node_modules' || list.length >= MAX_FILE_RESULTS) continue;
              const fp = path.join(dir, e.name);
              if (e.isDirectory()) { if (recursive) await walk(fp); }
              else if (re.test(e.name)) list.push(path.relative(resolved, fp));
            }
          }
          await walk(resolved);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const truncated = list.length >= MAX_FILE_RESULTS;
          res.end(JSON.stringify({ files: truncated ? list.slice(0, MAX_FILE_RESULTS) : list, total: list.length, truncated }));
        })();
        return;
      }
      // 互联网搜索（web 工具）- 多引擎备选，提高可用性
      if (req.method === 'GET' && req.url.startsWith('/web-search?q=')) {
        const u = new URL(req.url, 'http://x');
        const q = u.searchParams.get('q') || '';
        const count = Math.min(parseInt(u.searchParams.get('count') || '5', 10) || 5, 10);
        if (!q) { res.writeHead(400); res.end('{"error":"empty query"}'); return; }
        const osStr = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : process.platform === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64';
        const UA = `Mozilla/5.0 (${osStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36`;
        // 搜索引擎：Bing（国内可访问）
        const engines = [
          { name: 'Bing', url: `https://www.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBing },
        ];
        let idx = 0;
        function tryNext(errMsg) {
          if (idx >= engines.length) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: '所有搜索引擎均失败: ' + (errMsg || '未知错误') }));
            return;
          }
          const eng = engines[idx++];
          const mod = eng.url.startsWith('https') ? https : http;
          mod.get(eng.url, { timeout: 10000, headers: { 'User-Agent': UA } }, (resp) => {
            let data = '';
            resp.on('data', c => data += c);
            resp.on('end', () => {
              try {
                const results = eng.parse(data, count);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ results, from: eng.name }));
              } catch(e) {
                tryNext(eng.name + ' 解析失败: ' + e.message);
              }
            });
            resp.on('error', () => tryNext(eng.name + ' 响应错误'));
          }).on('error', e => tryNext(eng.name + ': ' + e.message));
        }
        tryNext();
        return;
      }
      // 搜索解析器：Bing
      function parseBing(html, count) {
        const results = [];
        // Bing 搜索结果：<li class="b_algo"> 下 <h2><a href="...">title</a></h2> + <p>snippet</p>
        const algoRe = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
        let m;
        while ((m = algoRe.exec(html)) !== null && results.length < count) {
          const block = m[1];
          const aMatch = block.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
          if (!aMatch) continue;
          const url = aMatch[1];
          const title = aMatch[2].replace(/<[^>]+>/g, '').trim();
          if (!title || url === 'javascript:void(0)') continue;
          const snippet = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().replace(title, '').trim().substring(0, 300);
          results.push({ title, url, snippet });
        }
        return results;
      }
      // 列出目录内容
      if (req.method === 'GET' && req.url.startsWith('/list-dir?path=')) {
        let fp = decodeURIComponent(req.url.split('?path=')[1] || '').replace(/\\/g,'/');
        if (!fp) fp='.';
        const resolved = safePath(fp);
        if (!resolved) { res.writeHead(403); res.end('[]'); return; }
        (async () => {
          try {
            const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
            const list = [];
            for (const e of entries) {
              if (e.name.startsWith('.') || e.name === 'node_modules') continue;
              const isDir = e.isDirectory();
              let size;
              if (!isDir) { try { size = (await fs.promises.stat(path.join(resolved, e.name))).size; } catch (_) {} }
              list.push({ name: e.name, isDir, size });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(list));
          } catch(e) {
            res.writeHead(500); res.end(JSON.stringify({ error: '读取目录失败: ' + e.message }));
          }
        })();
        return;
      }
      // 项目文件索引（供 buildAiContext 注入上下文，让 AI 看清项目全貌）
      // 递归目录树（一次看清项目骨架）
      if (req.method === 'GET' && req.url.startsWith('/tree?path=')) {
        const u = new URL(req.url, 'http://localhost');
        let fp = decodeURIComponent(u.searchParams.get('path') || '') || '.';
        const maxDepth = Math.min(parseInt(u.searchParams.get('maxDepth') || '3', 10) || 3, 6);
        const ignore = new Set((u.searchParams.get('ignore') || '').split(',').map(s => s.trim()).filter(Boolean));
        const DEFAULT_IGNORE = new Set(['node_modules', '.git', '.codebuddy', '.idea', '.vscode', '.next', '.nuxt', '__pycache__', 'dist', 'build', 'target', 'vendor', 'bower_components', '.venv', 'venv', 'env', '.env']);
        const resolved = safePath(fp);
        if (!resolved) { res.writeHead(403); res.end('# 禁止访问的路径'); return; }
        const MAX_ITEMS = 600; let totalCount = 0;
        const result = []; // {line, depth} 数组
        async function walk(dir, depth) {
          if (depth > maxDepth || totalCount >= MAX_ITEMS) return;
          let entries;
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
          entries = entries.filter(e => {
            if (e.name.startsWith('.')) return false;
            if (DEFAULT_IGNORE.has(e.name) || ignore.has(e.name)) return false;
            return true;
          });
          entries.sort((a, b) => (a.isDirectory() === b.isDirectory()) ? a.name.localeCompare(b.name) : (a.isDirectory() ? -1 : 1));
          let displayed = 0, skipped = 0;
          for (const e of entries) {
            if (totalCount >= MAX_ITEMS) { skipped++; continue; }
            totalCount++; displayed++;
            const line = '  '.repeat(depth - 1) + '├── ' + e.name + (e.isDirectory() ? '/' : '');
            result.push({ line, depth });
            if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1);
          }
          if (skipped > 0) {
            result.push({ line: '  '.repeat(depth - 1) + `└── ... (还有 ${skipped + countRemaining(entries, displayed)} 项未显示)`, depth });
          }
        }
        // 辅助：统计当前目录还有多少子项在跳过之后
        function countRemaining(entries, displayed) {
          let remaining = 0;
          for (let i = displayed; i < entries.length; i++) {
            remaining++;
          }
          return remaining;
        }
        (async () => {
          try {
            result.push({ line: path.basename(resolved) + '/', depth: 0 });
            await walk(resolved, 1);
            if (totalCount >= MAX_ITEMS) result.push({ line: `... (已达到显示上限 ${MAX_ITEMS} 项，更深层请用更小的范围查看)`, depth: 0 });
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(result.map(r => r.line).join('\n'));
          } catch (e) {
            res.writeHead(500); res.end('# 读取失败: ' + e.message);
          }
        })();
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
      // 中断当前正在执行的命令（供前端"中断"按钮调用）
      if (req.method === 'POST' && req.url === '/bash-abort') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // 应用 SEARCH/REPLACE 补丁（apply-patch 路由，供 edit_file 调用）
      if (req.method === 'POST' && req.url === '/apply-patch') {
        readBody(req).then(body => {
          try {
            const { path: fp, patches } = JSON.parse(body);
            if (!fp || !patches || !patches.length) { res.writeHead(400); res.end(JSON.stringify({error:'missing params'})); return; }
            const resolved = safePath(fp);
            if (!resolved) { res.writeHead(403); res.end(JSON.stringify({error:'操作被拒绝：只能在「' + WORKSPACE + '」内操作'})); return; }
            // 文件大小预检：超过20MB拒绝patch（split/indexOf在大文件上性能极差）
            try { const st = fs.statSync(resolved); if (st.size > 20 * 1024 * 1024) { res.writeHead(413); res.end(JSON.stringify({error:'文件过大（' + (st.size/1024/1024).toFixed(1) + 'MB），超过20MB，请手动编辑或用bash处理'})); return; } } catch(e) { res.writeHead(404); res.end(JSON.stringify({error:'文件不存在: ' + e.message})); return; }
            fs.readFile(resolved, (e, buf) => { const content = decodeText(buf);
              if (e) { res.writeHead(404); res.end(JSON.stringify({error:'文件无法读取: ' + e.message})); return; }
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
                // newFull 携带替换后内容（截断到500字符，避免回传过大）
                changes.push({line:lineNum, old:oldSnippet, new:newSnippet, newFull: (p.new||'').length > 500 ? (p.new||'').substring(0,500)+'...(截断)' : (p.new||'')});
                modified = modified.replace(p.old, p.new || '');
              }
              if (changes.length === 0 && skipped.length === 0) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({count:0})); return; }
              fs.writeFile(resolved, modified, 'utf-8', (we) => {
                if (we) { res.writeHead(500); res.end(JSON.stringify({error:'写入失败: ' + we.message})); return; }
                // 仅代码文件执行语法检查
                const codeExts=['.js','.jsx','.mjs','.cjs','.ts','.tsx','.mts','.cts','.vue','.py','.html','.css','.xml','.yaml','.yml','.sh','.bash'];
                const ext=path.extname(resolved).toLowerCase();
                if(codeExts.includes(ext)){
                  lintFile(resolved, (e, lint) => {
                    res.writeHead(200, {'Content-Type':'application/json'});
                    res.end(JSON.stringify({count:changes.length, changes, skipped, lint}));
                  });
                }else{
                  res.writeHead(200, {'Content-Type':'application/json'});
                  res.end(JSON.stringify({count:changes.length, changes, skipped}));
                }
              });
            });
          } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:'invalid json'})); }
        });
        return;
      }

      // 创建文件（覆盖写入，若文件已存在则计算行级差异；.docx/.pdf 自动排版；写入后自动 lint）
      if (req.method === 'POST' && req.url === '/create-file') {
        readBody(req).then(body => {
          try {
            const { path: fp, content } = JSON.parse(body);
            if (!fp || content === undefined) { res.writeHead(400); res.end('{"error":"missing params"}'); return; }
            const resolved = safePath(fp);
            if (!resolved) { res.writeHead(403); res.end(JSON.stringify({ error: '操作被拒绝：只能在「' + WORKSPACE + '」内操作' })); return; }
            const ext = path.extname(resolved).toLowerCase();
            const ok = (p) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(p)); };
            try { fs.mkdirSync(path.dirname(resolved), { recursive: true }); } catch (e) {}
            fs.writeFile(resolved, content, 'utf-8', (we) => {
              if (we) { res.writeHead(500); res.end('{"error":"创建失败: ' + we.message.replace(/"/g,"'") + '"}'); return; }
              // 仅代码文件执行语法检查，非代码文件（json/txt/md等）跳过
              const codeExts=['.js','.jsx','.mjs','.cjs','.ts','.tsx','.mts','.cts','.vue','.py','.html','.css','.xml','.yaml','.yml','.sh','.bash'];
              if(codeExts.includes(ext)){
                lintFile(resolved, (e, lint) => ok({ success: true, lint }));
              }else{
                ok({ success: true });
              }
            });
          } catch(e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
        });
        return;
      }
      // 文档生成与原地编辑（/create-document、/edit-document）已移除，由 MCP 工具接管
      // 删除文件
      if (req.method === 'POST' && req.url === '/delete-file') {
        readBody(req).then(body => {
          try {
            const { path: fp } = JSON.parse(body);
            if (!fp) { res.writeHead(400); res.end('{"error":"missing params"}'); return; }
            const resolved = safePath(fp);
            if (!resolved) { res.writeHead(403); res.end(JSON.stringify({ error: '操作被拒绝：只能在「' + WORKSPACE + '」内操作' })); return; }
            fs.unlink(resolved, (we) => {
              // ENOENT（文件已不存在）视为成功，避免并发删除同一文件时报错
              if (we && we.code !== 'ENOENT') { res.writeHead(500); res.end(JSON.stringify({ error: '删除失败: ' + we.message })); return; }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            });
          } catch(e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
        });
        return;
      }
      // 符号重命名（搜索整个项目 + 精确替换）
      if (req.method === 'POST' && req.url === '/rename-symbol') {
        readBody(req).then(body => {
          try {
            const { oldName, newName, searchPath, fileType } = JSON.parse(body);
            if (!oldName || !newName) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少参数 oldName/newName' })); return; }
            const resolved = safePath(searchPath || '.');
            if (!resolved) { res.writeHead(403); res.end(JSON.stringify({ error: '路径不允许' })); return; }
            // 用正则严格匹配单词边界，避免子串误伤（如 forgetData 不会被 getData 匹配到）
            const re = new RegExp('\\b' + oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
            const results = [];
            (async () => {
              async function walk(dir) {
                let entries;
                try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch(e) { return; }
                for (const e of entries) {
                  if (e.name.startsWith('.') || e.name === 'node_modules') continue;
                  const fp = path.join(dir, e.name);
                  if (e.isDirectory()) { await walk(fp); continue; }
                  if (fileType && path.extname(e.name).toLowerCase() !== '.' + fileType.replace(/^\./, '')) continue;
                  const SEARCH_EXTS = ['.js','.jsx','.mjs','.cjs','.ts','.tsx','.vue','.html','.css','.scss','.less','.json','.xml','.yaml','.yml','.md','.py','.java','.go','.rs','.rb','.php','.c','.cpp','.h','.hpp','.swift','.kt','.dart','.lua','.pl','.sh','.bat','.ps1'];
                  if (!SEARCH_EXTS.includes(path.extname(e.name).toLowerCase())) continue;
                  try {
                    const st = fs.statSync(fp);
                    if (st.size > 10 * 1024 * 1024) continue; // 跳过 >10MB 的大文件
                    const buf = await fs.promises.readFile(fp); const content = decodeText(buf);
                    if (!re.test(content)) continue;
                    re.lastIndex = 0;
                    const lines = content.split('\n');
                    const matches = [];
                    for (let i = 0; i < lines.length; i++) {
                      let m; re.lastIndex = 0;
                      while ((m = re.exec(lines[i])) !== null) {
                        matches.push({ line: i + 1, column: m.index + 1, content: lines[i].trim() });
                      }
                    }
                    if (matches.length === 0) continue;
                    const relPath = path.relative(resolved, fp);
                    const newContent = content.replace(re, newName);
                    results.push({ file: relPath, matches, newContent, oldContent: content });
                  } catch(e) {}
                }
              }
              await walk(resolved);
              if (results.length === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ changed: 0, files: [], message: '未找到符号 "' + oldName + '" 的引用' }));
                return;
              }
              // 写入所有修改 + 语法检查
              let changed = 0, totalOccurrences = 0;
              const changes = [];
              for (const r of results) {
                totalOccurrences += r.matches.length;
                try {
                  const targetPath = safePath(r.file) || path.join(resolved, r.file);
                  await fs.promises.writeFile(targetPath, r.newContent, 'utf-8');
                  changed++;
                  // 对该文件执行语法检查
                  const lintResult = await new Promise(resolve => {
                    lintFile(targetPath, (e, lint) => resolve(lint));
                  });
                  changes.push({
                    file: r.file,
                    occurrences: r.matches.length,
                    // 每处变更的行级详情（最多展示前 20 处，避免反馈过长）
                    details: r.matches.slice(0, 20).map(m => ({
                      line: m.line,
                      column: m.column,
                      snippet: m.content.length > 60 ? m.content.substring(0, 60) + '...' : m.content,
                    })),
                    hasMore: r.matches.length > 20,
                    lint: lintResult || null,
                  });
                } catch(e) {
                  changes.push({ file: r.file, occurrences: r.matches.length, error: e.message, lint: null });
                }
              }
              const detailMsg = changed > 0
                ? '已将 "' + oldName + '" → "' + newName + '"（' + changed + ' 个文件，' + totalOccurrences + ' 处）\n\n' + changes.map(c =>
                    '📄 ' + c.file + '（' + c.occurrences + ' 处）' +
                    (c.lint ? (c.lint.ok ? ' ✅ 语法正常' : ' ❌ ' + c.lint.output.substring(0, 200)) : '') +
                    (c.error ? ' ❌ ' + c.error : '') +
                    '\n' + (c.details || []).slice(0, 5).map(d => '  L' + d.line + ':' + d.column + ' ' + d.snippet).join('\n') +
                    (c.hasMore ? '\n  ... 还有 ' + (c.occurrences - 5) + ' 处' : '')
                  ).join('\n\n')
                : '未找到符号 "' + oldName + '" 的引用';
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ changed, totalOccurrences, changes, message: detailMsg }));
            })();
          } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid json' })); }
        });
        return;
      }
      // 跨文件批量替换：搜索所有匹配文件 → 替换全部匹配 → 自动语法检查
      if (req.method === 'POST' && req.url === '/batch-replace') {
        readBody(req).then(body => {
          try {
            const { pattern, replacement, searchPath, fileType } = JSON.parse(body);
            if (!pattern || replacement === undefined) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少参数 pattern/replacement' })); return; }
            const resolved = safePath(searchPath || '.');
            if (!resolved) { res.writeHead(403); res.end(JSON.stringify({ error: '路径不允许' })); return; }
            const re = new RegExp(pattern, 'g');
            const BATCH_EXTS = ['.js','.jsx','.mjs','.cjs','.ts','.tsx','.vue','.html','.css','.scss','.less','.json','.xml','.yaml','.yml','.md','.py','.java','.go','.rs','.rb','.php','.c','.cpp','.h','.hpp','.swift','.kt','.dart','.lua','.pl','.sh','.bat','.ps1','.txt'];
            const results = [];
            (async () => {
              async function walk(dir) {
                let entries;
                try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch(e) { return; }
                for (const e of entries) {
                  if (e.name.startsWith('.') || e.name === 'node_modules') continue;
                  const fp = path.join(dir, e.name);
                  if (e.isDirectory()) { await walk(fp); continue; }
                  if (fileType && path.extname(e.name).toLowerCase() !== '.' + fileType.replace(/^\./, '')) continue;
                  if (!BATCH_EXTS.includes(path.extname(e.name).toLowerCase())) continue;
                  try {
                    const st = fs.statSync(fp);
                    if (st.size > 10 * 1024 * 1024) continue;
                    const buf = await fs.promises.readFile(fp); const content = decodeText(buf);
                    if (!re.test(content)) continue; re.lastIndex = 0;
                    const newContent = content.replace(re, replacement);
                    if (newContent === content) continue; // 无实际变化
                    const relPath = path.relative(resolved, fp);
                    const lines = content.split('\n');
                    const matchLines = [];
                    for (let i = 0; i < lines.length; i++) { re.lastIndex = 0; if (re.test(lines[i])) matchLines.push(i + 1); }
                    await fs.promises.writeFile(fp, newContent, 'utf-8');
                    const lint = await new Promise(resolve => lintFile(fp, (e, r) => resolve(r)));
                    results.push({ file: relPath, matchLines, lint: lint || null });
                  } catch(e) {
                    results.push({ file: path.relative(resolved, fp), error: e.message });
                  }
                }
              }
              await walk(resolved);
              if (results.length === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ changed: 0, files: [], message: '未找到匹配 "' + pattern + '" 的引用' }));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ changed: results.length, files: results, message: results.length + ' 个文件已完成替换' }));
            })();
          } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid json' })); }
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
            if (!resolved) { res.writeHead(403); res.end(JSON.stringify({ error: '操作被拒绝：只能在「' + WORKSPACE + '」内操作' })); return; }
            fs.mkdir(resolved, { recursive: true }, (we) => {
              if (we) { res.writeHead(500); res.end('{"error":"创建目录失败: ' + we.message.replace(/"/g,"'") + '"}'); return; }
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
            let { path: fp, newPath, oldPath } = JSON.parse(body);
            if (!fp && oldPath) fp = oldPath;
            if (!fp || !newPath) { res.writeHead(400); res.end('{"error":"missing params"}'); return; }
            const resolved = safePath(fp);
            const resolvedNew = safePath(newPath);
            if (!resolved || !resolvedNew) { res.writeHead(403); res.end(JSON.stringify({ error: '操作被拒绝：只能在「' + WORKSPACE + '」内操作' })); return; }
            fs.rename(resolved, resolvedNew, (we) => {
              if (we) { res.writeHead(500); res.end(JSON.stringify({ error: '重命名失败: ' + we.message })); return; }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            });
          } catch(e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
        });
        return;
      }
      // 语法检查路由（lint 逻辑已移至模块顶层 lintFile；edit_file/replace 写入后自动调用，AI 无需单独 lint）
      if (req.method === 'POST' && req.url === '/lint-file') {
        readBody(req).then(body => {
          try {
            const { path: fp } = JSON.parse(body);
            if (!fp) { res.writeHead(400); res.end('{"error":"missing path"}'); return; }
            const resolved = safePath(fp);
            if (!resolved) { res.writeHead(403); res.end(JSON.stringify({ error: '操作被拒绝：只能在「' + WORKSPACE + '」内操作' })); return; }
            lintFile(resolved, (e, r) => {
              if (!r) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:null,output:'该文件类型不支持语法检查，已跳过'})); return; }
              res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(r));
            });
          } catch(e) { res.writeHead(400); res.end('{"error":"invalid json"}'); }
        });
        return;
      }
      // 网页抓取（web 工具）：支持重定向跟随、gzip/deflate 解压、charset 解码、超时中断、可选截断翻页
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
                resp.on('end', async () => {
                  try {
                    let buf = Buffer.concat(chunks);
                    const enc = (resp.headers['content-encoding'] || '').toLowerCase();
                    try {
                      if (enc === 'gzip') buf = await new Promise((res, rej) => zlib.gunzip(buf, (e, d) => e ? rej(e) : res(d)));
                      else if (enc === 'deflate') buf = await new Promise((res, rej) => zlib.inflate(buf, (e, d) => e ? rej(e) : res(d)));
                    } catch(e) { /* 解压失败，使用原始 buf */ }
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
      // 执行 JavaScript 代码（在项目目录下用 node -e 运行，可指定文件让代码处理）
      if (req.method === 'POST' && req.url === '/run-js') {
        readBody(req).then(body => {
          try {
            const { code, file } = JSON.parse(body);
            if (!code) { res.writeHead(400); res.end(JSON.stringify({ error: 'empty code' })); return; }
            let fullCode = code;
            if (file) {
              const resolved = safePath(file);
              if (!resolved) { res.writeHead(403); res.end(JSON.stringify({ error: 'path not allowed' })); return; }
              fullCode = `const __file=${JSON.stringify(resolved)};\nconst __content=require('fs').readFileSync(__file,'utf-8');\n` + code;
            }
            execFile('node', ['-e', fullCode], { cwd: WORKSPACE, timeout: 60000, maxBuffer: 5*1024*1024 }, (err, stdout, stderr) => {
              const output = (stdout||'') + (stderr||'');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ code: err ? (err.code||1) : 0, output, error: err ? err.message : '' }));
            });
          } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid json' })); }
        });
        return;
      }
      // 获取当前操作系统信息
      if (req.method === 'GET' && req.url === '/platform') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(process.platform);
        return;
      }
      // 获取项目根目录路径
      if (req.method === 'GET' && req.url === '/project-root') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(__dirname);
        return;
      }
      // 获取工作空间配置（JSON：{current, list}）
      if (req.method === 'GET' && req.url === '/workspace') {
        (async () => {
          let list = [];
          try { const raw = await storage.loadData('workspace'); const cfg = JSON.parse(raw); if (Array.isArray(cfg.list)) list = cfg.list; } catch(e) {}
          const def = __dirname;
          if (!list.includes(def)) list.unshift(def);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ current: WORKSPACE, list }));
        })();
        return;
      }
      // 设置工作空间（接受 JSON：{current, list}，立即生效）
      if (req.method === 'POST' && req.url === '/workspace') {
        readBody(req).then(body => {
          try {
            const cfg = JSON.parse(body);
            if (!cfg.current) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少 current' })); return; }
            const newWs = path.resolve(cfg.current);
            if (!fs.existsSync(newWs)) { res.writeHead(400); res.end(JSON.stringify({ error: '路径不存在' })); return; }
            WORKSPACE = newWs;
            const list = Array.isArray(cfg.list) ? cfg.list : [newWs];
            if (!list.includes(newWs)) list.unshift(newWs);
            storage.saveData('workspace', JSON.stringify({ current: WORKSPACE, list })).then(() => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, workspace: WORKSPACE }));
            });
          } catch(e) {
            res.writeHead(400); res.end(JSON.stringify({ error: '无效 JSON' }));
          }
        });
        return;
      }
      // 项目文件索引（仅当前目录一层，不递归子目录）
      if (req.method === 'GET' && req.url === '/project-index') {
        (async () => {
          try {
            const entries = await fs.promises.readdir(__dirname, { withFileTypes: true });
            const list = [];
            for (const e of entries) {
              if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'data') continue;
              const rel = path.relative(__dirname, path.join(__dirname, e.name));
              if (e.isDirectory()) {
                list.push({ path: rel + '/', size: 0, isDir: true });
              } else {
                const st = await fs.promises.stat(path.join(__dirname, e.name));
                list.push({ path: rel, size: st.size, isDir: false });
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(list));
          } catch (e) { res.writeHead(500); res.end('[]'); }
        })();
        return;
      }
      // 工作空间文件索引（扫描 WORKSPACE 目录下文件）
      if (req.method === 'GET' && req.url === '/workspace-index') {
        (async () => {
          try {
            const entries = await fs.promises.readdir(WORKSPACE, { withFileTypes: true });
            const list = [];
            for (const e of entries) {
              if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'data') continue;
              const rel = path.relative(WORKSPACE, path.join(WORKSPACE, e.name));
              if (e.isDirectory()) {
                list.push({ path: rel + '/', size: 0, isDir: true });
              } else {
                const st = await fs.promises.stat(path.join(WORKSPACE, e.name));
                list.push({ path: rel, size: st.size, isDir: false });
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(list));
          } catch (e) { res.writeHead(500); res.end('[]'); }
        })();
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
            if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('mcp-skills-changed'); } catch(e) {} }
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
            if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('mcp-skills-changed'); } catch(e) {} }
            res.writeHead(200); res.end();
          } catch (e) {
            res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
      // MCP 重载（添加/卸载技能后重新连接）
      if (req.method === 'POST' && req.url === '/mcp-reload') {
        mcp.reload().then(() => {
          if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('mcp-skills-changed'); } catch(e) {} }
          res.writeHead(200); res.end();
        }).catch(() => { res.writeHead(500); res.end(); });
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
        const ext = path.extname(fp);
        const headers = { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' };
        if (ext === '.html') headers['Content-Security-Policy'] = "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https:; img-src 'self' data: https:; connect-src 'self' http: https:;";
        res.writeHead(200, headers);
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
  // 加载已保存的工作空间配置
  try {
    const raw = await storage.loadData('workspace');
    const cfg = JSON.parse(raw);
    if (cfg.current && fs.existsSync(cfg.current)) WORKSPACE = path.resolve(cfg.current);
  } catch (e) { /* 无配置则使用默认值 */ }
  console.log('[main] 工作空间:', WORKSPACE);
  // 启动时主动写出状态文件（默认配置），便于用户直接查看与管理；不会覆盖已有内容
  const ensureCfg = (name, def) => {
    const p = storage.getPath(name);
    if (!fs.existsSync(p)) { try { fs.writeFileSync(p, def); } catch (e) { console.warn(`[main] 初始化 ${name} 配置失败:`, e.message); } }
  };
  ensureCfg('tools', JSON.stringify({ disabled: [] }));
  ensureCfg('skills', JSON.stringify({ installed: {} }));
  ensureCfg('instructions', JSON.stringify({ list: [] }));
  ensureCfg('pet-cfg', JSON.stringify({}));
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
      { label: '🐾 宠物配置', click: () => mainWindow.webContents.send('menu', 'pet-cfg', '') },
      { label: '🧰 内置工具', click: () => mainWindow.webContents.send('menu', 'tools', '') },
      { label: '🧩 拓展工具', click: () => mainWindow.webContents.send('menu', 'skills', '') },
      { label: '📋 自定义指令', click: () => mainWindow.webContents.send('menu', 'instructions', '') },
      { label: '📁 工作空间', click: () => mainWindow.webContents.send('menu', 'workspace-window', '') },
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
      width: 360, height: 480, resizable: false,
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
  // 工作空间设置窗口
  ipcMain.on('open-workspace-window', () => {
    if (workspaceWindow && !workspaceWindow.isDestroyed()) { if(workspaceWindow.isMinimized())workspaceWindow.restore(); workspaceWindow.focus(); return; }
    workspaceWindow = new BrowserWindow({
      width: 380, height: 400, resizable: false,
      transparent: false, frame: false, skipTaskbar: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
    });
    workspaceWindow.loadURL(`http://127.0.0.1:${port}/workspace.html`);
    workspaceWindow.on('closed', () => { workspaceWindow = null; });
  });
  // 文件夹选择器（工作空间用）
  ipcMain.handle('open-folder-dialog', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
  // 宠物配置窗口
  ipcMain.on('open-pet-cfg-window', () => {
    if (petCfgWindow && !petCfgWindow.isDestroyed()) { if(petCfgWindow.isMinimized())petCfgWindow.restore(); petCfgWindow.focus(); return; }
    petCfgWindow = new BrowserWindow({
      width: 380, height: 640, resizable: false,
      transparent: false, frame: false, skipTaskbar: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
    });
    petCfgWindow.loadURL(`http://127.0.0.1:${port}/pet-cfg.html`);
    petCfgWindow.on('closed', () => {
      petCfgWindow = null;
      if(mainWindow&&!mainWindow.isDestroyed()) mainWindow.webContents.send('pet-cfg-window-closed');
    });
  });
  // 宠物配置开关（开场白/主动问候）即时生效：仅转发给主窗口，由主窗口实时更新内存中的 petCfg
  ipcMain.on('update-pet-cfg-live', (_, partial) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pet-cfg-live', partial);
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
