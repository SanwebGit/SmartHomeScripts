/**
 * ==============================================================================
 * @fileoverview ioBroker Script: Alexa History Trigger via Mute-Status
 * @version 1.0.0
 * @author Sanweb
 * * Beschreibung:
 * Dieses Skript überwacht den Mute-Status aller Alexa Echo-Geräte über einen
 * Selektor. Sobald sich ein Mute-Status aktualisiert, wird der History-Trigger
 * der Alexa2-Instanz mit einer Verzögerung von 2,5 Sekunden ausgelöst.
 * * Systemanforderungen:
 * - ioBroker JavaScript Adapter
 * - ioBroker Alexa2 Adapter
 * ==============================================================================
 */
(function() {
    "use strict";

// === [ KONFIGURATION ] ========================================================

/** @type {ScriptConfig} */
const CONFIG = {
    // Wildcard-Muster für alle Mute-Datenpunkte der Echo-Devices
    patternMuted: 'alexa2.0.Echo-Devices.*.Player.muted',
    
    // Ziel-Datenpunkt, der getriggert werden soll
    dpHistoryTrigger: 'alexa2.0.History.#trigger',
    
    // Verzögerung in Millisekunden
    delayMs: 2500,
    
    // false = Laufende Timer NICHT löschen
    // true  = Verhindert mehrfaches Auslösen, wenn in den 2,5s erneute Updates kommen (Empfehlung!)
    clearRunningTimer: true,
    
    // Auslösebedingung ('any' = bei jeder Aktualisierung, 'ne' = nur bei echter Änderung)
    triggerCondition: 'ne' 
};
// ==============================================================================

/**
 * Hauptfunktion zur Initialisierung des Skripts.
 * Kapselt die Logik und hält den globalen Namensraum sauber.
 */
function initAlexaMuteTrigger() {
    // Prüfen, ob der Ziel-Datenpunkt grundsätzlich existiert (verhindert Fehlermeldungen)
    if (!existsState(CONFIG.dpHistoryTrigger)) {
        log(`Fehler: Der Ziel-Datenpunkt '${CONFIG.dpHistoryTrigger}' existiert nicht.`, 'warn');
        return;
    }

    // Event-Listener auf das Muster setzen (ohne jQuery-Selektor $)
    on({ id: CONFIG.patternMuted, change: CONFIG.triggerCondition }, handleMuteUpdate);
    
    log('Alexa History Trigger Skript erfolgreich initialisiert.', 'info');
}

/**
 * Handler-Funktion, die bei jedem Trigger-Event aufgerufen wird.
 * @param {object} obj - Das ioBroker State-Objekt, das das Event ausgelöst hat
 */
function handleMuteUpdate(obj) {
    // Optionales Debugging (kann bei Bedarf im ioBroker Log-Level aktiviert werden)
    log(`Mute-Event erkannt bei: ${obj.id} (Wert: ${obj.state.val})`, 'debug');

    // Verzögertes Setzen des History-Triggers
    setStateDelayed(
        CONFIG.dpHistoryTrigger, 
        true, 
        CONFIG.delayMs, 
        CONFIG.clearRunningTimer
    );
}

// === [ SKRIPT START ] =========================================================
initAlexaMuteTrigger();

})();