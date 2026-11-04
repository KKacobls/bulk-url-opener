(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const number = new Intl.NumberFormat('zh-TW');
  const state = { before: null, busy: false, filters: null, generation: 0, lastDate: '', allRendered: 0 };

  function localDate(at) {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function dateTitle(at) {
    return new Date(at).toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  }
  function niceTime(at) {
    return new Date(at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function labelOf(row) {
    return row.kind === 'reply' ? '留言串內貼文' : row.kind === 'open' ? '打開貼文' : '觀看貼文';
  }
  const textNode = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text;
    return el;
  };

  const cachedObjectUrls = new Set();
  const lightbox = document.createElement('div');
  lightbox.style.cssText = 'position:fixed;inset:0;z-index:1000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.92);padding:24px;cursor:zoom-out';
  lightbox.setAttribute('role', 'dialog');
  lightbox.setAttribute('aria-modal', 'true');
  lightbox.setAttribute('aria-label', '圖片放大檢視');
  const enlarged = document.createElement('img');
  enlarged.style.cssText = 'display:block;max-width:100%;max-height:95vh;object-fit:contain;cursor:default;border-radius:7px';
  const closeLarge = document.createElement('button');
  closeLarge.type = 'button';
  closeLarge.textContent = '×';
  closeLarge.setAttribute('aria-label', '關閉圖片');
  closeLarge.style.cssText = 'position:absolute;top:12px;right:16px;font-size:32px;border:0;background:transparent;color:white;cursor:pointer';
  lightbox.append(enlarged, closeLarge);
  document.body.append(lightbox);
  let previousFocus = null;
  function hideLarge() {
    lightbox.style.display = 'none';
    enlarged.removeAttribute('src');
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  function showLarge(url) {
    if (!url) return;
    previousFocus = document.activeElement;
    enlarged.src = url;
    lightbox.style.display = 'flex';
    closeLarge.focus();
  }
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) hideLarge(); });
  enlarged.addEventListener('click', e => e.stopPropagation());
  closeLarge.addEventListener('click', hideLarge);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && lightbox.style.display !== 'none') {
      e.preventDefault(); e.stopImmediatePropagation(); hideLarge();
    }
  }, true);

  function mediaGallery(post) {
    if (!Array.isArray(post.images) || !post.images.length) return null;
    const gallery = document.createElement('div');
    gallery.className = 'media-gallery';
    gallery.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(125px,1fr));gap:8px;margin:12px 0 15px';
    for (const url of post.images.slice(0, 40)) {
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.alt = '貼文圖片'; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      img.src = url;
      img.style.cssText = 'width:100%;height:155px;object-fit:cover;border-radius:9px';
      a.addEventListener('click', (event) => { event.preventDefault(); showLarge(a.href); });
      a.append(img); gallery.append(a);
      ThreadsHistoryDB.getMedia(url).then(blob => {
        if (!blob || !img.isConnected) return;
        const local = URL.createObjectURL(blob);
        cachedObjectUrls.add(local);
        img.src = local; a.href = local;
      }).catch(() => {});
    }
    return gallery;
  }
  window.addEventListener('pagehide', () => {
    for (const url of cachedObjectUrls) URL.revokeObjectURL(url);
    cachedObjectUrls.clear();
  });

  function screenshotPreview(post) {
    const holder = document.createElement('div');
    holder.className = 'post-screenshot';
    ThreadsHistoryDB.getScreenshot(post.id).then(blob => {
      if (!blob || !holder.isConnected) return;
      const url = URL.createObjectURL(blob);
      cachedObjectUrls.add(url);
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.src = url;
      img.alt = '當時可見區域的貼文截圖';
      img.style.cssText = 'display:block;max-width:100%;max-height:430px;object-fit:contain;border:1px solid #434852;border-radius:11px;margin:10px 0';
      a.addEventListener('click', (event) => { event.preventDefault(); showLarge(a.href); });
      a.append(img);
      holder.append(a);
    }).catch(() => {});
    return holder;
  }

  function renderRow(row) {
    const el = document.createElement('article');
    el.className = 'record';
    const time = textNode('div', 'record-time', niceTime(row.at));
    time.append(textNode('small', '', new Date(row.at).toLocaleTimeString('zh-TW', { second: '2-digit', minute: '2-digit', hour: '2-digit', hour12: false }).split(':').at(-1) + ' 秒'));
    const line = textNode('div', `record-line ${row.kind}`, '');
    const body = textNode('div', 'record-body', '');
    const top = textNode('div', 'record-top', '');
    const author = textNode('span', 'user', `@${row.post.author || 'unknown'}`);
    const pill = textNode('span', `pill ${row.kind}`, labelOf(row));
    top.append(author, pill);
    if (row.kind === 'reply' && row.contextId) {
      top.append(textNode('span', 'pill', `留言串 #${row.contextId.slice(0, 9)}`));
    }
    const content = textNode('p', 'record-excerpt', row.post.text || '（圖片或尚未擷取到文字。點擊原文查看完整內容。）');
    const actions = textNode('div', 'record-actions', '');
    const link = document.createElement('a');
    link.href = row.post.url || 'https://www.threads.com/';
    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '開啟原始貼文 ↗';
    const detail = textNode('button', 'subtle', `這則共觀看 ${number.format(row.post.viewCount || 0)} 次 · 查看時間`);
    detail.type = 'button';
    detail.addEventListener('click', () => showPostDetail(row.post));
    actions.append(link, detail);
    body.append(top, content, screenshotPreview(row.post));
    const gallery = mediaGallery(row.post);
    if (gallery) body.append(gallery);
    body.append(actions);
    el.append(time, line, body);
    return el;
  }

  function getFilters() {
    const from = $('date-from').value ? new Date(`${$('date-from').value}T00:00:00`).getTime() : null;
    const to = $('date-to').value ? new Date(`${$('date-to').value}T23:59:59.999`).getTime() : null;
    return { q: $('search').value.trim(), kind: $('kind').value, from, to, limit: 60 };
  }

  function appendDay(at) {
    const date = localDate(at);
    if (state.lastDate !== date) {
      state.lastDate = date;
      $('records').append(textNode('div', 'day-heading', dateTitle(at)));
    }
  }

  async function fetchRecords(reset = false) {
    if (state.busy && !reset) return;
    const generation = reset ? ++state.generation : state.generation;
    if (reset) {
      state.before = null;
      state.lastDate = '';
      state.allRendered = 0;
      state.filters = getFilters();
      $('records').replaceChildren();
      $('more').hidden = true;
    }
    state.busy = true;
    $('read-error').textContent = '';
    $('result-hint').textContent = '正在讀取…';
    try {
      const result = await ThreadsHistoryDB.query({ ...state.filters, before: state.before });
      if (generation !== state.generation) return;
      for (const row of result.rows) {
        appendDay(row.at);
        $('records').append(renderRow(row));
        state.allRendered++;
      }
      state.before = result.before;
      $('more').hidden = !state.before;
      $('result-hint').textContent = `已顯示 ${number.format(state.allRendered)} 筆 · 依載入時間排序`;
      if (!state.allRendered) {
        const empty = textNode('div', 'empty-view', '');
        empty.append(textNode('strong', '', '這個條件下還沒有紀錄'),
          textNode('div', '', '試著清除篩選，或在 Threads 開啟貼文後再回來。'));
        $('records').append(empty);
      }
    } catch (error) {
      if (generation === state.generation) $('read-error').textContent = `讀取失敗：${error?.message || error}`;
    } finally {
      if (generation === state.generation) state.busy = false;
    }
  }

  async function refreshCounts() {
    const [counts, { recording = true }] = await Promise.all([
      ThreadsHistoryDB.counts(), chrome.storage.local.get({ recording: true })
    ]);
    $('stat-posts').textContent = number.format(counts.posts);
    $('stat-events').textContent = number.format(counts.events);
    $('stat-status').textContent = recording ? '記錄中' : '已暫停';
    $('stat-status').style.color = recording ? '#9be5c0' : '#f1c38d';
  }

  async function showPostDetail(post) {
    $('detail-backdrop').hidden = false;
    const body = $('detail-body'); body.replaceChildren();
    body.append(
      textNode('div', 'dialog-meta', `@${post.author || 'unknown'} · ${post.id}`),
      textNode('p', 'dialog-text', post.text || '（無文字摘要）')
    );
    const link = document.createElement('a');
    link.href = post.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = '原始貼文 ↗'; link.style.color = '#9cdec0';
    body.append(screenshotPreview(post));
    const gallery = mediaGallery(post);
    if (gallery) body.append(gallery);
    body.append(link, textNode('h3', '', '最近的觀看與開啟紀錄'));
    try {
      const result = await ThreadsHistoryDB.query({ postId: post.id, limit: 100 });
      for (const row of result.rows) {
        body.append(textNode('div', 'dialog-event',
          `${new Date(row.at).toLocaleString('zh-TW')} · ${labelOf(row)}`));
      }
      if (result.before) body.append(textNode('p', 'dialog-meta', '只顯示最近 100 次事件，可在匯出的 JSON 查看全部。'));
    } catch (err) {
      body.append(textNode('p', 'error', err.message || String(err)));
    }
  }

  function closeDetail() { $('detail-backdrop').hidden = true; }
  $('close-detail').addEventListener('click', closeDetail);
  $('detail-backdrop').addEventListener('click', (event) => { if (event.target === $('detail-backdrop')) closeDetail(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDetail(); });

  let debounce;
  for (const id of ['search', 'kind', 'date-from', 'date-to']) {
    $(id).addEventListener(id === 'search' ? 'input' : 'change', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => fetchRecords(true), id === 'search' ? 300 : 0);
    });
  }
  $('reset').addEventListener('click', () => {
    for (const id of ['search', 'kind', 'date-from', 'date-to']) $(id).value = '';
    fetchRecords(true);
  });
  $('more').addEventListener('click', () => fetchRecords());

  async function initSettings() {
    const prefs = await chrome.storage.local.get({ recording: true, captureReplies: true, dwellMs: 1500, cooldownMs: 45000 });
    $('recording').checked = prefs.recording;
    $('replies').checked = prefs.captureReplies;
    const set = async (key, value) => {
      await chrome.storage.local.set({ [key]: value });
      $('settings-message').textContent = '設定已儲存';
      await refreshCounts();
    };
    $('recording').addEventListener('change', (ev) => set('recording', ev.target.checked));
    $('replies').addEventListener('change', (ev) => set('captureReplies', ev.target.checked));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.recording) $('recording').checked = changes.recording.newValue;
      if (changes.captureReplies) $('replies').checked = changes.captureReplies.newValue;
      refreshCounts().catch(() => {});
    });
  }

  function saveFile(data, filename, mime) {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  const csvCell = (value) => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  const dateSuffix = () => localDate(Date.now());
  $('export-json').addEventListener('click', async () => {
    try {
      $('settings-message').textContent = '正在準備 JSON…';
      const data = await ThreadsHistoryDB.allData();
      saveFile(JSON.stringify(data, null, 2), `threads-history-${dateSuffix()}.json`, 'application/json;charset=utf-8');
      $('settings-message').textContent = `已匯出 ${number.format(data.events.length)} 筆事件`;
    } catch (err) { $('settings-message').textContent = `匯出失敗：${err.message}`; }
  });
  $('export-csv').addEventListener('click', async () => {
    try {
      $('settings-message').textContent = '正在準備 CSV…';
      const data = await ThreadsHistoryDB.allData();
      const posts = new Map(data.posts.map(p => [p.id, p]));
      const header = ['觀看時間（本機）', '事件類型', '貼文ID', '作者', '貼文文字', '發文時間', '永久連結', '留言串ID', '觀看次數', '圖片網址'];
      const lines = [header.map(csvCell).join(',')];
      for (const event of data.events) {
        const post = posts.get(event.postId) || {};
        lines.push([
          new Date(event.at).toLocaleString('zh-TW'), labelOf(event),
          event.postId, post.author, post.text, post.postedAt,
          post.url, event.contextId, post.viewCount, (post.images || []).join(' | ')
        ].map(csvCell).join(','));
      }
      // Excel in Windows reliably recognizes UTF-8 with a BOM.
      saveFile('\ufeff' + lines.join('\r\n'), `threads-history-${dateSuffix()}.csv`, 'text/csv;charset=utf-8');
      $('settings-message').textContent = `已匯出 ${number.format(data.events.length)} 筆事件`;
    } catch (err) { $('settings-message').textContent = `匯出失敗：${err.message}`; }
  });
  $('delete-all').addEventListener('click', async () => {
    if (!confirm('確定要永久清除所有 Threads 觀看紀錄嗎？建議先匯出 JSON 備份。')) return;
    if (!confirm('再次確認：此操作無法復原。真的清除嗎？')) return;
    try {
      await ThreadsHistoryDB.clearAll();
      await Promise.all([refreshCounts(), fetchRecords(true)]);
      $('settings-message').textContent = '全部紀錄已清空。';
    } catch (err) { $('settings-message').textContent = `清除失敗：${err.message}`; }
  });

  Promise.all([initSettings(), refreshCounts(), fetchRecords(true)]).catch((error) => {
    $('read-error').textContent = '初始化失敗：' + (error.message || error);
  });
})();
