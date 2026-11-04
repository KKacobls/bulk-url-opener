/* Every write goes through one extension-owned IndexedDB database. */
importScripts('core.js', 'db.js');

const DEFAULTS = Object.freeze({ recording: true, captureReplies: true });
const pendingImages = new Set();
const pendingQueue = [];
let activeImages = 0;

function isApprovedImageUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && value.length < 4096 &&
      (host === 'threads.com' || host.endsWith('.threads.com') ||
       host === 'fbcdn.net' || host.endsWith('.fbcdn.net') ||
       host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com'));
  } catch (_) { return false; }
}

function queueImages(items) {
  for (const item of items) {
    for (const url of item.post.images || []) {
      if (pendingImages.has(url)) continue;
      pendingImages.add(url);
      pendingQueue.push(url);
    }
  }
  drainImages();
}

function drainImages() {
  while (activeImages < 3 && pendingQueue.length) {
    const url = pendingQueue.shift();
    activeImages++;
    cacheImage(url).catch(() => {}).finally(() => {
      pendingImages.delete(url);
      activeImages--;
      drainImages();
    });
  }
}

async function cacheImage(url) {
  if (!isApprovedImageUrl(url) || await ThreadsHistoryDB.hasMedia(url)) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      credentials: 'omit', redirect: 'follow', signal: controller.signal
    });
    if (!response.ok) return;
    const size = Number(response.headers.get('content-length') || 0);
    if (size > 10 * 1024 * 1024) return;
    const blob = await response.blob();
    if (!blob.type.startsWith('image/') || blob.size < 100 || blob.size > 10 * 1024 * 1024) return;
    await ThreadsHistoryDB.saveMedia(url, blob);
  } finally { clearTimeout(timeout); }
}


function validateItem(item) {
  if (!item || typeof item !== 'object' || !item.post) return null;
  const post = item.post;
  if (!/^[A-Za-z0-9_-]{4,50}$/.test(String(post.id || ''))) return null;
  const parsed = ThreadsHistoryCore.parsePostUrl(post.url);
  if (!parsed || parsed.id !== post.id) return null;
  if (!['view', 'reply', 'open', 'media'].includes(item.kind)) return null;
  const at = Number(item.at);
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) > 86400000) return null;
  const contextId = /^[A-Za-z0-9_-]{4,50}$/.test(item.contextId || '') ? item.contextId : '';
  return {
    key: `${String(at).padStart(13, '0')}|${crypto.randomUUID()}`,
    at, kind: item.kind, contextId,
    page: ['feed', 'thread', 'profile', 'search'].includes(item.page) ? item.page : 'feed',
    post: {
      id: post.id,
      author: ThreadsHistoryCore.cleanText(String(post.author || parsed.author), 80),
      url: parsed.url,
      text: ThreadsHistoryCore.cleanText(post.text, 2200),
      postedAt: /^\d{4}-\d\d-\d\dT/.test(post.postedAt || '') ? String(post.postedAt).slice(0, 40) : '',
      images: (Array.isArray(post.images) ? post.images : []).slice(0, 80).filter((url) => isApprovedImageUrl(url))
    }
  };
}

let lastCaptureAt = 0;
async function capturePost(sender, message) {
  // Only capture the foreground Threads tab. Background and off-screen posts
  // remain archived as text/images without a screenshot.
  if (!sender.tab?.active || sender.tab?.windowId == null || sender.tab?.id == null) return { ok: false, error: 'tab not active' };
  if (!/^[A-Za-z0-9_-]{4,50}$/.test(String(message.id || ''))) return { ok: false, error: 'invalid id' };
  const r = message.rect, v = message.viewport;
  if (!r || !v || ![r.left, r.top, r.right, r.bottom, v.width, v.height].every(Number.isFinite)) return { ok: false, error: 'invalid rectangle' };
  if (r.right - r.left < 140 || r.bottom - r.top < 90 || v.width < 200 || v.height < 200) return { ok: false, error: 'too small' };
  if (Date.now() - lastCaptureAt < 1100) return { ok: false, error: 'rate limit' };
  if (await ThreadsHistoryDB.hasScreenshot(message.id)) return { ok: true, cached: true };
  const [frontTab] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
  if (frontTab?.id !== sender.tab.id || !/^https:\/\/(?:www\.)?threads\.(?:com|net)\//i.test(frontTab.url || '')) {
    return { ok: false, error: 'tab switched' };
  }
  const window = await chrome.windows.get(sender.tab.windowId);
  if (!window.focused) return { ok: false, error: 'not focused' };
  lastCaptureAt = Date.now();
  try {
    const png = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    const blob = await (await fetch(png)).blob();
    const bitmap = await createImageBitmap(blob);
    const scaleX = bitmap.width / v.width, scaleY = bitmap.height / v.height;
    const x = Math.max(0, Math.floor(r.left * scaleX));
    const y = Math.max(0, Math.floor(r.top * scaleY));
    const w = Math.min(bitmap.width - x, Math.ceil((r.right - r.left) * scaleX));
    const h = Math.min(bitmap.height - y, Math.ceil((r.bottom - r.top) * scaleY));
    if (w <= 0 || h <= 0) return { ok: false, error: 'crop empty' };
    const output = new OffscreenCanvas(w, h);
    output.getContext('2d').drawImage(bitmap, x, y, w, h, 0, 0, w, h);
    bitmap.close();
    const image = await output.convertToBlob({ type: 'image/webp', quality: 0.82 });
    await ThreadsHistoryDB.saveScreenshot(message.id, image);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const prefs = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (prefs[key] === undefined) missing[key] = value;
  }
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !['RECORD_BATCH', 'CAPTURE_POST'].includes(message.type)) return false;
  const senderUrl = sender.url || '';
  const isThreadsTab = Boolean(sender.tab && /^https:\/\/(?:www\.)?threads\.(?:com|net)\//i.test(senderUrl));
  if (!isThreadsTab) { sendResponse({ ok: false, error: '拒絕非 Threads 頁面' }); return false; }
  if (message.type === 'CAPTURE_POST') {
    capturePost(sender, message).then(sendResponse).catch(error =>
      sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  (async () => {
    try {
      const { recording, captureReplies } = await chrome.storage.local.get(DEFAULTS);
      if (!recording) return { ok: true, saved: 0 };
      const raw = Array.isArray(message.items) ? message.items.slice(0, 100) : [];
      const items = raw.map(validateItem).filter(Boolean).filter((item) => captureReplies || item.kind !== 'reply');
      const saved = await ThreadsHistoryDB.commitBatch(items);
      queueImages(items);
      return { ok: true, saved };
    } catch (error) {
      console.error('[Threads History]', error);
      return { ok: false, error: String(error?.message || error) };
    }
  })().then(sendResponse);
  return true;
});
