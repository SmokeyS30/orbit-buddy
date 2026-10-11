export function searchMessages(messages, query, limit = 20) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const results = [];
  const terms = q.split(/\s+/).filter((t) => t.length > 1);
  for (const message of messages || []) {
    const content = String(message?.content || '');
    const lower = content.toLowerCase();
    let matchCount = 0;
    for (const term of terms) {
      let idx = lower.indexOf(term);
      while (idx !== -1) {
        matchCount++;
        idx = lower.indexOf(term, idx + term.length);
      }
    }
    if (matchCount === 0) continue;
    const firstIdx = lower.indexOf(terms[0]);
    const start = Math.max(0, firstIdx - 60);
    const end = Math.min(content.length, firstIdx + 90);
    let excerpt = content.slice(start, end);
    if (start > 0) excerpt = '...' + excerpt;
    if (end < content.length) excerpt = excerpt + '...';
    const created = new Date(message?.created_at || 0).valueOf();
    const ageDays = Math.max(0, (Date.now() - created) / 86400000);
    const recencyBoost = 1 / (1 + ageDays / 30);
    const score = matchCount + recencyBoost;
    results.push({ message, excerpt, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, Math.max(1, limit));
}

export function formatSearchResults(results) {
  return (results || []).map(({ message, excerpt }) => {
    const d = new Date(message?.created_at || 0);
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${ts} — ${excerpt}`;
  });
}
