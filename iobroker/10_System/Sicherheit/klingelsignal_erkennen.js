/*******************************************************************************
 * Skriptname:   Klingelsignal & Sturm Protection
 * Beschreibung: Verarbeitet HmIP-Klingelsignal, steuert Türsummer bei 
 * gewährtem Zutritt und gibt Alexa-Sprachmeldung aus.
 * Autor:        Sanweb
 * * -----------------------------------------------------------------------------
 * Versionshistorie:
 * v1.3.1  | 25.04.2026 | Konfig-Felder umbenannt: startZeit/endZeit →
 *                       alexaAktivVon/alexaAktivBis (klarere Semantik)
 * v1.3.0  | 25.04.2026 | Race Condition Init behoben, robustes Date-Parsing
 *                       (Unix-Timestamp), onStop-Härtung, Mitternacht-Range,
 *                       Zeitbasis Date.now(), Bugfix Doppel-Auslösung
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
// HINWEIS: Ab v1.3.0 als Unix-Timestamp (number) gespeichert – siehe FIX 2.
const DP_LAST_RING = '0_userdata.0.Haustuer.Klingel_LastRingTime';

// Aktor: Türsummer (Boolean, meist Kanal 3 oder 4, 'STATE')
const DP_TUERSUMMER = 'hm-rpc.0.00045A49A87CFF.3.STATE';

// Aktor: Alexa Sprachausgabe (.Commands.speak)
const DP_ALEXA_SPEAK = 'alexa2.0.Echo-Devices.e4a56dc3ec9a497c9209c05d2c29a09d.Commands.speak';

// ==============================================================================
// KONFIGURATION: PARAMETER
// ==============================================================================
// Hinweis zur Semantik:
//   alexaAktivVon / alexaAktivBis definieren das Zeitfenster, in dem Alexa
//   bei einem Klingelsignal sprechen DARF. Außerhalb dieses Fensters bleibt
//   Alexa stumm (z.B. nachts). Mitternacht-übergreifende Fenster sind erlaubt
//   (z.B. alexaAktivVon: '22:00', alexaAktivBis: '06:00').
const CONFIG = {
    alexa: {
        message: 'Ding Dong, es hat an der Haustür geklingelt!',
        alexaAktivVon: '11:00',  // Alexa AN ab (HH:MM)
        alexaAktivBis: '22:00',  // Alexa AN bis (HH:MM) – außerhalb: stumm
        timeoutMs: 5000          // Timeout für API-Call
    },
    tuersummerDauerMs: 2000,   // Anzugsdauer Summer in ms
    sturmProtectionMs: 30000,  // Cooldown gegen Dauerklingeln in ms
    debug: false               // Debug-Logs im ioBroker
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

// Datum formatieren (YYYY-MM-DD - HH:MM:SS) – nur für Logging-Zwecke
function formatDateTime(dateObj) {
    const pad = (n) => n.toString().padStart(2, '0');
    return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())} - ${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}:${pad(dateObj.getSeconds())}`;
}

// Prüfen, ob aktuelle Zeit im konfigurierten Fenster liegt.
// Unterstützt auch Mitternacht-übergreifende Fenster (z.B. 22:00–06:00).
// Logik: Liegt Endzeit numerisch hinter Startzeit, ist es ein "normales" Fenster
// und wir prüfen [start, end). Liegt Endzeit <= Startzeit, handelt es sich um
// ein Fenster über Mitternacht – gültig ist dann [start, 24:00) ODER [00:00, end).
function isTimeInRange(startTime, endTime) {
    const now = new Date();
    const startParts = startTime.split(':');
    const endParts = endTime.split(':');
    
    const startMins = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10);
    const endMins = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10);
    const currentMins = now.getHours() * 60 + now.getMinutes();
    
    if (startMins === endMins) {
        // Entartetes Fenster: Start == Ende → niemals aktiv
        return false;
    }
    
    if (startMins < endMins) {
        // Normales Fenster (gleicher Tag)
        return currentMins >= startMins && currentMins < endMins;
    } else {
        // Mitternacht-übergreifendes Fenster
        return currentMins >= startMins || currentMins < endMins;
    }
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
// Initialisierung wird mit await ausgeführt, BEVOR on() registriert wird.
// Damit ist sichergestellt, dass lastRingTime und alle Datenpunkte beim ersten
// Klingelsignal bereits konsistent vorliegen (keine Race Condition).
await (async () => {
    // Validierung der Alexa-Zeiten
    const isValidTime = (time) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
    if (!isValidTime(CONFIG.alexa.alexaAktivVon) || !isValidTime(CONFIG.alexa.alexaAktivBis)) {
        log(`WARNUNG: Ungültiges Zeitformat bei Alexa-Zeiten. Verwende Standard 00:00-23:59`, 'warn');
        CONFIG.alexa.alexaAktivVon = '00:00';
        CONFIG.alexa.alexaAktivBis = '23:59';
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
    // Speicherung als Unix-Timestamp (number).
    // Begründung: Ein numerischer Timestamp ist eindeutig, zeitzonenunabhängig
    // und vermeidet das fehleranfällige Re-Parsing eines lokalisierten Strings
    // (das alte Format 'YYYY-MM-DD - HH:MM:SS' ist kein ISO-8601 und führte
    // in V8/Node zu "Invalid Date"). Der formatierte String dient nur noch
    // zum Logging. Beim erstmaligen Antreffen eines Alt-Strings wird dieser
    // toleriert (Migration: Wert wird ignoriert, lastRingTime = 0).
    if (!(await existsStateAsync(DP_LAST_RING))) {
        log(`Datenpunkt ${DP_LAST_RING} wird automatisch angelegt...`, 'info');
        await createStateAsync(DP_LAST_RING, 0, {
            name: 'Letzter Klingelzeitpunkt (Unix-Timestamp ms)',
            desc: 'Zeitstempel des letzten Klingelsignals als Unix-Timestamp in Millisekunden',
            type: 'number',
            role: 'date',
            read: true,
            write: true
        });
        lastRingTime = 0;
    } else {
        try {
            const stateLastRing = await getStateAsync(DP_LAST_RING);
            const savedVal = stateLastRing?.val;
            
            if (typeof savedVal === 'number' && Number.isFinite(savedVal) && savedVal >= 0) {
                // Neues Format: Unix-Timestamp direkt übernehmen
                lastRingTime = savedVal;
                logDebug(`Letzter Klingelzeitpunkt erfolgreich geladen (Timestamp)`, { timestamp: lastRingTime });
            } else {
                // Migration / Fallback: Alt-String oder ungültiger Wert → 0
                logDebug(`DP_LAST_RING enthält keinen gültigen Timestamp (Migration/Fallback).`, { rawValue: savedVal });
                lastRingTime = 0;
            }
        } catch (error) {
            log(`Fehler beim Lesen des letzten Klingelzeitpunkts, verwende 0. Detail: ${error}`, 'warn');
            lastRingTime = 0;
        }
    }
})();

// ==============================================================================
// HAUPTPROGRAMM (TRIGGER)
// ==============================================================================

on({id: DP_KLINGEL, val: true, ack: true}, async function (obj) {
    
    // Date.now() als primäre Zeitbasis (konsistent, unabhängig von Geräteuhr).
    // obj.state.ts wird nur für Diagnose-/Log-Zwecke beibehalten.
    const now = Date.now();
    const deviceTs = obj?.state?.ts;

    // 1. STURM PROTECTION (Cooldown prüfen)
    if ((now - lastRingTime) < CONFIG.sturmProtectionMs) {
        const remaining = Math.round((CONFIG.sturmProtectionMs - (now - lastRingTime)) / 1000);
        logDebug(`Klingel ignoriert (Sturm Protection aktiv, noch ${remaining}s).`, { deviceTs });
        return;
    }

    // Cooldown-Timer aktualisieren & speichern (als Unix-Timestamp)
    lastRingTime = now;
    const formattedDate = formatDateTime(new Date(now));
    
    await safeSetStateAsync(DP_LAST_RING, now, true);
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
        if (isTimeInRange(CONFIG.alexa.alexaAktivVon, CONFIG.alexa.alexaAktivBis)) {
            try {
                await Promise.race([
                    safeSetStateAsync(DP_ALEXA_SPEAK, CONFIG.alexa.message, false),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout nach ' + CONFIG.alexa.timeoutMs + 'ms')), CONFIG.alexa.timeoutMs))
                ]);
            } catch (error) {
                log(`Alexa nicht erreichbar oder Timeout: ${error.message}`, 'warn');
            }
        } else {
            logDebug(`Alexa stumm (außerhalb Zeitfenster: ${CONFIG.alexa.alexaAktivVon}-${CONFIG.alexa.alexaAktivBis}).`);
        }
    } else {
        // ZUTRITT GEWÄHRT (Türsummer aktivieren)
        log('Zutritt gewährt. Türsummer wird aktiviert.', 'info');
        
        if (await existsStateAsync(DP_TUERSUMMER)) {
            
            // Doppel-Auslösung verhindern
            // Kein redundanter Reset von DP_ZUTRITTSKONTROLLE hier –
            // der noch laufende Timer aus dem ersten Trigger erledigt das.
            const currentState = await getStateAsync(DP_TUERSUMMER);
            if (currentState?.val === true) {
                logDebug('Türsummer ist bereits aktiv, überspringe...');
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
// Türsummer wird IMMER geprüft und ggf. abgeschaltet, unabhängig davon,
// ob ein Timer aktiv ist. So wird ein evtl. nach einem vorherigen Absturz
// hängengebliebener Summer-State zuverlässig zurückgesetzt.
onStop(function () {
    // Timer (falls vorhanden) sauber abräumen
    if (timerTuersummer) {
        clearTimeout(timerTuersummer);
        timerTuersummer = null;
        log('Skript wird gestoppt. Bereinige Timer...', 'info');
    }

    // Türsummer immer prüfen und ggf. ausschalten – synchron, da onStop kurz ist.
    try {
        if (existsState(DP_TUERSUMMER)) {
            const summerState = getState(DP_TUERSUMMER);
            if (summerState && summerState.val === true) {
                setState(DP_TUERSUMMER, false, false);
                log('Türsummer wegen Skript-Stopp sicherheitshalber ausgeschaltet.', 'info');
            }
        }
    } catch (error) {
        log(`Fehler im onStop beim Zurücksetzen des Türsummers: ${error}`, 'error');
    }
});

})();