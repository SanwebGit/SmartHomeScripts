/********************************************************************************
 * Script:       Astro Szenen Steuerung
 * Description:  Steuert Smart Home Szenen (Tag, Nacht, Aus) basierend auf 
 * dem Astro-Status und der aktuellen Uhrzeit.
 * Version:      1.4.1
 * Author:       Sanweb
 * Datum:        2026-03-09
 * * Changelog:
 * 1.4.1  - Feste scenes-Adapter Instanz (scenes.0) im CONFIG definiert (Bugfix für Instanz-Name).
 * 1.4.0  - Umstellung auf sendTo() für das Aktivieren/Deaktivieren von Szenen.
 * 1.3.0  - Rollback auf Logik 1.1.1, Typen-Normalisierung für Initialisierung.
 * 1.2.1  - Typen-Normalisierung in setIfChanged hinzugefügt.
 * 1.2.0  - Prüfung des Ist-Zustandes vor dem Schalten.
 * 1.1.1  - Eindeutiger Log-Prefix.
 * 1.1.0  - Konfiguration in ein zentrales CONFIG-Objekt ausgelagert.
 * 1.0.0  - Initiale Version (Portierung aus Node-RED).
 ********************************************************************************/

(function() {
    "use strict";

// ==========================================
// Konfiguration
// ==========================================
const CONFIG = {
    LOG_PREFIX: "[Astro-Szenen] ", // Eindeutige Bezeichnung für das Logbuch
    ASTRO_ID: "0_userdata.0.System.Astro.TagNacht",
    SCENES_ADAPTER: "scenes.0",    // Die Instanz des Szenen-Adapters für sendTo()
    SCENES: {
        TAG: "scene.0.Automatisches Licht.Astro_Tag",
        NACHT: "scene.0.Automatisches Licht.Astro_Nacht",
        AUS: "scene.0.Automatisches Licht.Astro_Aus"
    },
    TIMES: {
        NIGHT_OFF: "22:30", // Ende Nachtlicht
        EARLIEST_START: 12  // Früheste Stunde für Nachtlicht
    }
};

// ==========================================
// Initialisierung & RBE (Report By Exception)
// ==========================================
let lastScene = "none";

// Wandelt verschiedene ioBroker Datentypen (String, Number) sicher in einen Boolean um
function normalizeBool(value) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    return Boolean(value);
}

// Verbesserte Initialisierung mit Priorität und Typen-Normalisierung
function initializeLastScene() {
    if (existsState(CONFIG.SCENES.TAG) && normalizeBool(getState(CONFIG.SCENES.TAG).val)) {
        lastScene = "Tag";
    } else if (existsState(CONFIG.SCENES.NACHT) && normalizeBool(getState(CONFIG.SCENES.NACHT).val)) {
        lastScene = "Nacht";
    } else if (existsState(CONFIG.SCENES.AUS) && normalizeBool(getState(CONFIG.SCENES.AUS).val)) {
        lastScene = "Alles Aus";
    } else {
        lastScene = "none";
    }
    log(`${CONFIG.LOG_PREFIX}Initialisiert: lastScene = ${lastScene}`, "debug");
}

// Dann aufrufen:
initializeLastScene();

// ==========================================
// Hilfsfunktionen
// ==========================================

// Aktiviert oder deaktiviert eine Szene über den offiziellen sendTo-Befehl des Adapters
function setSceneState(sceneId, isActive) {
    const command = isActive ? 'enable' : 'disable';
    
    // Sendet den Befehl an die zentrale Adapter-Instanz (z.B. "scenes.0")
    sendTo(CONFIG.SCENES_ADAPTER, command, sceneId, result => {
        if (result && result.err) {
            log(`${CONFIG.LOG_PREFIX}Fehler bei '${command}' für ${sceneId}: ${result.err}`, "error");
        } else {
            // Optionales Debug-Log, um den erfolgreichen sendTo-Befehl zu verfolgen
            log(`${CONFIG.LOG_PREFIX}Befehl '${command}' erfolgreich an ${sceneId} gesendet.`, "debug");
        }
    });
}

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
    log(`${CONFIG.LOG_PREFIX}Prüfung: Astro=${astroStatus}, Zeit=${currentHours}:${currentMinutes}, Aktuelle Szene=${currentSceneName}, Letzte Szene=${lastScene}`, "info");

    // --- RBE (Report By Exception) ---
    // Wir senden nur Befehle, wenn sich die aktive Szene ändert
    if (currentSceneName !== lastScene) {
        lastScene = currentSceneName;
        log(`${CONFIG.LOG_PREFIX}Status-Änderung erkannt: Aktiviere Szene -> ${currentSceneName}`);

        // Ausgänge über den offiziellen sendTo-Befehl an die zentrale Instanz schalten
        // Dies führt dazu, dass EINE Szene ein "enable" bekommt und ZWEI ein "disable"
        setSceneState(CONFIG.SCENES.TAG, valTag);
        setSceneState(CONFIG.SCENES.NACHT, valNacht);
        setSceneState(CONFIG.SCENES.AUS, valAus);
    }
}

// ==========================================
// Trigger
// ==========================================

// 1. Trigger: Bei jeder Änderung des Astro-Datenpunkts
on({ id: CONFIG.ASTRO_ID, change: "ne" }, function (obj) {
    checkAstroScene();
});

// 2. Trigger: Zeitplan alle 5 Minuten
// Dieser Intervall-Check stellt sicher, dass zeitbasierte Wechsel (z.B. um 22:30 Uhr)
// zuverlässig ausgelöst werden, auch wenn der Astro-Status ("Nacht") sich nicht ändert.
schedule("*/5 * * * *", function () {
    checkAstroScene();
});

// 3. Beim Starten des Skripts einmalig prüfen
checkAstroScene();

})();