// Divide o .exe do app em pedaços < 25 MiB (limite de arquivo do Cloudflare)
// e gera public/download/app.json. O botão "Baixar app" junta tudo no navegador.
// Uso: node scripts/split-app.js desktop/dist/Telinha-1.0.0.exe
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const src = process.argv[2];
if (!src) throw new Error('Uso: node scripts/split-app.js <arquivo.exe>');
const out = path.join(__dirname, '..', 'public', 'download');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const data = fs.readFileSync(src);
const PART = 24 * 1024 * 1024;
const name = path.basename(src);
const parts = [];
for (let i = 0, off = 0; off < data.length; i++, off += PART) {
  const file = `${name}.part${i}`;
  fs.writeFileSync(path.join(out, file), data.subarray(off, off + PART));
  parts.push(file);
}
const sha256 = crypto.createHash('sha256').update(data).digest('hex');
const version = (name.match(/(\d+\.\d+\.\d+)/) || [])[1] || null; // o app compara com a dele
fs.writeFileSync(path.join(out, 'app.json'), JSON.stringify({ name, version, size: data.length, sha256, parts }, null, 2));
console.log(`${name}: ${data.length} bytes em ${parts.length} pedaços`);
