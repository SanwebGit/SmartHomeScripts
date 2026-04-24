// @ts-check
/**
 * @fileoverview Heizungs-Lerner (Schritt 3: Alle Räume & Kontexte)
 * @version 3.5 - Pushover Edition
 * @author Sanweb
 * @license MIT
 *
 * Finale Version des neuen Lern-Skripts.
 *
 * FUNKTIONEN (Version 3.4/3.5):
 * - Gliedert den Tag in präzisere 4-Stunden-Blöcke für eine genauere Lern-Erfahrung.
 * - Erweitert die Temperaturgrenzen für die Kategorisierung auf -25°C bis +20°C.
 * - Fügt eine Konfigurationsvariable `SEND_PUSHOVER_NOTIFICATIONS` hinzu.
 * - Angepasst auf Pushover (Priorität korrigiert).
 */

(function(){
    "use strict";

    // HILFSTYPEN
    /** @typedef {object} InfluxHistoryPoint @property {number} ts @property {any} val */
    /** @typedef {object} InfluxHistoryResult @property {InfluxHistoryPoint[]} result */

    // -------------------------------------------------------------------------------------
    // 1. FINALE KONFIGURATION
    // -------------------------------------------------------------------------------------

    // ADAPTER & DATENBANK
    const INFLUXDB_INSTANCE = 'influxdb.0';
    const PUSHOVER_INSTANCE = 'pushover.0'; // GEÄNDERT: Pushover Instanz
    const SQL_INSTANCE = 'sql.0';
    const DB_NAME = 'iobroker_heizung';
    const SCHEDULE = '*/30 * * * *';

    // NEU: Schalter für Benachrichtigungen
    const SEND_PUSHOVER_NOTIFICATIONS = false; // Auf `false` setzen, um Benachrichtigungen zu deaktivieren

    const LERN_PARAMETER = {
        analyseZeitraumStunden: 4,
        minDurationMinutes: 25,
        tempTolerance: 1.0
    };

    // GRENZEN FÜR KATEGORISIERUNG
    const GRENZEN = {
        temp: [-25, -20, -15, -10, -5, 0, 5, 10, 15, 20],
        solar: [0.1, 0.4, 0.7],
        wind: [1.1, 1.3, 1.5]
    };

    // DATENPUNKTE
    const DATENPUNKTE = {
        raeume: [
            { name: 'Wohnzimmer', thermostatId: 'hm-rpc.2.INT0000005.1', wetterAusrichtung: ['Sued', 'West'] },
            { name: 'Schlafzimmer', thermostatId: 'hm-rpc.2.INT0000001.1', wetterAusrichtung: ['Sued', 'West'] },
            { name: 'Badezimmer', thermostatId: 'hm-rpc.2.INT0000002.1', wetterAusrichtung: ['Nord', 'Ost'] },
            { name: 'Kueche', thermostatId: 'hm-rpc.2.INT0000003.1', wetterAusrichtung: ['Nord', 'Ost'] },
            { name: 'Esszimmer', thermostatId: 'hm-rpc.2.INT0000004.1', wetterAusrichtung: ['Nord', 'Ost'] }
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
        }
    };


    // -------------------------------------------------------------------------------------
    // 2. HILFSFUNKTIONEN
    // -------------------------------------------------------------------------------------

    /**
     * Baut eine sichere SQL-Abfrage aus einer Vorlage und Parametern.
     * @param {string} query Die SQL-Vorlage mit ?-Platzhaltern.
     * @param {any[]} params Ein Array mit den Werten.
     * @returns {string} Der fertige SQL-String.
     */
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
        } catch (e) {
            log(`[Fehler] Datenbank-Tabelle konnte nicht initialisiert werden: ${e.message || e}`, 'error');
        }
    }

    async function getHistoryData(raum, start, end) {
        const idsToFetch = [
            `${raum.thermostatId}.ACTUAL_TEMPERATURE`,
            `${raum.thermostatId}.SET_POINT_TEMPERATURE`,
            DATENPUNKTE.wetter.aussenTemp,
            ...Object.values(DATENPUNKTE.global)
        ];
        raum.wetterAusrichtung.forEach(richtung => {
            idsToFetch.push(`${DATENPUNKTE.wetter.basisPfadSolar}_${richtung}`);
            idsToFetch.push(`${DATENPUNKTE.wetter.basisPfadWind}_${richtung}`);
        });

        const idMap = {};
        const promises = idsToFetch.map(id => {
            const isSollTemp = id.includes('.SET_POINT_TEMPERATURE');
            const options = {
                end: end,
                aggregate: 'none',
                count: isSollTemp ? 1 : 500
            };
            if (!isSollTemp) {
                options.start = start;
            }
            const key = id.replace(/\./g, '_');
            idMap[key] = id;
            return sendToAsync(INFLUXDB_INSTANCE, 'getHistory', { id, options }).then(res => ({ key, res }) );
        });

        try {
            const results = await Promise.all(promises);
            const historien = {};
            results.forEach(item => {
                /** @type {InfluxHistoryResult} */
                const result = item.res;
                historien[idMap[item.key]] = result?.result || [];
            });
            return historien;
        } catch(e) {
            log(`[Fehler] Kritischer Fehler beim Datenabruf für ${raum.name}: ${e.message}`, 'error');
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
    // 3. KERNLOGIK: PHASEN-ANALYSE & SPEICHERUNG
    // -------------------------------------------------------------------------------------

    function getKontextAt(ts, raum, historien) {
        const aussenTemp = getValueAt(ts, historien[DATENPUNKTE.wetter.aussenTemp]);
        if (aussenTemp === null) return null;

        let maxSolar = 0, maxWind = 1;
        raum.wetterAusrichtung.forEach(richtung => {
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
            basisSoll: basisSoll
        };
    }

    async function speichereErfahrung(erfahrung) {
        const query = `
            INSERT INTO ${DB_NAME}.heizungs_erfahrung (raum, temp_bereich, solar_level, wind_level, tageszeit, offset_erfolg)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                offset_erfolg = ((offset_erfolg * nutzungs_zaehler) + VALUES(offset_erfolg)) / (nutzungs_zaehler + 1),
                nutzungs_zaehler = nutzungs_zaehler + 1;
        `;
        
        const params = [
            erfahrung.raum,
            erfahrung.temp_bereich,
            erfahrung.solar_level,
            erfahrung.wind_level,
            erfahrung.tageszeit,
            erfahrung.offset_erfolg
        ];

        try {
            const finalQuery = buildQuery(query, params);
            log(`[SQL] Sende Abfrage: ${finalQuery.replace(/\s\s+/g, ' ')}`);
            const result = await sendToAsync(SQL_INSTANCE, 'query', finalQuery);
            log(`[SQL] Antwort vom Adapter: ${JSON.stringify(result)}`);
            log(`[SQL] Erfahrung für ${erfahrung.raum} erfolgreich verarbeitet.`);
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
                            offset_erfolg: parseFloat((soll - kontext.basisSoll).toFixed(2))
                        };
                        
                        await speichereErfahrung(erfahrung);

                        // GEÄNDERT: Pushover Logik
                        if (SEND_PUSHOVER_NOTIFICATIONS) {
                            const message = `Phase für ${raum.name} gelernt!\nDauer: ${dauerMinuten} Min.\nSoll: ${soll}°C, Außen: ${getValueAt(midTs, historien[DATENPUNKTE.wetter.aussenTemp])}°C`;
                            try {
                                // GEÄNDERT: Priority angepasst für Pushover. 
                                // Gotify Priority 2 = Low. 
                                // Pushover Priority 2 = Emergency (Benötigt Retry/Expire).
                                // Daher auf 0 (Normal) gesetzt.
                                await sendToAsync(PUSHOVER_INSTANCE, 'send', { 
                                    message, 
                                    title: 'Heizungs-Lerner', 
                                    priority: -2 
                                });
                            } catch(e) { /* ignorieren */ }
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
    // 4. HAUPTFUNKTION & ZEITPLANUNG
    // -------------------------------------------------------------------------------------

    async function main() {
        log(`[Start] Starte Analyse-Lauf V3.5...`);
        const end = new Date().getTime();
        const start = end - (LERN_PARAMETER.analyseZeitraumStunden * 3600 * 1000);

        for (const raum of DATENPUNKTE.raeume) {
            log(`--- Analysiere Raum: ${raum.name} ---`);
            const historien = await getHistoryData(raum, start, end);
            if (historien) {
                await analysiereStabilePhasen(raum, historien);
            }
        }
        log('[Ende] Analyse-Lauf V3.5 abgeschlossen.');
    }

    (async () => {
        await initialisiereDatenbank();
        log(`[Skript] Heizungs-Lerner V3.5 gestartet. Nächster Lauf: In 30 Sekunden, dann alle 30 Minuten.`);
        schedule(SCHEDULE, main);
        setTimeout(main, 30000);
    })();

})();