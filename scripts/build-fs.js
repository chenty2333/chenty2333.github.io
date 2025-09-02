// Generate data/fs.json from notes directory
// Run with: node scripts/build-fs.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NOTES_DIR = path.join(ROOT, 'notes');
const OUT = path.join(ROOT, 'data', 'fs.json');

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const node = {};
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      node[e.name] = walk(full);
    } else {
      const st = fs.statSync(full);
      node[e.name] = {
        path: path.relative(ROOT, full).replace(/\\/g, '/'),
        type: 'file',
        size: st.size,
        mtime: new Date(st.mtimeMs).toISOString().slice(0, 10),
      };
    }
  }
  return node;
}

function main() {
  const tree = { notes: walk(NOTES_DIR) };
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(tree, null, 2), 'utf8');
  console.log('Wrote', OUT);
}

main();
