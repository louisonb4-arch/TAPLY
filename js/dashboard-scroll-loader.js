/* Load the React/Framer Motion island shortly before it comes into view.
   Leaves the static screenshot fallback intact if JavaScript fails. */
(() => {
  'use strict';
  const mount = document.querySelector('[data-dashboard-react-root]');
  if (!mount) return;

  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    const script = document.createElement('script');
    script.src = 'js/dashboard-scroll-react.js';
    script.async = true;
    script.onerror = () => {
      loaded = false;
      console.warn('[Taply] Le visuel statique du dashboard reste disponible.');
    };
    document.head.appendChild(script);
  };
  if (!('IntersectionObserver' in window)) {
    load();
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    observer.disconnect();
    load();
  }, { rootMargin: '650px 0px 650px 0px', threshold: 0 });
  observer.observe(mount);
})();
