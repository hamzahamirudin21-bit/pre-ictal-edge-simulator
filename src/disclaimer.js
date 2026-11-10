export const DISCLAIMER_TEXT =
  'EDUCATIONAL SIMULATION ONLY. All data is synthetic. This is NOT a medical device and makes no clinical claims. Do not use it for any medical decision.';

/**
 * Render the standard disclaimer into an element.
 * @param {HTMLElement} el
 */
export function renderDisclaimer(el) {
  el.textContent = DISCLAIMER_TEXT;
  el.setAttribute('role', 'note');
}