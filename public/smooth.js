// Smoothness helpers for the orbit-buddy PWA.
// Pairs with smooth.css. No dependencies; DOM access happens only inside
// functions, so this module is safe to import in Node for testing.

const VIEW_EXIT_MS = 200;

// Saved original content per container, so hideSkeleton can restore it.
const savedContent = new Map();

function byId(id) {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id);
}

/**
 * Replace a container's content with shimmer placeholders while loading.
 * The previous innerHTML is saved and restored by hideSkeleton().
 */
export function showSkeleton(containerId) {
  const el = byId(containerId);
  if (!el) return;
  if (!savedContent.has(el)) savedContent.set(el, el.innerHTML);
  el.innerHTML =
    '<div class="skeleton" aria-hidden="true">' +
    '<div class="skeleton-line"></div>' +
    '<div class="skeleton-line"></div>' +
    '<div class="skeleton-line short"></div>' +
    '</div>';
}

/**
 * Restore the content saved by showSkeleton(), or clear the container
 * if showSkeleton was never called for it.
 */
export function hideSkeleton(containerId) {
  const el = byId(containerId);
  if (!el) return;
  if (savedContent.has(el)) {
    el.innerHTML = savedContent.get(el);
    savedContent.delete(el);
  } else {
    el.innerHTML = '';
  }
}

/**
 * Cross-fade between views instead of an instant swap.
 * Works with the existing `.view` / `.view.active` convention and
 * `data-view="<name>"` attributes. Falls back to an instant switch if
 * the target view is missing.
 */
export function transitionToView(viewName) {
  if (typeof document === 'undefined') return;
  const current = document.querySelector('.view.active');
  const next = document.querySelector(`.view[data-view="${viewName}"]`);
  if (!next) return;
  if (current === next) return;

  if (current) {
    current.classList.add('smooth-exit');
    setTimeout(() => {
      current.classList.remove('active', 'smooth-exit');
      next.classList.add('active', 'smooth-enter');
      setTimeout(() => next.classList.remove('smooth-enter'), VIEW_EXIT_MS + 50);
    }, VIEW_EXIT_MS);
  } else {
    next.classList.add('active', 'smooth-enter');
    setTimeout(() => next.classList.remove('smooth-enter'), VIEW_EXIT_MS + 50);
  }
}

/**
 * Return a debounced wrapper: rapid calls collapse into one invocation
 * after `ms` of quiet. Guards against render thrashing during fast updates.
 */
export function debouncedRender(fn, ms = 100) {
  let timer = null;
  let lastArgs = null;
  return function debounced(...args) {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...lastArgs);
    }, ms);
  };
}
