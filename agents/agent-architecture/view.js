(function () {
  'use strict';

  const root = document.getElementById('agentArchitecture');
  if (!root) return;
  const { layers, inventory, relations, graphNodes, graphEdges, interactions } = window.AgentArchitecture;
  const api = window.ingrid;
  root.innerHTML = `
    <div class="map-header">
      <div><h2>Agent 分层架构图</h2><p id="mapConnection" role="status">正在读取工作台…</p></div>
      <div class="map-controls">
        <select id="mapLayer" aria-label="架构层级"><option value="-1">全部层级</option></select>
        <input id="mapSearch" type="search" placeholder="搜索名称或职责" aria-label="搜索名称或职责">
        <label><input id="mapActive" type="checkbox"> 仅进行中</label>
      </div>
    </div>
    <div class="map-legend">
      <span><i></i>固定协作</span><span><i class="map-running-line"></i>正在协作</span>
      <span><i class="map-recent-line"></i>最近 5 分钟完成</span><span><i class="map-simulation-line"></i>演练</span>
      <span class="map-gesture">拖拽节点或背景，滚轮缩放</span>
    </div>
    <div class="map-layout">
      <div id="mapViewport" class="map-viewport" aria-label="按层级排列的 Agent 关系图">
        <canvas aria-hidden="true"></canvas><div class="map-world"></div>
        <p id="mapEmpty" hidden>没有符合条件的节点。</p>
      </div>
      <div class="map-navigation" aria-label="图形视图操作">
        <button type="button" id="mapZoomOut" aria-label="缩小">−</button>
        <button type="button" id="mapZoomIn" aria-label="放大">+</button>
        <button type="button" id="mapFit">适配</button>
        <button type="button" id="mapReset">重新布局</button>
      </div>
      <aside id="mapDetail" class="map-detail" aria-label="节点详情" hidden></aside>
    </div>`;

  const search = root.querySelector('#mapSearch');
  const layerSelect = root.querySelector('#mapLayer');
  const activeFilter = root.querySelector('#mapActive');
  const connection = root.querySelector('#mapConnection');
  const detail = root.querySelector('#mapDetail');
  const empty = root.querySelector('#mapEmpty');
  const graph = window.createLayeredAgentGraph(root.querySelector('#mapViewport'), layers, key => select(key, true));
  layers.forEach((layer, index) => {
    const option = new Option((index + 1) + ' · ' + layer.name, index);
    layerSelect.add(option);
  });

  const statuses = { running: '运行中', waiting: '待确认', queued: '排队中', done: '已完成', failed: '失败', stopped: '已停止' };
  const triggers = { active: '定时／主动触发', chain: '链路接续', gap: '缺口触发', manual: '人工触发' };

  let snapshot = { nodes: inventory(), active: [], recent: [] };
  let nodes = graphNodes(snapshot.nodes);
  let projectStatus = null;
  let stageRecords = null;
  let stageRequest = 0;
  let connected = false;
  let selected = '';
  let detailVersion = '';
  const touches = (run, key) => run.agent === key || run.from === key || run.handoff === key;

  function add(parent, tag, content, className) {
    const el = document.createElement(tag);
    if (content) el.textContent = content;
    if (className) el.className = className;
    parent.append(el);
    return el;
  }

  function select(key, bringIntoView) {
    const next = nodes.find(node => node.key === key);
    const filter = Number(layerSelect.value);
    if (next && filter >= 0 && !(next.group in layers[filter].groups)) layerSelect.value = '-1';
    if (selected !== key) {
      selected = key;
      stageRecords = null;
      stageRequest++;
    }
    render();
    if (!next) return;
    refreshStage();
    if (bringIntoView && matchMedia('(max-width: 680px)').matches) detail.scrollIntoView({ block: 'nearest' });
  }

  function closeDetail() {
    const button = Array.from(root.querySelectorAll('[data-map-key]')).find(el => el.dataset.mapKey === selected);
    select('', false);
    button?.focus({ preventScroll: true });
  }

  function nodeLabel(key) {
    return nodes.find(n => n.key === key)?.name || key;
  }

  function displayTime(value) {
    return value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  }

  function relationshipRow(parent, from, to, summary) {
    const row = add(parent, 'li');
    for (const [index, key] of [from, to].entries()) {
      if (index) add(row, 'span', ' → ');
      if (key === selected || !nodes.some(n => n.key === key)) add(row, 'strong', nodeLabel(key));
      else {
        const btn = add(row, 'button', nodeLabel(key), 'map-link');
        btn.type = 'button';
        btn.onclick = () => {
          select(key, false);
          detail.querySelector('h3').focus({ preventScroll: true });
        };
      }
    }
    add(row, 'small', summary);
  }

  function renderDetail(node, active, recent) {
    detail.replaceChildren();
    detail.hidden = !node;
    if (!node) return;
    const close = add(detail, 'button', '×', 'map-close');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭节点详情');
    close.onclick = closeDetail;

    add(detail, 'h3', node.name).tabIndex = -1;
    add(detail, 'p', node.duty);
    add(detail, 'small', [
      node.registeredName !== node.name && node.registeredName,
      triggers[node.trigger], node.engine,
      node.availability === 'soon' && '规划中',
    ].filter(Boolean).join(' · '), 'map-meta');
    if (node.key === 'cityverse' || node.key.startsWith('cv:')) renderProjectDetail(node);

    if (!node.stage && (active.length || !node.key.startsWith('cv:'))) add(detail, 'h4', '当前任务');
    if (active.length) {
      const list = add(detail, 'ul', '', 'map-list');
      active.forEach(run => {
        const item = add(list, 'li');
        add(item, 'strong', run.title);
        add(item, 'small', [run.simulated ? '演练' : '', statuses[run.status], run.agent !== selected ? '交给 ' + nodeLabel(run.agent) : '',
          run.phase, run.engine, displayTime(run.startedAt)].filter(Boolean).join(' · '));
      });
    } else if (!node.stage && !node.key.startsWith('cv:')) {
      add(detail, 'p', connected ? '当前没有已接入的进行中记录。' : '连接桌面工作台后可查看执行记录。');
    }

    add(detail, 'h4', '实际协作记录');
    const linked = active.concat(recent).filter(run => interactions(run).some(([from, to]) => from === selected || to === selected));
    if (linked.length) {
      const list = add(detail, 'ul', '', 'map-list');
      linked.slice(0, 10).forEach(run => {
        const label = [run.title, statuses[run.status], run.simulated ? '演练' : '', displayTime(run.endedAt || run.startedAt)].filter(Boolean).join(' · ');
        interactions(run).forEach(([from, to, reason]) => {
          if (from === selected || to === selected) relationshipRow(list, from, to, [reason, label].filter(Boolean).join(' · '));
        });
      });
    } else add(detail, 'p', '暂无协作记录。');

    add(detail, 'h4', '职责上的协作路径');
    const configured = relations.filter(([from, to]) => (from === selected || to === selected)
      && nodes.some(n => n.key === from) && nodes.some(n => n.key === to));
    if (configured.length) {
      const list = add(detail, 'ul', '', 'map-list');
      configured.forEach(rel => relationshipRow(list, ...rel));
    } else add(detail, 'p', '暂无已确认的固定协作路径。');

    if (recent.length) {
      add(detail, 'h4', '近期活动');
      const list = add(detail, 'ul', '', 'map-list');
      recent.slice(0, 6).forEach(run => {
        const item = add(list, 'li', run.title);
        add(item, 'small', [run.source, statuses[run.status], run.simulated ? '演练' : '', displayTime(run.endedAt)].filter(Boolean).join(' · '));
      });
    }
  }

  function projectActivity(node) {
    if (!projectStatus?.online || !node.stage) return null;
    const fields = { approval: ['pendingApproval', 'waiting', '待审批'], execute: ['plansExecuting', 'running', '执行中'],
      gate: ['gatesReviewing', 'running', '审查中'] };
    const spec = fields[node.stage];
    if (!spec) return null;
    const [field, state, label] = spec;
    const count = projectStatus.active?.[field] || 0;
    return count ? { state, label: count + ' 条' + label } : null;
  }

  function renderProjectDetail(node) {
    add(detail, 'h4', 'CityVerse 控制台');
    if (!node.stage && node.key !== 'cityverse') {
      add(detail, 'p', '该角色的执行记录由项目侧管理，工作台尚未接入。');
      return;
    }
    if (!projectStatus?.online) {
      add(detail, 'p', projectStatus?.error || '等待连接本机项目控制台。');
      return;
    }
    if (node.key === 'cityverse') {
      add(detail, 'p', '已连接 · ' + projectStatus.plans + ' 条规划 · ' + projectStatus.plansPending + ' 条待审');
      return;
    }
    const live = projectActivity(node);
    add(detail, 'p', [live?.label, projectStatus[node.metric] + ' ' + node.unit].filter(Boolean).join(' · '));
    if (node.stage === 'approval' && api.cityversePendingPlans && window.openCvApprove) {
      const button = add(detail, 'button', '打开待审批清单', 'map-link');
      button.type = 'button';
      button.onclick = window.openCvApprove;
    }
    if (!stageRecords || stageRecords.key !== node.key) {
      add(detail, 'small', '正在读取阶段记录…');
      return;
    }
    if (stageRecords.error || !stageRecords.items.length) {
      add(detail, 'p', stageRecords.error || '暂无阶段记录。');
      return;
    }
    const list = add(detail, 'ul', '', 'map-list');
    stageRecords.items.forEach(item => {
      const row = add(list, 'li', item.title);
      if (item.status) add(row, 'small', statuses[item.status] || item.status);
    });
  }

  let stageInFlight = '';
  async function refreshStage() {
    const node = nodes.find(item => item.key === selected);
    if (!node?.stage || stageInFlight === node.key || !projectStatus?.online || !api?.cityverseStage) return;
    const request = ++stageRequest;
    stageInFlight = node.key;
    let result;
    try {
      result = await api.cityverseStage(node.stage);
    } catch {
      result = { error: '阶段记录暂时无法读取' };
    }
    if (request !== stageRequest) {
      if (stageInFlight === node.key) stageInFlight = '';
      return;
    }
    stageInFlight = '';
    stageRecords = { key: node.key, ...result };
    render();
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const layer = Number(layerSelect.value);
    function matches(node) {
      return (!activeFilter.checked || node.graphState === 'running' || node.graphState === 'waiting' || node.graphState === 'simulation')
        && [node.name, node.registeredName, node.duty].join(' ').toLowerCase().includes(query);
    }
    const items = nodes.map(node => {
      const relevant = snapshot.active.filter(run => touches(run, node.key));
      const executing = relevant.filter(run => run.status === 'running');
      const project = projectActivity(node);
      const graphState = project?.state || (executing.length ? (executing.some(run => !run.simulated) ? 'running' : 'simulation')
        : relevant.length ? 'waiting' : node.availability === 'soon' ? 'soon' : '');
      const graphLabel = project?.label || ({ running: '进行中', simulation: '演练中', waiting: '等待中', soon: '规划中' })[graphState];
      return { ...node, graphState, graphLabel };
    });
    graph.setData(items, graphEdges(items, snapshot.active, snapshot.recent, Date.now()), matches, selected, layer);
    empty.hidden = items.some(node => matches(node) && (layer < 0 || node.group in layers[layer].groups));

    const node = nodes.find(n => n.key === selected);
    const active = snapshot.active.filter(run => touches(run, selected));
    const recent = snapshot.recent.filter(run => touches(run, selected));
    const status = node && (node.key === 'cityverse' || node.key.startsWith('cv:'))
      ? [projectStatus?.online, projectStatus?.error, projectStatus?.[node.metric],
        projectStatus?.plans, projectStatus?.plansPending, projectActivity(node), stageRecords]
      : null;
    const version = JSON.stringify([node, active, recent, connected, status]);
    if (version !== detailVersion) {
      const focused = detail.contains(document.activeElement);
      detailVersion = version;
      renderDetail(node, active, recent);
      if (focused) detail.querySelector('h3')?.focus({ preventScroll: true });
    }
  }

  search.oninput = render;
  layerSelect.onchange = render;
  activeFilter.onchange = render;
  root.querySelector('#mapFit').onclick = graph.fit;
  root.querySelector('#mapReset').onclick = graph.reset;
  root.querySelector('#mapZoomIn').onclick = () => graph.zoom(1.25);
  root.querySelector('#mapZoomOut').onclick = () => graph.zoom(.8);
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && selected) closeDetail();
  });

  let polling = false;
  async function refresh() {
    if (polling || !root.getClientRects().length || !api?.archStatus) return;
    polling = true;
    try {
      snapshot = await api.archStatus();
      nodes = graphNodes(snapshot.nodes);
      connected = true;
      const time = new Date(snapshot.now).toLocaleTimeString('zh-CN');
      connection.textContent = '已读取本机注册表与执行记录 · ' + time;
    } catch {
      connected = false;
      snapshot = { ...snapshot, active: [] };
      connection.textContent = '读取失败，暂时无法确认当前执行状态';
    } finally {
      polling = false;
      render();
    }
  }

  let projectPolling = false;
  async function refreshProject() {
    if (projectPolling || !root.getClientRects().length || !api?.cityverseOverview) return;
    projectPolling = true;
    try {
      projectStatus = await api.cityverseOverview();
    } catch {
      projectStatus = { online: false, error: '无法读取 CityVerse 控制台' };
    } finally {
      projectPolling = false;
      render();
      refreshStage();
    }
  }

  if (api?.archStatus) {
    document.getElementById('tabArch')?.addEventListener('click', () => {
      refresh();
      refreshProject();
    });
    root.addEventListener('map:project-changed', refreshProject);
    refresh();
    refreshProject();
    setInterval(refresh, 2500);
    setInterval(refreshProject, 5000);
  } else connection.textContent = '架构预览 · 桌面工作台提供本机注册表与执行记录';
  render();
})();
