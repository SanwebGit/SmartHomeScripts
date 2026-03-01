/*
 * iobroker-skript: Wetterdaten-JSON-Parser
 *
 * Author: Gemini
 * Version: 2.0
 * Datum: 24.09.2025
 *
 * Beschreibung:
 * Dieses Skript überwacht einen MQTT-Datenpunkt, der Wetterdaten als JSON empfängt.
 * Es parst den JSON-String und erstellt bzw. aktualisiert separate Datenpunkte.
 * v2.0:
 * - Effizienz: Schreibt Datenpunkte nur noch bei Wertänderung.
 * - Robustheit: Setzt nicht mehr gesendete Datenpunkte auf 'null'.
 * - Erweiterung: Fügt einen 'lastUpdate'-Zeitstempel hinzu.
 * - Qualität: Skript gekapselt (IIFE) und "use strict" aktiviert.
 */

(function() {
    "use strict";

    // --- KONFIGURATION ---
    const sourceDpId = 'mqtt.0.wetter.gw1100'; // Der Datenpunkt mit dem JSON-String
    const targetPath = '0_userdata.0.Wetter';   // Basispfad für die neuen Datenpunkte
    // --------------------

    const dpMappings = {
        // Generelle Infos
        runtime:        { name: "Laufzeit", type: "number", role: "value", unit: "s" },
        heap:           { name: "Heap-Speicher", type: "number", role: "value", unit: "bytes" },
        lastUpdate:     { name: "Letzte Aktualisierung", type: "string", role: "date", unit: "" },

        // Innen-Sensoren
        tempin:         { name: "Innentemperatur", type: "number", role: "value.temperature", unit: "°C" },
        humidityin:     { name: "Innenluftfeuchtigkeit", type: "number", role: "value.humidity", unit: "%" },

        // Außen-Sensoren
        temp:           { name: "Außentemperatur", type: "number", role: "value.temperature", unit: "°C" },
        humidity:       { name: "Außenluftfeuchtigkeit", type: "number", role: "value.humidity", unit: "%" },
        baromrel:       { name: "Relativer Luftdruck", type: "number", role: "value.pressure", unit: "hPa" },
        baromabs:       { name: "Absoluter Luftdruck", type: "number", role: "value.pressure", unit: "hPa" },
        solarradiation: { name: "Sonneneinstrahlung", type: "number", role: "value.radiation", unit: "W/m²" },
        uv:             { name: "UV-Index", type: "number", role: "value.uv", unit: "" },

        // Wind
        winddir:        { name: "Windrichtung", type: "number", role: "value.direction", unit: "°" },
        winddir_avg10m: { name: "Windrichtung (10min ø)", type: "number", role: "value.direction", unit: "°" },
        windspeed:      { name: "Windgeschwindigkeit", type: "number", role: "value.speed.wind", unit: "km/h" },
        windgust:       { name: "Windböe", type: "number", role: "value.speed.wind.gust", unit: "km/h" },
        maxdailygust:   { name: "Maximale tägliche Böe", type: "number", role: "value.speed.wind.max", unit: "km/h" },
        beaufortscale:  { name: "Beaufort-Skala", type: "number", role: "value", unit: "" },
        winddir_name:   { name: "Windrichtung (Name)", type: "string", role: "text", unit: "" },

        // Regen
        rainrate:       { name: "Regenrate", type: "number", role: "value.rain.rate", unit: "mm/h" },
        eventrain:      { name: "Regen (Ereignis)", type: "number", role: "value.rain", unit: "mm" },
        hourlyrain:     { name: "Regen (Stündlich)", type: "number", role: "value.rain", unit: "mm" },
        dailyrain:      { name: "Regen (Täglich)", type: "number", role: "value.rain.today", unit: "mm" },
        last24hrain:    { name: "Regen (Letzte 24h)", type: "number", role: "value.rain", unit: "mm" },
        weeklyrain:     { name: "Regen (Wöchentlich)", type: "number", role: "value.rain", unit: "mm" },
        monthlyrain:    { name: "Regen (Monatlich)", type: "number", role: "value.rain", unit: "mm" },
        yearlyrain:     { name: "Regen (Jährlich)", type: "number", role: "value.rain", unit: "mm" },
        totalrain:      { name: "Regen (Gesamt)", type: "number", role: "value.rain", unit: "mm" },

        // Boden & PM2.5
        soilmoisture1:  { name: "Bodenfeuchtigkeit 1", type: "number", role: "value.humidity", unit: "%" },
        pm25_ch1:       { name: "Feinstaub PM2.5 Ch 1", type: "number", role: "value.pm25", unit: "µg/m³" },

        // Blitze
        lightning_num:  { name: "Anzahl Blitze", type: "number", role: "value", unit: "" },
        lightning:      { name: "Entfernung letzter Blitz", type: "number", role: "value.distance", unit: "km" },
        lightning_time: { name: "Zeitpunkt letzter Blitz", type: "string", role: "date", unit: "" },

        // berechnete Werte
        dewpoint:       { name: "Taupunkt", type: "number", role: "value.temperature", unit: "°C" },
        feelslike:      { name: "Gefühlte Temperatur", type: "number", role: "value.temperature.feelslike", unit: "°C" },
        heatindex:      { name: "Hitzeindex", type: "number", role: "value.temperature", unit: "°C" },
        windchill:      { name: "Windchill", type: "number", role: "value.temperature.windchill", unit: "°C" },
        thermalperception: { name: "Thermisches Empfinden", type: "string", role: "text", unit: "" },
        solarradiation_perceived: { name: "Sonneneinstrahlung wahrgenommen.", type: "number", role: "value.radiation", unit: "W/m²" },
        humidex:        { name: "Feuchte-Index", type: "number", role: "value", unit: "" },
        frostpoint:     { name: "Frostpunkt", type: "number", role: "value.temperature", unit: "°C" },
        frostrisk:      { name: "Frostrisiko", type: "string", role: "text", unit: "" },
        humidityabs:    { name: "Absolute Luftfeuchtigkeit (Aussen)", type: "number", role: "value.humidity", unit: "g/m³" },
        humidityabsin:  { name: "Absolute Luftfeuchtigkeit (Innen)", type: "number", role: "value.humidity", unit: "g/m³" },

        // Batteriestatus
        wh65batt:       { name: "Batterie WH65", type: "string", role: "text", unit: "" },
        soilbatt1:      { name: "Batterie Bodenfeuchtesensor 1", type: "number", role: "value.voltage", unit: "V" },
        pm25batt1:      { name: "Batterie PM2.5 Sensor 1", type: "number", role: "value.battery", unit: "%" },
        wh57batt:       { name: "Batterie WH57", type: "number", role: "value.battery", unit: "%" },
    };

    /**
     * Stellt sicher, dass ein Datenpunkt existiert. Wenn nicht, wird er erstellt.
     * @param {string} id - Die ID des Datenpunkts.
     * @param {string} key - Der Schlüssel aus dem JSON, um das Mapping zu finden.
     * @param {any} value - Der aktuelle Wert, der als Standardwert verwendet wird.
     */
    async function ensureStateExists(id, key, value) {
        if (!(await existsStateAsync(id))) {
            log(`[Wetter] -> Datenpunkt ${id} existiert nicht und wird angelegt.`, 'info');
            const mapping = dpMappings[key] || {};
            const valueType = typeof value;
            const common = {
                name: mapping.name || key,
                type: mapping.type || valueType,
                role: mapping.role || (valueType === 'number' ? 'value' : 'text'),
                unit: mapping.unit || '',
                read: true,
                write: false,
                def: value,
            };
            await createStateAsync(id, common);
        }
    }

    /**
     * Hauptfunktion zum Verarbeiten der JSON-Daten.
     * @param {string} jsonString - Der JSON-String aus dem Quelldatenpunkt.
     */
    async function processWeatherData(jsonString) {
        let dataObj;
        try {
            dataObj = JSON.parse(jsonString);
        } catch (e) {
            log(`[Wetter] -> Fehler beim Parsen des JSON-Strings: ${e}`, 'error');
            return;
        }

        if (typeof dataObj !== 'object' || dataObj === null) {
            log('[Wetter] -> Die geparsten Daten sind kein valides Objekt.', 'warn');
            return;
        }

        const receivedKeys = new Set();

        // 1. Datenpunkte aktualisieren oder erstellen
        for (const key in dataObj) {
            if (Object.prototype.hasOwnProperty.call(dataObj, key)) {
                let value = dataObj[key];
                if (value === null) continue;

                const targetDpId = `${targetPath}.${key}`;
                receivedKeys.add(targetDpId);

                if (typeof value === 'number' && value % 1 !== 0) {
                    value = Math.round(value * 100) / 100;
                }

                await ensureStateExists(targetDpId, key, value);

                // Effizienz: Nur schreiben, wenn sich der Wert geändert hat
                const oldState = await getStateAsync(targetDpId);
                if (!oldState || oldState.val !== value) {
                    await setStateAsync(targetDpId, value, true);
                }
            }
        }
        
        // 2. 'lastUpdate'-Zeitstempel aktualisieren
        const lastUpdateDpId = `${targetPath}.lastUpdate`;
        receivedKeys.add(lastUpdateDpId);
        const timestamp = new Date().toLocaleString('de-DE');
        await ensureStateExists(lastUpdateDpId, 'lastUpdate', timestamp);
        await setStateAsync(lastUpdateDpId, timestamp, true);

        // 3. Robustheit: Veraltete Datenpunkte auf null setzen
        const existingDps = $(`state[id=${targetPath}.*]`);
        for (const dpId of existingDps) {
             if (!receivedKeys.has(dpId)) {
                const obsoleteState = await getStateAsync(dpId);
                if (obsoleteState && obsoleteState.val !== null) {
                    log(`[Wetter] -> Datenpunkt ${dpId} wird nicht mehr empfangen und auf 'null' gesetzt.`, 'info');
                    await setStateAsync(dpId, null, true);
                }
            }
        }
    }

    // Skript-Start
    async function main() {
        const initialState = getState(sourceDpId);
        if (initialState && initialState.val) {
            log(`Führe Skript bei Start aus für ${sourceDpId}.`);
            await processWeatherData(initialState.val);
        }

        on({ id: sourceDpId, change: 'any' }, async (obj) => {
            if (obj.state && obj.state.val && typeof obj.state.val === 'string') {
                await processWeatherData(obj.state.val);
            }
        });

        log('[Wetter] -> Wetter-Parser-Skript V2.0 gestartet. Warte auf Daten von ' + sourceDpId);
    }

    main().catch(err => {
        log(`[Wetter] -> Ein unerwarteter Fehler im Skript ist aufgetreten: ${err}`, 'error');
    });

})();

