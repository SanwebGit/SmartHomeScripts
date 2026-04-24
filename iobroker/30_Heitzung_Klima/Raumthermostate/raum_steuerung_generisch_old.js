// @ts-check
/* global clearInterval, clearSchedule, clearTimeout, createState,
   createStateAsync, existsState, existsStateAsync, getObjectAsync,
   getState, getStateAsync, log, on, onStop, require, schedule,
   sendTo, sendToAsync, setInterval, setObjectAsync, setState,
   setStateAsync, setTimeout */

/**
 * @fileoverview Generische Einzelraum-Heizungssteuerung fuer ioBroker (Paket 2)
 * @version 7.0 (Konsolidierung aus 5 Einzelskripten)
 * @author Sanweb
 * @license MIT
 *
 * -------------------------------------------------------------------------------------
 * ZWECK DES SKRIPTS:
 * -------------------------------------------------------------------------------------
 * Dieses Skript konsolidiert die fuenf zuvor separaten Raumskripte
 * (raum_bad.js, raum_esszimmer.js, raum_kueche.js, raum_schlafzimmer.js,
 * raum_wohnzimmer.js) in EIN generisches Skript.
 *
 * Jeder Raum wird ueber die Fabrik-Funktion createRoomController() als
 * eigenstaendige Instanz mit eigenem Closure, eigenem Debounce-Manager,
 * eigenen Triggern und eigener Haupt-Logik aufgebaut.
 *
 * NEU in V7.0 (Paket 2):
 * - ROOMS_CONFIG-Array mit allen 5 Raeumen
 * - Fabrik-Funktion createRoomController() pro Raum
 * - Ein gemeinsamer Schedule (alle 15 Minuten) statt 5 versetzte Cronjobs
 * - Gestaffelter Start (500 ms Versatz je Raum) zur geordneten Initialisierung
 * - Zweifeld-Struktur: roomName (Anzeige) + dbRaum (SQL-konform fuer Paket 3)
 *
 * UEBERNOMMENE BUGFIXES aus Paket 1:
 * - Magnus-Formel verwendet Math.log10() (korrekter dekadischer Logarithmus)
 * - Esszimmer und Kueche mit eigenen, korrekten Lernwerte-Pfaden
 * - Global-Header zur Unterdrueckung von Highlighter-Warnungen
 *
 * ARCHITEKTUR-HINWEIS:
 * Die Raumskripte lesen ausschliesslich ioBroker-Datenpunkte aus dem RAM
 * und greifen NICHT direkt auf die SQL-Datenbank zu. Der Stratege (Paket 3)
 * uebernimmt die Rolle des Puffers zwischen SQL und Raumskripten.
 * -------------------------------------------------------------------------------------
 */

(function () {
    'use strict';

    // =====================================================================================
    // 1. GLOBALE KONSTANTEN (gelten fuer ALLE Raeume)
    // =====================================================================================

    const GLOBAL_IDS = {
        heizPeriode: '0_userdata.0.Heizung.Allgemein.HeizperiodeAktiv',
        anwesenheit: '0_userdata.0.Anwesenheit.Status',
        nachtschaltung: '0_userdata.0.System.Nachtschaltung.Aktiv',
        sollTempAnwesend: '0_userdata.0.Heizung.sollTempAnwesend',
        sollTempAbwesend: '0_userdata.0.Heizung.sollTempAbwesend',
    };

    const WETTER_PFADE = {
        basisPfadSolar: '0_userdata.0.Heizung.Analyse.Wetter_Heizunterstuetzung_Solar_',
        basisPfadWind: '0_userdata.0.Heizung.Analyse.Wetter_Waermeverlust_Wind_',
    };

    const DEBOUNCE_CONFIG = {
        aktiv: true,
        delayHighPriority: 20000,
        delayLowPriority: 1000,
    };

    const TRIGGER_SCHWELLEN = {
        aussenTempTriggerThreshold: 1.0,
        raumTempTriggerThreshold: 0.3,
        luftfeuchteTriggerThreshold: 5.0,
    };

    const DEBUG_LOG_AKTIV = true;

    // =====================================================================================
    // 2. ROOMS_CONFIG — alle 5 Raeume in einem Array
    // =====================================================================================
    //
    // HINWEIS zu den Feldern:
    //   roomName  = Anzeige-Name (wie im Originalskript, fuer Logs)
    //   dbRaum    = SQL-konformer Schluessel (fuer Paket 3 / Stratege)
    //               Werte: Wohnzimmer, Schlafzimmer, Badezimmer, Kueche, Esszimmer
    //
    const ROOMS_CONFIG = [
        // -----------------------------------------------------------------------------
        // RAUM 1: BAD
        // Quelle: raum_bad.js (Paket 1, V6.15)
        // -----------------------------------------------------------------------------
        {
            roomName: 'Bad',
            dbRaum: 'Badezimmer',
            nachtschaltungNutzen: true,
            tuerSensorNutzen: true,
            hysterese: 0.5,
            tempFensterOffen: 12.0,
            tempHeizperiodeAus: 4.5,
            temperaturOffset: 0.0,
            minSollTemp: 16.0,
            maxSollTemp: 24.0,
            ausrichtungFenster: ['Nord', 'Ost'],
            devices: {
                thermostate: ['hm-rpc.2.INT0000002.1.SET_POINT_TEMPERATURE'],
                fensterKontakte: ['hm-rpc.0.0023DA49A3CC62.1.STATE'],
                tuerSensor: 'hm-rpc.0.0023DF299CC991.1.STATE',
                aussenTempSensor: 'hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE',
                feuchteSensor: 'hm-rpc.2.INT0000002.1.HUMIDITY',
                wandSensorOberflaeche: 'hm-rpc.0.002822699B7E86.2.ACTUAL_TEMPERATURE',
                wandSensorKern: 'hm-rpc.0.002822699B7E86.1.ACTUAL_TEMPERATURE',
            },
            lernwerte: {
                solarKorrekturId: '0_userdata.0.Heizung.Lernwerte.Badezimmer.Solar_Korrektur',
                windKorrekturId: '0_userdata.0.Heizung.Lernwerte.Badezimmer.Wind_Korrektur',
            },
            basisRegelung: {
                aussenTempNeutral: 12.0,
                heizkurvenfaktor: 0.1,
                luftfeuchteOptimal: 70.0,
                feuchteKorrekturfaktor: 0.02,
            },
            module: {
                schimmelSchutzAktiv: true,
                sicherheitsabstandTaupunkt: 2.5,
                offsetSchimmelSchutz: 0.5,
                behaglichkeitAktiv: true,
                maxTempDifferenzWand: 3.0,
                offsetBehaglichkeit: 0.5,
                heizlastAktiv: true,
                heizlastKorrekturfaktor: 0.1,
            },
        },

        // -----------------------------------------------------------------------------
        // RAUM 2: ESSZIMMER
        // Quelle: raum_esszimmer.js (Paket 1, V6.15)
        // -----------------------------------------------------------------------------
        {
            roomName: 'Esszimmer',
            dbRaum: 'Esszimmer',
            nachtschaltungNutzen: true,
            tuerSensorNutzen: false,
            hysterese: 0.5,
            tempFensterOffen: 12.0,
            tempHeizperiodeAus: 4.5,
            temperaturOffset: 0.0,
            minSollTemp: 16.0,
            maxSollTemp: 24.0,
            ausrichtungFenster: ['Nord', 'Ost'],
            devices: {
                thermostate: ['hm-rpc.2.INT0000004.1.SET_POINT_TEMPERATURE'],
                fensterKontakte: ['hm-rpc.0.0023DA49A3B05C.1.STATE'],
                tuerSensor: 'hm-rpc.0.00000000000000.0.STATE',
                aussenTempSensor: 'hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE',
                feuchteSensor: 'hm-rpc.2.INT0000004.1.HUMIDITY',
                wandSensorOberflaeche: 'hm-rpc.0.002822699B7E86.1.ACTUAL_TEMPERATURE',
                wandSensorKern: 'hm-rpc.0.002822699B7E86.2.ACTUAL_TEMPERATURE',
            },
            lernwerte: {
                solarKorrekturId: '0_userdata.0.Heizung.Lernwerte.Esszimmer.Solar_Korrektur',
                windKorrekturId: '0_userdata.0.Heizung.Lernwerte.Esszimmer.Wind_Korrektur',
            },
            basisRegelung: {
                aussenTempNeutral: 12.0,
                heizkurvenfaktor: 0.1,
                luftfeuchteOptimal: 70.0,
                feuchteKorrekturfaktor: 0.02,
            },
            module: {
                schimmelSchutzAktiv: true,
                sicherheitsabstandTaupunkt: 2.5,
                offsetSchimmelSchutz: 0.5,
                behaglichkeitAktiv: true,
                maxTempDifferenzWand: 3.0,
                offsetBehaglichkeit: 0.5,
                heizlastAktiv: true,
                heizlastKorrekturfaktor: 0.1,
            },
        },

        // -----------------------------------------------------------------------------
        // RAUM 3: KUECHE
        // Quelle: raum_kueche.js (Paket 1, V6.15)
        // -----------------------------------------------------------------------------
        {
            roomName: 'Küche',
            dbRaum: 'Kueche',
            nachtschaltungNutzen: true,
            tuerSensorNutzen: false,
            hysterese: 0.5,
            tempFensterOffen: 12.0,
            tempHeizperiodeAus: 4.5,
            temperaturOffset: 0.0,
            minSollTemp: 16.0,
            maxSollTemp: 24.0,
            ausrichtungFenster: ['Nord', 'Ost'],
            devices: {
                thermostate: ['hm-rpc.2.INT0000003.1.SET_POINT_TEMPERATURE'],
                fensterKontakte: ['hm-rpc.0.0023DA49A3CC5A.1.STATE'],
                tuerSensor: 'hm-rpc.0.00000000000000.0.STATE',
                aussenTempSensor: 'hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE',
                feuchteSensor: 'hm-rpc.2.INT0000003.1.HUMIDITY',
                wandSensorOberflaeche: 'hm-rpc.0.002822699B7E86.1.ACTUAL_TEMPERATURE',
                wandSensorKern: 'hm-rpc.0.002822699B7E86.2.ACTUAL_TEMPERATURE',
            },
            lernwerte: {
                solarKorrekturId: '0_userdata.0.Heizung.Lernwerte.Kueche.Solar_Korrektur',
                windKorrekturId: '0_userdata.0.Heizung.Lernwerte.Kueche.Wind_Korrektur',
            },
            basisRegelung: {
                aussenTempNeutral: 12.0,
                heizkurvenfaktor: 0.1,
                luftfeuchteOptimal: 70.0,
                feuchteKorrekturfaktor: 0.02,
            },
            module: {
                schimmelSchutzAktiv: true,
                sicherheitsabstandTaupunkt: 2.5,
                offsetSchimmelSchutz: 0.5,
                behaglichkeitAktiv: true,
                maxTempDifferenzWand: 3.0,
                offsetBehaglichkeit: 0.5,
                heizlastAktiv: true,
                heizlastKorrekturfaktor: 0.1,
            },
        },

        // -----------------------------------------------------------------------------
        // RAUM 4: SCHLAFZIMMER
        // Quelle: raum_schlafzimmer.js (Paket 1, V6.15)
        // -----------------------------------------------------------------------------
        {
            roomName: 'Schlafzimmer',
            dbRaum: 'Schlafzimmer',
            nachtschaltungNutzen: true,
            tuerSensorNutzen: true,
            hysterese: 0.5,
            tempFensterOffen: 12.0,
            tempHeizperiodeAus: 4.5,
            temperaturOffset: 0.0,
            minSollTemp: 16.0,
            maxSollTemp: 24.0,
            ausrichtungFenster: ['Sued', 'West'],
            devices: {
                thermostate: ['hm-rpc.2.INT0000001.1.SET_POINT_TEMPERATURE'],
                fensterKontakte: ['hm-rpc.0.00109A49A438EA.1.STATE'],
                tuerSensor: 'hm-rpc.0.0023DA49A3B9FF.1.STATE',
                aussenTempSensor: 'hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE',
                feuchteSensor: 'hm-rpc.2.INT0000001.1.HUMIDITY',
                wandSensorOberflaeche: 'hm-rpc.0.002822699B7D20.1.ACTUAL_TEMPERATURE',
                wandSensorKern: 'hm-rpc.0.002822699B7D20.2.ACTUAL_TEMPERATURE_STATUS',
            },
            lernwerte: {
                solarKorrekturId: '0_userdata.0.Heizung.Lernwerte.Schlafzimmer.Solar_Korrektur',
                windKorrekturId: '0_userdata.0.Heizung.Lernwerte.Schlafzimmer.Wind_Korrektur',
            },
            basisRegelung: {
                aussenTempNeutral: 12.0,
                heizkurvenfaktor: 0.1,
                luftfeuchteOptimal: 70.0,
                feuchteKorrekturfaktor: 0.02,
            },
            module: {
                schimmelSchutzAktiv: true,
                sicherheitsabstandTaupunkt: 2.5,
                offsetSchimmelSchutz: 0.5,
                behaglichkeitAktiv: true,
                maxTempDifferenzWand: 3.0,
                offsetBehaglichkeit: 0.5,
                heizlastAktiv: true,
                heizlastKorrekturfaktor: 0.1,
            },
        },

        // -----------------------------------------------------------------------------
        // RAUM 5: WOHNZIMMER
        // Quelle: raum_wohnzimmer.js (Paket 1, V6.15)
        // -----------------------------------------------------------------------------
        {
            roomName: 'Wohnzimmer',
            dbRaum: 'Wohnzimmer',
            nachtschaltungNutzen: true,
            tuerSensorNutzen: true,
            hysterese: 0.5,
            tempFensterOffen: 12.0,
            tempHeizperiodeAus: 4.5,
            temperaturOffset: 0.0,
            minSollTemp: 16.0,
            maxSollTemp: 24.0,
            ausrichtungFenster: ['Sued', 'West'],
            devices: {
                thermostate: ['hm-rpc.2.INT0000005.1.SET_POINT_TEMPERATURE'],
                fensterKontakte: ['hm-rpc.0.00109A49A44D25.1.STATE'],
                tuerSensor: 'hm-rpc.0.0023DF299CD2BD.1.STATE',
                aussenTempSensor: 'hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE',
                feuchteSensor: 'hm-rpc.2.INT0000005.1.HUMIDITY',
                wandSensorOberflaeche: 'hm-rpc.0.002822699B7D20.1.ACTUAL_TEMPERATURE',
                wandSensorKern: 'hm-rpc.0.002822699B7D20.2.ACTUAL_TEMPERATURE_STATUS',
            },
            lernwerte: {
                solarKorrekturId: '0_userdata.0.Heizung.Lernwerte.Wohnzimmer.Solar_Korrektur',
                windKorrekturId: '0_userdata.0.Heizung.Lernwerte.Wohnzimmer.Wind_Korrektur',
            },
            basisRegelung: {
                aussenTempNeutral: 12.0,
                heizkurvenfaktor: 0.1,
                luftfeuchteOptimal: 70.0,
                feuchteKorrekturfaktor: 0.02,
            },
            module: {
                schimmelSchutzAktiv: true,
                sicherheitsabstandTaupunkt: 2.5,
                offsetSchimmelSchutz: 0.5,
                behaglichkeitAktiv: true,
                maxTempDifferenzWand: 3.0,
                offsetBehaglichkeit: 0.5,
                heizlastAktiv: true,
                heizlastKorrekturfaktor: 0.1,
            },
        },
    ];

    // =====================================================================================
    // 3. FABRIK-FUNKTION: createRoomController(roomConfig)
    //    Erzeugt pro Raum einen eigenen Closure mit Debounce-Manager,
    //    Hauptlogik, Triggern und einem externen main()-Aufruf fuer den
    //    gemeinsamen Schedule.
    // =====================================================================================
    //
    // Rueckgabe: { main, triggerCalculation, config }
    //   main()                = direkter Aufruf der Hauptlogik (fuer Schedule)
    //   triggerCalculation()  = Debounced Aufruf (fuer Trigger)
    //   config                = die uebergebene roomConfig (zur Referenz)
    //
    function createRoomController(roomConfig) {

        // --- Lokaler Closure-State (pro Raum-Instanz) ---
        let debounceTimerHighPriority = null;
        let debounceTimerLowPriority = null;

        // =================================================================================
        // 3.1 HAUPTFUNKTION (fuehrt die komplette Raumberechnung aus)
        // =================================================================================
        async function main() {
            try {
                // --- 3.1.1 Alle Zustaende explizit und sicher sammeln ---
                const states = {
                    heizPeriode: (await getStateAsync(GLOBAL_IDS.heizPeriode))?.val,
                    anwesenheit: (await getStateAsync(GLOBAL_IDS.anwesenheit))?.val,
                    nachtschaltung: (await getStateAsync(GLOBAL_IDS.nachtschaltung))?.val,
                    sollTempAnwesend: (await getStateAsync(GLOBAL_IDS.sollTempAnwesend))?.val,
                    sollTempAbwesend: (await getStateAsync(GLOBAL_IDS.sollTempAbwesend))?.val,
                    tuerSensor: roomConfig.tuerSensorNutzen
                        ? (await getStateAsync(roomConfig.devices.tuerSensor))?.val
                        : null,
                    aussenTempSensor: (await getStateAsync(roomConfig.devices.aussenTempSensor))?.val,
                    feuchteSensor: (await getStateAsync(roomConfig.devices.feuchteSensor))?.val,
                    wandSensorOberflaeche: (await getStateAsync(roomConfig.devices.wandSensorOberflaeche))?.val,
                    wandSensorKern: (await getStateAsync(roomConfig.devices.wandSensorKern))?.val,
                    solarKorrekturId: (await getStateAsync(roomConfig.lernwerte.solarKorrekturId))?.val,
                    windKorrekturId: (await getStateAsync(roomConfig.lernwerte.windKorrekturId))?.val,
                    fensterKontakte: []
                };

                for (const subId of roomConfig.devices.fensterKontakte) {
                    states.fensterKontakte.push((await getStateAsync(subId))?.val);
                }

                // --- 3.1.2 Sensoren validieren & Hilfsvariablen ---
                const aussenSensorOK =
                    typeof states.aussenTempSensor === 'number' &&
                    states.aussenTempSensor > -30.0 &&
                    states.aussenTempSensor < 60.0;
                const feuchteSensorOK =
                    typeof states.feuchteSensor === 'number' &&
                    states.feuchteSensor >= 0.0 &&
                    states.feuchteSensor <= 100.0;

                let sollTempAnwesend = states.sollTempAnwesend || 21.0;
                const sollTempAbwesend = states.sollTempAbwesend || 16.0;

                if (roomConfig.nachtschaltungNutzen && states.nachtschaltung) {
                    sollTempAnwesend = sollTempAbwesend;
                }

                const isDoorPhysicallyClosed =
                    states.tuerSensor === 0 ||
                    states.tuerSensor === false ||
                    states.tuerSensor === '0' ||
                    states.tuerSensor === 'false';

                const fensterIstOffen = states.fensterKontakte.some(
                    state => state === true || state === 1 || state === 'true' || state === '1'
                );

                // --- Log-Strings vorbereiten ---
                let logModuleAction = '';
                let logWetter = '';

                // --- 3.1.3 LOGIK: Basistemperatur ermitteln ---
                let neueSollTemp;
                let istSonderfall = false;

                if (states.heizPeriode) {
                    if (fensterIstOffen) {
                        neueSollTemp = roomConfig.tempFensterOffen;
                        istSonderfall = true;
                    } else if (states.anwesenheit) {
                        if (roomConfig.tuerSensorNutzen && isDoorPhysicallyClosed) {
                            neueSollTemp = sollTempAbwesend;
                        } else {
                            neueSollTemp = sollTempAnwesend;
                        }
                    } else {
                        neueSollTemp = sollTempAbwesend;
                    }
                } else {
                    neueSollTemp = roomConfig.tempHeizperiodeAus;
                    istSonderfall = true;
                }

                const basisSollTemp = neueSollTemp;

                // --- 3.1.4 LOGIK: Dynamische Anpassungen & Module ---
                if (!istSonderfall) {

                    // --- 3.1.4.1 Feuchtekorrektur ---
                    if (feuchteSensorOK && !states.anwesenheit) {
                        neueSollTemp +=
                            (roomConfig.basisRegelung.luftfeuchteOptimal - states.feuchteSensor) *
                            roomConfig.basisRegelung.feuchteKorrekturfaktor;
                    }

                    // --- 3.1.4.2 Wetter-Analyse (Solar/Wind) ---
                    let maxSolarFaktor = 0;
                    let maxWindFaktor = 1.0;

                    for (const richtung of roomConfig.ausrichtungFenster) {
                        const solarState = await getStateAsync(WETTER_PFADE.basisPfadSolar + richtung);
                        if (solarState && typeof solarState.val === 'number' && solarState.val > maxSolarFaktor) {
                            maxSolarFaktor = solarState.val;
                        }

                        const windState = await getStateAsync(WETTER_PFADE.basisPfadWind + richtung);
                        if (windState && typeof windState.val === 'number' && windState.val > maxWindFaktor) {
                            maxWindFaktor = windState.val;
                        }
                    }

                    const gelernteSolarKorrektur =
                        typeof states.solarKorrekturId === 'number' ? states.solarKorrekturId : 1.0;
                    const gelernterWindKorrektur =
                        typeof states.windKorrekturId === 'number' ? states.windKorrekturId : 1.0;

                    if (maxSolarFaktor > 0) {
                        const solarOffset = -1.0 * maxSolarFaktor;
                        neueSollTemp += solarOffset * gelernteSolarKorrektur;
                        logWetter += `, Solar=${(solarOffset * gelernteSolarKorrektur).toFixed(2)} (F:${maxSolarFaktor.toFixed(2)}*K:${gelernteSolarKorrektur.toFixed(2)})`;
                    }

                    if (maxWindFaktor > 1.0) {
                        const windOffset = 1.0 * (maxWindFaktor - 1.0);
                        neueSollTemp += windOffset * gelernterWindKorrektur;
                        logWetter += `, Wind=+${(windOffset * gelernterWindKorrektur).toFixed(2)} (F:${maxWindFaktor.toFixed(2)}*K:${gelernterWindKorrektur.toFixed(2)})`;
                    }

                    // --- 3.1.4.3 PHYSIK-MODULE & WETTERFUEHRUNG (Maximum-Prinzip) ---
                    let aufschlagWetter = 0;
                    let aufschlagSchimmel = 0;
                    let aufschlagBehaglichkeit = 0;
                    let aufschlagHeizlast = 0;

                    // Kandidat A: Witterungsfuehrung (Heizkurve)
                    if (aussenSensorOK && states.aussenTempSensor < roomConfig.basisRegelung.aussenTempNeutral) {
                        aufschlagWetter =
                            (roomConfig.basisRegelung.aussenTempNeutral - states.aussenTempSensor) *
                            roomConfig.basisRegelung.heizkurvenfaktor;
                    }

                    const wandSensorOberflaecheOK =
                        typeof states.wandSensorOberflaeche === 'number' &&
                        states.wandSensorOberflaeche < 90.0;

                    // Kandidat B: Schimmelschutz — BUGFIX aus Paket 1: Math.log10() statt Math.log()
                    if (roomConfig.module.schimmelSchutzAktiv && feuchteSensorOK && wandSensorOberflaecheOK) {
                        const MAGNUS_A = 7.5;
                        const MAGNUS_B = 237.3;
                        const sdd =
                            (MAGNUS_A * basisSollTemp) / (MAGNUS_B + basisSollTemp) +
                            Math.log10(states.feuchteSensor / 100);
                        const taupunkt = (MAGNUS_B * sdd) / (MAGNUS_A - sdd);
                        if (states.wandSensorOberflaeche < taupunkt + roomConfig.module.sicherheitsabstandTaupunkt) {
                            aufschlagSchimmel = roomConfig.module.offsetSchimmelSchutz;
                        }
                    }

                    // Kandidat C: Behaglichkeit
                    if (roomConfig.module.behaglichkeitAktiv && wandSensorOberflaecheOK) {
                        if (basisSollTemp - states.wandSensorOberflaeche > roomConfig.module.maxTempDifferenzWand) {
                            aufschlagBehaglichkeit = roomConfig.module.offsetBehaglichkeit;
                        }
                    }

                    // Kandidat D: Heizlast
                    const wandSensorKernOK =
                        typeof states.wandSensorKern === 'number' && states.wandSensorKern < 90.0;
                    if (roomConfig.module.heizlastAktiv && wandSensorOberflaecheOK && wandSensorKernOK) {
                        const tempDifferenz = states.wandSensorKern - states.wandSensorOberflaeche;
                        if (tempDifferenz > 0) {
                            aufschlagHeizlast = tempDifferenz * roomConfig.module.heizlastKorrekturfaktor;
                        }
                    }

                    // ENTSCHEIDUNG: Wer bietet mehr?
                    const finalerPhysikAufschlag = Math.max(
                        aufschlagWetter,
                        aufschlagSchimmel,
                        aufschlagBehaglichkeit,
                        aufschlagHeizlast,
                    );

                    if (finalerPhysikAufschlag > 0) {
                        neueSollTemp += finalerPhysikAufschlag;
                        logModuleAction += `, PhysikMax:+${finalerPhysikAufschlag.toFixed(2)} (Wetter(Kurve):${aufschlagWetter.toFixed(2)}|M1_Schimmel:${aufschlagSchimmel}|M2_Behag:${aufschlagBehaglichkeit}|M3_Last:${aufschlagHeizlast.toFixed(2)})`;
                    }

                    neueSollTemp += roomConfig.temperaturOffset;
                }

                // --- 3.1.5 LOGIK: Finalisierung & Ausfuehrung ---
                if (!istSonderfall) {
                    neueSollTemp = Math.max(
                        roomConfig.minSollTemp,
                        Math.min(roomConfig.maxSollTemp, neueSollTemp)
                    );
                }

                neueSollTemp = Math.round(neueSollTemp * 2) / 2;

                for (const thermostatId of roomConfig.devices.thermostate) {
                    const aktuellEingestellteTemp = (await getStateAsync(thermostatId))?.val || 4.5;
                    const sollwertGeaendert =
                        Math.abs(neueSollTemp - aktuellEingestellteTemp) > roomConfig.hysterese;

                    if (sollwertGeaendert) {
                        await setStateAsync(thermostatId, neueSollTemp);
                        const controlModeId = thermostatId.replace('SET_POINT_TEMPERATURE', 'CONTROL_MODE');
                        await setStateAsync(controlModeId, 1, true);
                    }

                    if (DEBUG_LOG_AKTIV) {
                        let logMessage;
                        if (sollwertGeaendert) {
                            logMessage = `[${roomConfig.roomName}] Setze Soll von ${aktuellEingestellteTemp.toFixed(1)}°C auf ${neueSollTemp.toFixed(1)}°C (Basis=${basisSollTemp.toFixed(1)}°C)`;
                        } else {
                            logMessage = `[${roomConfig.roomName}] Keine Aenderung (Ist=${aktuellEingestellteTemp.toFixed(1)}°C ~ Ziel=${neueSollTemp.toFixed(1)}°C (Basis=${basisSollTemp.toFixed(1)}°C), Hyst=${roomConfig.hysterese}°C)`;
                        }

                        const details = [
                            `HeizP=${!!states.heizPeriode}`,
                            `Anw=${!!states.anwesenheit}`,
                            `Win=${fensterIstOffen}`,
                        ];
                        if (roomConfig.tuerSensorNutzen) {
                            details.push(`TuerZu=${isDoorPhysicallyClosed}`);
                        }
                        details.push(`NachtSch=${!!states.nachtschaltung}`);

                        if (istSonderfall) {
                            details.push(`SONDERFALL`);
                        }

                        details.push(`Offset=${roomConfig.temperaturOffset}`);
                        details.push(`Mod1=${roomConfig.module.schimmelSchutzAktiv}`);
                        details.push(`Mod2=${roomConfig.module.behaglichkeitAktiv}`);
                        details.push(`Mod3=${roomConfig.module.heizlastAktiv}`);

                        const logDetails = `(${details.join(', ')})`;
                        const logActions = `${logWetter}${logModuleAction}`;

                        log(`${logMessage} ${logDetails}${logActions}`);
                    }
                }
            } catch (e) {
                log(`[${roomConfig.roomName}] FEHLER in Hauptfunktion: ${e.message}`, 'error');
            }
        }

        // =================================================================================
        // 3.2 PRIORISIERTER DEBOUNCE-MANAGER (pro Raum-Instanz)
        // =================================================================================
        function triggerCalculation(isHighPriority) {
            if (!DEBOUNCE_CONFIG.aktiv) {
                main();
                return;
            }

            const delay = isHighPriority
                ? DEBOUNCE_CONFIG.delayHighPriority
                : DEBOUNCE_CONFIG.delayLowPriority;
            const priorityText = isHighPriority ? 'HOCH' : 'NIEDRIG';

            if (isHighPriority) {
                if (debounceTimerLowPriority) clearTimeout(debounceTimerLowPriority);
                if (debounceTimerHighPriority) clearTimeout(debounceTimerHighPriority);

                debounceTimerHighPriority = setTimeout(async () => {
                    if (DEBUG_LOG_AKTIV) {
                        log(`[${roomConfig.roomName}] Debounce (${priorityText}): Zeit abgelaufen, fuehre Hauptfunktion aus...`, 'info');
                    }
                    await main();
                    debounceTimerHighPriority = null;
                }, delay);
            } else {
                if (debounceTimerHighPriority) {
                    if (DEBUG_LOG_AKTIV) {
                        log(`[${roomConfig.roomName}] Debounce (${priorityText}): Trigger ignoriert, da Hoch-Prioritaets-Timer aktiv ist.`, 'info');
                    }
                    return;
                }
                if (debounceTimerLowPriority) clearTimeout(debounceTimerLowPriority);

                debounceTimerLowPriority = setTimeout(async () => {
                    if (DEBUG_LOG_AKTIV) {
                        log(`[${roomConfig.roomName}] Debounce (${priorityText}): Zeit abgelaufen, fuehre Hauptfunktion aus...`, 'info');
                    }
                    await main();
                    debounceTimerLowPriority = null;
                }, delay);
            }

            if (DEBUG_LOG_AKTIV) {
                log(`[${roomConfig.roomName}] Debounce (${priorityText}): Trigger erhalten, starte ${delay} ms Timer.`, 'info');
            }
        }

        // =================================================================================
        // 3.3 TRIGGER-REGISTRIERUNG (pro Raum-Instanz)
        // =================================================================================

        // --- High-Priority-Trigger ---
        const highPriorityTriggerIds = [
            GLOBAL_IDS.anwesenheit,
            ...roomConfig.devices.fensterKontakte,
        ];
        if (roomConfig.tuerSensorNutzen && roomConfig.devices.tuerSensor) {
            highPriorityTriggerIds.push(roomConfig.devices.tuerSensor);
        }
        on(highPriorityTriggerIds, () => triggerCalculation(true));

        // --- Low-Priority-Trigger ---
        const lowPriorityTriggerIds = [
            GLOBAL_IDS.heizPeriode,
            GLOBAL_IDS.nachtschaltung,
            roomConfig.lernwerte.solarKorrekturId,
            roomConfig.lernwerte.windKorrekturId,
        ];
        for (const richtung of roomConfig.ausrichtungFenster) {
            lowPriorityTriggerIds.push(WETTER_PFADE.basisPfadSolar + richtung);
            lowPriorityTriggerIds.push(WETTER_PFADE.basisPfadWind + richtung);
        }
        const raumTempIds = roomConfig.devices.thermostate.map(id =>
            id.replace('SET_POINT_TEMPERATURE', 'ACTUAL_TEMPERATURE')
        );
        lowPriorityTriggerIds.push(...raumTempIds);

        function handleLowPriorityTrigger(obj) {
            if (obj && obj.state && obj.oldState && obj.state.val === obj.oldState.val) return;

            const isTempTrigger = raumTempIds.includes(obj.id);
            if (isTempTrigger) {
                if (
                    obj.state &&
                    obj.oldState &&
                    Math.abs(obj.state.val - obj.oldState.val) >= TRIGGER_SCHWELLEN.raumTempTriggerThreshold
                ) {
                    triggerCalculation(false);
                }
            } else {
                triggerCalculation(false);
            }
        }

        on(lowPriorityTriggerIds, handleLowPriorityTrigger);

        // --- Erster Start (mit kleinem Versatz zum Abwarten der Trigger-Registrierung) ---
        setTimeout(() => triggerCalculation(true), 1500);

        if (DEBUG_LOG_AKTIV) {
            log(`[${roomConfig.roomName}] Raum-Controller initialisiert (dbRaum='${roomConfig.dbRaum}').`, 'info');
        }

        // --- Rueckgabe fuer zentrale Verwaltung ---
        return {
            main,
            triggerCalculation,
            config: roomConfig,
        };
    }

    // =====================================================================================
    // 4. INITIALISIERUNG: alle Raum-Instanzen erzeugen (mit 500 ms Versatz)
    // =====================================================================================
    //
    // Der Versatz dient ausschliesslich einem geordneten Start — nicht dem
    // Duty-Cycle-Schutz. Den uebernimmt der Debounce-Manager jedes Raumes.
    //
    const roomControllers = [];

    ROOMS_CONFIG.forEach((config, index) => {
        setTimeout(() => {
            const controller = createRoomController(config);
            roomControllers.push(controller);
        }, index * 500);
    });

    // =====================================================================================
    // 5. GEMEINSAMER SCHEDULE (alle 15 Minuten, loest alle Raeume aus)
    // =====================================================================================
    //
    // Ersetzt die 5 versetzten Cronjobs der Einzelskripte:
    //   raum_bad.js         '1,16,31,46 * * * *'
    //   raum_esszimmer.js   '2,17,32,47 * * * *'
    //   raum_kueche.js      '3,18,33,48 * * * *'
    //   raum_schlafzimmer.js '4,19,34,49 * * * *'
    //   raum_wohnzimmer.js  '5,20,35,50 * * * *'
    //
    // Der Debounce-Manager verteilt Lastspitzen im Schreibzugriff auf HomeMatic
    // — ein gemeinsamer Schedule ist damit sicher.
    //
    schedule('*/15 * * * *', () => {
        roomControllers.forEach(controller => {
            if (controller && typeof controller.triggerCalculation === 'function') {
                controller.triggerCalculation(false);
            }
        });
    });

    if (DEBUG_LOG_AKTIV) {
        log(`[Raumsteuerung] Skript geladen — ${ROOMS_CONFIG.length} Raeume konfiguriert, Schedule '*/15 * * * *' registriert.`, 'info');
    }

})(); // Ende der Kapselung
