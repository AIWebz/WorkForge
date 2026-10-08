import { esc, icon, refreshIcons, emptyState, toast, modal, confirmDialog, drawer, timeAgo, avatar } from '../ui.js';
import { parseFile, extOf, SUPPORTED, IMAGE_TYPES } from '../fileparse.js';
import { chunkText, uid, now } from '../../extension/core/util.js';

const DEFAULT_COLLECTIONS = ['Company Documentation', 'Product Catalog', 'Pricing', 'Sales Materials', 'Customer Support', 'Internal Procedures'];

async function storeText(app, file, text) {
  await app.db.deleteWhere('chunks', 'fileId', file.id);
  const chunks = chunkText(text).map((t, i) => ({ id: uid('chk'), fileId: file.id, collectionId: file.collectionId, fileName: file.name, index: i, text: t }));
  await app.db.bulkPut('chunks', chunks);
  return chunks.length;
}

export default async function files(ctx) {
  const { el, app } = ctx;
  let current = ctx.query.c || null;
  el.innerHTML = '<div class="page" id="fp"></div>';
  const page = el.querySelector('#fp');

  const render = async () => {
    if (!ctx.isCurrent()) return;
    const [collections, allFiles, employees] = await Promise.all([app.db.all('collections'), app.db.all('files'), app.db.all('employees')]);
    collections.sort((a, b) => a.createdAt - b.createdAt);
    if (!current || !collections.some((c) => c.id === current)) current = collections[0]?.id || null;
    const coll = collections.find((c) => c.id === current);
    const list = allFiles.filter((f) => f.collectionId === current).sort((a, b) => b.createdAt - a.createdAt);
    const access = employees.filter((e) => (e.collections || []).includes(current));
    page.innerHTML = `<div class="page-head"><div><h1>Files &amp; Knowledge</h1><p>Organize documents into knowledge sources. Files are parsed in your browser and stored locally; employees can only read collections you grant.</p></div><button class="btn btn-primary" id="new-coll">${icon('folder-plus')} New collection</button></div>
      ${collections.length ? `<div class="grid-2" style="grid-template-columns: 260px 1fr; align-items:start">
        <div class="card" style="padding:8px"><nav class="nav">${collections.map((c) => `<a href="#/files?c=${c.id}" class="${c.id === current ? 'active' : ''}">${icon('folder')}<span class="ellipsis">${esc(c.name)}</span><span class="tiny muted" style="margin-left:auto">${allFiles.filter((f) => f.collectionId === c.id).length}</span></a>`).join('')}</nav></div>
        <div class="col gap-16">
          <div class="card card-pad">
            <div class="between"><div><h2>${esc(coll.name)}</h2><p class="small muted mt-4">${esc(coll.description || 'No description')}</p></div><div class="row"><button class="btn btn-sm" id="rename">${icon('pencil')} Edit</button><button class="btn btn-sm btn-danger" id="del-coll">${icon('trash-2')}</button></div></div>
            <div class="row wrap mt-12 small"><span class="muted">Employees with read access:</span>${access.length ? access.map((e) => `<a class="chip" href="#/employees/${e.id}/files">${avatar(e, 'avatar-sm')}${esc(e.name)}</a>`).join('') : '<span class="muted">none — grant access from an employee’s Files tab</span>'}</div>
          </div>
          <label class="dropzone" id="drop">${icon('upload-cloud', 'i-lg')}<div class="strong mt-8" style="color:var(--text)">Drop files here or click to upload</div><div class="small">${SUPPORTED.map((x) => x.toUpperCase()).filter((x, i, a) => a.indexOf(x) === i).join(' · ')} — up to 25 MB</div><input type="file" id="file-input" multiple hidden accept="${SUPPORTED.map((x) => `.${x}`).join(',')}"></label>
          <div class="card"><div class="card-head"><h3>Files</h3><span class="small muted">${list.length}</span></div><div class="card-body" style="padding-top:4px">
            ${list.length ? list.map((f) => `<div class="file-row"><span class="file-ic">${esc(extOf(f.name))}</span><div class="grow"><div class="small strong ellipsis">${esc(f.name)}</div><div class="tiny muted">${(f.size / 1024).toFixed(0)} KB · ${f.chunks || 0} chunks · ${f.chars ? `${f.chars.toLocaleString()} chars` : 'no text'} · ${timeAgo(f.createdAt)}${f.meta?.scanned ? ' · <span class="s-wait">scanned PDF: no text layer</span>' : ''}</div></div>
              ${f.status === 'error' ? `<span class="badge badge-danger" title="${esc(f.error)}">Error</span>` : f.status === 'needs_text' ? `<span class="badge" title="Images and scanned PDFs have no text layer; the AI engine reads text only">No text</span>` : '<span class="badge badge-success">Indexed</span>'}
              <button class="btn btn-xs btn-ghost" data-view="${f.id}" title="View text">${icon('eye')}</button><button class="btn btn-xs btn-ghost" data-del="${f.id}" title="Delete">${icon('trash-2')}</button></div>`).join('') : '<p class="small muted" style="padding:14px 0">No files in this collection yet.</p>'}
          </div></div>
        </div></div>` : `<div class="card">${emptyState('folder', 'Create your first knowledge source', 'Collections like “Pricing” or “Customer Support” let you control exactly what each employee can read.', `<div class="row wrap" style="justify-content:center">${DEFAULT_COLLECTIONS.map((n) => `<button class="btn btn-sm" data-quick="${esc(n)}">${icon('plus')} ${esc(n)}</button>`).join('')}</div>`)}</div>`}`;
    bindPage(collections, list);
    refreshIcons();
  };

  async function createCollection(name, description = '') {
    const c = { id: uid('col'), name, description, createdAt: now() };
    await app.db.put('collections', c);
    current = c.id;
    return c;
  }

  async function upload(fileList) {
    for (const f of fileList) {
      const rec = { id: uid('file'), collectionId: current, name: f.name, type: extOf(f.name), size: f.size, createdAt: now(), status: 'processing', chunks: 0, chars: 0 };
      await app.db.put('files', rec);
      try {
        const parsed = await parseFile(f);
        rec.meta = parsed.meta;
        if (parsed.dataUrl) rec.dataUrl = parsed.dataUrl;
        if (parsed.text.trim()) {
          rec.chunks = await storeText(app, rec, parsed.text);
          rec.chars = parsed.text.length;
          rec.status = 'indexed';
        } else rec.status = IMAGE_TYPES.includes(rec.type) || parsed.meta?.scanned ? 'needs_text' : 'indexed';
        await app.db.put('files', rec);
        toast(`${f.name}: ${rec.status === 'indexed' ? `indexed (${rec.chunks} chunks)` : 'stored, but it has no text the AI engine can read'}`, 'success');
      } catch (e) {
        rec.status = 'error';
        rec.error = e.message;
        await app.db.put('files', rec);
        toast(`${f.name}: ${e.message}`, 'error');
      }
    }
  }

  function bindPage(collections, list) {
    page.querySelector('#new-coll').onclick = () => collectionDialog();
    page.querySelectorAll('[data-quick]').forEach((b) => b.onclick = () => createCollection(b.dataset.quick));
    const coll = collections.find((c) => c.id === current);
    if (!coll) return;
    page.querySelector('#rename').onclick = () => collectionDialog(coll);
    page.querySelector('#del-coll').onclick = async () => {
      if (!(await confirmDialog(`Delete “${coll.name}” and its ${list.length} file(s)? Employees lose access immediately.`, { danger: true, confirm: 'Delete' }))) return;
      for (const f of list) { await app.db.deleteWhere('chunks', 'fileId', f.id); await app.db.delete('files', f.id); }
      for (const e of await app.db.all('employees')) {
        if ((e.collections || []).includes(coll.id)) { e.collections = e.collections.filter((x) => x !== coll.id); await app.db.put('employees', e); }
      }
      await app.db.delete('collections', coll.id);
      current = null;
    };
    const drop = page.querySelector('#drop');
    const input = page.querySelector('#file-input');
    input.onchange = () => upload([...input.files]);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); });
    page.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      await app.db.deleteWhere('chunks', 'fileId', b.dataset.del);
      await app.db.delete('files', b.dataset.del);
    });
    page.querySelectorAll('[data-view]').forEach((b) => b.onclick = async () => {
      const f = list.find((x) => x.id === b.dataset.view);
      const chunks = (await app.db.byIndex('chunks', 'fileId', f.id)).sort((a, c) => a.index - c.index);
      drawer({ title: f.name, subtitle: `${chunks.length} chunks · extracted text`, body: `${f.dataUrl ? `<img src="${f.dataUrl}" alt="" style="max-width:100%;border-radius:10px;margin-bottom:12px">` : ''}${chunks.length ? `<pre class="light" style="max-height:none">${esc(chunks.map((c) => c.text).join('\n\n'))}</pre>` : '<p class="muted small">No text extracted.</p>'}` });
    });
  }

  function collectionDialog(existing) {
    modal({
      title: existing ? 'Edit collection' : 'New knowledge collection',
      body: `<div class="form-grid"><label class="field"><span>Name</span><input class="input" id="c-name" value="${esc(existing?.name || '')}" placeholder="e.g. Pricing" list="c-sugg"><datalist id="c-sugg">${DEFAULT_COLLECTIONS.map((n) => `<option value="${n}">`).join('')}</datalist></label>
        <label class="field"><span>Description (helps employees know what's inside)</span><input class="input" id="c-desc" value="${esc(existing?.description || '')}"></label></div>`,
      actions: [{ label: 'Cancel' }, { label: existing ? 'Save' : 'Create', primary: true, onClick: async (m) => {
        const name = m.querySelector('#c-name').value.trim();
        if (!name) throw new Error('Name is required');
        if (existing) await app.db.put('collections', { ...existing, name, description: m.querySelector('#c-desc').value.trim() });
        else await createCollection(name, m.querySelector('#c-desc').value.trim());
      } }],
    });
  }

  ctx.watch(['collections', 'files', 'employees'], render, 300);
  await render();
}
