import { ui } from './classes';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
const openModalOverlays: HTMLElement[] = [];

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true'
  );
}

export function createModal(htmlContent: string, options: { onClose?: () => void } = {}): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = ui.modalOverlay;
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const content = document.createElement('div');
  content.className = ui.modal;
  content.innerHTML = htmlContent;
  const heading = content.querySelector<HTMLElement>('h1, h2, h3');
  if (heading) {
    if (!heading.id) heading.id = `modal-title-${Math.random().toString(36).slice(2, 10)}`;
    overlay.setAttribute('aria-labelledby', heading.id);
  }

  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', handleDocumentKeydown, true);
    const stackIndex = openModalOverlays.indexOf(overlay);
    if (stackIndex >= 0) openModalOverlays.splice(stackIndex, 1);
    overlay.remove();
    options.onClose?.();
    if (previouslyFocused?.isConnected && openModalOverlays.length === 0) previouslyFocused.focus();
  };
  const isTopmost = () => {
    // Overlays removed directly from the DOM (rather than via close()) must not stay on the stack,
    // otherwise the real topmost dialog loses Escape/Tab handling and focus restoration.
    for (let index = openModalOverlays.length - 1; index >= 0; index -= 1) {
      if (!openModalOverlays[index].isConnected) openModalOverlays.splice(index, 1);
    }
    return openModalOverlays[openModalOverlays.length - 1] === overlay;
  };
  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (!overlay.isConnected) {
      // Detached externally: run the full close bookkeeping (listener removal, onClose, focus restore).
      close();
      return;
    }
    if (!isTopmost()) return;
    if (event.key === 'Escape') {
      // Only the topmost dialog consumes Escape so stacked dialogs close one at a time.
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = focusableElements(content);
      if (focusable.length === 0) {
        event.preventDefault();
        overlay.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !content.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !content.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener('signalforge:close', close);
  window.addEventListener('keydown', handleDocumentKeydown, true);

  overlay.appendChild(content);
  document.body.appendChild(overlay);
  openModalOverlays.push(overlay);
  const focusable = content.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
  (focusable || overlay).focus();
  return content;
}

export function renderWarningList(element: HTMLElement | null, warnings: string[] = []): void {
  if (!element) return;
  if (!warnings.length) {
    element.innerHTML = '';
    element.classList.add('hidden');
    return;
  }
  element.classList.remove('hidden');
  element.innerHTML = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
}

export function closeModal(content: HTMLElement | null): void {
  content?.parentElement?.dispatchEvent(new CustomEvent('signalforge:close'));
}
