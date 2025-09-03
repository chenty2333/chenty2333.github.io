(function() {
  'use strict';

  function loadScript({ src, integrity, crossorigin, async = false, defer = false } = {}) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = !!async;
      s.defer = !!defer;
      if (integrity) {
        s.integrity = integrity;
        s.crossOrigin = crossorigin || 'anonymous';
      }
      s.onload = () => resolve(s);
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  function loadCss(href, integrity, crossorigin) {
    return new Promise((resolve, reject) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      if (integrity) {
        l.integrity = integrity;
        l.crossOrigin = crossorigin || 'anonymous';
      }
      l.onload = () => resolve(l);
      l.onerror = () => reject(new Error('Failed to load ' + href));
      document.head.appendChild(l);
    });
  }

  // Expose helpers globally for pages to use
  window.loadScript = loadScript;
  window.loadCss = loadCss;
})();
