/**
 * ============================================================
 *  sync-engine.js — 邮箱 / 日历同步引擎（Node 侧，主进程调用）
 * ============================================================
 *  职责：
 *    · CalDAV 日历同步（Apple iCloud 等，Basic 认证）
 *    · 轻量 ICS 解析（无需额外依赖）
 *    · 把远端事件转成秘书 EventStore 的统一事件格式
 *
 *  设计：local-first，凭据由主进程（main.js）用系统钥匙串加密后
 *        传入本模块，本模块不落盘、不打印任何密码。
 * ============================================================
 */
'use strict';

let _dav = null;
function dav() {
  if (!_dav) _dav = require('tsdav');
  return _dav;
}

/* ---------------- ICS 轻量解析 ---------------- */

/** 提取单个属性行（处理 NAME;PARAM=VALUE:value 形式），忽略折叠续行 */
function prop(block, name) {
  const re = new RegExp('(^|\\r?\\n)' + name + '(?:;[^:\\r\\n]*)?:([^\\r\\n]*)');
  const m = block.match(re);
  return m ? m[2].trim() : '';
}

/** 反转义 ICS 的 \n \\ \, \; */
function unescape(s) {
  return String(s || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * 解析 iCal 日期值 → ISO 字符串
 * 支持：UTC（…Z）、本地浮动（带 TZID 或无 Z）、全天（VALUE=DATE）
 */
function parseCalDate(raw) {
  if (!raw) return '';
  let value = String(raw);
  let isDate = false;
  if (value.indexOf(';') >= 0) {
    const parts = value.split(';');
    const params = parts.slice(0, -1).join(';');
    value = parts[parts.length - 1];
    if (/VALUE=DATE/i.test(params)) isDate = true;
  }
  value = value.replace(/^:/, '');
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z?)/);
  if (!m) return '';
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  if (isDate || m[4] == null) {
    return new Date(y, mo, d).toISOString();           // 全天 → 当天本地午夜
  }
  const h = +m[4], mi = +m[5], se = +m[6], isUtc = m[7] === 'Z';
  if (isUtc) return new Date(Date.UTC(y, mo, d, h, mi, se)).toISOString();
  return new Date(y, mo, d, h, mi, se).toISOString();  // 本地浮动（TZID 按本机时区）
}

/** 解析整段 ICS 文本 → 事件数组（含全天/多事件） */
function parseICalendar(ics) {
  const out = [];
  if (!ics) return out;
  const s = String(ics);
  const re = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const b = m[1];
    const title = unescape(prop(b, 'SUMMARY'));
    const at = parseCalDate(prop(b, 'DTSTART'));
    if (!title && !at) continue;
    const end = parseCalDate(prop(b, 'DTEND'));
    const dtStartRaw = ((b.match(/(^|\r?\n)DTSTART[^\r\n]*/) || ['', ''])[0] || '');
    out.push({
      uid: prop(b, 'UID'),
      title: title || '（无标题）',
      at: at,
      end: end,
      location: unescape(prop(b, 'LOCATION')),
      description: unescape(prop(b, 'DESCRIPTION')),
      allDay: /VALUE=DATE/i.test(dtStartRaw),
    });
  }
  return out;
}

/* ---------------- CalDAV 日历同步 ---------------- */

/**
 * 同步一个 CalDAV 账户 → 返回统一事件列表
 * @param {object} account { serverUrl, username, password, authMethod, name }
 * @param {object} opts { lookbackDays, lookaheadDays } 时间窗口
 * @returns {Promise<{ok:boolean, events:Array, calendars:Array, error?:string}>}
 */
async function syncCalendarAccount(account, opts) {
  const o = opts || {};
  const lookback = Number(o.lookbackDays) || 14;   // 回看 14 天
  const lookahead = Number(o.lookaheadDays) || 180; // 前瞻 180 天
  const now = Date.now();
  const minAt = now - lookback * 86400000;
  const maxAt = now + lookahead * 86400000;

  try {
    const authMethod = account.authMethod === 'oauth' ? 'Oauth' : 'Basic';
    const client = await dav().createDAVClient({
      serverUrl: account.serverUrl,
      credentials: {
        username: account.username,
        password: account.password,
      },
      authMethod: authMethod,
      defaultAccountType: 'caldav',
    });

    const calendars = await client.fetchCalendars();
    const events = [];
    const seen = new Set();
    const calendarsInfo = calendars.map((c) => ({
      displayName: String(c.displayName || '').replace(/^['"]|['"]$/g, ''),
      color: c.calendarColor || '',
      url: c.url || '',
    }));

    for (const cal of calendars) {
      let objects;
      try {
        objects = await client.fetchCalendarObjects({ calendar: cal });
      } catch (e) {
        // 单个日历失败不阻断整体，记录到 calendars 里
        calendarsInfo.forEach((ci) => { if (ci.url === cal.url) ci.error = String(e && e.message || e); });
        continue;
      }
      const calName = String(cal.displayName || '').replace(/^['"]|['"]$/g, '') || '日历';
      for (const obj of objects) {
        if (!obj || obj.data == null) continue;
        for (const ev of parseICalendar(obj.data)) {
          if (!ev.at) continue;
          const t = new Date(ev.at).getTime();
          if (!isFinite(t) || t < minAt || t > maxAt) continue;   // 时间窗口过滤
          const key = ev.uid || (ev.title + '|' + ev.at + '|' + calName);
          if (seen.has(key)) continue;
          seen.add(key);
          events.push({
            id: 'cal-' + (ev.uid ? ev.uid : key).replace(/[^a-zA-Z0-9._-]/g, '_'),
            title: ev.title,
            at: ev.at,
            end: ev.end,
            location: ev.location,
            note: (ev.description || '').slice(0, 500),
            source: account.name + ' · ' + calName,
            allDay: !!ev.allDay,
          });
        }
      }
    }

    return { ok: true, events, calendars: calendarsInfo };
  } catch (e) {
    const msg = String(e && e.message || e);
    let friendly = '同步失败：' + msg;
    if (/401|unauthor|forbidden|password|credential|principalUrl|principal/i.test(msg)) {
      friendly = '认证失败：请检查 Apple ID 或「App 专用密码」是否正确（需在 appleid.apple.com 生成，不是 Apple ID 登录密码）。';
    } else if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|fetch failed|ECONNRESET/i.test(msg)) {
      friendly = '网络错误：无法连接日历服务器，请检查网络。';
    }
    return { ok: false, events: [], calendars: [], error: friendly };
  }
}

module.exports = {
  parseICalendar,
  parseCalDate,
  syncCalendarAccount,
};
