/**
 * @fileoverview Selbstlernende Heizungs-Optimierung (Raum-Verhaltens-Analyse)
 * @version 2.1 (Finalisiert)
 * @author Sanweb
 * @license MIT
 *
 * -------------------------------------------------------------------------------------
 * ZWECK DES SKRIPTS (NEXT-LEVEL):
 * -------------------------------------------------------------------------------------
 * Dieses Skript agiert als das "Gehirn" der Heizungssteuerung. Es ersetzt die
 * bisherige globale Effizienz-Analyse durch eine detaillierte, raumspezifische
 * Verhaltensanalyse mit selbstlernender Feedback-Schleife.
 *
 * FUNKTIONSWEISE (Beobachten, Bewerten, Anpassen):
 * 1. BEOBACHTEN: Das Skript analysiert periodisch die historischen Daten jedes
 * konfigurierten Raumes aus der InfluxDB. Es korreliert die Ursache (Wetter-
 * faktoren) mit der Aktion (Soll-Temperatur) und dem Ergebnis (Ist-Temperatur
 * und Ventilöffnung).
 *
 * 2. BEWERTEN: Es erkennt Muster wie "Überschwingen" (Raum wird zu warm, oft
 * durch unterschätzte Sonneneinstrahlung) oder "Trägheit" (Raum wird nicht
 * warm genug, oft durch unterschätzten Wärmeverlust).
 *
 * 3. ANPASSEN: Basierend auf den erkannten Mustern passt das Skript langsam und
 * iterativ raumspezifische Korrektur-Faktoren an (z.B. "Solar_Korrektur" für
 * das Wohnzimmer). Diese Faktoren werden von den Einzelraum-Regelungsskripten
 * genutzt, um deren Vorhersagegenauigkeit kontinuierlich zu verbessern.
 *
 * NEU in V2.1: Lernt nun unabhängig von der globalen Heizperiode, um auch
 * wertvolle Daten aus den Übergangszeiten (Frühling/Herbst) zu erfassen.
 */

(function(){ // Start der Kapselung, um globale Variablen zu vermeiden
    "use strict";

// -------------------------------------------------------------------------------------
// 1. ZENTRALE KONFIGURATION
// -------------------------------------------------------------------------------------
const CONFIG = {
    // --- A. GRUNDEINSTELLUNGEN ---
    debugLogAktiv: true,
    autoCreateStates: true,

    // --- B. LERN-PARAMETER ---
    analyseZeitraumStunden: 24,   // Zeitraum für die historische Analyse
    lernrate: 0.01,               // Wie stark die Korrekturfaktoren pro Zyklus angepasst werden (z.B. 0.01 = 1%)
    minAbweichungFuerLernen: 0.3, // Mindestabweichung (Ist vs. Soll in °C), damit ein Ereignis als Lern-Input gilt
    
    // Schwellenwerte für Mustererkennung
    ueberschwingenSchwelle: 0.5,  // °C über Soll, gilt als Überschwingen
    traegheitSchwelle: -0.5,      // °C unter Soll, gilt als Trägheit

    // --- C. RÄUME & DATENPUNKTE ---
    // Definieren Sie hier alle Räume, die das Skript lernen und optimieren soll.
    raeume: [
        {
            name: 'Wohnzimmer',
            thermostatId: 'hm-rpc.2.INT0000005.1', // Basis-ID des Thermostats (ohne .STATE)
            wetterAusrichtung: ['Sued', 'West']   // Himmelsrichtungen der Fenster für Wetterdaten
        },
        {
            name: 'Schlafzimmer',
            thermostatId: 'hm-rpc.2.INT0000001.1',
            wetterAusrichtung: ['Sued', 'West']
        },
        {
            name: 'Badezimmer',
            thermostatId: 'hm-rpc.2.INT0000002.1',
            wetterAusrichtung: ['Nord', 'Ost']
        },
        {
            name: 'Kueche',
            thermostatId: 'hm-rpc.2.INT0000003.1',
            wetterAusrichtung: ['Nord', 'Ost']
        },
        {
            name: 'Esszimmer',
            thermostatId: 'hm-rpc.2.INT0000004.1',
            wetterAusrichtung: ['Nord', 'Ost']
        }
    ],

    // Pfade zu den Wetter-Faktoren (Output vom Wetter-Analyse-Skript)
    wetterDatenPfade: {
        basisPfadSolar: '0_userdata.0.Heizung.Analyse.Wetter_Heizunterstuetzung_Solar',
        basisPfadWind: '0_userdata.0.Heizung.Analyse.Wetter_Waermeverlust_Wind',
    },
    
    // Basis-Pfad, unter dem die neuen Lern-Datenpunkte erstellt werden
    lernwerteBasisPfad: '0_userdata.0.Heizung.Lernwerte',

    // --- D. SYSTEM & INFLUXDB ---
    influxdbInstance: 'influxdb.0',
};

// -------------------------------------------------------------------------------------
// 2. SKRIPT-INITIALISIERUNG
// -------------------------------------------------------------------------------------
async function initialisiereDatenpunkte() {
    if (!CONFIG.autoCreateStates) return;

    for (const raum of CONFIG.raeume) {
        const solarKorrekturId = `${CONFIG.lernwerteBasisPfad}.${raum.name}.Solar_Korrektur`;
        if (!(await existsStateAsync(solarKorrekturId))) {
            await createStateAsync(solarKorrekturId, 1.0, {
                name: `Lernwert Solar-Korrektur für ${raum.name}`,
                type: 'number', role: 'value', read: true, write: true,
                def: 1.0, min: 0.5, max: 1.5, unit: 'Faktor'
            });
        }

        const windKorrekturId = `${CONFIG.lernwerteBasisPfad}.${raum.name}.Wind_Korrektur`;
        if (!(await existsStateAsync(windKorrekturId))) {
            await createStateAsync(windKorrekturId, 1.0, {
                name: `Lernwert Wind-Korrektur für ${raum.name}`,
                type: 'number', role: 'value', read: true, write: true,
                def: 1.0, min: 0.5, max: 1.5, unit: 'Faktor'
            });
        }
    }
}

// -------------------------------------------------------------------------------------
// 3. DATENBESCHAFFUNG & -VERARBEITUNG
// -------------------------------------------------------------------------------------

/**
 * Holt alle relevanten Zeitreihen für einen Raum aus der InfluxDB.
 * @param {object} raum - Das Raum-Konfigurationsobjekt.
 * @returns {Promise<object|null>} Ein Objekt mit den Datenreihen oder null bei Fehler.
 */
async function getHistorischeDaten(raum) {
    const end = new Date().getTime();
    const start = end - (CONFIG.analyseZeitraumStunden * 3600 * 1000);
    
    const datenpunkte = {
        ist: `${raum.thermostatId}.ACTUAL_TEMPERATURE`,
        soll: `${raum.thermostatId}.SET_POINT_TEMPERATURE`,
        ventil: `${raum.thermostatId}.LEVEL`,
    };

    // Wetter-Datenpunkte dynamisch hinzufügen
    for(const richtung of raum.wetterAusrichtung) {
        datenpunkte[`solar_${richtung}`] = `${CONFIG.wetterDatenPfade.basisPfadSolar}_${richtung}`;
        datenpunkte[`wind_${richtung}`] = `${CONFIG.wetterDatenPfade.basisPfadWind}_${richtung}`;
    }

    const anfragen = Object.entries(datenpunkte).map(([name, id]) =>
        sendToAsync(CONFIG.influxdbInstance, 'getHistory', {
            id: id,
            options: { start, end, aggregate: 'mean', step: 600000 } // 10-Minuten-Intervalle
        }).then(result => {
            if (result.error) throw new Error(`Fehler bei ${id}: ${result.error}`);
            return { name, data: result.result || [] };
        })
    );

    try {
        const ergebnisse = await Promise.all(anfragen);
        const datenContainer = {};
        ergebnisse.forEach(e => datenContainer[e.name] = e.data);
        return datenContainer;
    } catch (e) {
        log(`[Lern-Skript] Fehler beim Abrufen der Verlaufsdaten für ${raum.name}: ${e.message}`, 'error');
        return null;
    }
}

// -------------------------------------------------------------------------------------
// 4. KERNLOGIK: LERNEN
// -------------------------------------------------------------------------------------

/**
 * Analysiert das Verhalten eines einzelnen Raumes und passt dessen Lernwerte an.
 * @param {object} raum - Das Raum-Konfigurationsobjekt.
 */
async function analysiereRaum(raum) {
    if (CONFIG.debugLogAktiv) log(`[Lern-Skript] Starte Analyse für Raum: ${raum.name}`);

    const historien = await getHistorischeDaten(raum);
    if (!historien || !historien.ist || historien.ist.length === 0) {
        log(`[Lern-Skript] Nicht genügend historische Daten für ${raum.name} vorhanden.`, 'warn');
        return;
    }

    let ueberschwingenEvents = 0;
    let traegheitEvents = 0;

    // Phase 1 & 2: Beobachten und Bewerten
    for (let i = 0; i < historien.ist.length; i++) {
        const ist = historien.ist[i].val;
        const soll = historien.soll.find(p => p.ts === historien.ist[i].ts)?.val;
        const ventil = historien.ventil.find(p => p.ts === historien.ist[i].ts)?.val;
        
        // **Intelligenter Filter:** Nur Datenpunkte analysieren, bei denen aktiv geheizt werden sollte.
        // Dies macht die globale Heizperiode-Prüfung überflüssig.
        if (soll === null || ventil === null || soll < 12) continue;

        const abweichung = ist - soll;

        if (Math.abs(abweichung) < CONFIG.minAbweichungFuerLernen) continue;

        // Finde dominante Wetterursache für diesen Zeitpunkt
        let maxSolar = 0, maxWind = 1;
        raum.wetterAusrichtung.forEach(richtung => {
            const solarVal = historien[`solar_${richtung}`]?.find(p => p.ts === historien.ist[i].ts)?.val;
            if (solarVal > maxSolar) maxSolar = solarVal;
            const windVal = historien[`wind_${richtung}`]?.find(p => p.ts === historien.ist[i].ts)?.val;
            if (windVal > maxWind) maxWind = windVal;
        });

        // Mustererkennung
        if (abweichung > CONFIG.ueberschwingenSchwelle && ventil < 0.1 && maxSolar > 0.2) {
            ueberschwingenEvents++;
        } else if (abweichung < CONFIG.traegheitSchwelle && ventil > 0.8 && maxWind > 1.1) {
            traegheitEvents++;
        }
    }

    if (CONFIG.debugLogAktiv) {
        log(`[Lern-Skript] ${raum.name} - Analyse-Ergebnis: Überschwingen-Events: ${ueberschwingenEvents}, Trägheit-Events: ${traegheitEvents}`);
    }

    // Phase 3: Anpassen
    const solarId = `${CONFIG.lernwerteBasisPfad}.${raum.name}.Solar_Korrektur`;
    const windId = `${CONFIG.lernwerteBasisPfad}.${raum.name}.Wind_Korrektur`;
    
    let currentSolar = (await getStateAsync(solarId)).val;
    let currentWind = (await getStateAsync(windId)).val;

    if (ueberschwingenEvents > traegheitEvents) {
        currentSolar -= CONFIG.lernrate; // Wenn zu warm, solaren Einfluss reduzieren
        log(`[Lern-Skript] ${raum.name} - LERNEN: System hat überreagiert. Reduziere Solar-Korrektur auf ${currentSolar.toFixed(3)}.`);
    } else if (traegheitEvents > ueberschwingenEvents) {
        currentWind += CONFIG.lernrate; // Wenn zu kalt, Einfluss von Wärmeverlust erhöhen
        log(`[Lern-Skript] ${raum.name} - LERNEN: System war zu träge. Erhöhe Wind-Korrektur auf ${currentWind.toFixed(3)}.`);
    } else {
        // Wenn System stabil, langsam zur Mitte (1.0) konvergieren
        currentSolar = currentSolar * (1 - CONFIG.lernrate) + 1.0 * CONFIG.lernrate;
        currentWind = currentWind * (1 - CONFIG.lernrate) + 1.0 * CONFIG.lernrate;
    }

    // Sicherstellen, dass Werte in den definierten Grenzen bleiben
    currentSolar = Math.max(0.5, Math.min(1.5, currentSolar));
    currentWind = Math.max(0.5, Math.min(1.5, currentWind));

    await setStateAsync(solarId, parseFloat(currentSolar.toFixed(4)), true);
    await setStateAsync(windId, parseFloat(currentWind.toFixed(4)), true);
}


// -------------------------------------------------------------------------------------
// 5. HAUPTFUNKTION & STEUERUNG
// -------------------------------------------------------------------------------------
async function main() {
    log(`[Lern-Skript] Starte neuen Lern-Zyklus (V${"2.1"}) für alle Räume...`);
    for (const raum of CONFIG.raeume) {
        await analysiereRaum(raum);
    }
    log("[Lern-Skript] Lern-Zyklus für alle Räume abgeschlossen.");
}

// -------------------------------------------------------------------------------------
// 6. SKRIPT-START & TRIGGER
// -------------------------------------------------------------------------------------
(async () => {
    await initialisiereDatenpunkte();
    
    // Das Lern-Skript läuft seltener, da es Langzeit-Muster analysiert (z.B. alle 6 Stunden)
    schedule('30 */6 * * *', main);
    
    // Einmaliger Start nach 1 Minute zur Initialisierung
    setTimeout(main, 60000);
})();

})(); // Ende der Kapselung

