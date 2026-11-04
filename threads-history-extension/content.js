(() => {
  'use strict';
  if (window.top !== window) return;
  if (window.__threadsHistoryCaptureV1) return;
  window.__threadsHistoryCaptureV1 = true;

  const C = ThreadsHistoryCore;
  const MAX_TRACKED = 4500;
  const tracked = new Map();
  const queue = [];
  let preferences = { recording: true, captureReplies: true };
  let context = null;
  let lastHref = '';
  let lastOpenedPost = '';
  let sendInProgress = false;
  let lastMutationScan = 0;
  let scanTimer;
  let navPoll;

  async function loadPreferences() {
    try { preferences = { ...preferences, ...await chrome.storage.local.get(preferences) }; }
    catch (_) { /* Extension reloaded; previous content script is no longer valid. */ }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, value] of Object.entries(changes)) {
      if (Object.hasOwn(preferences, key)) preferences[key] = value.newValue;
    }
    if (!preferences.recording) { queue.length = 0; tracked.clear(); }
  });

  function determinePage() {
    const path = location.pathname;
    const root = C.parsePostUrl(location.href);
    if (root) return { page: 'thread', root };
    if (/^\/@[^/]+/.test(path)) return { page: 'profile', root: null };
    if (/search|\/tag\//i.test(path)) return { page: 'search', root: null };
    return { page: 'feed', root: null };
  }

  function findCard(link) {
    let first = link.closest('[data-pressable-container], article, [role="article"]');
    if (first && first.getBoundingClientRect().height >= 55) return first;
    const routeRoot = C.parsePostUrl(location.href);
    let current = link;
    let best = null;
    for (let i = 0; current && i < 12; i++, current = current.parentElement) {
      if (!current || current === document.body || current === document.documentElement) break;
      const height = current.getBoundingClientRect().height;
      const times = current.querySelectorAll('time').length;
      const bodyLength = (current.innerText || '').trim().length;
      if (height > 55 && bodyLength > 10 && times <= 1) best = current;
      if (times > 1 || height > window.innerHeight * 2.7 || bodyLength > 6500) break;
      if (i > 3 && times === 0 && routeRoot == null && bodyLength > 800) break;
    }
    return best || first || link.parentElement;
  }

  function isRenderable(card) {
    // The user requested loaded DOM entries, including those not on screen.
    return Boolean(card && card.isConnected);
  }

  function getPostText(card, author) {
    const selections = [...card.querySelectorAll('[dir="auto"]')];
    const chunks = [];
    for (const node of selections) {
      if (node.closest('time, button, nav, [role="button"], [aria-hidden="true"]')) continue;
      if (node.closest('a[href*="/post/"], a[href*="/t/"]') && node.textContent.trim().length < 25) continue;
      if (selections.some(other => other !== node && node.contains(other))) continue;
      const value = C.cleanText(node.innerText || node.textContent, 600);
      if (!value || value === author || value === `@${author}`) continue;
      if (/^(Like|Reply|Repost|Share|Translate|更多|回覆|按讚|轉發|分享|查看翻譯|追蹤)$/i.test(value)) continue;
      if (!chunks.includes(value)) chunks.push(value);
      if (chunks.join('\n').length > 2100) break;
    }
    if (chunks.length) return C.cleanText(chunks.join('\n'), 2200);
    // Some media-only posts have no usable text. Avoid saving action controls as content.
    return '';
  }

  function getPostImages(card) {
    if (!card) return [];
    const result = new Set();
    for (const img of card.querySelectorAll('img')) {
      if (!img.complete || img.naturalWidth < 100 || img.naturalHeight < 75) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width < 95 || rect.height < 65) continue;
      if (img.closest('header, nav, [aria-hidden="true"]')) continue;
      const raw = img.currentSrc || img.src || '';
      try {
        const url = new URL(raw, location.href);
        if (url.protocol === 'https:' && url.href.length < 4096) result.add(url.href);
      } catch (_) {}
      if (result.size >= 80) break;
    }
    for (const video of card.querySelectorAll('video[poster]')) {
      try {
        const url = new URL(video.poster, location.href);
        if (url.protocol === 'https:' && url.href.length < 4096) result.add(url.href);
      } catch (_) {}
      if (result.size >= 80) break;
    }
    return [...result];
  }

  function inferPostedAt(card, link) {
    const time = link.querySelector('time') || card.querySelector('time');
    if (!time) return '';
    const value = time.getAttribute('datetime') || time.getAttribute('dateTime') || '';
    const date = value && new Date(value);
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
  }

  function findVisiblePosts() {
    const selected = new Map();
    const links = document.querySelectorAll('a[href*="/post/"], a[href*="/t/"]');
    let checked = 0;
    for (const link of links) {
      if (++checked > 1800) break;
      const parsed = C.parsePostUrl(link.getAttribute('href'), location.href);
      if (!parsed) continue;
      const card = findCard(link);
      if (!isRenderable(card)) continue;
      const timeLink = Boolean(link.querySelector('time'));
      const hasTime = Boolean(card.querySelector('time'));
      const isRoot = parsed.id === context?.root?.id;
      // A quoted permalink inside another card must not become a bogus view.
      // A timestamp link strongly indicates its own independent post.
      if (!timeLink && !isRoot && !(card.matches('article,[role="article"],[data-pressable-container]') && hasTime)) continue;
      const score = (timeLink ? 5 : 0) + (hasTime ? 2 : 0) + (isRoot ? 1 : 0);
      const prev = selected.get(parsed.id);
      if (!prev || score > prev.score) selected.set(parsed.id, { parsed, card, link, score });
    }
    // On direct permalink pages with no timestamp anchor, use a visible article
    // fallback only if it has enough content and the root post's URL is exact.
    if (context?.root && !selected.has(context.root.id)) {
      const fallback = [...document.querySelectorAll('article,[role="article"],[data-pressable-container]')]
        .find((el) => [...el.querySelectorAll('a[href*="/post/"],a[href*="/t/"]')]
          .some(a => C.parsePostUrl(a.getAttribute('href'), location.href)?.id === context.root.id)
          && el.isConnected);
      if (fallback) selected.set(context.root.id, { parsed: context.root, card: fallback, link: fallback, score: 0 });
    }
    return selected;
  }

  function pushEvent(parsed, kind, card = null, link = null) {
    const at = Date.now();
    const text = card ? getPostText(card, parsed.author) : '';
    const postedAt = card ? inferPostedAt(card, link || card) : '';
    queue.push({
      at, kind, contextId: context?.root?.id || '', page: context?.page || 'feed',
      post: { id: parsed.id, author: parsed.author, url: parsed.url, text, postedAt, images: getPostImages(card) }
    });
    if (queue.length >= 10) flush();
  }

  async function flush() {
    if (sendInProgress || !queue.length) return;
    if (!preferences.recording) { queue.length = 0; return; }
    sendInProgress = true;
    const batch = queue.splice(0, 70);
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'RECORD_BATCH', items: batch });
      if (!reply?.ok) throw new Error(reply?.error || '無法寫入');
    } catch (error) {
      // Retain a bounded retry buffer during temporary service-worker failures.
      if (/Extension context invalidated/i.test(String(error))) {
        queue.length = 0;
      } else {
        queue.unshift(...batch);
        if (queue.length > 500) queue.splice(0, queue.length - 500);
      }
    } finally { sendInProgress = false; }
  }

  const screenshotDone = new Set();
  let lastScreenshotAt = 0;
  function maybeScreenshot(parsed, card) {
    if (screenshotDone.has(parsed.id) || !card || document.hidden || !document.hasFocus()) return;
    if (Date.now() - lastScreenshotAt < 1000) return;
    const rect = card.getBoundingClientRect();
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    if (right - left < 140 || bottom - top < 90) return;
    lastScreenshotAt = Date.now();
    screenshotDone.add(parsed.id);
    chrome.runtime.sendMessage({
      type: 'CAPTURE_POST', id: parsed.id, viewport: { width: innerWidth, height: innerHeight },
      rect: { left, top, right, bottom }
    }).then(response => {
      if (!response?.ok) screenshotDone.delete(parsed.id);
    }).catch(() => screenshotDone.delete(parsed.id));
  }

  function trackLoaded() {
    if (!preferences.recording) return;
    const posts = findVisiblePosts();
    for (const [id, candidate] of posts) {
      const isReply = Boolean(context?.root && id !== context.root.id);
      if (isReply && !preferences.captureReplies) continue;
      const signature = JSON.stringify([
        getPostText(candidate.card, candidate.parsed.author),
        getPostImages(candidate.card)
      ]);
      const lastSignature = tracked.get(id);
      if (lastSignature === undefined) {
        tracked.set(id, signature);
        pushEvent(candidate.parsed, isReply ? 'reply' : 'view', candidate.card, candidate.link);
      } else if (lastSignature !== signature) {
        // Lazy images / edited DOM update the saved snapshot, not view count.
        tracked.set(id, signature);
        pushEvent(candidate.parsed, 'media', candidate.card, candidate.link);
      }
      maybeScreenshot(candidate.parsed, candidate.card);
      if (tracked.size > MAX_TRACKED) tracked.delete(tracked.keys().next().value);
    }
  }

  function routeChanged() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    context = determinePage();
    tracked.clear();
    screenshotDone.clear();
    const root = context.root;
    if (preferences.recording && root && root.id !== lastOpenedPost) {
      // Explicit permalink navigation is recorded separately from a qualified view.
      pushEvent(root, 'open');
    }
    lastOpenedPost = root?.id || '';
    trackLoaded();
  }

  function scheduleSoon() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; trackLoaded(); }, 180);
  }

  window.addEventListener('scroll', scheduleSoon, { passive: true });
  window.addEventListener('resize', scheduleSoon, { passive: true });
  // Deferred image load events update the archived media list.
  document.addEventListener('load', (event) => {
    if (event.target instanceof HTMLImageElement || event.target instanceof HTMLVideoElement) scheduleSoon();
  }, true);
  window.addEventListener('focus', scheduleSoon);

  window.addEventListener('pagehide', () => { flush(); });

  const observer = new MutationObserver(() => {
    const now = Date.now();
    if (now - lastMutationScan > 200) { lastMutationScan = now; scheduleSoon(); }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Threads frequently uses client-side navigation without a full page reload.
  navPoll = setInterval(routeChanged, 500);
  setInterval(trackLoaded, 1400);
  setInterval(flush, 2500);
  loadPreferences().then(() => { routeChanged(); trackLoaded(); });
})();
