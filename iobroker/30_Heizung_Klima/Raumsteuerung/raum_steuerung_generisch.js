// @ts-check
/* global clearInterval, clearSchedule, clearTimeout, createState,
   createStateAsync, existsState, existsStateAsync, getObjectAsync,
   getState, getStateAsync, log, on, onStop, require, schedule,
   sendTo, sendToAsync, setInterval, setObjectAsync, setState,
   setStateAsync, setTimeout */

/**
 * @fileoverview Generische Einzelraum-Heizungssteuerung fuer ioBroker
 * @version 9.0 (Paket 4: Solar/Wind-Multiplikator entfernt)
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
 * NEU in V9.0 (Paket 4 — Entfernung System A / multiplikative Lernwerte):
 * - Das alte Lern-System (lern_skript.js V2.2) ist in Paket 4 durch das
 *   Strategen-System (heizungs_lerner.js V4.0 + stratege.js) vollstaendig
 *   abgeloest. Der multiplikative Solar-/Wind-Korrekturfaktor ist damit
 *   architektonisch ueberfluessig und wird hier entfernt.
 * - Entfernt: ROOMS_CONFIG.lernwerte (alle 5 Raeume)
 * - Entfernt: getStateAsync-Aufrufe fuer solarKorrekturId / windKorrekturId
 * - Entfernt: Multiplikation mit gelernteSolarKorrektur / gelernterWindKorrektur
 *             in 3.1.4.2 Wetter-Analyse
 * - Entfernt: solarKorrekturId / windKorrekturId aus lowPriorityTriggerIds
 * - Log-Format Solar/Wind ohne K-Faktor (z.B. "Solar=-0.50 (F:0.50)")
 *
 * NACH-MIGRATIONS-SCHRITT FUER ALEXANDER:
 *   Nach erfolgreichem Start von V9.0 koennen diese 10 Datenpunkte
 *   gefahrlos aus ioBroker geloescht werden:
 *     0_userdata.0.Heizung.Lernwerte.{Raum}.Solar_Korrektur
 *     0_userdata.0.Heizung.Lernwerte.{Raum}.Wind_Korrektur
 *   fuer Raum in {Wohnzimmer, Schlafzimmer, Badezimmer, Kueche, Esszimmer}.
 *   Optional zusaetzlich: 0_userdata.0.Heizung.Lernwerte.Letzter_Lauf
 *
 * UEBERNOMMEN aus V8.0 (Paket 3):
 * - Strategen-Anbindung ueber Prognose-Datenpunkte (offsetId, vertrauenId)
 * - Clipping auf +/- 2.0 Grad, lineare Vertrauensgewichtung
 * - Zweifeld-Struktur: roomName (Anzeige) + dbRaum (SQL-konform)
 *
 * UEBERNOMMEN aus V7.0 (Paket 2):
 * - ROOMS_CONFIG-Array mit allen 5 Raeumen
 * - Fabrik-Funktion createRoomController() pro Raum
 * - Gemeinsamer Schedule (alle 15 Minuten)
 * - Gestaffelter Start (500 ms Versatz je Raum)
 *
 * UEBERNOMMENE BUGFIXES aus Paket 1:
 * - Magnus-Formel verwendet Math.log10() (korrekter dekadischer Logarithmus)
 * - Global-Header zur Unterdrueckung von Highlighter-Warnungen
 *
 * ARCHITEKTUR-HINWEIS:
 * Die Raumskripte lesen ausschliesslich ioBroker-Datenpunkte aus dem RAM
 * und greifen NICHT direkt auf die SQL-Datenbank zu. Der Stratege
 * uebernimmt die Rolle des Puffers zwischen SQL und Raumskripten.
 *
 * DATENFLUSS fuer den Prognose-Offset:
 *   SQL-Datenbank (iobroker_heizung.heizungs_erfahrung)
 *     -> Stratege (alle 15 Min, liest SQL, schreibt ioBroker-Datenpunkte)
 *     -> 0_userdata.0.Heizung.Prognose.{dbRaum}.Empfohlener_Offset(_Vertrauen)
 *     -> Raumskript (liest Datenpunkt bei Trigger, Clipping, Gewichtung)
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

    // Globale Grenze fuer den Prognose-Offset VOR der Vertrauensgewichtung.
    // Schutz vor DB-Ausreissern (z.B. fehlerhaft gelernter Extremwert).
    const PROGNOSE_OFFSET_CLIP = 2.0;

    const DEBUG_LOG_AKTIV = true;

    // =====================================================================================
    // 2. ROOMS_CONFIG — alle 5 Raeume in einem Array
    // =====================================================================================
    //
    // HINWEIS zu den Feldern:
    //   roomName  = Anzeige-Name (wie im Originalskript, fuer Logs)
    //   dbRaum    = SQL-konformer Schluessel (fuer Paket 3 / Stratege)
    //               Werte: Wohnzimmer, Schlafzimmer, Badezimmer, Kueche, Esszimmer
    //   prognose  = Strategen-Anbindung (Paket 3):
    //               offsetId      — Datenpunkt vom Strategen (Grad C)
    //               vertrauenId   — Datenpunkt vom Strategen (nutzungs_zaehler)
    //               maxVertrauen  — Schwelle fuer Vollvertrauen (50 = "reifer" Datensatz)
    //               aktiviert     — pro Raum abschaltbar
    //
    // ENTFERNT in V9.0: Feld 'lernwerte' (siehe Migrations-Hinweis im Header).
    //
    const ROOMS_CONFIG = [
        // -----------------------------------------------------------------------------
        // RAUM 1: BAD
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
            prognose: {
                offsetId: '0_userdata.0.Heizung.Prognose.Badezimmer.Empfohlener_Offset',
                vertrauenId: '0_userdata.0.Heizung.Prognose.Badezimmer.Empfohlener_Offset_Vertrauen',
                maxVertrauen: 50,
                aktiviert: true,
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
            prognose: {
                offsetId: '0_userdata.0.Heizung.Prognose.Esszimmer.Empfohlener_Offset',
                vertrauenId: '0_userdata.0.Heizung.Prognose.Esszimmer.Empfohlener_Offset_Vertrauen',
                maxVertrauen: 50,
                aktiviert: true,
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
            prognose: {
                offsetId: '0_userdata.0.Heizung.Prognose.Kueche.Empfohlener_Offset',
                vertrauenId: '0_userdata.0.Heizung.Prognose.Kueche.Empfohlener_Offset_Vertrauen',
                maxVertrauen: 50,
                aktiviert: true,
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
            prognose: {
                offsetId: '0_userdata.0.Heizung.Prognose.Schlafzimmer.Empfohlener_Offset',
                vertrauenId: '0_userdata.0.Heizung.Prognose.Schlafzimmer.Empfohlener_Offset_Vertrauen',
                maxVertrauen: 50,
                aktiviert: true,
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
            prognose: {
                offsetId: '0_userdata.0.Heizung.Prognose.Wohnzimmer.Empfohlener_Offset',
                vertrauenId: '0_userdata.0.Heizung.Prognose.Wohnzimmer.Empfohlener_Offset_Vertrauen',
                maxVertrauen: 50,
                aktiviert: true,
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
    function createRoomController(roomConfig) {

        let debounceTimerHighPriority = null;
        let debounceTimerLowPriority = null;

        // =================================================================================
        // 3.1 HAUPTFUNKTION
        // =================================================================================
        async function main() {
            try {
                // --- 3.1.1 Alle Zustaende sammeln ---
                // ENTFERNT in V9.0: solarKorrekturId / windKorrekturId
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
                    fensterKontakte: []
                };

                for (const subId of roomConfig.devices.fensterKontakte) {
                    states.fensterKontakte.push((await getStateAsync(subId))?.val);
                }

                // --- 3.1.2 Validierung ---
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

                let logModuleAction = '';
                let logWetter = '';
                let logPrognose = '';

                // --- 3.1.3 Basistemperatur ---
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

                // --- 3.1.4 Dynamische Anpassungen & Module ---
                if (!istSonderfall) {

                    // --- 3.1.4.1 Feuchtekorrektur ---
                    if (feuchteSensorOK && !states.anwesenheit) {
                        neueSollTemp +=
                            (roomConfig.basisRegelung.luftfeuchteOptimal - states.feuchteSensor) *
                            roomConfig.basisRegelung.feuchteKorrekturfaktor;
                    }

                    // --- 3.1.4.2 Wetter-Analyse (Solar/Wind) ---
                    // GEAENDERT in V9.0: kein multiplikativer Korrekturfaktor mehr.
                    // Solar/Wind wirken direkt mit dem vom wetter_analyse.js
                    // gelieferten Faktor. Kontextabhaengige Feinjustierung uebernimmt
                    // der Strategen-Offset in Schritt 3.1.4.4.
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

                    if (maxSolarFaktor > 0) {
                        const solarOffset = -1.0 * maxSolarFaktor;
                        neueSollTemp += solarOffset;
                        logWetter += `, Solar=${solarOffset.toFixed(2)} (F:${maxSolarFaktor.toFixed(2)})`;
                    }

                    if (maxWindFaktor > 1.0) {
                        const windOffset = 1.0 * (maxWindFaktor - 1.0);
                        neueSollTemp += windOffset;
                        logWetter += `, Wind=+${windOffset.toFixed(2)} (F:${maxWindFaktor.toFixed(2)})`;
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

                    // Kandidat B: Schimmelschutz — Math.log10() (Bugfix Paket 1)
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

                    // --- 3.1.4.4 STRATEGEN-PROGNOSE (Paket 3) ---
                    if (roomConfig.prognose && roomConfig.prognose.aktiviert) {
                        const rawOffsetState = await getStateAsync(roomConfig.prognose.offsetId);
                        const rawVertrauenState = await getStateAsync(roomConfig.prognose.vertrauenId);

                        const rawOffset =
                            rawOffsetState && typeof rawOffsetState.val === 'number'
                                ? rawOffsetState.val
                                : null;
                        const rawVertrauen =
                            rawVertrauenState && typeof rawVertrauenState.val === 'number'
                                ? rawVertrauenState.val
                                : 0;

                        if (rawOffset !== null && rawVertrauen > 0) {
                            const geklammerterOffset = Math.max(
                                -PROGNOSE_OFFSET_CLIP,
                                Math.min(PROGNOSE_OFFSET_CLIP, rawOffset)
                            );

                            const vertrauensGewicht = Math.min(
                                1.0,
                                rawVertrauen / roomConfig.prognose.maxVertrauen
                            );
                            const gewichteterOffset = geklammerterOffset * vertrauensGewicht;

                            neueSollTemp += gewichteterOffset;

                            logPrognose =
                                `, Prognose=${gewichteterOffset >= 0 ? '+' : ''}${gewichteterOffset.toFixed(2)}` +
                                ` (DB:${rawOffset >= 0 ? '+' : ''}${rawOffset.toFixed(2)}` +
                                `, Clip:${geklammerterOffset >= 0 ? '+' : ''}${geklammerterOffset.toFixed(2)}` +
                                `, Vtr:${rawVertrauen}/${roomConfig.prognose.maxVertrauen}` +
                                `, Gew:${Math.round(vertrauensGewicht * 100)}%)`;
                        } else {
                            if (DEBUG_LOG_AKTIV) {
                                logPrognose = `, Prognose=ignoriert (Offset=${rawOffset}, Vtr=${rawVertrauen})`;
                            }
                        }
                    }
                }

                // --- 3.1.5 Finalisierung & Ausfuehrung ---
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
                        if (istSonderfall) details.push(`SONDERFALL`);
                        details.push(`Offset=${roomConfig.temperaturOffset}`);
                        details.push(`Mod1=${roomConfig.module.schimmelSchutzAktiv}`);
                        details.push(`Mod2=${roomConfig.module.behaglichkeitAktiv}`);
                        details.push(`Mod3=${roomConfig.module.heizlastAktiv}`);
                        if (roomConfig.prognose) {
                            details.push(`Prog=${!!roomConfig.prognose.aktiviert}`);
                        }

                        const logDetails = `(${details.join(', ')})`;
                        const logActions = `${logWetter}${logModuleAction}${logPrognose}`;
                        log(`${logMessage} ${logDetails}${logActions}`);
                    }
                }
            } catch (e) {
                log(`[${roomConfig.roomName}] FEHLER in Hauptfunktion: ${e.message}`, 'error');
            }
        }

        // =================================================================================
        // 3.2 PRIORISIERTER DEBOUNCE-MANAGER
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
        // 3.3 TRIGGER-REGISTRIERUNG
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
        // ENTFERNT in V9.0: solarKorrekturId / windKorrekturId
        const lowPriorityTriggerIds = [
            GLOBAL_IDS.heizPeriode,
            GLOBAL_IDS.nachtschaltung,
        ];
        for (const richtung of roomConfig.ausrichtungFenster) {
            lowPriorityTriggerIds.push(WETTER_PFADE.basisPfadSolar + richtung);
            lowPriorityTriggerIds.push(WETTER_PFADE.basisPfadWind + richtung);
        }
        const raumTempIds = roomConfig.devices.thermostate.map(id =>
            id.replace('SET_POINT_TEMPERATURE', 'ACTUAL_TEMPERATURE')
        );
        lowPriorityTriggerIds.push(...raumTempIds);

        // --- Strategen-Prognose als Low-Priority-Trigger ---
        if (roomConfig.prognose && roomConfig.prognose.aktiviert) {
            if (roomConfig.prognose.offsetId) {
                lowPriorityTriggerIds.push(roomConfig.prognose.offsetId);
            }
            if (roomConfig.prognose.vertrauenId) {
                lowPriorityTriggerIds.push(roomConfig.prognose.vertrauenId);
            }
        }

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

        setTimeout(() => triggerCalculation(true), 1500);

        if (DEBUG_LOG_AKTIV) {
            log(`[${roomConfig.roomName}] Raum-Controller initialisiert (dbRaum='${roomConfig.dbRaum}', Prognose=${!!(roomConfig.prognose && roomConfig.prognose.aktiviert)}).`, 'info');
        }

        return {
            main,
            triggerCalculation,
            config: roomConfig,
        };
    }

    // =====================================================================================
    // 4. INITIALISIERUNG: alle Raum-Instanzen erzeugen (mit 500 ms Versatz)
    // =====================================================================================
    const roomControllers = [];

    ROOMS_CONFIG.forEach((config, index) => {
        setTimeout(() => {
            const controller = createRoomController(config);
            roomControllers.push(controller);
        }, index * 500);
    });

    // =====================================================================================
    // 5. GEMEINSAMER SCHEDULE (alle 15 Minuten)
    // =====================================================================================
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
