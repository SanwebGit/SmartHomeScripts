/********************************************************************************
 * Script:       Astro Szenen Steuerung
 * Description:  Steuert Smart Home Szenen (Tag, Nacht, Aus) basierend auf 
 * dem Astro-Status und der aktuellen Uhrzeit.
 * Version:      1.0.0
 * Author:       Sanweb
 * Datum:        2026-03-09
 * * Changelog:
 * 1.1.1  - Eindeutiger Log-Prefix hinzugefügt für bessere Übersicht im ioBroker-Log.
 * 1.1.0  - Konfiguration in ein zentrales CONFIG-Objekt ausgelagert (Refactoring).
 * 1.0.0  - Initiale Version (Portierung aus Node-RED)
 * inkl. RBE (Report By Exception) und robuster Fehlerprüfung.
 ********************************************************************************/

(function() {
    "use strict";

// ==========================================
// Konfiguration
// ==========================================
const CONFIG = {
    LOG_PREFIX: "[Astro-Szenen] ", // Eindeutige Bezeichnung für das Logbuch
    ASTRO_ID: "0_userdata.0.System.Astro.TagNacht",
    SCENES: {
        TAG: "scene.0.Automatisches Licht.Astro_Tag",
        NACHT: "scene.0.Automatisches Licht.Astro_Nacht",
        AUS: "scene.0.Automatisches Licht.Astro_Aus"
    },
    TIMES: {
        NIGHT_OFF: "22:30", // Ende Abendlicht
        EARLIEST_START: 12  // Früheste Stunde für Abendlicht
    }
};

// ==========================================
// Initialisierung & RBE (Report By Exception)
// ==========================================
let lastScene = "none";

// Verbesserte Initialisierung mit Priorität
function initializeLastScene() {
    if (existsState(CONFIG.SCENES.TAG) && getState(CONFIG.SCENES.TAG).val) {
        lastScene = "Tag";
    } else if (existsState(CONFIG.SCENES.NACHT) && getState(CONFIG.SCENES.NACHT).val) {
        lastScene = "Nacht";
    } else if (existsState(CONFIG.SCENES.AUS) && getState(CONFIG.SCENES.AUS).val) {
        lastScene = "Alles Aus";
    } else {
        lastScene = "none";
    }
    log(`${CONFIG.LOG_PREFIX}Initialisiert: lastScene = ${lastScene}`, "debug");
}

// Dann aufrufen:
initializeLastScene();

// ==========================================
// Hauptlogik
// ==========================================
function checkAstroScene() {
    // Input lesen und auf Existenz prüfen
    if (!existsState(CONFIG.ASTRO_ID)) {
        log(`${CONFIG.LOG_PREFIX}Astro-Datenpunkt existiert nicht: ${CONFIG.ASTRO_ID}`, "warn");
        return;
    }

    const astroState = getState(CONFIG.ASTRO_ID);
    if (!astroState || astroState.val === null) {
        log(`${CONFIG.LOG_PREFIX}Konnte Astro-Status nicht lesen oder Status ist null`, "warn");
        return;
    }
    
    // Typensicherheit: Explizit als String behandeln
    const astroStatus = String(astroState.val);

    // Aktuelle Zeit ermitteln
    const now = new Date();
    const currentHours = now.getHours();
    const currentMinutes = now.getMinutes();
    const currentTimeVal = currentHours * 60 + currentMinutes;

    // Endzeit in Minuten umrechnen
    const [endH, endM] = CONFIG.TIMES.NIGHT_OFF.split(':').map(Number);
    const endTimeVal = endH * 60 + endM;
    const startTimeVal = CONFIG.TIMES.EARLIEST_START * 60;

    // Variablen für die 3 Ausgänge (Standard: false)
    let valTag = false;
    let valNacht = false;
    let valAus = false;
    let currentSceneName = "";

    // --- LOGIK ---
    if (astroStatus === "Tag") {
        // Es ist Tag -> Szene Tag aktivieren
        valTag = true;
        currentSceneName = "Tag";
        
    } else if (astroStatus === "Nacht") {
        // Es ist Nacht -> Prüfen ob vor oder nach 22:30
        if (currentTimeVal >= startTimeVal && currentTimeVal < endTimeVal) {
            // Abend (Dunkel & vor 22:30) -> Szene Nacht aktivieren
            valNacht = true;
            currentSceneName = "Nacht";
        } else {
            // Spät (Dunkel & nach 22:30 oder morgens vor 12) -> Szene Aus aktivieren
            valAus = true;
            currentSceneName = "Alles Aus";
        }
    } else {
        log(`${CONFIG.LOG_PREFIX}Unbekannter Astro Status: ${astroStatus}`, "warn");
        return; // Abbruch, wenn der Status ungültig ist
    }

    // Debug-Logging für bessere Fehlersuche
    log(`${CONFIG.LOG_PREFIX}Prüfung: Astro=${astroStatus}, Zeit=${currentHours}:${currentMinutes}, Aktuelle Szene=${currentSceneName}, Letzte Szene=${lastScene}`, "debug");

    // --- RBE (Report By Exception) ---
    // Wir senden nur Befehle, wenn sich die aktive Szene ändert
    if (currentSceneName !== lastScene) {
        lastScene = currentSceneName;
        log(`${CONFIG.LOG_PREFIX}Status-Änderung erkannt: Aktiviere Szene -> ${currentSceneName}`);

        // Ausgänge schalten (ack: false explizit gesetzt für Steuerbefehle)
        setState(CONFIG.SCENES.TAG, valTag, false);
        setState(CONFIG.SCENES.NACHT, valNacht, false);
        setState(CONFIG.SCENES.AUS, valAus, false);
    }
}

// ==========================================
// Trigger
// ==========================================

// 1. Trigger: Bei jeder Änderung des Astro-Datenpunkts (entspricht "ioBroker in" Node)
on({ id: CONFIG.ASTRO_ID, change: "ne" }, function (obj) {
    checkAstroScene();
});

// 2. Trigger: Zeitplan alle 5 Minuten (entspricht "inject" Node mit repeat: 300)
// Dieser Intervall-Check stellt sicher, dass zeitbasierte Wechsel (z.B. um 22:30 Uhr)
// zuverlässig ausgelöst werden, auch wenn der Astro-Status ("Nacht") sich nicht ändert.
schedule("*/5 * * * *", function () {
    checkAstroScene();
});

// 3. Beim Starten des Skripts einmalig prüfen (entspricht fireOnStart)
checkAstroScene();

})();