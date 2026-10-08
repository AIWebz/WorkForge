// Downloads WebLLM model weights + runtime library into ./models so GitHub Pages
// serves the AI engine's model from this site. Runs in the Pages workflow when
// the repository variable WORKFORGE_MODEL is set (comma-separated model ids).
// Layout matches extension/core/engine.js: models/<id>/resolve/main/* and models/libs/*.wasm
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The vendored bundle is an ES module with a .js name; load it via a .mjs copy so any Node version treats it as ESM.
const tmp = join(tmpdir(), 'web-llm.mjs');
await copyFile('assets/vendor/web-llm.js', tmp);
const { prebuiltAppConfig } = await import(tmp);

const ids = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!ids.length) { console.log('No model requested.'); process.exit(0); }

async function download(url, dest) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) { await writeFile(dest, Buffer.from(await res.arrayBuffer())); return; }
      console.warn(`  ${res.status} ${url} (attempt ${attempt})`);
    } catch (e) {
      console.warn(`  ${e.cause?.code || e.message} ${url} (attempt ${attempt})`);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  throw new Error(`Failed to download ${url}`);
}

const hosted = [];
await mkdir('models/libs', { recursive: true });
for (const id of ids) {
  const rec = prebuiltAppConfig.model_list.find((m) => m.model_id === id);
  if (!rec) throw new Error(`Unknown model ${id}`);
  const src = `${rec.model.replace(/\/$/, '')}/resolve/main/`;
  const dir = `models/${id}/resolve/main`;
  await mkdir(dir, { recursive: true });
  console.log(`Fetching ${id}`);
  await download(`${src}mlc-chat-config.json`, `${dir}/mlc-chat-config.json`);
  await download(`${src}ndarray-cache.json`, `${dir}/ndarray-cache.json`);
  const cfg = JSON.parse(await readFile(`${dir}/mlc-chat-config.json`, 'utf8'));
  for (const f of cfg.tokenizer_files || []) await download(`${src}${f}`, `${dir}/${f}`);
  const cache = JSON.parse(await readFile(`${dir}/ndarray-cache.json`, 'utf8'));
  const shards = [...new Set(cache.records.map((r) => r.dataPath))];
  for (const [i, shard] of shards.entries()) {
    process.stdout.write(`  shard ${i + 1}/${shards.length}\r`);
    await download(`${src}${shard}`, `${dir}/${shard}`);
  }
  const lib = rec.model_lib.split('/').pop();
  await download(rec.model_lib, `models/libs/${lib}`);
  hosted.push(id);
  console.log(`\n  done: ${shards.length} shards + ${lib}`);
}
await writeFile('models/manifest.json', JSON.stringify({ models: hosted }, null, 2));
console.log(`Hosted models: ${hosted.join(', ')}`);
