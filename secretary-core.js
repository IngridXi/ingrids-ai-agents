/**
 * ============================================================
 *  secretary-core.js — 秘书 Agent（零依赖）
 *  ============================================================
 *
 *  借鉴开源项目（Apache 2.0 / 可借鉴模式）：
 *    · kylem148/secretary-agent   —— 日历规则、邮件→排期、截图、动作前确认
 *    · lucasantoro97/postino      —— IMAP 读信→分类归档→日历事件→晨间简报
 *    · Harrydi2006/mail-analyzer  —— 邮件提取事件（时间/地点/标题）、三级重要度、
 *                                    自动入日历、提前 3 天/1 天/1 小时提醒
 *    · daddia/my-assistant        —— 收件箱分类（重要/需回复/仅参考/营销）
 *
 *  核心对象（local-first，数据存本机）：
 *    EventStore    日程：增删查 + 即将到来 + 提醒
 *    EmailStore    邮件：导入 + 自动分类分级
 *    ThoughtStore  想法：随时记下，之后可分配给合适的 Agent
 *    classifyEmail 邮件分类（关键词启发式，免费、可解释）
 *    extractEventHint  从文字里猜事件标题/日期（启发式，供确认表单预填）
 *    brief         晨间简报：今天日程 + 重要未读邮件 + 待办
 *
 *  零依赖。浏览器 <script src>；Node require() 后取 globalThis.SecretaryCore。
 * ============================================================
 */
(function (global) {
  'use strict';

  /* ---------- 通用存储 ---------- */
  function defaultStorage(key, fallback) {
    return {
      load: function () {
        try { var r = global.localStorage.getItem(key); return r ? JSON.parse(r) : fallback; }
        catch (e) { return fallback; }
      },
      save: function (data) { try { global.localStorage.setItem(key, JSON.stringify(data)); } catch (e) {} },
    };
  }
  function uid(p) { return (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ---------- 1. EventStore：日程 ---------- */
  function normalizeEvent(e) {
    return {
      id: String(e.id || ''),
      title: String(e.title || ''),
      at: String(e.at || ''),                 // ISO 起止时间
      end: String(e.end || ''),
      location: String(e.location || ''),
      link: String(e.link || ''),             // 来源链接（如原邮件）
      source: String(e.source || ''),         // 来源说明（如「邮件截图」）
      note: String(e.note || ''),
      reminderMin: Number(e.reminderMin) || 0,// 提前提醒分钟数（0=不提醒）
      reminded: !!e.reminded,                 // 是否已提醒过
      done: !!e.done,
      createdAt: Number(e.createdAt) || Date.now(),
    };
  }
  function EventStore(storage) {
    this.storage = storage || defaultStorage('ingrid.secretary.events', []);
    this.events = (this.storage.load() || []).map(normalizeEvent);
  }
  EventStore.prototype._save = function () { try { this.storage.save(this.events); } catch (e) {} return this; };
  EventStore.prototype.list = function () {
    return this.events.slice().sort(function (a, b) {
      return (a.at || '9').localeCompare(b.at || '9');
    });
  };
  EventStore.prototype.add = function (e) {
    var ev = normalizeEvent(Object.assign({ id: uid('e') }, e || {}));
    this.events.push(ev); this._save(); return ev;
  };
  EventStore.prototype.get = function (id) {
    for (var i = 0; i < this.events.length; i++) if (this.events[i].id === id) return this.events[i];
    return null;
  };
  EventStore.prototype.update = function (id, patch) {
    var ev = this.get(id); if (!ev) return null;
    Object.assign(ev, patch || {}); this._save(); return ev;
  };
  EventStore.prototype.remove = function (id) {
    this.events = this.events.filter(function (e) { return e.id !== id; });
    this._save(); return this;
  };
  /** 即将到来的事件（含今天之后，已过的不算） */
  EventStore.prototype.upcoming = function (now) {
    var n = (now || Date.now());
    return this.list().filter(function (e) { return !e.done && new Date(e.at).getTime() >= n; });
  };
  /** 需要提醒但现在还没提醒的事件：{ id, title, at, note }[] */
  EventStore.prototype.dueReminders = function (now) {
    var n = now || Date.now();
    return this.list().filter(function (e) {
      if (e.done || e.reminded || !e.at || !e.reminderMin) return false;
      var at = new Date(e.at).getTime();
      if (!isFinite(at)) return false;
      return n >= at - e.reminderMin * 60000;
    });
  };

  /* ---------- 2. EmailStore：邮件 ---------- */
  function normalizeEmail(e) {
    return {
      id: String(e.id || ''),
      from: String(e.from || ''),
      subject: String(e.subject || '（无主题）'),
      body: String(e.body || ''),
      at: String(e.at || ''),                 // ISO 或任意时间串
      link: String(e.link || ''),
      category: String(e.category || 'general'),
      importance: Number(e.importance) || 0,  // 0 营销 1 普通 2 需关注 3 重要
      important: !!e.important,
      read: !!e.read,
      createdAt: Number(e.createdAt) || Date.now(),
    };
  }
  function EmailStore(storage) {
    this.storage = storage || defaultStorage('ingrid.secretary.emails', []);
    this.emails = (this.storage.load() || []).map(normalizeEmail);
  }
  EmailStore.prototype._save = function () { try { this.storage.save(this.emails); } catch (e) {} return this; };
  EmailStore.prototype.list = function () {
    return this.emails.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  };
  EmailStore.prototype.add = function (e) {
    var m = normalizeEmail(Object.assign({ id: uid('m') }, e || {}));
    var c = classifyEmail(m);
    m.category = c.category; m.importance = c.importance; m.important = c.important;
    this.emails.push(m); this._save(); return m;
  };
  EmailStore.prototype.get = function (id) {
    for (var i = 0; i < this.emails.length; i++) if (this.emails[i].id === id) return this.emails[i];
    return null;
  };
  EmailStore.prototype.update = function (id, patch) {
    var m = this.get(id); if (!m) return null;
    Object.assign(m, patch || {}); this._save(); return m;
  };
  EmailStore.prototype.remove = function (id) {
    this.emails = this.emails.filter(function (e) { return e.id !== id; });
    this._save(); return this;
  };
  EmailStore.prototype.importantUnread = function () {
    return this.emails.filter(function (m) { return m.important && !m.read; });
  };

  /* ---------- 3. ThoughtStore：想法 ---------- */
  function ThoughtStore(storage) {
    this.storage = storage || defaultStorage('ingrid.secretary.thoughts', []);
    this.thoughts = (this.storage.load() || []).map(function (t) {
      return { id: String(t.id || ''), text: String(t.text || ''), at: Number(t.at) || Date.now(),
        status: String(t.status || 'new'), assignedTo: String(t.assignedTo || '') };
    });
  }
  ThoughtStore.prototype._save = function () { try { this.storage.save(this.thoughts); } catch (e) {} return this; };
  ThoughtStore.prototype.list = function () { return this.thoughts.slice().reverse(); };
  ThoughtStore.prototype.add = function (text) {
    var t = { id: uid('t'), text: String(text || ''), at: Date.now(), status: 'new', assignedTo: '' };
    this.thoughts.push(t); this._save(); return t;
  };
  ThoughtStore.prototype.update = function (id, patch) {
    for (var i = 0; i < this.thoughts.length; i++) if (this.thoughts[i].id === id) {
      Object.assign(this.thoughts[i], patch || {}); this._save(); return this.thoughts[i];
    }
    return null;
  };
  ThoughtStore.prototype.remove = function (id) {
    this.thoughts = this.thoughts.filter(function (t) { return t.id !== id; });
    this._save(); return this;
  };

  /* ---------- 4. 邮件分类（关键词启发式） ---------- */
  var CATEGORY_RULES = [
    { cat: 'urgent', label: '🔴 重要紧急', words: ['紧急','立即','马上','尽快','务必','最后期限','deadline','截止','逾期','催','逾期未','必须今天','加急','asap','urgent'] },
    { cat: 'meeting', label: '📅 会议/邀请', words: ['会议','邀请','参会','zoom','teams','腾讯会议','议程','议程安排','schedule','invite','会议纪要','线上会议'] },
    { cat: 'reply', label: '✍️ 需回复', words: ['请回复','请确认','请告知','麻烦您','等你','期待回复','rsvp','请尽快回复','请审阅','请批准'] },
    { cat: 'todo', label: '✅ 待办', words: ['待办','任务','行动项','请处理','请完成','跟进','todo','action item','请协助'] },
    { cat: 'money', label: '💰 账单/付款', words: ['账单','发票','付款','支付','扣款','退款','缴费','invoice','payment','账单到期','续费','订阅'] },
    { cat: 'security', label: '🔐 账号/安全', words: ['验证码','登录','密码','安全','验证','异地登录','账号','找回','authenticate','verification'] },
    { cat: 'info', label: 'ℹ️ 仅参考', words: ['简报','newsletter','订阅','周报','月报','摘要','通知','公告','资讯','news','更新日志'] },
    { cat: 'marketing', label: '📣 营销', words: ['促销','优惠','折扣','广告','推广','营销','退订','unsubscribe','限时','特价','活动报名','免费领取'] },
  ];
  var IMPORTANCE = { urgent: 3, security: 3, money: 2, meeting: 2, reply: 2, todo: 2, info: 1, marketing: 0, general: 1 };

  function classifyEmail(email) {
    var blob = String(email.from || '') + ' ' + String(email.subject || '') + ' ' + String(email.body || '').slice(0, 1500);
    var t = blob.toLowerCase();
    var best = 'general', hit = 0, hits = [];
    CATEGORY_RULES.forEach(function (r) {
      var n = 0, hh = [];
      r.words.forEach(function (w) { if (w && t.indexOf(w.toLowerCase()) >= 0) { n++; hh.push(w); } });
      if (n > hit) { hit = n; best = r.cat; hits = hh; }
    });
    var imp = IMPORTANCE[best] != null ? IMPORTANCE[best] : 1;
    // 发件人含官方/银行/学校/公司域名也略升重要度
    if (/(gov\.|edu\.|bank|paypal|apple\.com|google\.com|学校|银行|财务|hr|人事)/i.test(String(email.from || ''))) imp = Math.max(imp, 2);
    return { category: best, importance: imp, important: imp >= 2, hits: hits };
  }
  function categoryLabel(cat) {
    for (var i = 0; i < CATEGORY_RULES.length; i++) if (CATEGORY_RULES[i].cat === cat) return CATEGORY_RULES[i].label;
    return '📄 一般';
  }

  /* ---------- 5. 从文字提取事件提示（启发式预填） ---------- */
  function extractEventHint(text, now) {
    var src = String(text || '');
    var out = { title: '', dateText: '', timeText: '' };
    // 标题：第一行非空
    var first = src.split(/\r?\n/).filter(function (l) { return l.trim(); })[0] || '';
    out.title = first.trim().slice(0, 60);
    // 日期
    var d = null;
    var m;
    if (/(今天|今日)/.test(src)) d = new Date(now || Date.now());
    else if (/明天|明日/.test(src)) { d = new Date(now || Date.now()); d.setDate(d.getDate() + 1); out.dateText = '明天'; }
    else if (/后天/.test(src)) { d = new Date(now || Date.now()); d.setDate(d.getDate() + 2); out.dateText = '后天'; }
    else if (m = src.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/)) {
      d = new Date((now || new Date()).getFullYear(), Number(m[1]) - 1, Number(m[2])); out.dateText = m[1] + '月' + m[2] + '日';
    }
    else if (m = src.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)) {
      d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); out.dateText = m[1] + '-' + m[2] + '-' + m[3];
    }
    else if (m = src.match(/(\d{1,2})[-\/](\d{1,2})/)) {
      d = new Date((now || new Date()).getFullYear(), Number(m[1]) - 1, Number(m[2])); out.dateText = m[1] + '月' + m[2] + '日';
    }
    // 时间
    if (m = src.match(/(\d{1,2})[:：](\d{1,2})/)) {
      out.timeText = m[1] + ':' + m[2];
      if (d) { d.setHours(Number(m[1]), Number(m[2]), 0, 0); }
    } else if (m = src.match(/(上午|下午|晚上)\s*(\d{1,2})\s*点/)) {
      var hh = Number(m[2]);
      if (m[1] === '下午' || m[1] === '晚上') hh = (hh % 12) + 12;
      out.timeText = hh + ':00';
      if (d) d.setHours(hh, 0, 0, 0);
    }
    if (d && isFinite(d.getTime())) out.at = d.toISOString();
    // 链接
    if (m = src.match(/https?:\/\/[^\s"'<>]+/)) out.link = m[0];
    return out;
  }

  /* ---------- 6. 晨间简报 ---------- */
  function brief(events, emails, now) {
    var n = now || Date.now();
    var today = new Date(n).toDateString();
    var upcoming = (events.list ? events.list() : events).filter(function (e) {
      return !e.done && new Date(e.at).getTime() >= n;
    });
    var todayEvents = upcoming.filter(function (e) { return new Date(e.at).toDateString() === today; });
    var important = (emails.importantUnread ? emails.importantUnread() : emails).filter(function (m) { return m.important; });
    return { todayEvents: todayEvents, upcoming: upcoming.slice(0, 6), importantEmails: important.slice(0, 6) };
  }

  /* ---------- 导出 ---------- */
  global.SecretaryCore = {
    EventStore: EventStore,
    EmailStore: EmailStore,
    ThoughtStore: ThoughtStore,
    classifyEmail: classifyEmail,
    categoryLabel: categoryLabel,
    extractEventHint: extractEventHint,
    brief: brief,
    CATEGORY_RULES: CATEGORY_RULES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
