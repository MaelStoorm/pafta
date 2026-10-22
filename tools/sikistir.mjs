// Uygulamaya giren JavaScript'i derleme sırasında sıkıştırır ve yerel değişken adlarını karıştırır.
// Kaynak dosyalar depoda okunur haliyle kalır; bu betik yalnızca derleme makinesindeki kopyayı değiştirir.
// Kullanım: node sikistir.mjs dosya.html dosya.js ...
import { minify } from 'terser';
import { readFileSync, writeFileSync } from 'node:fs';

const opts = { compress: { passes: 2 }, mangle: true, format: { comments: false }, ecma: 2020 };

for (const f of process.argv.slice(2)) {
  const once = readFileSync(f, 'utf8');
  let s = once;
  if (f.endsWith('.js')) {
    s = (await minify(s, opts)).code;
  } else {
    const parts = [];
    const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
    let last = 0, m;
    while ((m = re.exec(s))) {
      parts.push(s.slice(last, m.index));
      const code = m[2].trim() ? (await minify(m[2], opts)).code : m[2];
      parts.push(`<script${m[1]}>${code}</script>`);
      last = re.lastIndex;
    }
    parts.push(s.slice(last));
    s = parts.join('').replace(/<!--(?!\[)[\s\S]*?-->/g, '');
  }
  writeFileSync(f, s);
  console.log(`${f}: ${once.length} → ${s.length} bayt`);
}
