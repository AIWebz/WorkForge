// Per-employee memory and knowledge retrieval (BM25 over memory items and the
// file chunks of collections the employee is allowed to read).
import { tokenize, uid, now, truncate } from './util.js';

export const MEMORY_KINDS = {
  instructions: 'Employee instructions',
  business: 'Business information',
  long_term: 'Long-term memory',
  task: 'Task memory',
  conversation: 'Conversation memory',
  system: 'System information',
  execution: 'Previous execution results',
};

export async function addMemory(db, employeeId, kind, content, extra = {}) {
  const item = { id: uid('mem'), employeeId, kind: MEMORY_KINDS[kind] ? kind : 'long_term', content: String(content).slice(0, 8000), createdAt: now(), ...extra };
  await db.put('memory', item);
  return item;
}

export async function employeeMemory(db, employeeId) {
  return (await db.byIndex('memory', 'employeeId', employeeId)).sort((a, b) => b.createdAt - a.createdAt);
}

function bm25(docs, query, k = 8) {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return [];
  const toks = docs.map((d) => tokenize(d.text));
  const avg = toks.reduce((a, t) => a + t.length, 0) / Math.max(1, toks.length);
  const df = {};
  for (const t of toks) for (const w of new Set(t)) df[w] = (df[w] || 0) + 1;
  const N = docs.length;
  const scored = docs.map((d, i) => {
    const tf = {};
    for (const w of toks[i]) tf[w] = (tf[w] || 0) + 1;
    let s = 0;
    for (const w of q) {
      if (!tf[w]) continue;
      const idf = Math.log(1 + (N - (df[w] || 0) + 0.5) / ((df[w] || 0) + 0.5));
      s += idf * ((tf[w] * 2.2) / (tf[w] + 1.2 * (0.25 + 0.75 * (toks[i].length / (avg || 1)))));
    }
    return { ...d, score: s };
  });
  return scored.filter((d) => d.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

export async function grantedChunks(db, employee) {
  const out = [];
  for (const cid of employee.collections || []) {
    const chunks = await db.byIndex('chunks', 'collectionId', cid);
    out.push(...chunks);
  }
  return out;
}

/** Retrieve relevant memory + knowledge for a query. */
export async function retrieve(db, employee, query, { k = 8, includeFiles = true } = {}) {
  const mem = await employeeMemory(db, employee.id);
  const docs = mem.map((m) => ({ type: 'memory', id: m.id, kind: m.kind, text: m.content, createdAt: m.createdAt }));
  if (includeFiles) {
    const chunks = await grantedChunks(db, employee);
    docs.push(...chunks.map((c) => ({ type: 'file', id: c.id, fileId: c.fileId, fileName: c.fileName, text: c.text })));
  }
  return bm25(docs, query, k);
}

/** Build the memory context block injected into each script execution. */
export async function memoryContext(db, employee, query) {
  const mem = await employeeMemory(db, employee.id);
  const pinned = mem.filter((m) => m.kind === 'instructions' || m.kind === 'business' || m.kind === 'system').slice(0, 12);
  const relevant = await retrieve(db, employee, query, { k: 8 });
  const lines = [];
  if (pinned.length) {
    lines.push('## Standing memory');
    for (const m of pinned) lines.push(`- (${MEMORY_KINDS[m.kind]}) ${truncate(m.content, 600)}`);
  }
  const rel = relevant.filter((r) => !pinned.some((p) => p.id === r.id));
  if (rel.length) {
    lines.push('## Relevant memory and knowledge');
    for (const r of rel) {
      lines.push(r.type === 'file'
        ? `- [file ${r.fileName} · id ${r.fileId}] ${truncate(r.text, 700)}`
        : `- (${MEMORY_KINDS[r.kind] || r.kind}) ${truncate(r.text, 500)}`);
    }
  }
  return lines.join('\n');
}

export async function searchFiles(db, employee, query, k = 6) {
  const chunks = await grantedChunks(db, employee);
  return bm25(chunks.map((c) => ({ id: c.id, fileId: c.fileId, fileName: c.fileName, text: c.text })), query, k)
    .map((r) => ({ file_id: r.fileId, file: r.fileName, excerpt: truncate(r.text, 900), score: Number(r.score.toFixed(2)) }));
}

export async function readFile(db, employee, fileId) {
  const file = await db.get('files', fileId);
  if (!file || !(employee.collections || []).includes(file.collectionId)) throw new Error('File not found or not granted to this employee');
  const chunks = (await db.byIndex('chunks', 'fileId', fileId)).sort((a, b) => a.index - b.index);
  const text = chunks.map((c) => c.text).join('\n');
  return { file_id: fileId, name: file.name, type: file.type, text: text.slice(0, 20000), truncated: text.length > 20000 };
}
