export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>素材上传后台</title>
  <link rel="stylesheet" href="/admin/assets/admin.css">
</head>
<body>
  <main class="shell">
    <section id="login-view" class="login-panel" hidden>
      <div class="brand-mark">RW</div>
      <p class="eyebrow">PRIVATE MEDIA</p>
      <h1>素材上传后台</h1>
      <p class="muted">登录后查看用户上传元数据、服务器接收状态和 R2 交付结果。</p>
      <form id="login-form" novalidate>
        <label for="username">账号</label>
        <input id="username" name="username" autocomplete="username" maxlength="64" required>
        <label for="password">密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" maxlength="128" required>
        <p id="login-error" class="error" role="alert" hidden></p>
        <button type="submit">登录</button>
      </form>
    </section>

    <section id="dashboard-view" hidden>
      <header class="topbar">
        <div>
          <p class="eyebrow">PRIVATE MEDIA</p>
          <h1>上传审计</h1>
          <p class="muted">数据库元数据与 R2 队列状态</p>
        </div>
        <div class="header-actions">
          <span id="admin-name" class="admin-name"></span>
          <button id="refresh-button" class="secondary" type="button">刷新数据</button>
          <button id="logout-button" class="quiet" type="button">退出</button>
        </div>
      </header>

      <section id="summary" class="summary" aria-label="上传汇总"></section>

      <section class="records-panel">
        <div class="panel-heading">
          <div>
            <h2>上传记录</h2>
            <p id="result-count" class="muted"></p>
          </div>
          <form id="search-form" class="search-form">
            <label class="sr-only" for="search-input">搜索记录</label>
            <input id="search-input" type="search" maxlength="80" placeholder="文件名、昵称、openid 或 UUID">
            <button class="secondary" type="submit">搜索</button>
          </form>
        </div>
        <nav id="filters" class="filters" aria-label="状态筛选"></nav>
        <p id="dashboard-error" class="error" role="alert" hidden></p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间 / 文件</th>
                <th>用户</th>
                <th>服务器接收</th>
                <th>R2 交付</th>
                <th>错误与处理</th>
              </tr>
            </thead>
            <tbody id="records"></tbody>
          </table>
          <div id="empty-state" class="empty" hidden>没有符合条件的上传记录</div>
        </div>
        <footer class="pagination">
          <button id="previous-button" class="secondary" type="button">上一页</button>
          <span id="page-indicator"></span>
          <button id="next-button" class="secondary" type="button">下一页</button>
        </footer>
      </section>
    </section>
  </main>
  <script src="/admin/assets/admin.js" defer></script>
</body>
</html>`

export const ADMIN_CSS = `:root{color-scheme:light;--ink:#102f27;--muted:#687c76;--green:#176f53;--green-dark:#0d503c;--mint:#e8f4ef;--paper:#fff;--canvas:#f2f6f4;--line:#dce6e2;--danger:#a33c31;--warning:#9a6414;--shadow:0 18px 50px rgba(16,47,39,.08);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink)}button,input{font:inherit}.shell{width:min(1480px,calc(100% - 40px));margin:0 auto;padding:36px 0 60px}.login-panel{width:min(440px,100%);margin:10vh auto 0;background:var(--paper);border:1px solid var(--line);border-radius:24px;padding:36px;box-shadow:var(--shadow)}.brand-mark{display:grid;place-items:center;width:52px;height:52px;border-radius:16px;background:var(--green-dark);color:#fff;font-weight:800;letter-spacing:.08em}.eyebrow{margin:20px 0 6px;color:var(--green);font-size:12px;font-weight:800;letter-spacing:.22em}.login-panel h1,.topbar h1{margin:0;font-size:34px;letter-spacing:-.03em}.muted{color:var(--muted)}form label{display:block;margin:20px 0 8px;font-weight:700}input{width:100%;height:46px;padding:0 13px;border:1px solid #c7d6d0;border-radius:11px;background:#fff;color:var(--ink);outline:none}input:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(23,111,83,.12)}button{min-height:42px;padding:0 18px;border:0;border-radius:11px;background:var(--green);color:#fff;font-weight:750;cursor:pointer}button:hover{background:var(--green-dark)}button:disabled{cursor:not-allowed;opacity:.48}.login-panel button{width:100%;margin-top:24px}.secondary{border:1px solid #bdd0c8;background:#fff;color:var(--green-dark)}.secondary:hover,.quiet:hover{background:var(--mint)}.quiet{background:transparent;color:var(--muted)}.error{margin:14px 0 0;color:var(--danger);font-weight:650}.topbar{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:26px}.topbar .eyebrow{margin-top:0}.topbar .muted{margin:6px 0 0}.header-actions{display:flex;align-items:center;gap:10px}.admin-name{margin-right:8px;color:var(--muted);font-size:14px}.summary{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:22px}.metric{padding:20px;background:var(--paper);border:1px solid var(--line);border-radius:16px}.metric strong{display:block;margin-top:8px;font-size:30px;letter-spacing:-.04em}.metric span{color:var(--muted);font-size:13px}.metric.attention strong{color:var(--danger)}.metric.waiting strong{color:var(--warning)}.records-panel{background:var(--paper);border:1px solid var(--line);border-radius:22px;padding:24px;box-shadow:var(--shadow)}.panel-heading{display:flex;justify-content:space-between;align-items:flex-end;gap:20px}.panel-heading h2{margin:0;font-size:24px}.panel-heading p{margin:6px 0 0}.search-form{display:flex;gap:8px;width:min(460px,100%)}.search-form input{min-width:0}.filters{display:flex;flex-wrap:wrap;gap:8px;margin:22px 0 16px}.filter{min-height:36px;padding:0 13px;border:1px solid var(--line);background:#f8faf9;color:var(--muted);font-size:13px}.filter.active{border-color:var(--green);background:var(--mint);color:var(--green-dark)}.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px}table{width:100%;min-width:1120px;border-collapse:collapse}th,td{padding:16px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th{background:#f7faf8;color:var(--muted);font-size:12px;letter-spacing:.03em}tbody tr:last-child td{border-bottom:0}.file-name{max-width:290px;margin:5px 0 7px;font-weight:750;overflow-wrap:anywhere}.subtle,.mono{display:block;color:var(--muted);font-size:12px;line-height:1.6}.mono{max-width:290px;font-family:"SFMono-Regular",Consolas,monospace;overflow-wrap:anywhere}.badge{display:inline-flex;align-items:center;min-height:26px;padding:0 9px;border-radius:999px;background:#edf2f0;color:var(--muted);font-size:12px;font-weight:750}.badge.ready{background:#e4f5ed;color:#176f53}.badge.waiting{background:#fff4dc;color:#8d5b10}.badge.danger{background:#fdecea;color:#9b352a}.badge.neutral{background:#edf2f0;color:#536963}.progress{width:150px;height:6px;margin:9px 0 6px;overflow:hidden;border-radius:999px;background:#e4ebe8}.progress span{display:block;height:100%;background:var(--green)}.recommendation{display:block;margin-top:8px;font-weight:700;line-height:1.5}.empty{padding:54px;text-align:center;color:var(--muted)}.pagination{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:18px}.pagination span{min-width:86px;text-align:center;color:var(--muted);font-size:13px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}[hidden]{display:none!important}@media(max-width:1000px){.summary{grid-template-columns:repeat(3,1fr)}}@media(max-width:680px){.shell{width:min(100% - 24px,1480px);padding-top:20px}.topbar,.panel-heading{align-items:stretch;flex-direction:column}.header-actions{flex-wrap:wrap}.admin-name{width:100%}.summary{grid-template-columns:repeat(2,1fr)}.records-panel{padding:16px}.search-form{width:100%}.login-panel{padding:26px}.pagination{justify-content:space-between}}`

export const ADMIN_JAVASCRIPT = `(() => {
  'use strict'
  const pageSize = 30
  const state = { category: 'all', offset: 0, query: '', total: 0 }
  const categories = [
    ['all', '全部'], ['operator_review', '需人工检查'], ['user_reupload', '需用户重传'],
    ['r2_retrying', 'R2 排队中'], ['server_receiving', '服务器接收中'],
    ['r2_ready', '已入 R2'], ['cancelled', '已取消']
  ]
  const categoryMeta = {
    server_receiving: ['服务器接收中', 'neutral', '等待小程序完成到服务器的上传'],
    r2_retrying: ['R2 排队重试', 'waiting', '服务器已有完整文件，无需用户重传'],
    r2_ready: ['已入 R2', 'ready', '无需处理'],
    user_reupload: ['需用户重传', 'danger', '服务器未收到完整文件，可联系用户重新上传'],
    operator_review: ['需人工检查', 'danger', '服务器已收完整文件，请检查 spool、R2 凭据或服务日志'],
    cancelled: ['已取消', 'neutral', '无需处理']
  }
  const byId = (id) => document.getElementById(id)
  const element = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const formatBytes = (bytes) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KiB'
    return (bytes / 1048576).toFixed(2) + ' MiB'
  }
  const formatDate = (value) => value ? new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date(value)) : '—'
  async function request(path, options) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options })
    if (response.status === 401) throw Object.assign(new Error('unauthorized'), { unauthorized: true })
    if (!response.ok) throw new Error('request failed')
    if (response.status === 204) return null
    return response.json()
  }
  function showLogin(message) {
    byId('dashboard-view').hidden = true
    byId('login-view').hidden = false
    const error = byId('login-error')
    error.textContent = message || ''
    error.hidden = !message
  }
  function showDashboard(username) {
    byId('login-view').hidden = true
    byId('dashboard-view').hidden = false
    byId('admin-name').textContent = '当前账号：' + username
  }
  function renderSummary(summary) {
    const values = [
      ['用户', summary.users, ''], ['总记录', summary.total, ''],
      ['服务器接收中', summary.serverReceiving, ''], ['R2 排队中', summary.r2Retrying, 'waiting'],
      ['需用户重传', summary.userReupload, 'attention'], ['需人工检查', summary.operatorReview, 'attention']
    ]
    const container = byId('summary')
    container.replaceChildren(...values.map(([label, value, tone]) => {
      const card = element('article', 'metric ' + tone)
      card.append(element('span', '', label), element('strong', '', String(value)))
      return card
    }))
  }
  function labeled(parent, label, value, className) {
    parent.append(element('span', 'subtle', label), element('span', className || '', value))
  }
  function renderRows(page) {
    state.total = page.total
    const body = byId('records')
    const rows = page.rows.map((record) => {
      const tr = document.createElement('tr')
      const file = document.createElement('td')
      file.append(element('span', 'subtle', formatDate(record.createdAt)), element('div', 'file-name', record.fileName))
      file.append(element('span', 'subtle', (record.kind === 'video' ? '视频' : '图片') + ' · ' + formatBytes(record.expectedSizeBytes)))
      file.append(element('span', 'mono', 'upload ' + record.uploadId))
      const user = document.createElement('td')
      labeled(user, '昵称', record.nickname || '未确认')
      labeled(user, 'AppID', record.appId || '—', 'mono')
      labeled(user, 'openid', record.openid || '—', 'mono')
      labeled(user, '用户 ID', record.userId, 'mono')
      const server = document.createElement('td')
      const percent = record.expectedSizeBytes === 0 ? 0 : Math.min(100, Math.round(record.confirmedSizeBytes / record.expectedSizeBytes * 100))
      server.append(element('span', 'badge neutral', record.uploadStatus))
      const progress = element('progress', 'progress')
      progress.max = 100
      progress.value = percent
      server.append(progress, element('span', 'subtle', formatBytes(record.confirmedSizeBytes) + ' / ' + formatBytes(record.expectedSizeBytes) + ' · ' + percent + '%'))
      const r2 = document.createElement('td')
      const meta = categoryMeta[record.category] || ['未知', 'danger', '请人工检查']
      r2.append(element('span', 'badge ' + meta[1], meta[0]))
      labeled(r2, 'bucket', record.r2Bucket, 'mono')
      labeled(r2, 'object key', record.objectKey, 'mono')
      if (record.finalizeAttemptCount > 0) r2.append(element('span', 'subtle', '交付尝试 ' + record.finalizeAttemptCount + ' 次'))
      const action = document.createElement('td')
      const errorCode = record.lastFinalizeErrorCode || record.failureCode
      action.append(element('span', errorCode ? 'badge danger' : 'badge neutral', errorCode || '无错误'))
      if (record.lastFinalizeErrorAt) action.append(element('span', 'subtle', '最后错误：' + formatDate(record.lastFinalizeErrorAt)))
      if (record.nextFinalizeAt) action.append(element('span', 'subtle', '下次队列执行：' + formatDate(record.nextFinalizeAt)))
      action.append(element('span', 'recommendation', meta[2]))
      tr.append(file, user, server, r2, action)
      return tr
    })
    body.replaceChildren(...rows)
    byId('empty-state').hidden = rows.length !== 0
    const start = page.total === 0 ? 0 : state.offset + 1
    const end = Math.min(state.offset + pageSize, page.total)
    byId('result-count').textContent = '共 ' + page.total + ' 条，当前显示 ' + start + '–' + end
    byId('page-indicator').textContent = page.total === 0 ? '第 0 页' : '第 ' + (Math.floor(state.offset / pageSize) + 1) + ' / ' + Math.ceil(page.total / pageSize) + ' 页'
    byId('previous-button').disabled = state.offset === 0
    byId('next-button').disabled = state.offset + pageSize >= page.total
  }
  function renderFilters() {
    byId('filters').replaceChildren(...categories.map(([value, label]) => {
      const button = element('button', 'filter' + (state.category === value ? ' active' : ''), label)
      button.type = 'button'
      button.addEventListener('click', () => { state.category = value; state.offset = 0; renderFilters(); void loadData() })
      return button
    }))
  }
  async function loadData() {
    const error = byId('dashboard-error')
    error.hidden = true
    byId('refresh-button').disabled = true
    try {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String(state.offset) })
      if (state.category !== 'all') params.set('category', state.category)
      if (state.query) params.set('q', state.query)
      const [summary, page] = await Promise.all([
        request('/admin/api/summary'), request('/admin/api/uploads?' + params.toString())
      ])
      renderSummary(summary)
      renderRows(page)
    } catch (failure) {
      if (failure && failure.unauthorized) { showLogin('登录已过期，请重新登录'); return }
      error.textContent = '数据加载失败，请检查网络后手动刷新。'
      error.hidden = false
    } finally {
      byId('refresh-button').disabled = false
    }
  }
  byId('login-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const button = event.currentTarget.querySelector('button')
    button.disabled = true
    try {
      const result = await request('/admin/api/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: byId('username').value, password: byId('password').value })
      })
      byId('password').value = ''
      showDashboard(result.username)
      await loadData()
    } catch {
      showLogin('账号或密码错误')
    } finally { button.disabled = false }
  })
  byId('logout-button').addEventListener('click', async () => {
    try { await request('/admin/api/logout', { method: 'POST' }) } catch {}
    showLogin('')
  })
  byId('refresh-button').addEventListener('click', () => { void loadData() })
  byId('search-form').addEventListener('submit', (event) => {
    event.preventDefault(); state.query = byId('search-input').value.trim(); state.offset = 0; void loadData()
  })
  byId('previous-button').addEventListener('click', () => { state.offset = Math.max(0, state.offset - pageSize); void loadData() })
  byId('next-button').addEventListener('click', () => { if (state.offset + pageSize < state.total) { state.offset += pageSize; void loadData() } })
  renderFilters()
  request('/admin/api/session').then((session) => { showDashboard(session.username); return loadData() }).catch(() => showLogin(''))
})()`
