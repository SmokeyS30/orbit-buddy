// Semantic memory search for orbit-buddy.
// Combines OpenAI embedding vectors with the existing keyword scoring
// to find memories that are conceptually related even when the words differ.

const EMBEDDING_MODEL = 'text-embedding-3-small';
const MAX_EMBED_CHARS = 8000;

/**
 * Standard cosine similarity between two numeric vectors.
 * Returns 0 if either vector is empty or lengths mismatch.
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Fetch an embedding vector for text from the OpenAI embeddings API.
 * Native fetch, no dependencies.
 */
export async function getEmbedding(text, apiKey) {
  const input = String(text || '').slice(0, MAX_EMBED_CHARS);
  if (!input.trim()) throw new Error('getEmbedding: empty input');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`getEmbedding failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('getEmbedding: unexpected API response shape');
  return vec;
}

/**
 * Embed a memory's content. Truncates to the model limit and delegates
 * to getEmbedding. Returns the raw number array.
 */
export async function embedMemory(content, apiKey) {
  return getEmbedding(String(content || '').slice(0, MAX_EMBED_CHARS), apiKey);
}

/**
 * Parse a stored embedding (JSON string) into a number array.
 * Returns null when missing or unparsable.
 */
function parseEmbedding(stored) {
  if (Array.isArray(stored)) return stored;
  if (typeof stored !== 'string' || !stored.trim()) return null;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Rank memories purely by semantic similarity to the query embedding.
 * Memories carry their vector in memory.embedding (JSON string).
 * Returns [{ memory, score }] sorted by score descending, top N.
 */
export function semanticRank(memories, queryEmbedding, limit = 8) {
  const results = [];
  for (const memory of memories || []) {
    const vec = parseEmbedding(memory?.embedding);
    if (!vec) continue;
    const score = cosineSimilarity(queryEmbedding, vec);
    if (score > 0) results.push({ memory, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)));
}

/**
 * Simple keyword score: count of distinct query tokens present in the
 * memory content, normalized to 0..1.
 */
function keywordScore(content, queryTokens) {
  if (!queryTokens.length) return 0;
  const hay = String(content || '').toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (token && hay.includes(token)) hits++;
  }
  return hits / queryTokens.length;
}

/**
 * Tokenize a query into lowercase words, dropping very short tokens.
 */
function tokenize(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/**
 * Hybrid ranking: 0.4 * normalized keyword score + 0.6 * semantic score.
 * Memories without embeddings fall back to keyword-only scoring.
 * Returns [{ memory, score, keyword, semantic }] sorted descending, top N.
 */
export function hybridRank(memories, query, queryEmbedding, limit = 8) {
  const queryTokens = tokenize(query);
  const results = [];
  for (const memory of memories || []) {
    const kw = keywordScore(memory?.content, queryTokens);
    const vec = parseEmbedding(memory?.embedding);
    const sem = vec ? cosineSimilarity(queryEmbedding, vec) : 0;
    // If nothing matches at all, skip
    if (kw === 0 && sem === 0) continue;
    const score = vec ? 0.4 * kw + 0.6 * sem : kw;
    results.push({ memory, score, keyword: kw, semantic: sem });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)));
}
