/**
 * ==============================================================================
 * SCRIPT: Heizperioden-Monitor für ioBroker
 * ==============================================================================
 * Autor:         Sanweb
 * Version:       5.4
 * Letzte Änderung: 2025-05-22
 * Zweck:         Automatisierte Bestimmung der Heizperiode basierend auf der 
 * Tagesmitteltemperatur und kalendarischen Zeiträumen.
 * Korrektur:     getStatesAsync durch Promise.all([getStateAsync...]) ersetzt.
 * ==============================================================================
 */

(async () => {
    // --------------- KONFIGURATION ---------------
    const CONFIG = {
        // ID des Sensors, der die Außentemperatur liefert
        sensor: "hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE",
        
        // Temperatur-Grenzwert: Ist das Tagesmittel niedriger als dieser Wert, wird geheizt
        heizgrenze: 18.0,
        
        // Uhrzeit für den täglichen Reset und die Berechnung des Vortages
        resetTime: { hour: 2, minute: 50 },
        
        // Fehlertoleranz: Wartezeit in Minuten vor einem erneuten Berechnungsversuch
        retryDelayMin: 15, 
        
        // Anzahl der maximalen Wiederholungsversuche bei Fehlern im Tagesabschluss
        maxRetries: 3,
        
        // Heizperiode-Monate: Start (10 = Okt) bis Ende (5 = Mai)
        months: { start: 10, end: 5 }, 
        
        // Plausibilitätsprüfung: Sensorwerte außerhalb dieses Bereichs werden ignoriert
        limits: { min: -40, max: 60 },  
        
        // Zielpfade der ioBroker-Datenpunkte
        paths: {
            mittelwert: "0_userdata.0.Heizung.Allgemein.Tagesmittelwert",
            summe: "0_userdata.0.Heizung.Allgemein.ZwischenspeicherSumme",
            zaehler: "0_userdata.0.Heizung.Allgemein.MessungenZaehler",
            aktiv: "0_userdata.0.Heizung.Allgemein.HeizperiodeAktiv",
            letzterReset: "0_userdata.0.Heizung.Allgemein.LetzterReset",
            letzterResetTS: "0_userdata.0.Heizung.Allgemein.LetzterResetTimestamp"
        }
    };

    // --------------- INTERNER STATUS ---------------
    let stateCache = { summe: 0, zaehler: 0 };
    let isResetting = false; 

    /**
     * Erstellt die Datenpunkt-Struktur im ioBroker, falls diese noch nicht existieren.
     */
    async function initDataPoints() {
        const definitions = {
            [CONFIG.paths.mittelwert]: { 
                name: "Tagesmittelwert der Außentemperatur (Vortag)", 
                type: "number", role: "value.temperature", unit: "°C", def: 0 
            },
            [CONFIG.paths.summe]: { 
                name: "Akkumulierte Temperaturwerte des laufenden Tages", 
                type: "number", role: "value.temperature", unit: "°C", def: 0 
            },
            [CONFIG.paths.zaehler]: { 
                name: "Anzahl der eingegangenen Temperaturmessungen heute", 
                type: "number", role: "value", unit: "", def: 0 
            },
            [CONFIG.paths.aktiv]: { 
                name: "Status der Heizperiode (True = Aktiv)", 
                type: "boolean", role: "indicator.heating", def: false 
            },
            [CONFIG.paths.letzterReset]: { 
                name: "Datum der letzten Mittelwertberechnung (Text)", 
                type: "string", role: "date", def: "nie" 
            },
            [CONFIG.paths.letzterResetTS]: { 
                name: "Zeitpunkt der letzten Mittelwertberechnung (Timestamp)", 
                type: "number", role: "value.datetime", def: 0 
            }
        };

        for (const [id, common] of Object.entries(definitions)) {
            if (!(await existsStateAsync(id))) {
                await createStateAsync(id, common.def, { 
                    name: common.name, type: common.type, role: common.role, 
                    unit: common.unit || "", read: true, write: true 
                });
            }
        }
    }

    /**
     * Berechnet den Heizstatus basierend auf dem letzten Mittelwert.
     */
    async function berechneHeizperiode() {
        const jetzt = new Date();
        const monat = jetzt.getMonth() + 1;
        
        const lastMittelState = await getStateAsync(CONFIG.paths.mittelwert);
        const tagesMittel = (lastMittelState && typeof lastMittelState.val === 'number') ? lastMittelState.val : 0;

        const istHeizZeitraum = (monat >= CONFIG.months.start || monat <= CONFIG.months.end);
        const istUnterGrenze = (tagesMittel <= CONFIG.heizgrenze);
        const aktiv = istHeizZeitraum && istUnterGrenze;

        await setStateAsync(CONFIG.paths.aktiv, aktiv, true);
        return aktiv;
    }

    /**
     * Führt den Tagesabschluss durch mit Retry-Logik.
     */
    async function performDailyReset(attempt = 1) {
        isResetting = true; 
        try {
            log(`Tagesabschluss (Versuch ${attempt}/${CONFIG.maxRetries + 1})...`);
            
            const tagesMittel = stateCache.zaehler > 0 ? (stateCache.summe / stateCache.zaehler) : 0;
            const jetzt = new Date();

            await setStateAsync(CONFIG.paths.mittelwert, parseFloat(tagesMittel.toFixed(2)), true);
            await berechneHeizperiode();
            await setStateAsync(CONFIG.paths.letzterReset, jetzt.toLocaleDateString('de-DE'), true);
            await setStateAsync(CONFIG.paths.letzterResetTS, jetzt.getTime(), true);

            stateCache.summe = 0;
            stateCache.zaehler = 0;
            await setStateAsync(CONFIG.paths.summe, 0, true);
            await setStateAsync(CONFIG.paths.zaehler, 0, true);

            log("Tagesabschluss erfolgreich durchgeführt.");
        } catch (e) {
            log(`Fehler beim Tagesabschluss: ${e.message}`, 'warn');
            if (attempt <= CONFIG.maxRetries) {
                log(`Wiederholung in ${CONFIG.retryDelayMin} Minuten...`);
                setTimeout(() => performDailyReset(attempt + 1), CONFIG.retryDelayMin * 60000);
            } else {
                log("Maximale Retries erreicht.", 'error');
            }
        } finally {
            isResetting = false; 
        }
    }

    // --- INITIALISIERUNG ---
    await initDataPoints();
    
    // KORREKTUR: Promise.all für mehrere getStateAsync Aufrufe verwenden
    const [summeState, zaehlerState] = await Promise.all([
        getStateAsync(CONFIG.paths.summe),
        getStateAsync(CONFIG.paths.zaehler)
    ]);

    stateCache.summe = (summeState && typeof summeState.val === 'number') ? summeState.val : 0;
    stateCache.zaehler = (zaehlerState && typeof zaehlerState.val === 'number') ? zaehlerState.val : 0;

    const startStatus = await berechneHeizperiode();
    log(`Skript v5.4 gestartet. Heizstatus: ${startStatus}. Initial-Cache: ${stateCache.summe.toFixed(2)}°C (${stateCache.zaehler} Messungen).`);

    /**
     * Trigger 1: Sensor
     */
    on({ id: CONFIG.sensor, change: "any" }, async (obj) => {
        if (isResetting) return;
        try {
            const val = obj.state.val;
            if (typeof val !== 'number' || val < CONFIG.limits.min || val > CONFIG.limits.max) return;

            stateCache.summe += val;
            stateCache.zaehler++;

            await setStateAsync(CONFIG.paths.summe, stateCache.summe, true);
            await setStateAsync(CONFIG.paths.zaehler, stateCache.zaehler, true);
        } catch (e) { log(`Fehler im Sensor-Trigger: ${e.message}`, 'error'); }
    });

    /**
     * Trigger 2: Manueller Override
     */
    on({ id: [CONFIG.paths.summe, CONFIG.paths.zaehler], change: "ne", ack: false }, async (obj) => {
        if (isResetting) {
            log("Manueller Eingriff während des Resets ignoriert.", "warn");
            return;
        }

        let val = obj.state.val;
        if (typeof val !== 'number') return;
        if (val < 0) val = 0;

        if (obj.id === CONFIG.paths.summe) {
            stateCache.summe = val;
        } else {
            stateCache.zaehler = Math.floor(val);
        }
        
        log(`Manuelle Korrektur übernommen: ${obj.id.split('.').pop()} = ${val}`);
        await setStateAsync(obj.id, val, true);
    });

    /**
     * Zeitplan
     */
    schedule(`${CONFIG.resetTime.minute} ${CONFIG.resetTime.hour} * * *`, () => performDailyReset());

})();