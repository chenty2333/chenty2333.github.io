(function () {
  const contentEl = document.getElementById('content');
  const breadcrumbEl = document.getElementById('breadcrumb');

  // === LaTeX preprocessing ===
  const mathBlocks = [];

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttribute(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
  }

  function escapeMath(md) {
    mathBlocks.length = 0;
    // First, protect code blocks from math parsing
    const codeBlocks = [];
    md = md.replace(/```[\s\S]*?```/g, function (m) {
      const i = codeBlocks.length;
      codeBlocks.push(m);
      return `%%CODEBLOCK_${i}%%`;
    });
    md = md.replace(/`[^`]+`/g, function (m) {
      const i = codeBlocks.length;
      codeBlocks.push(m);
      return `%%CODEBLOCK_${i}%%`;
    });

    // Block math: $$ ... $$
    md = md.replace(/\$\$([\s\S]+?)\$\$/g, function (_, tex) {
      const i = mathBlocks.length;
      mathBlocks.push({ tex: tex.trim(), display: true });
      return `%%MATH_${i}%%`;
    });
    // Inline math: $ ... $ (single line, non-greedy)
    md = md.replace(/\$([^\n$]+?)\$/g, function (_, tex) {
      const i = mathBlocks.length;
      mathBlocks.push({ tex: tex.trim(), display: false });
      return `%%MATH_${i}%%`;
    });

    // Restore code blocks
    md = md.replace(/%%CODEBLOCK_(\d+)%%/g, function (_, idx) {
      return codeBlocks[+idx];
    });
    return md;
  }

  function restoreMath(html) {
    return html.replace(/%%MATH_(\d+)%%/g, function (_, idx) {
      const block = mathBlocks[+idx];
      if (!block) return '';
      try {
        return katex.renderToString(block.tex, {
          displayMode: block.display,
          throwOnError: false
        });
      } catch (e) {
        return `<code>${block.tex}</code>`;
      }
    });
  }

  // === Configure marked ===
  marked.setOptions({ gfm: true, breaks: false });

  const renderer = new marked.Renderer();
  renderer.code = function (token) {
    const text = typeof token === 'string' ? token : token.text;
    const lang = typeof token === 'string' ? arguments[1] : token.lang;
    const safeLang = (lang || '').trim().toLowerCase().replace(/[^\w-]+/g, '');
    const className = safeLang ? ` class="language-${safeLang}"` : '';
    const dataAttr = safeLang ? ` data-language="${escapeAttribute(safeLang)}"` : '';
    return `<pre${dataAttr}><code${className}>${escapeHtml(text)}</code></pre>`;
  };
  marked.use({ renderer });

  // === Routing ===
  function getPath() {
    const hash = location.hash.slice(1) || '/';
    const clean = hash.startsWith('/') ? hash.slice(1) : hash;
    if (!clean || clean === '/') return 'docs/index.md';
    return 'docs/' + clean + '.md';
  }

  function formatSegment(segment) {
    return decodeURIComponent(segment).replace(/[-_]/g, ' ');
  }

  function updateBreadcrumb(path) {
    const parts = path
      .replace(/^docs\//, '')
      .replace(/\/index\.md$/, '')
      .replace(/\.md$/, '')
      .split('/');

    if (parts.length === 1 && parts[0] === 'index') {
      breadcrumbEl.innerHTML = '';
      return;
    }

    let html = '';
    let href = '';
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) html += '<span class="breadcrumb__sep">/</span>';
      href += (i === 0 ? '' : '/') + parts[i];
      const isLast = i === parts.length - 1;
      const label = formatSegment(parts[i]);
      if (isLast) {
        html += `<span class="breadcrumb__current">${label}</span>`;
      } else {
        html += `<a href="#/${href}">${label}</a>`;
      }
    }
    breadcrumbEl.innerHTML = html;
  }

  async function loadPage() {
    const path = getPath();
    updateBreadcrumb(path);

    try {
      let res = await fetch(path);
      // If direct .md not found, try as directory with index.md
      if (!res.ok) {
        const dirPath = path.replace(/\.md$/, '/index.md');
        res = await fetch(dirPath);
      }
      if (!res.ok) throw new Error(res.status);
      const md = await res.text();
      renderMarkdown(md, path);
    } catch (e) {
      document.title = '404 | Chenty';
      contentEl.classList.remove('doc-body--home');
      contentEl.innerHTML = '<h1>404</h1><p class="lead">页面未找到。</p><p class="no-indent"><a href="#/">返回首页</a></p>';
    }
  }

  function decorateContent() {
    contentEl.querySelectorAll('table').forEach(function (table) {
      if (table.parentElement && table.parentElement.classList.contains('table-wrap')) {
        return;
      }
      const wrapper = document.createElement('div');
      wrapper.className = 'table-wrap';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
  }

  function renderMarkdown(md, path) {
    const escaped = escapeMath(md);
    let html = marked.parse(escaped);
    html = restoreMath(html);
    contentEl.innerHTML = html;
    contentEl.classList.toggle('doc-body--home', path === 'docs/index.md');
    decorateContent();
    Prism.highlightAllUnder(contentEl);
    const h1 = contentEl.querySelector('h1');
    const title = h1 ? h1.textContent.trim() : 'Chenty';
    document.title = title === 'Chenty' ? 'Chenty' : `${title} | Chenty`;
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', loadPage);
  loadPage();
})();
