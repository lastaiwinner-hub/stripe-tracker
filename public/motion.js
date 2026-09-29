'use strict';

(() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const selector = '.kpi, .card, .node-card, .act-card, .obj-card, .activity-metrics article';
  const wired = new WeakSet();

  const stage = document.createElement('div');
  stage.className = 'visual-stage';
  stage.setAttribute('aria-hidden', 'true');
  stage.innerHTML = '<div class="visual-grid"></div><div class="visual-orb"></div>';
  document.body.prepend(stage);

  function wire(card) {
    if (wired.has(card)) return;
    wired.add(card);
    card.classList.add('motion-card');
    if (reduceMotion.matches || !finePointer.matches) return;

    let frame = 0;
    const reset = () => {
      cancelAnimationFrame(frame);
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
      card.style.setProperty('--mx', '50%');
      card.style.setProperty('--my', '0%');
    };

    card.addEventListener('pointermove', event => {
      const rect = card.getBoundingClientRect();
      const px = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const py = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        card.style.setProperty('--rx', `${((.5 - py) * 4).toFixed(2)}deg`);
        card.style.setProperty('--ry', `${((px - .5) * 5).toFixed(2)}deg`);
        card.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
        card.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
      });
    }, { passive: true });
    card.addEventListener('pointerleave', reset, { passive: true });
    card.addEventListener('blur', reset, true);
  }

  const scan = root => {
    if (root.nodeType !== Node.ELEMENT_NODE && root !== document) return;
    if (root.matches?.(selector)) wire(root);
    root.querySelectorAll?.(selector).forEach(wire);
  };

  scan(document);
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(scan)))
    .observe(document.body, { childList: true, subtree: true });
})();
