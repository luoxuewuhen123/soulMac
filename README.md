<p align="center">
  <img src="icon.png" width="96" height="96" alt="茵茵">
</p>

<h1 align="center">茵茵 — 桌面宠物 · AI 智能体</h1>

<p align="center">
  <strong>一个长着宠物脸的本地 AI 编程助手</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-43.0+-47848F?logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
</p>

<p align="center">
  <a href="#-功能概览">功能概览</a> ·
  <a href="#-快速开始">快速开始</a> ·
  <a href="#-配置说明">配置说明</a> ·
  <a href="#-内置工具">内置工具</a> ·
  <a href="#-拓展工具">拓展工具</a> ·
  <a href="#-技术架构">技术架构</a> ·
  <a href="#-项目结构">项目结构</a>
</p>

---

## 🎯 这是什么？

**茵茵**是一个以桌面宠物为交互载体的 AI 智能体。

表面上，她是一只萌萌的桌面宠物——会走动、会说话、会卖萌。但本质上，她是一个**完整的本地 AI Agent**，拥有文件系统操作、代码搜索编辑、命令执行、网页抓取等全套工具链，可以帮你完成从写代码到项目管理的一系列任务。

> 她长着一张宠物的脸，但能帮你重构整个项目。

---

## ✨ 功能概览

### 🐱 桌面宠物
- Live2D 动态模型（可替换）
- 桌面常驻，拖拽移动
- TTS 语音对话（Edge TTS）
- 定时主动问候
- 装饰系统

### 🤖 AI 对话
- 支持 6 种大模型一键切换（DeepSeek / 通义千问 / GLM / Kimi / 豆包 / 文心）
- 也支持自定义 OpenAI 兼容接口
- 流式 SSE 实时回复
- 深度思考模式（思维链展示）
- 多模态视觉识别（模型支持时可看图）
- TypeScript/Vue 语法检查（写入后自动 lint）
- 中断机制（随时打断 AI 回复）
- 聊天历史 + 自动摘要 + 工作记忆

### 🛠️ 内置工具（AI 自动调用）
| 工具 | 功能 |
|------|------|
| `read_files` | 读取一个或多个文件（支持 paths 数组批量读，图片自动识别，默认读前2000行，截断时提示用 offset 续读） |
| `edit_file` | content 整体覆盖 或 patches SEARCH/REPLACE（old 须唯一），写入后自动 lint |
| `delete_files` | 永久删除一个或多个文件（paths 数组），文件不存在不会报错 |
| `replace` | 跨文件批量替换纯文本（非正则），wholeWord 精确重命名，替换后自动 lint |
| `search` | 全文搜索（关键词/正则），上下文预览，文件级统计 |
| `search_file` | 按文件名通配符模式搜索 |
| `tree` | 递归目录树（可限深度、忽略目录） |
| `run_js` | 在项目目录下执行 JS 代码（Node.js），后备用 |
| `lint_file` | 语法检查，支持 JS/TS/Vue/Py/HTML/CSS/XML/YAML/Shell，未覆盖类型有通用平衡兜底 |
| `web` | 搜索互联网（cn.bing.com）或抓取网页内容 |
| `mkdir` | 递归创建目录 |
| `rename_file` | 重命名或移动文件/目录，目标父目录需先存在（可用 mkdir） |

### 🧩 拓展工具（MCP 协议）
通过 MCP（Model Context Protocol）安装第三方工具包，扩展 AI 能力：
- 文档处理（PDF / DOCX / XLSX / PPTX）
- 浏览器自动化
- 数据库操作
- 更多社区 MCP 工具...

### ⚙️ 配置系统
- **AI 配置**：选择模型、填写 API Key、设置上下文窗口
- **宠物配置**：角色设定、开场白、主动问候
- **内置工具开关**：每个工具可独立关闭（省 token / 限制能力）
- **自定义指令**：为 AI 添加自定义规则（按需启用/禁用）
- **工作空间**：管理多个项目目录，秒级切换
- **拓展工具管理**：搜索和安装社区 MCP 工具

---

## 🚀 快速开始

### 前置条件
- Node.js 18+
- npm

### 安装

```bash
# 1. 克隆项目
git clone https://github.com/luoxuewuhen123/soul.git
cd soul

# 2. 安装依赖
npm install

# 3. 启动开发模式
npm start
```

### 打包发布

```bash
# Windows 安装包
npm run dist:win

# macOS DMG
npm run dist:mac

# Linux AppImage
npm run dist:linux

# 全部平台
npm run dist:all
```

### 首次使用

1. 启动后，右键点击宠物 → **AI 配置**，填写 API Key 并选择模型
2. 支持的大模型：DeepSeek V4 Flash、通义千问 Qwen3-Max、GLM 5.2、Kimi K2.5、豆包 Seed 2.0 Pro、文心 ERNIE 5.0
3. 也支持任何 OpenAI 兼容接口的自定义配置
4. 右键菜单 → **工作空间**，设置你的项目目录
5. 双击宠物 → 开始聊天！

---

## ⚙️ 配置说明

| 配置页 | 入口 | 说明 |
|--------|------|------|
| ⚙️ **AI 配置** | 右键菜单 | API 地址、API Key、模型选择、上下文窗口、视觉/思考开关 |
| 🐱 **宠物配置** | 右键菜单 | 角色人设、开场白、主动问候语和间隔 |
| 🧰 **内置工具** | 右键菜单 | 查看所有内置工具，可单独开关（修改即时生效） |
| 🧩 **拓展工具** | 右键菜单 | 搜索和安装社区 MCP 工具包 |
| 📋 **自定义指令** | 右键菜单 | 添加/编辑/开关 AI 行为规则 |
| 📁 **工作空间** | 右键菜单 | 管理项目目录列表，切换当前工作空间 |
| 💬 **聊天窗口** | 双击宠物 | 与 AI 对话，支持文本/工具调用可视化 |

所有配置修改后**即时生效**，无需重启应用。

---

## 🔧 内置工具详解

### 文件操作
| 工具 | 描述 | 反馈质量 |
|------|------|---------|
| `read_files` | 批量读文件（paths 数组），自动识别图片，默认读前2000行，截断时提示 | ⭐ 优秀：文件路径+行数明细 |
| `edit_file` | content 覆盖写 或 patches SEARCH/REPLACE（old须唯一），写入后自动 lint | ⭐ 优秀：变更行号明细、语法检查结果、未匹配项提示 |
| `delete_files` | 永久删除一个或多个文件（paths 数组），文件不存在不会报错 | ✅ 可靠 |
| `replace` | 跨文件批量替换纯文本（非正则），wholeWord 精确重命名 | ⭐ 优秀：变更文件/行级明细 + 语法检查 |
| `rename_file` | 重命名或移动文件/目录 | ✅ 可靠 |
| `mkdir` | 递归创建目录 | ✅ 可靠 |

### 搜索工具
| 工具 | 描述 | 反馈质量 |
|------|------|---------|
| `search` | 全文搜索（关键词/正则），上下文预览，文件级统计 | ⭐ 优秀：文件级统计、500 条上限 |
| `search_file` | 通配符文件名搜索 | ✅ 可靠 |
| `tree` | 递归目录树，可忽略目录，上限 600 项 | ⭐ 优秀：美观的 ASCII 树 |

### 检查 & 执行
| 工具 | 描述 | 反馈质量 |
|------|------|---------|
| `lint_file` | 语法检查，支持 JS/TS/Vue/Python/HTML/CSS/XML/YAML/Shell，未覆盖的类型有通用括号/引号平衡兜底 | ⭐ 优秀：精确行列号、错误信息 |
| `run_js` | 在项目目录下执行 JS 代码（Node.js），安全后备方案，可传 file 自动注入 __file/__content | ⭐ 优秀：exit code + 输出 |

### 网络工具
| 工具 | 描述 | 反馈质量 |
|------|------|---------|
| `web` | 搜索互联网（q）或抓取网页内容（url），一个工具代替两个 | ⭐ 优秀：搜索结果/自动去噪抓取 |

---

## 🧩 拓展工具（MCP）

茵茵通过 [MCP（Model Context Protocol）](https://modelcontextprotocol.io/) 支持第三方工具扩展。  
你可以在右键菜单 → **拓展工具** 中搜索并安装社区工具包。

目前可用的 MCP 工具包括但不限于：
- **文档处理**：PDF 解析、Word 生成、Excel 操作
- **浏览器**：网页自动化、截图
- **数据库**：SQLite、PostgreSQL 等
- **开发工具**：Git 操作、代码格式化等
- **更多**：持续增长的社区工具生态

也可以**手动添加自定义 MCP 服务器**，填写命令、参数和环境变量即可。

---

## 🏗 技术架构

```
┌─────────────────────────────────────────────────────┐
│                   用户界面层                          │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ 宠物窗口  │  │ 聊天窗口  │  │ 配置页(index/ai/   │  │
│  │(index    │  │(chat     │  │ pet/skills/tools/   │  │
│  │ .html)   │  │ .html)   │  │ instructions/       │  │
│  │          │  │          │  │ workspace)          │  │
│  └────┬─────┘  └────┬─────┘  └────────┬───────────┘  │
└───────┼──────────────┼────────────────────┼──────────┘
        │   IPC        │   HTTP            │
        ▼              ▼                    ▼
┌─────────────────────────────────────────────────────┐
│                   Electron 主进程                     │
│              main.js + storage.js                    │
│                                                      │
│  ┌────────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ HTTP Server│  │ IPC 通信  │  │ MCP Manager(mcp)│  │
│  │ (:随机端口) │  │ (窗口管理)│  │ (JSON-RPC)       │  │
│  └─────┬──────┘  └──────────┘  └────────┬─────────┘  │
│        │                                 │           │
│        ▼                                 ▼           │
│  ┌─────────────────┐         ┌────────────────────┐  │
│  │ 工具路由处理      │         │ 第三方 MCP 服务器   │  │
│  │ read_files/edit   │         │ (PDF/Excel/浏览器等)│  │
│  │ replace/search/   │         └────────────────────┘  │
│  │ lint/run_js/web  │                                  │
│  └─────────────────┘                                  │
└─────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────┐
│                  AI 大模型 API                        │
│  DeepSeek / 通义千问 / GLM / Kimi / 豆包 / 文心     │
│  function calling 工具循环 (最多 50 轮)              │
└─────────────────────────────────────────────────────┘
```

### 核心流程

1. **用户输入** → 宠物/聊天窗口通过 HTTP 发到 Electron 主进程
2. **构建上下文** → 加载角色设定、自定义指令、经验摘要、聊天历史
3. **AI 调用** → 带工具定义发送到 AI API，流式 SSE 接收回复
4. **工具循环** → AI 返回 `tool_calls`，前端并行执行所有工具调用（写入文件后自动 lint 检查语法）
5. **结果回传** → 每个工具的执行结果（含 lint 结果）返回给 AI，AI 决定下一步（最多 50 轮）
6. **最终回复** → AI 不再调用工具时，展示最终回复给用户

---

## 📁 项目结构

```
soul/
├── main.js                 # Electron 主进程（HTTP 服务器、IPC、路由）
├── preload.js              # 预加载脚本（曝光 API 到渲染进程）
├── storage.js              # 数据持久化存储模块
├── mcp.js                  # MCP 协议管理器（连接/调用第三方工具）
├── model-config.js         # AI 模型配置常量
├── tts-worker.js           # TTS 语音合成工作进程
│
├── index.html              # 宠物窗口（主界面）
├── chat.html               # 聊天窗口
│
├── ai-cfg.html             # AI 模型配置页
├── pet-cfg.html            # 宠物配置页
├── tools.html              # 内置工具管理页
├── skills.html             # 拓展工具管理页
├── instructions.html       # 自定义指令页
├── workspace.html          # 工作空间管理页
│
├── package.json            # 项目配置
├── installer.nsh           # NSIS 安装脚本
├── 启动宠物.bat             # Windows 快捷启动
├── 数据存储位置.txt          # 数据目录说明
│
├── icon.ico                # Windows 图标
├── icon.icns               # macOS 图标
│
├── xiaoyue/                # Live2D 模型资源
│   ├── model.json          #   模型配置文件
│   ├── *.moc3              #   模型数据
│   └── *.png               #   纹理贴图
│
└── data/                   # 运行自动生成（用户数据）
    ├── .ai-cfg.json        # AI 配置
    ├── .pet-cfg.json       # 宠物配置
    ├── .chat-cfg.json      # 聊天记录
    ├── .chat-archive.json  # 聊天存档
    ├── .experiences.json   # 聊天摘要
    ├── .tools.json         # 工具开关配置
    ├── .skills.json        # 拓展工具配置
    ├── .instructions.json  # 自定义指令
    ├── .workspace.json     # 工作空间配置
    ├── .deco.json          # 宠物装饰
    └── .voice.json         # 语音开关
```

---

## 📦 技术栈

| 类别 | 技术 |
|------|------|
| **框架** | Electron 43 |
| **AI 交互** | OpenAI-compatible API（function calling + 流式 SSE） |
| **桌面宠物** | Live2D Cubism 4（oh-my-live2d + pixi-live2d-display） |
| **TTS** | edge-tts-universal（微软 Edge 语音合成） |
| **工具扩展** | MCP（Model Context Protocol，JSON-RPC 2.0） |
| **文档处理** | pdf-parse、mammoth、docx、exceljs（通过 MCP） |
| **打包** | electron-builder（NSIS / DMG / AppImage） |

---

## 🔒 安全设计

- **工作空间沙箱**：所有文件操作只能在当前工作空间目录内执行
- **路径安全检查**：每步操作都经过 `safePath()` 校验，防止路径穿越
- **工具开关**：每个内置工具可独立关闭，可在不重启应用的情况下限制 AI 能力
- **中断机制**：随时中断 AI 回复，终止后台进程
- **单实例锁**：防止应用重复启动

---

## 📜 许可证

**CC BY-NC-SA 4.0**（知识共享-非商业性使用-相同方式共享）

🚫 **禁止商业用途**：本项目仅供个人学习与免费使用。禁止任何形式的倒卖、转售、收费安装、作为付费课程/教程内容、或任何商业目的的使用。

© 2025 sigan · 微信：zhengtu920

---

<p align="center">
  用 ❤️ 和 AI 做的桌面小伙伴 · 个人免费使用 · 禁止倒卖
</p>
