/**
 * ============================================================
 *  task-router.js — ra 的任务类型路由（零依赖）
 *  ============================================================
 *
 *  回答「让 ra 自己判断该派谁、挂哪些 skill」：
 *    1. classifyTask：把一句话任务归到任务类型（审稿 / 去AI味 / 写作 /
 *       文献综述 / 研究指导 / 编码 / 转写 / 总结 / 翻译 / 音乐 / 数据 / 通用）
 *    2. route：按任务类型挑 Agent（名字/简介/soul 关键词打分）+
 *              挑 Skill（复用 SkillsCore.recommend）+ 挑引擎（TASK_DEFAULTS）
 *    3. 每一步都给可解释的 reasons，用户可以微调；只依据给定的 Agent /
 *       Skill / 任务文字，不臆造。
 *
 *  零依赖。浏览器 <script src>；Node require() 后取 globalThis.TaskRouter。
 * ============================================================
 */
(function (global) {
  'use strict';

  /* ---------- 1. 任务类型表 ---------- */
  // words       归类关键词（命中越多越像这类任务）
  // agentWords  挑 Agent 用的关键词（匹配 agent 的 name/tag/soul/description）
  // boardHint   默认落到哪个技能板块
  // skillWords  兜底挑 Skill 用的名字关键词（SkillsCore.recommend 不可用时用）
  // engine      默认引擎（与 agents-core 的 TASK_DEFAULTS 对齐）
  var TASK_TYPES = [
    { id: 'review',    label: '审稿/评审',   words: ['审稿','评审','review','审阅','评阅','匿名评审','同行评审','返修意见','论证','审查','评议','论证链','引用审计','引用核查','引用','citation','可重复性','复现','reproducib','paper-code','预分析','pre-analysis'], agentWords: ['审稿','评审','研究','论文'], boardHint: 'research', skillWords: ['审稿'], engine: 'claude-code' },
    { id: 'deai',      label: '去 AI 味',    words: ['去ai味','去 ai 味','ai味','ai 味','去AI','机器味','套话','机械化','改写口语','更像人写','防御性写作','defensive','模棱两可','留退路','hedging','委婉','回避','不敢下判断'], agentWords: ['写作','研究','润色'], boardHint: 'research', skillWords: ['去 ai','去ai','去 AI','防御性写作'], engine: 'claude-code' },
    { id: 'litreview', label: '文献综述',    words: ['文献综述','文献','综述','literature','系统综述','荟萃','元分析','梳理文献','研究现状'], agentWords: ['研究','文献','综述'], boardHint: 'research', skillWords: ['文献综述','文献'], engine: 'deepseek' },
    { id: 'mentor',    label: '研究指导',    words: ['选题','研究问题','研究设计','开题','方法指导','章节','论文框架','研究计划','指导','拆解','建构','提炼','研究框架','理论框架','假设','变量','项目管理','投稿流程','论文规划','立项','推进','实验','实验设计','随机分组','样本量'], agentWords: ['研究','导师','指导','论文'], boardHint: 'research', skillWords: ['研究导师','导师'], engine: 'deepseek' },
    { id: 'writing',   label: '写作',        words: ['写作','写文章','撰写','论文写作','报告','公文','总结','润色','文笔','成文'], agentWords: ['写作','研究','润色','文章'], boardHint: 'research', skillWords: ['写作'], engine: 'claude-code' },
    { id: 'coding',    label: '编码',        words: ['代码','编程','重构','调试','函数','bug','api','脚本','部署','实现','写个','开发'], agentWords: ['代码','编程','开发'], boardHint: '', skillWords: ['代码'], engine: 'codex' },
    { id: 'transcribe',label: '转写/纪要',   words: ['转写','录音','会议纪要','纪要','语音','字幕','转录','说话人','meeting','分钟'], agentWords: ['会议','纪要','转写','录音','语音'], boardHint: '', skillWords: [], engine: 'funasr' },
    { id: 'summarize', label: '总结',        words: ['总结','摘要','概括','提炼','归纳','大纲','要点','summarize'], agentWords: ['总结','纪要','助手'], boardHint: '', skillWords: [], engine: 'deepseek' },
    { id: 'translate', label: '翻译',        words: ['翻译','译成','英译','中译','本地化','术语','互译'], agentWords: ['翻译'], boardHint: '', skillWords: [], engine: 'qwen' },
    { id: 'music',     label: '音乐',        words: ['写歌','歌词','作词','作曲','编曲','音乐','歌曲','翻唱','配乐','旋律','bgm','suno','ace-step','歌'], agentWords: ['音乐','歌','作曲','作词'], boardHint: '', skillWords: [], engine: 'local-llm' },
    { id: 'data',      label: '数据分析',    words: ['数据','分析','图表','统计','透视','清洗','可视化','报表','指标','excel','csv'], agentWords: ['数据','分析','图表'], boardHint: '', skillWords: [], engine: 'gpt' },
    { id: 'general',   label: '通用',        words: [], agentWords: ['助手'], boardHint: '', skillWords: [], engine: 'local-llm' },
  ];

  function typeById(id) {
    for (var i = 0; i < TASK_TYPES.length; i++) if (TASK_TYPES[i].id === id) return TASK_TYPES[i];
    return TASK_TYPES[TASK_TYPES.length - 1];
  }
  function typeLabel(id) { return typeById(id).label; }

  /* ---------- 2. 归类 ---------- */
  function classifyTask(task) {
    var t = String(task || '').toLowerCase();
    var best = 'general', hit = 0, detail = {};
    TASK_TYPES.forEach(function (tt) {
      var n = 0, hits = [];
      (tt.words || []).forEach(function (w) { if (w && t.indexOf(w) >= 0) { n++; hits.push(w); } });
      detail[tt.id] = n;
      if (n > hit) { hit = n; best = tt.id; }
    });
    return { type: best, label: typeLabel(best), score: hit, detail: detail };
  }

  /* ---------- 3. 挑 Agent（名字/简介/soul 关键词打分） ---------- */
  function agentBlob(a) {
    var d = a && a.detail ? a.detail : {};
    return String(a.name || '') + ' ' + String(a.tag || '') + ' ' +
      String(a.soul || '') + ' ' + String(d.desc || '') + ' ' + String(d.sub || '');
  }
  function scoreAgents(agents, tt, excludeId) {
    var words = (tt.agentWords || []).filter(Boolean);
    return (agents || []).map(function (a) {
      var blob = agentBlob(a).toLowerCase();
      var n = 0, hits = [];
      words.forEach(function (w) { if (w && blob.indexOf(w.toLowerCase()) >= 0) { n++; hits.push(w); } });
      return { agent: a, score: n, hits: hits };
    }).filter(function (x) {
      if (x.agent.id === excludeId) return false;
      if (x.agent.status === 'soon') return false;   // 「敬请期待」的不派
      return true;
    }).sort(function (a, b) { return b.score - a.score; });
  }

  /* ---------- 4. 路由主入口 ----------
   * ctx: {
   *   agents: [Agent...],
   *   commanderId: string,
   *   boards: BoardRegistry,
   *   skills: SkillRegistry,      // 可选：有则用 recommend()
   *   maxTargets, maxSkills
   * }
   * 返回 Promise<plan>（skills 推荐若为同步也统一包成 Promise）
   */
  function route(task, ctx) {
    var o = ctx || {};
    var t = String(task || '').trim();
    var classified = classifyTask(t);
    var tt = typeById(classified.type);
    var agents = o.agents || [];

    // —— 挑 Agent ——
    var scored = scoreAgents(agents, tt, o.commanderId);
    var pickable = scored.filter(function (x) { return x.score > 0; });
    var chosen = pickable.length ? pickable : scored.filter(function (x) { return x.agent.status === 'active'; });
    if (!chosen.length) chosen = scored;                     // 全是 soon / 无匹配，兜底
    var maxT = o.maxTargets || 2;
    var targets = chosen.slice(0, maxT);
    var targetIds = targets.map(function (x) { return x.agent.id; });
    var targetReasons = targets.map(function (x) {
      return x.agent.name + (x.score > 0 ? '（命中 ' + x.hits.slice(0, 2).join('、') + '）' : '（本板块可派，无关键词命中）');
    });

    // —— 挑 Skill ——
    var skillPlan = Promise.resolve({ ids: [], reasons: [] });
    if (o.skills) {
      skillPlan = Promise.resolve(o.skills.recommend(t, {
        boardId: tt.boardHint || o.boardId, limit: o.maxSkills || 3,
      })).then(function (recs) {
        recs = recs || [];
        return {
          ids: recs.slice(0, o.maxSkills || 3).map(function (x) { return x.skill.id; }),
          reasons: recs.slice(0, o.maxSkills || 3).map(function (x) {
            return x.skill.name + '（' + (x.reasons || []).join(' / ') + '）';
          }),
        };
      });
    }

    return skillPlan.then(function (sp) {
      return {
        taskType: classified.type,
        taskLabel: classified.label,
        confidence: classified.score,
        targetIds: targetIds,
        targetNames: targets.map(function (x) { return x.agent.name; }),
        targetReasons: targetReasons,
        skillIds: sp.ids,
        skillReasons: sp.reasons,
        boardId: tt.boardHint || o.boardId || '',
        engine: tt.engine,
        summary: '识别为「' + classified.label + '」' +
          (classified.score ? '（命中 ' + classified.score + ' 个关键词）' : '') +
          ' → 派给 ' + targetNames(targets.map(function (x) { return x.agent; })) +
          '，挂载 ' + sp.ids.length + ' 个技能，默认引擎 ' + tt.engine + '。',
      };
    });
  }

  function targetNames(targets) {
    return (targets && targets.length) ? targets.map(function (x) { return x.name; }).join('、') : '无可用 Agent';
  }

  /* ---------- 导出 ---------- */
  global.TaskRouter = {
    TASK_TYPES: TASK_TYPES,
    classifyTask: classifyTask,
    typeById: typeById,
    typeLabel: typeLabel,
    route: route,
    scoreAgents: scoreAgents,
  };
})(typeof window !== 'undefined' ? window : globalThis);
