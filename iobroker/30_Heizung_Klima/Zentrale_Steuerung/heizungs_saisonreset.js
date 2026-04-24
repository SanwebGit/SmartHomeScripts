// @ts-check
/* global clearInterval, clearSchedule, clearTimeout, createState,
   createStateAsync, existsState, existsStateAsync, getObjectAsync,
   getState, getStateAsync, log, on, onStop, require, schedule,
   sendTo, sendToAsync, setInterval, setObjectAsync, setState,
   setStateAsync, setTimeout */

/**
 * @fileoverview Saisonaler Reset des Nutzungszaehlers (Paket 4)
 * @version 1.0 - Initialversion
 * @author Sanweb
 * @license MIT
 *
 * -------------------------------------------------------------------------------------
 * ZWECK DES SKRIPTS:
 * -------------------------------------------------------------------------------------
 * Setzt am 1. Oktober um 03:00 Uhr den Nutzungszaehler aller alten Kontexte
 * moderat zurueck (LEAST auf 20), damit neue Beobachtungen am Saisonbeginn
 * im zeitgewichteten Lernalgorithmus mehr Gewicht bekommen.
 *
 * Der offset_erfolg-Wert selbst wird NICHT zurueckgesetzt. Er bleibt als
 * Startwert fuer die neue Saison erhalten. Alle 288 (und mehr) Datensaetze
 * bleiben vollstaendig als Erfahrungsbasis erhalten.
 *
 * Nur Kontexte die laenger als 6 Monate nicht genutzt wurden werden
 * zurueckgesetzt — damit bleiben frische Beobachtungen aus der Uebergangszeit
 * mit ihrem aktuellen Gewicht bestehen.
 *
 * Dieses Skript ist BEWUSST eigenstaendig (nicht im Lerner enthalten):
 *   - unabhaengige Ausfuehrung
 *   - manuelles Nachholen moeglich (Skript neu starten -> ausfuehren)
 *   - keine Interferenz mit der 30-Minuten-Lern-Schleife
 *
 * DATENFLUSS:
 *   ioBroker-Schedule (01.10. 03:00)
 *     -> sendTo('sql.0', 'query', UPDATE heizungs_erfahrung ...)
 *     -> Status-Datenpunkte aktualisieren
 * -------------------------------------------------------------------------------------
 */

(function () {
    'use strict';

    // HILFSTYPEN
    /**
     * @typedef {object} SqlUpdateResultRow
     * @property {number} [affectedRows]
     */
    /**
     * @typedef {object} SqlUpdateResult
     * @property {SqlUpdateResultRow[]} result
     * @property {number} [affectedRows]
     */

    // -------------------------------------------------------------------------------------
    // 1. KONFIGURATION
    // -------------------------------------------------------------------------------------

    const SQL_INSTANCE = 'sql.0';
    const DB_NAME = 'iobroker_heizung';

    // Cron: Minute 0, Stunde 3, Tag 1, Monat 10 (Oktober), jeder Wochentag
    // -> 1. Oktober, 03:00 Uhr jedes Jahres
    const SCHEDULE_RESET = '0 3 1 10 *';

    // Maximalwert auf den der Nutzungszaehler reduziert wird.
    // Bei 20 Beobachtungen hat eine neue Beobachtung ca. 3-5% Gewicht
    // (je nach Lernalgorithmus) — ausreichend um nicht zu dominieren,
    // aber hoch genug damit neue Saisons schnell Einfluss gewinnen.
    const RESET_ZAEHLER_MAX = 20;

    // Nur Kontexte zuruecksetzen die laenger als X Monate nicht genutzt wurden.
    // 6 Monate = Kontexte aus der letzten Heizperiode, die in der Uebergangszeit
    // nicht wieder aktiviert wurden.
    const RESET_MINDEST_ALTER_MONATE = 6;

    // Status-Datenpunkte
    const DATENPUNKTE_STATUS = {
        letzterReset: '0_userdata.0.Heizung.Lernsystem.Saisonreset_Letzter_Lauf',
        letzterResetAffectedRows: '0_userdata.0.Heizung.Lernsystem.Saisonreset_Betroffene_Zeilen',
    };

    const DEBUG_LOG_AKTIV = true;

    // -------------------------------------------------------------------------------------
    // 2. HILFSFUNKTIONEN
    // -------------------------------------------------------------------------------------

    async function initialisiereStatusDatenpunkte() {
        if (!(await existsStateAsync(DATENPUNKTE_STATUS.letzterReset))) {
            await createStateAsync(DATENPUNKTE_STATUS.letzterReset, 0, {
                name: 'Zeitstempel des letzten Saisonresets',
                type: 'number',
                role: 'date',
                read: true,
                write: false,
                def: 0,
            });
            log(`[Init] Datenpunkt ${DATENPUNKTE_STATUS.letzterReset} erstellt.`, 'info');
        }

        if (!(await existsStateAsync(DATENPUNKTE_STATUS.letzterResetAffectedRows))) {
            await createStateAsync(DATENPUNKTE_STATUS.letzterResetAffectedRows, 0, {
                name: 'Anzahl der beim letzten Saisonreset angepassten Kontexte',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            });
            log(`[Init] Datenpunkt ${DATENPUNKTE_STATUS.letzterResetAffectedRows} erstellt.`, 'info');
        }
    }

    // -------------------------------------------------------------------------------------
    // 3. KERNLOGIK: RESET
    // -------------------------------------------------------------------------------------

    /**
     * Fuehrt den saisonalen Reset durch.
     * @returns {Promise<number>} Anzahl der betroffenen Zeilen, -1 bei Fehler.
     */
    async function fuehreSaisonresetAus() {
        log('[Saisonreset] ===== START Saisonreset =====', 'info');
        log(`[Saisonreset] Setze Nutzungszaehler > ${RESET_ZAEHLER_MAX} auf ${RESET_ZAEHLER_MAX} fuer alle Kontexte aelter als ${RESET_MINDEST_ALTER_MONATE} Monate.`, 'info');

        // Schritt 1: Vorher-Zaehlung fuer Log-Transparenz
        const countQuery = `
            SELECT COUNT(*) AS anzahl
            FROM ${DB_NAME}.heizungs_erfahrung
            WHERE letzte_nutzung < DATE_SUB(NOW(), INTERVAL ${RESET_MINDEST_ALTER_MONATE} MONTH)
              AND nutzungs_zaehler > ${RESET_ZAEHLER_MAX};
        `;

        try {
            /** @type {any} */
            const countResult = await sendToAsync(SQL_INSTANCE, 'query', countQuery);
            if (countResult && countResult.result && countResult.result.length > 0) {
                const anzahl = countResult.result[0].anzahl;
                log(`[Saisonreset] ${anzahl} Kontexte werden zurueckgesetzt.`, 'info');
            }
        } catch (e) {
            log(`[Saisonreset] Vorher-Zaehlung fehlgeschlagen (nicht kritisch): ${e.message || e}`, 'warn');
        }

        // Schritt 2: Eigentliches UPDATE
        const updateQuery = `
            UPDATE ${DB_NAME}.heizungs_erfahrung
            SET nutzungs_zaehler = LEAST(nutzungs_zaehler, ${RESET_ZAEHLER_MAX})
            WHERE letzte_nutzung < DATE_SUB(NOW(), INTERVAL ${RESET_MINDEST_ALTER_MONATE} MONTH);
        `;

        try {
            if (DEBUG_LOG_AKTIV) {
                log(`[Saisonreset] Sende SQL: ${updateQuery.replace(/\s\s+/g, ' ')}`, 'info');
            }
            /** @type {any} */
            const result = await sendToAsync(SQL_INSTANCE, 'query', updateQuery);
            log(`[Saisonreset] SQL-Antwort: ${JSON.stringify(result)}`, 'info');

            // affectedRows kann je nach SQL-Adapter-Version an unterschiedlicher Stelle liegen
            let affectedRows = 0;
            if (result && typeof result.affectedRows === 'number') {
                affectedRows = result.affectedRows;
            } else if (result && result.result && typeof result.result.affectedRows === 'number') {
                affectedRows = result.result.affectedRows;
            }

            log(`[Saisonreset] Erfolgreich — ${affectedRows} Zeilen angepasst.`, 'info');
            return affectedRows;
        } catch (e) {
            log(`[Saisonreset] FEHLER beim UPDATE: ${e.message || e}`, 'error');
            return -1;
        }
    }

    /**
     * Haupt-Runner: fuehrt Reset durch und aktualisiert Status-Datenpunkte.
     */
    async function main() {
        const jetzt = new Date().getTime();

        const affectedRows = await fuehreSaisonresetAus();

        try {
            await setStateAsync(DATENPUNKTE_STATUS.letzterReset, jetzt, true);
            await setStateAsync(DATENPUNKTE_STATUS.letzterResetAffectedRows, affectedRows, true);
        } catch (e) {
            log(`[Saisonreset] Status-Datenpunkt-Update fehlgeschlagen: ${e.message || e}`, 'warn');
        }

        if (affectedRows >= 0) {
            log(`[Saisonreset] ===== ENDE Saisonreset (Erfolg) =====`, 'info');
        } else {
            log(`[Saisonreset] ===== ENDE Saisonreset (FEHLER) =====`, 'error');
        }
    }

    // -------------------------------------------------------------------------------------
    // 4. SKRIPT-START
    // -------------------------------------------------------------------------------------

    (async () => {
        await initialisiereStatusDatenpunkte();
        log(`[Skript] Heizungs-Saisonreset V1.0 gestartet. Naechster Lauf: ${SCHEDULE_RESET} (01. Okt 03:00).`, 'info');
        schedule(SCHEDULE_RESET, main);
        // Kein setTimeout-Start — das Reset darf nur einmal jaehrlich laufen.
        // Manuelle Ausfuehrung: Skript stoppen, setTimeout(main, 5000) temporaer einfuegen,
        // speichern, starten, danach wieder entfernen.
    })();

})();
