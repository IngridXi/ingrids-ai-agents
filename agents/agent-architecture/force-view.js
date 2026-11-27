(function () {
  'use strict';

  const NODE_WIDTH = 177;
  const NODE_HEIGHT = 33;
  const DOT_OFFSET = 15 - NODE_WIDTH / 2;
  const COLUMN = 193;
  const ROW = 51;
  const GAP = 14;
  const MAX_ROWS = 5;
  const strokes = {
    configured: { color: '#8d9c9b', width: 1, dash: [] },
    running: { color: '#b45912', width: 2.7, dash: [] },
    recent: { color: '#137c72', width: 2, dash: [] },
    simulation: { color: '#7650ad', width: 1.7, dash: [5, 4] },
  };

  function createGraph(viewport, layers, onSelect) {
    const canvas = viewport.querySelector('canvas');
    const world = viewport.querySelector('.map-world');
    const context = canvas.getContext('2d');
    const camera = { x: 0, y: 0, scale: 1 };
    const nodes = new Map();
    const groupOrder = layers.flatMap(layer => Object.keys(layer.groups));
    let bands = [];
    let edges = [];
    let visible = new Set();
    let selected = '';
    let hovered = '';
    let layerFilter = -1;
    let width = 0;
    let height = 0;
    let frame = 0;
    let ticks = 0;
    let drag = null;
    let suppressClick = false;

    function requestDraw(steps = 0) {
      ticks = Math.max(steps, ticks);
      if (!frame) frame = requestAnimationFrame(draw);
    }

    function layout(resetPositions) {
      const rowsByLayer = layers.map(({ groups }) => Object.entries(groups).map(([key, title]) => {
        const members = Array.from(nodes.values()).filter(node => node.group === key);
        const cols = Math.max(1, Math.ceil(members.length / MAX_ROWS));
        return { title, members, width: cols * COLUMN, rows: Math.ceil(members.length / cols) };
      }).filter(group => group.members.length));
      const totalWidth = Math.max(450, ...rowsByLayer.map(groups =>
        groups.reduce((sum, group) => sum + group.width + GAP, GAP)));
      let y = 0;
      bands = layers.map((layer, index) => {
        const groups = rowsByLayer[index];
        const tall = Math.max(1, ...groups.map(group => group.rows));
        const band = { ...layer, x: 0, y, width: totalWidth, height: 69 + tall * ROW, items: groups };
        const groupsWidth = groups.reduce((sum, group) => sum + group.width + GAP, -GAP);
        let x = (totalWidth - groupsWidth) / 2;
        for (const group of groups) {
          group.x = x;
          group.y = y + 48;
          group.height = band.height - 55;
          group.members.forEach((node, i) => {
            const ax = x + COLUMN / 2 + Math.floor(i / group.rows) * COLUMN + (i % 2 ? 5 : -5);
            const ay = group.y + 40 + (i % group.rows) * ROW + (i % 3 - 1) * 4;
            if (resetPositions || node.x == null || Math.abs(node.ax - ax) > 1 || Math.abs(node.ay - ay) > 1) {
              node.x = ax;
              node.y = ay;
              node.vx = 0;
              node.vy = 0;
              node.pinned = false;
            }
            Object.assign(node, { ax, ay, band: index, color: layer.color });
            node.button.style.setProperty('--node-color', layer.color);
          });
          x += group.width + GAP;
        }
        y += band.height + GAP;
        return band;
      });
    }

    function physics() {
      const items = Array.from(nodes.values());
      for (const node of items) {
        node.vx += (node.ax - node.x) * .075;
        node.vy += (node.ay - node.y) * .075;
      }
      for (let i = 0; i < items.length; i++) {
        const a = items[i];
        for (let j = i + 1; j < items.length; j++) {
          const b = items[j];
          if (a.band !== b.band) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const overlapX = NODE_WIDTH + 8 - Math.abs(dx);
          const overlapY = NODE_HEIGHT + 9 - Math.abs(dy);
          if (overlapX <= 0 || overlapY <= 0) continue;
          if (overlapX < overlapY) {
            const force = overlapX * .10 * (dx < 0 ? -1 : 1);
            a.vx -= force;
            b.vx += force;
          } else {
            const force = overlapY * .13 * (dy < 0 ? -1 : 1);
            a.vy -= force;
            b.vy += force;
          }
        }
      }
      for (const edge of edges) {
        const a = nodes.get(edge.from);
        const b = nodes.get(edge.to);
        if (!a || !b || a.group !== b.group) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 1;
        const pull = Math.min(.075, Math.max(-.06, (distance - 115) * .00065));
        a.vx += dx * pull;
        a.vy += dy * pull;
        b.vx -= dx * pull;
        b.vy -= dy * pull;
      }
      for (const node of items) {
        if (node.pinned) {
          node.vx = 0;
          node.vy = 0;
        } else {
          node.vx *= .72;
          node.vy *= .72;
          node.x = Math.max(node.ax - 11, Math.min(node.ax + 11, node.x + node.vx));
          node.y = Math.max(node.ay - 14, Math.min(node.ay + 14, node.y + node.vy));
        }
      }
    }

    function fit() {
      if (!width || !height || !bands.length) return;
      const first = bands[layerFilter < 0 ? 0 : layerFilter];
      const last = bands[layerFilter < 0 ? bands.length - 1 : layerFilter];
      const contentHeight = last.y + last.height - first.y;
      camera.scale = Math.min(1.06, (width - 24) / first.width, (height - 24) / contentHeight);
      camera.x = (width - first.width * camera.scale) / 2;
      camera.y = (height - contentHeight * camera.scale) / 2 - first.y * camera.scale;
      requestDraw();
    }

    function frameLabel(text, x, y, color, font) {
      context.fillStyle = color;
      context.font = font;
      context.fillText(text, x, y);
    }

    function drawEdge(edge, focused) {
      const a = nodes.get(edge.from);
      const b = nodes.get(edge.to);
      if (!a || !b || !visible.has(a.key) || !visible.has(b.key)) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 26) return;
      const boundary = 10 / distance;
      const sx = a.x + DOT_OFFSET + dx * boundary;
      const sy = a.y + dy * boundary;
      const tx = b.x + DOT_OFFSET - dx * boundary;
      const ty = b.y - dy * boundary;
      const close = edge.from === focused || edge.to === focused;
      const style = strokes[edge.state];
      context.globalAlpha = focused && !close ? .20 : (edge.state === 'configured' ? .65 : 1);
      context.strokeStyle = style.color;
      context.lineWidth = (style.width + (close ? .85 : 0)) / camera.scale;
      context.setLineDash(style.dash);
      context.beginPath();
      context.moveTo(sx, sy);
      const bend = Math.abs(tx - sx) > 22 && Math.abs(ty - sy) > 28;
      if (bend) {
        const curve = 18 * Math.sign(dy);
        context.bezierCurveTo(sx + (tx - sx) / 3, sy + curve, tx - (tx - sx) / 3, ty + curve, tx, ty);
      }
      else context.lineTo(tx, ty);
      context.stroke();
      context.setLineDash([]);

      const angle = bend ? Math.atan2(-18 * Math.sign(dy), (tx - sx) / 3) : Math.atan2(dy, dx);
      const size = (edge.state === 'configured' ? 5 : 7) / camera.scale;
      context.fillStyle = style.color;
      context.beginPath();
      context.moveTo(tx, ty);
      context.lineTo(tx - size * Math.cos(angle - .5), ty - size * Math.sin(angle - .5));
      context.lineTo(tx - size * Math.cos(angle + .5), ty - size * Math.sin(angle + .5));
      context.closePath();
      context.fill();
    }

    function draw() {
      frame = 0;
      if (!width || !height) return;
      if (ticks > 0) {
        physics();
        ticks--;
      }
      const dpr = window.devicePixelRatio || 1;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.translate(camera.x, camera.y);
      context.scale(camera.scale, camera.scale);
      context.textBaseline = 'top';
      bands.forEach((band, index) => {
        if (layerFilter >= 0 && layerFilter !== index) return;
        context.globalAlpha = .08;
        context.fillStyle = band.color;
        context.beginPath();
        context.roundRect(0, band.y, band.width, band.height, 15);
        context.fill();
        context.globalAlpha = 1;
        frameLabel((index + 1) + ' · ' + band.name, 16, band.y + 12, band.color, '700 19px system-ui');
        for (const group of band.items) {
          context.strokeStyle = band.color + '32';
          context.strokeRect(group.x, group.y - 12, group.width, group.height + 10);
          frameLabel(group.title, group.x + 9, group.y - 4, band.color, '600 14px system-ui');
        }
      });

      const focused = hovered || selected;
      const neighbors = new Set([focused]);
      for (const edge of edges) {
        if (edge.from === focused) neighbors.add(edge.to);
        if (edge.to === focused) neighbors.add(edge.from);
        if (edge.state === 'configured') drawEdge(edge, focused);
      }
      for (const edge of edges) {
        if (edge.state !== 'configured') drawEdge(edge, focused);
      }
      context.globalAlpha = 1;
      world.style.transform = 'translate(' + camera.x + 'px,' + camera.y + 'px) scale(' + camera.scale + ')';
      for (const node of nodes.values()) {
        node.button.hidden = !visible.has(node.key);
        node.button.style.transform = 'translate(' + (node.x - NODE_WIDTH / 2) + 'px,' + (node.y - NODE_HEIGHT / 2) + 'px)';
        node.button.classList.toggle('is-muted', !!hovered && !neighbors.has(node.key));
      }
      if (ticks > 0) requestDraw();
    }

    function setData(items, nextEdges, matches, selection, filter) {
      const nextKeys = new Set(items.map(node => node.key));
      let changed = nodes.size !== items.length;
      for (const [key, node] of nodes) {
        if (!nextKeys.has(key)) {
          node.button.remove();
          nodes.delete(key);
          changed = true;
        }
      }
      for (const item of items) {
        let node = nodes.get(item.key);
        if (!node) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'map-graph-node';
          button.dataset.mapKey = item.key;
          button.append(document.createElement('i'), document.createElement('span'));
          button.onclick = event => {
            if (!suppressClick || event.detail === 0) onSelect(item.key);
            suppressClick = false;
          };
          world.append(button);
          node = { button };
          nodes.set(item.key, node);
          changed = true;
        }
        if (node.group !== item.group) changed = true;
        Object.assign(node, item);
        const button = node.button;
        button.querySelector('span').textContent = item.name;
        button.dataset.kind = item.kind;
        button.dataset.state = item.graphState || '';
        button.setAttribute('aria-pressed', String(selection === item.key));
        button.title = [item.name, item.duty, item.graphLabel].filter(Boolean).join('\n');
      }
      const nextEdgesKey = JSON.stringify(nextEdges.map(({ from, to, state }) => [from, to, state]));
      const edgeChanged = nextEdgesKey !== JSON.stringify(edges.map(({ from, to, state }) => [from, to, state]));
      const filterChanged = filter !== layerFilter;
      selected = selection;
      layerFilter = filter;
      edges = nextEdges;
      if (changed) {
        const focused = document.activeElement;
        Array.from(nodes.values()).sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group))
          .forEach(node => world.append(node.button));
        if (world.contains(focused)) focused.focus({ preventScroll: true });
        layout(false);
      }
      visible = new Set(items.filter(item => matches(item) && (filter < 0 || nodes.get(item.key).band === filter)).map(item => item.key));
      if (!visible.has(hovered)) hovered = '';
      if (changed || filterChanged) fit();
      requestDraw(changed || edgeChanged ? 55 : 0);
    }

    function zoom(scale, x = width / 2, y = height / 2) {
      const next = Math.max(.23, Math.min(2.75, camera.scale * scale));
      const ratio = next / camera.scale;
      camera.x = x - (x - camera.x) * ratio;
      camera.y = y - (y - camera.y) * ratio;
      camera.scale = next;
      requestDraw();
    }

    const size = new ResizeObserver(() => {
      width = viewport.clientWidth;
      height = viewport.clientHeight;
      if (!width || !height) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      fit();
    });
    size.observe(viewport);

    viewport.addEventListener('wheel', event => {
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - bounds.left, event.clientY - bounds.top);
    }, { passive: false });
    viewport.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return;
      suppressClick = false;
      const node = nodes.get(event.target.closest('[data-map-key]')?.dataset.mapKey);
      drag = { id: event.pointerId, node, x: event.clientX, y: event.clientY, moved: false };
    });
    viewport.addEventListener('pointermove', event => {
      const key = event.target.closest('[data-map-key]')?.dataset.mapKey || '';
      if (!drag || drag.id !== event.pointerId) {
        if (key !== hovered) {
          hovered = key;
          requestDraw();
        }
        return;
      }
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        viewport.setPointerCapture(event.pointerId);
        viewport.classList.add('is-dragging');
      }
      if (drag.node) {
        const node = drag.node;
        const band = bands[node.band];
        node.pinned = true;
        node.x = Math.max(NODE_WIDTH / 2, Math.min(band.width - NODE_WIDTH / 2, node.x + dx / camera.scale));
        node.y = Math.max(band.y + 57, Math.min(band.y + band.height - NODE_HEIGHT / 2, node.y + dy / camera.scale));
      } else {
        camera.x += dx;
        camera.y += dy;
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
      requestDraw(drag.node ? 35 : 0);
    });

    function endDrag(event) {
      if (drag?.id !== event.pointerId) return;
      suppressClick = drag.moved;
      drag = null;
      viewport.classList.remove('is-dragging');
    }
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('pointerleave', () => {
      if (!drag?.moved) drag = null;
      hovered = '';
      requestDraw();
    });
    viewport.addEventListener('focusin', event => {
      const node = nodes.get(event.target.dataset.mapKey);
      if (!node) return;
      const x = node.x * camera.scale + camera.x;
      const y = node.y * camera.scale + camera.y;
      if (x < 0 || x > width || y < 0 || y > height) {
        camera.x += width / 2 - x;
        camera.y += height / 2 - y;
        requestDraw();
      }
    });

    return {
      setData, fit, zoom,
      reset() { layout(true); fit(); requestDraw(100); },
    };
  }

  window.createLayeredAgentGraph = createGraph;
})();
