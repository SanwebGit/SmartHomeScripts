/***************************************************************************************
 * Script:       Zutrittskontrolle Haustür
 * Description:  Überwacht Homematic HmIP-WKP Keypad zur temporären Freigabe der Zutrittskontrolle.
 *               Setzt den Status für definierte Minuten auf TRUE, danach automatisch wieder auf FALSE.
 * Author:       Sanweb
 * Version:      2.0.2
 * Date:         2026-04-25
 *
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
    // SICHERHEIT & AUDIT (NEU in v2.0)
    // ---------------------------------------------------------------------

    // AUDIT-LOG-DATENPUNKT (String, JSON-Array)
    // Datenpunkt für das persistente Audit-Log. Jede Türöffnung (Trigger) wird hier
    // als JSON-Eintrag protokolliert. Maximal 100 Einträge, älteste werden rotiert.
    // Wird beim Script-Start automatisch angelegt, falls nicht vorhanden.
    AUDIT_LOG_ID: '0_userdata.0.Haustuer.Audit_Log',

    // MAXIMALE ANZAHL EINTRÄGE im Audit-Log (Rotation)
    AUDIT_LOG_MAX_ENTRIES: 100,

    // ZEITFENSTER FÜR ZUTRITT (optional)
    // Wenn gesetzt, werden Trigger außerhalb dieses Fensters abgelehnt.
    // Format: { from: 6, to: 23 }  -> 06:00 bis 22:59 erlaubt (to ist exklusiv).
    // Über-Mitternacht-Fenster werden unterstützt: { from: 22, to: 6 } -> 22:00 bis 05:59.
    // Auf null setzen, um die Prüfung komplett zu deaktivieren.
    // HINWEIS: Die Prüfung verwendet die LOKALE Systemzeit des ioBroker-Hosts.
    // Stelle sicher, dass die Zeitzone des Hosts korrekt konfiguriert ist
    // (z.B. Europe/Berlin auf Raspberry Pi via `sudo raspi-config` oder im Docker-Container via TZ-Variable).
    ALLOWED_HOURS: null,

    // VERIFIKATIONS-DELAY (in Millisekunden)
    // Zeit, die nach setStateAsync gewartet wird, bevor der State erneut ausgelesen
    // und mit dem Soll-Wert verglichen wird (Read-Back-Verifikation).
    VERIFY_DELAY_MS: 200,

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
    // HINWEIS: Die Payload-Struktur ist auf Telegram zugeschnitten ({ text: '...' }).
    // Pushover erwartet stattdessen { message: '...' }, E-Mail-Adapter ggf. { to, subject, text }.
    // Bei Verwendung anderer Adapter ggf. die notifyAdmin()-Funktion entsprechend anpassen.
    NOTIFICATION_INSTANCE: '',

    // BENACHRICHTIGUNGS-THROTTLING (in Millisekunden)
    // Identische Nachrichten werden innerhalb dieses Zeitfensters nicht erneut gesendet.
    // Verhindert Notification-Floods bei wiederholten Fehlern.
    // Auf 0 setzen, um Throttling komplett zu deaktivieren.
    NOTIFICATION_THROTTLE_MS: 60000,

    // DEBUG-MODUS (true / false)
    // Wenn "true", schreibt das Script detaillierte Infos ins ioBroker-Log (gut zur Einrichtung).
    // Wenn "false", werden nur echte Fehler ins Log geschrieben (empfohlen für den Dauerbetrieb).
    DEBUG_MODE: true
};

const TIMEOUT_MS = CONFIG.TIMEOUT_MINUTES * 60 * 1000;
let timeoutTimer = null;
let isProcessing = false; // Lock-Variable zur Vermeidung von Mehrfachausführungen
let targetExists = false; // Caching für die Existenz des Ziel-Datenpunktes
let auditLog = [];        // In-Memory-Spiegel des Audit-Logs (wird beim Init aus DP geladen)

// Tagesmetriken — werden im täglichen Report zurückgesetzt
const dailyMetrics = {
    triggers: 0,
    timerStarts: 0,
    timerCancelled: 0,
    errors: 0,
    rejectedByTimeWindow: 0,
    verifyFailures: 0
};

// Kumulative Metriken — bleiben über die gesamte Script-Laufzeit erhalten
const cumulativeMetrics = {
    triggers: 0,
    errors: 0,
    verifyFailures: 0,
    rejectedByTimeWindow: 0,
    lastTrigger: null,
    startedAt: new Date().toISOString()
};

// In-Memory-Tracking der zuletzt gesendeten Benachrichtigungen für das Throttling.
// Key: erste 80 Zeichen der Nachricht (Gruppierung ähnlicher Meldungen).
// Value: Timestamp der letzten Sendung in ms (Date.now()).
const lastNotificationTime = {};

// Hilfsfunktion für Benachrichtigungen bei kritischen Fehlern.
// Throttling: Identische (bzw. in den ersten 80 Zeichen identische) Nachrichten werden
// innerhalb von CONFIG.NOTIFICATION_THROTTLE_MS nicht erneut gesendet, um Floods zu vermeiden.
function notifyAdmin(message) {
    if (!CONFIG.NOTIFICATION_INSTANCE) {
        return;
    }

    // Throttling-Prüfung
    if (CONFIG.NOTIFICATION_THROTTLE_MS > 0) {
        const now = Date.now();
        const key = String(message).substring(0, 80);
        const lastSent = lastNotificationTime[key];
        if (lastSent && (now - lastSent) < CONFIG.NOTIFICATION_THROTTLE_MS) {
            logDebug('Benachrichtigung unterdrückt (Throttling): ' + key);
            return;
        }
        lastNotificationTime[key] = now;

        // Speicher-Hygiene: alte Einträge aus dem Throttle-Cache entfernen,
        // damit der In-Memory-Buffer nicht unkontrolliert wächst.
        for (const k of Object.keys(lastNotificationTime)) {
            if ((now - lastNotificationTime[k]) > (CONFIG.NOTIFICATION_THROTTLE_MS * 10)) {
                delete lastNotificationTime[k];
            }
        }
    }

    try {
        sendTo(CONFIG.NOTIFICATION_INSTANCE, 'send', {
            text: `🚨 [Zutrittskontrolle] ${message}`
        });
        logDebug(`Benachrichtigung über ${CONFIG.NOTIFICATION_INSTANCE} gesendet.`);
    } catch (e) {
        log(`[Zutrittskontrolle] Fehler beim Senden der Benachrichtigung: ${e.message}`, 'error');
    }
}

// Hilfsfunktion für optionales Debug-Logging
function logDebug(message) {
    if (CONFIG.DEBUG_MODE) {
        log('[Zutrittskontrolle] ' + message, 'info');
    }
}

// =========================================================================
// AUDIT-LOG (NEU in v2.0)
// =========================================================================

/**
 * Stellt sicher, dass der Audit-Log-Datenpunkt existiert. Legt ihn an, falls nicht vorhanden.
 * Lädt anschließend bestehende Einträge in den In-Memory-Buffer (neustart-sicher).
 */
async function initAuditLog() {
    try {
        const exists = await existsStateAsync(CONFIG.AUDIT_LOG_ID);
        if (!exists) {
            // Datenpunkt anlegen — ioBroker createState() ist die übliche Variante.
            await createStateAsync(CONFIG.AUDIT_LOG_ID, '[]', {
                name: 'Zutrittskontrolle Audit-Log',
                type: 'string',
                role: 'json',
                read: true,
                write: false,
                desc: 'Persistentes Audit-Log der Zutrittsfreigaben (JSON-Array, max. ' + CONFIG.AUDIT_LOG_MAX_ENTRIES + ' Einträge)'
            });
            auditLog = [];
            logDebug('Audit-Log-Datenpunkt neu angelegt: ' + CONFIG.AUDIT_LOG_ID);
            return;
        }

        // Bestehenden Inhalt laden und parsen
        const state = await getStateAsync(CONFIG.AUDIT_LOG_ID);
        if (state && typeof state.val === 'string' && state.val.length > 0) {
            try {
                const parsed = JSON.parse(state.val);
                if (Array.isArray(parsed)) {
                    auditLog = parsed;
                    logDebug('Audit-Log geladen: ' + auditLog.length + ' bestehende Einträge.');
                } else {
                    log('[Zutrittskontrolle] Warnung: Audit-Log-Inhalt ist kein Array, starte mit leerem Log.', 'warn');
                    auditLog = [];
                }
            } catch (parseErr) {
                log('[Zutrittskontrolle] Warnung: Audit-Log konnte nicht geparst werden (' + parseErr.message + '), starte mit leerem Log.', 'warn');
                auditLog = [];
            }
        } else {
            auditLog = [];
        }
    } catch (e) {
        log('[Zutrittskontrolle] Fehler bei der Initialisierung des Audit-Logs: ' + e.message, 'error');
        auditLog = [];
    }
}

/**
 * Hängt einen Eintrag an das Audit-Log an, rotiert bei Überschreitung der Maximalgröße,
 * und persistiert das Log sofort in den ioBroker-Datenpunkt.
 */
async function appendAuditEntry(entry) {
    const enrichedEntry = {
        timestamp: new Date().toISOString(),
        ...entry
    };
    auditLog.push(enrichedEntry);

    // Rotation: alte Einträge entfernen, falls Maximalanzahl überschritten
    if (auditLog.length > CONFIG.AUDIT_LOG_MAX_ENTRIES) {
        auditLog = auditLog.slice(-CONFIG.AUDIT_LOG_MAX_ENTRIES);
    }

    // Sofort persistieren — sicherheitsrelevant, kein Verlust bei Stromausfall
    try {
        await setStateAsync(CONFIG.AUDIT_LOG_ID, JSON.stringify(auditLog), true);
    } catch (e) {
        dailyMetrics.errors++;
        cumulativeMetrics.errors++;
        log('[Zutrittskontrolle] Fehler beim Schreiben des Audit-Logs: ' + e.message, 'error');
    }
}

// =========================================================================
// ZEITFENSTER-PRÜFUNG (NEU in v2.0)
// =========================================================================

/**
 * Prüft, ob die aktuelle Stunde innerhalb des erlaubten Zeitfensters liegt.
 * Unterstützt sowohl reguläre Fenster (from < to) als auch über-Mitternacht-Fenster (from > to).
 * Gibt true zurück, wenn ALLOWED_HOURS deaktiviert (null) ist.
 *
 * Konvention: from inklusiv, to exklusiv. { from: 6, to: 23 } => 06:00:00 bis 22:59:59 erlaubt.
 *
 * HINWEIS: Verwendet new Date().getHours() — also die LOKALE Systemzeit des ioBroker-Hosts.
 * Falsche Zeitzone führt zu verschobenem Fenster.
 */
function isWithinAllowedHours() {
    if (!CONFIG.ALLOWED_HOURS) {
        return true; // Deaktiviert: alles erlaubt
    }

    const { from, to } = CONFIG.ALLOWED_HOURS;

    // Validierung der Konfiguration
    if (typeof from !== 'number' || typeof to !== 'number' ||
        from < 0 || from > 23 || to < 0 || to > 24) {
        log('[Zutrittskontrolle] Warnung: ALLOWED_HOURS hat ungültige Werte. Prüfung übersprungen.', 'warn');
        return true;
    }

    const currentHour = new Date().getHours();

    if (from < to) {
        // Reguläres Fenster, z.B. 6–23
        return currentHour >= from && currentHour < to;
    } else if (from > to) {
        // Über-Mitternacht-Fenster, z.B. 22–6 (22:00–05:59)
        return currentHour >= from || currentHour < to;
    } else {
        // from === to: kein Fenster definiert, alles ablehnen wäre absurd → erlauben
        return true;
    }
}

// =========================================================================
// STATE-MANAGEMENT
// =========================================================================

/**
 * Setzt den Ziel-Datenpunkt mit anschließender Read-Back-Verifikation.
 * Bei Abweichung zwischen Soll- und Ist-Wert wird ein Fehler geloggt und der Admin benachrichtigt.
 */
async function setTargetState(value) {
    if (typeof value !== 'boolean') {
        dailyMetrics.errors++;
        cumulativeMetrics.errors++;
        log('[Zutrittskontrolle] Fehler: Nur boolean-Werte erlaubt', 'error');
        return;
    }

    if (!targetExists) {
        dailyMetrics.errors++;
        cumulativeMetrics.errors++;
        log('[Zutrittskontrolle] Fehler: Ziel-Datenpunkt existiert nicht!', 'warn');
        return;
    }

    try {
        await setStateAsync(CONFIG.TARGET_ID, value, true);
        logDebug('Ziel-Datenpunkt auf ' + value + ' gesetzt.');

        // Read-Back-Verifikation (nicht-blockierend für den Aufrufer wäre ein fire-and-forget,
        // hier aber awaited damit Audit-Log-Reihenfolge konsistent ist und Fehler sofort sichtbar werden).
        await verifyTargetState(value);
    } catch (e) {
        dailyMetrics.errors++;
        cumulativeMetrics.errors++;
        log('[Zutrittskontrolle] Fehler beim Setzen des Datenpunktes: ' + e.message, 'error');
    }
}

/**
 * Verifiziert nach einem kurzen Delay (CONFIG.VERIFY_DELAY_MS), ob der Ziel-Datenpunkt
 * tatsächlich den erwarteten Wert hat. Bei Abweichung: Error-Log + Admin-Benachrichtigung.
 * Es wird KEIN automatischer Retry durchgeführt (Sicherheitsfunktion — autonomes Wiederholen
 * könnte unerwünschte Effekte haben).
 */
async function verifyTargetState(expectedValue) {
    return new Promise((resolve) => {
        setTimeout(async () => {
            try {
                const state = await getStateAsync(CONFIG.TARGET_ID);
                if (!state) {
                    dailyMetrics.verifyFailures++;
                    cumulativeMetrics.verifyFailures++;
                    const msg = `Verifikation fehlgeschlagen: Datenpunkt ${CONFIG.TARGET_ID} liefert keinen State zurück.`;
                    log('[Zutrittskontrolle] ' + msg, 'error');
                    notifyAdmin(msg);
                } else if (state.val !== expectedValue) {
                    dailyMetrics.verifyFailures++;
                    cumulativeMetrics.verifyFailures++;
                    const msg = `Verifikation fehlgeschlagen: Soll=${expectedValue}, Ist=${state.val}.`;
                    log('[Zutrittskontrolle] ' + msg, 'error');
                    notifyAdmin(msg);
                } else {
                    logDebug('Verifikation OK: State=' + state.val);
                }
            } catch (e) {
                dailyMetrics.errors++;
                cumulativeMetrics.errors++;
                log('[Zutrittskontrolle] Fehler bei der State-Verifikation: ' + e.message, 'error');
            } finally {
                resolve();
            }
        }, CONFIG.VERIFY_DELAY_MS);
    });
}

// =========================================================================
// TIMER-MANAGEMENT
// =========================================================================

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
        dailyMetrics.timerCancelled++;
        logDebug('Vorheriger Timer gelöscht (Vermeidung von Race Conditions).');
    }

    dailyMetrics.timerStarts++;
    logDebug('Starte Timer für ' + Math.round(duration / 1000) + ' Sekunden.');
    timeoutTimer = setTimeout(async function () {
        try {
            logDebug('Timer abgelaufen. Setze Zutrittskontrolle zurück.');
            await setTargetState(false);
        } catch (e) {
            dailyMetrics.errors++;
            cumulativeMetrics.errors++;
            log('[Zutrittskontrolle] Fehler im Timer-Callback: ' + e.message, 'error');
        } finally {
            timeoutTimer = null;
        }
    }, duration);
}

/**
 * Script-Neustart abfangen: Prüfen ob ein Timer reaktiviert werden muss.
 *
 * Annahmen / Garantien:
 *  - Diese Funktion läuft genau einmal beim Script-Start, BEVOR der on(...)-Trigger-Handler
 *    registriert ist. In diesem schmalen Zeitfenster (typisch < 100 ms) kann das Skript
 *    selbst den State nicht verändern.
 *  - Single-Writer-Annahme: Der TARGET_ID-Datenpunkt wird ausschließlich von diesem Skript
 *    geschrieben. Externe Schreiber (andere Skripte, Visualisierungen) sind nicht vorgesehen.
 *  - Sollte trotzdem ein externer Schreiber zwischen dem Lesen und dem Timer-Start aktiv
 *    werden, ist der Worst Case eine zu lange/zu kurze Reaktivierung — kein Sicherheitsproblem,
 *    weil der nächste Trigger die Logik neu anstößt und der Timer den State spätestens nach
 *    TIMEOUT_MS auf false setzt.
 *  - Ein zusätzlicher Re-Read würde diese theoretische Race nicht sauber schließen
 *    (false→true zwischen den Reads bliebe offen) und nur zusätzlichen I/O verursachen.
 */
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
            logDebug('Script-Neustart erkannt: Datenpunkt war TRUE, aber die Zeit ist abgelaufen. Setze zurück auf FALSE.');
            await setTargetState(false);
        }
    }
}

// =========================================================================
// VALIDIERUNG & INITIALISIERUNG
// =========================================================================

// Konfigurations-Validierung beim Script-Start
function validateConfig() {
    if (!CONFIG.TARGET_ID || !CONFIG.SOURCE_IDS || CONFIG.SOURCE_IDS.length === 0) {
        throw new Error('Ungültige Konfiguration: TARGET_ID oder SOURCE_IDS fehlen.');
    }
    if (!CONFIG.AUDIT_LOG_ID) {
        throw new Error('Ungültige Konfiguration: AUDIT_LOG_ID fehlt.');
    }
    if (CONFIG.TIMEOUT_MINUTES <= 0) {
        log('[Zutrittskontrolle] Warnung: TIMEOUT_MINUTES sollte größer als 0 sein.', 'warn');
    }
    if (CONFIG.AUDIT_LOG_MAX_ENTRIES <= 0) {
        log('[Zutrittskontrolle] Warnung: AUDIT_LOG_MAX_ENTRIES sollte größer als 0 sein.', 'warn');
    }
    // Plausibilität: Der Spam-Schutz sollte deutlich kürzer sein als die Türfreigabe-Zeit,
    // damit nach Ablauf der Freigabe wieder neue Trigger akzeptiert werden können.
    if (CONFIG.LOCK_TIMEOUT_MS >= TIMEOUT_MS) {
        log(
            '[Zutrittskontrolle] Warnung: LOCK_TIMEOUT_MS (' + CONFIG.LOCK_TIMEOUT_MS + ' ms) ' +
            'sollte kleiner sein als TIMEOUT_MS (' + TIMEOUT_MS + ' ms). ' +
            'Aktuell könnte ein neuer Trigger erst nach Ablauf der Türfreigabe wieder akzeptiert werden.',
            'warn'
        );
    }
}

// Prüft asynchron, ob die Quell-Datenpunkte existieren
async function validateSourceIds() {
    let allOk = true;
    for (const id of CONFIG.SOURCE_IDS) {
        try {
            const exists = await existsStateAsync(id);
            if (!exists) {
                log('[Zutrittskontrolle] Warnung: Quell-Datenpunkt ' + id + ' existiert nicht!', 'warn');
                allOk = false;
            }
        } catch (e) {
            log('[Zutrittskontrolle] Fehler bei der Prüfung von ' + id + ': ' + e.message, 'error');
            allOk = false;
        }
    }
    return allOk;
}

// Initiale Überprüfung beim Script-Start (mit asynchronem Check des Datenpunktes)
async function init() {
    try {
        validateConfig();
        await validateSourceIds();
        await initAuditLog();

        targetExists = await existsStateAsync(CONFIG.TARGET_ID);
        if (!targetExists) {
            log('[Zutrittskontrolle] Warnung: Ziel-Datenpunkt fehlt. Bitte anlegen.', 'warn');
        } else {
            await checkInitialState();
        }

        if (CONFIG.ALLOWED_HOURS) {
            logDebug('Zeitfenster aktiv: ' + CONFIG.ALLOWED_HOURS.from + ':00–' + CONFIG.ALLOWED_HOURS.to + ':00');
        }

        logDebug('Initialisierung abgeschlossen (v2.0.2).');
    } catch (e) {
        log('[Zutrittskontrolle] Fehler bei der Initialisierung: ' + e.message, 'error');
    }
}

// Initialisierung starten
init();

// =========================================================================
// TÄGLICHER CHECK & METRIK-REPORT
// =========================================================================

schedule(CONFIG.DAILY_CHECK_CRON, async () => {
    try {
        // Ziel-Datenpunkt prüfen
        targetExists = await existsStateAsync(CONFIG.TARGET_ID);
        if (!targetExists) {
            dailyMetrics.errors++;
            cumulativeMetrics.errors++;
            const errorMsg = 'Ziel-Datenpunkt wurde gelöscht oder ist nicht mehr erreichbar!';
            log(`[Zutrittskontrolle] Fehler: ${errorMsg}`, 'error');
            notifyAdmin(errorMsg);
        }

        // Audit-Log-Datenpunkt prüfen (kann auch versehentlich gelöscht worden sein)
        const auditExists = await existsStateAsync(CONFIG.AUDIT_LOG_ID);
        if (!auditExists) {
            dailyMetrics.errors++;
            cumulativeMetrics.errors++;
            const msg = 'Audit-Log-Datenpunkt wurde gelöscht — wird neu angelegt.';
            log('[Zutrittskontrolle] Warnung: ' + msg, 'warn');
            notifyAdmin(msg);
            await initAuditLog();
        }

        // Quell-Datenpunkte erneut validieren (P2.8)
        await validateSourceIds();

        // Tagesreport ausgeben
        log(
            `[Zutrittskontrolle] Tagesreport — ` +
            `Triggers: ${dailyMetrics.triggers}, ` +
            `Timer Starts: ${dailyMetrics.timerStarts}, ` +
            `Abbrüche: ${dailyMetrics.timerCancelled}, ` +
            `Abgelehnt (Zeitfenster): ${dailyMetrics.rejectedByTimeWindow}, ` +
            `Verify-Fehler: ${dailyMetrics.verifyFailures}, ` +
            `Fehler heute: ${dailyMetrics.errors} | ` +
            `Kumulativ — Triggers: ${cumulativeMetrics.triggers}, ` +
            `Fehler: ${cumulativeMetrics.errors}, ` +
            `Verify-Fehler: ${cumulativeMetrics.verifyFailures}, ` +
            `Letzter Trigger: ${cumulativeMetrics.lastTrigger || 'keiner'}`,
            'info'
        );

        // Audit-Log-Auszug der letzten 5 Einträge ins Log
        const recentEntries = auditLog.slice(-5);
        if (recentEntries.length > 0) {
            logDebug('Audit-Log (letzte ' + recentEntries.length + ' Einträge): ' + JSON.stringify(recentEntries));
        }

        // Tagesmetriken zurücksetzen — kumulative Metriken bleiben erhalten (P1.5)
        dailyMetrics.triggers = 0;
        dailyMetrics.timerStarts = 0;
        dailyMetrics.timerCancelled = 0;
        dailyMetrics.errors = 0;
        dailyMetrics.rejectedByTimeWindow = 0;
        dailyMetrics.verifyFailures = 0;
    } catch (e) {
        dailyMetrics.errors++;
        cumulativeMetrics.errors++;
        log('[Zutrittskontrolle] Fehler bei der täglichen Prüfung: ' + e.message, 'error');
    }
});

// =========================================================================
// TRIGGER-HANDLER
// =========================================================================

// Trigger für die konfigurierten Datenpunkte.
// Filter-Strategie: `change: 'ne'` (Wert hat sich geändert) kombiniert mit `val: true`
// (neuer Wert ist true) — der Handler wird damit nur bei einer echten true-Flanke aufgerufen.
// Das ersetzt die zusätzliche `obj.state.val === true`-Prüfung im Handler aus v1.x.
on({
    id: CONFIG.SOURCE_IDS,
    val: true,
    change: 'ne'
}, async function (obj) {
    if (isProcessing) {
        logDebug('Trigger ignoriert - Spam-Schutz aktiv');
        return;
    }

    // Lock STARR für LOCK_TIMEOUT_MS halten (v2.0.1 Bugfix).
    // Vorher wurde der Lock im finally-Block sofort nach Verarbeitungsende (~250 ms)
    // freigegeben, wodurch der konfigurierte Spam-Schutz (5 s) effektiv wirkungslos war.
    // Der Lock wird jetzt unabhängig von der Verarbeitungsdauer erst nach LOCK_TIMEOUT_MS
    // freigegeben. Der separate Watchdog-Timeout entfällt damit (Doppelfunktion).
    isProcessing = true;
    setTimeout(() => {
        isProcessing = false;
        logDebug('Spam-Schutz aufgehoben. Bereit für neue Trigger.');
    }, CONFIG.LOCK_TIMEOUT_MS);

    dailyMetrics.triggers++;
    cumulativeMetrics.triggers++;
    cumulativeMetrics.lastTrigger = new Date().toISOString();

    try {
        // Zeitfenster-Schutz (P0.3): Trigger außerhalb des Fensters ablehnen
        if (!isWithinAllowedHours()) {
            dailyMetrics.rejectedByTimeWindow++;
            cumulativeMetrics.rejectedByTimeWindow++;
            const msg = 'Trigger abgelehnt (außerhalb erlaubtes Zeitfenster): ' + obj.id;
            log('[Zutrittskontrolle] Warnung: ' + msg, 'warn');
            await appendAuditEntry({
                triggerId: obj.id,
                action: 'Trigger abgelehnt',
                reason: 'außerhalb Zeitfenster'
            });
            notifyAdmin(msg);
            return;
        }

        logDebug('Trigger ausgelöst durch Taste: ' + obj.id);
        await appendAuditEntry({
            triggerId: obj.id,
            action: 'Zutritt gewährt'
        });
        await setTargetState(true);
        startTimer(TIMEOUT_MS);
    } catch (e) {
        dailyMetrics.errors++;
        cumulativeMetrics.errors++;
        log('[Zutrittskontrolle] Fehler in der Trigger-Verarbeitung: ' + e.message, 'error');
    }
    // Hinweis: Der Lock (isProcessing) wird bewusst NICHT in einem finally-Block
    // freigegeben — siehe setTimeout oben für die starre Freigabe nach LOCK_TIMEOUT_MS.
});

// =========================================================================
// CLEANUP
// =========================================================================

// Bereinigung bei Script-Stop (Logik unverändert ggü. v1.6.2)
onStop(function() {
    if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
        logDebug('Script gestoppt - Timer bereinigt.');
    }
}, CONFIG.STOP_TIMEOUT_MS);

})();