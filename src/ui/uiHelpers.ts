import { ui } from './classes';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', handleDocumentKeydown, true);
    overlay.remove();
    options.onClose?.();
  };
  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (!overlay.isConnected) {
      window.removeEventListener('keydown', handleDocumentKeydown, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener('signalforge:close', close);
  window.addEventListener('keydown', handleDocumentKeydown, true);

  overlay.appendChild(content);
  document.body.appendChild(overlay);
  const focusable = content.querySelector<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  (focusable || overlay).focus();
  return content;
}

export function closeModal(content: HTMLElement | null): void {
  content?.parentElement?.dispatchEvent(new CustomEvent('signalforge:close'));
}
