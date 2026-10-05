/**
 * WebUI 前端逻辑。
 *
 * 架构约定：
 * - **服务端是唯一事实来源**。前端不自己维护演出时钟，
 *   只负责播放音频并把 `audio.currentTime` 回报给服务端做漂移校正。
 *   这样「观众听到的」与「推 cue 的时刻」锚定在同一时间原点（需求 R4.2）。
 * - 状态经 SSE 推送，前端只做渲染。
 */

const $ = (sel) => document.querySelector(sel);

let state = null;
let selectedCueIds = new Set();
let firedRecently = new Map(); // cueId -> 时间戳，用于按钮反馈
/**
 * 播放头元素引用。
 *
 * ⚠️ 刻意缓存引用而不是每次 getElementById：
 * 位置事件约 20Hz，每秒查 20 次 DOM 纯属浪费。
 * （另外这也让"元素是否已创建"变成一个显式的 null 判断。）
 */
let playheadEl = null;

// ── 工具 ──────────────────────────────────────────────────────────────────

function fmtMs(ms) {
  const safe = Math.max(0, Math.round(ms ?? 0));
  const totalSec = Math.floor(safe / 1000);
  const millis = safe % 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

// ── 标签页 ────────────────────────────────────────────────────────────────

document.querySelectorAll('nav.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach((b) => {
      b.setAttribute('aria-selected', String(b === btn));
    });
    document.querySelectorAll('section[role="tabpanel"]').forEach((sec) => {
      sec.classList.toggle('active', sec.id === `tab-${btn.dataset.tab}`);
    });
  });
});

// ── 顶栏 ──────────────────────────────────────────────────────────────────

function renderHeader() {
  const c = state.connection;
  const dot = $('#conn-status .dot');
  const label = $('#conn-status span:last-child');
  dot.className = `dot ${c.connected ? 'ok' : c.lastError ? 'bad' : ''}`;
  label.textContent = c.connected
    ? `已连接 ${c.mode === 'sim' ? '（模拟器）' : ''}`
    : c.lastError
      ? '连接失败'
      : '未连接';
  $('#show-name').textContent = c.connected && c.showName ? c.showName : '';

  const detail = $('#conn-detail');
  detail.innerHTML = '';
  const rows = [
    ['模式', c.mode],
    ['地址', c.baseUrl ?? '—'],
    ['Titan 版本', c.version ?? '—'],
    ['Show', c.showName ?? '—'],
    ['加载状态', c.loadState ?? '—'],
    ['levelDelta 拼写', c.levelDeltaSpelling === 'camel' ? '大写 D（默认）' : (c.levelDeltaSpelling ?? '—')],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = String(v);
    detail.append(dt, dd);
  }
  if (c.lastError) {
    const dt = document.createElement('dt');
    dt.textContent = '错误';
    const dd = document.createElement('dd');
    dd.style.color = 'var(--danger)';
    dd.textContent = c.lastError;
    detail.append(dt, dd);
  }
}

// ── 散 cue 库渲染 ─────────────────────────────────────────────────────────

function cuePlacementText(cue) {
  return `${cue.placement.group} · P${cue.placement.page} · ${cue.placement.index}`;
}

/** 演出域：大按钮网格 */
function renderPerformCueBank() {
  const root = $('#perform-cuebank');
  root.innerHTML = '';
  const pages = state.cueBank.pages;

  if (pages.every((p) => p.cues.length === 0)) {
    root.innerHTML = '<div class="empty">散 cue 库是空的 —— 到「准备」域添加。</div>';
    return;
  }

  for (const page of pages) {
    if (page.cues.length === 0) continue;
    const wrap = document.createElement('div');
    wrap.className = 'cue-page';

    const head = document.createElement('header');
    head.innerHTML = `<span>第 ${page.page} 页 · ${escapeHtml(page.name)}</span>
      <span class="meta">${page.cues.length} 个</span>`;
    wrap.append(head);

    const grid = document.createElement('div');
    grid.className = 'cue-grid';

    for (const cue of page.cues) {
      const btn = document.createElement('button');
      btn.className = 'cue-btn';
      btn.dataset.cueId = cue.id;
      if (firedRecently.has(cue.id)) btn.classList.add('fired');
      if (selectedCueIds.has(cue.id)) btn.classList.add('selected');
      btn.innerHTML = `
        <span class="name">${escapeHtml(cue.name)}</span>
        <span class="sub">${escapeHtml(cuePlacementText(cue))}${
          cue.tags?.length ? ' · ' + escapeHtml(cue.tags.join('/')) : ''
        }</span>`;

      btn.addEventListener('click', async (ev) => {
        try {
          if (ev.shiftKey) {
            await post('/api/cuebank/kill', { id: cue.id });
            toast(`熄灭：${cue.name}`);
          } else {
            await post('/api/cuebank/fire', { id: cue.id, level: cue.defaultLevel });
            firedRecently.set(cue.id, Date.now());
            renderPerformCueBank();
            setTimeout(() => {
              firedRecently.delete(cue.id);
              renderPerformCueBank();
            }, 600);
          }
        } catch (e) {
          toast(`操作失败：${e.message}`, 'error');
        }
      });

      // 长按 = 加入/移出「标记选择集」
      let holdTimer = null;
      btn.addEventListener('pointerdown', () => {
        holdTimer = setTimeout(() => {
          holdTimer = null;
          toggleSelected(cue.id);
        }, 550);
      });
      for (const evName of ['pointerup', 'pointerleave', 'pointercancel']) {
        btn.addEventListener(evName, () => {
          if (holdTimer) clearTimeout(holdTimer);
          holdTimer = null;
        });
      }

      grid.append(btn);
    }
    wrap.append(grid);
    root.append(wrap);
  }
}

function toggleSelected(cueId) {
  if (selectedCueIds.has(cueId)) selectedCueIds.delete(cueId);
  else selectedCueIds.add(cueId);
  $('#selected-count').textContent = `已选 ${selectedCueIds.size} 个用于标记`;
  renderPerformCueBank();
}

/** 准备域：可编辑的散 cue 表 */
function renderCueBankEditor() {
  const root = $('#cuebank-editor');
  root.innerHTML = '';
  if (state.cueBank.pages.every((p) => p.cues.length === 0)) {
    root.innerHTML = '<div class="empty">还没有散 cue。</div>';
    return;
  }

  for (const page of state.cueBank.pages) {
    const card = document.createElement('div');
    card.style.marginBottom = '14px';
    const h = document.createElement('h3');
    h.textContent = `第 ${page.page} 页 · ${page.name}`;
    h.style.marginTop = '0';
    card.append(h);

    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>
      <th>名称</th><th class="mono">落位</th>
      <th class="mono">淡入/淡出</th><th class="mono">电平</th>
      <th>标签</th><th></th></tr></thead>`;
    const tbody = document.createElement('tbody');

    for (const cue of page.cues) {
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = cue.name;
      nameInput.style.width = '100%';
      nameInput.addEventListener('change', () => updateCue(cue.id, { name: nameInput.value }));
      nameTd.append(nameInput);

      const placeTd = document.createElement('td');
      placeTd.className = 'mono';
      placeTd.textContent = cuePlacementText(cue);

      const timesTd = document.createElement('td');
      timesTd.className = 'mono';
      const fadeIn = document.createElement('input');
      fadeIn.type = 'number';
      fadeIn.value = cue.times.fadeInMs;
      fadeIn.step = 100;
      fadeIn.style.width = '82px';
      fadeIn.addEventListener('change', () =>
        updateCue(cue.id, { times: { ...cue.times, fadeInMs: Number(fadeIn.value) } }),
      );
      const slash = document.createTextNode(' / ');
      const fadeOut = document.createElement('input');
      fadeOut.type = 'number';
      fadeOut.value = cue.times.fadeOutMs;
      fadeOut.step = 100;
      fadeOut.style.width = '82px';
      fadeOut.addEventListener('change', () =>
        updateCue(cue.id, { times: { ...cue.times, fadeOutMs: Number(fadeOut.value) } }),
      );
      timesTd.append(fadeIn, slash, fadeOut);

      const levelTd = document.createElement('td');
      const levelInput = document.createElement('input');
      levelInput.type = 'number';
      levelInput.min = '0';
      levelInput.max = '1';
      levelInput.step = '0.05';
      levelInput.value = cue.defaultLevel;
      levelInput.style.width = '76px';
      levelInput.addEventListener('change', () =>
        updateCue(cue.id, { defaultLevel: Number(levelInput.value) }),
      );
      levelTd.append(levelInput);

      const tagsTd = document.createElement('td');
      const tagsInput = document.createElement('input');
      tagsInput.type = 'text';
      tagsInput.value = (cue.tags ?? []).join(',');
      tagsInput.style.width = '120px';
      tagsInput.addEventListener('change', () =>
        updateCue(cue.id, {
          tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
        }),
      );
      tagsTd.append(tagsInput);

      const actTd = document.createElement('td');
      const fireBtn = document.createElement('button');
      fireBtn.className = 'btn';
      fireBtn.textContent = '试推';
      fireBtn.addEventListener('click', async () => {
        try {
          await post('/api/cuebank/fire', { id: cue.id, level: cue.defaultLevel });
          toast(`试推：${cue.name}`, 'ok');
        } catch (e) {
          toast(e.message, 'error');
        }
      });
      const delBtn = document.createElement('button');
      delBtn.className = 'btn danger';
      delBtn.textContent = '删除';
      delBtn.style.marginLeft = '6px';
      delBtn.addEventListener('click', async () => {
        try {
          await api(`/api/cuebank/cue?id=${encodeURIComponent(cue.id)}`, { method: 'DELETE' });
          toast(`已删除：${cue.name}`, 'ok');
        } catch (e) {
          toast(e.message, 'error');
        }
      });
      actTd.append(fireBtn, delBtn);

      tr.append(nameTd, placeTd, timesTd, levelTd, tagsTd, actTd);
      tbody.append(tr);
    }
    table.append(tbody);
    card.append(table);
    root.append(card);
  }
}

async function updateCue(id, patch) {
  try {
    await post('/api/cuebank/cue', { id, ...patch });
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── 卡点表 ────────────────────────────────────────────────────────────────

function cueName(id) {
  for (const page of state.cueBank.pages) {
    const hit = page.cues.find((c) => c.id === id);
    if (hit) return hit.name;
  }
  return id;
}

function renderSongSelect() {
  const sel = $('#song-select');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const song of state.songs) {
    const opt = document.createElement('option');
    opt.value = song.id;
    opt.textContent = `${song.name}（${song.marks.length} 个卡点）`;
    sel.append(opt);
  }
  sel.value = state.currentSongId ?? prev ?? '';
}

function renderMarksEditor() {
  const song = state.songs.find((s) => s.id === state.currentSongId);
  const root = $('#marks-editor');
  root.innerHTML = '';
  if (!song) {
    root.innerHTML = '<div class="empty">尚未选择曲目。</div>';
    return;
  }
  $('#song-audio').value = song.audioPath ?? '';
  $('#song-duration').value = Math.round((song.durationMs ?? 0) / 1000);

  if (song.marks.length === 0) {
    root.innerHTML = '<div class="empty">还没有卡点 —— 演出域点「在此刻标记」，或在这里添加。</div>';
  } else {
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>
      <th class="mono">时刻</th><th>散 cue</th><th class="mono">电平</th>
      <th>备注</th><th></th></tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const mark of [...song.marks].sort((a, b) => a.tMs - b.tMs)) {
      const tr = document.createElement('tr');

      const tTd = document.createElement('td');
      tTd.className = 'mono';
      const tInput = document.createElement('input');
      tInput.type = 'number';
      tInput.value = mark.tMs;
      tInput.step = 10;
      tInput.style.width = '110px';
      tInput.addEventListener('change', () => {
        mark.tMs = Number(tInput.value);
        void saveSong(song);
      });
      tTd.append(tInput, document.createTextNode(' ms'));

      const cueTd = document.createElement('td');
      cueTd.textContent = mark.cueIds.map(cueName).join(' + ');

      const lvlTd = document.createElement('td');
      lvlTd.className = 'mono';
      const lvlInput = document.createElement('input');
      lvlInput.type = 'number';
      lvlInput.min = '0';
      lvlInput.max = '1';
      lvlInput.step = '0.05';
      lvlInput.value = mark.level;
      lvlInput.style.width = '76px';
      lvlInput.addEventListener('change', () => {
        mark.level = Number(lvlInput.value);
        void saveSong(song);
      });
      lvlTd.append(lvlInput);

      const noteTd = document.createElement('td');
      const noteInput = document.createElement('input');
      noteInput.type = 'text';
      noteInput.value = mark.note ?? '';
      noteInput.style.width = '100%';
      noteInput.addEventListener('change', () => {
        mark.note = noteInput.value;
        void saveSong(song);
      });
      noteTd.append(noteInput);

      const actTd = document.createElement('td');
      const del = document.createElement('button');
      del.className = 'btn danger';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        await api(`/api/show/marks?id=${encodeURIComponent(mark.id)}`, { method: 'DELETE' });
      });
      actTd.append(del);

      tr.append(tTd, cueTd, lvlTd, noteTd, actTd);
      tbody.append(tr);
    }
    table.append(tbody);
    root.append(table);
  }

  $('#offset-input').value = song.offsetMs ?? 0;
  $('#now-playing').textContent = song.name;
}

async function saveSong(song) {
  try {
    await post('/api/songs', song);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── 演出域渲染 ────────────────────────────────────────────────────────────

function renderTransport() {
  const t = state.transport;
  $('#clock-pos').textContent = fmtMs(t.positionMs);
  $('#clock-state').textContent = t.running ? '播放中' : '已停止';
  $('#clock-state').style.color = t.running ? 'var(--ok)' : 'var(--fg-dim)';

  if (t.nextMark) {
    const delta = t.nextMark.tMs - t.positionMs;
    $('#clock-next').textContent = `下一个卡点 ${fmtMs(t.nextMark.tMs)}（${
      delta >= 0 ? '还有 ' : '已过 '
    }${fmtMs(Math.abs(delta))}）${t.nextMark.note ? ' · ' + t.nextMark.note : ''}`;
  } else {
    $('#clock-next').textContent = t.durationMs ? '本曲卡点已走完' : '';
  }

  const pct = t.durationMs > 0 ? Math.min(100, (t.positionMs / t.durationMs) * 100) : 0;
  $('#progress-fill').style.width = `${pct}%`;

  $('#btn-play').disabled = t.running;
  $('#btn-pause').disabled = !t.running;
}

function renderRuler() {
  const song = state.songs.find((s) => s.id === state.currentSongId);
  const ruler = $('#ruler');
  ruler.innerHTML = '';
  playheadEl = null; // 旧元素已随 innerHTML 清空失效
  if (!song || song.durationMs <= 0) return;

  for (const mark of song.marks) {
    const t = mark.tMs + (song.offsetMs ?? 0);
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = `${Math.min(100, (t / song.durationMs) * 100)}%`;
    tick.title = `${fmtMs(t)} ${mark.note ?? ''}`;
    ruler.append(tick);
  }
  const head = document.createElement('div');
  head.className = 'playhead';
  head.id = 'playhead';
  head.style.left = '0%';
  ruler.append(head);
  playheadEl = head;

  ruler.onclick = async (ev) => {
    const rect = ruler.getBoundingClientRect();
    const frac = (ev.clientX - rect.left) / rect.width;
    try {
      await post('/api/show/seek', { toMs: frac * song.durationMs });
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

function renderStats() {
  const s = state.stats;
  const root = $('#stats');
  const items = [
    ['自动触发次数', s.count],
    ['人工触发次数', s.manualCount],
    ['平均偏差', `${s.meanLatenessMs.toFixed(1)} ms`],
    ['最大偏差', `${s.maxLatenessMs.toFixed(1)} ms`],
    ['±20ms 命中', s.count ? `${s.within20ms}/${s.count}` : '—'],
    ['±50ms 命中', s.count ? `${s.within50ms}/${s.count}` : '—'],
  ];
  root.innerHTML = items
    .map(
      ([label, value]) =>
        `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`,
    )
    .join('');

  const body = $('#hit-body');
  body.innerHTML = '';
  for (const hit of [...state.recentHits].reverse()) {
    const tr = document.createElement('tr');
    if (!hit.manual && Math.abs(hit.latenessMs) > 50) tr.className = 'late-bad';
    tr.innerHTML = `
      <td class="mono">${new Date(hit.at).toLocaleTimeString('zh-CN')}</td>
      <td class="mono">${fmtMs(hit.scheduledMs)}</td>
      <td class="mono">${fmtMs(hit.actualMs)}</td>
      <td class="mono lateness">${hit.manual ? '—' : (hit.latenessMs >= 0 ? '+' : '') + hit.latenessMs.toFixed(0) + ' ms'}</td>
      <td>${escapeHtml(cueName(hit.cueId))}</td>
      <td>${hit.manual ? '<span class="badge">人工</span>' : '<span class="badge ok">自动</span>'}</td>
      <td>${escapeHtml(hit.note ?? '')}</td>`;
    body.append(tr);
  }
  if (state.recentHits.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="empty">还没有触发记录。</td></tr>';
  }
}

// ── 结构体检（R2） ────────────────────────────────────────────────────────

const SEVERITY_LABEL = { high: '严重', medium: '中等', low: '提示' };

function renderAnalysis() {
  const root = $('#analysis-result');
  const report = state.analysis;
  if (!report) {
    root.innerHTML =
      '<div class="empty">还没有体检过 —— 连接控台后点上面的「读取并体检」。</div>';
    $('#btn-cuesheet').disabled = true;
    return;
  }
  $('#btn-cuesheet').disabled = false;

  const s = report.summary;
  const sev = report.countsBySeverity;
  const parts = [];

  parts.push(`<div class="stats" style="margin-bottom:14px">
    <div class="stat"><div class="label">灯具</div><div class="value">${s.fixtures}</div></div>
    <div class="stat"><div class="label">编组</div><div class="value">${s.groups}</div></div>
    <div class="stat"><div class="label">调色板</div><div class="value">${s.palettes}</div></div>
    <div class="stat"><div class="label">回放</div><div class="value">${s.playbacks}</div></div>
    <div class="stat"><div class="label">散 cue</div><div class="value">${s.memories}</div></div>
    <div class="stat"><div class="label">多步 cue list</div><div class="value">${s.cuelists}</div></div>
    <div class="stat"><div class="label">cue 总数</div><div class="value">${s.totalCues}</div></div>
    <div class="stat"><div class="label">读取往返次数</div><div class="value">${report.requestsUsed}</div></div>
  </div>`);

  parts.push(`<div class="row" style="margin-bottom:10px">
    <span class="badge ${sev.high ? 'bad' : ''}">严重 ${sev.high}</span>
    <span class="badge ${sev.medium ? 'warn' : ''}">中等 ${sev.medium}</span>
    <span class="badge">提示 ${sev.low}</span>
    <span class="badge" style="margin-left:auto">发现方式：${report.discovery === 'bulk' ? '批量句柄端点' : '不可用'}</span>
  </div>`);
  parts.push(`<p class="hint">${escapeHtml(report.discoveryNote)}</p>`);

  if (report.findings.length === 0) {
    parts.push('<div class="empty">没有发现结构性问题。</div>');
  } else {
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    for (const f of report.findings) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="badge ${f.severity === 'high' ? 'bad' : f.severity === 'medium' ? 'warn' : ''}">${
          SEVERITY_LABEL[f.severity]
        }</span></td>
        <td><b>${escapeHtml(f.title)}</b><br><span style="color:var(--fg-dim);font-size:13px">${escapeHtml(
          f.detail,
        )}</span></td>
        <td style="color:var(--fg-dim);font-size:13px">${escapeHtml(f.suggestion)}</td>
        <td class="mono" style="font-size:12px;color:var(--fg-faint)">${escapeHtml(f.where)}</td>`;
      tbody.append(tr);
    }
    table.innerHTML = `<thead><tr><th>级别</th><th>问题</th><th>建议</th><th>位置</th></tr></thead>`;
    table.append(tbody);
    const wrap = document.createElement('div');
    wrap.className = 'card';
    wrap.style.padding = '0';
    wrap.append(table);
    parts.push(wrap.outerHTML);
  }

  // 明确写出"做不到什么" —— 避免被误读为已全面检查
  parts.push(`<div class="card">
    <h3 style="margin-top:0">本次体检<u>不</u>包含</h3>
    <ul style="margin:0;padding-left:20px;color:var(--fg-dim);font-size:14px;line-height:1.9">
      ${report.limitations.map((l) => `<li>${escapeHtml(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`).join('')}
    </ul>
  </div>`);

  if (report.warnings.length > 0) {
    parts.push(`<div class="card">
      <h3 style="margin-top:0">读取过程中的提示</h3>
      <ul style="margin:0;padding-left:20px;color:var(--fg-dim);font-size:14px">
        ${report.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}
      </ul>
    </div>`);
  }

  root.innerHTML = parts.join('');
}

// ── 完整渲染 ──────────────────────────────────────────────────────────────

function renderAll() {
  renderHeader();
  renderPerformCueBank();
  renderCueBankEditor();
  renderSongSelect();
  renderMarksEditor();
  renderTransport();
  renderRuler();
  renderStats();
  renderAnalysis();
  renderInject();
  $('#selected-count').textContent = `已选 ${selectedCueIds.size} 个用于标记`;
}

// ── 音频与时钟同步（R4.2 的核心） ─────────────────────────────────────────

const audio = $('#audio');
let syncTimer = null;

function audioSrcFor(song) {
  if (!song?.audioPath) return '';
  if (/^(https?:)?\/\//.test(song.audioPath) || song.audioPath.startsWith('/')) {
    return song.audioPath;
  }
  return `/audio/${encodeURIComponent(song.audioPath)}`;
}

function startSyncLoop() {
  if (syncTimer) return;
  // 约 2.5Hz —— 更频繁没必要，反而增加抖动来源
  syncTimer = setInterval(() => {
    if (!audio.paused && !Number.isNaN(audio.currentTime)) {
      void post('/api/show/sync', { positionMs: audio.currentTime * 1000 }).catch(() => {});
    }
  }, 400);
}

function stopSyncLoop() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

audio.addEventListener('loadedmetadata', () => {
  const song = state?.songs.find((s) => s.id === state.currentSongId);
  if (song && audio.duration && Number.isFinite(audio.duration)) {
    song.durationMs = Math.round(audio.duration * 1000);
    void saveSong(song);
  }
});

$('#btn-play').addEventListener('click', async () => {
  try {
    const song = state.songs.find((s) => s.id === state.currentSongId);
    if (!song) return toast('请先在「准备」域选择或新建曲目', 'error');

    const src = audioSrcFor(song);
    if (src && audio.src !== new URL(src, location.href).href) {
      audio.src = src;
      await audio.load();
    }
    if (src) {
      audio.currentTime = state.transport.positionMs / 1000;
      await audio.play();
      startSyncLoop();
    } else {
      toast('该曲目没有音频文件，仅按时钟推 cue', 'ok');
    }
    await post('/api/show/play', { fromMs: state.transport.positionMs });
  } catch (e) {
    toast(`无法播放：${e.message}`, 'error');
  }
});

$('#btn-pause').addEventListener('click', async () => {
  audio.pause();
  stopSyncLoop();
  await post('/api/show/pause');
});

$('#btn-stop').addEventListener('click', async () => {
  audio.pause();
  audio.currentTime = 0;
  stopSyncLoop();
  await post('/api/show/stop');
});

$('#btn-killall').addEventListener('click', async () => {
  if (!confirm('确定熄灭所有 playback 吗？')) return;
  try {
    await post('/api/cuebank/killall');
    toast('已全部熄灭', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
});

$('#btn-apply-offset').addEventListener('click', async () => {
  const song = state.songs.find((s) => s.id === state.currentSongId);
  if (!song) return;
  try {
    await post('/api/show/offset', { id: song.id, offsetMs: Number($('#offset-input').value) });
    toast('整曲偏移已应用', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
});

$('#btn-mark-now').addEventListener('click', async () => {
  if (selectedCueIds.size === 0) {
    return toast('请先在下面的散 cue 台上长按选中要标记的 cue', 'error');
  }
  try {
    await post('/api/show/mark', {
      cueIds: [...selectedCueIds],
      note: $('#mark-note').value || undefined,
    });
    $('#mark-note').value = '';
    toast('已在此刻标记', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ── 准备域操作 ────────────────────────────────────────────────────────────

$('#btn-connect').addEventListener('click', async () => {
  const baseUrl = $('#console-url').value.trim();
  if (!baseUrl) return toast('请填写控台地址', 'error');
  try {
    const s = await post('/api/connect', { baseUrl });
    if (s.connected) toast(`已连接 Titan ${s.version}`, 'ok');
    else toast(`连接失败：${s.lastError}`, 'error');
  } catch (e) {
    toast(e.message, 'error');
  }
});

$('#btn-sim').addEventListener('click', async () => {
  $('#console-url').value = 'http://127.0.0.1:4500';
  $('#btn-connect').click();
});

$('#btn-disconnect').addEventListener('click', async () => {
  await post('/api/disconnect');
  toast('已断开');
});

$('#btn-add-cue').addEventListener('click', async () => {
  const name = $('#new-cue-name').value.trim();
  if (!name) return toast('请填写名称', 'error');
  try {
    await post('/api/cuebank/cue', { name, page: Number($('#new-cue-page').value) || 1 });
    $('#new-cue-name').value = '';
    toast('已新增', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
});

$('#btn-resolve').addEventListener('click', async () => {
  try {
    const r = await post('/api/resolve-handles');
    toast(`解析完成：成功 ${r.resolved}，失败 ${r.failed.length}`, r.failed.length ? 'error' : 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
});

$('#btn-save-song').addEventListener('click', async () => {
  const song = state.songs.find((s) => s.id === state.currentSongId);
  if (!song) return toast('尚未选择曲目', 'error');
  song.audioPath = $('#song-audio').value.trim();
  song.durationMs = Number($('#song-duration').value) * 1000;
  await saveSong(song);
  toast('曲目已保存', 'ok');
});

$('#btn-new-song').addEventListener('click', async () => {
  const name = prompt('新曲目名称', '新曲目');
  if (!name) return;
  const created = await post('/api/songs', { name, audioPath: '', durationMs: 0, marks: [] });
  await post('/api/songs/load', { id: created.id });
  toast('已新建曲目', 'ok');
});

$('#btn-delete-song').addEventListener('click', async () => {
  const song = state.songs.find((s) => s.id === state.currentSongId);
  if (!song) return;
  if (!confirm(`确定删除曲目「${song.name}」？`)) return;
  await api(`/api/songs?id=${encodeURIComponent(song.id)}`, { method: 'DELETE' });
  toast('已删除', 'ok');
});

$('#song-select').addEventListener('change', async (ev) => {
  try {
    await post('/api/songs/load', { id: ev.target.value });
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ── 批量灌入 ──────────────────────────────────────────────────────────────

let lastPlan = null;

function renderInject() {
  const root = $('#inject-result');
  const result = state.inject;

  if (result) {
    const parts = [];
    parts.push(`<div class="row" style="margin-top:12px">
      <span class="badge ${result.ok ? 'ok' : 'bad'}">${result.ok ? '成功' : '失败'}</span>
      <span class="badge">已执行 ${result.executed}</span>
      <span class="badge">跳过 ${result.skipped}</span>
      <span class="badge">耗时 ${(result.durationMs / 1000).toFixed(1)}s</span>
      ${result.transactionToken ? '<span class="badge ok">已开撤销事务</span>' : '<span class="badge warn">事务不可用（无法一键回滚）</span>'}
      ${result.rolledBack ? '<span class="badge warn">已自动回滚</span>' : ''}
    </div>`);

    if (result.verify) {
      parts.push(`<p class="hint">执行后核对：期望 ${result.verify.expected} 个落位，控台上存在 ${result.verify.present} 个${
        result.verify.missing.length ? `；未找到：${escapeHtml(result.verify.missing.join('、'))}` : ''
      }</p>`);
    }
    if (result.failed.length > 0) {
      parts.push(`<div class="card" style="border-color:var(--danger)">
        <h3 style="margin-top:0">失败项</h3>
        ${result.failed
          .map(
            (f) =>
              `<div style="margin-bottom:8px"><b>${escapeHtml(f.description)}</b><br>
               <span style="color:var(--danger);font-size:13px">${escapeHtml(f.error)}</span></div>`,
          )
          .join('')}
      </div>`);
    }
    root.innerHTML = parts.join('');
    return;
  }

  if (!lastPlan) {
    root.innerHTML = '';
    return;
  }

  const p = lastPlan;
  const parts = [];
  parts.push(`<h3>将要执行（${p.summary.total} 个动作）</h3>
    <div class="stats" style="margin-bottom:12px">
      <div class="stat"><div class="label">新建句柄</div><div class="value">${p.summary.create}</div></div>
      <div class="stat"><div class="label">写名称</div><div class="value">${p.summary.legends}</div></div>
      <div class="stat"><div class="label">写时间</div><div class="value">${p.summary.times}</div></div>
      <div class="stat"><div class="label">需 programmer</div><div class="value">${p.summary.needsProgrammer}</div></div>
    </div>`);

  const conflictRows = p.conflicts
    .map(
      (c) => `<tr><td>${escapeHtml(c.where)}</td><td>${escapeHtml(c.cueName)}</td>
        <td>${escapeHtml(c.existingLegend || '(空)')}</td></tr>`,
    )
    .join('');
  if (p.conflicts.length > 0) {
    parts.push(`<div class="card" style="border-color:var(--warn); padding:0">
      <div style="padding:12px 14px 0"><b>落位冲突（${p.conflicts.length} 个）</b>
      <p class="hint" style="margin:4px 0 8px">这些落位在控台上已被占用且名称不同。默认跳过，不覆盖现场。</p></div>
      <table><thead><tr><th>落位</th><th>本库名称</th><th>控台现有名称</th></tr></thead>
      <tbody>${conflictRows}</tbody></table></div>`);
  }

  parts.push(`<details style="margin-top:12px"><summary style="cursor:pointer;color:var(--fg-dim)">
    展开全部 ${p.actions.length} 个动作</summary>
    <div class="card" style="padding:0;margin-top:8px">
    <table><tbody>${p.actions
      .map(
        (a) =>
          `<tr><td class="mono" style="font-size:12px">${escapeHtml(a.kind)}</td>
           <td>${escapeHtml(a.description)}</td></tr>`,
      )
      .join('')}</tbody></table></div></details>`);

  if (p.warnings.length > 0) {
    parts.push(`<ul style="color:var(--warn);font-size:13px;margin-top:10px">
      ${p.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`);
  }

  root.innerHTML = parts.join('');
}

$('#btn-inject-plan').addEventListener('click', async () => {
  const btn = $('#btn-inject-plan');
  btn.disabled = true;
  try {
    lastPlan = await post('/api/inject/plan', {});
    $('#btn-inject-run').disabled = lastPlan.summary.total === 0;
    renderInject();
    toast(`计划已生成：${lastPlan.summary.total} 个动作`, 'ok');
  } catch (e) {
    toast(`生成计划失败：${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#btn-inject-run').addEventListener('click', async () => {
  if (!lastPlan) return;
  const n = lastPlan.summary.create;
  if (!confirm(`确认执行灌入？\n\n将新建 ${n} 个句柄，共 ${lastPlan.summary.total} 个动作。\n全程包在撤销事务里，失败会自动回滚。`)) return;

  const btn = $('#btn-inject-run');
  btn.disabled = true;
  try {
    const result = await post('/api/inject/execute', {
      plan: lastPlan,
      overwriteConflicts: $('#inject-overwrite').checked,
    });
    state.inject = result;
    renderInject();
    toast(result.ok ? `灌入完成：${result.executed} 个动作` : '灌入失败，见下方详情', result.ok ? 'ok' : 'error');
  } catch (e) {
    toast(`灌入失败：${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── 结构体检按钮 ──────────────────────────────────────────────────────────

$('#btn-analyze').addEventListener('click', async () => {
  const btn = $('#btn-analyze');
  const badge = $('#analyze-progress');
  btn.disabled = true;
  badge.textContent = '读取中…';
  badge.className = 'badge warn';
  try {
    const max = Number($('#analyze-max-cues').value) || 60;
    const report = await post('/api/analyze', { maxCuesPerPlayback: max });
    badge.textContent = `完成 · 发现 ${report.findings.length} 个问题`;
    badge.className = 'badge ok';
    toast(
      `体检完成：严重 ${report.countsBySeverity.high}、中等 ${report.countsBySeverity.medium}、提示 ${report.countsBySeverity.low}`,
      'ok',
    );
  } catch (e) {
    badge.textContent = '失败';
    badge.className = 'badge bad';
    toast(`体检失败：${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#btn-cuesheet').addEventListener('click', () => {
  window.open('/api/analyze/cuesheet', '_blank');
});

// ── SSE 与启动 ────────────────────────────────────────────────────────────

function connectEvents() {
  const es = new EventSource('/api/events');

  es.addEventListener('state', (ev) => {
    state = JSON.parse(ev.data);
    renderAll();
  });

  // 高频：仅更新位置相关的部分，避免整页重绘造成演出中抖动
  es.addEventListener('position', (ev) => {
    if (!state) return;
    const p = JSON.parse(ev.data);
    state.transport.positionMs = p.positionMs;
    state.transport.running = p.running;
    renderTransport();
    const song = state.songs.find((s) => s.id === state.currentSongId);
    if (playheadEl && song && song.durationMs > 0) {
      playheadEl.style.left = `${Math.min(100, (p.positionMs / song.durationMs) * 100)}%`;
    }
  });

  es.addEventListener('hit', (ev) => {
    const hit = JSON.parse(ev.data);
    firedRecently.set(hit.cueId, Date.now());
    renderPerformCueBank();
    setTimeout(() => {
      firedRecently.delete(hit.cueId);
      renderPerformCueBank();
    }, 600);
  });

  // ★ 离线模式下推 cue 不会真的送到控台 —— 必须明确告知，否则操作者会以为推上去了
  es.addEventListener('fire-offline', (ev) => {
    const d = JSON.parse(ev.data);
    const cue = cueName(d.cueId);
    toast(`「${cue}」未送到控台：当前未连接（离线预演模式）`, 'error');
  });

  // 时钟发生硬重同步 = 播放位置跳了，操作者应当知道
  es.addEventListener('clock-resync', (ev) => {
    const d = JSON.parse(ev.data);
    toast(`播放时钟已重同步（偏差 ${Math.round(d.driftMs)}ms）—— 卡点已重新武装`, 'error');
  });

  // 灌入结果（跨标签页/多操作者同步）
  es.addEventListener('inject-result', () => {
    void api('/api/state').then((st) => {
      state = st;
      renderInject();
    });
  });

  es.addEventListener('resolved', (ev) => {
    const d = JSON.parse(ev.data);
    toast(`句柄解析完成：成功 ${d.resolved}，失败 ${d.failed.length}`, d.failed.length ? 'error' : 'ok');
  });

  es.addEventListener('analyze-progress', (ev) => {
    const p = JSON.parse(ev.data);
    const badge = $('#analyze-progress');
    badge.textContent = p.message;
    badge.className = 'badge warn';
  });

  for (const name of ['connection', 'cuebank', 'songs', 'song-loaded', 'marks', 'analysis']) {
    es.addEventListener(name, async () => {
      state = await api('/api/state');
      renderAll();
    });
  }

  es.addEventListener('error', (ev) => {
    if (ev.data) {
      try {
        const d = JSON.parse(ev.data);
        toast(d.message ?? '触发失败', 'error');
      } catch {
        /* SSE 自身重连事件没有 data */
      }
    }
  });

  es.addEventListener('open', () => {
    void api('/api/state').then((s) => {
      state = s;
      renderAll();
    });
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// 键盘快捷键 —— 演出中常用（空格 = 播放/暂停）
document.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input, textarea, select')) return;
  if (ev.code === 'Space') {
    ev.preventDefault();
    if (state?.transport.running) $('#btn-pause').click();
    else $('#btn-play').click();
  }
});

state = await api('/api/state');
renderAll();
connectEvents();
