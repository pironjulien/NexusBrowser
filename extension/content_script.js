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

// 2. Pastille d'état discrète : agent qui pilote l'onglet et action en cours
let nexusPillTimer = null;

function hidePill(pill) {
    if (!pill) return;
    pill.style.opacity = "0";
    pill.style.transform = "translateY(8px)";
    setTimeout(() => { if (pill.parentNode) pill.parentNode.removeChild(pill); }, 300);
}

function showPill(detail) {
    if (!document.documentElement) return;
    let pill = document.getElementById("__nexus_status_pill");
    if (detail.remove) {
        hidePill(pill);
        return;
    }
    if (!pill) {
        pill = document.createElement("div");
        pill.id = "__nexus_status_pill";
        Object.assign(pill.style, {
            position: "fixed", bottom: "16px", right: "16px", zIndex: "2147483647", display: "flex",
            alignItems: "center", gap: "8px", padding: "6px 12px", background: "rgba(24, 24, 27, 0.92)",
            border: "1px solid rgba(255, 255, 255, 0.18)", borderRadius: "8px", boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
            color: "#f4f4f5", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", fontSize: "12px",
            fontWeight: "500", pointerEvents: "none", userSelect: "none", opacity: "0", transform: "translateY(8px)",
            transition: "opacity 0.2s ease-out, transform 0.2s ease-out"
        });
        const dot = document.createElement("span");
        Object.assign(dot.style, { width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#2563eb", display: "inline-block" });
        const label = document.createElement("span");
        label.className = "__nexus_pill_text";
        pill.appendChild(dot);
        pill.appendChild(label);
        document.documentElement.appendChild(pill);
        requestAnimationFrame(() => {
            pill.style.opacity = "1";
            pill.style.transform = "translateY(0)";
        });
    }
    const label = pill.querySelector(".__nexus_pill_text");
    const agent = String(detail.agent || "Nexus").slice(0, 32);
    if (label) label.textContent = `${agent} · ${String(detail.text || "En tâche de fond").slice(0, 80)}`;
    pill.style.opacity = "1";
    pill.style.transform = "translateY(0)";
    if (nexusPillTimer) clearTimeout(nexusPillTimer);
    const autoHideMs = Number.isFinite(detail.autoHideMs) ? detail.autoHideMs : 3500;
    if (autoHideMs > 0) nexusPillTimer = setTimeout(() => hidePill(pill), autoHideMs);
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender) => {
        if (!message || !fromExtension(sender)) return;
        if (message.nexusPill && typeof message.nexusPill === "object") showPill(message.nexusPill);
        if (message.nexusRipple && typeof message.nexusRipple === "object") showRipple(Number(message.nexusRipple.x), Number(message.nexusRipple.y));
    });
}
