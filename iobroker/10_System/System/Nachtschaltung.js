/**
 * @file        Intelligente & träge Anwesenheitserkennung im Bett (ioBroker)
 * @version     3.0 FINAL
 * @author      Ihr Name
 * @license     MIT
 * @description
 * Dieses Skript realisiert eine träge und intelligente Nachtschaltung. Es ist die
 * stabile und erweiterte ioBroker-Umsetzung der Logik aus dem Homematic-Forum.
 *
 * FUNKTIONSWEISE:
 * 1.  Träge Anwesenheitserkennung: Ein kurzes Aufstehen (z.B. für ein Glas Wasser) wird
 * ignoriert. Der Status wird erst nach einer saisonal angepassten Verzögerung auf
 * "frei" gesetzt.
 * 2.  Aktivierung bei zwei Personen: Die Nachtschaltung wird SOFORT aktiv, wenn beide
 * Personen bei Nacht im Bett sind.
 * 3.  Aktivierung bei einer Person: Geht nur eine Person bei Nacht ins Bett, startet ein
 * 30-Minuten-Timer. Die Nachtschaltung wird erst nach Ablauf aktiv. Kommt die
 * zweite Person hinzu, wird der Timer abgebrochen und die Schaltung sofort aktiviert.
 * 4.  Master-Reset durch Abwesenheit: Wenn niemand im Haus anwesend ist, werden alle
 * Timer sofort gestoppt und die Nachtschaltung deaktiviert, um Fehlzustände zu verhindern.
 *
 * @changelog
 * V3.0 (Final):
 * - Kommentare umfassend überarbeitet und ergänzt für maximale Verständlichkeit.
 * - Code-Struktur durch Hilfsfunktionen für Timer und Zustandsänderungen optimiert.
 * - Redundante Code-Teile entfernt und Logik für Klarheit neu geordnet.
 * - Visuelle Gliederung des Skripts für bessere Lesbarkeit verbessert.
 */

// ======================================================================================
// │ KONFIGURATION                                                                      │
// └────────────────────────────────────────────────────────────────────────────────────┘

// --- 1. DATENPUNKTE DER SENSOREN ---
// IDs der STATE-Datenpunkte Ihrer Bett-Sensoren (z.B. Homematic Tür-/Fensterkontakte).
// Annahme: false = belegt (Kontakt geschlossen), true = frei (Kontakt offen).
const SENSOR_LINKS_DP  = 'hm-rpc.0.001E1D899E94B0.1.STATE';
const SENSOR_RECHTS_DP = 'hm-rpc.0.001E1D899E922D.1.STATE';

// --- 2. ZIEL-DATENPUNKTE IN IO-BROKER ---
// IDs der Zieldatenpunkte, die das Skript steuert.
// Werden bei Bedarf automatisch unter '0_userdata.0' angelegt.
const STATUS_LINKS_VAR  = '0_userdata.0.System.Nachtschaltung.BettLinks';
const STATUS_RECHTS_VAR = '0_userdata.0.System.Nachtschaltung.BettRechts';
const AKTIV_VAR         = '0_userdata.0.System.Nachtschaltung.Aktiv';

// --- 3. STEUERNDE DATENPUNKTE ---
// ID des Datenpunkts, der Tag (true) oder Nacht (false) signalisiert.
const TAG_NACHT_VAR     = '0_userdata.0.System.Astro.Tag';
// ID des Datenpunkts für die globale Anwesenheit im Haus.
const ANWESENHEIT_VAR   = '0_userdata.0.Anwesenheit.Status'; // true = anwesend, false = abwesend

// --- 4. VERZÖGERUNGSZEITEN IN MINUTEN ---
const DELAY_MINUTEN_SOMMER = 3;  // Verzögerung für das Verlassen des Bettes (Juni - Sep)
const DELAY_MINUTEN_WINTER = 4;  // Verzögerung für das Verlassen des Bettes (Okt - Mai)
const DELAY_MINUTEN_EINZEL = 30; // Verzögerung, bis die Schaltung für nur eine Person aktiv wird.

// --- 5. DEBUG-MODUS ---
// Bei 'true' werden detaillierte Log-Ausgaben erzeugt.
const DEBUG = true;


// ======================================================================================
// │ GLOBALE VARIABLEN & ZUSTÄNDE                                                       │
// └────────────────────────────────────────────────────────────────────────────────────┘

const LOG_PREFIX = '[NACHTSCHALTUNG] '; // Prefix für alle Log-Ausgaben.

let timerLinks = null;  // Hält die Timer-ID für die linke Bettseite.
let timerRechts = null; // Hält die Timer-ID für die rechte Bettseite.
let einzelTimer = null; // Hält die Timer-ID für die Einzelbelegungs-Logik.


// ======================================================================================
// │ HILFSFUNKTIONEN                                                                    │
// └────────────────────────────────────────────────────────────────────────────────────┘

/**
 * Setzt einen Datenpunkt nur dann, wenn sich der Wert geändert hat, und loggt die Aktion.
 * @param {string} id - Die ID des Datenpunkts.
 * @param {boolean | number | string} value - Der zu setzende Wert.
 */
async function setStateChangedAndLog(id, value) {
    if ((await getStateAsync(id)).val !== value) {
        if (DEBUG) log(`${LOG_PREFIX}AKTION: Setze '${id}' auf '${value}'.`);
        await setStateAsync(id, value, true);
    }
}

/**
 * Stoppt und löscht alle laufenden Timer im Skript.
 * Nützlich als zentraler Reset-Mechanismus.
 */
function clearAllTimers() {
    if (timerLinks) {
        clearTimeout(timerLinks);
        timerLinks = null;
        if (DEBUG) log(`${LOG_PREFIX}TIMER-STOP: Abwesenheits-Timer (Links) abgebrochen.`);
    }
    if (timerRechts) {
        clearTimeout(timerRechts);
        timerRechts = null;
        if (DEBUG) log(`${LOG_PREFIX}TIMER-STOP: Abwesenheits-Timer (Rechts) abgebrochen.`);
    }
    if (einzelTimer) {
        clearTimeout(einzelTimer);
        einzelTimer = null;
        if (DEBUG) log(`${LOG_PREFIX}TIMER-STOP: Einzelbelegungs-Timer abgebrochen.`);
    }
}


// ======================================================================================
// │ SKRIPT-INITIALISIERUNG                                                             │
// └────────────────────────────────────────────────────────────────────────────────────┘

/**
 * Stellt sicher, dass alle benötigten Datenpunkte existieren.
 * Fehlende Datenpunkte werden mit Standardwerten angelegt.
 */
async function initializeDataPoints() {
    const statesToCreate = {
        [STATUS_LINKS_VAR]:  { name: 'Status Bett Links (belegt/frei)', type: 'boolean', def: false, role: 'state.switch' },
        [STATUS_RECHTS_VAR]: { name: 'Status Bett Rechts (belegt/frei)', type: 'boolean', def: false, role: 'state.switch' },
        [AKTIV_VAR]:         { name: 'Nachtschaltung aktiv', type: 'boolean', def: false, role: 'switch' }
    };

    for (const [id, config] of Object.entries(statesToCreate)) {
        if (!(await existsStateAsync(id))) {
            log(`${LOG_PREFIX}Datenpunkt '${id}' wird erstellt.`, 'info');
            await createStateAsync(id, {
                type: config.type, name: config.name, def: config.def,
                read: true, write: true, role: config.role
            });
        }
    }

    // Überprüfung der externen Steuerungs-Datenpunkte
    const externalDps = [TAG_NACHT_VAR, ANWESENHEIT_VAR];
    for (const dp of externalDps) {
        if (!(await existsStateAsync(dp))) {
            log(`${LOG_PREFIX}WARNUNG: Der Steuer-Datenpunkt '${dp}' existiert nicht. Das Skript funktioniert möglicherweise nicht korrekt.`, 'warn');
        }
    }
}


// ======================================================================================
// │ KERNLOGIK                                                                          │
// └────────────────────────────────────────────────────────────────────────────────────┘

/**
 * Verarbeitet die Status-Änderung eines einzelnen Bett-Sensors.
 * @param {'links' | 'rechts'} side - Die Bettseite, die aktualisiert wird.
 * @param {boolean} sensorValue - Der vom Sensor gemeldete Wert (true=offen, false=geschlossen).
 */
async function processSensor(side, sensorValue) {
    const statusVar = side === 'links' ? STATUS_LINKS_VAR : STATUS_RECHTS_VAR;
    let timerRef = side === 'links' ? timerLinks : timerRechts;
    const isBelegt = !sensorValue; // Sensor 'offen' (true) bedeutet, Bett ist 'nicht belegt' (false)

    if (isBelegt) {
        // Person ist im Bett oder zurückgekehrt.
        if (timerRef) {
            clearTimeout(timerRef);
            if (side === 'links') timerLinks = null; else timerRechts = null;
            if (DEBUG) log(`${LOG_PREFIX}TIMER-STOP (${side.toUpperCase()}): Person ist zurück. Abwesenheits-Timer gestoppt.`);
        }
        await setStateChangedAndLog(statusVar, true);
    } else {
        // Person hat das Bett verlassen.
        if ((await getStateAsync(statusVar)).val) {
            const currentMonth = new Date().getMonth() + 1; // 1 (Jan) - 12 (Dez)
            const delayMinuten = (currentMonth >= 6 && currentMonth <= 9) ? DELAY_MINUTEN_SOMMER : DELAY_MINUTEN_WINTER;
            const delayMilliseconds = delayMinuten * 60 * 1000;

            if (DEBUG) log(`${LOG_PREFIX}TIMER-START (${side.toUpperCase()}): Person hat Bett verlassen. Starte ${delayMinuten}min Abwesenheits-Timer.`);

            const newTimer = setTimeout(async () => {
                if (DEBUG) log(`${LOG_PREFIX}TIMER-ENDE (${side.toUpperCase()}): Verzögerung abgelaufen. Setze Status auf 'frei'.`);
                await setStateChangedAndLog(statusVar, false);
                if (side === 'links') timerLinks = null; else timerRechts = null;
            }, delayMilliseconds);

            if (side === 'links') timerLinks = newTimer; else timerRechts = newTimer;
        }
    }
}

/**
 * Die zentrale Funktion, die den finalen Status der Nachtschaltung berechnet und setzt.
 * Wird bei jeder relevanten Zustandsänderung aufgerufen.
 */
async function updateNightMode() {
    // 1. Alle relevanten Zustände einlesen
    const isBelegtLinks  = (await getStateAsync(STATUS_LINKS_VAR)).val;
    const isBelegtRechts = (await getStateAsync(STATUS_RECHTS_VAR)).val;
    const isNacht        = !(await getStateAsync(TAG_NACHT_VAR)).val;
    const isAnwesend     = (await getStateAsync(ANWESENHEIT_VAR)).val;
    const isAktivCurrent = (await getStateAsync(AKTIV_VAR)).val;

    if (DEBUG) log(`${LOG_PREFIX}ANALYSE: Links=${isBelegtLinks}, Rechts=${isBelegtRechts}, Nacht=${isNacht}, Anwesend=${isAnwesend}, AktuellAktiv=${isAktivCurrent}`);

    // --- ENTSCHEIDUNGS-LOGIK ---

    // MASTER-REGEL: Bei Tag oder wenn niemand anwesend ist, wird die Nachtschaltung immer beendet.
    if (!isNacht || !isAnwesend) {
        clearAllTimers();
        await setStateChangedAndLog(AKTIV_VAR, false);
        return; // Verarbeitung hier beenden
    }

    // REGELN FÜR DIE NACHT BEI ANWESENHEIT:
    const beideBelegt = isBelegtLinks && isBelegtRechts;
    const einerBelegt = isBelegtLinks || isBelegtRechts;

    if (beideBelegt) {
        // Fall 1: Beide Personen im Bett -> Sofort aktivieren.
        if (DEBUG) log(`${LOG_PREFIX}LOGIK: Beide Personen im Bett. Aktiviere Nachtschaltung sofort.`);
        clearAllTimers();
        await setStateChangedAndLog(AKTIV_VAR, true);
    } else if (einerBelegt) {
        // Fall 2: Genau eine Person im Bett.
        if (!isAktivCurrent && !einzelTimer) {
            // Wenn Schaltung noch aus ist und kein Timer läuft, starte den 30-Minuten-Timer.
            const delayMilliseconds = DELAY_MINUTEN_EINZEL * 60 * 1000;
            if (DEBUG) log(`${LOG_PREFIX}LOGIK: Eine Person im Bett (von inaktiv). Starte ${DELAY_MINUTEN_EINZEL}min Timer.`);
            einzelTimer = setTimeout(async () => {
                if (DEBUG) log(`${LOG_PREFIX}TIMER-ENDE (EINZEL): ${DELAY_MINUTEN_EINZEL}min abgelaufen. Aktiviere Nachtschaltung.`);
                einzelTimer = null;
                await setStateChangedAndLog(AKTIV_VAR, true);
            }, delayMilliseconds);
        }
        // Falls bereits aktiv (weil zweite Person aufgestanden ist), bleibt der Zustand erhalten.
    } else {
        // Fall 3: Niemand im Bett -> Immer deaktivieren.
        if (DEBUG) log(`${LOG_PREFIX}LOGIK: Niemand mehr im Bett. Deaktiviere Nachtschaltung.`);
        clearAllTimers();
        await setStateChangedAndLog(AKTIV_VAR, false);
    }
}


// ======================================================================================
// │ TRIGGER-DEFINITIONEN                                                               │
// └────────────────────────────────────────────────────────────────────────────────────┘

// Trigger für die einzelnen Bett-Sensoren
on({ id: SENSOR_LINKS_DP, change: 'ne' }, async (obj) => {
    if (DEBUG) log(`${LOG_PREFIX}TRIGGER: Sensor Links meldet: ${obj.state.val}`);
    await processSensor('links', obj.state.val);
});

on({ id: SENSOR_RECHTS_DP, change: 'ne' }, async (obj) => {
    if (DEBUG) log(`${LOG_PREFIX}TRIGGER: Sensor Rechts meldet: ${obj.state.val}`);
    await processSensor('rechts', obj.state.val);
});

// Ein kombinierter Trigger für die finale Logik, um unnötige Aufrufe zu vermeiden.
const finalLogicTrigger = [STATUS_LINKS_VAR, STATUS_RECHTS_VAR, TAG_NACHT_VAR, ANWESENHEIT_VAR];
on({ id: finalLogicTrigger, change: 'ne' }, async (obj) => {
    if (DEBUG) log(`${LOG_PREFIX}TRIGGER: Eine für die Logik relevante Variable hat sich geändert -> ${obj.id}`);
    await updateNightMode();
});


// ======================================================================================
// │ SKRIPT-START & STOP                                                                │
// └────────────────────────────────────────────────────────────────────────────────────┘

onStop(function () {
    clearAllTimers();
    log(`${LOG_PREFIX}Skript gestoppt.`, 'info');
});

// Hauptfunktion, die beim Skriptstart ausgeführt wird.
(async function main() {
    await initializeDataPoints();
    log(`${LOG_PREFIX}Skript gestartet.`, 'info');
    // Beim Start einmal die Logik ausführen, um den korrekten Zustand sicherzustellen.
    await updateNightMode();
})();

