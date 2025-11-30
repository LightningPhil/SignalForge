/**
 * UI Helper Functions
 */

/**
 * Creates and displays a modal overlay with the provided HTML content.
 * Handles closing logic (click outside).
 * 
 * @param {string} htmlContent - Inner HTML for the modal body
 * @returns {HTMLElement} - The content container element
 */
export function createModal(htmlContent) {
    // Overlay Container
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    
    // Content Box
    const content = document.createElement('div');
    content.className = 'modal-content';
    content.innerHTML = htmlContent;
    
    // Click outside to close
    overlay.addEventListener('click', (e) => {
        if(e.target === overlay) {
            document.body.removeChild(overlay);
        }
    });

    overlay.appendChild(content);
    document.body.appendChild(overlay);
    
    return content;
}