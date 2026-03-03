/**
 * @fileoverview Wetterdaten-Analyse-Skript für proaktive Heizungssteuerung
 * @version 3.0 (Final)
 * @author Sanweb
 * @license MIT
 *
 * -------------------------------------------------------------------------------------
 * ZWECK DES SKRIPTS:
 * -------------------------------------------------------------------------------------
 * Dieses Skript ist die zentrale Intelligenz-Schicht für die Wetteranalyse. Es ermittelt
 * proaktiv den Einfluss von Sonne und Wind auf das Gebäude und berechnet daraus
 * richtungsspezifische Faktoren. Diese Faktoren werden von den Einzelraum-Regelungs-
 * skripten genutzt, um die Heizungs-Soll-Temperatur vorausschauend anzupassen.
 *
 * -------------------------------------------------------------------------------------
 * KERNFUNKTIONEN:
 * -------------------------------------------------------------------------------------
 * 1. PHYSIKALISCHES SOLAR-MODELL: Der solare Gewinn wird nicht nur pauschal erfasst,
 * sondern mit dem Sinus der Sonnenhöhe gewichtet. Dies bildet die tatsächliche
 * Energieintensität bei flachem Einfallswinkel (Morgen-/Abendsonne) physikalisch
 * korrekt ab und verhindert eine Überbewertung.
 *
 * 2. DETAILLIERTE SONNENSTANDS-PRÜFUNG: Der solare Gewinn wird nur berechnet, wenn die
 * Sonne eine in der Konfiguration definierte Mindesthöhe und einen bestimmten
 * Winkelbereich (Azimut) erreicht. Dies ermöglicht die präzise Berücksichtigung
 * von Hindernissen wie Nachbargebäuden oder Bäumen.
 *
 * 3. ERWEITERTES WIND-MODELL: Berücksichtigt nicht nur den direkten Winddruck
 * (Luv-Seite), sondern auch die indirekte Auskühlung an windabgewandten Seiten
 * durch Sog-Effekte (Lee-Seite), um eine Gesamtauskühlung des Gebäudes abzubilden.
 *
 * 4. ROBUSTHEIT: Das Skript stürzt nicht ab, wenn die 'suncalc'-Bibliothek fehlt,
 * sondern gibt eine klare Fehlermeldung aus und überspringt lediglich die Solar-Analyse.
 *
 * -------------------------------------------------------------------------------------
 * VORAUSSETZUNGEN & EMPFEHLUNGEN:
 * -------------------------------------------------------------------------------------
 * - Die 'suncalc'-Bibliothek muss im JavaScript-Adapter eingetragen sein.
 * - Empfohlene Ausführungshäufigkeit: Alle 5 bis 15 Minuten.
 */

(function(){ // Start der Kapselung, um globale Variablen zu vermeiden
    "use strict";

// --- Robustheits-Prüfung: suncalc-Bibliothek laden ---
let suncalc;
let suncalcAvailable = false;
try {
    // @ts-ignore
    suncalc = require('suncalc');
    suncalcAvailable = true;
} catch (e) {
    log('[Wetter-Analyse] FEHLER: Die "suncalc"-Bibliothek wurde nicht im JavaScript-Adapter gefunden. Die Solar-Analyse wird übersprungen.', 'error');
}


// -------------------------------------------------------------------------------------
// 1. ZENTRALE KONFIGURATION
// -------------------------------------------------------------------------------------
const CONFIG = {
    // --- A. GRUNDEINSTELLUNGEN ---
    debugLogAktiv: true,
    autoCreateStates: true,

    // --- B. STANDORT-KONFIGURATION (WICHTIG & ERFORDERLICH) ---
    // Exakte Koordinaten sind für eine genaue Sonnenstandsberechnung unerlässlich.
    standort: {
        breitengrad: 52.042402075167075,
        laengengrad: 8.48875812214296,
    },

    // --- C. PHYSIKALISCHE MODELLE ---
    // Faktor für die indirekte Auskühlung an nicht direkt vom Wind getroffenen Wänden.
    // Ein Wert von 0.25 bedeutet, dass diese Wände 25% des Auskühlungseffekts der Hauptwindrichtung erfahren.
    windAbschwaechung: 0.25,

    // --- D. KONFIGURATION DER FENSTER UND SONNENEINSTRAHLUNG ---
    // Tipp: Nutzen Sie eine Webseite wie suncalc.org, um den Sonnenverlauf an Ihrem Standort
    // zu visualisieren und die Winkel für Ihre Fenster präzise zu bestimmen.
    fensterAusrichtung: {
        // minHoehe: Mindesthöhe in Grad, die die Sonne haben muss (um über Hindernisse zu scheinen).
        // azimutVon/Bis: Winkelbereich in Grad (0°=N, 90°=O, 180°=S, 270°=W), in dem die Sonne das Fenster trifft.
        'Sued':  { minHoehe: 12, azimutVon: 130, azimutBis: 230 },
        'West':  { minHoehe: 10,  azimutVon: 230, azimutBis: 280 },
        'Ost':   { minHoehe: 10,  azimutVon: 80,  azimutBis: 130 },
        'Nord':  { minHoehe: 15, azimutVon: 330, azimutBis: 30 } // Bereich über 360/0 Grad wird korrekt behandelt
    },

    // --- E. INPUT-IDs: WETTERSTATION ---
    weatherIds: {
        solarradiation: '0_userdata.0.Wetter.solarradiation',
        windspeed: '0_userdata.0.Wetter.windspeed',
        winddir: '0_userdata.0.Wetter.winddir',
    },

    // --- F. OUTPUT-IDs: ZIEL-DATENPUNKTE ---
    outputIds: {
        aktuellerZustand: '0_userdata.0.Heizung.Analyse.Wetter_AktuellerZustand',
        basisPfadSolar: '0_userdata.0.Heizung.Analyse.Wetter_Heizunterstuetzung_Solar',
        basisPfadWind: '0_userdata.0.Heizung.Analyse.Wetter_Waermeverlust_Wind',
    },
};

// -------------------------------------------------------------------------------------
// 2. SKRIPT-INITIALISIERUNG
// -------------------------------------------------------------------------------------
async function createStates() {
    if (!CONFIG.autoCreateStates) return;
    if (CONFIG.debugLogAktiv) log('[Wetter-Analyse] Prüfe und erstelle Datenpunkte...');

    const idZustand = CONFIG.outputIds.aktuellerZustand;
    if (!(await existsStateAsync(idZustand))) {
        await createStateAsync(idZustand, 'unbekannt', { name: 'Wetter: Aktueller Zustand', type: 'string', role: 'text', def: 'unbekannt', read: true, write: false });
    }

    const richtungen = ['Nord', 'Ost', 'Sued', 'West'];
    for (const richtung of richtungen) {
        const solarId = `${CONFIG.outputIds.basisPfadSolar}_${richtung}`;
        if (!(await existsStateAsync(solarId))) {
            await createStateAsync(solarId, 0, { name: `Wetter: Heizunterstützung Solar ${richtung}`, type: 'number', role: 'value', unit: 'Faktor', def: 0, read: true, write: false });
        }
        const windId = `${CONFIG.outputIds.basisPfadWind}_${richtung}`;
        if (!(await existsStateAsync(windId))) {
            await createStateAsync(windId, 1, { name: `Wetter: Wärmeverlust Wind ${richtung}`, type: 'number', role: 'value', unit: 'Faktor', def: 1, read: true, write: false });
        }
    }
}

// -------------------------------------------------------------------------------------
// 3. DATENBESCHAFFUNG & HILFSFUNKTIONEN
// -------------------------------------------------------------------------------------
async function getCurrentData() {
    const data = {};
    for (const key in CONFIG.weatherIds) {
        const state = await getStateAsync(CONFIG.weatherIds[key]);
        data[key] = state ? state.val : null;
    }
    return data;
}

function gradToHimmelsrichtung(deg) {
    if (deg === null || typeof deg === 'undefined') return 'Nord';
    if (deg > 315 || deg <= 45) return 'Nord';
    if (deg > 45 && deg <= 135) return 'Ost';
    if (deg > 135 && deg <= 225) return 'Sued';
    if (deg > 225 && deg <= 315) return 'West';
    return 'Nord';
}

// -------------------------------------------------------------------------------------
// 4. ANALYSE-SCHICHTEN
// -------------------------------------------------------------------------------------
function analyseCurrentData(data) {
    // --- Windanalyse ---
    const waermeverlustWind = { Nord: 1.0, Ost: 1.0, Sued: 1.0, West: 1.0 };
    if (data.winddir !== null && data.windspeed > 5) {
        const windRichtung = gradToHimmelsrichtung(data.winddir);
        const zusaetzlicherFaktor = ((data.windspeed || 0) / 65);
        
        waermeverlustWind[windRichtung] = 1 + zusaetzlicherFaktor;

        const richtungen = ['Nord', 'Ost', 'Sued', 'West'];
        for (const r of richtungen) {
            if (r !== windRichtung) {
                waermeverlustWind[r] = 1 + (zusaetzlicherFaktor * CONFIG.windAbschwaechung);
            }
        }
    }
    
    // --- Solaranalyse ---
    const heizunterstuetzungSolar = { Nord: 0.0, Ost: 0.0, Sued: 0.0, West: 0.0 };
    if (suncalcAvailable && data.solarradiation > 50) {
        const now = new Date();
        const sunPos = suncalc.getPosition(now, CONFIG.standort.breitengrad, CONFIG.standort.laengengrad);
        
        const sunAltitudeDeg = sunPos.altitude * 180 / Math.PI;
        if (sunAltitudeDeg > 0) {
            let sunAzimutDeg = (sunPos.azimuth * 180 / Math.PI) + 180;
            if (sunAzimutDeg >= 360) sunAzimutDeg -= 360;

            for (const richtung in CONFIG.fensterAusrichtung) {
                const fenster = CONFIG.fensterAusrichtung[richtung];
                const isAzimutInNordRange = (fenster.azimutVon > fenster.azimutBis) && (sunAzimutDeg >= fenster.azimutVon || sunAzimutDeg <= fenster.azimutBis);
                const isAzimutInNormalRange = (fenster.azimutVon <= fenster.azimutBis) && (sunAzimutDeg >= fenster.azimutVon && sunAzimutDeg <= fenster.azimutBis);

                if (sunAltitudeDeg >= fenster.minHoehe && (isAzimutInNormalRange || isAzimutInNordRange)) {
                    const basisSolarFaktor = Math.min(1, Math.max(0, (data.solarradiation || 0) / 800));
                    const gewichteterSolarFaktor = basisSolarFaktor * Math.sin(sunPos.altitude);
                    
                    heizunterstuetzungSolar[richtung] = gewichteterSolarFaktor;
                }
            }
        }
    }

    // --- Zustandstext ---
    let zustand = data.solarradiation > 400 ? 'Sonnig' : 'Bedeckt';
    zustand += data.windspeed > 25 ? ' & windig' : (data.windspeed < 5 ? ' & windstill' : ' & mäßiger Wind');

    return {
        aktuellerZustand: zustand,
        heizunterstuetzungSolar: heizunterstuetzungSolar,
        waermeverlustWind: waermeverlustWind,
    };
}

// -------------------------------------------------------------------------------------
// 5. HAUPTFUNKTION & STEUERUNG
// -------------------------------------------------------------------------------------
async function runAnalysis() {
    if (CONFIG.debugLogAktiv) {
        log(`[Wetter-Analyse] Starte Analyse V${"3.0 (Final)"}. Standort: ${CONFIG.standort.breitengrad}, ${CONFIG.standort.laengengrad}`);
    }

    const currentData = await getCurrentData();
    const result = analyseCurrentData(currentData);

    await setStateAsync(CONFIG.outputIds.aktuellerZustand, result.aktuellerZustand, true);
    
    const solarLogParts = [];
    for (const richtung in result.heizunterstuetzungSolar) {
        const id = `${CONFIG.outputIds.basisPfadSolar}_${richtung}`;
        const val = parseFloat(result.heizunterstuetzungSolar[richtung].toFixed(3));
        await setStateAsync(id, val, true);
        if (val > 0) solarLogParts.push(`Solar(${richtung}):${val}`);
    }

    const windLogParts = [];
    for (const richtung in result.waermeverlustWind) {
        const id = `${CONFIG.outputIds.basisPfadWind}_${richtung}`;
        const val = parseFloat(result.waermeverlustWind[richtung].toFixed(3));
        await setStateAsync(id, val, true);
        if (val > 1) windLogParts.push(`Wind(${richtung}):${val.toFixed(2)}`);
    }

    if (CONFIG.debugLogAktiv) {
        let logMessage = `[Wetter-Analyse] Abgeschlossen. Zustand: "${result.aktuellerZustand}".`;
        if (solarLogParts.length > 0) logMessage += ` ${solarLogParts.join(' ')}`;
        if (windLogParts.length > 0) logMessage += ` ${windLogParts.join(' ')}`;
        log(logMessage);
    }
}

// -------------------------------------------------------------------------------------
// 6. SKRIPT-START & TRIGGER
// -------------------------------------------------------------------------------------
(async () => {
    await createStates();
    
    // Empfohlenes Intervall: 5-15 Minuten
    schedule('*/15 * * * *', runAnalysis);
    
    // Einmaliger Start nach kurzer Verzögerung
    setTimeout(runAnalysis, 5000);
})();

})(); // Ende der Kapselung

