(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentArchitecture = api;
})(globalThis, function () {
  'use strict';

  const groups = {
    work: '研究与日常工作',
    production: '设计与内容制作',
    governance: '调度与运营治理',
    support: '知识与工作支持',
    services: '入口与共享工具',
    custom: '其他已注册 Agent',
  };

  // 显示名仅用于架构图。注册名仍可用来匹配旧记录、任务与模型锁。
  // resp = 负责明细（主要领域）；work = 工作明细（具体动作/产出）；trigger = 触发类型（与治理官四类一致）。
  const definitions = [
    { key: 'research-chat', group: 'work', name: '学术研究助手', registeredName: '研究助手', trigger: 'human',
      duty: '研究设计、文献核查、论文写作与审稿返修',
      resp: ['研究设计与方法', '文献核查与引证', '论文写作', '审稿返修'],
      work: ['检索筛选文献', '搭建研究框架', '核对引用与数据', '撰写润色论文、回复审稿意见'] },
    { key: 'ethics-chat', group: 'work', name: 'AI 对齐与伦理教学助手', registeredName: '伦理agent', trigger: 'human',
      duty: '对齐模型对照演示、商业案例教学与归档',
      resp: ['对齐模型对照演示', '商业伦理案例教学', '伦理案例归档'],
      work: ['模型对齐对比演示', '案例讲解与讨论', '归档伦理教学材料'] },
    { key: 'dev-chat', group: 'work', name: '软件开发与维护助手', registeredName: '软件工程', trigger: 'human',
      duty: '编写代码、排查故障与审查改动',
      resp: ['编写代码', '排查故障', '审查改动'],
      work: ['实现功能与脚本', '定位并修复 bug', '代码审查与重构建议'] },
    { key: 'assistant-chat', group: 'work', name: '日常问答与文档助手', registeredName: '通用助手', trigger: 'human',
      duty: '问答、网页资料整理、文档生成与项目协调',
      resp: ['日常问答', '网页资料整理', '文档生成', '项目协调'],
      work: ['回答日常问题', '整理网页资料', '生成文档', '协调项目任务（含 CityVerse 总控）'] },
    { key: 'meeting-audio', group: 'production', name: '会议转写与纪要助手', registeredName: '会议纪要官', trigger: 'human',
      duty: '实时转写、说话人识别、会议纪要与 PPT',
      resp: ['实时转写', '说话人识别', '会议纪要', '导出 PPT'],
      work: ['实时/录音转写', '登记说话人声纹', '生成纪要', '导出会议 PPT'] },
    { key: 'design', group: 'production', name: '界面视觉设计助手', registeredName: '界面设计师', trigger: 'human',
      duty: '配色、排版、界面动效与视觉检查',
      resp: ['配色方案', '排版布局', '界面动效', '视觉检查'],
      work: ['配色与排版', '界面动效', '视觉走查'] },
    { key: 'music', group: 'production', name: '歌曲与 MV 制作助手', registeredName: '音乐创作', trigger: 'human',
      duty: '根据主题或歌词制作歌曲与 MV',
      resp: ['歌词/主题创作', '歌曲制作', 'MV 制作'],
      work: ['根据主题或歌词作曲', '编曲与混音', '制作 MV'] },
    { key: 'type-governor', group: 'governance', name: '触发类型治理与任务路由', registeredName: '智能路由 ra', trigger: 'active',
      duty: '巡检触发方式，支持审批、委派与流水线',
      resp: ['触发方式巡检', '任务路由', '审批与委派'],
      work: ['巡检各 agent 触发类型', '路由委派任务', '编排流水线、支持审批'] },
    { key: 'cost', group: 'governance', name: '用量与预算监控', registeredName: 'CFO 成本官', trigger: 'active',
      duty: '汇总用量账本、监控预算与推荐模型',
      resp: ['用量账本汇总', '预算监控', '模型推荐'],
      work: ['汇总用量账本', '监控预算', '推荐性价比模型'] },
    { key: 'model', group: 'governance', name: '模型切换与锁定', registeredName: '模型调控官', trigger: 'active',
      duty: '处理本地模型可用性、降级与手动锁定',
      resp: ['模型可用性', '降级处理', '手动锁定'],
      work: ['检测本地模型可用性', '降级切换', '手动锁定模型'] },
    { key: 'workforce', group: 'governance', name: 'Agent 职责与负载审计', registeredName: 'Agent 总管', trigger: 'active',
      duty: '检查工作量与职责覆盖，提出增、分、合建议',
      resp: ['负载审计', '职责覆盖检查', '增减合建议'],
      work: ['检查工作量', '核对职责覆盖', '提出增/分/合建议'] },
    { key: 'supervisor', group: 'governance', name: '目标偏离监测', trigger: 'pipeline',
      duty: '对照核心需求检查目标漂移并提醒纠偏',
      resp: ['目标对照', '漂移检测', '纠偏提醒'],
      work: ['对照核心需求', '检测目标漂移', '提醒纠偏'] },
    { key: 'settler', group: 'support', name: '经验提案与入库', trigger: 'pipeline',
      duty: '从已完成工作提炼经验，等待人工审核',
      resp: ['经验提炼', '提案入库'],
      work: ['从已完成工作提炼经验', '提交提案、等待人工审核'] },
    { key: 'sentiment', group: 'support', name: '反馈与偏好提炼', trigger: 'pipeline',
      duty: '从显式反馈提炼偏好并提交经验提案',
      resp: ['反馈提炼', '偏好沉淀', '经验提案'],
      work: ['从显式反馈提炼偏好', '沉淀偏好', '提交经验提案'] },
    { key: 'secretary', group: 'support', name: '日程与待办提醒', trigger: 'active',
      duty: '汇总日程、跟进邮件，并主动提醒工作台里需要你处理的所有待办',
      resp: ['日程汇总', '会议提醒', '邮件跟进', '待办提醒'],
      work: ['汇总日程', '提醒会议', '跟进待回复邮件', '汇总并提醒待办'] },
    { key: 'radar', group: 'support', name: '生态资讯雷达', registeredName: '灵感目录', trigger: 'active',
      duty: '追踪生态动态，整理可用作灵感的资讯',
      resp: ['生态追踪', '灵感整理'],
      work: ['追踪生态动态', '整理可用作灵感的资讯'] },
    { key: 'agent-console', group: 'services', name: 'Agent 总控台', registeredName: 'Agent 总控台', trigger: 'human',
      duty: '查看经验提案、治理巡检与架构',
      resp: ['经验提案查看', '治理巡检', '架构总览'],
      work: ['查看经验提案', '查看治理巡检', '查看架构图'] },
    { key: 'knowledge', group: 'services', name: '共享知识库', trigger: 'human',
      duty: '索引与检索本地文献和资料',
      resp: ['文献索引', '全文检索', '术语图谱'],
      work: ['索引本地文献资料', '跨库检索', '维护术语图谱'] },
    { key: 'task-queue', group: 'services', name: '后台任务队列', trigger: 'pipeline',
      duty: '执行独立后台任务并记录等待与完成状态',
      resp: ['任务排队', '独立执行', '状态记录'],
      work: ['执行独立后台任务', '记录等待与完成状态'] },
    { key: 'cityverse', group: 'services', name: 'CityVerse 项目', trigger: 'human',
      duty: '查看社区情报、建设计划、执行与门禁',
      resp: ['社区情报', '建设计划', '执行与门禁'],
      work: ['查看社区情报', '查看建设计划', '查看执行与门禁'] },
  ];

  // CityVerse 的阶段清单取自工作台已有项目控制台接口；阶段聚合状态不代表节点之间发生了交接。
  const projectStages = [
    ['collect', '社区舆情采集', '读取社区来源并保存采集结果，供洞察提炼使用。', 'findings', '条采集结果'],
    ['insight', '社区洞察提炼', '汇总采集结果，将洞察交给玩法整理与建设规划。', 'insights', '条洞察'],
    ['playbook', '玩法整理', '维护玩法点子，供建设规划引用。', 'playbook', '条玩法'],
    ['plan', '建设规划', '汇总洞察与玩法，生成待人工审核的建设计划。', 'plans', '条计划'],
    ['approval', '人工审批', '查看待审计划，批准后可启动执行。', 'plansPending', '条待审'],
    ['execute', '批准计划执行', '执行已批准的建设计划，并将执行结果交给质量门禁。', 'runs', '次执行'],
    ['gate', '执行质量门禁', '审查执行结果并记录通过或驳回。', 'gates', '次门禁'],
  ];
  const projectRoles = {
    'cv-strategy': [
      ['selfcheck', '项目能力盘点', '盘点仓库现状，将能力快照与短板交给路线差距分析。'],
      ['competitor', '竞品对标', '比较参考项目，把维度差异交给路线差距分析。'],
      ['research', '路线资讯研究', '围绕路线图收集资讯，将简报交给路线差距分析。'],
      ['analyze', '路线差距分析', '汇总项目能力、竞品与资讯，并给出优先级。'],
      ['feed', '建设任务提案', '将差距分析转为待审批的建设规划。'],
    ],
    'cv-operations': [
      ['content-planner', '运营内容策划', '将活动需求整理成待审批的任务说明。'],
      ['poi-operator', '点位数据诊断', '检查商圈点位、街景路线和 AR 锚点，给出修复建议。'],
      ['content-executor', '运营内容上架', '处理已获批准的活动、折扣和内容更新。'],
      ['quality-gate', '运营内容质检', '审查运营内容的数值、文案和预算。'],
      ['merchant-advisor', '商户折扣建议', '为商户折扣方案提供审批建议。', 'soon'],
      ['risk-inspector', '游戏异常巡检', '检查异常用券、坐标漂移等风险信号。'],
      ['data-governor', '运营数据对账', '核对点位、商户、券和玩家数据。'],
      ['exp-settler', '运营经验提案', '从已解决的运营事项整理可复用的经验。'],
      ['ip-guardian', '知识产权登记与巡查', '管理版权留痕、商标监测与授权记录。'],
    ],
  };
  // 触发类型（与 agent-type-governor.js 四类一致：active/pipeline/gap/human）
  const triggerColors = { active: '#f59e0b', pipeline: '#0ea5e9', gap: '#dc2626', human: '#16a34a' };
  const triggerLabels = { active: '主动', pipeline: '链路', gap: '缺口', human: '人工' };
  const stageTriggers = { collect: 'active', insight: 'pipeline', playbook: 'pipeline', plan: 'pipeline', approval: 'human', execute: 'pipeline', gate: 'pipeline' };
  const roleTriggers = {
    selfcheck: 'active', competitor: 'pipeline', research: 'active', analyze: 'pipeline', feed: 'gap',
    'content-planner': 'human', 'poi-operator': 'human', 'content-executor': 'human', 'quality-gate': 'human',
    'merchant-advisor': 'human', 'risk-inspector': 'human', 'data-governor': 'human', 'exp-settler': 'human', 'ip-guardian': 'human',
  };

  const layers = [
    { name: '工作台底座', color: '#23665b', groups },
    { name: '项目调度', color: '#994b3b', groups: { dispatch: 'CityVerse 本机总控' } },
    { name: 'CityVerse 项目', color: '#544a96', groups: { 'cv-intel': '社区情报与建设', 'cv-strategy': '战略研究', 'cv-operations': '运营与内容管理' } },
  ];

  function graphNodes(workbench) {
    const cityverse = workbench.find(node => node.key === 'cityverse') || definitions.find(node => node.key === 'cityverse');
    return workbench.filter(node => node.key !== 'cityverse').map(node => ({
      ...node, kind: node.group === 'services' ? 'resource' : 'agent',
    })).concat(
      { ...cityverse, group: 'cv-intel', kind: 'resource' },
      { key: 'cv:chief', group: 'dispatch', name: '项目任务调度', kind: 'resource', trigger: 'pipeline',
        duty: '从 CityVerse 总控队列领取任务并交给项目执行程序，记录进度与结果。' },
      projectStages.map(([stage, name, duty, metric, unit]) => ({
        key: 'cv:' + stage, group: 'cv-intel', name, duty, stage, metric, unit,
        kind: stage === 'approval' ? 'resource' : 'agent', trigger: stageTriggers[stage],
      })),
      Object.entries(projectRoles).flatMap(([group, roles]) => roles.map(([key, name, duty, availability]) => ({
        key: 'cv:' + key, group, name, duty, availability, kind: 'agent', trigger: roleTriggers[key],
      }))),
    );
  }

  const relations = [
    ['assistant-chat', 'cv:chief', '通过本机总控读取项目进度或提交经批准的任务'],
    ['cv:chief', 'cityverse', '将项目任务派给对应的项目执行程序'],
    ['assistant-chat', 'sentiment', '提交对话反馈'],
    ['research-chat', 'sentiment', '提交对话反馈'],
    ['ethics-chat', 'sentiment', '提交对话反馈'],
    ['dev-chat', 'sentiment', '提交对话反馈'],
    ['sentiment', 'settler', '提交偏好提案，进入待审批流程'],
    ['agent-console', 'settler', '展示待审提案与已入库经验'],
    ['research-chat', 'knowledge', '按需检索共享文献'],
    ['ethics-chat', 'knowledge', '按需检索案例及法务资料'],
    ['type-governor', 'task-queue', '为队列的自动分拣提供任务类型与默认引擎'],
    ['cityverse', 'cv:collect', '社区情报控制台汇总采集与建设流程'],
    ['cv:collect', 'cv:insight', '将采集记录交给洞察提炼'],
    ['cv:insight', 'cv:playbook', '为玩法整理提供社区洞察'],
    ['cv:insight', 'cv:plan', '为建设规划提供洞察'],
    ['cv:playbook', 'cv:plan', '为建设规划提供玩法点子'],
    ['cv:plan', 'cv:approval', '生成待审核的建设计划'],
    ['cv:approval', 'cv:execute', '人工批准后可启动执行'],
    ['cv:execute', 'cv:gate', '将执行结果交给质量门禁'],
    ['cv:selfcheck', 'cv:analyze', '提供项目能力快照'],
    ['cv:competitor', 'cv:analyze', '提供竞品差异'],
    ['cv:research', 'cv:analyze', '提供路线资讯'],
    ['cv:analyze', 'cv:feed', '将差距清单转为建设提案'],
    ['cv:feed', 'cv:plan', '提交建设计划'],
  ];

  function knownKey(agent) {
    const slug = /^agents\/([^/]+)\/index\.html$/.exec(agent.href || '')?.[1];
    if (slug && definitions.some(d => d.key === slug)) return slug;
    return definitions.find(d => d.registeredName && d.registeredName === agent.name)?.key;
  }

  function inventory(registry) {
    if (!Array.isArray(registry)) return definitions;
    const seen = new Set();
    const nodes = registry.map(agent => {
      const known = knownKey(agent);
      const d = known && !seen.has(known) && definitions.find(item => item.key === known);
      if (d) seen.add(known);
      return {
        key: d ? d.key : 'agent:' + agent.id,
        group: d ? d.group : 'custom',
        name: d ? d.name : agent.name,
        duty: d ? d.duty : agent.tag,
        registeredName: agent.name,
        availability: agent.status,
        trigger: agent.triggerType || (d && d.trigger),
        engine: agent.engineLabel || agent.engine,
        id: agent.id,
        resp: d ? d.resp : undefined,
        work: d ? d.work : undefined,
      };
    });
    return nodes.concat(definitions.filter(d => !d.registeredName));
  }

  function interactions(run) {
    const edges = [];
    if (run.from && run.from !== run.agent) edges.push([run.from, run.agent, '']);
    if (run.handoff && run.handoff !== run.agent) edges.push([run.handoff, run.agent, '上一步结果交接']);
    return edges;
  }

  function graphEdges(nodes, active, recent, now) {
    const keys = new Set(nodes.map(node => node.key));
    const edges = new Map();
    const priority = { configured: 0, simulation: 1, recent: 2, running: 3 };
    function add(from, to, state) {
      if (!keys.has(from) || !keys.has(to)) return;
      const id = JSON.stringify([from, to]);
      const existing = edges.get(id);
      if (!existing || priority[state] > priority[existing.state]) edges.set(id, { from, to, state });
    }
    relations.forEach(([from, to]) => add(from, to, 'configured'));
    for (const run of recent) {
      if (run.status !== 'done' || !Number.isFinite(run.endedAt) || run.endedAt > now || now - run.endedAt > 5 * 60000) continue;
      interactions(run).forEach(([from, to]) => add(from, to, run.simulated ? 'simulation' : 'recent'));
    }
    for (const run of active) {
      if (run.status !== 'running') continue;
      interactions(run).forEach(([from, to]) => add(from, to, run.simulated ? 'simulation' : 'running'));
    }
    return Array.from(edges.values());
  }

  return { layers, relations, graphNodes, graphEdges, interactions, inventory, knownKey, triggerColors, triggerLabels };
});
