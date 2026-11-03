/**
 * Nexus Browser Bridge — script de contenu : réveil du service worker au chargement d'une page.
 *
 * Il n'écoute aucun événement de la page, ne reçoit aucun message et n'ajoute rien au document : une page ne voit
 * aucune trace de NexusBrowser (le point du clic et le logo de travail ne sont plus dessinés dans les pages).
 */
try {
    if (window === window.top && typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ target: "background", ping: true }, () => {
            if (chrome.runtime.lastError) {}
        });
    }
} catch (_) {}
