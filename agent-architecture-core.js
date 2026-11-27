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
    services: '入口、工具与外部项目',
    custom: '其他已注册 Agent',
  };

  // 显示名仅用于架构图。注册名仍可用来匹配旧记录、任务与模型锁。
  const definitions = [
    ['research-chat', 'work', '学术研究助手', '研究设计、文献核查、论文写作与审稿返修', '研究助手'],
    ['ethics-chat', 'work', 'AI 对齐与伦理教学助手', '对齐模型对照演示、商业案例教学与归档', '伦理agent'],
    ['dev-chat', 'work', '软件开发与维护助手', '编写代码、排查故障与审查改动', '软件工程'],
    ['assistant-chat', 'work', '日常问答与文档助手', '问答、网页资料整理、文档生成与项目协调', '通用助手'],
    ['meeting-audio', 'production', '会议转写与纪要助手', '实时转写、说话人识别、会议纪要与 PPT', '会议纪要官'],
    ['design', 'production', '界面视觉设计助手', '配色、排版、界面动效与视觉检查', '界面设计师'],
    ['music', 'production', '歌曲与 MV 制作助手', '根据主题或歌词制作歌曲与 MV', '音乐创作'],
    ['type-governor', 'governance', '触发类型治理与任务路由', '巡检触发方式，支持审批、委派与流水线', '智能路由 ra'],
    ['cost', 'governance', '用量与预算监控', '汇总用量账本、监控预算与推荐模型', 'CFO 成本官'],
    ['model', 'governance', '模型切换与锁定', '处理本地模型可用性、降级与手动锁定', '模型调控官'],
    ['workforce', 'governance', 'Agent 职责与负载审计', '检查工作量与职责覆盖，提出增、分、合建议', 'Agent 总管'],
    ['supervisor', 'governance', '目标偏离监测', '对照核心需求检查目标漂移并提醒纠偏'],
    ['settler', 'support', '经验提案与入库', '从已完成工作提炼经验，等待人工审核'],
    ['sentiment', 'support', '反馈与偏好提炼', '从显式反馈提炼偏好并提交经验提案'],
    ['secretary', 'support', '日程与邮件跟进', '汇总日程、提醒会议和跟进待回复邮件'],
    ['radar', 'support', '生态资讯雷达', '追踪生态动态，整理可用作灵感的资讯', '灵感目录'],
    ['agent-console', 'services', 'Agent 总控台', '查看经验提案、治理巡检与架构', 'Agent 总控台'],
    ['knowledge', 'services', '共享知识库', '索引与检索本地文献和资料'],
    ['task-queue', 'services', '后台任务队列', '执行独立后台任务并记录等待与完成状态'],
    ['cityverse', 'services', 'CityVerse 项目', '查看社区情报、建设计划、执行与门禁'],
  ].map(([key, group, name, duty, registeredName]) => ({ key, group, name, duty, registeredName }));

  const relations = [
    ['assistant-chat', 'cityverse', '通过本机总控读取项目进度或提交经批准的任务'],
    ['assistant-chat', 'sentiment', '提交对话反馈'],
    ['research-chat', 'sentiment', '提交对话反馈'],
    ['ethics-chat', 'sentiment', '提交对话反馈'],
    ['dev-chat', 'sentiment', '提交对话反馈'],
    ['sentiment', 'settler', '提交偏好提案，进入待审批流程'],
    ['agent-console', 'settler', '展示待审提案与已入库经验'],
    ['research-chat', 'knowledge', '按需检索共享文献'],
    ['ethics-chat', 'knowledge', '按需检索案例及法务资料'],
    ['type-governor', 'task-queue', '为队列的自动分拣提供任务类型与默认引擎'],
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
        trigger: agent.triggerType,
        engine: agent.engineLabel || agent.engine,
        id: agent.id,
      };
    });
    return nodes.concat(definitions.filter(d => !d.registeredName));
  }

  return { groups, relations, inventory, knownKey };
});
