(async () => {
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => new Intl.NumberFormat('zh-TW').format(n);
  try {
    const { recording = true } = await chrome.storage.local.get({ recording: true });
    $('enabled').checked = recording;
    $('status').textContent = recording ? '已啟用・瀏覽 Threads 時自動記錄' : '已暫停記錄';
    $('enabled').addEventListener('change', async (event) => {
      const enabled = event.target.checked;
      await chrome.storage.local.set({ recording: enabled });
      $('status').textContent = enabled ? '已啟用・瀏覽 Threads 時自動記錄' : '已暫停記錄';
    });
    const counts = await ThreadsHistoryDB.counts();
    $('post-count').textContent = fmt(counts.posts);
    $('event-count').textContent = fmt(counts.events);
    const { rows } = await ThreadsHistoryDB.query({ limit: 6 });
    if (rows.length) $('latest').replaceChildren();
    for (const row of rows) {
      const item = document.createElement('a');
      item.className = 'item';
      item.href = row.post.url || 'https://www.threads.com/';
      item.target = '_blank';
      item.rel = 'noopener noreferrer';
      const dot = document.createElement('div');
      dot.className = `dot ${row.kind}`;
      const cont = document.createElement('div'); cont.className = 'content';
      const title = document.createElement('strong');
      title.textContent = `@${row.post.author || 'threads'} · ${row.kind === 'reply' ? '留言串' : row.kind === 'open' ? '打開貼文' : '觀看貼文'}`;
      const excerpt = document.createElement('p');
      excerpt.textContent = row.post.text || '（圖片／尚無文字摘要）';
      const time = document.createElement('time');
      time.textContent = new Date(row.at).toLocaleString('zh-TW');
      cont.append(title, excerpt, time);
      item.append(dot, cont);
      $('latest').append(item);
    }
  } catch (error) {
    $('error').textContent = '讀取失敗：' + (error.message || error);
  }
  $('dashboard').addEventListener('click', () => chrome.runtime.openOptionsPage());
})();
