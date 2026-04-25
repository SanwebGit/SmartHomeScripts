/**
 * @file        Intelligente & träge Anwesenheitserkennung im Bett (ioBroker)
 * @version     4.0
 * @author      Sanweb
 * @description
 * Refactoring v3.4 → v4.0:
 *
 * 🔴 KRITISCH:
 *  - [1] Echter Queuing-Mutex für updateNightMode():
 *        Trigger, die während eines laufenden Updates eintreffen, gehen nicht mehr
 *        verloren. Stattdessen wird ein pendingNightModeUpdate-Flag gesetzt und
 *        nach Abschluss des aktuellen Laufs einmalig nachgeholt. Damit ist der
 *        zuletzt gemeldete Zustand garantiert ausgewertet worden.
 *
 * 🟡 MITTEL:
 *  - [2] Sensor-Timer (links/rechts) werden bei Tag-/Abwesenheits-Reset jetzt
 *        ebenfalls gestoppt — vermeidet, dass ein bereits laufender Frei-Timer
 *        nach Rückkehr in den Nacht-/Anwesend-Modus unerwartet zuschlägt.
 *  - [3] Null-Safety: isBelegtLinks / isBelegtRechts werden via !! sauber
 *        auf Boolean gecastet. null/undefined ergibt nun deterministisch false.
 *  - [4] DEBUG-Flag standardmäßig auf false (Produktion). Für Diagnose temporär
 *        wieder auf true setzen.
 *
 * 🟢 OPTIONAL:
 *  - [5] setStateChangedAndLog akzeptiert optional einen knownCurrentValue,
 *        der einen redundanten getState-Call einspart, wenn der aktuelle Wert
 *        ohnehin bereits vorliegt (z. B. innerhalb von updateNightMode).
 *  - [6] SOMMER_MONATE: Begründung der Monatsauswahl als Kommentar ergänzt.
 *
 * Nicht geändert: Architektur (Trigger-Split, Timer-Objekt, Promise.all),
 * Konfigurationsabschnitt, ioBroker-API-Aufrufe, Log-Präfix, Sprache.
 */

// ======================================================================================
// │ KONFIGURATION                                                                      │
// └────────────────────────────────────────────────────────────────────────────────────┘

// --- 1. DATENPUNKTE DER SENSOREN ---
const SENSOR_LINKS_DP  = 'hm-rpc.0.001E1D899E94B0.1.STATE';
const SENSOR_RECHTS_DP = 'hm-rpc.0.001E1D899E922D.1.STATE';

/**
 * Sensor-Logik:
 * false = Normal      (false bedeutet belegt/geschlossen)
 * true  = Invertiert  (true  bedeutet belegt/geschlossen)
 */
const SENSOR_INVERTED = false;

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

const MS_PER_MINUTE = 60 * 1000; // Umrechnungsfaktor für Timer

/**
 * Sommermonate: Juni–September.
 * Begründung: In den vollen Sommermonaten ist die Nacht in Mitteleuropa kurz
 * und die Aufwachphase typischerweise zügiger; daher reicht eine kürzere
 * Frei-Verzögerung (DELAY_MINUTEN_SOMMER).
 * Mai und Oktober gelten bewusst noch als "Winter" (= längere Verzögerung
 * DELAY_MINUTEN_WINTER), weil dort die Übergangszeiten oft mit unruhigerem
 * Schlafverhalten und längeren Wachphasen einhergehen.
 * Wer ein anderes Verhalten möchte, passt einfach das Array an, z. B.:
 *   [5, 6, 7, 8, 9, 10]  // Mai–Oktober als Sommer
 */
const SOMMER_MONATE = [6, 7, 8, 9];

// --- 5. DEBUG-MODUS ---
// Für Produktion auf false. Für Diagnose temporär auf true setzen.
const DEBUG = false;


// ======================================================================================
// │ GLOBALE VARIABLEN & ZUSTÄNDE                                                        │
// └────────────────────────────────────────────────────────────────────────────────────┘

const LOG_PREFIX = '[NACHTSCHALTUNG] ';

// Zentrale Timer-Verwaltung zur Vermeidung von Referenzfehlern
const timers = {
    links: null,
    rechts: null,
    einzel: null
};

// Mutex + Queue-Flag für updateNightMode (Race-Condition-Schutz mit Nachholen)
let isUpdatingNightMode    = false;
let pendingNightModeUpdate = false;


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
 *
 * @param {string} id  - Datenpunkt-ID
 * @param {*}      value - zu setzender Wert
 * @param {*}      [knownCurrentValue=undefined] - optional bereits bekannter
 *                 aktueller Wert. Wenn übergeben (auch null/false), entfällt
 *                 der zusätzliche getState-Call.
 */
async function setStateChangedAndLog(id, value, knownCurrentValue = undefined) {
    let currentVal;
    if (typeof knownCurrentValue !== 'undefined') {
        currentVal = knownCurrentValue;
    } else {
        const currentState = await safeGetState(id);
        currentVal = currentState.val;
    }

    if (currentVal !== value) {
        if (DEBUG) log(`${LOG_PREFIX}AKTION: Setze '${id}' auf '${value}'.`);
        await setStateAsync(id, value, true);
    }
}


// ======================================================================================
// │ SKRIPT-INITIALISIERUNG                                                              │
// └────────────────────────────────────────────────────────────────────────────────────┘

async function initializeDataPoints() {
    // 'type' wurde aus dem Objekt entfernt, da ohnehin alle States boolean sind
    const statesToCreate = {
        [STATUS_LINKS_VAR]:  { name: 'Status Bett Links (belegt/frei)', role: 'state.switch' },
        [STATUS_RECHTS_VAR]: { name: 'Status Bett Rechts (belegt/frei)', role: 'state.switch' },
        [AKTIV_VAR]:         { name: 'Nachtschaltung aktiv', role: 'switch' }
    };

    for (const [id, config] of Object.entries(statesToCreate)) {
        if (!(await existsStateAsync(id))) {
            log(`${LOG_PREFIX}Erstelle Datenpunkt: ${id}`, 'info');
            await createStateAsync(id, {
                type: 'boolean', // Hier direkt als Literal deklariert, was den Linter zufriedenstellt
                name: config.name,
                def: false, // default false für alle
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


// ======================================================================================
// │ KERNLOGIK                                                                          │
// └────────────────────────────────────────────────────────────────────────────────────┘

/**
 * Verarbeitet die Sensor-Eingaben (links/rechts).
 */
async function processSensor(side, sensorRawValue) {
    const statusVar = side === 'links' ? STATUS_LINKS_VAR : STATUS_RECHTS_VAR;

    // Logik-Umkehrung falls konfiguriert (Sicheres Casting mit !!)
    // Standard: false = belegt. Wenn Inverted=true, dann true = belegt.
    const isBelegt = SENSOR_INVERTED ? !!sensorRawValue : !sensorRawValue;

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
}

/**
 * Zentrale Entscheidungs-Logik der Nachtschaltung.
 *
 * Mutex mit Queue: Läuft bereits eine Auswertung, wird der eingehende Trigger
 * nicht verworfen, sondern als pending markiert und nach dem aktuellen Lauf
 * einmalig nachgeholt. So ist garantiert, dass der jeweils zuletzt gemeldete
 * Zustand auch tatsächlich ausgewertet wird.
 */
async function updateNightMode() {
    if (isUpdatingNightMode) {
        pendingNightModeUpdate = true;
        if (DEBUG) log(`${LOG_PREFIX}QUEUE: updateNightMode läuft bereits, Trigger wird nachgeholt.`);
        return;
    }

    isUpdatingNightMode    = true;
    pendingNightModeUpdate = false;

    try {
        // Performance: Alle Zustände parallel abfragen
        const [links, rechts, tagStatus, anwesenheit, aktiv] = await Promise.all([
            safeGetState(STATUS_LINKS_VAR),
            safeGetState(STATUS_RECHTS_VAR),
            safeGetState(TAG_NACHT_VAR),
            safeGetState(ANWESENHEIT_VAR),
            safeGetState(AKTIV_VAR)
        ]);

        // Null-Safety: undefined/null werden deterministisch zu false
        const isBelegtLinks  = !!links.val;
        const isBelegtRechts = !!rechts.val;
        const isNacht        = tagStatus.val === false;   // Tag=true -> Nacht=false
        const isAnwesend     = anwesenheit.val === true;
        const isAktivCurrent = aktiv.val === true;        // Fallback: null/undefined wird false

        if (DEBUG) {
            log(`${LOG_PREFIX}ANALYSE: Links=${isBelegtLinks} | Rechts=${isBelegtRechts} | Nacht=${isNacht} | Anwesend=${isAnwesend}`);
        }

        // MASTER-REGEL: Abbruch bei Tag oder Abwesenheit
        if (!isNacht || !isAnwesend) {
            if (isAktivCurrent || timers.einzel || timers.links || timers.rechts) {
                if (DEBUG) log(`${LOG_PREFIX}RESET: Tag oder Abwesenheit erkannt. Deaktiviere Schaltung und stoppe alle Timer.`);
                stopTimer('links');
                stopTimer('rechts');
                stopTimer('einzel');
                // Bekannten Wert direkt mitgeben -> spart einen getState-Call
                await setStateChangedAndLog(AKTIV_VAR, false, isAktivCurrent);
            }
            return;
        }

        // LOGIK-MATRIX
        const beideBelegt = isBelegtLinks && isBelegtRechts;
        const einerBelegt = isBelegtLinks || isBelegtRechts;

        if (beideBelegt) {
            // Sofort aktiv
            stopTimer('einzel');
            await setStateChangedAndLog(AKTIV_VAR, true, isAktivCurrent);
        } else if (einerBelegt) {
            // Verzögerte Aktivierung falls noch nicht aktiv
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
            // Niemand im Bett
            stopTimer('einzel');
            await setStateChangedAndLog(AKTIV_VAR, false, isAktivCurrent);
        }
    } finally {
        // Lock zwingend freigeben
        isUpdatingNightMode = false;

        // Falls während des Laufs ein weiterer Trigger eintraf: einmalig nachholen.
        if (pendingNightModeUpdate) {
            pendingNightModeUpdate = false;
            if (DEBUG) log(`${LOG_PREFIX}QUEUE: Hole verworfenen Trigger nach.`);
            await updateNightMode();
        }
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

// Trigger für die finale Logik (zusammengefasst)
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
    log(`${LOG_PREFIX}Initialisierung...`, 'info');
    await initializeDataPoints();

    // Cleanup möglicher alter Timer-Zustände beim Skript-Start
    stopTimer('links');
    stopTimer('rechts');
    stopTimer('einzel');

    // Initialer Check beim Start
    await updateNightMode();
    log(`${LOG_PREFIX}System bereit.`, 'info');
})();