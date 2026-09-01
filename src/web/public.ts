/**
 * web 静态页（第 7 期批次二 · KS-7.26 / T6）
 *
 * 自包含 INDEX_HTML：内联 style/script，零构建零外部资源（本期零新依赖）。
 * 四面板 DOM 标记（验收判据 1）：data-panel="file-tree"（左）/ "editor"（中）/ "chat"（右）/ "activity"（下）。
 * Key 不落前端（SEC-6）：静态资源与任何内联脚本不得含 Key 形态（也不含 sk- 形态字面，含跨词连字）。
 *
 * 行为（原生 JS，无框架；客户端脚本不用模板字符串，纯字符串拼接，避免转义歧义）：
 * - 启动拉 /api/vaults + /api/tree 渲染文件树（目录点击展开/折叠一层）；点击文件读入编辑器；
 * - 保存 → POST /api/file；已存在文件先原生 confirm()（对应服务端 confirm:true）；
 *   409/403 拒绝时把 unlockHint/code 显示到编辑器状态条；
 * - 对话 → POST /api/chat，追加用户/回复气泡（agent_message 事件同样入气泡，3s 窗口去重防双份）；
 * - 活动轨道：EventSource('/api/events')，事件按 type 渲染一行；断线自动重连（原生），显示连接状态点。
 *
 * 批次三（T10 多仓库并行，KS-7.27）：
 * - 文件树：挂载根下拉列 /api/vaults 全部根并标注来源（vault/授权目录，读响应附加 mounts 字段）；
 *   「并排双仓」开关：两个树容器并排渲染当前选中两根（CSS grid 两列，窄屏自动叠放为单列）；
 * - 活动轨道：按 event.vaultId 着色——无字段/缺省 = 「默认」中性色；每个新出现的 vaultId 依序取
 *   固定色板（7 色循环）；行首色点 + 根名前缀，事件行结构不变；只消费 vaultId 字段（无则中性色）。
 */

/** 自包含单页 HTML（GET / 响应体） */
export const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ThatPerson 本地工作台</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Microsoft YaHei", system-ui, sans-serif; font-size: 14px; color: #222; background: #f7f7f5; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; background: #fff; border-bottom: 1px solid #ddd; }
  header h1 { font-size: 16px; margin: 0; }
  #conn-state { font-size: 12px; color: #666; }
  main { display: grid; grid-template-columns: 260px 1fr 340px; gap: 8px; padding: 8px 8px 0 8px; height: 58vh; }
  footer { padding: 0 8px 8px 8px; }
  section { background: #fff; border: 1px solid #ccc; border-radius: 4px; padding: 8px; overflow: auto; display: flex; flex-direction: column; }
  section h2 { font-size: 13px; margin: 0 0 6px 0; color: #444; border-bottom: 1px solid #eee; padding-bottom: 4px; }
  .tree-item { padding: 2px 4px; cursor: pointer; border-radius: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tree-item:hover { background: #eef4ff; }
  .tree-sub { margin-left: 14px; border-left: 1px dotted #ccc; }
  #vault-select { width: 100%; margin-bottom: 6px; }
  #editor-path { font-size: 12px; color: #666; margin-bottom: 4px; word-break: break-all; }
  #editor-text { flex: 1; width: 100%; resize: none; font-family: ui-monospace, Consolas, monospace; font-size: 13px; border: 1px solid #ddd; border-radius: 3px; padding: 6px; }
  .editor-actions { margin-top: 6px; display: flex; align-items: center; gap: 8px; }
  #editor-status { font-size: 12px; color: #a05a00; }
  button { padding: 4px 14px; border: 1px solid #bbb; background: #fafafa; border-radius: 3px; cursor: pointer; }
  button:hover { background: #f0f0f0; }
  .chat-list { flex: 1; overflow-y: auto; border: 1px solid #eee; border-radius: 3px; padding: 6px; background: #fcfcfa; }
  .chat-msg { margin-bottom: 8px; }
  .chat-role { font-size: 12px; color: #888; display: block; }
  .chat-text { display: inline-block; padding: 5px 8px; border-radius: 6px; max-width: 92%; white-space: pre-wrap; word-break: break-word; }
  .chat-user .chat-text { background: #e3efff; }
  .chat-bot .chat-text { background: #f0f0ec; }
  .chat-input { display: flex; gap: 6px; margin-top: 6px; }
  #chat-text { flex: 1; padding: 4px 6px; border: 1px solid #ddd; border-radius: 3px; }
  .activity-list { margin: 0; padding: 0; list-style: none; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .act-line { padding: 1px 0; border-bottom: 1px dashed #eee; color: #444; }
  .act-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  .act-vault { color: #666; }
  .hint { color: #999; font-size: 12px; }
  /* T10 并排双仓：默认单树；开关后两列 grid，窄屏自动叠放 */
  .dual-bar { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 12px; color: #555; }
  #vault-select-b { display: none; flex: 1; min-width: 0; }
  body.dual-on #vault-select-b { display: inline-block; }
  #tree-dual { display: none; grid-template-columns: 1fr 1fr; gap: 6px; }
  body.dual-on #tree-dual { display: grid; }
  body.dual-on #tree-box { display: none; }
  body.dual-on main { grid-template-columns: 430px 1fr 340px; }
  .tree-pane { border: 1px solid #e4e4e4; border-radius: 3px; padding: 4px; min-width: 0; overflow: auto; }
  .tree-pane-head { font-size: 12px; color: #555; margin-bottom: 4px; padding-bottom: 2px; border-bottom: 1px dashed #eee; word-break: break-all; }
  @media (max-width: 960px) { body.dual-on #tree-dual { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>ThatPerson 本地工作台</h1>
  <span id="conn-state">○ 重连中</span>
</header>
<main>
  <section data-panel="file-tree" id="panel-file">
    <h2>文件树</h2>
    <select id="vault-select" title="选择挂载根"></select>
    <div class="dual-bar">
      <label for="dual-toggle"><input type="checkbox" id="dual-toggle"> 并排双仓</label>
      <select id="vault-select-b" title="并排右栏挂载根"></select>
    </div>
    <div id="tree-box"><span class="hint">加载中…</span></div>
    <div id="tree-dual">
      <div class="tree-pane">
        <div class="tree-pane-head" id="pane-a-head">（未选择）</div>
        <div id="pane-a-body"><span class="hint">加载中…</span></div>
      </div>
      <div class="tree-pane">
        <div class="tree-pane-head" id="pane-b-head">（未选择）</div>
        <div id="pane-b-body"><span class="hint">加载中…</span></div>
      </div>
    </div>
  </section>
  <section data-panel="editor" id="panel-editor">
    <h2>编辑器</h2>
    <div id="editor-path">（未打开文件）</div>
    <textarea id="editor-text" placeholder="在左侧文件树点击文件后在此编辑…"></textarea>
    <div class="editor-actions">
      <button id="btn-save" type="button">保存</button>
      <span id="editor-status">就绪</span>
    </div>
  </section>
  <section data-panel="chat" id="panel-chat">
    <h2>对话</h2>
    <div id="chat-list" class="chat-list"><span class="hint">向 ThatPerson 发送第一条消息吧（服务端以 --mock 启动时为离线演示回复）</span></div>
    <div class="chat-input">
      <input id="chat-text" type="text" placeholder="输入消息，回车发送…">
      <button id="btn-send" type="button">发送</button>
    </div>
  </section>
</main>
<footer>
  <section data-panel="activity" id="panel-activity">
    <h2>活动轨道</h2>
    <ul id="activity-list" class="activity-list"></ul>
  </section>
</footer>
<script>
(function () {
  'use strict';
  var state = { root: null, rootB: null, mounts: [], currentFile: null, fileExists: false, lastAssistant: { text: '', at: 0 } };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function nowText() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function setEditorStatus(text) { $('editor-status').textContent = text; }

  // ===== 文件树 =====
  // T10：每根标注来源（vault/授权目录）——读 /api/vaults 附加 mounts 字段；缺省回退目录名 + 授权目录
  function mountInfo(root) {
    var p = String(root);
    var lower = p.toLowerCase();
    var hit = null;
    for (var i = 0; i < state.mounts.length; i++) {
      if (String(state.mounts[i].path).toLowerCase() === lower) { hit = state.mounts[i]; break; }
    }
    var name = (hit && hit.name) || p.split(/[\\/]/).pop() || p;
    return { name: name, source: (hit && hit.source === 'vault') ? 'vault' : '授权目录' };
  }
  function mountText(root) {
    var info = mountInfo(root);
    return info.name + '（' + info.source + '）';
  }
  function fillVaultSelect(sel, roots) {
    sel.innerHTML = '';
    roots.forEach(function (root) {
      var opt = document.createElement('option');
      opt.value = root;
      opt.textContent = mountText(root);
      sel.appendChild(opt);
    });
  }
  function updatePane(which, root) {
    var head = $(which === 'a' ? 'pane-a-head' : 'pane-b-head');
    var body = $(which === 'a' ? 'pane-a-body' : 'pane-b-body');
    if (!root) { head.textContent = '（未选择）'; body.textContent = ''; return; }
    head.textContent = mountText(root);
    loadTree(root, body, 0);
  }

  function loadVaults() {
    fetch('/api/vaults').then(function (r) { return r.json(); }).then(function (data) {
      var roots = (data && data.roots) || [];
      state.mounts = (data && data.mounts) || [];
      fillVaultSelect($('vault-select'), roots);
      fillVaultSelect($('vault-select-b'), roots);
      if (roots.length > 0) {
        state.root = roots[0];
        state.rootB = roots.length > 1 ? roots[1] : roots[0];
        $('vault-select-b').selectedIndex = roots.length > 1 ? 1 : 0;
        loadTree(state.root, $('tree-box'), 0);
        updatePane('a', state.root);
        updatePane('b', state.rootB);
      } else {
        state.root = null;
        state.rootB = null;
        $('tree-box').textContent = '暂无挂载根，可运行 thatperson open <目录> 授权';
        $('pane-a-head').textContent = '（未选择）';
        $('pane-b-head').textContent = '（未选择）';
        $('pane-a-body').textContent = '';
        $('pane-b-body').textContent = '';
      }
    }).catch(function () {
      $('tree-box').textContent = '挂载根加载失败';
      $('pane-a-body').textContent = '挂载根加载失败';
      $('pane-b-body').textContent = '挂载根加载失败';
    });
  }

  function loadTree(root, container, depth) {
    container.textContent = '加载中…';
    fetch('/api/tree?root=' + encodeURIComponent(root))
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        container.textContent = '';
        if (!res.ok || !res.d || !res.d.children) {
          container.textContent = (res.d && (res.d.unlockHint || res.d.error)) || '目录树加载失败';
          return;
        }
        renderChildren(res.d.children || [], container, depth);
      })
      .catch(function () { container.textContent = '目录树加载失败'; });
  }

  function renderChildren(children, container, depth) {
    if (children.length === 0) {
      container.appendChild(el('div', 'hint', '（空目录）'));
      return;
    }
    children.forEach(function (child) {
      var row = el('div', 'tree-item', (child.type === 'dir' ? '▸ ' : '· ') + child.name);
      row.title = child.path || child.name;
      if (child.type === 'dir') {
        row.addEventListener('click', function (evt) {
          evt.stopPropagation();
          var sub = row.nextSibling;
          if (sub && sub.__subtree) { row.parentNode.removeChild(sub); return; } // 已展开 → 折叠
          var box = el('div', 'tree-sub');
          box.__subtree = true;
          row.parentNode.insertBefore(box, row.nextSibling);
          loadTree(child.path, box, depth + 1);
        });
      } else {
        row.addEventListener('click', function (evt) {
          evt.stopPropagation();
          openFile(child.path);
        });
      }
      container.appendChild(row);
    });
  }

  // ===== 编辑器 =====
  function openFile(p) {
    fetch('/api/file?path=' + encodeURIComponent(p))
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d && typeof res.d.content === 'string') {
          state.currentFile = p;
          state.fileExists = true;
          $('editor-text').value = res.d.content;
          $('editor-path').textContent = p;
          setEditorStatus('已打开文件');
        } else {
          setEditorStatus((res.d && (res.d.unlockHint || res.d.error)) || '文件打开失败');
        }
      })
      .catch(function () { setEditorStatus('文件打开失败'); });
  }

  function postFile(payload, onDone) {
    fetch('/api/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (res) { onDone(res); })
      .catch(function () { setEditorStatus('保存失败：服务不可达'); });
  }

  function saveFile() {
    var p = state.currentFile;
    if (!p) { setEditorStatus('请先在左侧选择要编辑的文件'); return; }
    var content = $('editor-text').value;
    var send = function (confirmed) {
      var payload = { path: p, content: content };
      if (confirmed) payload.confirm = true;
      postFile(payload, function (res) {
        if (res.status >= 200 && res.status < 300) {
          state.fileExists = true;
          setEditorStatus('已保存 ' + nowText());
          return;
        }
        if (res.status === 409) {
          // 服务端要求覆盖确认：原生 confirm 后带 confirm:true 重发
          if (window.confirm('目标文件已存在，确定覆盖保存？')) send(true);
          else setEditorStatus('已取消覆盖（409 conflict）');
          return;
        }
        if (res.status === 403) {
          setEditorStatus('写入被拒绝（' + ((res.d && res.d.code) || '403') + '）' + ((res.d && res.d.unlockHint) ? '：' + res.d.unlockHint : ''));
          return;
        }
        setEditorStatus((res.d && res.d.error) || '保存失败');
      });
    };
    if (state.fileExists && !window.confirm('该文件已存在，确定覆盖保存？')) {
      setEditorStatus('已取消保存');
      return;
    }
    send(state.fileExists === true);
  }

  // ===== 对话 =====
  function appendBubble(role, text) {
    var list = $('chat-list');
    var first = list.querySelector('.hint');
    if (first) first.parentNode.removeChild(first);
    var msg = el('div', 'chat-msg ' + (role === 'user' ? 'chat-user' : 'chat-bot'));
    msg.appendChild(el('span', 'chat-role', role === 'user' ? '你' : 'ThatPerson'));
    msg.appendChild(el('div', 'chat-text', text));
    list.appendChild(msg);
    list.scrollTop = list.scrollHeight;
  }

  // 去重：agent_message 事件与 REST 响应同源，3s 窗口内同文本只入一个气泡
  function appendAssistant(text) {
    var t = String(text == null ? '' : text);
    if (t && t === state.lastAssistant.text && Date.now() - state.lastAssistant.at < 3000) return;
    state.lastAssistant = { text: t, at: Date.now() };
    appendBubble('bot', t);
  }

  function sendChat() {
    var input = $('chat-text');
    var message = input.value.trim();
    if (!message) return;
    input.value = '';
    appendBubble('user', message);
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: message }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d && typeof res.d.reply === 'string') appendAssistant(res.d.reply);
        else appendAssistant((res.d && res.d.error) || '对话失败');
      })
      .catch(function () { appendAssistant('对话服务不可达'); });
  }

  // ===== 活动轨道（SSE）=====
  var ACT_LABELS = {
    agent_start: '循环启动',
    tool_call: '工具调用',
    tool_result: '工具结果',
    memory_read: '记忆读取',
    memory_write: '记忆写入',
    status: '状态',
    error: '错误',
    session_meta: '会话',
    skill_start: '技能开始',
    skill_step: '技能步骤'
  };

  function activityDetail(evt) {
    switch (evt.type) {
      case 'tool_call': return evt.name + '（' + (evt.policy || '') + ' · ' + (evt.riskLevel || '') + '）';
      case 'tool_result': return evt.name + (evt.ok ? ' 成功' : ' 失败' + (evt.code ? ' ' + evt.code : '')) + ' ' + evt.ms + 'ms';
      case 'memory_read': return (evt.phase || '') + (evt.sections && evt.sections.length ? '：' + evt.sections.join('、') : '');
      case 'memory_write': return (evt.tool || '') + (evt.file ? ' → ' + evt.file : '');
      case 'status': return evt.phase || '';
      case 'error': return (evt.tool ? evt.tool + ' ' : '') + (evt.code || '') + (evt.message ? ' ' + evt.message : '');
      case 'session_meta': return evt.action || '';
      case 'skill_start': return evt.name || '';
      case 'skill_step': return (evt.name || '') + (evt.step ? ' · ' + evt.step : '');
      default: return '';
    }
  }

  // T10 活动轨道按 vaultId 着色：无字段 = 「默认」中性色；每个新出现的 vaultId 依序取固定色板（7 色循环）
  var VAULT_PALETTE = ['#2f6fdb', '#c9302c', '#1f7a33', '#8e44ad', '#d9822b', '#0f7f7f', '#b0417f'];
  var vaultColors = { '默认': '#8a8a8a' };
  var vaultSeq = 0;
  function vaultIdOf(evt) { return evt && evt.vaultId ? String(evt.vaultId) : '默认'; }
  function vaultColor(id) {
    if (!vaultColors[id]) {
      vaultColors[id] = VAULT_PALETTE[vaultSeq % VAULT_PALETTE.length];
      vaultSeq += 1;
    }
    return vaultColors[id];
  }

  function activityLine(evt) {
    var list = $('activity-list');
    var label = ACT_LABELS[evt.type] || evt.type;
    var detail = activityDetail(evt);
    var line = el('li', 'act-line');
    var vid = vaultIdOf(evt); // 只消费 vaultId 字段（可选；无则中性色）
    var dot = el('span', 'act-dot');
    dot.style.background = vaultColor(vid);
    dot.title = '仓库：' + vid;
    line.appendChild(dot);
    line.appendChild(el('span', 'act-vault', vid + ' · '));
    line.appendChild(document.createTextNode('[' + nowText() + '] ' + label + (detail ? '：' + detail : '')));
    list.insertBefore(line, list.firstChild);
    while (list.children.length > 200) list.removeChild(list.lastChild);
  }

  function connectEvents() {
    var es = new EventSource('/api/events');
    es.onopen = function () { $('conn-state').textContent = '● 已连接'; };
    es.onerror = function () { $('conn-state').textContent = '○ 重连中'; };
    es.onmessage = function (frame) {
      var evt;
      try { evt = JSON.parse(frame.data); } catch (err) { return; }
      if (!evt || !evt.type) return;
      if (evt.type === 'agent_message') { appendAssistant(evt.content); return; } // 助手回复进对话气泡，避免与活动轨道重复
      activityLine(evt);
    };
  }

  // ===== 启动 =====
  $('btn-save').addEventListener('click', saveFile);
  $('btn-send').addEventListener('click', sendChat);
  $('chat-text').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(); });
  $('vault-select').addEventListener('change', function () {
    state.root = this.value;
    if (state.root) {
      loadTree(state.root, $('tree-box'), 0);
      if (document.body.classList.contains('dual-on')) updatePane('a', state.root);
    }
  });
  $('vault-select-b').addEventListener('change', function () {
    state.rootB = this.value;
    if (state.rootB && document.body.classList.contains('dual-on')) updatePane('b', state.rootB);
  });
  $('dual-toggle').addEventListener('change', function () {
    document.body.classList.toggle('dual-on', this.checked);
    if (this.checked && state.root) {
      updatePane('a', state.root);
      updatePane('b', state.rootB);
    }
  });
  loadVaults();
  connectEvents();
})();
</script>
</body>
</html>
`;
