// Small in-memory IndexedDB test double, to test read/write code without a network or a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const stores = new Map();
const schema = new Set();
function request(tx, fn) {
  const req = { result: undefined, error: null, onsuccess: null, onerror: null };
  tx.enqueue(() => {
    try { req.result = fn(); req.onsuccess?.({ target: req }); }
    catch (err) { req.error = err; req.onerror?.({ target: req }); tx.onerror?.({ target: tx }); }
  });
  return req;
}
const db = {
  objectStoreNames: { contains: (name) => schema.has(name) },
  createObjectStore(name, { keyPath }) {
    schema.add(name); stores.set(name, new Map());
    return { createIndex() {} };
  },
  transaction(names) {
    const tasks = [];
    const tx = {
      oncomplete: null, onerror: null, onabort: null,
      enqueue(fn) {
        tasks.push(fn);
        if (tasks.length === 1) setTimeout(process, 0);
      },
      objectStore(name) {
        const data = stores.get(name);
        return {
          get: (id) => request(tx, () => data.get(id)),
          put: (obj) => request(tx, () => { data.set(obj.id || obj.key, structuredClone(obj)); return obj.id || obj.key; }),
          count: () => request(tx, () => data.size),
          getAll: () => request(tx, () => [...data.values()].map(x => structuredClone(x))),
          clear: () => request(tx, () => data.clear()),
          openCursor(range, direction) {
            const keys = [...data.keys()].sort();
            if (direction === 'prev') keys.reverse();
            const valid = keys.filter(k => !range || (range.exclusive ? k < range.upper : k <= range.upper));
            let i = 0;
            const req = { onsuccess: null, onerror: null, result: null, error: null };
            function emit() {
              tx.enqueue(() => {
                const key = valid[i++];
                req.result = key === undefined ? null : {
                  key, value: structuredClone(data.get(key)), continue: emit
                };
                req.onsuccess?.();
              });
            }
            emit(); return req;
          }
        };
      }
    };
    function process() {
      const fn = tasks.shift();
      if (fn) fn();
      if (tasks.length) setTimeout(process, 0);
      else setTimeout(() => { if (!tasks.length) tx.oncomplete?.(); else process(); }, 0);
    }
    return tx;
  }
};
const indexedDB = {
  open() {
    const req = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null };
    setTimeout(() => { req.onupgradeneeded?.(); req.onsuccess?.(); }, 0);
    return req;
  }
};
const sandbox = { indexedDB, IDBKeyRange: { upperBound: (upper, exclusive) => ({ upper, exclusive }) },
  setTimeout, console, Promise, structuredClone, Date, Map, Math };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../db.js'), 'utf8'), sandbox);
const DB = sandbox.ThreadsHistoryDB;
(async () => {
  const base = Date.now() - 5000;
  const post = { id:'CABtest12345',author:'tester',url:'https://www.threads.com/@tester/post/CABtest12345',text:'hello',postedAt:'' };
  const make = (at, kind, text) => ({
    key:`${String(at).padStart(13, '0')}|${String(at)}`,at,kind,
    post: { ...post, text }, page:'feed', contextId:''
  });
  await DB.commitBatch([make(base,'view','first'),make(base+1,'reply','second'),make(base+2,'open','third')]);
  const counts = await DB.counts();
  assert.equal(counts.posts, 1);
  assert.equal(counts.events, 3);
  const all = await DB.allData();
  assert.equal(all.posts[0].viewCount, 2);
  assert.equal(all.posts[0].openCount, 1);
  assert.equal(all.posts[0].text, 'third');
  const page1 = await DB.query({ limit:2 });
  assert.equal(page1.rows.length,2);
  const page2 = await DB.query({ limit:2, before:page1.before });
  assert.equal(page2.rows.length,1);
  const replies = await DB.query({ kind:'reply' });
  assert.equal(replies.rows.length,1);
  const search = await DB.query({ q:'tester' });
  assert.equal(search.rows.length,3);
  const empty = await DB.query({ q:'not found' });
  assert.equal(empty.rows.length,0);
  await DB.clearAll();
  const after = await DB.counts();
  assert.equal(after.posts, 0);
  assert.equal(after.events, 0);
  console.log('PASS: IndexedDB batch dedup, repeated views, query, pagination, filters, clear');
})().catch(e => { console.error(e); process.exitCode = 1; });
