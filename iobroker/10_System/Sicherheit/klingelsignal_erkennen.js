/*******************************************************************************
 * Skriptname:   Klingelsignal & Sturm Protection
 * Beschreibung: Verarbeitet HmIP-Klingelsignal, steuert Türsummer bei 
 * gewährtem Zutritt und gibt Alexa-Sprachmeldung aus.
 * Autor:        Sanweb
 * * -----------------------------------------------------------------------------
 * Versionshistorie:
 * v1.2.1  | 05.03.2026 | Kommentare kompakt zusammengefasst
 * v1.2.0  | 05.03.2026 | Konfig in Objekt, Alexa-Timeout, Türsummer-Check
 * v1.1.0  | 05.03.2026 | Refactoring auf asynchrone API (*Async), Typsicherheit
 * v1.0.3  | 05.03.2026 | Datumsformat auf YYYY-MM-DD - HH:MM:SS
 * v1.0.0  | 04.03.2026 | Initiale Version
 *******************************************************************************/

(async () => {

// ==============================================================================
// KONFIGURATION: DATENPUNKTE (Bitte an eigene IDs anpassen)
// ==============================================================================

// Trigger: HmIP Klingelsensor (meist Kanal 1, 'PRESS_SHORT')
const DP_KLINGEL = 'hm-rpc.0.0026E0C998D1F2.1.PRESS_SHORT';

// Schalter: true = Tür öffnen, false = Alexa klingelt (Wird auto-erstellt)
const DP_ZUTRITTSKONTROLLE = '0_userdata.0.Haustuer.Zutrittskontrolle_Haustuer';

// Speicher: Letzter Klingelzeitpunkt für Cooldown (Wird auto-erstellt)
const DP_LAST_RING = '0_userdata.0.Haustuer.Klingel_LastRingTime';

// Aktor: Türsummer (Boolean, meist Kanal 3 oder 4, 'STATE')
const DP_TUERSUMMER = 'hm-rpc.0.00045A49A87CFF.3.STATE';

// Aktor: Alexa Sprachausgabe (.Commands.speak)
const DP_ALEXA_SPEAK = 'alexa2.0.Echo-Devices.e4a56dc3ec9a497c9209c05d2c29a09d.Commands.speak';

// ==============================================================================
// KONFIGURATION: PARAMETER
// ==============================================================================
const CONFIG = {
    alexa: {
        message: 'Ding Dong, es hat an der Haustür geklingelt!',
        startZeit: '11:00', // Aktiv ab (HH:MM)
        endZeit: '22:00',   // Aktiv bis (HH:MM)
        timeoutMs: 5000     // Timeout für API-Call
    },
    tuersummerDauerMs: 2000, // Anzugsdauer Summer in ms
    sturmProtectionMs: 30000, // Cooldown gegen Dauerklingeln in ms
    debug: false             // Debug-Logs im ioBroker
};

// Interne Variablen
let lastRingTime = 0; 
let timerTuersummer = null;

// ==============================================================================
// HILFSFUNKTIONEN
// ==============================================================================

// Erweitertes Debug-Logging
function logDebug(msg, data = null) {
    if (CONFIG.debug) {
        const context = data ? ` | Data: ${JSON.stringify(data)}` : '';
        log(`[DEBUG] ${msg}${context}`, 'debug');
    }
}

// Datum formatieren (YYYY-MM-DD - HH:MM:SS)
function formatDateTime(dateObj) {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())} - ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}:${pad(dateObj.getSeconds())}`;
}

// Prüfen, ob Zeit im konfigurierten Fenster liegt
function isTimeInRange(startTime, endTime) {
    const now = new Date();
    const startParts = startTime.split(':');
    const endParts = endTime.split(':');
    
    const startMins = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10);
    const endMins = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10);
    const currentMins = now.getHours() * 60 + now.getMinutes();
    
    return currentMins >= startMins && currentMins < endMins;
}

// Sicheres asynchrones Setzen von States inkl. Fehlerbehandlung
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
    // Validierung der Alexa-Zeiten
    const isValidTime = (time) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
    if (!isValidTime(CONFIG.alexa.startZeit) || !isValidTime(CONFIG.alexa.endZeit)) {
        log(`WARNUNG: Ungültiges Zeitformat bei Alexa-Zeiten. Verwende Standard 00:00-23:59`, 'warn');
        CONFIG.alexa.startZeit = '00:00';
        CONFIG.alexa.endZeit = '23:59';
    }

    // Datenpunkt: Zutrittskontrolle anlegen
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

    // Datenpunkt: Letzter Klingelzeitpunkt anlegen & auslesen
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
                const parsedDate = new Date(savedStr.replace(' - ', ' '));
                if (!isNaN(parsedDate.getTime())) {
                    lastRingTime = parsedDate.getTime();
                    logDebug(`Letzter Klingelzeitpunkt erfolgreich geladen`, { timestamp: lastRingTime });
                } else {
                    throw new Error('Date parsing resulted in NaN');
                }
            } else {
                lastRingTime = 0; // Fallback
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

on({id: DP_KLINGEL, val: true, ack: true}, async function (obj) {
    
    const now = obj.state.ts || Date.now();

    // 1. STURM PROTECTION (Cooldown prüfen)
    if ((now - lastRingTime) < CONFIG.sturmProtectionMs) {
        const remaining = Math.round((CONFIG.sturmProtectionMs - (now - lastRingTime)) / 1000);
        logDebug(`Klingel ignoriert (Sturm Protection aktiv, noch ${remaining}s).`);
        return;
    }

    // Cooldown-Timer aktualisieren & speichern
    lastRingTime = now;
    const formattedDate = formatDateTime(new Date(now));
    
    await safeSetStateAsync(DP_LAST_RING, formattedDate, true);
    log(`Klingelsignal erkannt um ${formattedDate}. Sturm Protection aktiviert.`, 'info');

    // 2. STATUS ZUTRITTSKONTROLLE
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
        // NORMALER ABLAUF (Alexa Sprachausgabe)
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
        // ZUTRITT GEWÄHRT (Türsummer aktivieren)
        log('Zutritt gewährt. Türsummer wird aktiviert.', 'info');
        
        if (await existsStateAsync(DP_TUERSUMMER)) {
            
            // Doppel-Auslösung verhindern
            const currentState = await getStateAsync(DP_TUERSUMMER);
            if (currentState?.val === true) {
                logDebug('Türsummer ist bereits aktiv, überspringe...');
                await safeSetStateAsync(DP_ZUTRITTSKONTROLLE, false, false);
                return;
            }

            // Summer ein
            await safeSetStateAsync(DP_TUERSUMMER, true, false);

            if (timerTuersummer) clearTimeout(timerTuersummer);
            
            // Summer aus & Reset nach Ablauf
            timerTuersummer = setTimeout(async () => {
                await safeSetStateAsync(DP_TUERSUMMER, false, false);
                timerTuersummer = null;
                
                await safeSetStateAsync(DP_ZUTRITTSKONTROLLE, false, false);
                logDebug('Zutrittskontrolle nach Türöffnung zurückgesetzt.');
            }, CONFIG.tuersummerDauerMs);
        } else {
            log(`Türsummer-Datenpunkt (${DP_TUERSUMMER}) fehlt! Zutrittskontrolle wird zurückgesetzt.`, 'error');
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
        
        // Notfall-Reset (synchron)
        if (existsState(DP_TUERSUMMER)) {
            setState(DP_TUERSUMMER, false, false);
            log('Türsummer wegen Skript-Stopp sicherheitshalber ausgeschaltet.', 'info');
        }
    }
});

})();