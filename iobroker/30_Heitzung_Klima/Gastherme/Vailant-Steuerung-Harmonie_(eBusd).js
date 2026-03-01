/**
 * @fileoverview Zentrale, intelligente & modulierende Heizungssteuerung für ioBroker
 * @version 5.2 (Harmonisierte Regelgrenzen)
 * @author Ihr Name / Gemini
 * @license MIT
 *
 * -------------------------------------------------------------------------------------
 * ZWECK DES SKRIPTS:
 * -------------------------------------------------------------------------------------
 * Dieses Skript steuert die zentrale Heiztherme durch eine intelligente, dynamische
 * Anpassung der witterungsgeführten Heizkurve. Es lernt die optimale Einstellung
 * für das Gebäude und reagiert nur auf echte, systemische Anforderungen.
 *
 * NEU in V5.2 (Harmonisierung):
 * - KONSISTENTE REGELGRENZEN: Der Wert für 'maxAnpassung' wurde an 'maxAbsenkung'
 * angeglichen. Die lernende Regelung und die absoluten Leitplanken sind nun
 * synchronisiert, was der Steuerung den vollen, beabsichtigten Spielraum gibt.
 * -------------------------------------------------------------------------------------
 */

(function(){ // Start der Kapselung
    "use strict";

// --- Globale Variable für Debounce-Timer ---
let executionTimeout = null;

// -------------------------------------------------------------------------------------
// 1. ZENTRALE KONFIGURATION
// -------------------------------------------------------------------------------------
const CONFIG = {
    // --- A. GRUNDEINSTELLUNGEN ---
    debugLogAktiv: true,
    toleranzTemp: 0.2,
    debounceDelay: 2000, // 2 Sekunden warten nach einem Trigger, um weitere Updates zu sammeln

    // --- B. HEIZKURVEN-STEUERUNG ---
    heizkurve: {
        basis: 1.2,
        maxAnpassung: 0.4, // Harmonisiert mit maxAbsenkung, um vollen Spielraum zu ermöglichen
    },
    
    // --- C. INTEGRALE SPREIZUNGS-STEUERUNG (DER "AUTOPILOT") ---
    spreizungsRegelung: {
        aktiv: true,
        zielSpreizung: 9.0,
        anpassungsFaktor: 0.003, // Kleiner Wert für langsame Anpassung
        maxAbsenkung: -0.4, // Erhöht von -0.3, um mehr Spielraum nach unten zu geben
        maxAnhebung: 0.2,
    },

    // --- D. STABILISIERUNGS-LOGIK ---
    stabilisierung: {
        maxAussenTemp: 5.0,
        neutralzoneSpreizung: 0.5
    },

    // --- E. RAUMKONFIGURATION ---
    rooms: [
        { roomName: 'Wohnzimmer',   thermostatSetPointId: 'hm-rpc.2.INT0000005.1.SET_POINT_TEMPERATURE' },
        { roomName: 'Schlafzimmer', thermostatSetPointId: 'hm-rpc.2.INT0000001.1.SET_POINT_TEMPERATURE' },
        { roomName: 'Badezimmer',   thermostatSetPointId: 'hm-rpc.2.INT0000002.1.SET_POINT_TEMPERATURE' },
        { roomName: 'Kueche',       thermostatSetPointId: 'hm-rpc.2.INT0000003.1.SET_POINT_TEMPERATURE' },
        { roomName: 'Esszimmer',    thermostatSetPointId: 'hm-rpc.2.INT0000004.1.SET_POINT_TEMPERATURE' },
    ],

    // --- F. EBUS-ADAPTER KONFIGURATION ---
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

    // --- G. ioBroker OBJEKT-IDs ---
    ids: {
        svHeizperiodeId: '0_userdata.0.Heizung.Allgemein.HeizperiodeAktiv',
        statusGasthermeId: '0_userdata.0.Heizung.Zentral.StatusTherme',
        hoechsteAnforderungId: '0_userdata.0.Heizung.Zentral.HoechsteAnforderungTemp',
        svSpreizungKorrekturId: '0_userdata.0.Heizung.Zentral.SpreizungKorrektur',
        aussenTempId: 'hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE',
    }
};

// -------------------------------------------------------------------------------------
// 2. SKRIPT-INITIALISIERUNG
// -------------------------------------------------------------------------------------
async function createStates() {
    if (!(await existsStateAsync(CONFIG.ids.statusGasthermeId))) {
        await createStateAsync(CONFIG.ids.statusGasthermeId, false, { name: 'Status Gastherme', type: 'boolean', role: 'indicator', read: true, write: false, def: false });
    }
    if (!(await existsStateAsync(CONFIG.ids.hoechsteAnforderungId))) {
        await createStateAsync(CONFIG.ids.hoechsteAnforderungId, 0, { name: 'Höchste Anforderung Temperatur', type: 'number', role: 'value.temperature', read: true, write: false, unit: '°C', def: 0 });
    }
    if (!(await existsStateAsync(CONFIG.ids.svSpreizungKorrekturId))) {
        await createStateAsync(CONFIG.ids.svSpreizungKorrekturId, 0, { name: 'Heizkurven-Korrektur durch Spreizung', type: 'number', role: 'value', read: true, write: true, unit: '', def: 0 });
    }
}

// -------------------------------------------------------------------------------------
// 3. HAUPTFUNKTION
// -------------------------------------------------------------------------------------
async function main() {
    log('[Zentral] Starte Bedarfsermittlung...', 'info');

    try {
        const roomTempSwitchState = await getStateAsync(CONFIG.ebus.getRoomTempSwitchOnId);
        if (roomTempSwitchState && roomTempSwitchState.val !== 'off') {
            log('[Zentral|FAILSAFE] Raumaufschaltung war aktiv und wurde jetzt entmachtet.', 'warn');
            await setStateAsync(CONFIG.ebus.setRoomTempSwitchOnId, 0, true);
        } else if (roomTempSwitchState && roomTempSwitchState.val === 'off') {
            log('[Zentral|INFO] Prüfung: Raumaufschaltung ist korrekt entmachtet.', 'info');
        }
    } catch (e) {
        log(`[Zentral|FAILSAFE] Fehler bei der Prüfung der Raumaufschaltung: ${e}`, 'error');
    }

    const heizperiodeState = await getStateAsync(CONFIG.ids.svHeizperiodeId);
    if (!heizperiodeState || !heizperiodeState.val) {
        if (CONFIG.debugLogAktiv) log("[Zentral] Heizperiode ist 'aus'. Schalte Heizkreis aus.");
        await setStateAsync(CONFIG.ids.statusGasthermeId, false, true);
        await setStateAsync(CONFIG.ebus.setOpModeId, 0, true);
        return;
    }

    let maxSollTemp = 0;
    let gesamtHeizbedarf = false;
    let heizendeRaeume = 0;

    for (const room of CONFIG.rooms) {
        const setPointId = room.thermostatSetPointId;
        const actualTempId = setPointId.replace('SET_POINT_TEMPERATURE', 'ACTUAL_TEMPERATURE');
        const levelId = setPointId.replace('SET_POINT_TEMPERATURE', 'LEVEL');

        const sollTempState = await getStateAsync(setPointId);
        const actualTempState = await getStateAsync(actualTempId);
        const levelState = await getStateAsync(levelId);

        if (sollTempState && actualTempState && levelState) {
            const hasDemand = (actualTempState.val < (sollTempState.val - CONFIG.toleranzTemp)) || (levelState.val >= 0.1);
            if (hasDemand) {
                gesamtHeizbedarf = true;
                heizendeRaeume++;
                if (sollTempState.val > maxSollTemp) maxSollTemp = sollTempState.val;
            }
        }
    }

    await setStateAsync(CONFIG.ids.statusGasthermeId, gesamtHeizbedarf, true);
    await setStateAsync(CONFIG.ids.hoechsteAnforderungId, maxSollTemp, true);
    
    if (gesamtHeizbedarf) {
        try {
            const opModeState = await getStateAsync(CONFIG.ebus.getOpModeId);
            if (opModeState && opModeState.val === 'auto') {
                if (CONFIG.debugLogAktiv) log("[Zentral] Heizbedarf erkannt. Heizkreis ist bereits an ('auto').");
            } else {
                if (CONFIG.debugLogAktiv) log("[Zentral] Heizbedarf erkannt. Schalte Heizkreis ein ('auto').");
                await setStateAsync(CONFIG.ebus.setOpModeId, 1, true);
            }
        } catch(e) {
            log(`[Zentral] Fehler beim Prüfen des OpMode, setze 'auto' vorsorglich: ${e}`, 'warn');
            await setStateAsync(CONFIG.ebus.setOpModeId, 1, true);
        }

        if (maxSollTemp > 5.0) {
            await setStateAsync(CONFIG.ebus.setDayTempId, parseFloat(maxSollTemp.toFixed(1)), true);
        }

        const anzahlRaeume = CONFIG.rooms.length;
        const lastAnpassung = (heizendeRaeume / anzahlRaeume) * CONFIG.heizkurve.maxAnpassung;
        let neueHeizkurve = CONFIG.heizkurve.basis + lastAnpassung;

        let spreizungKorrektur = 0.0;
        if (CONFIG.spreizungsRegelung.aktiv) {
            const gespeicherteKorrekturState = await getStateAsync(CONFIG.ids.svSpreizungKorrekturId);
            let aktuelleKorrektur = gespeicherteKorrekturState ? (gespeicherteKorrekturState.val || 0.0) : 0.0;
            
            const aussenTempState = await getStateAsync(CONFIG.ids.aussenTempId);
            if (aussenTempState && typeof aussenTempState.val === 'number' && aussenTempState.val < CONFIG.stabilisierung.maxAussenTemp) {
                const flowTempState = await getStateAsync(CONFIG.ebus.getFlowTempId);
                const returnTempState = await getStateAsync(CONFIG.ebus.getReturnTempId);

                if (flowTempState && returnTempState && typeof flowTempState.val === 'number' && typeof returnTempState.val === 'number' && flowTempState.val > 30 && returnTempState.val > 0) {
                    const aktuelleSpreizung = flowTempState.val - returnTempState.val;
                    const fehler = CONFIG.spreizungsRegelung.zielSpreizung - aktuelleSpreizung;
                    
                    if (Math.abs(fehler) > CONFIG.stabilisierung.neutralzoneSpreizung) {
                        const anpassungsSchritt = -1 * fehler * CONFIG.spreizungsRegelung.anpassungsFaktor;
                        let neueKorrektur = aktuelleKorrektur + anpassungsSchritt;
                        neueKorrektur = Math.max(CONFIG.spreizungsRegelung.maxAbsenkung, Math.min(CONFIG.spreizungsRegelung.maxAnhebung, neueKorrektur));

                        if (CONFIG.debugLogAktiv) log(`[Zentral|Korrektur Aktiv] Spreizung: ${aktuelleSpreizung.toFixed(1)}K (Fehler: ${(-fehler).toFixed(1)}K). Korrektur: ${aktuelleKorrektur.toFixed(3)} -> Neu: ${neueKorrektur.toFixed(3)}`);
                        
                        await setStateAsync(CONFIG.ids.svSpreizungKorrekturId, neueKorrektur, true);
                        spreizungKorrektur = neueKorrektur;
                    } else {
                        if (CONFIG.debugLogAktiv) log(`[Zentral|Neutralzone] Spreizung: ${aktuelleSpreizung.toFixed(1)}K. Wert ist optimal.`);
                        spreizungKorrektur = aktuelleKorrektur;
                    }
                } else {
                    spreizungKorrektur = aktuelleKorrektur;
                }
            } else {
                if (CONFIG.debugLogAktiv) log(`[Zentral|Optimierung Pausiert] Außentemp: ${aussenTempState ? aussenTempState.val : 'N/A'}°C. Nutze gespeicherte Korrektur: ${aktuelleKorrektur.toFixed(3)}`);
                spreizungKorrektur = aktuelleKorrektur;
            }
        }

        neueHeizkurve += spreizungKorrektur;
        
        const minKurve = CONFIG.heizkurve.basis - CONFIG.heizkurve.maxAnpassung;
        const maxKurve = CONFIG.heizkurve.basis + CONFIG.heizkurve.maxAnpassung;
        neueHeizkurve = Math.max(minKurve, Math.min(maxKurve, neueHeizkurve));
        
        const finalCurve = parseFloat(neueHeizkurve.toFixed(1));

        if (CONFIG.debugLogAktiv) log(`[Zentral] Last: ${lastAnpassung.toFixed(2)}, Spreiz-Korr: ${spreizungKorrektur.toFixed(2)} -> Finale Heizkurve: ${finalCurve}`);
        
        await setStateAsync(CONFIG.ebus.setHeatCurveId, finalCurve, true);

    } else {
        try {
            const opModeState = await getStateAsync(CONFIG.ebus.getOpModeId);
            if (opModeState && opModeState.val === 'off') {
                if (CONFIG.debugLogAktiv) log("[Zentral] Kein Heizbedarf. Heizkreis ist bereits aus ('off').");
            } else {
                if (CONFIG.debugLogAktiv) log("[Zentral] Kein Heizbedarf. Schalte Heizkreis aus ('off').");
                await setStateAsync(CONFIG.ebus.setOpModeId, 0, true);
            }
        } catch(e) {
            log(`[Zentral] Fehler beim Prüfen des OpMode, setze 'off' vorsorglich: ${e}`, 'warn');
            await setStateAsync(CONFIG.ebus.setOpModeId, 0, true);
        }
    }
}

// -------------------------------------------------------------------------------------
// 4. SKRIPT-START & TRIGGER
// -------------------------------------------------------------------------------------
(async () => {
    await createStates();

    const triggerIds = [CONFIG.ids.svHeizperiodeId];
    CONFIG.rooms.forEach(room => {
        triggerIds.push(room.thermostatSetPointId);
        triggerIds.push(room.thermostatSetPointId.replace('SET_POINT_TEMPERATURE', 'ACTUAL_TEMPERATURE'));
        triggerIds.push(room.thermostatSetPointId.replace('SET_POINT_TEMPERATURE', 'LEVEL'));
    });

    if (CONFIG.ebus.getFlowTempId) triggerIds.push(CONFIG.ebus.getFlowTempId);
    if (CONFIG.ebus.getReturnTempId) triggerIds.push(CONFIG.ebus.getReturnTempId);
    if (CONFIG.ids.aussenTempId) triggerIds.push(CONFIG.ids.aussenTempId);
    
    // --- NEU: Debounce-Logik ---
    on({ id: triggerIds, change: "ne" }, (obj) => {
        if(CONFIG.debugLogAktiv) log(`Trigger von ${obj.id} empfangen. Starte Debounce-Timer (${CONFIG.debounceDelay}ms).`);
        if (executionTimeout) {
            clearTimeout(executionTimeout);
        }
        executionTimeout = setTimeout(main, CONFIG.debounceDelay);
    });
    
    // Periodischer Trigger bleibt unberührt
    schedule('*/5 * * * *', main);
    
    // Einmaliger Start zur Initialisierung
    setTimeout(main, 5000);
})();

})(); // Ende der Kapselung

