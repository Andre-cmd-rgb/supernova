'use strict';
// Google search suggestions for the command bar. Only asked while the user
// types, cancelled when they type on, cached for the session.

const SUGGEST = 'https://suggestqueries.google.com/complete/search?client=firefox&hl=';

function createSuggester(fetchImpl, { lang = 'en', max = 5 } = {}) {
  const cache = new Map();
  let inflight = null;
  return async function suggest(query) {
    const q = query.trim();
    if (!q || q.length > 120) return [];
    if (cache.has(q)) return cache.get(q);
    if (inflight) inflight.abort();
    const ctl = new AbortController();
    inflight = ctl;
    const timer = setTimeout(() => ctl.abort(), 1500);
    try {
      const res = await fetchImpl(SUGGEST + encodeURIComponent(lang) + '&q=' + encodeURIComponent(q), {
        signal: ctl.signal,
        credentials: 'omit',
      });
      if (!res.ok) return [];
      const body = await res.json();
      const list = Array.isArray(body) && Array.isArray(body[1]) ? body[1].filter((s) => typeof s === 'string') : [];
      const out = list.filter((s) => s.toLowerCase() !== q.toLowerCase()).slice(0, max);
      if (cache.size > 500) cache.clear();
      cache.set(q, out);
      return out;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
      if (inflight === ctl) inflight = null;
    }
  };
}

module.exports = { createSuggester };
