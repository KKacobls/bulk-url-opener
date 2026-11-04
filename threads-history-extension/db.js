/* IndexedDB is owned by the extension origin (not the Threads website). */
(function (root) {
  'use strict';
  const NAME = 'threads-history-v1';
  const VERSION = 2;
  let openPromise;

  function open() {
    if (openPromise) return openPromise;
    openPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(NAME, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('posts')) {
          const posts = db.createObjectStore('posts', { keyPath: 'id' });
          posts.createIndex('lastSeenAt', 'lastSeenAt');
        }
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'url' });
        if (!db.objectStoreNames.contains('screenshots')) db.createObjectStore('screenshots', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('events')) {
          const events = db.createObjectStore('events', { keyPath: 'key' });
          events.createIndex('byPost', 'postId');
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); openPromise = null; };
        resolve(db);
      };
      request.onerror = () => { openPromise = null; reject(request.error); };
      request.onblocked = () => { openPromise = null; reject(new Error('資料庫正在被其他視窗佔用，請關閉舊視窗再試')); };
    });
    return openPromise;
  }

  function asPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function commitBatch(items) {
    if (!items.length) return Promise.resolve(0);
    return open().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(['posts', 'events'], 'readwrite');
      const posts = transaction.objectStore('posts');
      const events = transaction.objectStore('events');
      let finished = 0;
      transaction.oncomplete = () => resolve(finished);
      transaction.onerror = () => reject(transaction.error || new Error('資料庫交易失敗'));
      transaction.onabort = () => reject(transaction.error || new Error('資料庫交易中止'));
      // Sequential get->put inside the transaction makes repeated IDs in a
      // single batch count correctly (IDB transactions serialize across tabs).
      let index = 0;
      function processNext() {
        if (index >= items.length) return;
        const item = items[index++];
        const req = posts.get(item.post.id);
        req.onsuccess = () => {
          const prev = req.result;
          const newPost = {
            id: item.post.id,
            url: item.post.url || prev?.url || '',
            author: item.post.author || prev?.author || '',
            text: item.post.text || prev?.text || '',
            postedAt: item.post.postedAt || prev?.postedAt || '',
            images: [...new Set([...(prev?.images || []), ...(item.post.images || [])])].slice(0, 80),
            firstSeenAt: Math.min(prev?.firstSeenAt ?? Infinity, item.at),
            lastSeenAt: Math.max(prev?.lastSeenAt || 0, item.at),
            viewCount: (prev?.viewCount || 0) + (item.kind === 'view' || item.kind === 'reply' ? 1 : 0),
            openCount: (prev?.openCount || 0) + (item.kind === 'open' ? 1 : 0)
          };
          posts.put(newPost);
          if (item.kind !== 'media') events.put({
            key: item.key,
            postId: item.post.id,
            kind: item.kind,
            at: item.at,
            contextId: item.contextId || '',
            page: item.page || 'feed'
          });
          finished++;
          processNext();
        };
      }
      processNext();
    }));
  }

  async function hasMedia(url) {
    const db = await open();
    return Boolean(await asPromise(db.transaction('media', 'readonly').objectStore('media').getKey(url)));
  }

  async function saveMedia(url, blob) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('media', 'readwrite');
      tx.objectStore('media').put({ url, blob, savedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function getMedia(url) {
    const db = await open();
    return (await asPromise(db.transaction('media', 'readonly').objectStore('media').get(url)))?.blob || null;
  }

  async function hasScreenshot(id) {
    const db = await open();
    return Boolean(await asPromise(db.transaction('screenshots', 'readonly')
      .objectStore('screenshots').getKey(id)));
  }

  async function saveScreenshot(id, blob) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('screenshots', 'readwrite');
      tx.objectStore('screenshots').put({ id, blob, at: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function getScreenshot(id) {
    const db = await open();
    return (await asPromise(db.transaction('screenshots', 'readonly')
      .objectStore('screenshots').get(id)))?.blob || null;
  }

  async function counts() {
    const db = await open();
    const tx = db.transaction(['posts', 'events'], 'readonly');
    const p = await asPromise(tx.objectStore('posts').count());
    const e = await asPromise(tx.objectStore('events').count());
    return { posts: p, events: e };
  }

  async function query({ before = null, limit = 80, from = null, to = null,
                         q = '', kind = '', postId = '' } = {}) {
    const db = await open();
    const tx = db.transaction(['posts', 'events'], 'readonly');
    const posts = tx.objectStore('posts');
    const events = tx.objectStore('events');
    const out = [];
    let nextCursor = null;
    let scanned = 0;
    const term = String(q || '').toLowerCase().trim();
    const endKey = before || (Number.isFinite(to) ? String(to).padStart(13, '0') + '|\uffff' : null);
    const keyRange = endKey ? IDBKeyRange.upperBound(endKey, !!before) : null;
    const max = Math.min(150, Math.max(1, Number(limit) || 80));
    // The query scans a bounded page so large histories remain responsive.
    return new Promise((resolve, reject) => {
      let hasMore = false;
      const request = events.openCursor(keyRange, 'prev');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve({ rows: out, before: null }); return; }
        const ev = cursor.value;
        scanned++;
        if (Number.isFinite(from) && ev.at < from) { resolve({ rows: out, before: null }); return; }
        const match = (!kind || ev.kind === kind) && (!postId || ev.postId === postId);
        const advance = () => {
          if (out.length >= max || scanned >= 12000) {
            // Next call resumes after the last scanned event, not merely the last match.
            nextCursor = cursor.key;
            hasMore = true;
            resolve({ rows: out, before: hasMore ? nextCursor : null });
          } else cursor.continue();
        };
        if (!match) { advance(); return; }
        const pReq = posts.get(ev.postId);
        pReq.onerror = () => reject(pReq.error);
        pReq.onsuccess = () => {
          const post = pReq.result || { id: ev.postId, author: '', text: '', url: '', viewCount: 0 };
          if (!term || (`${post.author} ${post.text} ${ev.postId}`).toLowerCase().includes(term)) {
            out.push({ ...ev, post });
          }
          advance();
        };
      };
    });
  }

  async function allData() {
    const db = await open();
    const tx = db.transaction(['posts', 'events'], 'readonly');
    const [posts, events] = await Promise.all([
      asPromise(tx.objectStore('posts').getAll()),
      asPromise(tx.objectStore('events').getAll())
    ]);
    return { version: 1, exportedAt: new Date().toISOString(), posts, events };
  }

  function clearAll() {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(['posts', 'events', 'media', 'screenshots'], 'readwrite');
      tx.objectStore('posts').clear();
      tx.objectStore('events').clear();
      tx.objectStore('media').clear();
      tx.objectStore('screenshots').clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  root.ThreadsHistoryDB = { open, commitBatch, hasMedia, saveMedia, getMedia, hasScreenshot, saveScreenshot, getScreenshot, counts, query, allData, clearAll };
})(typeof globalThis !== 'undefined' ? globalThis : this);
