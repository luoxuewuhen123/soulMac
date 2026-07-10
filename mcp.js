const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// skills 文件路径由 storage 模块统一管理
const storage = require('./storage');
let servers = [];
let connectingPromise = null;

function loadSkills() {
  try {
    const raw = fs.readFileSync(storage.getPath('skills'), 'utf-8');
    return JSON.parse(raw).installed || {};
  } catch (e) {
    return {};
  }
}

/** JSON-RPC 通信（带超时） */
function jsonRpc(proc, method, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    let buf = '';
    let done = false;

    const timer = setTimeout(() => {
      if (!done) { done = true; cleanup(); reject(new Error('超时 (' + method + ')')); }
    }, timeoutMs);

    const onData = (chunk) => {
      if (done) return;
      buf += chunk.toString();
      // 逐行解析 JSON
      const lines = buf.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const resp = JSON.parse(line);
          if (resp.id === id) {
            done = true; clearTimeout(timer); cleanup();
            if (resp.error) reject(new Error(resp.error.message || JSON.stringify(resp.error)));
            else resolve(resp.result);
            return;
          }
        } catch (e) { /* 非 JSON 行（如 stderr 混杂），跳过 */ }
      }
      buf = lines[lines.length - 1]; // 保留未完成的行
    };

    const onError = (e) => { if (!done) { done = true; clearTimeout(timer); cleanup(); reject(e); } };
    const onExit = (code) => { if (!done) { done = true; clearTimeout(timer); cleanup(); reject(new Error('进程退出, code=' + code)); } };

    const cleanup = () => {
      proc.stdout.removeListener('data', onData);
      proc.removeListener('error', onError);
      proc.removeListener('exit', onExit);
    };

    proc.stdout.on('data', onData);
    proc.on('error', onError);
    proc.on('exit', onExit);
    proc.stdin.write(req);
  });
}

/** 连接一个 MCP 服务器 */
async function connectServer(id, cfg) {
  const command = cfg.command;
  const args = cfg.args || [];

  console.log('[mcp] 正在启动:', cfg.name || id, command, ...args);

  const proc = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...cfg.env },
    shell: process.platform === 'win32',
    windowsHide: true,
  });

  // 收集 stderr 用于调试
  proc.stderr.on('data', d => console.log('[mcp:' + id + ']', d.toString().trim()));

  // 初始化握手
  const initResult = await jsonRpc(proc, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'soul-pet', version: '1.0.0' },
  });

  console.log('[mcp]', id, '初始化成功');

  // 发送 initialized 通知
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  // 获取工具列表
  const result = await jsonRpc(proc, 'tools/list', {});
  const tools = result.tools || [];

  servers.push({ name: id, proc, tools });
  console.log('[mcp] 已连接:', cfg.name || id, `(${tools.length} 个工具)`);
  tools.forEach(t => console.log('  -', t.name));
  return tools;
}

/** 连接所有已安装的技能（去重：同一时间只连接一次） */
async function connectAll() {
  if (connectingPromise) return connectingPromise;
  connectingPromise = (async () => {
    const skills = loadSkills();
    console.log('[mcp] 技能配置:', Object.keys(skills).length, '个');
    for (const [id, cfg] of Object.entries(skills)) {
      try {
        await connectServer(id, cfg);
      } catch (e) {
        console.warn('[mcp] 连接失败:', id, '->', e.message);
      }
    }
    return servers;
  })();
  const result = await connectingPromise;
  connectingPromise = null;
  return result;
}

/** 归一化 inputSchema 以兼容 OpenAI strict 模式：补 additionalProperties:false、递归处理嵌套、剔除不支持的类型 */
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {}, additionalProperties: false };
  const out = { ...schema };
  // strict 模式要求顶层为 object 且 additionalProperties:false
  if (out.type !== 'object' && out.type !== undefined) {
    // 非 object schema（如纯 string）无法满足 strict，包装成 object
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  out.type = 'object';
  out.additionalProperties = false;
  if (out.properties && typeof out.properties === 'object') {
    const props = {};
    for (const [k, v] of Object.entries(out.properties)) {
      if (!v || typeof v !== 'object') continue;
      const nv = { ...v };
      if (nv.type === 'array') {
        if (nv.items) nv.items = normalizeSchemaItem(nv.items);
        delete nv.additionalProperties;
      } else if (nv.type === 'object') {
        nv.additionalProperties = false;
        if (nv.properties) {
          const sub = {};
          for (const [sk, sv] of Object.entries(nv.properties)) sub[sk] = normalizeSchemaItem(sv);
          nv.properties = sub;
        }
      }
      props[k] = nv;
    }
    out.properties = props;
  } else {
    out.properties = {};
  }
  // strict 模式不支持 default；保留 required 原样
  return out;
}
function normalizeSchemaItem(item) {
  if (!item || typeof item !== 'object') return { type: 'string' };
  const nv = { ...item };
  if (nv.type === 'object') {
    nv.additionalProperties = false;
    if (nv.properties) {
      const sub = {};
      for (const [sk, sv] of Object.entries(nv.properties)) sub[sk] = normalizeSchemaItem(sv);
      nv.properties = sub;
    }
  } else if (nv.type === 'array' && nv.items) {
    nv.items = normalizeSchemaItem(nv.items);
  }
  return nv;
}

/** 获取工具定义（按需连接） */
async function getToolDefinitions() {
  if (servers.length === 0) {
    const skills = loadSkills();
    if (Object.keys(skills).length > 0) {
      await connectAll();
    }
  }
  const result = [];
  for (const server of servers) {
    for (const tool of server.tools) {
      result.push({
        type: 'function',
        function: {
          name: `mcp__${server.name}__${tool.name}`,
          description: `[${server.name}] ${tool.description || ''}`,
          strict: true,
          parameters: normalizeSchema(tool.inputSchema),
        },
      });
    }
  }
  console.log('[mcp] 返回工具数:', result.length);
  return result;
}

/** 调用 MCP 工具 */
async function callTool(fullName, args) {
  const parts = fullName.split('__');
  const serverName = parts[1];
  const toolName = parts.slice(2).join('__');
  const server = servers.find(s => s.name === serverName);
  if (!server) throw new Error(`MCP 服务器 "${serverName}" 未连接`);
  const result = await jsonRpc(server.proc, 'tools/call', { name: toolName, arguments: args }, 60000);
  if (result.isError) return `✗ ${result.content?.[0]?.text || '执行失败'}`;
  return result.content?.map(c => c.text || '').filter(Boolean).join('\n') || 'ok';
}

async function disconnectAll() {
  for (const server of servers) {
    try { server.proc.kill(); } catch (e) { /* ignore */ }
  }
  servers = [];
}

async function reload() {
  connectingPromise = null;
  await disconnectAll();
  return await connectAll();
}

/** 直接连接一个新技能（不先断开所有） */
async function addServer(id, cfg) {
  if (servers.some(s => s.name === id)) {
    // 已存在则先断开
    const old = servers.find(s => s.name === id);
    try { old.proc.kill(); } catch(e) {}
    servers = servers.filter(s => s.name !== id);
  }
  try {
    await connectServer(id, cfg);
  } catch (e) {
    console.warn('[mcp] 添加技能失败:', id, '->', e.message);
    throw e;
  }
}

/** 删除一个技能并断开其连接 */
async function removeServer(id) {
  const server = servers.find(s => s.name === id);
  if (server) {
    try { server.proc.kill(); } catch(e) {}
    servers = servers.filter(s => s.name !== id);
  }
}

module.exports = { connectAll, reload, getToolDefinitions, callTool, disconnectAll, addServer, removeServer };
