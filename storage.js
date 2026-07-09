const fs = require('fs');
const path = require('path');

const DATA_DIR = 'data';
let baseDir = path.join(__dirname, DATA_DIR); // 默认值，可通过 init() 覆盖

/** 初始化数据目录（在 app.whenReady 后调用，传入 app.getPath('userData') 路径） */
function init(userDataPath) {
  baseDir = path.join(userDataPath, DATA_DIR);
  try { fs.mkdirSync(baseDir, { recursive: true }); } catch(e) { console.error('[storage] 创建目录失败:', baseDir, e.message); }
}

// ===== 文件路径映射 =====
const files = {
  deco:          '.deco.json',
  'chat-cfg':    '.chat-cfg.json',
  'chat-archive':'.chat-archive.json',
  voice:         '.voice.json',

  'ai-cfg':      '.ai-cfg.json',
  experiences:   '.experiences.json',
  skills:        '.skills.json',
  tools:         '.tools.json',
  instructions:  '.instructions.json',
  'pet-cfg':     '.pet-cfg.json',
};

// ===== 各文件默认值（文件不存在时返回） =====
const defaults = {
  deco:          '{}',
  'chat-cfg':    '{}',
  'chat-archive':'[]',
  voice:         '{"enabled":false}',

  'ai-cfg':      '{}',
  experiences:   '[]',
  skills:        '{}',
  tools:         '{"disabled":[]}',
  instructions:  '{"list":[]}',
  'pet-cfg':     '{}',
};

// ===== 串行写入队列 =====
const writeQueue = [];
let writing = false;

function queueWrite(fp, data, cb) {
  writeQueue.push({ file: fp, data, cb });
  if (!writing) processQueue();
}

function processQueue() {
  if (writeQueue.length === 0) { writing = false; return; }
  writing = true;
  const { file, data, cb } = writeQueue.shift();
  fs.writeFile(file, data, (err) => {
    if (err) {
      console.error('[storage] 写入失败:', file, err.message);
      cb && cb(err);
    } else {
      cb && cb(null);
    }
    processQueue();
  });
}

// ===== 公开 API =====

function getPath(name) {
  return path.join(baseDir, files[name] || name);
}

/** 异步保存（写入队列） */
function save(name, data, cb) {
  queueWrite(getPath(name), typeof data === 'string' ? data : JSON.stringify(data), cb);
}

/** 异步加载，不存在时返回默认值（HTTP 版本，旧接口保持兼容） */
function load(name, res) {
  fs.readFile(getPath(name), (e, d) => {
    if (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(defaults[name] || '{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(d);
  });
}

/** 异步加载数据，返回 Promise<string>，不存在时返回默认值 */
function loadData(name) {
  return new Promise((resolve) => {
    fs.readFile(getPath(name), (e, d) => {
      if (e) {
        resolve(defaults[name] || '{}');
      } else {
        resolve(d.toString());
      }
    });
  });
}

/** 异步保存数据，返回 Promise */
function saveData(name, data) {
  return new Promise((resolve, reject) => {
    queueWrite(getPath(name), typeof data === 'string' ? data : JSON.stringify(data), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = { save, load, loadData, saveData, init, getPath };
