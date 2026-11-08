/* 会议纪要官：实时转写 + 说话人识别 + 笔记 + AI 总结 + 纪要 + PPT（纯前端，本机服务） */
(function () {
  'use strict';
  var API = (window.MEETING_AUDIO_API || 'http://127.0.0.1:8950').replace(/\/$/, '');
  var WS_URL = 'ws://127.0.0.1:8951/realtime';

  var el = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var fmtTs = function (s) { var m = Math.floor(s / 60), ss = Math.floor(s % 60); return (m < 10 ? '0' + m : m) + ':' + (ss < 10 ? '0' + ss : ss); };

  function setStatus(node, msg, cls) { node.textContent = msg || ''; node.className = 'status' + (cls ? ' ' + cls : ''); }
  function busy(btn, on, label) {
    if (on) {
      if (btn.dataset.origHtml === undefined) btn.dataset.origHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> ' + label;
    } else {
      btn.disabled = false;
      if (btn.dataset.origHtml !== undefined) { btn.innerHTML = btn.dataset.origHtml; delete btn.dataset.origHtml; }
    }
  }

  /* ============ 实时录音状态 ============ */
  var audioCtx = null, processor = null, micStream = null, ws = null;
  var pcmChunks = [], pcmTotal = 0, recSeconds = 0, recTimer = null, recording = false;
  var labelMap = {};            // 说话人临时标签 -> 姓名
  var transcriptAccum = '';     // 实时累计转写（供 AI 总结）
  var finalResult = null;       // 结束后的精确转写结果
  var minutesMd = '';

  function floatToInt16(f32) {
    var out = new Int16Array(f32.length);
    for (var i = 0; i < f32.length; i++) { var s = Math.max(-1, Math.min(1, f32[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return out;
  }
  function resampleLinear(input, from, to) {
    if (from === to) return input;
    var ratio = from / to, outLen = Math.floor(input.length / ratio), out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) { var pos = i * ratio, idx = Math.floor(pos), f = pos - idx; var a = input[idx], b = input[Math.min(idx + 1, input.length - 1)]; out[i] = a + (b - a) * f; }
    return out;
  }
  function floatToWav(f32, sr) {
    var blockAlign = 2, dataSize = f32.length * blockAlign;
    var ab = new ArrayBuffer(44 + dataSize), view = new DataView(ab);
    function wstr(o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
    wstr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sr, true); view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
    wstr(36, 'data'); view.setUint32(40, dataSize, true);
    for (var i = 0; i < f32.length; i++) { var s = Math.max(-1, Math.min(1, f32[i])); view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([ab], { type: 'audio/wav' });
  }

  /* ============ 实时录音：采集 + WebSocket ============ */
  function startLive() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setStatus(el('status'), '当前浏览器不支持录音，请用 Chrome / Edge / Safari 并允许麦克风权限', 'err'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      micStream = stream;
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 }); }
      catch (e) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      var source = audioCtx.createMediaStreamSource(stream);
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      pcmChunks = []; pcmTotal = 0; transcriptAccum = ''; labelMap = {};
      el('live-list').innerHTML = ''; el('live-transcript').classList.remove('hidden');
      el('summary-box').classList.add('hidden'); el('summary-text').textContent = '';

      processor.onaudioprocess = function (e) {
        var input = e.inputBuffer.getChannelData(0);
        var output = e.outputBuffer.getChannelData(0);
        for (var i = 0; i < output.length; i++) output[i] = 0; // 静音输出，避免回声
        var pcm = resampleLinear(input, audioCtx.sampleRate, 16000);
        pcmChunks.push(pcm.slice(0)); pcmTotal += pcm.length;
        if (ws && ws.readyState === 1) ws.send(floatToInt16(pcm).buffer);
      };
      source.connect(processor); processor.connect(audioCtx.destination);

      openWs();
      recording = true;
      recSeconds = 0;
      el('btn-rec').classList.add('on');
      el('rec-label').textContent = '结束会议录音';
      el('rec-timer').classList.remove('hidden');
      el('rec-timer').textContent = '00:00';
      el('btn-summary').disabled = false;
      el('btn-minutes').disabled = true; el('btn-ppt').disabled = true;
      recTimer = setInterval(function () { recSeconds++; el('rec-timer').textContent = fmtTs(recSeconds); }, 1000);
      setStatus(el('status'), '正在实时转写…（首次需加载模型，稍等）');
    }).catch(function () { setStatus(el('status'), '无法访问麦克风，请检查浏览器权限', 'err'); });
  }

  function openWs() {
    try { ws = new WebSocket(WS_URL); } catch (e) { ws = null; setStatus(el('status'), '无法连接实时服务（' + WS_URL + '）', 'err'); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () { setStatus(el('status'), '实时服务已连接，开始说话吧', 'ok'); };
    ws.onmessage = function (ev) {
      var msg = JSON.parse(ev.data);
      if (msg.type === 'ready') { setStatus(el('status'), '实时转写就绪，开始说话吧', 'ok'); }
      else if (msg.type === 'turn') { onTurn(msg); }
      else if (msg.type === 'done') { setStatus(el('status'), '实时转写结束', 'ok'); }
    };
    ws.onerror = function () { setStatus(el('status'), '实时服务连接出错', 'err'); };
    ws.onclose = function () { /* 静默 */ };
  }

  function onTurn(turn) {
    var label = turn.matched ? turn.speaker_name : turn.speaker_label;
    var name = labelMap[label] || label;
    transcriptAccum += name + '：' + turn.text + '。';
    var list = el('live-list');
    var line = document.createElement('div');
    line.className = 'spk-line';
    line.setAttribute('data-label', label);
    var matched = turn.matched || !!labelMap[label];
    var nameHtml = esc(name) + (matched ? '<span class="spk-badge">已识别</span>' : '');
    if (!matched && turn.segment_id) {
      nameHtml += '<button class="spk-name-btn" data-seg="' + turn.segment_id + '" data-label="' + esc(label) + '">命名</button>';
    }
    line.innerHTML = '<div class="who"><div class="name ' + (matched ? 'matched' : 'unknown') + '">' + nameHtml + '</div>' +
      '<div class="ts">' + fmtTs(turn.start) + ' – ' + fmtTs(turn.end) + '</div></div>' +
      '<div class="text">' + esc(turn.text) + '</div>';
    list.appendChild(line);
    el('live-transcript').scrollTop = el('live-transcript').scrollHeight;
    if (!matched && turn.segment_id) {
      line.querySelector('.spk-name-btn').addEventListener('click', function () { promptName(this); });
    }
  }

  function promptName(btn) {
    var segId = btn.getAttribute('data-seg'), label = btn.getAttribute('data-label');
    var box = document.createElement('span');
    box.className = 'spk-name-inline';
    box.innerHTML = '<input type="text" placeholder="输入姓名"><button>确认</button>';
    btn.parentNode.replaceChild(box, btn);
    var input = box.querySelector('input'); input.focus();
    function submit() {
      var name = input.value.trim();
      if (!name) { box.parentNode.replaceChild(btn, box); return; }
      fetch(API + '/enroll-segment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segment_id: segId, name: name }) })
        .then(function (r) { return r.json(); }).then(function (j) {
          if (!j.ok && j.error) throw new Error(j.error);
          labelMap[label] = name;
          document.querySelectorAll('.spk-line[data-label="' + CSS.escape(label) + '"]').forEach(function (ln) {
            var nm = ln.querySelector('.name');
            nm.innerHTML = esc(name) + '<span class="spk-badge">已识别</span>';
            nm.className = 'name matched';
          });
          loadSpeakers();
          setStatus(el('status'), '已把「' + label + '」命名为「' + name + '」，之后会自动认出', 'ok');
        }).catch(function (e) { setStatus(el('status'), '命名失败：' + e.message, 'err'); box.parentNode.replaceChild(btn, box); });
    }
    box.querySelector('button').addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  }

  function stopLive() {
    recording = false;
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
    if (processor) { try { processor.disconnect(); } catch (e) {} processor = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
    if (ws) { try { ws.send(JSON.stringify({ type: 'stop' })); ws.close(); } catch (e) {} ws = null; }
    el('btn-rec').classList.remove('on');
    el('rec-label').textContent = '开始会议录音';
    el('rec-timer').classList.add('hidden');
    el('btn-summary').disabled = true;
    setStatus(el('status'), '正在做最终精确转写…');
    var total = new Float32Array(pcmTotal), off = 0;
    pcmChunks.forEach(function (c) { total.set(c, off); off += c.length; });
    if (total.length < 16000) { setStatus(el('status'), '录音过短，未生成结果', 'err'); return; }
    var wav = floatToWav(total, 16000);
    postAudio('/transcribe?denoise=1', wav).then(function (j) {
      finalResult = j.result;
      renderFinalResult(j.result);
      el('btn-minutes').disabled = false;
      setStatus(el('status'), '最终转写完成，可生成会议纪要', 'ok');
    }).catch(function (e) { setStatus(el('status'), '最终转写失败：' + e.message, 'err'); });
  }

  function renderFinalResult(result) {
    var box = el('final-result');
    box.classList.remove('hidden');
    var html = '<hr class="divider"><h2 style="font-size:16px;color:var(--deep)">最终转写结果</h2>';
    (result.segments || []).forEach(function (s) {
      var name = s.speaker_name || ('说话人 ' + (s.spk >= 0 ? (s.spk + 1) : '?'));
      var cls = s.speaker_name ? 'matched' : 'unknown';
      html += '<div class="spk-line"><div class="who"><div class="name ' + cls + '">' + esc(name) + '</div>' +
        '<div class="ts">' + fmtTs(s.start) + ' – ' + fmtTs(s.end) + '</div></div>' +
        '<div class="text">' + esc(s.text) + '</div></div>';
    });
    box.innerHTML = html;
  }

  /* ============ 通用上传/请求 ============ */
  function postAudio(path, blob) {
    return fetch(API + path, { method: 'POST', body: blob }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    });
  }
  function postJson(path, data) {
    return fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    });
  }

  function healthCheck(attempt) {
    attempt = attempt || 0;
    fetch(API + '/health').then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) {
        if (j.realtime_port) WS_URL = 'ws://127.0.0.1:' + j.realtime_port + '/realtime';
        setStatus(el('status'), '本机会议录音服务已就绪');
        loadSpeakers();
      } else retry();
    }).catch(retry);
    function retry() {
      if (attempt < 5) {
        setStatus(el('status'), '正在启动本机会议录音服务…', 'warn');
        setTimeout(function () { healthCheck(attempt + 1); }, 600);
      } else {
        setStatus(el('status'), '会议录音服务未能启动：请检查 extensions/meeting_audio/server.log', 'err');
      }
    }
  }

  /* ============ 总结引擎选择 ============ */
  var API_ENGINE_META = [
    { id: 'deepseek', name: 'DeepSeek', tag: 'API · 中文强 · 高性价比' },
    { id: 'gpt', name: 'GPT', tag: 'API · OpenAI' },
    { id: 'qwen', name: 'Qwen', tag: 'API · 通义千问' }
  ];
  var currentEngine = 'ollama';

  function updateEngineHint() {
    var hint = el('engine-hint'), v = el('summary-engine').value;
    if (v === 'ollama') {
      hint.textContent = '本地 Ollama（qwen3:32b）总结，内容不上云';
      hint.className = 'eb-hint ok';
    } else {
      var m = API_ENGINE_META.filter(function (x) { return x.id === v; })[0];
      hint.textContent = (m ? m.name : v) + ' · 云端 API 按 token 计费（Key 由主程序注入，不经过页面）';
      hint.className = 'eb-hint warn';
    }
  }

  function initEngineSelect() {
    var sel = el('summary-engine');
    if (!sel) return;
    sel.addEventListener('change', function () {
      currentEngine = sel.value;
      updateEngineHint();
    });
    if (!window.ingrid || !window.ingrid.getSettings) { updateEngineHint(); return; }
    window.ingrid.getSettings().then(function (s) {
      s = s || {};
      API_ENGINE_META.forEach(function (m) {
        if (s[m.id]) {
          var opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name + ' · ' + m.tag;
          sel.appendChild(opt);
        }
      });
      updateEngineHint();
    }).catch(function () { updateEngineHint(); });
  }

  /* ============ 笔记：本地自动保存 ============ */
  function saveNotes() { try { localStorage.setItem('meeting_audio_notes', el('notes').value); setStatus(el('notes-status'), '已自动保存到本机', 'ok'); } catch (e) {} }
  function restoreNotes() { try { var v = localStorage.getItem('meeting_audio_notes'); if (v) el('notes').value = v; } catch (e) {} }
  el('notes').addEventListener('input', function () { clearTimeout(el('notes')._t); el('notes')._t = setTimeout(saveNotes, 500); });

  /* ============ AI 总结 / 纪要 / PPT ============ */
  function doSummary() {
    var btn = el('btn-summary'); busy(btn, true, '总结中');
    postJson('/summary', { transcript: transcriptAccum, notes: el('notes').value, engine: currentEngine }).then(function (j) {
      el('summary-box').classList.remove('hidden');
      el('summary-text').textContent = j.summary;
      setStatus(el('summary-status'), '已生成实时总结', 'ok');
    }).catch(function (e) { setStatus(el('summary-status'), '总结失败：' + e.message, 'err'); }).finally(function () { busy(btn, false, 'AI 实时总结'); });
  }

  function buildTranscriptText(result) {
    var lines = [];
    (result.segments || []).forEach(function (s) {
      var name = s.speaker_name || ('说话人 ' + (s.spk >= 0 ? (s.spk + 1) : '?'));
      lines.push(name + '：' + s.text);
    });
    return lines.join('\n');
  }

  function doMinutes() {
    var btn = el('btn-minutes'); busy(btn, true, '生成中');
    var transcript = finalResult ? buildTranscriptText(finalResult) : transcriptAccum.replace(/。/g, '。\n');
    postJson('/minutes', { transcript: transcript, notes: el('notes').value, speakers: finalResult ? finalResult.speakers : [], engine: currentEngine })
      .then(function (j) {
        minutesMd = j.minutes;
        el('minutes-result').classList.remove('hidden');
        el('minutes-result').innerHTML = renderMarkdown(j.minutes);
        el('btn-ppt').disabled = false;
        setStatus(el('minutes-status'), '会议纪要已生成，可导出 PPT', 'ok');
      }).catch(function (e) { setStatus(el('minutes-status'), '纪要生成失败：' + e.message, 'err'); })
      .finally(function () { busy(btn, false, '生成会议纪要'); });
  }

  function doPpt() {
    if (!minutesMd) return;
    var btn = el('btn-ppt'); busy(btn, true, '生成中');
    postJson('/ppt', { minutes: minutesMd, title: el('meeting-title').value || '会议纪要' })
      .then(function (j) {
        var url = API + (j.url || ('/download/' + j.file));
        el('ppt-download').classList.remove('hidden');
        el('ppt-download').setAttribute('href', url);
        el('ppt-download').setAttribute('download', j.file || 'meeting_minutes.pptx');
        window.open(url, '_blank');
        setStatus(el('ppt-status'), 'PPT 已生成，可下载', 'ok');
      }).catch(function (e) { setStatus(el('ppt-status'), 'PPT 生成失败：' + e.message, 'err'); })
      .finally(function () { busy(btn, false, '生成会议总结 PPT'); });
  }

  function renderMarkdown(md) {
    var lines = String(md || '').split('\n'), html = '', inUl = false;
    function closeUl() { if (inUl) { html += '</ul>'; inUl = false; } }
    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      if (!line) { closeUl(); return; }
      if (/^#{1,3}\s+/.test(line)) { closeUl(); html += '<h2>' + esc(line.replace(/^#{1,3}\s+/, '')) + '</h2>'; }
      else if (/^\s*[-*•]\s+/.test(line)) { if (!inUl) { html += '<ul>'; inUl = true; } html += '<li>' + esc(line.replace(/^\s*[-*•]\s+/, '')) + '</li>'; }
      else if (/^\d+[.、)]\s*/.test(line)) { if (!inUl) { html += '<ul>'; inUl = true; } html += '<li>' + esc(line.replace(/^\d+[.、)]\s*/, '')) + '</li>'; }
      else if (/^>\s*/.test(line)) { closeUl(); html += '<blockquote>' + esc(line.replace(/^>\s*/, '')) + '</blockquote>'; }
      else { closeUl(); html += '<p>' + esc(line) + '</p>'; }
    });
    closeUl();
    return html;
  }

  /* ============ 上传已有录音转写 ============ */
  function decodeToBuffer(arrayBuffer) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx();
    return ctx.decodeAudioData(arrayBuffer).then(function (buffer) {
      ctx.close();
      var sr = 16000, length = Math.max(1, Math.ceil(buffer.duration * sr));
      var offline = new OfflineAudioContext(1, length, sr);
      var src = offline.createBufferSource(); src.buffer = buffer; src.connect(offline.destination); src.start(0);
      return offline.startRendering();
    });
  }
  function bufferToWav(buffer) {
    var samples = buffer.getChannelData(0);
    var blockAlign = 2, dataSize = samples.length * blockAlign;
    var ab = new ArrayBuffer(44 + dataSize), view = new DataView(ab);
    function wstr(o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
    wstr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 16000 * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
    wstr(36, 'data'); view.setUint32(40, dataSize, true);
    for (var i = 0; i < samples.length; i++) { var s = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([ab], { type: 'audio/wav' });
  }
  function fileToWav(file) { return file.arrayBuffer().then(decodeToBuffer).then(bufferToWav); }

  function doTranscribe(blob) {
    setStatus(el('upload-status'), '正在降噪转写…（首次运行需加载模型，可能稍慢）');
    var btn = el('btn-upload'); busy(btn, true, '处理中');
    fileToWav(blob).then(function (wav) { return postAudio('/transcribe?denoise=1', wav); }).then(function (j) {
      renderResult(j.result); setStatus(el('upload-status'), '转写完成，共 ' + j.result.segments.length + ' 段', 'ok');
    }).catch(function (e) { setStatus(el('upload-status'), '处理失败：' + e.message, 'err'); })
      .finally(function () { busy(btn, false, '上传录音转写'); });
  }
  function renderResult(result) {
    var box = el('result'); box.classList.remove('hidden');
    var spkCount = (result.speakers || []).length;
    var named = (result.speakers || []).filter(function (s) { return s.name; }).length;
    var meta = '时长 ' + fmtTs(result.duration_seconds || 0) + ' · 识别到 ' + spkCount + ' 位说话人' +
      (result.speaker_profiles_count ? ' · 已登记 ' + result.speaker_profiles_count + ' 人，其中认出 ' + named + ' 人' : '');
    var html = '<div class="meta" style="font-size:12px;color:var(--muted);margin-bottom:12px">' + esc(meta) + '</div>';
    (result.segments || []).forEach(function (s) {
      var known = !!s.speaker_name;
      var name = known ? s.speaker_name : ('说话人 ' + (s.spk >= 0 ? (s.spk + 1) : '?'));
      var cls = known ? 'matched' : 'unknown';
      var badge = known ? '<span class="spk-badge">已识别</span>' : '';
      html += '<div class="spk-line"><div class="who"><div class="name ' + cls + '">' + esc(name) + badge + '</div>' +
        '<div class="ts">' + fmtTs(s.start) + ' – ' + fmtTs(s.end) + '</div></div>' +
        '<div class="text">' + esc(s.text) + '</div></div>';
    });
    box.innerHTML = html;
  }

  /* ============ 声纹登记 ============ */
  function enrollWav(wav) {
    var name = el('speaker-name').value.trim();
    if (!name) { setStatus(el('enroll-status'), '请先填写人物姓名', 'err'); return; }
    setStatus(el('enroll-status'), '正在提取声纹并登记…');
    postAudio('/enroll?name=' + encodeURIComponent(name), wav)
      .then(function (j) {
        setStatus(el('enroll-status'), '已登记「' + j.speaker.name + '」，之后的新录音会自动认出', 'ok');
        el('speaker-name').value = ''; loadSpeakers();
      }).catch(function (e) { setStatus(el('enroll-status'), '登记失败：' + e.message, 'err'); });
  }
  function doEnroll(blob) {
    var btn = el('btn-enroll-upload'); busy(btn, true, '登记中');
    fileToWav(blob).then(enrollWav).catch(function (e) { setStatus(el('enroll-status'), '登记失败：' + e.message, 'err'); })
      .finally(function () { busy(btn, false, '上传人声登记'); });
  }

  /* ============ 录制人声并登记（短暂录音） ============ */
  var enrollStream = null, enrollCtx = null, enrollProc = null, enrollChunks = [], enrollTotal = 0, enrolling = false, enrollTimer = null;
  function startEnrollRec() {
    if (!el('speaker-name').value.trim()) { setStatus(el('enroll-status'), '请先填写人物姓名', 'err'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setStatus(el('enroll-status'), '当前浏览器不支持录音', 'err'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      enrollStream = stream;
      try { enrollCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 }); }
      catch (e) { enrollCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      var src = enrollCtx.createMediaStreamSource(stream);
      enrollProc = enrollCtx.createScriptProcessor(4096, 1, 1);
      enrollChunks = []; enrollTotal = 0;
      enrollProc.onaudioprocess = function (e) {
        var input = e.inputBuffer.getChannelData(0);
        var output = e.outputBuffer.getChannelData(0);
        for (var i = 0; i < output.length; i++) output[i] = 0;
        var pcm = resampleLinear(input, enrollCtx.sampleRate, 16000);
        enrollChunks.push(pcm.slice(0)); enrollTotal += pcm.length;
      };
      src.connect(enrollProc); enrollProc.connect(enrollCtx.destination);
      enrolling = true;
      var b = el('btn-enroll-rec'); b.classList.add('on'); b.innerHTML = '■ 结束并登记';
      setStatus(el('enroll-status'), '正在录制人声…请清晰说几句话，说完点「结束并登记」（最长 10 秒）', 'ok');
      enrollTimer = setInterval(function () { if (enrollTotal / 16000 >= 10) stopEnrollRec(); }, 500);
    }).catch(function () { setStatus(el('enroll-status'), '无法访问麦克风，请检查浏览器权限', 'err'); });
  }
  function stopEnrollRec() {
    enrolling = false;
    if (enrollTimer) { clearInterval(enrollTimer); enrollTimer = null; }
    if (enrollProc) { try { enrollProc.disconnect(); } catch (e) {} enrollProc = null; }
    if (enrollCtx) { try { enrollCtx.close(); } catch (e) {} enrollCtx = null; }
    if (enrollStream) { enrollStream.getTracks().forEach(function (t) { t.stop(); }); enrollStream = null; }
    var b = el('btn-enroll-rec'); b.classList.remove('on'); b.innerHTML = '录制人声并登记';
    if (enrollTotal < 16000) { setStatus(el('enroll-status'), '录制过短，请至少录 1 秒清晰人声', 'err'); return; }
    var total = new Float32Array(enrollTotal), off = 0;
    enrollChunks.forEach(function (c) { total.set(c, off); off += c.length; });
    enrollWav(floatToWav(total, 16000));
  }
  function loadSpeakers() {
    fetch(API + '/speakers').then(function (r) { return r.json(); }).then(function (j) {
      var list = el('speaker-list'), arr = j.speakers || [];
      if (!arr.length) { list.innerHTML = '<div class="empty">暂无登记人物，先在上方录一段人声登记。</div>'; return; }
      list.innerHTML = arr.map(function (s) {
        return '<div class="speaker-item"><span class="avatar">' + esc((s.name || '?').charAt(0)) + '</span>' +
          '<div class="info"><div class="n">' + esc(s.name) + '</div><div class="m">登记于 ' + esc(s.created_at || '—') + ' · 样本 ' + (s.duration_seconds || 0) + ' 秒</div></div>' +
          '<button class="del" data-id="' + esc(s.speaker_id) + '" title="删除">删除</button></div>';
      }).join('');
      list.querySelectorAll('.del').forEach(function (b) {
        b.addEventListener('click', function () {
          fetch(API + '/speaker/' + encodeURIComponent(b.getAttribute('data-id')), { method: 'DELETE' }).then(function () { loadSpeakers(); });
        });
      });
    }).catch(function () { /* 服务未启动时静默 */ });
  }

  /* ============ 事件绑定 ============ */
  el('btn-rec').addEventListener('click', function () { if (recording) stopLive(); else startLive(); });
  el('btn-summary').addEventListener('click', doSummary);
  el('btn-minutes').addEventListener('click', doMinutes);
  el('btn-ppt').addEventListener('click', doPpt);
  el('btn-upload').addEventListener('click', function () { el('file-input').click(); });
  el('file-input').addEventListener('change', function (e) { var f = e.target.files[0]; e.target.value = ''; if (f) doTranscribe(f); });
  el('btn-enroll-upload').addEventListener('click', function () { el('enroll-input').click(); });
  el('enroll-input').addEventListener('change', function (e) { var f = e.target.files[0]; e.target.value = ''; if (f) doEnroll(f); });
  el('btn-enroll-rec').addEventListener('click', function () { if (enrolling) stopEnrollRec(); else startEnrollRec(); });

  /* ============ 左侧功能导航切换 ============ */
  var navItems = Array.prototype.slice.call(document.querySelectorAll('.nav-item'));
  var panels = Array.prototype.slice.call(document.querySelectorAll('.tab-panel'));
  navItems.forEach(function (item) {
    item.addEventListener('click', function () {
      var target = item.getAttribute('data-tab');
      navItems.forEach(function (n) { n.classList.remove('active'); });
      panels.forEach(function (p) { p.classList.remove('active'); });
      item.classList.add('active');
      var panel = document.getElementById(target);
      if (panel) panel.classList.add('active');
    });
  });

  healthCheck();
  initEngineSelect();
  loadSpeakers();
  restoreNotes();
})();
