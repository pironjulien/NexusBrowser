/**
 * Nexus Browser Bridge — script de contenu : réveil du service worker au chargement d'une page.
 *
 * Il n'écoute aucun événement de la page, ne reçoit aucun message et n'ajoute rien au document : une page ne voit
 * aucune trace de NexusBrowser (le point du clic et le logo de travail ne sont plus dessinés dans les pages).
 */
try {
    if (window === window.top && typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ target: "background", ping: true }, () => {
            void chrome.runtime.lastError; // lu exprès : service worker endormi ou rechargé, rien à signaler dans la page
        });
    }
} catch (_) {
    // Contexte de l'extension invalidé (extension rechargée ou mise à jour) : script orphelin, il n'a plus rien à réveiller.
    // Aucune trace dans la console de la page (voir ci-dessus).
}
