/* Shared, dependency-free helpers. */
(function (root) {
  'use strict';
  const ALLOWED_HOSTS = new Set(['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net']);

  function parsePostUrl(raw, base = 'https://www.threads.com/') {
    try {
      const url = new URL(raw, base);
      if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase()) || url.protocol !== 'https:') return null;
      const path = decodeURIComponent(url.pathname);
      let match = path.match(/^\/@([^/]+)\/post\/([A-Za-z0-9_-]{4,50})(?:\/|$)/i);
      if (match) {
        const author = match[1].replace(/^@/, '');
        const code = match[2];
        return { id: code, author, url: `https://www.threads.com/@${encodeURIComponent(author)}/post/${code}` };
      }
      match = path.match(/^\/t\/([A-Za-z0-9_-]{4,50})(?:\/|$)/i);
      if (match) {
        const code = match[1];
        return { id: code, author: '', url: `https://www.threads.com/t/${code}` };
      }
    } catch (_) { /* Non-URL. */ }
    return null;
  }

  function cleanText(raw, maxLen = 2200) {
    return String(raw || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\t\u00a0]+/g, ' ')
      .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
      .replace(/\n[ \t]+/g, '\n')
      .trim()
      .slice(0, maxLen);
  }

  function visibilityRatio(rect, viewportWidth, viewportHeight) {
    const width = Math.max(0, rect.width || rect.right - rect.left);
    const height = Math.max(0, rect.height || rect.bottom - rect.top);
    if (!width || !height) return 0;
    const shownH = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
    const shownW = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
    return (shownH / Math.min(height, viewportHeight)) * (shownW / Math.min(width, viewportWidth));
  }

  function eligibleRevisit(lastLogged, lastDisappeared, now, cooldownMs, absentMs) {
    return !lastLogged || (lastDisappeared > 0 && now - lastDisappeared >= absentMs && now - lastLogged >= cooldownMs);
  }

  const core = Object.freeze({ parsePostUrl, cleanText, visibilityRatio, eligibleRevisit });
  root.ThreadsHistoryCore = core;
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
