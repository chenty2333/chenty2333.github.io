#!/usr/bin/env node
/**
 * Bump CACHE_VERSION across index.html, reader.html, ya/ya.html
 * Usage: node scripts/version.js 3.2.2
 * Supports up to four segments (e.g., 1.2.3.4). Compares semver-like order.
 */
const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, '..', 'index.html'),
  path.join(__dirname, '..', 'reader.html'),
  path.join(__dirname, '..', 'ya', 'ya.html'),
];

function parseVer(s) {
  if (!/^\d+(?:\.\d+){0,3}$/.test(s)) return null;
  return s.split('.').map(n => parseInt(n, 10));
}
function cmpVer(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function extractCurrentVersion(text) {
  const m = text.match(/const\s+CACHE_VERSION\s*=\s*'([^']+)'/);
  return m ? m[1] : null;
}

function replaceVersion(text, newVer) {
  // Replace declaration
  let out = text.replace(/const\s+CACHE_VERSION\s*=\s*'[^']*'/, `const CACHE_VERSION = '${newVer}'`);
  return out;
}

function main() {
  const newVerStr = process.argv[2];
  if (!newVerStr) {
    console.error('Usage: node scripts/version.js <new_version>');
    process.exit(1);
  }
  const newVer = parseVer(newVerStr);
  if (!newVer) {
    console.error('Invalid version. Use digits separated by dots, up to four segments, e.g., 1.2.3 or 1.2.3.4');
    process.exit(1);
  }

  let current = null;
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, 'utf8');
    const ver = extractCurrentVersion(txt);
    if (ver) { current = ver; break; }
  }
  if (!current) {
    console.error('Could not find existing CACHE_VERSION in target files.');
    process.exit(2);
  }
  const curArr = parseVer(current);
  if (!curArr) {
    console.error('Existing CACHE_VERSION is invalid: ' + current);
    process.exit(2);
  }
  if (cmpVer(newVer, curArr) <= 0) {
    console.error(`New version (${newVerStr}) must be greater than current (${current}).`);
    process.exit(3);
  }

  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.warn('Skip missing:', f);
      continue;
    }
    const txt = fs.readFileSync(f, 'utf8');
    if (!/const\s+CACHE_VERSION\s*=\s*'[^']*'/.test(txt)) {
      console.warn('No CACHE_VERSION found, skip:', f);
      continue;
    }
    const out = replaceVersion(txt, newVerStr);
    fs.writeFileSync(f, out, 'utf8');
    console.log('Updated', path.relative(path.join(__dirname, '..'), f));
  }

  console.log('Done. New CACHE_VERSION =', newVerStr);
}

main();
