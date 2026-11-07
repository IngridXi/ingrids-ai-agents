/**
 * ============================================================
 *  agents-core.js  —— 从 OpenMausBot 提炼的可复用「多 Agent」核心
 *  ============================================================
 *
 *  设计来源：github.com/milind-soni/OpenMausBot（Apache 2.0）
 *  核心思想（OpenMausBot 的「每个 bot 是一个真实 agent」）：
 *    1. 每个 Agent 是独立的「数字员工」，有自己的：
 *         name     名字          soul      人设 / 系统指令（standing instructions）
 *         memory   私有记忆(MEMORY.md)  skills  技能  routines  定时任务
 *         engine   绑定的模型/引擎    approvalMode  权限模式  tools  可用工具
 *    2. bring-your-own-agent：引擎复用本机已登录的 CLI（Claude Code / Codex / Grok），
 *       或接 LLM API（DeepSeek / GPT / Qwen …）。
 *    3. local-first：所有配置、记忆、密钥都存本机（localStorage / 可导出 JSON），不上云。
 *
 *  用法：
 *    <script src="agents-core.js"></script>
 *    然后调用 window.AgentsCore 里的 API（见文件底部示例）。
 *  可直接复制到任意纯 HTML/JS 项目里复用，零依赖。
 * ============================================================
 */
(function (global) {
  'use strict';

  /* ---------- 1. 引擎 / 模型注册表（bring-your-own-agent） ---------- */
  // kind: 'cli' 复用本机已登录 CLI ｜ 'api' 走云端 API ｜ 'local' 本地推理
  var ENGINES = {
    'claude-code': { name: 'Claude Code', kind: 'cli',  tag: '本机 CLI · 编码强',   status: 'ready' },
    'codex':       { name: 'Codex',       kind: 'cli',  tag: '本机 CLI · 编码强',   status: 'ready' },
    'grok':        { name: 'Grok',        kind: 'cli',  tag: '本机 CLI · 综合',     status: 'ready' },
    'deepseek':    { name: 'DeepSeek',    kind: 'api',  tag: '中文强 · 高性价比',   status: 'pending' },
    'gpt':         { name: 'GPT',         kind: 'api',  tag: '综合 · 推理',         status: 'pending' },
    'qwen':        { name: 'Qwen',        kind: 'api',  tag: '中文 · 可本地部署',   status: 'pending' },
    'local-llm':   { name: '本地大模型',  kind: 'local',tag: '不上云 · 隐私优先',   status: 'ready' },
    'funasr':      { name: 'FunASR',      kind: 'local',tag: '语音转写（本机）',    status: 'ready' },
  };

  /* ---------- 2. Agent Schema（对应 OpenMausBot 的 newBotDefaults） ---------- */
  // 新建一个 Agent 的默认模板；new AgentRegistry().create() 会用这份默认值。
  var DEFAULT_AGENT = {
    id: '',            // 唯一标识（自动生成）
    name: '',          // 名字（显示在列表里）
    title: '',         // 头衔 / 一句话定位
    emoji: '🤖',       // 图标
    soul: '',          // 人设 / 系统指令（相当于 system prompt）
    description: '',   // 简介
    engine: 'local-llm', // 绑定的主模型（见 ENGINES）
    fallbacks: [],     // 主模型不可用时的降级顺序，如 ['deepseek','gpt']
    memory: {},        // 私有记忆，如 { 'MEMORY.md': '...' }，local-first
    skills: [],        // 技能列表 [{ name, description, text }]
    routines: [],      // 定时任务 [{ name, prompt, enabled, schedule }]
    tools: [],         // 可用工具/外部应用，如 ['github','gmail','notion']
    approvalMode: 'ask', // 权限：'ask' 每次确认 | 'full' 全自动 | 'custom' 自定义
    computer: 'off',   // 是否允许操作本机电脑：'off' | 'on'
    visibility: 'private', // 可见性：'private' | 'team' | 'public'
  };

  /* ---------- 3. AgentRegistry：增删改查 + local-first 持久化 ---------- */
  // storage 可插拔：默认 localStorage（浏览器）；Electron 桌面版注入文件系统后端。
  // 形如 { load: function()=>Array, save: function(agents)=>void }
  function defaultStorage(storageKey) {
    return {
      load: function () {
        try {
          var raw = global.localStorage.getItem(storageKey);
          return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
      },
      save: function (agents) {
        try { global.localStorage.setItem(storageKey, JSON.stringify(agents)); } catch (e) {}
      },
    };
  }

  function AgentRegistry(storageKey, storage) {
    this.storageKey = storageKey || 'openmausbot.agents';
    this.storage = storage || defaultStorage(this.storageKey);
    this.agents = this._load();
  }

  AgentRegistry.prototype._load = function () {
    try {
      var raw = this.storage.load();
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  };

  AgentRegistry.prototype._save = function () {
    try { this.storage.save(this.agents); } catch (e) {}
    return this;
  };

  AgentRegistry.prototype._id = function () {
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  };

  // 列出所有 Agent（可按可见性过滤）
  AgentRegistry.prototype.list = function (filter) {
    var self = this;
    if (!filter) return this.agents.slice();
    return this.agents.filter(function (a) { return a[filter.key] === filter.value; });
  };

  // 创建（merge 默认值，OpenMausBot 的 useDefaults 逻辑）
  AgentRegistry.prototype.create = function (overrides, useDefaults) {
    var base = useDefaults === false ? { id: this._id() } : Object.assign({}, DEFAULT_AGENT, { id: this._id() });
    var agent = Object.assign(base, overrides || {});
    if (!agent.name) agent.name = '未命名 Agent ' + (this.agents.length + 1);
    this.agents.push(agent);
    this._save();
    return agent;
  };

  AgentRegistry.prototype.get = function (id) {
    for (var i = 0; i < this.agents.length; i++) if (this.agents[i].id === id) return this.agents[i];
    return null;
  };

  AgentRegistry.prototype.update = function (id, patch) {
    var a = this.get(id); if (!a) return null;
    Object.assign(a, patch); this._save(); return a;
  };

  AgentRegistry.prototype.remove = function (id) {
    var before = this.agents.length;
    this.agents = this.agents.filter(function (a) { return a.id !== id; });
    this._save(); return this.agents.length < before;
  };

  // 导出 / 导入（像 OpenMausBot 的 bot package 那样备份迁移）
  AgentRegistry.prototype.export = function () { return JSON.stringify(this.agents, null, 2); };
  AgentRegistry.prototype.import = function (json) {
    var arr = JSON.parse(json); if (!Array.isArray(arr)) throw new Error('格式错误');
    this.agents = arr; this._save(); return this.agents.length;
  };

  /* ---------- 4. ModelRouter：按任务类型 / Agent 绑定路由到引擎 ---------- */
  // OpenMausBot 思路：每个 Agent 有自己的模型；路由负责「主模型不可用 → 降级」，
  // 以及「按任务类型给一个缺省引擎」（比如转写→funasr，写作→claude，性价比→deepseek）。
  var TASK_DEFAULTS = {
    'transcribe': 'funasr',   // 语音转写
    'summarize': 'deepseek',  // 摘要/纪要（性价比）
    'writing':   'claude-code', // 写作/长文
    'coding':    'codex',     // 代码
    'translate': 'qwen',      // 翻译
    'general':   'local-llm', // 通用/隐私
  };

  function ModelRouter() {}

  // 给某个 Agent 解析出「实际该用的引擎」，含降级链
  ModelRouter.prototype.resolve = function (agent, registry) {
    var chain = [agent.engine].concat(agent.fallbacks || []);
    var engs = registry || ENGINES;
    for (var i = 0; i < chain.length; i++) {
      var e = engs[chain[i]];
      if (e && e.status !== 'disabled') return { engine: chain[i], meta: e };
    }
    return { engine: chain[0], meta: engs[chain[0]] || null };
  };

  // 按任务类型推荐一个缺省引擎（创建 Agent 时的提示）
  ModelRouter.prototype.defaultFor = function (taskType) {
    return TASK_DEFAULTS[taskType] || TASK_DEFAULTS.general;
  };

  /* ---------- 导出 ---------- */
  global.AgentsCore = {
    ENGINES: ENGINES,
    DEFAULT_AGENT: DEFAULT_AGENT,
    TASK_DEFAULTS: TASK_DEFAULTS,
    AgentRegistry: AgentRegistry,
    ModelRouter: ModelRouter,
    // 便捷工厂：在浏览器里直接建一个「会议纪要」这类常用 Agent
    createAgent: function (overrides) { return Object.assign({}, DEFAULT_AGENT, overrides); },
  };

  /* ---------- 使用示例（浏览器控制台可跑） ----------
  var core = window.AgentsCore;
  var reg = new core.AgentRegistry();
  var bot = reg.create({
    name: '会议纪要官',
    emoji: '🎙️',
    soul: '你是专业的会议记录员：转写、区分说话人、提炼行动项与决策。',
    engine: 'funasr',
    fallbacks: ['deepseek'],
    skills: [{ name: '声纹识别', description: '登记人声后自动认人', text: '...' }],
    routines: [{ name: '每日复盘', prompt: '汇总当天会议', enabled: false,
                 schedule: { type: 'daily', time: '18:00', weekdays: [1,2,3,4,5] } }],
  });
  var router = new core.ModelRouter();
  console.log(router.resolve(bot)); // { engine:'funasr', meta:{...} }
  -------------------------------------------------------------- */
})(typeof window !== 'undefined' ? window : globalThis);
