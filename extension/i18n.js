/**
 * Interface text of the extension pages (popup.html, pair.html) from Chrome's catalogs (_locales): English by default,
 * French when Chrome runs in French. An element names its text with data-i18n="key" and its accessible name with
 * data-i18n-aria-label="key"; lang follows the catalog Chrome picked, not the browser's own language.
 */
function localizePage() {
    document.documentElement.lang = chrome.i18n.getMessage("locale");
    for (const element of document.querySelectorAll("[data-i18n]")) {
        element.textContent = chrome.i18n.getMessage(element.dataset.i18n);
    }
    for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
        element.setAttribute("aria-label", chrome.i18n.getMessage(element.dataset.i18nAriaLabel));
    }
}

localizePage();
