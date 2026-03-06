/**
 * @fileoverview Zentrale, intelligente & modulierende Heizungssteuerung für ioBroker
 * @version 8.0 (Final Polish: Error-Tracking States, erweiterte Plausibilität, strict Types)
 * @author Sanweb
 * @license MIT
 *
 * -------------------------------------------------------------------------------------
 * ZWECK DES SKRIPTS:
 * -------------------------------------------------------------------------------------
 * Dieses Skript steuert die zentrale Heiztherme durch eine intelligente, dynamische
 * Anpassung der witterungsgeführten Heizkurve.
 *
 * NEU in V8.0:
 * - Error-Tracking: Fehlerzähler pro ID werden automatisch als States exponiert
 * - Erweiterte Plausibilitätsprüfungen für Einzel-Sensoren (Raum/Außen)
 * - Strikterer Fallback in convertType (gibt null zurück, wenn Typ nicht erfüllt)
 * -------------------------------------------------------------------------------------
 */

(function(){ // Start der Kapselung
    "use strict";

// --- Globale Variablen ---
let executionTimeout = null;
let lastExecution = 0;
let statsRunCounter = 0;
const errorCounters = {}; // Speichert Fehleranzahl pro ID für Log-Backoff
const allMonitoredIds = new Set(); // Sammelt alle IDs für die Error-States

// --- Cached Values ---
let cachedMinKurve = 0;
let cachedMaxKurve = 0;

// -------------------------------------------------------------------------------------
// 1. ZENTRALE KONFIGURATION
// -------------------------------------------------------------------------------------
const CONFIG = {
    // --- A. GRUNDEINSTELLUNGEN ---
    logLevel: 'info', // 'debug', 'info', 'warn', 'error'
    toleranzTemp: 0.2,
    ventilSchwelle: 0.1, // Ab 10% Ventilöffnung wird Bedarf angemeldet
    
    // --- B. TRIGGER & WATCHDOG ---
    trigger: {
        throttleTime: 1000,
        debounceDelay: 2000,
    },
    watchdog: {
        enableForIds: ['ACTUAL_TEMPERATURE', 'TEMPERATURE'],
        maxAgeMs: 3600000, // 1 Stunde
    },

    // --- C. ERROR TRACKING ---
    errorTracking: {
        exposeAsStates: true, // Erstellt automatisch Datenpunkte für Fehlerzähler
        baseId: '0_userdata.0.Heizung.Allgemein.Fehlerzaehler' // Pfad für die States
    },

    // --- D. HEIZKURVEN-STEUERUNG ---
    heizkurve: {
        basis: 1.2,
        maxAnpassung: 0.4,
    },
    
    // --- E. INTEGRALE SPREIZUNGS-STEUERUNG ---
    spreizungsRegelung: {
        aktiv: true,
        zielSpreizung: 9.0,
        anpassungsFaktor: 0.003,
        maxAbsenkung: -0.4,
        maxAnhebung: 0.2,
        minFlowTemp: 30.0,
        minReturnTemp: 0.0,
    },

    // --- F. STABILISIERUNGS-LOGIK & PLAUSIBILITÄT ---
    stabilisierung: {
        maxAussenTemp: 5.0,
        neutralzoneSpreizung: 0.5,
        plausibilitaet: {
            minSpreizung: 0.0,
            maxSpreizung: 30.0,
            minRaumTemp: 5.0,   // Frostschutz
            maxRaumTemp: 40.0,  // Maximal realistische Raumtemperatur
            minAussenTemp: -30.0,
            maxAussenTemp: 50.0
        }
    },

    // --- G. RAUMKONFIGURATION ---
    rooms: [
        { roomName: 'Wohnzimmer',   thermostatSetPointId: 'hm-rpc.2.INT0000005.1.SET_POINT_TEMPERATURE' },
        { roomName: 'Schlafzimmer', thermostatSetPointId: 'hm-rpc.2.INT0000001.1.SET_POINT_TEMPERATURE' },
        { roomName: 'Badezimmer',   thermostatSetPointId: 'hm-rpc.2.INT0000002.1.SET_POINT_TEMPERATURE' },
        { roomName: 'Kueche',       thermostatSetPointId: 'hm-rpc.2.INT0000003.1.SET_POINT_TEMPERATURE' },
        { roomName: 'Esszimmer',    thermostatSetPointId: 'hm-rpc.2.INT0000004.1.SET_POINT_TEMPERATURE' },
    ],

    // --- H. EBUS-ADAPTER KONFIGURATION ---
    ebus: {
        setOpModeId: 'mqtt.1.ebusd.700.Z1OpMode.set',
        setHeatCurveId: 'mqtt.1.ebusd.700.Hc1HeatCurve.set',
        setDayTempId: 'mqtt.1.ebusd.700.Z1DayTemp.set',
        getFlowTempId: 'hm-rpc.0.002822699B7E84.1.ACTUAL_TEMPERATURE',
        getReturnTempId: 'hm-rpc.0.002822699B7E84.2.ACTUAL_TEMPERATURE',
        getOpModeId: 'mqtt.1.ebusd.700.Z1OpMode',
        getRoomTempSwitchOnId: 'mqtt.1.ebusd.700.Hc1RoomTempSwitchOn',
        setRoomTempSwitchOnId: 'mqtt.1.ebusd.700.Hc1RoomTempSwitchOn.set',
    },

    // --- I. ioBroker OBJEKT-IDs ---
    ids: {
        svHeizperiodeId: '0_userdata.0.Heizung.Allgemein.HeizperiodeAktiv',
        statusGasthermeId: '0_userdata.0.Heizung.Zentral.StatusTherme',
        hoechsteAnforderungId: '0_userdata.0.Heizung.Zentral.HoechsteAnforderungTemp',
        svSpreizungKorrekturId: '0_userdata.0.Heizung.Zentral.SpreizungKorrektur',
        aussenTempId: 'hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE',
        letzteAusfuehrungId: '0_userdata.0.Heizung.Zentral.LetzteAusfuehrung',
    }
};

// -------------------------------------------------------------------------------------
// 2. HILFSFUNKTIONEN & INITIALISIERUNG
// -------------------------------------------------------------------------------------

function sysLog(msg, level = 'info') {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    const confLvl = levels[CONFIG.logLevel] !== undefined ? levels[CONFIG.logLevel] : 1;
    const curLvl = levels[level] !== undefined ? levels[level] : 1;
    
    if (curLvl >= confLvl) {
        if (level === 'error') log(`[Zentral|ERROR] ${msg}`, 'error');
        else if (level === 'warn') log(`[Zentral|WARN] ${msg}`, 'warn');
        else if (level === 'info') log(`[Zentral|INFO] ${msg}`, 'info');
        else log(`[Zentral|DEBUG] ${msg}`);
    }
}

/**
 * Konsistente Typkonvertierung mit striktem Fallback
 */
function convertType(val, expectedType) {
    if (val === null || val === undefined) return null;
    
    if (expectedType === 'number') {
        if (typeof val === 'number') return val;
        if (typeof val === 'string') {
            const parsed = parseFloat(val.replace(',', '.'));
            return isNaN(parsed) ? null : parsed;
        }
        if (typeof val === 'boolean') return val ? 1 : 0;
        return null; // Fallback für Nummernerwartung
    }
    
    if (expectedType === 'boolean') {
        if (typeof val === 'boolean') return val;
        if (typeof val === 'number') return val !== 0;
        if (typeof val === 'string') {
            const lower = val.toLowerCase();
            return lower === 'true' || lower === '1' || lower === 'on';
        }
        return null; // Fallback für Booleanerwartung
    }
    
    // Wenn ein expliziter Typ erwartet wurde, dieser aber nicht verarbeitet wurde:
    if (expectedType) return null; 
    
    return val; // Fallback, falls kein expliziter Typ gefordert
}

/**
 * Aktualisiert den Fehlerzähler-State in ioBroker
 */
async function updateErrorState(id, count) {
    if (!CONFIG.errorTracking.exposeAsStates || !id) return;
    const cleanId = id.replace(/\./g, '_');
    const stateId = `${CONFIG.errorTracking.baseId}.${cleanId}`;
    try { 
        await setStateAsync(stateId, count, true); 
    } catch(e) {
        // Leises Scheitern, um Logs nicht weiter zu füllen
    }
}

/**
 * Typsicherer State-Abruf mit Watchdog, Error-Backoff und State-Tracking
 */
async function safeGetState(id, expectedType = null) {
    try {
        const state = await getStateAsync(id);
        if (!state || state.val === null || state.val === undefined) return null;
        
        // Error-Counter zurücksetzen bei Erfolg
        if (errorCounters[id]) {
            errorCounters[id] = 0;
            await updateErrorState(id, 0);
        }
        
        // Watchdog-Prüfung
        const isWatchdogRelevant = CONFIG.watchdog.enableForIds.some(pattern => id.includes(pattern));
        if (isWatchdogRelevant && CONFIG.watchdog.maxAgeMs > 0 && state.ts) {
            const age = Date.now() - state.ts;
            if (age > CONFIG.watchdog.maxAgeMs) {
                sysLog(`State ${id} ist veraltet (${Math.round(age/1000/60)} Min). Wird ignoriert.`, 'warn');
                return null;
            }
        }

        // Typkonvertierung
        if (expectedType) {
            const convertedVal = convertType(state.val, expectedType);
            if (convertedVal === null) {
                sysLog(`Wert von ${id} ("${state.val}") konnte nicht in '${expectedType}' konvertiert werden.`, 'warn');
                return null;
            }
            return { ...state, val: convertedVal };
        }
        
        return state;
    } catch (e) {
        errorCounters[id] = (errorCounters[id] || 0) + 1;
        await updateErrorState(id, errorCounters[id]);
        
        // KRITISCHER Fehler-Watchdog
        if (errorCounters[id] >= 1000 && errorCounters[id] % 1000 === 0) {
            sysLog(`KRITISCH: Fehlerzähler für ${id} hat ${errorCounters[id]} erreicht! Hardware/Verbindung prüfen.`, 'error');
        }
        // Exponential/Modulo Backoff für Logs
        else if (errorCounters[id] <= 3 || errorCounters[id] % 10 === 0) {
            sysLog(`Fehler beim Lesen von ${id} (${errorCounters[id]}x aufgetreten): ${e.message}`, 'error');
        }
        return null;
    }
}

/**
 * Sammelt alle IDs und präkalkuliert konstante Werte
 */
function initConfig() {
    CONFIG.rooms = CONFIG.rooms.map(room => {
        const actualId = room.thermostatSetPointId.replace('SET_POINT_TEMPERATURE', 'ACTUAL_TEMPERATURE');
        const levelId = room.thermostatSetPointId.replace('SET_POINT_TEMPERATURE', 'LEVEL');
        
        allMonitoredIds.add(room.thermostatSetPointId);
        allMonitoredIds.add(actualId);
        allMonitoredIds.add(levelId);
        
        return { ...room, actualTempId: actualId, levelId: levelId };
    });
    
    // Globale IDs für Error-Tracking sammeln
    allMonitoredIds.add(CONFIG.ids.svHeizperiodeId);
    allMonitoredIds.add(CONFIG.ids.aussenTempId);
    allMonitoredIds.add(CONFIG.ebus.getFlowTempId);
    allMonitoredIds.add(CONFIG.ebus.getReturnTempId);
    allMonitoredIds.add(CONFIG.ebus.getOpModeId);
    allMonitoredIds.add(CONFIG.ebus.getRoomTempSwitchOnId);
    allMonitoredIds.add(CONFIG.ids.svSpreizungKorrekturId);
    
    cachedMinKurve = CONFIG.heizkurve.basis - CONFIG.heizkurve.maxAnpassung;
    cachedMaxKurve = CONFIG.heizkurve.basis + CONFIG.heizkurve.maxAnpassung;
    
    sysLog('Initialisierung & Caching abgeschlossen.', 'debug');
}

/**
 * Erzeugt eine lesbare Beschreibung für den Fehlerzähler anhand der ID
 */
function getErrorStateName(id) {
    // Räume prüfen
    for (const room of CONFIG.rooms) {
        if (id === room.thermostatSetPointId) return `Fehlerzähler: Soll-Temperatur (${room.roomName}) - Lesefehler`;
        if (id === room.actualTempId) return `Fehlerzähler: Ist-Temperatur (${room.roomName}) - Lese-/Watchdog-Fehler`;
        if (id === room.levelId) return `Fehlerzähler: Ventilöffnung (${room.roomName}) - Lesefehler`;
    }
    
    // Globale & eBUS Sensoren
    if (id === CONFIG.ids.svHeizperiodeId) return 'Fehlerzähler: Heizperiode (Status) - Lesefehler';
    if (id === CONFIG.ids.aussenTempId) return 'Fehlerzähler: Außentemperatur - Lese-/Watchdog-Fehler';
    if (id === CONFIG.ids.svSpreizungKorrekturId) return 'Fehlerzähler: Spreizungskorrektur - Lesefehler';
    if (id === CONFIG.ebus.getFlowTempId) return 'Fehlerzähler: Vorlauftemperatur - Lese-/Watchdog-Fehler';
    if (id === CONFIG.ebus.getReturnTempId) return 'Fehlerzähler: Rücklauftemperatur - Lese-/Watchdog-Fehler';
    if (id === CONFIG.ebus.getOpModeId) return 'Fehlerzähler: Betriebsmodus (Therme) - Lesefehler';
    if (id === CONFIG.ebus.getRoomTempSwitchOnId) return 'Fehlerzähler: Raumaufschaltung (Status) - Lesefehler';

    return `Fehlerzähler für unbekannte ID: ${id}`;
}

/**
 * Legt alle benötigten Datenpunkte im ioBroker an
 */
async function createStates() {
    try {
        if (!(await existsStateAsync(CONFIG.ids.statusGasthermeId))) {
            await createStateAsync(CONFIG.ids.statusGasthermeId, false, { name: 'Status Gastherme', type: 'boolean', role: 'indicator', read: true, write: false });
        }
        if (!(await existsStateAsync(CONFIG.ids.hoechsteAnforderungId))) {
            await createStateAsync(CONFIG.ids.hoechsteAnforderungId, 0, { name: 'Höchste Anforderung Temperatur', type: 'number', role: 'value.temperature', read: true, write: false, unit: '°C' });
        }
        if (!(await existsStateAsync(CONFIG.ids.svSpreizungKorrekturId))) {
            await createStateAsync(CONFIG.ids.svSpreizungKorrekturId, 0, { name: 'Heizkurven-Korrektur durch Spreizung', type: 'number', role: 'value', read: true, write: true });
        }
        if (!(await existsStateAsync(CONFIG.ids.letzteAusfuehrungId))) {
            await createStateAsync(CONFIG.ids.letzteAusfuehrungId, 0, { name: 'Letzte erfolgreiche Ausfuehrung (Timestamp)', type: 'number', role: 'date', read: true, write: false });
        }

        // --- Neu: Fehlerzähler-States anlegen ---
        if (CONFIG.errorTracking.exposeAsStates) {
            for (const id of allMonitoredIds) {
                if (!id) continue;
                const cleanId = id.replace(/\./g, '_');
                const stateId = `${CONFIG.errorTracking.baseId}.${cleanId}`;
                const stateName = getErrorStateName(id);
                
                if (!(await existsStateAsync(stateId))) {
                    await createStateAsync(stateId, 0, { name: stateName, type: 'number', role: 'value', read: true, write: false, def: 0 });
                } else {
                    // Vorhandene Fehlerzähler beim Skript-Neustart einlesen (Persistenz)
                    const existingState = await getStateAsync(stateId);
                    if (existingState && typeof existingState.val === 'number') {
                        errorCounters[id] = existingState.val;
                    }
                }
            }
            sysLog(`Fehler-Tracking States wurden unter ${CONFIG.errorTracking.baseId} geprüft/angelegt.`, 'debug');
        }
    } catch (e) {
        sysLog(`Fehler bei der Objekterstellung: ${e.message}`, 'error');
    }
}

// -------------------------------------------------------------------------------------
// 3. HAUPTFUNKTION
// -------------------------------------------------------------------------------------
async function main() {
    statsRunCounter++;
    if (statsRunCounter > 1000000) statsRunCounter = 1; // Überlaufschutz
    
    sysLog(`Starte Bedarfsermittlung (Lauf #${statsRunCounter})...`, 'debug');

    // 1. Raumaufschaltung prüfen (Failsafe mit Erfolgsprüfung)
    const roomTempSwitchState = await safeGetState(CONFIG.ebus.getRoomTempSwitchOnId);
    if (roomTempSwitchState) {
        const isOff = convertType(roomTempSwitchState.val, 'boolean') === false || roomTempSwitchState.val === 'off' || roomTempSwitchState.val === 0;
        if (!isOff) {
            sysLog('Raumaufschaltung war aktiv und wird entmachtet.', 'warn');
            try { 
                await setStateAsync(CONFIG.ebus.setRoomTempSwitchOnId, 0, true); 
                setTimeout(async () => {
                    const checkState = await safeGetState(CONFIG.ebus.getRoomTempSwitchOnId);
                    if (checkState && checkState.val !== 0 && checkState.val !== 'off') {
                        sysLog('WARNUNG: Raumaufschaltung konnte nicht dauerhaft deaktiviert werden!', 'error');
                    }
                }, 2000);
            } catch(e){
                sysLog(`Fehler beim Setzen der Raumaufschaltung: ${e.message}`, 'error');
            }
        }
    }

    // 2. Heizperiode prüfen
    const heizperiodeState = await safeGetState(CONFIG.ids.svHeizperiodeId, 'boolean');
    if (!heizperiodeState || !heizperiodeState.val) {
        sysLog("Heizperiode ist 'aus'. Schalte Heizkreis ab.", 'info');
        try {
            await setStateAsync(CONFIG.ids.statusGasthermeId, false, true);
            await setStateAsync(CONFIG.ebus.setOpModeId, 0, true);
        } catch (e) { sysLog(`Fehler beim Abschalten: ${e.message}`, 'error'); }
        return;
    }

    // 3. Raumbedarf ermitteln
    let maxSollTemp = 0;
    let gesamtHeizbedarf = false;
    let heizendeRaeume = 0;

    for (const room of CONFIG.rooms) {
        const sollTempState = await safeGetState(room.thermostatSetPointId, 'number');
        const actualTempState = await safeGetState(room.actualTempId, 'number');
        const levelState = await safeGetState(room.levelId, 'number'); 

        if (sollTempState && actualTempState) {
            // Plausibilitätsprüfung Raumtemperatur
            if (actualTempState.val < CONFIG.stabilisierung.plausibilitaet.minRaumTemp || 
                actualTempState.val > CONFIG.stabilisierung.plausibilitaet.maxRaumTemp) {
                sysLog(`Unglaubwürdige Raumtemperatur in ${room.roomName}: ${actualTempState.val}°C. Ignoriere Raum für diesen Zyklus.`, 'warn');
                continue; // Überspringe diesen Raum
            }

            const ventilOffen = levelState ? (levelState.val >= CONFIG.ventilSchwelle) : false;
            const tempBedarf = actualTempState.val < (sollTempState.val - CONFIG.toleranzTemp);
            
            if (tempBedarf || ventilOffen) {
                gesamtHeizbedarf = true;
                heizendeRaeume++;
                if (sollTempState.val > maxSollTemp) maxSollTemp = sollTempState.val;
            }
        }
    }

    // Status wegschreiben
    try {
        await setStateAsync(CONFIG.ids.statusGasthermeId, gesamtHeizbedarf, true);
        await setStateAsync(CONFIG.ids.hoechsteAnforderungId, maxSollTemp, true);
    } catch (e) { sysLog(`Fehler beim Schreiben der Status-States: ${e.message}`, 'error'); }
    
    // 4. Anlagensteuerung
    if (gesamtHeizbedarf) {
        const opModeState = await safeGetState(CONFIG.ebus.getOpModeId);
        if (opModeState && opModeState.val !== 'auto') {
            sysLog("Heizbedarf erkannt. Schalte Heizkreis ein ('auto').", 'info');
            try { await setStateAsync(CONFIG.ebus.setOpModeId, 1, true); } catch(e) {}
        }

        if (maxSollTemp > 5.0) {
            try { await setStateAsync(CONFIG.ebus.setDayTempId, parseFloat(maxSollTemp.toFixed(1)), true); } catch(e){}
        }

        // 5. Heizkurven-Berechnung
        const anzahlRaeume = CONFIG.rooms.length;
        const lastAnpassung = (heizendeRaeume / anzahlRaeume) * CONFIG.heizkurve.maxAnpassung;
        let neueHeizkurve = CONFIG.heizkurve.basis + lastAnpassung;

        let spreizungKorrektur = 0.0;
        if (CONFIG.spreizungsRegelung.aktiv) {
            const gespeicherteKorrekturState = await safeGetState(CONFIG.ids.svSpreizungKorrekturId, 'number');
            let aktuelleKorrektur = gespeicherteKorrekturState ? (gespeicherteKorrekturState.val || 0.0) : 0.0;
            
            const aussenTempState = await safeGetState(CONFIG.ids.aussenTempId, 'number');
            let aussenTempValid = false;
            
            // Plausibilität Außentemperatur
            if (aussenTempState && 
                aussenTempState.val >= CONFIG.stabilisierung.plausibilitaet.minAussenTemp && 
                aussenTempState.val <= CONFIG.stabilisierung.plausibilitaet.maxAussenTemp) {
                aussenTempValid = true;
            } else if (aussenTempState) {
                sysLog(`Unglaubwürdige Außentemperatur: ${aussenTempState.val}°C. Pausiere Optimierung.`, 'warn');
            }

            if (aussenTempValid && aussenTempState.val < CONFIG.stabilisierung.maxAussenTemp) {
                const flowTempState = await safeGetState(CONFIG.ebus.getFlowTempId, 'number');
                const returnTempState = await safeGetState(CONFIG.ebus.getReturnTempId, 'number');

                if (flowTempState && returnTempState && 
                    flowTempState.val > CONFIG.spreizungsRegelung.minFlowTemp && 
                    returnTempState.val > CONFIG.spreizungsRegelung.minReturnTemp) {
                    
                    const aktuelleSpreizung = flowTempState.val - returnTempState.val;
                    
                    // Plausibilitätsprüfung Spreizung
                    if (aktuelleSpreizung < CONFIG.stabilisierung.plausibilitaet.minSpreizung || 
                        aktuelleSpreizung > CONFIG.stabilisierung.plausibilitaet.maxSpreizung) {
                        sysLog(`Unglaubwürdige Spreizung ermittelt: ${aktuelleSpreizung.toFixed(1)}K. Ignoriere Wert.`, 'warn');
                        spreizungKorrektur = aktuelleKorrektur;
                    } else {
                        const fehler = CONFIG.spreizungsRegelung.zielSpreizung - aktuelleSpreizung;
                        
                        if (Math.abs(fehler) > CONFIG.stabilisierung.neutralzoneSpreizung) {
                            const anpassungsSchritt = -1 * fehler * CONFIG.spreizungsRegelung.anpassungsFaktor;
                            let neueKorrektur = aktuelleKorrektur + anpassungsSchritt;
                            neueKorrektur = Math.max(CONFIG.spreizungsRegelung.maxAbsenkung, Math.min(CONFIG.spreizungsRegelung.maxAnhebung, neueKorrektur));

                            sysLog(`Spreizung: ${aktuelleSpreizung.toFixed(1)}K (Fehler: ${(-fehler).toFixed(1)}K). Korr: ${aktuelleKorrektur.toFixed(3)} -> Neu: ${neueKorrektur.toFixed(3)}`, 'info');
                            
                            try { await setStateAsync(CONFIG.ids.svSpreizungKorrekturId, neueKorrektur, true); } catch(e){}
                            spreizungKorrektur = neueKorrektur;
                        } else {
                            sysLog(`Neutralzone - Spreizung: ${aktuelleSpreizung.toFixed(1)}K optimal.`, 'debug');
                            spreizungKorrektur = aktuelleKorrektur;
                        }
                    }
                } else {
                    spreizungKorrektur = aktuelleKorrektur;
                }
            } else {
                sysLog(`Optimierung pausiert (Außentemp ${aussenTempState ? aussenTempState.val : 'N/A'}°C oder ungültig).`, 'debug');
                spreizungKorrektur = aktuelleKorrektur;
            }
        }

        neueHeizkurve += spreizungKorrektur;
        neueHeizkurve = Math.max(cachedMinKurve, Math.min(cachedMaxKurve, neueHeizkurve));
        
        const finalCurve = parseFloat(neueHeizkurve.toFixed(1));
        sysLog(`Last: ${lastAnpassung.toFixed(2)}, Spreiz-Korr: ${spreizungKorrektur.toFixed(2)} -> Finale Heizkurve: ${finalCurve}`, 'info');
        
        try { await setStateAsync(CONFIG.ebus.setHeatCurveId, finalCurve, true); } catch(e){}

    } else {
        const opModeState = await safeGetState(CONFIG.ebus.getOpModeId);
        const isOff = opModeState ? convertType(opModeState.val, 'boolean') === false || opModeState.val === 'off' || opModeState.val === 0 : false;
        
        if (isOff) {
            sysLog("Kein Heizbedarf. Heizkreis ist bereits aus.", 'debug');
        } else {
            sysLog("Kein Heizbedarf. Schalte Heizkreis aus ('off').", 'info');
            try { await setStateAsync(CONFIG.ebus.setOpModeId, 0, true); } catch(e){}
        }
    }
    
    // Monitoring Update
    try { await setStateAsync(CONFIG.ids.letzteAusfuehrungId, Date.now(), true); } catch(e){}
}

// -------------------------------------------------------------------------------------
// 4. SKRIPT-START & TRIGGER
// -------------------------------------------------------------------------------------
(async () => {
    sysLog('Initialisiere Skript V8.0...', 'info');
    initConfig();
    await createStates();

    const triggerIds = Array.from(allMonitoredIds); // Nimmt nun alle gesammelten IDs für die Trigger
    
    // Hybride Throttle/Debounce-Logik
    on({ id: triggerIds, change: "ne" }, (obj) => {
        const now = Date.now();
        sysLog(`Trigger von ${obj.id} empfangen.`, 'debug');
        
        if (now - lastExecution < CONFIG.trigger.throttleTime) {
            // Zu viele Events: Debounce
            if (executionTimeout) clearTimeout(executionTimeout);
            executionTimeout = setTimeout(() => {
                lastExecution = Date.now();
                main();
            }, CONFIG.trigger.debounceDelay);
        } else {
            // Ausreichend Pause dazwischen: Sofort ausführen
            if (executionTimeout) clearTimeout(executionTimeout);
            lastExecution = now;
            main();
        }
    });
    
    // Periodischer Fallback-Trigger
    schedule('*/5 * * * *', main);
    
    // Einmaliger Start
    setTimeout(main, 3000);
})();

// --- Graceful Shutdown ---
onStop(function (callback, timeout) {
    sysLog('Skript wird gestoppt - Therme bleibt im letzten sicheren Zustand (Graceful Shutdown)', 'warn');
    if (executionTimeout) clearTimeout(executionTimeout);
    callback();
}, 2000);

})(); // Ende der Kapselung