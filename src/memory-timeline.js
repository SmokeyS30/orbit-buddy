export function buildTimeline(memoryId, allMemories) {
  const byId = new Map();
  for (const m of allMemories || []) {
    if (m?.id) byId.set(m.id, m);
  }
  const target = byId.get(memoryId);
  if (!target) return [];

  // Walk backwards: find memories that were superseded by the current node
  const chain = [target];
  let cursor = target;
  const seen = new Set([target.id]);
  while (true) {
    const prev = [...byId.values()].find((m) => m.superseded_by === cursor.id && !seen.has(m.id));
    if (!prev) break;
    seen.add(prev.id);
    chain.unshift(prev);
    cursor = prev;
  }

  // Walk forwards: follow superseded_by from the target
  cursor = target;
  while (cursor.superseded_by && byId.has(cursor.superseded_by) && !seen.has(cursor.superseded_by)) {
    seen.add(cursor.superseded_by);
    cursor = byId.get(cursor.superseded_by);
    chain.push(cursor);
  }

  // Chronological order (oldest first)
  chain.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));

  return chain.map((m, i) => ({
    id: m.id,
    content: m.content,
    created_at: m.created_at,
    event: i === chain.length - 1 ? 'current' : (m.superseded_by ? 'superseded' : 'created'),
  }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(iso) {
  const d = new Date(iso || 0);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function formatTimeline(timeline) {
  if (!timeline || timeline.length === 0) return '';
  const parts = timeline.map((entry) => {
    const label = `${shortDate(entry.created_at)}: '${entry.content}'`;
    return entry.event === 'current' ? `${label} (current)` : label;
  });
  return parts.join(' → ');
}
