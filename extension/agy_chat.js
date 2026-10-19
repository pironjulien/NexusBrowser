/**
 * Fil du panneau Antigravity (état pur, sans DOM ni chrome.*), partagé par le service worker (importScripts) et le
 * panneau, testé dans tests/browser.test.cjs.
 *
 * Une entrée « ask » par demande de Julien : localId = identifiant de requête de bout en bout (écrit DANS le message
 * du relais, renvoyé avec la réponse : un dépôt n'a lieu qu'une fois, et la réponse retrouve sa demande même si la
 * confirmation « déposée » s'est perdue). Statuts : sending → sent → answered, ou error / abandoned. Une entrée
 * « reply » par réponse d'Antigravity. Les mises à jour convergent dans n'importe quel ordre ; « answered » ne recule
 * jamais (relectures de Codex, 18/10).
 */
(function (scope) {
    const MAX_ENTRIES = 100;
    const MAX_TEXT = 6000;
    const RESEND_AFTER_MS = 15000;  // sans confirmation du pont : même demande renvoyée (dépôt idempotent dans le relais)
    const SLOW_ATTEMPTS = 3;  // au-delà : « réception non confirmée » affiché, les renvois continuent

    function cap(list) {
        return list.length > MAX_ENTRIES ? list.slice(list.length - MAX_ENTRIES) : list;
    }

    /** Origine seule (ni identifiants, ni chemin, ni paramètres) : rien de secret dans la boîte du relais. */
    function originOf(url) {
        try {
            const parsed = new URL(String(url || ""));
            return /^https?:$/.test(parsed.protocol) ? parsed.origin : parsed.protocol;
        } catch (_) {
            return "";
        }
    }

    /** Texte d'une demande, ou erreur claire. */
    function checkText(text) {
        const value = String(text ?? "").trim();
        if (!value) return { error: "Demande vide." };
        if (value.length > MAX_TEXT) return { error: `Demande trop longue (${value.length} caractères, ${MAX_TEXT} au plus).` };
        return { text: value };
    }

    function addAsk(list, { localId, text, tab, at }) {
        const entry = { kind: "ask", localId, text, tab: tab || null, at: at || Date.now(), status: "sending", attempts: 0, lastSent: 0 };
        return cap([...(Array.isArray(list) ? list : []), entry]);
    }

    function isActive(entry) {
        return entry.kind === "ask" && (entry.status === "sending" || entry.status === "sent");
    }

    /** Mise à jour venue du pont : statut d'une demande (localId) ou réponse d'Antigravity (reply). Idempotente. */
    function applyUpdate(list, update) {
        const out = Array.isArray(list) ? list.map((entry) => ({ ...entry })) : [];
        if (!update || typeof update !== "object") return out;
        const reply = update.reply;
        if (reply && typeof reply === "object" && typeof reply.id === "string") {
            const ask = out.find((entry) => entry.kind === "ask"
                && ((reply.request_id && entry.localId === reply.request_id) || (entry.relayId && entry.relayId === reply.reply_to)));
            if (ask) {
                ask.status = "answered";
                if (reply.reply_to) ask.relayId = String(reply.reply_to);
            }
            if (out.some((entry) => entry.kind === "reply" && entry.id === reply.id)) return out;
            out.push({
                kind: "reply",
                id: reply.id,
                from: String(reply.from || "antigravity"),
                text: String(reply.text || ""),
                replyTo: reply.reply_to || null,
                at: Date.parse(reply.created) || Date.now()
            });
            return cap(out);
        }
        if (typeof update.localId === "string") {
            const ask = out.find((entry) => entry.kind === "ask" && entry.localId === update.localId);
            if (!ask) return out;
            if (update.status === "sent") {
                ask.relayId = String(update.relayId || "");
                ask.sidecarActive = update.sidecarActive !== false;
                delete ask.error;
                delete ask.held;
                const answered = out.some((entry) => entry.kind === "reply" && entry.replyTo === ask.relayId);
                if (ask.status !== "answered") ask.status = answered ? "answered" : ask.status === "abandoned" ? "abandoned" : "sent";
            } else if (update.status === "held" && ask.status === "sending") {
                // Retenue par le pont (plusieurs profils) : issue antérieure inconnue, réservation et reprises gardées.
                ask.held = String(update.error || "demande retenue par le pont");
            } else if (update.status === "error" && ask.status === "sending") {
                // Refus explicite du relais (texte, installation) : rien n'a été déposé pour cette requête.
                ask.status = "error";
                ask.error = String(update.error || "erreur inconnue");
            }
        }
        return out;
    }

    /** Demandes à renvoyer (sans confirmation depuis RESEND_AFTER_MS), toujours avec le même localId. */
    function dueResends(list, now = Date.now()) {
        return (Array.isArray(list) ? list : []).filter((entry) => entry.kind === "ask" && entry.status === "sending"
            && (!entry.lastSent || now - entry.lastSent >= RESEND_AFTER_MS));
    }

    /** Un envoi a réellement quitté l'extension (seuls ceux-là comptent comme essais). */
    function markSent(list, localId, now = Date.now()) {
        return (Array.isArray(list) ? list : []).map((entry) => entry.kind === "ask" && entry.localId === localId
            ? { ...entry, attempts: (entry.attempts || 0) + 1, lastSent: now } : entry);
    }

    /** Demande partie et pas encore répondue (Antigravity travaille), la plus récente. */
    function pendingAsk(list) {
        const asks = (Array.isArray(list) ? list : []).filter((entry) => entry.kind === "ask" && entry.status === "sent");
        return asks.length ? asks[asks.length - 1] : null;
    }

    /** Demande en cours (une à la fois) : jusqu'à sa réponse, son refus, ou son abandon explicite par Julien. */
    function busyAsk(list) {
        return (Array.isArray(list) ? list : []).find(isActive) || null;
    }

    /** « Effacer l'affichage » : garde les demandes en cours (leur réservation n'est pas un simple affichage). */
    function clearDisplay(list) {
        return (Array.isArray(list) ? list : []).filter(isActive);
    }

    function abandon(list, localId) {
        return (Array.isArray(list) ? list : []).map((entry) => entry.kind === "ask" && entry.localId === localId && isActive(entry)
            ? { ...entry, status: "abandoned" } : entry);
    }

    /** Ligne d'état sous une demande. */
    function askStatus(entry) {
        switch (entry && entry.status) {
            case "sending": return entry.held ? `Retenue : ${entry.held}` : (entry.attempts || 0) >= SLOW_ATTEMPTS
                ? "Réception non confirmée par le pont : nouvel essai toutes les 15 s (même demande, jamais en double)"
                : "Envoi…";
            case "sent": return entry.sidecarActive === false
                ? "Déposée, mais Antigravity ne semble pas actif (sidecar arrêté)"
                : "Déposée pour Antigravity";
            case "answered": return "";
            case "abandoned": return "Abandonnée par vous (si Antigravity finit, sa réponse s'affichera ici)";
            case "error": return `Non transmise : ${entry.error || "erreur"}`;
            default: return "";
        }
    }

    scope.AgyChat = {
        MAX_ENTRIES, MAX_TEXT, RESEND_AFTER_MS, SLOW_ATTEMPTS,
        originOf, checkText, addAsk, applyUpdate, dueResends, markSent, pendingAsk, busyAsk, clearDisplay, abandon, askStatus
    };
})(typeof globalThis !== "undefined" ? globalThis : window);
