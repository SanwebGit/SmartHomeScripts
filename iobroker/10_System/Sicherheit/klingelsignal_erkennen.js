/*******************************************************************************
 * Skriptname:   Klingelsignal & Sturm Protection
 * Beschreibung: Verarbeitet das Klingelsignal (HmIP), steuert den Türsummer 
 * bei gewährtem Zutritt und gibt eine Alexa-Sprachmeldung aus.
 * Inklusive "Sturm Protection" (Cooldown) gegen Dauer-Klingeln.
 * Autor:        Sanweb
 * * -----------------------------------------------------------------------------
 * Versionshistorie:
 * v1.0.1  | 04.03.2026 | Auto-Create für fehlende Datenpunkte hinzugefügt
 * v1.0.0  | 04.03.2026 | Initiale Version
 *******************************************************************************/

// ==============================================================================
// KONFIGURATION: DATENPUNKTE BITTE ANPASSEN
// ==============================================================================
(async () => {

// Der von dir genannte Datenpunkt des HmIP Klingelsensors
// (Hinweis: '1.STATE' repräsentiert Kanal 1 und den Datenpunkt STATE)
const DP_KLINGEL = 'hm-rpc.0.0026E0C998D1F2.1.STATE';

// Datenpunkt der Zutrittskontrolle (Boolean erwartet: true = gewährt, false = verweigert)
// Falls du eine Werteliste nutzt, muss die Abfrage weiter unten angepasst werden.
const DP_ZUTRITTSKONTROLLE = '0_userdata.0.Haustuer.Zutrittskontrolle_Haustuer';

// Datenpunkt zum Speichern des letzten Klingelzeitpunkts (Typ: Number/Zahl)
const DP_LAST_RING = '0_userdata.0.Haustuer.Klingel_LastRingTime';

// Datenpunkt für den HmIP-PCBS Haustürsummer (meist Kanal 3 oder 4, .STATE)
const DP_TUERSUMMER = 'hm-rpc.0.00045A49A87CFF.3.STATE';

// Datenpunkt für die Alexa Sprachausgabe (Gruppe Überall)
const DP_ALEXA_SPEAK = 'alexa2.0.Echo-Devices.e4a56dc3ec9a497c9209c05d2c29a09d.Commands.speak';

// ==============================================================================
// KONFIGURATION: VARIABLEN UND BEFEHLE
// ==============================================================================
const ALEXA_MESSAGE = 'Ding Dong, es hat an der Haustür geklingelt!';

// Konfiguration der Zeiten
const ALEXA_START_ZEIT = '11:00';    // Ab wann darf Alexa sprechen? (Format HH:MM)
const ALEXA_ENDE_ZEIT = '22:00';     // Bis wann darf Alexa sprechen? (Format HH:MM)
const TUERSUMMER_DAUER_MS = 2000;    // Wie lange zieht der Türsummer an? (in Millisekunden)
const STURM_PROTECTION_MS = 33000;   // Wie lange ist die Klingel nach Betätigung gesperrt? (in Millisekunden)

const DEBUG = false; // Auf true setzen für Entwicklung / detailliertes Logging

// Interne Variablen für Timer und den Klingelschutz (Sturm Protection)
let lastRingTime = 0; // Speichert den Zeitstempel des letzten Klingelns (verhindert Race Conditions)
let timerTuersummer = null;

// ==============================================================================
// HILFSFUNKTIONEN
// ==============================================================================

// Debug-Logging
function logDebug(msg) {
    if (DEBUG) log(msg, 'debug');
}

// Funktion zum Prüfen ob die aktuelle Zeit im konfigurierten Fenster liegt
function isTimeInRange(startTime, endTime) {
    const now = new Date();
    const startParts = startTime.split(':');
    const endParts = endTime.split(':');
    
    const startMins = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10);
    const endMins = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10);
    const currentMins = now.getHours() * 60 + now.getMinutes();
    
    return currentMins >= startMins && currentMins < endMins;
}

// Sicheres Setzen von States mit Prüfung und Logging sowie Callback-Fehlerbehandlung
function safeSetState(id, val) {
    if (existsState(id)) {
        log(`Setze Datenpunkt "${id}" auf Wert: ${val}`, 'debug');
        // Hinweis zum ack-Flag:
        // Andere States hier nutzen ack=false (Steuerbefehle an Geräte).
        // DP_LAST_RING nutzt im Hauptprogramm ack=true (reiner Status, keine Steuerung).
        setState(id, val, false, (err) => {
            if (err) log(`Fehler beim Setzen von ${id}: ${err}`, 'error');
        });
    } else {
        log(`Fehler: Datenpunkt "${id}" existiert nicht. Aktion abgebrochen.`, 'warn');
    }
}

// ==============================================================================
// INITIALISIERUNG & AUTO-CREATE DATENPUNKTE
// ==============================================================================

// Plausibilitätsprüfung der konfigurierten Zeiten
if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(ALEXA_START_ZEIT) || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(ALEXA_ENDE_ZEIT)) {
    log('WARNUNG: ALEXA_START_ZEIT oder ALEXA_ENDE_ZEIT haben ein ungültiges Format! Erwartet wird HH:MM', 'warn');
} else {
    // Zusätzlich prüfen, ob Startzeit vor Endzeit liegt
    const startParts = ALEXA_START_ZEIT.split(':');
    const endParts = ALEXA_ENDE_ZEIT.split(':');
    const startMins = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10);
    const endMins = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10);
    if (startMins >= endMins) {
        log('WARNUNG: ALEXA_START_ZEIT liegt nach oder auf ALEXA_ENDE_ZEIT!', 'warn');
    }
}

// 1. Datenpunkt für die Zutrittskontrolle prüfen und ggf. anlegen
if (!existsState(DP_ZUTRITTSKONTROLLE)) {
    log(`Datenpunkt ${DP_ZUTRITTSKONTROLLE} existiert nicht. Wird automatisch angelegt...`, 'info');
    await createStateAsync(DP_ZUTRITTSKONTROLLE, false, {
        name: 'Zutrittskontrolle Haustür',
        desc: 'Status der Zutrittskontrolle',
        type: 'boolean',
        role: 'indicator',
        read: true,
        write: true
    });
}

// 2. Datenpunkt für den letzten Klingelzeitpunkt prüfen und ggf. anlegen
if (!existsState(DP_LAST_RING)) {
    log(`Datenpunkt ${DP_LAST_RING} existiert nicht. Wird automatisch angelegt...`, 'info');
    await createStateAsync(DP_LAST_RING, 0, {
        name: 'Letzter Klingelzeitpunkt',
        desc: 'Timestamp des letzten Klingelsignals in Millisekunden',
        type: 'number',
        role: 'value.time',
        read: true,
        write: true
    });
    lastRingTime = 0; // Wert ist 0, da der Datenpunkt gerade erst angelegt wurde
} else {
    // Letzten Klingel-Zeitpunkt laden (Datenpunkt existierte bereits)
    const savedTime = getState(DP_LAST_RING).val;
    if (typeof savedTime === 'number' && !isNaN(savedTime)) {
        lastRingTime = savedTime;
        logDebug(`Letzter Klingelzeitpunkt aus Datenpunkt geladen: ${lastRingTime}`);
    } else {
        log('WARNUNG: Gespeicherter Klingelzeitpunkt ist ungültig, verwende 0', 'warn');
        lastRingTime = 0;
    }
}

// ==============================================================================
// HAUPTPROGRAMM (TRIGGER)
// ==============================================================================

// Trigger auf Aktualisierung des Klingelsensors (wenn Wert 'true' ist)
on({id: DP_KLINGEL, val: true, ack: true}, function (obj) {
    
    const now = Date.now();

    // 1. KLINGELSCHUTZ PRÜFEN (Timestamp-basierter Cooldown)
    if ((now - lastRingTime) < STURM_PROTECTION_MS) {
        const remaining = Math.round((STURM_PROTECTION_MS - (now - lastRingTime)) / 1000);
        log(`Klingel betätigt, aber Sturm Protection ist noch aktiv (${remaining}s verbleibend). Aktion ignoriert.`, 'info');
        return;
    }

    // Klingelschutz aktivieren (Zeitstempel setzen)
    lastRingTime = now;
    if (existsState(DP_LAST_RING)) {
        // Hinweis zum ack-Flag: ack=true, da wir hier nur einen Status im System protokollieren und nichts steuern
        setState(DP_LAST_RING, lastRingTime, true); 
    }
    log('Klingelsignal erkannt. Ablauf startet, Sturm Protection aktiviert.', 'info');

    // Aktuellen Status der Zutrittskontrolle abrufen (Explizite Boolean-Prüfung)
    let zutrittGewaehrt = false;
    if (existsState(DP_ZUTRITTSKONTROLLE)) {
        zutrittGewaehrt = (getState(DP_ZUTRITTSKONTROLLE).val === true);
    }

    if (!zutrittGewaehrt) {
        // ----------------------------------------------------------------------
        // BEDINGUNG: Zutritt verweigert (Normale Klingelfunktion)
        // ----------------------------------------------------------------------
        log('Zutritt verweigert. Führe normalen Klingelablauf aus.', 'info');

        // Uhrzeit abfragen (mit neuer HH:MM Prüfung)
        if (isTimeInRange(ALEXA_START_ZEIT, ALEXA_ENDE_ZEIT)) {
            // Alexa Sprachausgabe
            safeSetState(DP_ALEXA_SPEAK, ALEXA_MESSAGE);
        } else {
            log(`Uhrzeit außerhalb ${ALEXA_START_ZEIT}-${ALEXA_ENDE_ZEIT} Uhr: Alexa bleibt stumm.`, 'info');
        }

    } else {
        // ----------------------------------------------------------------------
        // BEDINGUNG: Zutritt gewährt (Haustürsummer auslösen)
        // ----------------------------------------------------------------------
        log('Zutritt gewährt. Betätige Türsummer.', 'info');

        // Haustürsummer sofort Ein
        safeSetState(DP_TUERSUMMER, true);

        // Haustürsummer nach definierter Zeit Aus
        if (timerTuersummer) clearTimeout(timerTuersummer);
        logDebug('Timer für Türsummer gestartet');
        timerTuersummer = setTimeout(function() {
            safeSetState(DP_TUERSUMMER, false);
        }, TUERSUMMER_DAUER_MS);

        // Zutrittskontrolle sofort wieder auf "verweigert" zurücksetzen
        safeSetState(DP_ZUTRITTSKONTROLLE, false);
    }
});

// ==============================================================================
// SKRIPT STOPP BEHANDLUNG
// ==============================================================================
onStop(function () {
    log('Skript wird gestoppt. Bereinige Timer und setze Türsummer zurück...', 'info');
    if (timerTuersummer) {
        clearTimeout(timerTuersummer);
        timerTuersummer = null;
        // Sicherheitshalber den Summer ausschalten, falls er gerade an war
        if (existsState(DP_TUERSUMMER)) {
            setState(DP_TUERSUMMER, false);
            log('Türsummer wegen Skript-Stopp sicherheitshalber ausgeschaltet.', 'info');
        }
    }
});

})();