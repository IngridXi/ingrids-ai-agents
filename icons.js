/* ============================================================
 * icons.js — 纯色简约线性图标库（Lucide 风格，24×24，stroke=currentColor）
 * 全局暴露：
 *   window.ICONS       { name: innerSVG }
 *   window.iconSvg(name)     -> 完整 <svg> 字符串（继承文字颜色/字号）
 *   window.iconFor(emoji)    -> emoji 映射到图标，未命中回退原 emoji
 * 用法：渲染层把 ${a.emoji} 换成 ${iconFor(a.emoji)} 即可。
 * ============================================================ */
(function () {
  'use strict';

  // ---- 图标集合：每个值是 <svg> 内部内容（不含 <svg> 标签本身） ----
  var ICONS = {
    // 机器人（logo / 默认 Agent）
    bot: '<rect x="4" y="7" width="16" height="11" rx="3"/><path d="M12 7V4"/><circle cx="12" cy="2.6" r="1"/><line x1="9" y1="12.5" x2="9" y2="12.5"/><line x1="15" y1="12.5" x2="15" y2="12.5"/>',

    // 四宫格（技能板块）
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>',

    // 齿轮（引擎设置）
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.7M12 18.8v2.7M2.5 12h2.7M18.8 12h2.7M5.3 5.3l1.9 1.9M16.8 16.8l1.9 1.9M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9"/>',

    // 房子（本机优先）
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/>',

    // 眼睛（监事）
    eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',

    // 羽毛（秘书）
    feather: '<path d="M20.2 12.2a6 6 0 0 0-8.4-8.4L5 10.5V19h8.5z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/>',

    // 麦克风（会议纪要官）
    mic: '<rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5 10.5v1a7 7 0 0 0 14 0v-1"/><line x1="12" x2="12" y1="18.5" y2="21.5"/>',

    // 音符（音乐创作）
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',

    // 罗盘（智能路由 ra）
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5.5-5.5 2 2-5.5z"/>',

    // 调色板（界面设计师 / Design 板块）
    palette: '<path d="M12 2a10 10 0 1 0 0 20c1 0 1.7-.8 1.7-1.7 0-.4-.2-.9-.5-1.2-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H16a6 6 0 0 0 6-6c0-4.4-4.5-8-10-8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/>',

    // 对话气泡（通用助手）
    message: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>',

    // 柱状图（数据分析）
    chart: '<path d="M3 3v18h18"/><path d="M7 16v-5"/><path d="M12 16V8"/><path d="M17 16v-3"/>',

    // 笔（写作助手）
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',

    // 地球（翻译助手）
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',

    // 学位帽（Research 板块 / 研究）
    grad: '<path d="m22 10-10-5L2 10l10 5z"/><path d="M6 12.5V17c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5"/><path d="M22 10v5"/>',

    // 文件夹（板块默认）
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',

    // 滑杆（调度中枢）
    sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',

    // 闪电（预设）
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',

    // 星芒（自动提取 / 魔法）
    sparkles: '<path d="M12 3l1.9 5.1 5.1 1.9-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z"/>',

    // 芯片（Claude Code 引擎）
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',

    // 终端（Codex 引擎）
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',

    // 相机（邮件截图）
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',

    // 链接
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',

    // 日历（日程）
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',

    // 邮件
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',

    // 警告三角（⚠）
    warning: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',

    // 紧急（红圈叹号）
    urgent: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>',

    // 勾选（待办）
    check: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5.5"/>',

    // 纸币（账单/付款）
    money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',

    // 锁（账号/安全）
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',

    // 喇叭（营销）
    megaphone: '<path d="m3 11 15-6v14L3 13z"/><path d="M11.5 18.5a3 3 0 0 0 5.8 1"/><path d="M18 8.5a5 5 0 0 1 0 7"/>',

    // 文件（一般 / 文档）
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',

    // 多人（说话人）
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',

    // 铅笔（笔记）
    pencil: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',

    // 钥匙（API Key）
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',

    // 时钟（提前提醒）
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',

    // 信息（仅参考）
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5"/><path d="M12 8h.01"/>',

    // 烧瓶（研究助手 / 实验）
    flask: '<path d="M10 2v6.3L4.7 17a2 2 0 0 0 1.7 3h11.2a2 2 0 0 0 1.7-3L14 8.3V2"/><path d="M8.5 2h7"/><path d="M7 14h10"/>',

    // 书（知识库）
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',

    // 放大镜（搜索）
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',

    // 发送（纸飞机）
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',

    // 停止（生成中）
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',

    // 用户（人形）
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'
  };

  // ---- emoji → 图标名 映射（key 用 Unicode 转义，绝对精确） ----
  var ICON_MAP = {
    '\u{1F916}': 'bot',      // 🤖
    '\u{1F9E9}': 'grid',     // 🧩
    '\u2699': 'settings',    // ⚙
    '\u{1F3E0}': 'home',     // 🏠
    '\u{1F441}': 'eye',      // 👁
    '\u{1F54A}': 'feather',  // 🕊
    '\u{1F399}': 'mic',      // 🎙
    '\u{1F3B5}': 'music',    // 🎵
    '\u{1F9ED}': 'compass',  // 🧭
    '\u{1F3A8}': 'palette',  // 🎨
    '\u{1F4AC}': 'message',  // 💬
    '\u{1F4CA}': 'chart',    // 📊
    '\u270D': 'pen',         // ✍
    '\u{1F310}': 'globe',    // 🌐
    '\u{1F52C}': 'grad',     // 🔬
    '\u{1F4C1}': 'folder',   // 📁
    '\u{1F39B}': 'sliders',  // 🎛
    '\u26A1': 'zap',         // ⚡
    '\u2728': 'sparkles',    // ✨
    '\u{1F9E0}': 'cpu',      // 🧠
    '\u{1F4BB}': 'terminal', // 💻
    '\u{1F4F7}': 'camera',   // 📷
    '\u{1F517}': 'link',     // 🔗
    '\u{1F4C5}': 'calendar', // 📅
    '\u{1F4E7}': 'mail',     // 📧
    '\u26A0': 'warning',     // ⚠
    '\u{1F534}': 'urgent',   // 🔴
    '\u2705': 'check',       // ✅
    '\u{1F4B0}': 'money',    // 💰
    '\u{1F510}': 'lock',     // 🔐
    '\u{1F4E3}': 'megaphone',// 📣
    '\u{1F4C4}': 'file',     // 📄
    '\u{1F465}': 'users',    // 👥
    '\u{1F4DD}': 'pencil',   // 📝
    '\u{1F511}': 'key',      // 🔑
    '\u23F0': 'clock',       // ⏰
    '\u2139': 'info'         // ℹ
  };

  // 生成完整 <svg>。默认宽度 1em，随父元素 font-size 缩放，颜色继承 currentColor。
  function iconSvg(name) {
    var inner = ICONS[name];
    if (!inner) return '';
    return '<svg class="icon" viewBox="0 0 24 24" width="1em" height="1em" ' +
      'fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true" style="vertical-align:-0.15em">' + inner + '</svg>';
  }

  // emoji → 图标；未命中回退原 emoji（保留信息，不破坏自定义 emoji）。
  function iconFor(emoji) {
    if (!emoji) return '';
    var key = String(emoji).replace(/\uFE0F/g, '').replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
    var name = ICON_MAP[key];
    return name ? iconSvg(name) : emoji;
  }

  window.ICONS = ICONS;
  window.iconSvg = iconSvg;
  window.iconFor = iconFor;
})();
