// @ts-check
/**
 * @fileoverview Heizungs-Stratege (Wissen abrufen)
 * @version 1.7 - Typ-sicher
 * @author Sanweb / Gemini
 * @license MIT
 *
 * Ruft basierend auf der aktuellen Situation die passende gelernte Erfahrung
 * aus der Datenbank ab und stellt sie als Empfehlung bereit.
 *
 * FUNKTIONEN (Version 1.7):
 * - Korrigiert die JSDoc-Typdefinition für SQL-Ergebnisse, um den von
 * TypeScript gemeldeten Fehler `Argument of type 'number' is not assignable...`
 * zu beheben.
 * - Stellt durch eine Hilfsvariable sicher, dass der geparste Zahlenwert
 * konsistent verwendet wird.
 */

(function(){
    "use strict";

    // HILFSTYPEN
    /**
     * @typedef {object} SqlQueryResultRow
     * @property {string} offset_erfolg // DECIMAL/NUMBER-Typen werden vom SQL-Adapter als String zurückgegeben.
     * @property {number} nutzungs_zaehler
     */
    /**
     * @typedef {object} SqlQueryResult
     * @property {SqlQueryResultRow[]} result
     */

    // -------------------------------------------------------------------------------------
    // 1. KONFIGURATION
    // -------------------------------------------------------------------------------------

    const SQL_INSTANCE = 'sql.0';
    const DB_NAME = 'iobroker_heizung';
    const SCHEDULE = '*/15 * * * *'; // Läuft alle 15 Minuten

    // Basis-Pfad für die neuen Empfehlungs-Datenpunkte
    const BASIS_PFAD_PROGNOSE = '0_userdata.0.Heizung.Prognose';

    const GRENZEN = {
        temp: [0, 5, 10, 15],
        solar: [0.1, 0.4, 0.7],
        wind: [1.1, 1.3, 1.5]
    };

    const DATENPUNKTE = {
        raeume: [
            { name: 'Wohnzimmer', wetterAusrichtung: ['Sued', 'West'] },
            { name: 'Schlafzimmer', wetterAusrichtung: ['Sued', 'West'] },
            { name: 'Badezimmer', wetterAusrichtung: ['Nord', 'Ost'] },
            { name: 'Kueche', wetterAusrichtung: ['Nord', 'Ost'] },
            { name: 'Esszimmer', wetterAusrichtung: ['Nord', 'Ost'] }
        ],
        wetter: {
            basisPfadSolar: '0_userdata.0.Heizung.Analyse.Wetter_Heizunterstuetzung_Solar',
            basisPfadWind: '0_userdata.0.Heizung.Analyse.Wetter_Waermeverlust_Wind',
            aussenTemp: 'hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE',
        }
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

    async function initialisiereDatenpunkte() {
        log('[Initialisierung] Prüfe und erstelle Empfehlungs-Datenpunkte...');
        for (const raum of DATENPUNKTE.raeume) {
            const raumPfad = `${BASIS_PFAD_PROGNOSE}.${raum.name}`;
            const offsetDp = `${raumPfad}.Empfohlener_Offset`;
            const vertrauenDp = `${raumPfad}.Empfohlener_Offset_Vertrauen`;

            if (!(await existsStateAsync(offsetDp))) {
                await createStateAsync(offsetDp, 0.0, {
                    name: `Empfohlener Offset für ${raum.name}`,
                    type: 'number',
                    role: 'value.temperature',
                    unit: '°C',
                    read: true,
                    write: false,
                    def: 0.0
                });
                log(`[Initialisierung] Datenpunkt ${offsetDp} wurde erstellt.`);
            }

            if (!(await existsStateAsync(vertrauenDp))) {
                await createStateAsync(vertrauenDp, 0, {
                    name: `Vertrauenslevel der Empfehlung für ${raum.name}`,
                    type: 'number',
                    role: 'value',
                    unit: '',
                    read: true,
                    write: false,
                    def: 0
                });
                log(`[Initialisierung] Datenpunkt ${vertrauenDp} wurde erstellt.`);
            }
        }
        log('[Initialisierung] Datenpunkt-Prüfung abgeschlossen.');
    }

    function getKategorie(value, grenzen) {
        if (value === null || typeof value === 'undefined') return 'unbekannt';
        for (let i = grenzen.length - 1; i >= 0; i--) {
            if (value >= grenzen[i]) return `kat_${i + 1}`;
        }
        return `kat_0`;
    }

    function getTageszeit() {
        const stunde = new Date().getHours();
        if (stunde >= 5 && stunde < 12) return 'morgens';
        if (stunde >= 12 && stunde < 18) return 'mittags';
        if (stunde >= 18 && stunde < 23) return 'abends';
        return 'nachts';
    }

    async function getAktuellenKontext(raum) {
        try {
            const aussenTempState = await getStateAsync(DATENPUNKTE.wetter.aussenTemp);
            if (!aussenTempState || aussenTempState.val === null) return null;

            let maxSolar = 0, maxWind = 1;
            for (const richtung of raum.wetterAusrichtung) {
                const solarState = await getStateAsync(`${DATENPUNKTE.wetter.basisPfadSolar}_${richtung}`);
                if (solarState && typeof solarState.val === 'number' && solarState.val > maxSolar) maxSolar = solarState.val;

                const windState = await getStateAsync(`${DATENPUNKTE.wetter.basisPfadWind}_${richtung}`);
                if (windState && typeof windState.val === 'number' && windState.val > maxWind) maxWind = windState.val;
            }

            return {
                raum: raum.name,
                temp_bereich: getKategorie(aussenTempState.val, GRENZEN.temp),
                solar_level: getKategorie(maxSolar, GRENZEN.solar),
                wind_level: getKategorie(maxWind, GRENZEN.wind),
                tageszeit: getTageszeit()
            };
        } catch (e) {
            log(`[Fehler] Konnte aktuellen Kontext für ${raum.name} nicht ermitteln: ${e.message}`, 'warn');
            return null;
        }
    }


    // -------------------------------------------------------------------------------------
    // 3. KERNLOGIK: ERFAHRUNG ABRUFEN
    // -------------------------------------------------------------------------------------

    async function getErfahrung(kontext) {
        const query = `
            SELECT offset_erfolg, nutzungs_zaehler
            FROM ${DB_NAME}.heizungs_erfahrung
            WHERE raum = ? AND temp_bereich = ? AND solar_level = ? AND wind_level = ? AND tageszeit = ?
            LIMIT 1;
        `;
        const params = [
            kontext.raum,
            kontext.temp_bereich,
            kontext.solar_level,
            kontext.wind_level,
            kontext.tageszeit
        ];

        try {
            const finalQuery = buildQuery(query, params);
            /** @type {SqlQueryResult} */
            const result = await sendToAsync(SQL_INSTANCE, 'query', finalQuery);
            
            if (result && result.result && result.result.length > 0) {
                return {
                    offset: result.result[0].offset_erfolg,      // Wird als String zurückgegeben
                    vertrauen: result.result[0].nutzungs_zaehler
                };
            }
            return { offset: "0.0", vertrauen: 0 }; // Keine Erfahrung gefunden, gebe String zurück für Konsistenz
        } catch (e) {
            log(`[Fehler] SQL-Fehler beim Abrufen der Erfahrung: ${e.message}`, 'error');
            return { offset: "0.0", vertrauen: 0 };
        }
    }


    // -------------------------------------------------------------------------------------
    // 4. HAUPTFUNKTION & ZEITPLANUNG
    // -------------------------------------------------------------------------------------

    async function main() {
        log('[Stratege] Starte Empfehlungs-Lauf...');
        for (const raum of DATENPUNKTE.raeume) {
            const kontext = await getAktuellenKontext(raum);
            if (kontext) {
                const erfahrung = await getErfahrung(kontext);
                
                const offsetDp = `${BASIS_PFAD_PROGNOSE}.${raum.name}.Empfohlener_Offset`;
                const vertrauenDp = `${BASIS_PFAD_PROGNOSE}.${raum.name}.Empfohlener_Offset_Vertrauen`;

                // Der 'offset' von der Datenbank ist ein String, also müssen wir ihn parsen.
                const offsetAsNumber = parseFloat(erfahrung.offset);

                await setStateAsync(offsetDp, offsetAsNumber, true);
                await setStateAsync(vertrauenDp, erfahrung.vertrauen, true);

                // Für die Log-Ausgabe verwenden wir die geparste Zahl.
                log(`[Stratege] Empfehlung für ${raum.name}: ${offsetAsNumber.toFixed(2)}°C (Vertrauen: ${erfahrung.vertrauen}) | Kontext: Temp=${kontext.temp_bereich}, Solar=${kontext.solar_level}, Wind=${kontext.wind_level}, Zeit=${kontext.tageszeit}`);
            }
        }
        log('[Stratege] Empfehlungs-Lauf abgeschlossen.');
    }

    (async () => {
        await initialisiereDatenpunkte();
        log(`[Skript] Heizungs-Stratege V1.7 gestartet. Nächster Lauf: In 1 Minute, dann alle 15 Minuten.`);
        schedule(SCHEDULE, main);
        setTimeout(main, 60000);
    })();

})();

