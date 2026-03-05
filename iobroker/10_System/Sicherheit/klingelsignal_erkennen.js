/*******************************************************************************
 * Skriptname:   Klingelsignal & Sturm Protection
 * Beschreibung: Verarbeitet das Klingelsignal (HmIP), steuert den Türsummer 
 * bei gewährtem Zutritt und gibt eine Alexa-Sprachmeldung aus.
 * Inklusive "Sturm Protection" (Cooldown) gegen Dauer-Klingeln.
 * Autor:        Sanweb
 * * -----------------------------------------------------------------------------
 * Versionshistorie:
 * v1.2.0  | 05.03.2026 | Konfiguration in Objekt ausgelagert,
 * | Timeout für Alexa hinzugefügt, doppelten Türsummer-Start verhindert.
 * v1.1.0  | 05.03.2026 | Komplettes Refactoring auf asynchrone API (*Async), 
 * | Try-Catch-Fehlerbehandlung, erweiterte Typsicherheit,
 * | Fallbacks für Uhrzeiten & parsen.
 * v1.0.3  | 05.03.2026 | Datumsformat auf YYYY-MM-DD - HH:MM:SS geändert
 * v1.0.2  | 05.03.2026 | Korrektur Datenpunkt Klingelsignal (PRESS_SHORT)
 * v1.0.1  | 04.03.2026 | Auto-Create für fehlende Datenpunkte hinzugefügt
 * v1.0.0  | 04.03.2026 | Initiale Version
 *******************************************************************************/

(async () => {

// ==============================================================================
// KONFIGURATION: DATENPUNKTE BITTE ANPASSEN
// ==============================================================================
const DP_KLINGEL = 'hm-rpc.0.0026E0C998D1F2.1.PRESS_SHORT';
const DP_ZUTRITTSKONTROLLE = '0_userdata.0.Haustuer.Zutrittskontrolle_Haustuer';
const DP_LAST_RING = '0_userdata.0.Haustuer.Klingel_LastRingTime';
const DP_TUERSUMMER = 'hm-rpc.0.00045A49A87CFF.3.STATE';
const DP_ALEXA_SPEAK = 'alexa2.0.Echo-Devices.e4a56dc3ec9a497c9209c05d2c29a09d.Commands.speak';

// ==============================================================================
// KONFIGURATION: VARIABLEN UND BEFEHLE
// ==============================================================================
const CONFIG = {
    alexa: {
        message: 'Ding Dong, es hat an der Haustür geklingelt!',
        startZeit: '11:00',
        endZeit: '22:00',
        timeoutMs: 5000
    },
    tuersummerDauerMs: 2000,
    sturmProtectionMs: 30000,
    debug: false
};

// Interne Variablen
let lastRingTime = 0; 
let timerTuersummer = null;

// ==============================================================================
// HILFSFUNKTIONEN
// ==============================================================================

// Erweitertes Debug-Logging mit optionalem Kontext (Vorschlag 6)
function logDebug(msg, data = null) {
    if (CONFIG.debug) {
        const context = data ? ` | Data: ${JSON.stringify(data)}` : '';
        log(`[DEBUG] ${msg}${context}`, 'debug');
    }
}

// Datum formatieren
function formatDateTime(dateObj) {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())} - ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}:${pad(dateObj.getSeconds())}`;
}

// Prüfen, ob Zeit im Fenster liegt
function isTimeInRange(startTime, endTime) {
    const now = new Date();
    const startParts = startTime.split(':');
    const endParts = endTime.split(':');
    
    const startMins = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10);
    const endMins = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10);
    const currentMins = now.getHours() * 60 + now.getMinutes();
    
    return currentMins >= startMins && currentMins < endMins;
}

// Sicheres asynchrones Setzen von States (Vorschlag 1, 2, 7)
async function safeSetStateAsync(id, val, ack = false) {
    try {
        if (await existsStateAsync(id)) {
            logDebug(`Setze Datenpunkt "${id}" auf Wert: ${val}`, { ack: ack });
            await setStateAsync(id, val, ack);
        } else {
            log(`Fehler: Datenpunkt "${id}" existiert nicht. Aktion abgebrochen.`, 'warn');
        }
    } catch (error) {
        log(`Ausnahmefehler beim Setzen von ${id}: ${error}`, 'error');
    }
}

// ==============================================================================
// INITIALISIERUNG
// ==============================================================================
(async () => {
    // Validierung der Alexa-Zeiten mit Fallback (Vorschlag 4)
    const isValidTime = (time) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
    if (!isValidTime(CONFIG.alexa.startZeit) || !isValidTime(CONFIG.alexa.endZeit)) {
        log(`WARNUNG: Ungültiges Zeitformat bei Alexa-Zeiten. Verwende Standard 00:00-23:59`, 'warn');
        CONFIG.alexa.startZeit = '00:00';
        CONFIG.alexa.endZeit = '23:59';
    }

    // Zutrittskontrolle anlegen
    if (!(await existsStateAsync(DP_ZUTRITTSKONTROLLE))) {
        log(`Datenpunkt ${DP_ZUTRITTSKONTROLLE} wird automatisch angelegt...`, 'info');
        await createStateAsync(DP_ZUTRITTSKONTROLLE, false, {
            name: 'Zutrittskontrolle Haustür',
            type: 'boolean',
            role: 'indicator',
            read: true,
            write: true
        });
    }

    // Letzter Klingelzeitpunkt anlegen/auslesen (Vorschlag 10)
    if (!(await existsStateAsync(DP_LAST_RING))) {
        log(`Datenpunkt ${DP_LAST_RING} wird automatisch angelegt...`, 'info');
        await createStateAsync(DP_LAST_RING, 'noch nie', {
            name: 'Letzter Klingelzeitpunkt',
            desc: 'Zeitstempel des letzten Klingelsignals (formatiert)',
            type: 'string',
            role: 'text',
            read: true,
            write: true
        });
        lastRingTime = 0;
    } else {
        try {
            const stateLastRing = await getStateAsync(DP_LAST_RING);
            const savedStr = stateLastRing?.val;
            
            if (typeof savedStr === 'string' && savedStr.includes(' - ')) {
                const parseable = savedStr.replace(' - ', ' ');
                const parsedDate = new Date(parseable);
                if (!isNaN(parsedDate.getTime())) {
                    lastRingTime = parsedDate.getTime();
                    logDebug(`Letzter Klingelzeitpunkt erfolgreich geladen`, { timestamp: lastRingTime });
                } else {
                    throw new Error('Date parsing resulted in NaN');
                }
            } else {
                lastRingTime = 0; // Fallback, falls String unerwartetes Format hat
            }
        } catch (error) {
            log(`Fehler beim Parsen des letzten Klingelzeitpunkts, verwende 0. Detail: ${error}`, 'warn');
            lastRingTime = 0;
        }
    }
})();

// ==============================================================================
// HAUPTPROGRAMM (TRIGGER)
// ==============================================================================

// Trigger ist nun asynchron, nutzt das obj-Objekt (Vorschlag 3)
on({id: DP_KLINGEL, val: true, ack: true}, async function (obj) {
    
    // Wir nehmen den exakten Zeitstempel des Events anstatt Date.now(), ist minimal präziser
    const now = obj.state.ts || Date.now();

    // 1. KLINGELSCHUTZ PRÜFEN
    if ((now - lastRingTime) < CONFIG.sturmProtectionMs) {
        const remaining = Math.round((CONFIG.sturmProtectionMs - (now - lastRingTime)) / 1000);
        logDebug(`Klingel ignoriert (Sturm Protection aktiv, noch ${remaining}s).`);
        return;
    }

    // Zeitstempel aktualisieren
    lastRingTime = now;
    const formattedDate = formatDateTime(new Date(now));
    
    // Status wegschreiben (ack = true, da Statusinformation)
    await safeSetStateAsync(DP_LAST_RING, formattedDate, true);
    log(`Klingelsignal erkannt um ${formattedDate}. Sturm Protection aktiviert.`, 'info');

    // 2. STATUS ZUTRITTSKONTROLLE ABRUFEN (Vorschlag 2 & 9)
    let zutrittGewaehrt = false;
    try {
        if (await existsStateAsync(DP_ZUTRITTSKONTROLLE)) {
            const stateValue = await getStateAsync(DP_ZUTRITTSKONTROLLE);
            zutrittGewaehrt = (stateValue?.val === true || stateValue?.val === 'true');
        }
    } catch (error) {
        log(`Fehler beim Lesen der Zutrittskontrolle: ${error}`, 'error');
    }

    // 3. AKTION AUSFÜHREN
    if (!zutrittGewaehrt) {
        // NORMALER ABLAUF
        if (isTimeInRange(CONFIG.alexa.startZeit, CONFIG.alexa.endZeit)) {
            try {
                await Promise.race([
                    safeSetStateAsync(DP_ALEXA_SPEAK, CONFIG.alexa.message, false),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout nach ' + CONFIG.alexa.timeoutMs + 'ms')), CONFIG.alexa.timeoutMs))
                ]);
            } catch (error) {
                log(`Alexa nicht erreichbar oder Timeout: ${error.message}`, 'warn');
            }
        } else {
            logDebug(`Alexa stumm (außerhalb Zeitfenster: ${CONFIG.alexa.startZeit}-${CONFIG.alexa.endZeit}).`);
        }
    } else {
        // ZUTRITT GEWÄHRT
        log('Zutritt gewährt. Türsummer wird aktiviert.', 'info');
        
        // Prüfen ob Datenpunkt existiert, bevor Timer-Logik startet (Vorschlag 5)
        if (await existsStateAsync(DP_TUERSUMMER)) {
            
            // Prüfen ob Türsummer bereits aktiv ist
            const currentState = await getStateAsync(DP_TUERSUMMER);
            if (currentState?.val === true) {
                logDebug('Türsummer ist bereits aktiv, überspringe erneute Aktivierung...');
                // Zutrittskontrolle zurücksetzen, da sie quasi "verbraucht" wurde
                await safeSetStateAsync(DP_ZUTRITTSKONTROLLE, false, false);
                return;
            }

            await safeSetStateAsync(DP_TUERSUMMER, true, false);

            // Verhindern mehrfacher Timer (Race Condition) (Vorschlag 8)
            if (timerTuersummer) clearTimeout(timerTuersummer);
            
            timerTuersummer = setTimeout(async () => {
                await safeSetStateAsync(DP_TUERSUMMER, false, false);
                timerTuersummer = null;
                
                // Zutrittskontrolle erst NACH erfolgreichem Öffnen zurücksetzen (Vorschlag 3)
                await safeSetStateAsync(DP_ZUTRITTSKONTROLLE, false, false);
                logDebug('Zutrittskontrolle nach Türöffnung zurückgesetzt.');
            }, CONFIG.tuersummerDauerMs);
        } else {
            log(`Türsummer-Datenpunkt (${DP_TUERSUMMER}) fehlt! Zutrittskontrolle wird sicherheitshalber zurückgesetzt.`, 'error');
            await safeSetStateAsync(DP_ZUTRITTSKONTROLLE, false, false);
        }
    }
});

// ==============================================================================
// SKRIPT STOPP BEHANDLUNG
// ==============================================================================
onStop(function () {
    if (timerTuersummer) {
        clearTimeout(timerTuersummer);
        timerTuersummer = null;
        log('Skript wird gestoppt. Bereinige Timer...', 'info');
        
        // Notfall-Reset: Hier nutzen wir synchrones setState, da asynchrone 
        // Aktionen beim Skript-Stop eventuell abgebrochen werden.
        if (existsState(DP_TUERSUMMER)) {
            setState(DP_TUERSUMMER, false, false);
            log('Türsummer wegen Skript-Stopp sicherheitshalber ausgeschaltet.', 'info');
        }
    }
});

})();