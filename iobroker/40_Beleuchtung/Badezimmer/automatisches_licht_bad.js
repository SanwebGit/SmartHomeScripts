/**
 * @description Steuert einen Homematic-Aktor basierend auf Zigbee-Präsenzmeldern 
 * und einer definierten Zusatzbedingung.
 * @version     1.1.0
 * @author      Sanweb
 * @copyright   2026
 * @requires    javascript (ioBroker JavaScript Adapter)
 * @requires    zigbee2mqtt (ioBroker Zigbee2MQTT Adapter)
 * @requires    hm-rpc (ioBroker Homematic RPC Adapter)
 * @changelog
 * 1.1.0 - Optimierung für Homematic Duty-Cycle und Multi-Sensor-Logik
 * 1.0.0 - Initiale Erstellung
 */

(function() {
    "use strict";
// =============================================================================
// KONFIGURATION
// =============================================================================
// Das Auslagern von IDs in ein Config-Objekt verhindert "Magic Strings" im Code 
// und macht das Skript wartbar.
const CONFIG = {
    sensors: {
        presence: [
            'zigbee2mqtt.0.0xa4c138665cef7108.presence',
            'zigbee2mqtt.0.0xa4c138f24bb238a3.presence'
        ],
        // Zusatzbedingung (z.B. Helligkeit, Systemvariable oder ein anderer Aktor)
        condition: 'hm-rpc.0.003A20C99025DB.1.STATE',
        conditionExpectedValue: 0
    },
    actors: {
        target: 'hm-rpc.0.003AE0C9AD4F01.4.STATE'
    },
    settings: {
        // 'true' = Licht bleibt an, solange MINDESTENS EIN Melder Präsenz zeigt.
        // 'false' = (Original Blockly Verhalten) Licht geht aus, sobald EIN Melder 'false' meldet.
        useMultiSensorLogic: true 
    }
};

// =============================================================================
// LOGIK & FUNKTIONEN
// =============================================================================

/**
 * Prüft, ob mindestens einer der konfigurierten Präsenzmelder 'true' ist.
 * @returns {boolean} True, wenn mindestens ein Melder Präsenz erkennt.
 */
function isAnyPresenceActive() {
    return CONFIG.sensors.presence.some(sensorId => {
        const state = getState(sensorId);
        return state ? state.val === true : false;
    });
}

/**
 * Hauptfunktion zur Initialisierung der Trigger
 */
function initPresenceControl() {
    log('Initialisiere Präsenzsteuerung...', 'info');

    // Trigger auf alle Präsenzmelder (bei Änderung und bestätigtem Wert)
    on({ id: CONFIG.sensors.presence, change: 'ne', ack: true }, function (obj) {
        
        // 1. Auswerten der Bedingung
        const conditionState = getState(CONFIG.sensors.condition);
        const conditionMet = conditionState ? conditionState.val === CONFIG.sensors.conditionExpectedValue : false;

        // 2. Auswerten der Präsenz (abhängig von den Einstellungen)
        let isPresence = false;
        if (CONFIG.settings.useMultiSensorLogic) {
            // Next-Level: Ist *irgendein* Melder aktiv?
            isPresence = isAnyPresenceActive();
        } else {
            // Nimmt stur den Wert des Melders, der gerade ausgelöst hat
            isPresence = obj.state.val === true;
        }

        // 3. Zielzustand ermitteln (Präsenz vorhanden UND Bedingung erfüllt)
        const shouldBeOn = isPresence && conditionMet;

        // 4. Aktor schonend schalten (Duty-Cycle Schutz bei z.B. Homematic Geräten)
        const currentActorState = getState(CONFIG.actors.target);
        const currentActorVal = currentActorState ? currentActorState.val : null;
        
        // Wir schalten nur, wenn der Aktor nicht ohnehin schon im gewünschten Zustand ist (oder der Zustand unbekannt ist)
        if (currentActorVal !== shouldBeOn) {
            // false am Ende bedeutet: Wir senden den Befehl (ack: false), wir bestätigen ihn nicht nur
            setState(CONFIG.actors.target, shouldBeOn, false); 
            log(`[Auto-Licht Bad] Zustand geändert durch ${obj.id}: Schalte Aktor auf ${shouldBeOn}`, 'info');
        } else {
            // Debug-Ausgabe für Testzwecke
            log(`[Auto-Licht Bad] Aktor ist bereits auf ${shouldBeOn}, überspringe Schaltvorgang.`, 'debug');
        }
    });
}

// =============================================================================
// SKRIPT START
// =============================================================================
// Kapselung des Skripts in einer Start-Funktion (Best Practice)
initPresenceControl();

})();