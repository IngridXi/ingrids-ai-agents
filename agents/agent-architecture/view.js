(function () {
  'use strict';

  const root = document.getElementById('agentArchitecture');
  if (!root) return;
  const { groups, inventory, relations } = window.AgentArchitecture;
  const api = window.ingrid;
  root.innerHTML = `
    <div class="map-header">
      <div><h2>工作台 Agent 架构</h2><p id="mapConnection" role="status">正在读取工作台…</p></div>
      <div class="map-controls">
        <input id="mapSearch" type="search" placeholder="搜索名称或职责" aria-label="搜索名称或职责">
        <label><input id="mapActive" type="checkbox"> 仅进行中</label>
      </div>
    </div>
    <div class="map-layout">
      <div id="mapGroups"></div>
      <aside id="mapDetail" class="map-detail" aria-label="节点详情"></aside>
    </div>`;

  const search = root.querySelector('#mapSearch');
  const activeFilter = root.querySelector('#mapActive');
  const connection = root.querySelector('#mapConnection');
  const roster = root.querySelector('#mapGroups');
  const detail = root.querySelector('#mapDetail');
  const statuses = { running: '运行中', waiting: '待确认', queued: '排队中', done: '已完成', failed: '失败', stopped: '已停止' };
  const triggers = { active: '定时／主动触发', chain: '链路接续', gap: '缺口触发', manual: '人工触发' };

  let snapshot = { nodes: inventory(), active: [], recent: [] };
  let connected = false;
  let selected = '';
  let rosterVersion = '';
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
    selected = key;
    render();
    if (bringIntoView && matchMedia('(max-width: 800px)').matches) detail.scrollIntoView({ block: 'nearest' });
  }

  function nodeLabel(key) {
    return snapshot.nodes.find(n => n.key === key)?.name || key;
  }

  function displayTime(value) {
    return value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  }

  function relationshipRow(parent, from, to, summary) {
    const row = add(parent, 'li');
    for (const [index, key] of [from, to].entries()) {
      if (index) add(row, 'span', ' → ');
      if (key === selected || !snapshot.nodes.some(n => n.key === key)) add(row, 'strong', nodeLabel(key));
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
    if (!node) {
      add(detail, 'h3', '节点详情');
      add(detail, 'p', '选择一个节点，查看职责、当前工作与协作。');
      return;
    }

    add(detail, 'h3', node.name).tabIndex = -1;
    add(detail, 'p', node.duty);
    add(detail, 'small', [
      node.registeredName !== node.name && node.registeredName,
      triggers[node.trigger], node.engine,
    ].filter(Boolean).join(' · '), 'map-meta');
    if (node.key === 'cityverse') {
      const project = document.getElementById('projView-cityverse');
      if (project) {
        const jump = add(detail, 'button', '查看 CityVerse 项目架构 ↓', 'map-link');
        jump.type = 'button';
        jump.onclick = () => project.scrollIntoView({ behavior: 'smooth' });
      }
    }

    add(detail, 'h4', '当前任务');
    if (active.length) {
      const list = add(detail, 'ul', '', 'map-list');
      active.forEach(run => {
        const item = add(list, 'li');
        add(item, 'strong', run.title);
        add(item, 'small', [run.simulated ? '演练' : '', statuses[run.status], run.agent !== selected ? '交给 ' + nodeLabel(run.agent) : '',
          run.phase, run.engine, displayTime(run.startedAt)].filter(Boolean).join(' · '));
      });
    } else {
      add(detail, 'p', connected ? '当前没有已接入的进行中记录。' : '连接桌面工作台后可查看执行记录。');
    }

    add(detail, 'h4', '实际协作记录');
    const linked = active.concat(recent).filter(run => run.from || run.handoff);
    if (linked.length) {
      const list = add(detail, 'ul', '', 'map-list');
      linked.slice(0, 10).forEach(run => {
        const label = [run.title, statuses[run.status], run.simulated ? '演练' : '', displayTime(run.endedAt || run.startedAt)].filter(Boolean).join(' · ');
        if (run.from && (run.from === selected || run.agent === selected)) relationshipRow(list, run.from, run.agent, label);
        if (run.handoff && (run.handoff === selected || run.agent === selected)) relationshipRow(list, run.handoff, run.agent, '上一步结果交接 · ' + label);
      });
    } else add(detail, 'p', '暂无协作记录。');

    add(detail, 'h4', '职责上的协作路径');
    const configured = relations.filter(([from, to]) => (from === selected || to === selected)
      && snapshot.nodes.some(n => n.key === from) && snapshot.nodes.some(n => n.key === to));
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

  function render() {
    const query = search.value.trim().toLowerCase();
    const visible = snapshot.nodes.map(node => {
      const relevant = snapshot.active.filter(run => touches(run, node.key));
      return { node, count: relevant.length, running: relevant.some(run => run.status === 'running') };
    }).filter(({ node, count }) => (!activeFilter.checked || count)
      && [node.name, node.registeredName, node.duty].join(' ').toLowerCase().includes(query));
    const key = JSON.stringify([visible, selected]);
    if (key !== rosterVersion) {
      const focused = document.activeElement?.dataset.mapKey;
      rosterVersion = key;
      roster.replaceChildren();
      for (const [group, title] of Object.entries(groups)) {
        const rows = visible.filter(item => item.node.group === group);
        if (!rows.length) continue;
        const section = add(roster, 'section', '', 'map-group');
        section.dataset.group = group;
        add(section, 'h3', title);
        const grid = add(section, 'div', '', 'map-grid');
        for (const { node, count, running } of rows) {
          const button = add(grid, 'button', '', 'map-node');
          button.type = 'button';
          button.dataset.mapKey = node.key;
          button.setAttribute('aria-pressed', String(node.key === selected));
          button.onclick = () => select(node.key, true);
          add(button, 'strong', node.name);
          add(button, 'span', node.duty);
          const state = count ? (running ? '进行中' : '等待中') + ' · ' + count
            : node.availability === 'soon' ? '尚未启用' : '';
          if (state) add(button, 'small', state, count ? 'map-running' : '');
          if (focused === node.key) button.focus({ preventScroll: true });
        }
      }
      if (!visible.length) add(roster, 'p', '没有符合条件的节点。');
    }

    const node = snapshot.nodes.find(n => n.key === selected);
    const active = snapshot.active.filter(run => touches(run, selected));
    const recent = snapshot.recent.filter(run => touches(run, selected));
    const version = JSON.stringify([node, active, recent, connected]);
    if (version !== detailVersion) {
      const restoreFocus = detail.contains(document.activeElement);
      detailVersion = version;
      renderDetail(node, active, recent);
      if (restoreFocus) detail.querySelector('h3').focus({ preventScroll: true });
    }
  }

  search.oninput = render;
  activeFilter.onchange = render;
  let polling = false;
  async function refresh() {
    if (polling || !root.getClientRects().length || !api?.archStatus) return;
    polling = true;
    try {
      snapshot = await api.archStatus();
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

  if (api?.archStatus) {
    document.getElementById('tabArch')?.addEventListener('click', refresh);
    refresh();
    setInterval(refresh, 2500);
  } else connection.textContent = '架构预览 · 桌面工作台提供本机注册表与执行记录';
  render();
})();
