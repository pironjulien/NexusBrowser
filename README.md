# Antigravity Chrome — Autonomous Browser Use & Web Automation Bridge 🌐🤖✨

[![Chrome Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-FastMCP%20%2F%20CDP-FF6F00?logo=anthropic&logoColor=white)](https://modelcontextprotocol.io/)
[![Google Gemini Design](https://img.shields.io/badge/UI-Google%20Gemini%201%3A1-9B72CB?logo=google&logoColor=white)](https://gemini.google.com)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://python.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Author](https://img.shields.io/badge/Author-Julien%20Piron-10a37f)](https://julienpiron.fr)

> **Moteur autonome de Browser Use, remplissage de formulaires et automatisation web Chromium pour Google Antigravity et agents IA. Équipé d'un pont Chrome DevTools Protocol (CDP) temps réel, d'un balisage visuel Set-of-Marks et d'un panneau latéral copilote Google Gemini 1:1.**

Développé nativement pour **Google Antigravity** et les flux d'orchestration agentiques souverains, **Antigravity Chrome** donne à votre agent IA les yeux et les mains nécessaires pour interagir avec le Web de manière 100% autonome, déterministe et silencieuse.

---

## ⚡ Architecture SOTA & Avantages Techniques

| Dimension | Approche Conventionnelle (Scripts Web) | Antigravity Chrome (Ce Projet) |
| :--- | :--- | :--- |
| **Remplissage de formulaires** | Approximation par frappe aveugle | **Saisie déterministe (`fill`, `type_keys`) avec validation d'état DOM et événements natifs React/Vue** |
| **Ancrage visuel (Grounding)** | Vision brute approximative (pixels) | **Arbre d'accessibilité (`axtree`) + Set-of-Marks (SoM) avec badges `[#1]`, `[#2]` dynamiques** |
| **Protocole sous-jacent** | Capture d'écran OS complète | **Chrome DevTools Protocol (CDP) direct via WebSocket local sécurisé (`127.0.0.1:9224`)** |
| **Gestion multi-onglets** | Limitée ou inexistante | **Contrôle total : `list_tabs`, `select_tab`, `new_tab`, `close_tab`, sélecteur rapide `@`** |
| **Isolation Concurrente & Arrière-Plan** | Vole le focus ou bloque l'utilisateur | **Exécution 100% en arrière-plan (`active: false`) sans vol de focus + Groupes d'onglets Chrome "Antigravity"** |
| **Extraction de données** | Scraping texte simple | **Dumps d'arbre DOM structuré, console logs en temps réel, cookies de session et export PDF vectoriel** |
| **Interface & Ergonomie** | Boîte noire sans interface | **Panneau latéral natif Chrome MV3 calqué sur Google Gemini (`#131314`), dictée vocale et mode Auto** |

---

## 🚀 Capacités Clés d'Automatisation

### 1. 📝 Remplissage Autonome de Formulaires & Data Entry
- Remplissage automatique de formulaires multi-champs (inputs texte, mots de passe, zones de texte, menus déroulants `<select>`, cases à cocher, boutons radio).
- Déclenchement automatique des événements JavaScript (`input`, `change`, `blur`) indispensables pour les Single Page Applications modernes (React, Next.js, Vue, Angular).
- Gestion des wizards et formulaires multi-étapes avec détection des erreurs de validation et correction itérative.

### 2. 🎯 Clic Déterministe & Navigation Web
- Clics précis par sélecteur CSS, XPath ou coordonnées écran avec ripple laser visuel (`__antigravity_visual_click`).
- Prise en charge des clics sémantiques basés sur le texte visible et le rôle ARIA.
- Défilement intelligent (`scroll`), survol d'éléments (`hover`) pour afficher les menus déroulants et infobulles.
- Navigation multi-onglets (`navigate`, `reload`, `select_tab`, `new_tab`, `close_tab`).

### 3. 🏷️ Set-of-Marks (SoM) & Vision AI Grounding
- Injection instantanée de badges numérotés (`[#1]`, `[#2]`, ...) sur tous les éléments interactifs de la page active (y compris au sein du Shadow DOM récursif).
- Permet aux modèles multimodaux (Gemini 2.5 Pro / Flash) de désigner avec une précision absolue l'élément à manipuler, éliminant tout risque d'erreur de sélecteur.

### 4. 🔍 Extraction de Données & Inspection Web
- **Accessibility Tree (`axtree`)** : Extraction de la hiérarchie d'accessibilité compacte pour une compréhension instantanée de la structure logique de la page.
- **Console Logs en direct** : Capture de tous les messages `console.log`, `console.error` et avertissements pour diagnostiquer les erreurs web.
- **Captures d'écran & PDF** : Dumps WebP/PNG optimisés (< 200 Ko) et impression PDF vectorielle native via CDP.
- **Cookies & Sessions** : Lecture et injection de cookies pour la navigation authentifiée sans ré-authentification répétitive.

### 5. 💬 Panneau Latéral Copilote Google Gemini 1:1
- Interface docking native Chrome persistante (`sidepanel.html`), toujours accessible via **`Ctrl + Shift + A`**.
- Thème sombre Google Gemini (`#131314`), typographie fluide Google Sans et étincelle animée.
- **Puce de contexte dynamique (« Work with Tabs »)** : Détection automatique de l'onglet actif avec raccourci `@` et bouton `+`.
- **Dictée vocale native** : Microphone interactif Web Speech API avec pulsation et retranscription en temps réel.
- **Mode `AGY 2.0 • Auto`** : Routage automatique de chaque invite entre modèle SOTA direct, raisonnement approfondi Pro ou vitesse Flash.

### 6. 🛡️ Isolation Concurrente en Arrière-Plan & Groupes d'Onglets ("Antigravity")
- **Non-interférence totale (Travail Parallèle Indépendant)** : Antigravity ouvre par défaut ses onglets de travail en arrière-plan (`active: false`). L'utilisateur continue de naviguer, rédiger et travailler dans ses propres onglets sans aucun vol de focus ni basculement intempestif.
- **Ciblage persistant de l'agent (`lastAgentTabId`)** : Toutes les commandes de l'agent s'exécutent de façon déterministe sur l'onglet d'arrière-plan sans jamais toucher à l'onglet actif de l'utilisateur.
- **Groupes d'Onglets Chrome Natifs (`chrome.tabGroups`)** : Tous les onglets créés par l'agent sont automatiquement réunis dans un groupe Chrome dédié violet intitulé **« Antigravity »**, isolés des onglets personnels et repliables d'un simple clic.
- **Status Pill Non-Intrusive** : Pilule translucide discrète `⚡ Antigravity · [Action]` affichée en bas à droite de l'onglet piloté, transparente aux clics (`pointer-events: none`) et à impact CPU strictement nul (0 ms de latence).

---

## 🏛️ Architecture Technique

```mermaid
flowchart LR
    subgraph Antigravity["Google Antigravity & AI Agents"]
        Agent["Agent IA / LLM\n(Gemini 2.5 / Flash)"]
        MCP["MCP Tools Client\n(32 outils Browser)"]
    end

    subgraph Bridge["Pont Local Sécurisé (Python 3.10+)"]
        Server["Bridge Server\n(127.0.0.1:9224 WS / 9225 HTTP)"]
        TokenAuth["Authentification par Jeton Local\n(NexusSecure Token)"]
    end

    subgraph Chrome["Google Chrome (Manifest V3)"]
        SW["Background Service Worker\n(background.js)"]
        CDP["Chrome DevTools Protocol\n(chrome.debugger)"]
        SidePanel["Gemini Side Panel UI\n(sidepanel.html)"]
        ContentScript["Content Script & SoM\n(content_script.js)"]
        Tabs["Onglets & Pages Web\n(DOM / React / SPA)"]
    end

    Agent <--> MCP
    MCP <-->|HTTP REST / JSON| Server
    Server <-->|WebSocket Sécurisé| SW
    SW <--> CDP
    SW <--> SidePanel
    CDP <--> Tabs
    ContentScript <--> Tabs
```

---

## 🛠️ Catalogue d'Outils pour Agents (Outils MCP / API)

L'agent Antigravity dispose d'une palette complète de 32 outils pour piloter Chrome :

| Outil | Description |
| :--- | :--- |
| `browser_new_tab(url, background=True, group="Antigravity")` | Ouvre un onglet en arrière-plan sans voler le focus et le regroupe dans Antigravity. |
| `browser_group_tabs(tab_ids, title, color)` | Regroupe des onglets Chrome dans un groupe nommé et coloré (`chrome.tabGroups`). |
| `browser_interactive_map(viewport_only=True)` | Cartographie condensée des éléments interactifs avec badges SoM `[#N]` (économie de 85% à 95% de tokens). |
| `browser_navigate(url)` | Ouvre ou redirige l'onglet actif ou cible vers une URL. |
| `browser_click(selector, mark)` | Clique avec précision Playwright-grade et effet laser sur sélecteur ou marqueur SoM `[#N]`. |
| `browser_fill(selector, text, mark)` | Remplissage réactif de formulaire (React, Next.js, contenteditable). |
| `browser_hover(selector, mark)` | Survole un élément pour révéler menus déroulants et infobulles. |
| `browser_press_key(key)` | Simule l'appui d'une touche (`Enter`, `Tab`, `ArrowDown`, etc.). |
| `browser_select_option(selector, value)` | Sélectionne une valeur dans un menu déroulant `<select>`. |
| `browser_drag_and_drop(from_mark, to_mark)` | Glisser-déposer fluide multi-étapes via CDP. |
| `browser_wait_load()` | Attend la stabilisation complète du document DOM. |
| `browser_wait_network_idle()` | Attend que toutes les requêtes Fetch/XHR soient terminées. |
| `browser_upload(files, selector)` | Téléversement direct de fichiers sans boîte de dialogue OS bloquante. |
| `browser_scroll(direction, y)` | Fait défiler la page (`up`, `down`, pixels). |
| `browser_screenshot(format, mark)` | Capture de l'onglet ou d'un élément précis sous format WebP/PNG compact (< 200 Ko). |
| `browser_content()` | Extrait le DOM ou le texte brut nettoyé de la page active. |
| `browser_axtree()` | Récupère l'arbre d'accessibilité hiérarchique pour le raisonnement IA. |
| `browser_list_tabs()` | Liste tous les onglets ouverts avec IDs, URLs, titres et `groupId`. |
| `browser_active_tab()` | Obtient les métadonnées de l'onglet actif. |
| `browser_select_tab(tab_id)` | Bascule l'action et le premier plan sur un onglet spécifique. |
| `browser_close_tab(tab_id)` | Ferme l'onglet spécifié ou l'onglet de travail d'arrière-plan. |
| `browser_reload(bypass_cache)` | Recharge la page de l'onglet actif ou cible. |
| `browser_eval(script)` | Exécute une expression JavaScript dans le contexte de la page. |
| `browser_get_cookies(urls)` | Lit les cookies de session pour la persistance d'authentification. |
| `browser_check_handoff()` | Détecte de façon proactive les challenges 2FA, OTP ou CAPTCHA. |
| `browser_cdp_send(method, params)` | Envoi de commande Chrome DevTools Protocol brute directe. |
| `browser_logs()` | Récupère les logs de la console DevTools de la page. |

---

## 🚀 Installation & Démarrage Rapide

### 1. Cloner le Dépôt
```bash
git clone https://github.com/pironjulien/antigravity-chrome-sidepanel.git
cd antigravity-chrome-sidepanel
```

### 2. Charger l'Extension dans Google Chrome
1. Ouvrez Google Chrome et accédez à `chrome://extensions`.
2. Activez le **Mode développeur** (en haut à droite).
3. Cliquez sur **Charger l'extension non empaquetée** (*Load unpacked*).
4. Sélectionnez le dossier `extension/` du dépôt.

### 3. Lancer le Serveur Pont Local
```bash
python native-host/bridge_server.py
```
> Le serveur écoute sur `ws://127.0.0.1:9224` (WebSocket) et `http://127.0.0.1:9225` (API REST). Il est immédiatement prêt à recevoir les requêtes d'Antigravity.

### 4. Utilisation au Quotidien
- **Raccourci Panneau Latéral** : Appuyez sur **`Ctrl + Shift + A`** pour ouvrir le panneau à tout moment.
- **Sélecteur d'Onglets `@`** : Tapez `@` dans la zone de texte pour cibler un autre onglet ouvert.
- **Dictée Vocale** : Cliquez sur le micro et dictez vos consignes en langage naturel.
- **Automatisation Agent** : Lancez vos tâches depuis Antigravity ; l'agent pilote automatiquement vos onglets Chrome !

---

## ⌨️ Raccourcis Disponibles

| Raccourci | Action |
| :--- | :--- |
| `Ctrl + Shift + A` | Ouvrir / fermer le Panneau Latéral Chrome |
| `@` | Ouvrir le sélecteur d'onglets de contexte |
| `Entrée` | Envoyer l'instruction au copilote |
| `click #N` | Cliquer directement sur l'élément avec le marqueur Set-of-Mark `#N` |

---

## 👨‍💻 Auteur & Licence

Développé par **Julien Piron** ([julienpiron.fr](https://julienpiron.fr) | X : [@julienpironfr](https://x.com/julienpironfr)).  
Publié sous licence **MIT**. Voir le fichier [LICENSE](LICENSE) pour plus de détails.
