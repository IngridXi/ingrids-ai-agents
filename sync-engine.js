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

/* ---------------- ICS 生成（写回 CalDAV） ---------------- */

/** 转义 ICS 文本（逗号/分号/换行/反斜杠） */
function icalEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/** ISO 时间字符串 → iCal 时间值；全天 → DATE，否则 → UTC 的 DATE-TIME（带 Z） */
function toICalDate(iso, allDay) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  if (allDay) {
    // 全天：取本地年月日（避免 UTC 换算跨天）
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return y + m + day;
  }
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0'), mi = String(d.getUTCMinutes()).padStart(2, '0'), se = String(d.getUTCSeconds()).padStart(2, '0');
  return y + m + day + 'T' + h + mi + se + 'Z';
}

/** 由统一事件对象生成完整 ICS 文本 */
function eventToICS(ev) {
  const uid = String(ev.uid || ('ingrid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)));
  const now = new Date();
  const stamp = toICalDate(now.toISOString(), false);
  const allDay = !!ev.allDay;
  const dtstart = toICalDate(ev.at, allDay);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ingrid-AI-Agents//Calendar Sync//CN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + stamp,
    'DTSTART' + (allDay ? ';VALUE=DATE:' : ':') + dtstart,
  ];
  if (ev.end) lines.push('DTEND' + (allDay ? ';VALUE=DATE:' : ':') + toICalDate(ev.end, allDay));
  lines.push('SUMMARY:' + icalEscape(ev.title || '（无标题）'));
  if (ev.location) lines.push('LOCATION:' + icalEscape(ev.location));
  if (ev.note || ev.description) lines.push('DESCRIPTION:' + icalEscape(ev.note || ev.description));
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/** 选一个「主日历」：优先名字形如「日历/Calendar」的非共享/订阅日历 */
function pickMainCalendar(calendars) {
  const list = calendars || [];
  if (!list.length) return null;
  const preferred = list.find((c) => {
    const n = String(c.displayName || '').replace(/^['"]|['"]$/g, '');
    return /(^|\s)(日历|Calendar)(\s|$)/i.test(n) && !/家庭|家人|Family|Shared|订阅|Birthday/i.test(n);
  });
  return preferred || list[0];
}

/**
 * 写回一条日程到 CalDAV（新建，手机/苹果日历可看到）
 * @param {object} account 解密后的账户（含明文 password）
 * @param {object} ev { title, at, end, location, note, allDay, uid? }
 * @returns {Promise<{ok:boolean, uid?:string, calendar?:string, error?:string}>}
 */
async function pushCalendarEvent(account, ev) {
  try {
    const authMethod = account.authMethod === 'oauth' ? 'Oauth' : 'Basic';
    const client = await dav().createDAVClient({
      serverUrl: account.serverUrl,
      credentials: { username: account.username, password: account.password },
      authMethod: authMethod,
      defaultAccountType: 'caldav',
    });
    const calendars = await client.fetchCalendars();
    if (!calendars || !calendars.length) return { ok: false, error: '该账户下没有可写入的日历' };
    const cal = pickMainCalendar(calendars);
    const iCalString = eventToICS(ev);
    const uid = String(ev.uid || (iCalString.match(/UID:([^\r\n]+)/) || [])[1] || 'ingrid-' + Date.now());
    await client.createCalendarObject({ calendar: cal, iCalString: iCalString, filename: uid + '.ics' });
    return { ok: true, uid: uid, calendar: String(cal.displayName || '').replace(/^['"]|['"]$/g, '') };
  } catch (e) {
    const msg = String(e && e.message || e);
    let friendly = '写回失败：' + msg;
    if (/401|unauthor|forbidden|password|credential|principal/i.test(msg)) friendly = '认证失败：请检查账户密码/授权码。';
    else if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|fetch failed/i.test(msg)) friendly = '网络错误：无法连接日历服务器。';
    return { ok: false, error: friendly };
  }
}

/* ---------------- OAuth2（Google / Microsoft） ---------------- */

const OAUTH_PROVIDERS = {
  google: {
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/calendar',
  },
  microsoft: {
    label: 'Microsoft',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Mail.Read offline_access',
  },
};

/** 构造 OAuth 授权 URL（含 offline/consent 以拿到 refresh_token） */
function buildOAuthUrl(provider, clientId, redirectUri, state) {
  const p = OAUTH_PROVIDERS[provider];
  if (!p) throw new Error('未知 OAuth 提供方：' + provider);
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scope,
    access_type: 'offline',
    prompt: 'consent',
    state: state || 'ingrid',
  });
  return p.authUrl + '?' + q.toString();
}

/** 用授权码换取 tokens（返回 access_token / refresh_token 等） */
async function exchangeOAuthCode(provider, clientId, clientSecret, redirectUri, code) {
  const p = OAUTH_PROVIDERS[provider];
  if (!p) throw new Error('未知 OAuth 提供方：' + provider);
  return dav().fetchOauthTokens({
    authorizationCode: code, redirectUrl: redirectUri, clientId: clientId, clientSecret: clientSecret, tokenUrl: p.tokenUrl,
  });
}

/** 用 refresh_token 刷新 access_token */
async function refreshOAuthToken(provider, clientId, clientSecret, refreshToken) {
  const p = OAUTH_PROVIDERS[provider];
  if (!p) throw new Error('未知 OAuth 提供方：' + provider);
  return dav().refreshAccessToken({ refreshToken: refreshToken, clientId: clientId, clientSecret: clientSecret, tokenUrl: p.tokenUrl });
}

/* ---------------- Google Calendar API v3（OAuth Bearer） ---------------- */

async function syncGoogleCalendar(accessToken, opts) {
  const o = opts || {};
  const lookback = Number(o.lookbackDays) || 14, lookahead = Number(o.lookaheadDays) || 180;
  const now = Date.now();
  const minT = new Date(now - lookback * 86400000).toISOString();
  const maxT = new Date(now + lookahead * 86400000).toISOString();
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=' +
    encodeURIComponent(minT) + '&timeMax=' + encodeURIComponent(maxT) + '&maxResults=2500';
  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!resp.ok) {
    const msg = 'Google 日历请求失败 HTTP ' + resp.status;
    if (resp.status === 401) throw new Error('认证已过期：' + msg);
    throw new Error(msg);
  }
  const j = await resp.json();
  const events = [];
  for (const it of (j.items || [])) {
    const allDay = !!(it.start && it.start.date && !it.start.dateTime);
    const at = allDay ? new Date(it.start.date + 'T00:00:00').toISOString() : new Date(it.start.dateTime).toISOString();
    if (isNaN(Date.parse(at))) continue;
    const end = (!allDay && it.end && it.end.dateTime) ? new Date(it.end.dateTime).toISOString() : '';
    events.push({
      id: 'gcal-' + String(it.id || it.iCalUID || Date.now()),
      title: it.summary || '（无标题）', at: at, end: end,
      location: it.location || '', note: (it.description || '').slice(0, 500),
      source: 'Google 日历', allDay: allDay,
    });
  }
  return { ok: true, events: events, calendars: [{ displayName: 'Google 日历', url: '' }] };
}

/* ---------------- Microsoft Graph（OAuth Bearer） ---------------- */

async function syncMicrosoftCalendar(accessToken, opts) {
  const o = opts || {};
  const lookback = Number(o.lookbackDays) || 14, lookahead = Number(o.lookaheadDays) || 180;
  const now = Date.now();
  const minT = new Date(now - lookback * 86400000).toISOString();
  const maxT = new Date(now + lookahead * 86400000).toISOString();
  const url = 'https://graph.microsoft.com/v1.0/me/events?$select=id,subject,start,end,location,bodyPreview&$top=1000&startDateTime=' +
    encodeURIComponent(minT) + '&endDateTime=' + encodeURIComponent(maxT);
  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!resp.ok) {
    const msg = 'Outlook 日历请求失败 HTTP ' + resp.status;
    if (resp.status === 401) throw new Error('认证已过期：' + msg);
    throw new Error(msg);
  }
  const j = await resp.json();
  const events = [];
  for (const it of (j.value || [])) {
    const allDay = !!(it.start && it.start.date && !it.start.dateTime);
    const at = allDay ? new Date(it.start.date + 'T00:00:00').toISOString() : new Date(it.start.dateTime).toISOString();
    if (isNaN(Date.parse(at))) continue;
    const end = (!allDay && it.end && it.end.dateTime) ? new Date(it.end.dateTime).toISOString() : '';
    events.push({
      id: 'ms-' + String(it.id || Date.now()),
      title: it.subject || '（无标题）', at: at, end: end,
      location: (it.location && it.location.displayName) || '', note: (it.bodyPreview || '').slice(0, 500),
      source: 'Outlook 日历', allDay: allDay,
    });
  }
  return { ok: true, events: events, calendars: [{ displayName: 'Outlook 日历', url: '' }] };
}

/* ---------------- Microsoft Graph 邮件（Outlook 邮箱） ---------------- */

async function syncMicrosoftMail(accessToken, opts) {
  const o = opts || {};
  const top = Math.min(Number(o.top) || 50, 200);
  const url = 'https://graph.microsoft.com/v1.0/me/messages?$select=id,from,subject,bodyPreview,receivedDateTime,isRead&$top=' +
    top + '&$orderby=receivedDateTime%20desc';
  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!resp.ok) {
    const msg = 'Outlook 邮箱请求失败 HTTP ' + resp.status;
    if (resp.status === 401) throw new Error('认证已过期：' + msg);
    throw new Error(msg);
  }
  const j = await resp.json();
  const emails = [];
  for (const it of (j.value || [])) {
    emails.push({
      id: 'msmail-' + String(it.id || Date.now()),
      from: (it.from && it.from.emailAddress && it.from.emailAddress.address) || '',
      fromName: (it.from && it.from.emailAddress && it.from.emailAddress.name) || '',
      subject: it.subject || '（无主题）',
      body: (it.bodyPreview || '').slice(0, 500),
      at: it.receivedDateTime || '',
      read: !!it.isRead,
      link: 'https://outlook.office.com/mail/',
      source: 'Outlook 邮箱',
    });
  }
  return { ok: true, emails: emails };
}

module.exports = {
  parseICalendar,
  parseCalDate,
  syncCalendarAccount,
  eventToICS,
  toICalDate,
  pushCalendarEvent,
  OAUTH_PROVIDERS,
  buildOAuthUrl,
  exchangeOAuthCode,
  refreshOAuthToken,
  syncGoogleCalendar,
  syncMicrosoftCalendar,
  syncMicrosoftMail,
};
