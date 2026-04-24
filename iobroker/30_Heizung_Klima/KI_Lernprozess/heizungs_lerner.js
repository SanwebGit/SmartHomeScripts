// @ts-check
/* global clearInterval, clearSchedule, clearTimeout, createState,
   createStateAsync, existsState, existsStateAsync, getObjectAsync,
   getState, getStateAsync, log, on, onStop, require, schedule,
   sendTo, sendToAsync, setInterval, setObjectAsync, setState,
   setStateAsync, setTimeout */

/**
 * @fileoverview Heizungs-Lerner (Paket 4: Dauerbetrieb-Konsolidierung)
 * @version 4.0 - Zeitgewichtetes Lernen + Sommerpause
 * @author Sanweb
 * @license MIT
 *
 * -------------------------------------------------------------------------------------
 * ZWECK DES SKRIPTS:
 * -------------------------------------------------------------------------------------
 * Alleinige Lernquelle fuer das Heizungssystem (Option C nach Paket 4 Analyse).
 * Loest lern_skript.js V2.2 vollstaendig ab.
 *
 * NEU in V4.0 (Paket 4):
 * - Zeitgewichteter gleitender Durchschnitt (LERN_GEWICHT_NEU=0.15,
 *   LERN_GEWICHT_ALT=0.85) statt kumulativer Durchschnitt
 *   -> verhindert Ueberlernen bei Langzeitbetrieb ueber mehrere Saisons
 *   -> Extremausreisser koennen gelernte Werte nicht dauerhaft dominieren
 *   -> alle 288 vorhandenen Datensaetze bleiben als Startwert erhalten
 *
 * - Sommerpause-Logik:
 *   -> Pruefung am Anfang jedes Lauf-Zyklus
 *   -> Pausenbedingung: gleitender 24h-Mittelwert der Aussentemperatur > 15 Grad
 *   -> kein SQL-Schreiben waehrend Pause
 *   -> Datenpunkt 0_userdata.0.Heizung.Lernsystem.Sommerpause_Aktiv zeigt Status
 *   -> zusaetzlicher Datenpunkt 0_userdata.0.Heizung.Lernsystem.Letzter_Lauf
 *
 * UEBERNOMMEN aus V3.5:
 * - Kernlogik: Erkennung stabiler Phasen (Ist ~ Soll ueber >=25 Min)
 * - Kontextbasierte Einteilung (Temp x Solar x Wind x Tageszeit)
 * - Direkter SQL-Zugriff per sendTo('sql.0', 'query', ...)
 * - Pushover-Benachrichtigung (optional, default aus)
 * - InfluxDB-Historie als Datenquelle
 *
 * DATENFLUSS (unveraendert):
 *   InfluxDB (aktuelle Saison)
 *     -> Lerner (alle 30 Min, erkennt stabile Phasen)
 *     -> SQL-DB iobroker_heizung.heizungs_erfahrung (zeitgewichtetes UPDATE)
 *     -> Stratege (liest SQL, schreibt Prognose-Datenpunkte)
 *     -> Raumskripte (lesen Datenpunkte)
 * -------------------------------------------------------------------------------------
 */

(function () {
    'use strict';

    // HILFSTYPEN
    /**
     * @typedef {object} SqlQueryResultRow
     * @property {string} offset_erfolg
     * @property {number} nutzungs_zaehler
     */
    /**
     * @typedef {object} SqlQueryResult
     * @property {SqlQueryResultRow[]} result
     */

    // -------------------------------------------------------------------------------------
    // 1. KONFIGURATION
    // -------------------------------------------------------------------------------------

    // ADAPTER & DATENBANK
    const INFLUXDB_INSTANCE = 'influxdb.0';
    const PUSHOVER_INSTANCE = 'pushover.0';
    const SQL_INSTANCE = 'sql.0';
    const DB_NAME = 'iobroker_heizung';
    const SCHEDULE = '*/30 * * * *';

    // SCHALTER
    const SEND_PUSHOVER_NOTIFICATIONS = false;
    const DEBUG_LOG_AKTIV = false;

    // LERNPARAMETER
    const LERN_PARAMETER = {
        analyseZeitraumStunden: 4,
        minDurationMinutes: 25,
        tempTolerance: 1.0,
    };

    // ZEITGEWICHTETER LERNALGORITHMUS (NEU in V4.0)
    // Neuere Beobachtungen zaehlen mehr, alte verblassen langsam aber bleiben erhalten.
    // Nach ca. 6 neuen Beobachtungen hat eine neue Heizperiode 65% Einfluss.
    // Extremausreisser koennen den Wert nicht dauerhaft dominieren.
    const LERN_GEWICHT_NEU = 0.15;
    const LERN_GEWICHT_ALT = 0.85;

    // SOMMERPAUSE (NEU in V4.0)
    // Pause wird aktiv wenn der gleitende 24h-Mittelwert der Aussentemperatur
    // dauerhaft ueber dieser Schwelle liegt. Verhindert Lernen von verfaelschten
    // Minimal-Daten im Sommer.
    const SOMMERPAUSE = {
        schwelleGradCelsius: 15.0,
        fensterStunden: 24,
        datenpunktStatus: '0_userdata.0.Heizung.Lernsystem.Sommerpause_Aktiv',
        datenpunktLetzterLauf: '0_userdata.0.Heizung.Lernsystem.Letzter_Lauf',
        datenpunktMittelwert24h: '0_userdata.0.Heizung.Lernsystem.AussenTemp_Mittelwert_24h',
    };

    // GRENZEN FUER KATEGORISIERUNG (identisch zu V3.5)
    const GRENZEN = {
        temp: [-25, -20, -15, -10, -5, 0, 5, 10, 15, 20],
        solar: [0.1, 0.4, 0.7],
        wind: [1.1, 1.3, 1.5],
    };

    // DATENPUNKTE (identisch zu V3.5)
    const DATENPUNKTE = {
        raeume: [
            { name: 'Wohnzimmer',   thermostatId: 'hm-rpc.2.INT0000005.1', wetterAusrichtung: ['Sued', 'West'] },
            { name: 'Schlafzimmer', thermostatId: 'hm-rpc.2.INT0000001.1', wetterAusrichtung: ['Sued', 'West'] },
            { name: 'Badezimmer',   thermostatId: 'hm-rpc.2.INT0000002.1', wetterAusrichtung: ['Nord', 'Ost']  },
            { name: 'Kueche',       thermostatId: 'hm-rpc.2.INT0000003.1', wetterAusrichtung: ['Nord', 'Ost']  },
            { name: 'Esszimmer',    thermostatId: 'hm-rpc.2.INT0000004.1', wetterAusrichtung: ['Nord', 'Ost']  },
        ],
        wetter: {
            basisPfadSolar: '0_userdata.0.Heizung.Analyse.Wetter_Heizunterstuetzung_Solar',
            basisPfadWind: '0_userdata.0.Heizung.Analyse.Wetter_Waermeverlust_Wind',
            aussenTemp: 'hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE',
        },
        global: {
            anwesenheit: '0_userdata.0.Anwesenheit.Status',
            nachtschaltung: '0_userdata.0.System.Nachtschaltung.Aktiv',
            sollTempAnwesend: '0_userdata.0.Heizung.sollTempAnwesend',
            sollTempAbwesend: '0_userdata.0.Heizung.sollTempAbwesend',
        },
    };

    // -------------------------------------------------------------------------------------
    // 2. HILFSFUNKTIONEN
    // -------------------------------------------------------------------------------------

    function buildQuery(query, params) {
        let i = 0;
        if (!params) return query;
        return query.replace(/\?/g, () => {
            const param = params[i++];
            if (param === null || typeof param === 'undefined') return 'NULL';
            if (typeof param === 'string') return `'${param.replace(/'/g, "''")}'`;
            return param;
        });
    }

    async function initialisiereDatenbank() {
        const dbOptions = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
        const query = `CREATE TABLE IF NOT EXISTS ${DB_NAME}.heizungs_erfahrung (
            id INT AUTO_INCREMENT PRIMARY KEY,
            raum VARCHAR(50) NOT NULL,
            temp_bereich VARCHAR(20) NOT NULL,
            solar_level VARCHAR(20) NOT NULL,
            wind_level VARCHAR(20) NOT NULL,
            tageszeit VARCHAR(20) NOT NULL,
            offset_erfolg DECIMAL(4,2) NOT NULL,
            nutzungs_zaehler INT DEFAULT 1,
            letzte_nutzung TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY erfahrungs_index (raum, temp_bereich, solar_level, wind_level, tageszeit)
        ) ${dbOptions};`;
        try {
            await sendToAsync(SQL_INSTANCE, 'query', query);
            log('[Init] SQL-Tabelle heizungs_erfahrung verifiziert/erstellt.', 'info');
        } catch (e) {
            log(`[Fehler] Datenbank-Tabelle konnte nicht initialisiert werden: ${e.message || e}`, 'error');
        }
    }

    async function initialisiereStatusDatenpunkte() {
        if (!(await existsStateAsync(SOMMERPAUSE.datenpunktStatus))) {
            await createStateAsync(SOMMERPAUSE.datenpunktStatus, false, {
                name: 'Sommerpause des Lernsystems aktiv',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
                def: false,
            });
            log(`[Init] Datenpunkt ${SOMMERPAUSE.datenpunktStatus} erstellt.`, 'info');
        }

        if (!(await existsStateAsync(SOMMERPAUSE.datenpunktLetzterLauf))) {
            await createStateAsync(SOMMERPAUSE.datenpunktLetzterLauf, 0, {
                name: 'Zeitstempel des letzten Lern-Laufs',
                type: 'number',
                role: 'date',
                read: true,
                write: false,
                def: 0,
            });
            log(`[Init] Datenpunkt ${SOMMERPAUSE.datenpunktLetzterLauf} erstellt.`, 'info');
        }

        if (!(await existsStateAsync(SOMMERPAUSE.datenpunktMittelwert24h))) {
            await createStateAsync(SOMMERPAUSE.datenpunktMittelwert24h, 0.0, {
                name: 'Gleitender 24h-Mittelwert der Aussentemperatur',
                type: 'number',
                role: 'value.temperature',
                unit: '°C',
                read: true,
                write: false,
                def: 0.0,
            });
            log(`[Init] Datenpunkt ${SOMMERPAUSE.datenpunktMittelwert24h} erstellt.`, 'info');
        }
    }

    async function getHistoryData(raum, start, end) {
        const idsToFetch = [
            `${raum.thermostatId}.ACTUAL_TEMPERATURE`,
            `${raum.thermostatId}.SET_POINT_TEMPERATURE`,
            DATENPUNKTE.wetter.aussenTemp,
            ...Object.values(DATENPUNKTE.global),
        ];
        raum.wetterAusrichtung.forEach((richtung) => {
            idsToFetch.push(`${DATENPUNKTE.wetter.basisPfadSolar}_${richtung}`);
            idsToFetch.push(`${DATENPUNKTE.wetter.basisPfadWind}_${richtung}`);
        });

        const idMap = {};
        const promises = idsToFetch.map((id) => {
            const isSollTemp = id.includes('.SET_POINT_TEMPERATURE');
            const options = {
                end: end,
                aggregate: 'none',
                count: isSollTemp ? 1 : 500,
            };
            if (!isSollTemp) {
                options.start = start;
            }
            const key = id.replace(/\./g, '_');
            idMap[key] = id;
            return sendToAsync(INFLUXDB_INSTANCE, 'getHistory', { id, options }).then((res) => ({ key, res }));
        });

        try {
            const results = await Promise.all(promises);
            const historien = {};
            results.forEach((item) => {
                // @ts-ignore — sendToAsync-Rueckgabetyp ist fuer InfluxDB-getHistory unterspezifiziert (hat zur Laufzeit ein .result-Array)
                historien[idMap[item.key]] = (item.res && item.res.result) || [];
            });
            return historien;
        } catch (e) {
            log(`[Fehler] Kritischer Fehler beim Datenabruf fuer ${raum.name}: ${e.message}`, 'error');
            return null;
        }
    }

    function getValueAt(ts, series) {
        if (!series || series.length === 0) return null;
        if (series.length === 1) return series[0].val;

        let bestPoint = null;
        for (const p of series) {
            if (p.ts <= ts) {
                if (bestPoint === null || p.ts > bestPoint.ts) bestPoint = p;
            }
        }
        return bestPoint ? bestPoint.val : null;
    }

    function getKategorie(value, grenzen) {
        if (value === null || typeof value === 'undefined') return 'unbekannt';
        for (let i = grenzen.length - 1; i >= 0; i--) {
            if (value >= grenzen[i]) return `kat_${i + 1}`;
        }
        return `kat_0`;
    }

    function getTageszeit(ts) {
        const stunde = new Date(ts).getHours();
        if (stunde >= 4 && stunde < 8) return 'früher Morgen';
        if (stunde >= 8 && stunde < 12) return 'Vormittag';
        if (stunde >= 12 && stunde < 16) return 'Nachmittag';
        if (stunde >= 16 && stunde < 20) return 'früher Abend';
        if (stunde >= 20 && stunde < 24) return 'später Abend';
        return 'Nacht';
    }

    // -------------------------------------------------------------------------------------
    // 3. SOMMERPAUSE-LOGIK (NEU in V4.0)
    // -------------------------------------------------------------------------------------

    /**
     * Ermittelt den gleitenden Mittelwert der Aussentemperatur ueber die letzten
     * SOMMERPAUSE.fensterStunden Stunden aus der InfluxDB.
     * @returns {Promise<number|null>} Mittelwert in Grad Celsius oder null bei Fehler.
     */
    async function getAussenTempMittelwert24h() {
        const end = new Date().getTime();
        const start = end - (SOMMERPAUSE.fensterStunden * 3600 * 1000);

        try {
            const raw = await sendToAsync(INFLUXDB_INSTANCE, 'getHistory', {
                id: DATENPUNKTE.wetter.aussenTemp,
                options: {
                    start: start,
                    end: end,
                    aggregate: 'none',
                    count: 500,
                },
            });
            // @ts-ignore — sendToAsync-Rueckgabetyp ist fuer InfluxDB-getHistory unterspezifiziert (hat zur Laufzeit ein .result-Array)
            const punkte = (raw && raw.result) || [];

            if (punkte.length === 0) {
                log('[Sommerpause] Keine Aussentemperatur-Daten fuer 24h-Mittelwert gefunden.', 'warn');
                return null;
            }

            let summe = 0;
            let zaehler = 0;
            for (const p of punkte) {
                if (p.val !== null && typeof p.val === 'number' && !isNaN(p.val)) {
                    summe += p.val;
                    zaehler++;
                }
            }

            if (zaehler === 0) return null;
            return summe / zaehler;
        } catch (e) {
            log(`[Sommerpause] Fehler beim Abrufen der 24h-Aussentemperatur: ${e.message || e}`, 'error');
            return null;
        }
    }

    /**
     * Prueft ob die Sommerpause aktiv sein soll und aktualisiert den Status-Datenpunkt.
     * @returns {Promise<boolean>} true wenn Pause aktiv (kein Lernen), false wenn aktiv gelernt wird.
     */
    async function pruefeSommerpause() {
        const mittelwert = await getAussenTempMittelwert24h();

        if (mittelwert === null) {
            log('[Sommerpause] Status unklar (keine Daten). Lerne weiter.', 'warn');
            try {
                await setStateAsync(SOMMERPAUSE.datenpunktStatus, false, true);
            } catch (e) { /* ignorieren */ }
            return false;
        }

        try {
            await setStateAsync(SOMMERPAUSE.datenpunktMittelwert24h, parseFloat(mittelwert.toFixed(2)), true);
        } catch (e) { /* ignorieren */ }

        const pauseAktiv = mittelwert > SOMMERPAUSE.schwelleGradCelsius;

        try {
            await setStateAsync(SOMMERPAUSE.datenpunktStatus, pauseAktiv, true);
        } catch (e) {
            log(`[Sommerpause] Fehler beim Schreiben des Status-Datenpunkts: ${e.message || e}`, 'warn');
        }

        if (pauseAktiv) {
            log(`[Sommerpause] AKTIV — 24h-Mittelwert Aussentemp = ${mittelwert.toFixed(2)}°C (> ${SOMMERPAUSE.schwelleGradCelsius}°C). Kein Lernen.`, 'info');
        } else {
            log(`[Sommerpause] INAKTIV — 24h-Mittelwert Aussentemp = ${mittelwert.toFixed(2)}°C (<= ${SOMMERPAUSE.schwelleGradCelsius}°C). Lerne weiter.`, 'info');
        }

        return pauseAktiv;
    }

    // -------------------------------------------------------------------------------------
    // 4. KERNLOGIK: PHASEN-ANALYSE & SPEICHERUNG
    // -------------------------------------------------------------------------------------

    function getKontextAt(ts, raum, historien) {
        const aussenTemp = getValueAt(ts, historien[DATENPUNKTE.wetter.aussenTemp]);
        if (aussenTemp === null) return null;

        let maxSolar = 0;
        let maxWind = 1;
        raum.wetterAusrichtung.forEach((richtung) => {
            const solar = getValueAt(ts, historien[`${DATENPUNKTE.wetter.basisPfadSolar}_${richtung}`]) || 0;
            if (solar > maxSolar) maxSolar = solar;
            const wind = getValueAt(ts, historien[`${DATENPUNKTE.wetter.basisPfadWind}_${richtung}`]) || 1;
            if (wind > maxWind) maxWind = wind;
        });

        const anwesend = getValueAt(ts, historien[DATENPUNKTE.global.anwesenheit]);
        const nacht = getValueAt(ts, historien[DATENPUNKTE.global.nachtschaltung]);
        const sollAnwesend = getValueAt(ts, historien[DATENPUNKTE.global.sollTempAnwesend]) ?? 21;
        const sollAbwesend = getValueAt(ts, historien[DATENPUNKTE.global.sollTempAbwesend]) ?? 16;

        let basisSoll = anwesend ? sollAnwesend : sollAbwesend;
        if (nacht) basisSoll = sollAbwesend;

        return {
            temp_bereich: getKategorie(aussenTemp, GRENZEN.temp),
            solar_level: getKategorie(maxSolar, GRENZEN.solar),
            wind_level: getKategorie(maxWind, GRENZEN.wind),
            tageszeit: getTageszeit(ts),
            basisSoll: basisSoll,
        };
    }

    /**
     * Liest den bestehenden Offset aus der SQL-Datenbank (fuer zeitgewichtete Mittelung).
     * @returns {Promise<{offset: number, zaehler: number}|null>} Alter Wert oder null wenn nicht vorhanden.
     */
    async function getBisherigeErfahrung(erfahrung) {
        const query = `
            SELECT offset_erfolg, nutzungs_zaehler
            FROM ${DB_NAME}.heizungs_erfahrung
            WHERE raum = ? AND temp_bereich = ? AND solar_level = ?
              AND wind_level = ? AND tageszeit = ?
            LIMIT 1;
        `;
        const params = [
            erfahrung.raum,
            erfahrung.temp_bereich,
            erfahrung.solar_level,
            erfahrung.wind_level,
            erfahrung.tageszeit,
        ];

        try {
            const finalQuery = buildQuery(query, params);
            /** @type {SqlQueryResult} */
            const result = /** @type {any} */ (await sendToAsync(SQL_INSTANCE, 'query', finalQuery));

            if (result && result.result && result.result.length > 0) {
                return {
                    offset: parseFloat(result.result[0].offset_erfolg),
                    zaehler: result.result[0].nutzungs_zaehler,
                };
            }
            return null;
        } catch (e) {
            log(`[Fehler] SQL-Fehler beim Lesen der bisherigen Erfahrung: ${e.message || e}`, 'error');
            return null;
        }
    }

    /**
     * Speichert eine neue Erfahrung mit ZEITGEWICHTETEM Durchschnitt in der SQL-DB.
     * Ersetzt den alten kumulativen Durchschnitt aus V3.5.
     *
     * Formel: neuer_offset = (alter_offset * 0.85) + (beobachteter_offset * 0.15)
     */
    async function speichereErfahrung(erfahrung) {
        const bisherig = await getBisherigeErfahrung(erfahrung);

        let finalerOffset;
        let operation;

        if (bisherig === null) {
            finalerOffset = erfahrung.offset_erfolg;
            operation = 'INSERT_NEU';
        } else {
            finalerOffset = (bisherig.offset * LERN_GEWICHT_ALT) + (erfahrung.offset_erfolg * LERN_GEWICHT_NEU);
            finalerOffset = parseFloat(finalerOffset.toFixed(2));
            operation = `ZEITGEWICHTET (alt=${bisherig.offset.toFixed(2)}, beob=${erfahrung.offset_erfolg.toFixed(2)}, neu=${finalerOffset.toFixed(2)}, zaehler=${bisherig.zaehler}->${bisherig.zaehler + 1})`;
        }

        const query = `
            INSERT INTO ${DB_NAME}.heizungs_erfahrung
                (raum, temp_bereich, solar_level, wind_level, tageszeit, offset_erfolg)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                offset_erfolg = ?,
                nutzungs_zaehler = nutzungs_zaehler + 1;
        `;

        const params = [
            erfahrung.raum,
            erfahrung.temp_bereich,
            erfahrung.solar_level,
            erfahrung.wind_level,
            erfahrung.tageszeit,
            finalerOffset,
            finalerOffset,
        ];

        try {
            const finalQuery = buildQuery(query, params);
            if (DEBUG_LOG_AKTIV) {
                log(`[SQL] Sende Abfrage: ${finalQuery.replace(/\s\s+/g, ' ')}`, 'info');
            }
            const result = await sendToAsync(SQL_INSTANCE, 'query', finalQuery);
            log(`[SQL] Erfahrung fuer ${erfahrung.raum} [${erfahrung.temp_bereich}/${erfahrung.solar_level}/${erfahrung.wind_level}/${erfahrung.tageszeit}] verarbeitet. ${operation}`, 'info');
            if (DEBUG_LOG_AKTIV) {
                log(`[SQL] Antwort vom Adapter: ${JSON.stringify(result)}`, 'info');
            }
        } catch (e) {
            log(`[Fehler] SQL-Fehler beim Speichern: ${e.message || e}`, 'error');
        }
    }

    async function analysiereStabilePhasen(raum, historien) {
        const istSeries = historien[`${raum.thermostatId}.ACTUAL_TEMPERATURE`];
        const sollSeries = historien[`${raum.thermostatId}.SET_POINT_TEMPERATURE`];

        if (!istSeries || istSeries.length < 2 || !sollSeries || sollSeries.length === 0) return;

        let phaseStartPunkt = null;
        let letzterStabilerPunkt = null;

        const prozessiereGefundenePhase = async () => {
            if (phaseStartPunkt && letzterStabilerPunkt) {
                const dauerMinuten = Math.round((letzterStabilerPunkt.ts - phaseStartPunkt.ts) / 60000);
                if (dauerMinuten >= LERN_PARAMETER.minDurationMinutes) {
                    const midTs = phaseStartPunkt.ts + (letzterStabilerPunkt.ts - phaseStartPunkt.ts) / 2;
                    const soll = getValueAt(midTs, sollSeries);
                    const kontext = getKontextAt(midTs, raum, historien);

                    if (soll !== null && kontext) {
                        const erfahrung = {
                            raum: raum.name,
                            temp_bereich: kontext.temp_bereich,
                            solar_level: kontext.solar_level,
                            wind_level: kontext.wind_level,
                            tageszeit: kontext.tageszeit,
                            offset_erfolg: parseFloat((soll - kontext.basisSoll).toFixed(2)),
                        };

                        await speichereErfahrung(erfahrung);

                        if (SEND_PUSHOVER_NOTIFICATIONS) {
                            const aussenVal = getValueAt(midTs, historien[DATENPUNKTE.wetter.aussenTemp]);
                            const message = `Phase fuer ${raum.name} gelernt!\nDauer: ${dauerMinuten} Min.\nSoll: ${soll}°C, Aussen: ${aussenVal !== null ? aussenVal.toFixed(1) : '?'}°C`;
                            try {
                                await sendToAsync(PUSHOVER_INSTANCE, 'send', {
                                    message: message,
                                    title: 'Heizungs-Lerner V4.0',
                                    priority: -2,
                                });
                            } catch (e) { /* ignorieren */ }
                        }
                    }
                }
            }
        };

        for (const punkt of istSeries) {
            const ist = punkt.val;
            const soll = getValueAt(punkt.ts, sollSeries);

            if (ist !== null && soll !== null && soll > 12 && Math.abs(ist - soll) <= LERN_PARAMETER.tempTolerance) {
                if (phaseStartPunkt === null) phaseStartPunkt = punkt;
                letzterStabilerPunkt = punkt;
            } else {
                await prozessiereGefundenePhase();
                phaseStartPunkt = null;
                letzterStabilerPunkt = null;
            }
        }
        await prozessiereGefundenePhase();
    }

    // -------------------------------------------------------------------------------------
    // 5. HAUPTFUNKTION & ZEITPLANUNG
    // -------------------------------------------------------------------------------------

    async function main() {
        log('[Start] Starte Analyse-Lauf V4.0...', 'info');

        try {
            await setStateAsync(SOMMERPAUSE.datenpunktLetzterLauf, new Date().getTime(), true);
        } catch (e) { /* ignorieren */ }

        const pauseAktiv = await pruefeSommerpause();
        if (pauseAktiv) {
            log('[Ende] Analyse-Lauf V4.0 uebersprungen (Sommerpause).', 'info');
            return;
        }

        const end = new Date().getTime();
        const start = end - (LERN_PARAMETER.analyseZeitraumStunden * 3600 * 1000);

        for (const raum of DATENPUNKTE.raeume) {
            log(`--- Analysiere Raum: ${raum.name} ---`, 'info');
            const historien = await getHistoryData(raum, start, end);
            if (historien) {
                await analysiereStabilePhasen(raum, historien);
            }
        }

        log('[Ende] Analyse-Lauf V4.0 abgeschlossen.', 'info');
    }

    // -------------------------------------------------------------------------------------
    // 6. SKRIPT-START
    // -------------------------------------------------------------------------------------

    (async () => {
        await initialisiereDatenbank();
        await initialisiereStatusDatenpunkte();
        log('[Skript] Heizungs-Lerner V4.0 gestartet. Naechster Lauf: In 30 Sekunden, dann alle 30 Minuten.', 'info');
        schedule(SCHEDULE, main);
        setTimeout(main, 30000);
    })();

})();