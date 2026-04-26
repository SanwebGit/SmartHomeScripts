/**
 * @file        Intelligente & träge Anwesenheitserkennung im Bett (ioBroker)
 * @version     4.1 ULTIMATE
 * @author      Sanweb
 * @description
 * Überarbeitete Version basierend auf v3.4 mit drei gezielten Korrekturen
 * unter Beibehaltung der unveränderten Kernlogik:
 *
 *   [FIX 1] Race-Condition-Schutz auch in processSensor (Lock pro Seite).
 *   [FIX 2] Neustart-Stabilität: Rücklese der Sensor-Rohwerte beim Start und
 *           Synchronisation der Status-Datenpunkte mit dem Ist-Zustand.
 *   [FIX 3] Per-Sensor-Invertierung statt globalem Flag, für gemischte
 *           HomeMatic-Geräte mit unterschiedlichen Logikpegeln.
 *
 * Die Entscheidungsmatrix in updateNightMode() bleibt unverändert.
 */

// ======================================================================================
// │ KONFIGURATION                                                                      │
// └────────────────────────────────────────────────────────────────────────────────────┘

// --- 1. DATENPUNKTE DER SENSOREN ---
const SENSOR_LINKS_DP  = 'hm-rpc.0.001E1D899E94B0.1.STATE';
const SENSOR_RECHTS_DP = 'hm-rpc.0.001E1D899E922D.1.STATE';

/**
 * [FIX 3] Sensor-Logik pro Seite konfigurierbar.
 * false = Normal (false bedeutet belegt/geschlossen)
 * true  = Invertiert (true bedeutet belegt/geschlossen)
 */
const SENSOR_LINKS_INVERTED  = false;
const SENSOR_RECHTS_INVERTED = false;

// --- 2. ZIEL-DATENPUNKTE IN IO-BROKER ---
const STATUS_LINKS_VAR  = '0_userdata.0.System.Nachtschaltung.BettLinks';
const STATUS_RECHTS_VAR = '0_userdata.0.System.Nachtschaltung.BettRechts';
const AKTIV_VAR         = '0_userdata.0.System.Nachtschaltung.Aktiv';

// --- 3. STEUERNDE DATENPUNKTE ---
const TAG_NACHT_VAR     = '0_userdata.0.System.Astro.Tag';
const ANWESENHEIT_VAR   = '0_userdata.0.Anwesenheit.Status';

// --- 4. VERZÖGERUNGSZEITEN & SAISON ---
const DELAY_MINUTEN_SOMMER = 3;
const DELAY_MINUTEN_WINTER = 4;
const DELAY_MINUTEN_EINZEL = 30;

const MS_PER_MINUTE = 60 * 1000;

// Definition der Sommermonate (Juni bis September)
const SOMMER_MONATE = [6, 7, 8, 9];

// --- 5. DEBUG-MODUS ---
const DEBUG = true;


// ======================================================================================
// │ GLOBALE VARIABLEN & ZUSTÄNDE                                                        │
// └────────────────────────────────────────────────────────────────────────────────────┘

const LOG_PREFIX = '[NACHTSCHALTUNG] ';

// Zentrale Timer-Verwaltung
const timers = {
    links: null,
    rechts: null,
    einzel: null
};

// [FIX 1] Locks pro Seite zur Vermeidung paralleler Sensor-Verarbeitung
const sensorLocks = {
    links: false,
    rechts: false
};

// Lock für Race-Condition-Vermeidung in updateNightMode
let isUpdatingNightMode = false;


// ======================================================================================
// │ HILFSFUNKTIONEN                                                                    │
// └────────────────────────────────────────────────────────────────────────────────────┘

/**
 * Sicherer Abruf eines Zustands mit Fehlerbehandlung.
 */
async function safeGetState(id) {
    try {
        const state = await getStateAsync(id);
        if (!state) {
            log(`${LOG_PREFIX}Fehler: Datenpunkt '${id}' liefert keinen Zustand.`, 'warn');
            return { val: null };
        }
        return state;
    } catch (e) {
        log(`${LOG_PREFIX}Kritischer Fehler beim Lesen von '${id}': ${e.message}`, 'error');
        return { val: null };
    }
}

/**
 * Stoppt einen spezifischen Timer und setzt die Referenz auf null.
 */
function stopTimer(key) {
    if (timers.hasOwnProperty(key) && timers[key]) {
        clearTimeout(timers[key]);
        timers[key] = null;
        if (DEBUG) log(`${LOG_PREFIX}TIMER-STOP: '${key}' abgebrochen.`);
        return true;
    }
    if (DEBUG) log(`${LOG_PREFIX}TIMER-STOP: '${key}' war nicht aktiv.`);
    return false;
}

/**
 * Setzt einen Datenpunkt nur dann, wenn sich der Wert geändert hat.
 */
async function setStateChangedAndLog(id, value) {
    const currentState = await safeGetState(id);
    if (currentState.val !== value) {
        if (DEBUG) log(`${LOG_PREFIX}AKTION: Setze '${id}' auf '${value}'.`);
        await setStateAsync(id, value, true);
    }
}

/**
 * [FIX 3] Hilfsfunktion: Wandelt Rohwert eines Sensors unter Berücksichtigung
 * der seitenspezifischen Invertierung in den belegt-Status um.
 */
function isSensorBelegt(side, rawValue) {
    const inverted = side === 'links' ? SENSOR_LINKS_INVERTED : SENSOR_RECHTS_INVERTED;
    return inverted ? !!rawValue : !rawValue;
}


// ======================================================================================
// │ SKRIPT-INITIALISIERUNG                                                              │
// └────────────────────────────────────────────────────────────────────────────────────┘

async function initializeDataPoints() {
    const statesToCreate = {
        [STATUS_LINKS_VAR]:  { name: 'Status Bett Links (belegt/frei)', role: 'state.switch' },
        [STATUS_RECHTS_VAR]: { name: 'Status Bett Rechts (belegt/frei)', role: 'state.switch' },
        [AKTIV_VAR]:         { name: 'Nachtschaltung aktiv', role: 'switch' }
    };

    for (const [id, config] of Object.entries(statesToCreate)) {
        if (!(await existsStateAsync(id))) {
            log(`${LOG_PREFIX}Erstelle Datenpunkt: ${id}`, 'info');
            await createStateAsync(id, {
                type: 'boolean',
                name: config.name,
                def: false,
                read: true, write: true, role: config.role
            });
        }
    }

    // Validierung der Sensoren beim Start
    const sensors = [SENSOR_LINKS_DP, SENSOR_RECHTS_DP, TAG_NACHT_VAR, ANWESENHEIT_VAR];
    for (const dp of sensors) {
        if (!(await existsStateAsync(dp))) {
            log(`${LOG_PREFIX}KRITISCH: Steuer-Datenpunkt '${dp}' fehlt! Skript-Logik gefährdet.`, 'error');
        } else {
            const state = await safeGetState(dp);
            if (typeof state.val !== 'boolean') {
                if (typeof state.val === 'number' && (state.val === 0 || state.val === 1)) {
                    log(`${LOG_PREFIX}INFO: Datenpunkt '${dp}' ist ein Integer (${state.val}). Wird als Boolean interpretiert.`, 'info');
                } else {
                    log(`${LOG_PREFIX}WARNUNG: Datenpunkt '${dp}' hat unerwarteten Typ (${typeof state.val}). Prüfe Konfiguration!`, 'warn');
                }
            }
        }
    }
}

/**
 * [FIX 2] Synchronisation der Status-Datenpunkte mit den tatsächlichen
 * Sensor-Rohwerten beim Skript-Start. Verhindert, dass nach einem Neustart
 * veraltete Status-Werte in die Logik einfließen.
 *
 * Wichtig: Es werden hier KEINE Delay-Timer rekonstruiert. Liegt jemand im
 * Bett, wird der Status sofort auf 'belegt' gesetzt; ist das Bett leer, wird
 * der Status direkt auf 'frei' gesetzt. Das ist der konservative Ansatz —
 * die Verzögerungslogik gilt nur für während des Betriebs erkannte Übergänge.
 */
async function syncSensorStatesOnStartup() {
    if (DEBUG) log(`${LOG_PREFIX}STARTUP-SYNC: Lese Sensor-Rohwerte und gleiche Status ab.`);

    const [linksRaw, rechtsRaw] = await Promise.all([
        safeGetState(SENSOR_LINKS_DP),
        safeGetState(SENSOR_RECHTS_DP)
    ]);

    if (linksRaw.val !== null) {
        const isBelegtLinks = isSensorBelegt('links', linksRaw.val);
        if (DEBUG) log(`${LOG_PREFIX}STARTUP-SYNC: Links roh=${linksRaw.val} → belegt=${isBelegtLinks}`);
        await setStateChangedAndLog(STATUS_LINKS_VAR, isBelegtLinks);
    } else {
        log(`${LOG_PREFIX}STARTUP-SYNC: Sensor links nicht lesbar — Sync übersprungen.`, 'warn');
    }

    if (rechtsRaw.val !== null) {
        const isBelegtRechts = isSensorBelegt('rechts', rechtsRaw.val);
        if (DEBUG) log(`${LOG_PREFIX}STARTUP-SYNC: Rechts roh=${rechtsRaw.val} → belegt=${isBelegtRechts}`);
        await setStateChangedAndLog(STATUS_RECHTS_VAR, isBelegtRechts);
    } else {
        log(`${LOG_PREFIX}STARTUP-SYNC: Sensor rechts nicht lesbar — Sync übersprungen.`, 'warn');
    }
}


// ======================================================================================
// │ KERNLOGIK                                                                          │
// └────────────────────────────────────────────────────────────────────────────────────┘

/**
 * Verarbeitet die Sensor-Eingaben (links/rechts).
 *
 * [FIX 1] Schutz vor parallelen Aufrufen pro Seite via sensorLocks.
 * Logik selbst bleibt identisch zur v3.4-Schematik.
 */
async function processSensor(side, sensorRawValue) {
    // [FIX 1] Race-Condition-Schutz pro Seite
    if (sensorLocks[side]) {
        if (DEBUG) log(`${LOG_PREFIX}RACE-CONDITION SCHUTZ (${side.toUpperCase()}): processSensor läuft bereits, überspringe.`);
        return;
    }
    sensorLocks[side] = true;

    try {
        const statusVar = side === 'links' ? STATUS_LINKS_VAR : STATUS_RECHTS_VAR;

        // [FIX 3] Per-Sensor-Invertierung über Hilfsfunktion
        const isBelegt = isSensorBelegt(side, sensorRawValue);

        if (isBelegt) {
            // Falls ein Abwesenheits-Timer läuft: Stoppen (Person ist zurück)
            const wasRunning = stopTimer(side);

            if (DEBUG) {
                if (wasRunning) {
                    log(`${LOG_PREFIX}INFO (${side.toUpperCase()}): Person vor Ablauf des Timers zurückgekehrt.`);
                } else {
                    log(`${LOG_PREFIX}INFO (${side.toUpperCase()}): Person hat sich ins Bett gelegt (kein laufender Timer).`);
                }
            }

            await setStateChangedAndLog(statusVar, true);
        } else {
            // Person verlässt das Bett -> Prüfen ob vorher belegt war
            const currentStatus = await safeGetState(statusVar);
            if (currentStatus.val === true) {
                const currentMonth = new Date().getMonth() + 1;
                const delayMin = SOMMER_MONATE.includes(currentMonth) ? DELAY_MINUTEN_SOMMER : DELAY_MINUTEN_WINTER;
                const delayMs = delayMin * MS_PER_MINUTE;
                const ablaufZeit = new Date(Date.now() + delayMs).toLocaleTimeString();

                if (DEBUG) log(`${LOG_PREFIX}TIMER-START (${side.toUpperCase()}): Verlassen erkannt. Frei-Status in ${delayMin}min (um ${ablaufZeit}).`);

                timers[side] = setTimeout(async () => {
                    if (DEBUG) log(`${LOG_PREFIX}TIMER-ENDE (${side.toUpperCase()}): Zeit abgelaufen. Status auf 'frei'.`);
                    timers[side] = null;
                    await setStateChangedAndLog(statusVar, false);
                }, delayMs);
            }
        }
    } finally {
        // [FIX 1] Lock zwingend freigeben
        sensorLocks[side] = false;
    }
}

/**
 * Zentrale Entscheidungs-Logik der Nachtschaltung.
 * UNVERÄNDERT gegenüber v3.4 — diese Funktion bildet die Schematik exakt ab.
 */
async function updateNightMode() {
    if (isUpdatingNightMode) {
        if (DEBUG) log(`${LOG_PREFIX}RACE-CONDITION SCHUTZ: updateNightMode läuft bereits, überspringe Trigger.`);
        return;
    }
    isUpdatingNightMode = true;

    try {
        const [links, rechts, tagStatus, anwesenheit, aktiv] = await Promise.all([
            safeGetState(STATUS_LINKS_VAR),
            safeGetState(STATUS_RECHTS_VAR),
            safeGetState(TAG_NACHT_VAR),
            safeGetState(ANWESENHEIT_VAR),
            safeGetState(AKTIV_VAR)
        ]);

        const isBelegtLinks  = links.val;
        const isBelegtRechts = rechts.val;
        const isNacht        = tagStatus.val === false;
        const isAnwesend     = anwesenheit.val === true;
        const isAktivCurrent = aktiv.val === true;

        if (DEBUG) {
            log(`${LOG_PREFIX}ANALYSE: Links=${isBelegtLinks} | Rechts=${isBelegtRechts} | Nacht=${isNacht} | Anwesend=${isAnwesend}`);
        }

        // MASTER-REGEL: Abbruch bei Tag oder Abwesenheit
        if (!isNacht || !isAnwesend) {
            if (isAktivCurrent || timers.einzel) {
                if (DEBUG) log(`${LOG_PREFIX}RESET: Tag oder Abwesenheit erkannt. Deaktiviere Schaltung.`);
                stopTimer('einzel');
                await setStateChangedAndLog(AKTIV_VAR, false);
            }
            return;
        }

        // LOGIK-MATRIX
        const beideBelegt = isBelegtLinks && isBelegtRechts;
        const einerBelegt = isBelegtLinks || isBelegtRechts;

        if (beideBelegt) {
            stopTimer('einzel');
            await setStateChangedAndLog(AKTIV_VAR, true);
        } else if (einerBelegt) {
            if (!isAktivCurrent && !timers.einzel) {
                const delayMs = DELAY_MINUTEN_EINZEL * MS_PER_MINUTE;
                const ablauf = new Date(Date.now() + delayMs).toLocaleTimeString();

                if (DEBUG) log(`${LOG_PREFIX}LOGIK: Einzelperson erkannt. Aktiviere Nachtschaltung in ${DELAY_MINUTEN_EINZEL}min (um ${ablauf}).`);

                timers.einzel = setTimeout(async () => {
                    timers.einzel = null;
                    await setStateChangedAndLog(AKTIV_VAR, true);
                }, delayMs);
            }
        } else {
            stopTimer('einzel');
            await setStateChangedAndLog(AKTIV_VAR, false);
        }
    } finally {
        isUpdatingNightMode = false;
    }
}


// ======================================================================================
// │ TRIGGER                                                                            │
// ======================================================================================

on({ id: SENSOR_LINKS_DP, change: 'ne' }, async (obj) => {
    await processSensor('links', obj.state.val);
});

on({ id: SENSOR_RECHTS_DP, change: 'ne' }, async (obj) => {
    await processSensor('rechts', obj.state.val);
});

on({ id: [STATUS_LINKS_VAR, STATUS_RECHTS_VAR, TAG_NACHT_VAR, ANWESENHEIT_VAR], change: 'ne' }, async () => {
    await updateNightMode();
});


// ======================================================================================
// │ START / STOP                                                                       │
// ======================================================================================

onStop(() => {
    stopTimer('links');
    stopTimer('rechts');
    stopTimer('einzel');
    log(`${LOG_PREFIX}Skript sauber beendet.`, 'info');
});

(async function main() {
    log(`${LOG_PREFIX}Initialisierung v3.5...`, 'info');
    await initializeDataPoints();

    // Cleanup möglicher alter Timer-Zustände beim Skript-Start
    stopTimer('links');
    stopTimer('rechts');
    stopTimer('einzel');

    // [FIX 2] Status-Datenpunkte mit den realen Sensor-Rohwerten synchronisieren
    await syncSensorStatesOnStartup();

    // Initialer Check beim Start
    await updateNightMode();
    log(`${LOG_PREFIX}System bereit.`, 'info');
})();