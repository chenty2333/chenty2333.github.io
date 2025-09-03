#!/usr/bin/env node
/**
 * update-sri.js
 *
 * Usage: node update-sri.js [--files <file1,file2,...>] [--dry-run] [--check]
 * Scans provided HTML files (default: index.html, reader.html) for external script/link
 * resources, fetches them, computes sha384 SRI, and inserts/updates integrity + crossorigin="anonymous".
 * By default skips git cleanliness check; use --check to enable it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

function usage() {
  console.log('Usage: node scripts/update-sri.js [--files file1,file2] [--dry-run] [--check]');
  process.exit(1);
}

const argv = process.argv.slice(2);
let filesArg = null;
let dryRun = false;
let noCheck = true; // default to skip git cleanliness check; use --check to enable
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--files' && argv[i+1]) { filesArg = argv[++i]; }
  else if (a === '--dry-run') { dryRun = true; }
  else if (a === '--check') { noCheck = false; } // --check to enable git check
  else if (a === '--help' || a === '-h') usage();
}

const defaultFiles = [
  path.join(__dirname, '..', 'index.html'),
  path.join(__dirname, '..', 'reader.html'),
  path.join(__dirname, '..', 'ya', 'ya.html'),
];
const targetFiles = filesArg ? filesArg.split(',').map(p => path.resolve(p)) : defaultFiles;

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    // support protocol-relative URLs
    if (url.startsWith('//')) url = 'https:' + url;
    const client = url.startsWith('https://') ? https : http;
    const headers = {
      'accept-encoding': 'identity', // request uncompressed body for consistent hashing
      'user-agent': 'update-sri-script/1.0'
    };
    const req = client.get(url, { headers }, (res) => {
      // handle redirects with absolute or relative Location
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const next = new URL(res.headers.location, url).toString();
          return resolve(fetchUrl(next));
        } catch (e) {
          return reject(new Error('Invalid redirect location ' + res.headers.location));
        }
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    // timeout
    req.setTimeout(15000, () => {
      req.abort();
      reject(new Error('Request timeout for ' + url));
    });
    req.on('error', (err) => reject(err));
  });
}

function computeSri(buffer) {
  const hash = crypto.createHash('sha384').update(buffer).digest('base64');
  return `sha384-${hash}`;
}

function replaceAttr(tag, attrName, attrValue) {
  const re = new RegExp(`\\s${attrName}=(?:"[^"]*"|'[^']*')`);
  if (re.test(tag)) return tag.replace(re, ` ${attrName}="${attrValue}"`);
  // insert before trailing > (handle self-closing)
  return tag.replace(/(\s*\/?\s*>$)/, ` ${attrName}="${attrValue}"$1`);
}

function ensureCrossorigin(tag) {
  const re = /\scrossorigin=(?:"[^"]*"|'[^']*')/;
  if (re.test(tag)) return tag;
  return tag.replace(/(\s*\/?\s*>$)/, ` crossorigin="anonymous"$1`);
}

async function processFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn('Skipping missing file:', filePath);
    return;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  let out = text;

  // find external scripts
  const scriptRe = /<script[^>]*\ssrc=(?:"|')([^"']+)(?:"|')[^>]*><\/script>/gi;
  // Match link with href; we'll check rel attribute separately to be order-independent
  const linkRe = /<link[^>]*\shref=(?:"|')([^"']+)(?:"|')[^>]*>/gi;

  const resources = [];
  let m;
  while ((m = scriptRe.exec(text)) !== null) {
    const url = m[1];
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//')) resources.push({ type: 'script', url, tag: m[0] });
  }
  while ((m = linkRe.exec(text)) !== null) {
    const url = m[1];
    const tag = m[0];
    // check rel attribute contains stylesheet (order-insensitive)
    const relMatch = /rel=(?:"|')([^"']+)(?:"|')/i.exec(tag);
    const relVal = relMatch ? relMatch[1].toLowerCase() : '';
    if (!/stylesheet/.test(relVal)) continue;
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//')) resources.push({ type: 'link', url, tag });
  }

  if (resources.length === 0) {
    console.log('No external resources found in', filePath);
    return;
  }

  for (const res of resources) {
    try {
      console.log('Fetching', res.url);
      const data = await fetchUrl(res.url);
      const sri = computeSri(data);
      console.log('Computed', sri, 'for', res.url);

      // replace tag in out
      const oldTag = res.tag;
      let newTag = oldTag;
      if (res.type === 'script') {
        // Only modify the opening <script ...> tag, not the closing </script>
        const openEnd = oldTag.indexOf('>');
        if (openEnd !== -1) {
          const opening = oldTag.slice(0, openEnd + 1);
          const closing = oldTag.slice(openEnd + 1); // includes </script>
          let updatedOpening = replaceAttr(opening, 'integrity', sri);
          updatedOpening = ensureCrossorigin(updatedOpening);
          newTag = updatedOpening + closing;
        }
      } else {
        // link tag (self-contained)
        newTag = replaceAttr(newTag, 'integrity', sri);
        newTag = ensureCrossorigin(newTag);
      }

      if (oldTag !== newTag) {
        out = out.split(oldTag).join(newTag);
        console.log(`Updated tag in ${filePath}: ${res.url}`);
      } else {
        console.log(`No change for ${res.url}`);
      }
    } catch (err) {
      console.error('Failed to process', res.url, err.message);
    }
  }

  if (dryRun) {
    console.log('Dry run enabled; not writing changes for', filePath);
    return;
  }

  // By default skip git working tree check; use --check to enable
  if (!noCheck) {
    try {
      const { execSync } = require('child_process');
      // ensure we're inside a git repo
      execSync('git rev-parse --is-inside-work-tree', { cwd: path.dirname(filePath), stdio: 'ignore' });
      const status = execSync('git status --porcelain', { cwd: path.dirname(filePath) }).toString().trim();
      if (status) {
        console.error('Aborting: git working tree is not clean. Please commit or stash changes before running the script, or re-run without --check to skip.');
        process.exit(2);
      }
    } catch (err) {
      console.error('Aborting: git check failed or git not available. Please ensure you run this in a git repo or re-run without --check.');
      process.exit(2);
    }
  }

  // Write updated file (no .bak created per configuration)
  fs.writeFileSync(filePath, out, 'utf8');
  console.log('Wrote updated file:', filePath);
}

(async function main() {
  for (const f of targetFiles) {
    await processFile(f);
  }
})();
