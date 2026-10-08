// In-browser document parsing. Parsers are vendored in assets/vendor and loaded
// on demand; file contents never leave the browser (except when you explicitly
// ask the AI engine to read an image).
import { loadScript } from './ui.js';
import { htmlToText } from '../extension/core/tools.js';

const CDN = {
  pdf: 'assets/vendor/pdf.min.js',
  pdfWorker: 'assets/vendor/pdf.worker.min.js',
  mammoth: 'assets/vendor/mammoth.browser.min.js',
  xlsx: 'assets/vendor/xlsx.full.min.js',
};

export const SUPPORTED = ['pdf', 'docx', 'txt', 'md', 'markdown', 'csv', 'tsv', 'xlsx', 'xls', 'json', 'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
export const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

export function extOf(name) { return String(name).split('.').pop().toLowerCase(); }

export async function parseFile(file) {
  const ext = extOf(file.name);
  if (!SUPPORTED.includes(ext)) throw new Error(`.${ext} files are not supported`);
  if (file.size > 25 * 1024 * 1024) throw new Error('Files larger than 25 MB are not supported in the browser');

  if (['txt', 'md', 'markdown', 'csv', 'tsv'].includes(ext)) {
    const text = await file.text();
    const meta = ext === 'csv' || ext === 'tsv' ? { rows: text.split('\n').filter(Boolean).length } : {};
    return { text, meta };
  }
  if (ext === 'json') {
    const raw = await file.text();
    try { return { text: JSON.stringify(JSON.parse(raw), null, 2), meta: {} }; } catch { return { text: raw, meta: { invalidJson: true } }; }
  }
  if (ext === 'html' || ext === 'htm') return { text: htmlToText(await file.text()), meta: {} };

  if (ext === 'pdf') {
    await loadScript(CDN.pdf);
    const pdfjs = window.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      let lastY = null;
      const out = [];
      for (const item of content.items) {
        const y = item.transform?.[5];
        if (lastY !== null && Math.abs(y - lastY) > 2) { out.push(line); line = ''; }
        line += item.str + (item.hasEOL ? '\n' : '');
        lastY = y;
      }
      out.push(line);
      pages.push(`--- Page ${i} ---\n${out.join('\n')}`);
    }
    const text = pages.join('\n\n');
    return { text, meta: { pages: doc.numPages, scanned: text.replace(/--- Page \d+ ---/g, '').trim().length < 20 } };
  }
  if (ext === 'docx') {
    await loadScript(CDN.mammoth);
    const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { text: r.value, meta: {} };
  }
  if (ext === 'xlsx' || ext === 'xls') {
    await loadScript(CDN.xlsx);
    const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const parts = wb.SheetNames.map((n) => `--- Sheet: ${n} ---\n${window.XLSX.utils.sheet_to_csv(wb.Sheets[n])}`);
    return { text: parts.join('\n\n'), meta: { sheets: wb.SheetNames.length } };
  }
  if (IMAGE_TYPES.includes(ext)) {
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
    return { text: '', meta: { image: true }, dataUrl };
  }
  throw new Error('Unsupported file');
}
