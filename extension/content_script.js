/**
 * Nexus Browser Bridge — script de contenu : réveil du service worker, pastille d'état et point du clic.
 *
 * Il n'écoute AUCUN événement de la page : pastille et point du clic ne répondent qu'aux messages de l'extension
 * elle-même (chrome.tabs.sendMessage du service worker, expéditeur vérifié). Une page ne peut donc ni afficher une
 * fausse pastille « agent au travail » ni faire croire à un clic.
 */

// 0. Réveil du service worker au chargement d'une page (cadre principal seulement)
try {
    if (window === window.top && typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ target: "background", ping: true }, () => {
            if (chrome.runtime.lastError) {}
        });
    }
} catch (_) {}

/** Message venu du service worker de CETTE extension (jamais d'une page ni d'un autre script de contenu). */
function fromExtension(sender) {
    return !!(sender && typeof chrome !== "undefined" && sender.id === chrome.runtime?.id && !sender.tab);
}

// 1. Point du vrai clic (repère de la vue)
function showRipple(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !document.documentElement) return;
    const ripple = document.createElement("div");
    ripple.style.position = "fixed";
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    ripple.style.width = "20px";
    ripple.style.height = "20px";
    ripple.style.borderRadius = "50%";
    ripple.style.transform = "translate(-50%, -50%) scale(0.5)";
    ripple.style.backgroundColor = "rgba(37, 99, 235, 0.35)";
    ripple.style.border = "2px solid #2563eb";
    ripple.style.pointerEvents = "none";
    ripple.style.zIndex = "2147483647";
    ripple.style.transition = "transform 0.35s ease-out, opacity 0.35s ease-out";
    document.documentElement.appendChild(ripple);
    requestAnimationFrame(() => {
        ripple.style.transform = "translate(-50%, -50%) scale(2.4)";
        ripple.style.opacity = "0";
    });
    setTimeout(() => { if (ripple.parentNode) ripple.parentNode.removeChild(ripple); }, 400);
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender) => {
        if (!message || !fromExtension(sender)) return;
        if (message.nexusRipple && typeof message.nexusRipple === "object") showRipple(Number(message.nexusRipple.x), Number(message.nexusRipple.y));
    });
}
