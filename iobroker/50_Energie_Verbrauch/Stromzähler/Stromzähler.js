/**
 * Trockner Analyse & Überwachungssript PRO (Gekapselt)
 * - Vermeidung globaler Konflikte durch IIFE
 * - Vollständige Auto-State Creation für alle Analyse-Datenpunkte
 * - InfluxDB 2.x Kompatibilität über getHistory
 * - InfluxDB Auto-Logging & Persistente Datenspeicherung
 */

(async function() {
    // --- KONFIGURATION ---
    const ID_POWER = 'zigbee2mqtt.0.0xa4c138055df2ffff.load_power'; 
    const ID_ENERGY = 'zigbee2mqtt.0.0xa4c138055df2ffff.energy';     
    const INFLUX_INSTANZ = 'influxdb.0';                             
    const BASE_PATH = '0_userdata.0.Haushalt.Trockner';                      
    const STOP_DELAY = 120000;      // 2 Min. Standard-Verzögerung

    // Definition der Datenpunkte
    const DP = {
        startAnalyse:   BASE_PATH + '.Analyse.Starten',
        statusText:     BASE_PATH + '.Status',
        isRunning:      BASE_PATH + '.Laeuft',
        startThreshold: BASE_PATH + '.Analyse.Vorschlag_startingThreshold',
        endThreshold:   BASE_PATH + '.Analyse.Vorschlag_finishingThreshold',
        startPuffer:    BASE_PATH + '.Analyse.Vorschlag_startPuffer',
        startTime:      BASE_PATH + '.Aktueller_Startzeitpunkt',
        startEnergy:    BASE_PATH + '.Aktueller_Energie_Startwert',
        currConsum:     BASE_PATH + '.Aktueller_Verbrauch_kWh',
        lastRuntime:    BASE_PATH + '.Letzte_Laufzeit_Minuten',
        lastConsum:     BASE_PATH + '.Letzter_Verbrauch_kWh',
        cycleCount:     BASE_PATH + '.Zyklen_Gesamt',
        lastChange:     BASE_PATH + '.Letzte_Statusänderung',
        analyseStatus:  BASE_PATH + '.Analyse.Status'
    };

    let stopTimer = null;

    /**
     * 0. INITIALISIERUNG & AUTOMATISCHE ERSTELLUNG
     */
    async function init() {
        console.log("Trockner-Skript: Prüfe und erstelle Datenpunkte...");

        // Basis-Status
        await createStateAsync(DP.isRunning, false, {type: 'boolean', name: 'Trockner läuft', role: 'switch'});
        await createStateAsync(DP.statusText, 'IDLE', {type: 'string', name: 'Status', role: 'text'});
        await createStateAsync(DP.lastChange, 0, {type: 'number', name: 'Letzte Statusänderung', role: 'value.time'});
        
        // Analyse-Sektion
        await createStateAsync(DP.startAnalyse, false, {type: 'boolean', name: 'Analyse starten', role: 'button'});
        await createStateAsync(DP.analyseStatus, 'Bereit', {type: 'string', name: 'Analyse Status', role: 'text'});
        await createStateAsync(DP.startThreshold, 10, {type: 'number', name: 'Vorschlag Start-Schwellenwert', unit: 'W', role: 'value'});
        await createStateAsync(DP.endThreshold, 3, {type: 'number', name: 'Vorschlag Ende-Schwellenwert', unit: 'W', role: 'value'});
        await createStateAsync(DP.startPuffer, 1.5, {type: 'number', name: 'Dynamischer Start-Puffer', unit: 'W', role: 'value'});

        // Laufzeit-Daten
        await createStateAsync(DP.startTime, 0, {type: 'number', name: 'Startzeitpunkt aktueller Lauf', role: 'value.time'});
        await createStateAsync(DP.startEnergy, 0, {type: 'number', name: 'Energie Startwert', unit: 'kWh', role: 'value'});
        await createStateAsync(DP.currConsum, 0, {type: 'number', name: 'Aktueller Verbrauch', unit: 'kWh', role: 'value.power.consumption'});
        await createStateAsync(DP.lastRuntime, 0, {type: 'number', name: 'Letzte Laufzeit', unit: 'min', role: 'value'});
        await createStateAsync(DP.lastConsum, 0, {type: 'number', name: 'Letzter Stromverbrauch', unit: 'kWh', role: 'value.power.consumption'});
        await createStateAsync(DP.cycleCount, 0, {type: 'number', name: 'Zyklen Gesamt', role: 'value'});
        
        // InfluxDB Setup (Auto-Konfiguration)
        const loggingConfigs = [
            { id: ID_POWER, debounce: 1000, desc: "Leistung" },
            { id: DP.isRunning, debounce: 0, desc: "Status" },
            { id: DP.lastConsum, debounce: 0, desc: "Verbrauch Historie" }
        ];

        loggingConfigs.forEach(config => {
            sendTo(INFLUX_INSTANZ, 'enableHistory', {
                id: config.id,
                options: { enabled: true, changesOnly: true, debounce: config.debounce }
            });
        });
        
        console.log("Trockner-Skript: Alle Datenpunkte und Logging-Konfigurationen sind bereit.");
    }

    await init();

    /**
     * 1. ÜBERWACHUNG & LOGIK
     */
    on({id: ID_POWER, change: "ne"}, async function (obj) {
        const power = obj.state.val;
        const running = (await getStateAsync(DP.isRunning)).val;
        const startLimit = (await getStateAsync(DP.startThreshold)).val || 10;
        const endLimit = (await getStateAsync(DP.endThreshold)).val || 3;

        // --- START-ERKENNUNG ---
        if (power >= startLimit && !running) {
            if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; return; }

            const currentEnergy = (await getStateAsync(ID_ENERGY)).val;
            
            setState(DP.isRunning, true);
            setState(DP.statusText, "RUNNING");
            setState(DP.startTime, Date.now());
            setState(DP.startEnergy, currentEnergy);
            setState(DP.lastChange, Date.now());
            
            sendNotification("Der Trockner hat gestartet.");
        }

        // --- WÄHREND DES LAUFS ---
        if (running) {
            const startEnergy = (await getStateAsync(DP.startEnergy)).val;
            const currentEnergy = (await getStateAsync(ID_ENERGY)).val;
            const consumed = currentEnergy - startEnergy;
            setState(DP.currConsum, parseFloat(consumed.toFixed(3)));

            // Phasen-Informationen im Status
            if (power > 500) setState(DP.statusText, "HEIZEN");
            else if (power > 10) setState(DP.statusText, "DREHEN / KNITTERSCHUTZ");

            // --- STOP-LOGIK MIT ENT-PRELLUNG ---
            if (power < endLimit) {
                if (!stopTimer) {
                    stopTimer = setTimeout(async () => {
                        const startT = (await getStateAsync(DP.startTime)).val;
                        const durationMin = Math.round((Date.now() - startT - STOP_DELAY) / 1000 / 60);
                        
                        const finalEnergy = (await getStateAsync(ID_ENERGY)).val;
                        const totalConsumed = parseFloat((finalEnergy - startEnergy).toFixed(3));
                        const cycles = ((await getStateAsync(DP.cycleCount)).val || 0) + 1;

                        setState(DP.isRunning, false);
                        setState(DP.statusText, "IDLE");
                        setState(DP.lastRuntime, durationMin);
                        setState(DP.lastConsum, totalConsumed);
                        setState(DP.cycleCount, cycles);
                        setState(DP.lastChange, Date.now());
                        setState(DP.currConsum, 0);
                        
                        stopTimer = null;
                        sendNotification(`Trockner fertig! Dauer: ${durationMin} Min. Verbrauch: ${totalConsumed} kWh.`);
                    }, STOP_DELAY);
                }
            } else if (stopTimer) {
                clearTimeout(stopTimer);
                stopTimer = null;
            }
        }
    });

    /**
     * 2. ANALYSE (InfluxDB Abfrage via getHistory für 2.x Support)
     */
    on({id: DP.startAnalyse, val: true}, function () {
        const TAGE = 14;
        setState(DP.analyseStatus, `Analysiere ${TAGE} Tage (Influx 2.x)...`);

        const end = Date.now();
        const start = end - (TAGE * 24 * 60 * 60 * 1000);

        // Nutze getHistory statt sendTo('query') für bessere Kompatibilität
        getHistory(INFLUX_INSTANZ, {
            id: ID_POWER,
            start: start,
            end: end,
            aggregate: 'none', // Wir wollen die Rohdaten für die Analyse
            count: 5000       // Begrenzung auf die letzten 5000 Punkte zur Performance-Schonung
        }, (err, result) => {
            if (err) {
                console.error(`Trockner-Analyse: Fehler bei getHistory: ${err}`);
                setState(DP.analyseStatus, "Fehler: Siehe Log");
                return;
            }

            if (!result || result.length === 0) {
                console.warn(`Trockner-Analyse: Keine Daten für ${ID_POWER} gefunden.`);
                setState(DP.analyseStatus, "Keine Daten");
                return;
            }

            const vals = result.map(i => i.val).filter(v => v !== null && typeof v === 'number');
            if (vals.length === 0) {
                setState(DP.analyseStatus, "Keine numerischen Daten");
                return;
            }

            const maxP = Math.max(...vals);
            const sorted = vals.sort((a,b) => a-b);
            const standby = sorted[Math.floor(sorted.length * 0.1)] || 0;

            // Vorschläge berechnen
            setState(DP.startThreshold, Math.round(standby + (maxP * 0.04) + 5));
            setState(DP.endThreshold, Math.round(standby + 1.5));
            setState(DP.analyseStatus, "Analyse abgeschlossen");
            
            console.log(`Trockner-Analyse erfolgreich. Punkte: ${vals.length}, Max: ${maxP}W, Standby: ${standby}W.`);
            setTimeout(() => setState(DP.startAnalyse, false), 2000);
        });
    });

    /**
     * 3. HILFSFUNKTIONEN (Skript-intern)
     */
    function sendNotification(msg) {
        console.log("Trockner-Info: " + msg);
    }

})();