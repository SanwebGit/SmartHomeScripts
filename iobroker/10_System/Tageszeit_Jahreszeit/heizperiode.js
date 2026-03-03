/*
 * SKRIPT-KONVERTIERUNG & OPTIMIERUNG FÜR IOBROKER
 *
 * Zweck: Bestimmt automatisch die Heizperiode anhand der Tagesmitteltemperatur.
 * Version: 2.7 (Laufzeitfehler durch Entfernen von TypeScript-Syntax behoben)
 *
 * Verbesserungen gegenüber dem ursprünglichen Homematic-Skript:
 * 1. Ereignisgesteuert: Das Skript wird nur bei Bedarf ausgeführt.
 * 2. Robuste Mittelwertberechnung: Zählt die Messungen für einen echten Durchschnitt.
 * 3. Automatische Datenpunkterstellung: Vereinfacht die Einrichtung erheblich.
 * 4. Stabilitäts-Check: Verarbeitet nur gültige Zahlenwerte vom Sensor.
 * 5. Gekapselt: Verhindert Konflikte mit anderen Skripten.
 */

(async () => {

    // --------------- ANPASSBARE PARAMETER ---------------

    // ID des Außentemperatensors
    const ID_SENSOR_TEMP = "hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE";

    // Schwellwert in °C: Unterhalb dieser Tagesmitteltemperatur wird die Heizperiode aktiv.
    const HEIZGRENZE = 18.0;

    // Uhrzeit für die tägliche Berechnung und den Reset.
    const RESET_STUNDE = 2;
    const RESET_MINUTE = 50;

    // --------------- DATENPUNKTE (VOLLSTÄNDIGE PFADE) ---------------

    const ID_MITTELWERT = "0_userdata.0.Heizung.Allgemein.Tagesmittelwert";
    const ID_ZWISCHENSPEICHER = "0_userdata.0.Heizung.Allgemein.ZwischenspeicherSumme";
    const ID_ZAEHLER = "0_userdata.0.Heizung.Allgemein.MessungenZaehler";
    const ID_HEIZPERIODE = "0_userdata.0.Heizung.Allgemein.HeizperiodeAktiv";
    const ID_LETZTER_RESET = "0_userdata.0.Heizung.Allgemein.LetzterReset";


    /**
     * Erstellt alle notwendigen ioBroker-Datenpunkte, falls sie noch nicht existieren.
     */
    async function erstelleDatenpunkte() {
        log("Prüfe und erstelle benötigte Datenpunkte...");
        const datenpunkte = {
            [ID_MITTELWERT]: { name: "Tagesmitteltemperatur des letzten Tages", type: "number", role: "value.temperature", unit: "°C", def: 0 },
            [ID_ZWISCHENSPEICHER]: { name: "Akkumulierte Temperatur für den aktuellen Tag", type: "number", role: "value.temperature", unit: "°C", def: 0 },
            [ID_ZAEHLER]: { name: "Anzahl der Temperaturmessungen für den aktuellen Tag", type: "number", role: "value", unit: "", def: 0 },
            [ID_HEIZPERIODE]: { name: "Heizperiode ist aktiv", type: "boolean", role: "indicator.heating", def: false },
            [ID_LETZTER_RESET]: { name: "Datum des letzten Resets", type: "string", role: "date", unit: "", def: "nie" }
        };

        for (const [id, common] of Object.entries(datenpunkte)) {
            if (!await existsStateAsync(id)) {
                // @ts-ignore
                await createStateAsync(id, common.def, { name: common.name, type: common.type, role: common.role, unit: common.unit, read: true, write: true });
                log(`Datenpunkt '${id}' wurde erstellt.`);
            }
        }
        log("Alle Datenpunkte sind vorhanden.");
    }


    // --- HAUPTPROGRAMM ---

    // 1. Alle benötigten States beim Skriptstart anlegen und darauf warten.
    await erstelleDatenpunkte();

    // Startmeldung ins Log schreiben
    log(`Skript gestartet. Überwache Temperatursensor: ${ID_SENSOR_TEMP}`);

    /**
     * Trigger 1: Wird bei jeder Aktualisierung des Temperatursensors ausgeführt.
     * Speichert die Temperatur und zählt die Messungen für die spätere Mittelwertbildung.
     */
    // @ts-ignore
    on({ id: ID_SENSOR_TEMP, change: "any" }, async function (obj) {
        const aktuelleTemp = obj.state.val;

        // Prüfung, ob der Wert eine gültige Zahl ist.
        if (typeof aktuelleTemp !== 'number') {
            log(`Ungültiger Wert vom Sensor empfangen: ${aktuelleTemp} (Typ: ${typeof aktuelleTemp}). Überspringe Verarbeitung.`, 'warn');
            return;
        }

        // Hole alte Werte und addiere den neuen Wert hinzu
        const alteSumme = (await getStateAsync(ID_ZWISCHENSPEICHER)).val || 0;
        const alterZaehler = (await getStateAsync(ID_ZAEHLER)).val || 0;

        const neueSumme = alteSumme + aktuelleTemp;
        const neuerZaehler = alterZaehler + 1;

        // Schreibe die neuen Werte zurück in die Datenpunkte
        await setStateAsync(ID_ZWISCHENSPEICHER, neueSumme, true);
        await setStateAsync(ID_ZAEHLER, neuerZaehler, true);
    });

    /**
     * Trigger 2: Führt die tägliche Berechnung zur festgelegten Zeit aus (lokale Serverzeit).
     * Berechnet den Mittelwert, setzt die Heizperiode und setzt die Speicher zurück.
     * INFO: 02:50 MEZ (Winter) = 01:50 UTC | 02:50 MESZ (Sommer) = 00:50 UTC.
     */
    // @ts-ignore
    schedule(`${RESET_MINUTE} ${RESET_STUNDE} * * *`, async function () {
        log("Tagesabschluss wird durchgeführt: Berechne Tagesmittel und setze Heizperiode.");

        // 1. Werte aus den Datenpunkten auslesen
        const summe = (await getStateAsync(ID_ZWISCHENSPEICHER)).val;
        const zaehler = (await getStateAsync(ID_ZAEHLER)).val;

        // 2. Tagesmittelwert berechnen (Schutz vor Division durch Null)
        const tagesMittel = (zaehler > 0) ? (summe / zaehler) : 0;
        await setStateAsync(ID_MITTELWERT, parseFloat(tagesMittel.toFixed(2)), true);
        log(`Tagesmittel berechnet: ${tagesMittel.toFixed(2)}°C (Summe: ${summe.toFixed(2)}°C / Zähler: ${zaehler})`);

        // 3. Zwischenspeicher, Zähler und Reset-Datum für den nächsten Tag zurücksetzen
        await setStateAsync(ID_ZWISCHENSPEICHER, 0, true);
        await setStateAsync(ID_ZAEHLER, 0, true);
        
        const jetzt = new Date();
        const tag = String(jetzt.getDate()).padStart(2, '0');
        const monatFormatiert = String(jetzt.getMonth() + 1).padStart(2, '0');
        const jahr = jetzt.getFullYear();
        const datumString = `${tag}.${monatFormatiert}.${jahr}`;
        await setStateAsync(ID_LETZTER_RESET, datumString, true);

        log("Zwischenspeicher, Zähler und Reset-Datum wurden aktualisiert.");

        // 4. Heizperiode bestimmen und setzen
        const monat = jetzt.getMonth() + 1; // getMonth() ist 0-basiert (0=Jan), daher +1
        const istHeizZeitraum = (monat >= 10 || monat <= 5); // Oktober bis Mai
        const istUnterHeizgrenze = (tagesMittel <= HEIZGRENZE);
        const heizperiodeAktiv = (istUnterHeizgrenze && istHeizZeitraum);

        await setStateAsync(ID_HEIZPERIODE, heizperiodeAktiv, true);
        
        // OPTIMIERT: Detailliertere Log-Ausgabe für bessere Nachvollziehbarkeit
        if (!istHeizZeitraum) {
            log(`Heizperiode gesetzt auf: ${heizperiodeAktiv}. Grund: Außerhalb des Zeitraums (Oktober-Mai).`);
        } else if (!istUnterHeizgrenze) {
            log(`Heizperiode gesetzt auf: ${heizperiodeAktiv}. Grund: Tagesmittel (${tagesMittel.toFixed(2)}°C) liegt über der Heizgrenze (${HEIZGRENZE}°C).`);
        } else {
            log(`Heizperiode gesetzt auf: ${heizperiodeAktiv}. Grund: Im Heizzeitraum und Tagesmittel (${tagesMittel.toFixed(2)}°C) unter der Heizgrenze (${HEIZGRENZE}°C).`);
        }
    });

})();

