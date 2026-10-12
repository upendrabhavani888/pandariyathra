// Builds web/index.html (the app the server serves) from web/template.html.
//   npm install          (once, in this folder: fetches the PDF reader library)
//   npm run build:web
// Add "--demo" to build the standalone, no-server demo instead: web/standalone-demo.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = process.argv.includes('--demo');
const lib = path.join(process.env.PDFJS_DIR || path.join(root, 'node_modules', 'pdfjs-dist'), 'build');
const read = (f) => fs.readFileSync(f, 'utf8').replace(/<\/script/g, '<\\/script');
for (const f of ['pdf.min.js', 'pdf.worker.min.js']) if (!fs.existsSync(path.join(lib, f))) { console.error(`Missing ${path.join(lib, f)}. Run "npm install" in ${root} first.`); process.exit(1); }
const html = fs.readFileSync(path.join(root, 'web', 'template.html'), 'utf8')
  .replace('__PDFJS__', () => read(path.join(lib, 'pdf.min.js')))
  .replace('__WORKER__', () => read(path.join(lib, 'pdf.worker.min.js')))
  .replace('__PY_SERVER__', demo ? 'false' : 'true');
const out = path.join(root, 'web', demo ? 'standalone-demo.html' : 'index.html');
fs.writeFileSync(out, html);
console.log(`Built ${path.relative(root, out)} (${(html.length / 1048576).toFixed(1)} MB)`);
