/* Every write goes through one extension-owned IndexedDB database. */
importScripts('core.js', 'db.js');

const DEFAULTS = Object.freeze({ recording: true, captureReplies: true, dwellMs: 1500, cooldownMs: 45000 });

function validateItem(item) {
  if (!item || typeof item !== 'object' || !item.post) return null;
  const post = item.post;
  if (!/^[A-Za-z0-9_-]{4,50}$/.test(String(post.id || ''))) return null;
  const parsed = ThreadsHistoryCore.parsePostUrl(post.url);
  if (!parsed || parsed.id !== post.id) return null;
  if (!['view', 'reply', 'open'].includes(item.kind)) return null;
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
      postedAt: /^\d{4}-\d\d-\d\dT/.test(post.postedAt || '') ? String(post.postedAt).slice(0, 40) : ''
    }
  };
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
  if (!message || message.type !== 'RECORD_BATCH') return false;
  const senderUrl = sender.url || '';
  const isThreadsTab = Boolean(sender.tab && /^https:\/\/(?:www\.)?threads\.(?:com|net)\//i.test(senderUrl));
  if (!isThreadsTab) { sendResponse({ ok: false, error: '拒絕非 Threads 頁面' }); return false; }
  (async () => {
    try {
      const { recording, captureReplies } = await chrome.storage.local.get(DEFAULTS);
      if (!recording) return { ok: true, saved: 0 };
      const raw = Array.isArray(message.items) ? message.items.slice(0, 100) : [];
      const items = raw.map(validateItem).filter(Boolean).filter((item) => captureReplies || item.kind !== 'reply');
      const saved = await ThreadsHistoryDB.commitBatch(items);
      return { ok: true, saved };
    } catch (error) {
      console.error('[Threads History]', error);
      return { ok: false, error: String(error?.message || error) };
    }
  })().then(sendResponse);
  return true;
});
