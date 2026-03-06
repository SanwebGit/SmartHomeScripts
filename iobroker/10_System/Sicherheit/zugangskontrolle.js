/***************************************************************************************
 * Script:       Zutrittskontrolle Haustür
 * Description:  Überwacht Homematic HmIP-WKP Keypad zur temporären Freigabe der Zutrittskontrolle.
 * Setzt den Status für 2 Minuten auf TRUE, danach automatisch wieder auf FALSE.
 * Author:       Sanweb
 * Version:      1.6.2
 * Date:         2026-03-06
 ***************************************************************************************/
(async () => {
    "use strict";
// =========================================================================
// KONFIGURATION
// Bitte passe die folgenden Werte an deine ioBroker-Umgebung an.
// =========================================================================
const CONFIG = {
    // ---------------------------------------------------------------------
    // HAUPT-EINSTELLUNGEN
    // ---------------------------------------------------------------------
    
    // ZIEL-DATENPUNKT (Boolean: true/false)
    // Dieser Datenpunkt wird auf "true" gesetzt, wenn eine Taste gedrückt wird.
    // Nach Ablauf der Zeit (TIMEOUT_MINUTES) wird er wieder auf "false" gesetzt.
    // Tipp: Erstelle diesen Datenpunkt idealerweise manuell unter '0_userdata.0...'.
    TARGET_ID: '0_userdata.0.Haustuer.Zutrittskontrolle_Haustuer',
    
    // AUSLÖSER / QUELL-DATENPUNKTE (Array von Strings)
    // Liste aller Datenpunkte, die den Ziel-Datenpunkt aktivieren sollen (z.B. Taster, Fernbedienungen).
    // Das Script reagiert, wenn einer dieser Datenpunkte den Wert "true" annimmt.
    SOURCE_IDS: [
        'hm-rpc.0.002E9F29993DEB.1.PRESS_LOCK',
        'hm-rpc.0.002E9F29993DEB.2.PRESS_UNLOCK',
        'hm-rpc.0.002E9F29993DEB.3.PRESS_LOCK',
        'hm-rpc.0.002E9F29993DEB.4.PRESS_UNLOCK'
    ],
    
    // ZEITSTEUERUNG
    // Wie viele Minuten soll die Zutrittskontrolle auf "true" (freigegeben) bleiben?
    TIMEOUT_MINUTES: 2,

    // ---------------------------------------------------------------------
    // EXPERTEN-EINSTELLUNGEN (Normalerweise keine Änderung nötig)
    // ---------------------------------------------------------------------
    
    // SCRIPT-STOP-VERZÖGERUNG (in Millisekunden)
    // Zeitfenster, in dem das Script beim Beenden/Neustarten aufräumen darf (Timer löschen).
    STOP_TIMEOUT_MS: 2000, 
    
    // SPAM-SCHUTZ / DEBOUNCE (in Millisekunden)
    // Verhindert, dass mehrmaliges extrem schnelles Drücken Fehler verursacht.
    // Nach dieser Zeit wird das Script spätestens wieder für neue Tastendrücke freigegeben.
    LOCK_TIMEOUT_MS: 5000, 

    // SYSTEM-ÜBERWACHUNG (Cron-Syntax)
    // Wann soll das Script täglich prüfen, ob der Ziel-Datenpunkt noch existiert?
    // Standard: '0 0 * * *' (Täglich um Mitternacht)
    DAILY_CHECK_CRON: '0 0 * * *', 

    // ---------------------------------------------------------------------
    // BENACHRICHTIGUNGEN & LOGGING
    // ---------------------------------------------------------------------
    
    // FEHLER-MELDUNGEN PER MESSENGER
    // Trage hier deine Messenger-Instanz ein (z.B. 'telegram.0', 'pushover.0', 'email.0').
    // Das Script meldet sich dann aktiv, wenn z.B. der Ziel-Datenpunkt versehentlich gelöscht wurde.
    // Leer lassen (''), um Benachrichtigungen komplett zu deaktivieren.
    NOTIFICATION_INSTANCE: '', 
    
    // DEBUG-MODUS (true / false)
    // Wenn "true", schreibt das Script detaillierte Infos ins ioBroker-Log (gut zur Einrichtung).
    // Wenn "false", werden nur echte Fehler ins Log geschrieben (empfohlen für den Dauerbetrieb).
    DEBUG_MODE: true 
};

const TIMEOUT_MS = CONFIG.TIMEOUT_MINUTES * 60 * 1000;
let timeoutTimer = null;
let isProcessing = false; // Lock-Variable zur Vermeidung von Mehrfachausführungen
let targetExists = false; // Caching für die Existenz des Ziel-Datenpunktes

// Metriken für Monitoring
const METRICS = {
    triggers: 0,
    timerStarts: 0,
    timerCancelled: 0, // Durch neue Trigger abgebrochene Timer
    errors: 0,
    lastTrigger: null
};

// State-Change-History für Trigger
const HISTORY = {
    maxEntries: 10,
    entries: []
};

// Hilfsfunktion zur Pflege der Historie
function addHistory(entry) {
    HISTORY.entries.unshift({
        timestamp: new Date().toISOString(),
        ...entry
    });
    if (HISTORY.entries.length > HISTORY.maxEntries) {
        HISTORY.entries.pop();
    }
}

// Hilfsfunktion für Benachrichtigungen bei kritischen Fehlern
function notifyAdmin(message) {
    if (CONFIG.NOTIFICATION_INSTANCE) {
        try {
            sendTo(CONFIG.NOTIFICATION_INSTANCE, 'send', {
                text: `🚨 [Zutrittskontrolle] ${message}`
            });
            logDebug(`Benachrichtigung über ${CONFIG.NOTIFICATION_INSTANCE} gesendet.`);
        } catch (e) {
            log(`[Zutrittskontrolle] Fehler beim Senden der Benachrichtigung: ${e.message}`, 'error');
        }
    }
}

// Hilfsfunktion für optionales Debug-Logging
function logDebug(message) {
    if (CONFIG.DEBUG_MODE) {
        log('[Zutrittskontrolle] ' + message, 'info');
    }
}

// Sicheres und asynchrones Setzen des Ziel-Datenpunktes mit Typen-Prüfung
async function setTargetState(value) {
    if (typeof value !== 'boolean') {
        METRICS.errors++;
        log('[Zutrittskontrolle] Fehler: Nur boolean-Werte erlaubt', 'error');
        return;
    }

    if (!targetExists) {
        METRICS.errors++;
        log('[Zutrittskontrolle] Fehler: Ziel-Datenpunkt existiert nicht!', 'warn');
        return;
    }

    try {
        // Nutzung der nativen ioBroker Async-Funktion anstelle eines manuellen Promise-Wrappers
        await setStateAsync(CONFIG.TARGET_ID, value, true);
        logDebug('Ziel-Datenpunkt auf ' + value + ' gesetzt.');
    } catch (e) {
        METRICS.errors++;
        log('[Zutrittskontrolle] Fehler beim Setzen des Datenpunktes: ' + e.message, 'error');
    }
}

// Zentrale Funktion für das Starten/Zurücksetzen des Timers
function startTimer(duration) {
    if (duration <= 0) {
        logDebug('Ungültige oder abgelaufene Timer-Dauer, setze direkt zurück.');
        setTargetState(false);
        return;
    }

    if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
        METRICS.timerCancelled++;
        logDebug('Vorheriger Timer gelöscht (Vermeidung von Race Conditions).');
    }
    
    METRICS.timerStarts++;
    logDebug('Starte Timer für ' + Math.round(duration / 1000) + ' Sekunden.');
    timeoutTimer = setTimeout(async function () {
        try {
            logDebug('Timer abgelaufen. Setze Zutrittskontrolle zurück.');
            await setTargetState(false);
        } catch (e) {
            METRICS.errors++;
            log('[Zutrittskontrolle] Fehler im Timer-Callback: ' + e.message, 'error');
        } finally {
            timeoutTimer = null;
        }
    }, duration);
}

// Script-Neustart abfangen: Prüfen ob ein Timer reaktiviert werden muss
async function checkInitialState() {
    const currentState = await getStateAsync(CONFIG.TARGET_ID);
    
    if (!currentState) {
        logDebug('Kein aktueller State gefunden für den Ziel-Datenpunkt.');
        return;
    }

    // Falls der Datenpunkt aktuell TRUE ist, prüfen wir, wie lange er das schon ist
    if (currentState.val === true) {
        const lastChange = currentState.lc || currentState.ts;
        
        if (!lastChange) {
            logDebug('Kein Zeitstempel verfügbar - setze zurück auf FALSE');
            await setTargetState(false);
            return;
        }

        const passedTime = Date.now() - lastChange;
        const remainingTime = TIMEOUT_MS - passedTime;

        if (remainingTime > 0) {
            logDebug('Script-Neustart erkannt: Datenpunkt war bereits TRUE. Reaktivierung für restliche ' + Math.round(remainingTime / 1000) + 's.');
            startTimer(remainingTime);
        } else {
            logDebug('Script-Neustart erkannt: Datenpunkt war TRUE, aber die 2 Minuten sind abgelaufen. Setze zurück auf FALSE.');
            await setTargetState(false);
        }
    }
}

// Konfigurations-Validierung beim Script-Start
function validateConfig() {
    if (!CONFIG.TARGET_ID || !CONFIG.SOURCE_IDS || CONFIG.SOURCE_IDS.length === 0) {
        throw new Error('Ungültige Konfiguration: TARGET_ID oder SOURCE_IDS fehlen.');
    }
    if (CONFIG.TIMEOUT_MINUTES <= 0) {
        log('[Zutrittskontrolle] Warnung: TIMEOUT_MINUTES sollte größer als 0 sein.', 'warn');
    }
}

// Prüft asynchron, ob die Quell-Datenpunkte existieren
async function validateSourceIds() {
    for (const id of CONFIG.SOURCE_IDS) {
        try {
            const exists = await existsStateAsync(id);
            if (!exists) {
                log('[Zutrittskontrolle] Warnung: Quell-Datenpunkt ' + id + ' existiert nicht!', 'warn');
            }
        } catch (e) {
            log('[Zutrittskontrolle] Fehler bei der Prüfung von ' + id + ': ' + e.message, 'error');
        }
    }
}

// Initiale Überprüfung beim Script-Start (mit asynchronem Check des Datenpunktes)
async function init() {
    try {
        validateConfig();
        await validateSourceIds();
        
        targetExists = await existsStateAsync(CONFIG.TARGET_ID);
        if (!targetExists) {
            log('[Zutrittskontrolle] Warnung: Ziel-Datenpunkt fehlt. Bitte anlegen.', 'warn');
        } else {
            await checkInitialState();
        }
    } catch (e) {
        log('[Zutrittskontrolle] Fehler bei der Initialisierung: ' + e.message, 'error');
    }
}

// Initialisierung starten
init();

// Tägliche Überprüfung der Existenz des Ziel-Datenpunkts und Loggen der Metriken
schedule(CONFIG.DAILY_CHECK_CRON, async () => {
    try {
        targetExists = await existsStateAsync(CONFIG.TARGET_ID);
        if (!targetExists) {
            METRICS.errors++;
            const errorMsg = 'Ziel-Datenpunkt wurde gelöscht oder ist nicht mehr erreichbar!';
            log(`[Zutrittskontrolle] Fehler: ${errorMsg}`, 'error');
            notifyAdmin(errorMsg);
        } else {
            logDebug(`Tägliche Prüfung OK. Metriken: Triggers: ${METRICS.triggers}, Timer Starts: ${METRICS.timerStarts}, Abbrüche: ${METRICS.timerCancelled}, Fehler: ${METRICS.errors}`);
            
            // Metriken nach Report zurücksetzen (lastTrigger bleibt für Historie erhalten)
            METRICS.triggers = 0;
            METRICS.timerStarts = 0;
            METRICS.timerCancelled = 0;
            METRICS.errors = 0;
        }
    } catch (e) {
        METRICS.errors++;
        log('[Zutrittskontrolle] Fehler bei der täglichen Prüfung: ' + e.message, 'error');
    }
});

// Trigger für die konfigurierten Datenpunkte
on({
    id: CONFIG.SOURCE_IDS,
    change: 'ne'
}, async function (obj) {
    if (isProcessing) {
        logDebug('Trigger ignoriert - bereits in Verarbeitung');
        return;
    }
    
    isProcessing = true;
    METRICS.triggers++;
    METRICS.lastTrigger = new Date().toISOString();
    
    // Zusätzliche Absicherung: Lock nach Zeit X zwingend aufheben, falls ein Fehler unbemerkt bleibt
    const processingTimeout = setTimeout(() => {
        if (isProcessing) {
            isProcessing = false;
            METRICS.errors++;
            logDebug('Processing lock automatisch zurückgesetzt (Timeout-Fallback).');
        }
    }, CONFIG.LOCK_TIMEOUT_MS);
    
    try {
        // Prüfen ob das Event überhaupt ausgelöst wurde und ob der neue Wert TRUE ist
        if (obj.state && obj.state.val === true) {
            logDebug('Trigger ausgelöst durch Taste: ' + obj.id);
            addHistory({ triggerId: obj.id, action: 'Zutritt gewährt' });
            await setTargetState(true);
            startTimer(TIMEOUT_MS);
        }
    } catch (e) {
        METRICS.errors++;
        log('[Zutrittskontrolle] Fehler in der Trigger-Verarbeitung: ' + e.message, 'error');
    } finally {
        clearTimeout(processingTimeout);
        isProcessing = false;
    }
});

// Bereinigung bei Script-Stop
onStop(function() {
    if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
        logDebug('Script gestoppt - Timer bereinigt.');
    }
}, CONFIG.STOP_TIMEOUT_MS);

})();