/**
 * Haushaltsgeräte-Überwachung PRO (v4.1.0 - Next Level)
 * - Prädiktive Zeitvorhersage (InfluxDB Durchschnitt)
 * - Intelligentes Benachrichtigungs-Management (Quiet Hours & Reminder)
 * - Anomalie-Erkennung (Sicherheits-Abschaltung/Alarm)
 * - Auto-State Creation & InfluxDB 2.x Support
 */

(async function() {
    // --- 1. GLOBALE EINSTELLUNGEN ---
    const BASE_DATA_POINT_PATH = '0_userdata.0.Haushalt';
    const INFLUXDB_INSTANCE = 'influxdb.0';
    const ANALYSIS_PERIOD_DAYS = 30;
    const ANALYSIS_SCHEDULE = '0 3 * * 3'; 
    
    // --- NEXT LEVEL KONFIGURATION ---
    const QUIET_HOURS = { start: '22:00', end: '07:00' }; // Keine lauten Benachrichtigungen
    const REMINDER_INTERVAL_MIN = 30;                     // Erinnerung wenn nicht geleert
    const SAFETY_TIMEOUT_MIN = 300;                       // Alarm wenn Gerät > 5h läuft

    // --- 2. GERÄTE-KONFIGURATION ---
    const APPLIANCES_CONFIG = [
        {
            deviceName: 'Trockner',
            powerSensorId: 'zigbee2mqtt.0.0xa4c138055df2ffff.load_power',
            energySensorId: 'zigbee2mqtt.0.0xa4c138055df2ffff.energy',
            startingThreshold: 10.0,
            finishingThreshold: 5.0,
            startingHysteresisMin: 2,
            finishingHysteresisMin: 5,
            pauseHysteresisMin: 15,
        },
        {
            deviceName: 'Waschmaschine',
            powerSensorId: 'zigbee2mqtt.0.0xa4c13805390dffff.load_power',
            energySensorId: 'zigbee2mqtt.0.0xa4c13805390dffff.energy',
            startingThreshold: 10.0,
            finishingThreshold: 5.0,
            startingHysteresisMin: 2,
            finishingHysteresisMin: 5,
            pauseHysteresisMin: 15,
        },
        {
            deviceName: 'Spülmaschine',
            powerSensorId: 'zigbee2mqtt.0.0xa4c1380557daffff.load_power',
            energySensorId: 'zigbee2mqtt.0.0xa4c1380557daffff.energy',
            startingThreshold: 10.0,
            finishingThreshold: 5.0,
            startingHysteresisMin: 2,
            finishingHysteresisMin: 5,
            pauseHysteresisMin: 15,
        }
    ];

    // --- 3. AKTIONEN (Smart Notifications) ---
    function isQuietTime() {
        const now = new Date();
        const currentTime = now.getHours() * 60 + now.getMinutes();
        const [sH, sM] = QUIET_HOURS.start.split(':').map(Number);
        const [eH, eM] = QUIET_HOURS.end.split(':').map(Number);
        const startTime = sH * 60 + sM;
        const endTime = eH * 60 + eM;
        return startTime > endTime ? (currentTime >= startTime || currentTime <= endTime) : (currentTime >= startTime && currentTime <= endTime);
    }

    function sendSmartNotification(title, message, priority = 1) {
        log(`[${title}] ${message}`);
        if (isQuietTime() && priority < 2) {
            log("Nachtruhe aktiv: Benachrichtigung nur im Log.");
            return;
        }
        // Beispiel für Telegram Integration:
        // sendTo('telegram.0', { text: `*${title}*\n${message}`, parse_mode: 'Markdown' });
    }

    // --- 4. SKRIPT-LOGIK ---
    const STATES = { IDLE: 'IDLE', STARTING: 'STARTING', RUNNING: 'RUNNING', FINISHING: 'FINISHING', PAUSED: 'PAUSED' };

    async function setupApplianceMonitor(config) {
        const SCRIPT_DP_PATH = `${BASE_DATA_POINT_PATH}.${config.deviceName}`;
        const DP = {
            STATUS: `${SCRIPT_DP_PATH}.Status`,
            LAEUFT: `${SCRIPT_DP_PATH}.Laeuft`,
            STATUS_TIMESTAMP: `${SCRIPT_DP_PATH}.Letzte_Statusänderung`,
            LAST_RUN_DURATION: `${SCRIPT_DP_PATH}.Letzte_Laufzeit_Minuten`,
            LAST_RUN_ENERGY: `${SCRIPT_DP_PATH}.Letzter_Verbrauch_kWh`,
            CURRENT_ENERGY: `${SCRIPT_DP_PATH}.Aktueller_Verbrauch_kWh`,
            RUN_START_TIME: `${SCRIPT_DP_PATH}.Aktueller_Startzeitpunkt`,
            RUN_START_ENERGY: `${SCRIPT_DP_PATH}.Aktueller_Energie_Startwert`,
            // Next Level DPs
            PREDICTED_END: `${SCRIPT_DP_PATH}.Voraussichtliches_Ende`,
            REMAINING_TIME: `${SCRIPT_DP_PATH}.Restlaufzeit_Minuten`,
            ANOMALY_ALARM: `${SCRIPT_DP_PATH}.Anomalie_Alarm`,
            // Analyse
            ANALYSE_START: `${SCRIPT_DP_PATH}.Analyse.Starten`,
            ANALYSE_STATUS: `${SCRIPT_DP_PATH}.Analyse.Status`,
            VORSCHLAG_START: `${SCRIPT_DP_PATH}.Analyse.Vorschlag_startingThreshold`,
            VORSCHLAG_FINISH: `${SCRIPT_DP_PATH}.Analyse.Vorschlag_finishingThreshold`,
        };

        let startTimeout = null, finishTimeout = null, pauseTimeout = null, safetyTimer = null, reminderTimer = null, predictionInterval = null;
        let runtimeConfig = { ...config };

        await (async function createDPs() {
            await createStateAsync(DP.STATUS, STATES.IDLE, { type: 'string', role: 'text' });
            await createStateAsync(DP.LAEUFT, false, { type: 'boolean', role: 'switch' });
            await createStateAsync(DP.STATUS_TIMESTAMP, 0, { type: 'number', role: 'value.time' });
            await createStateAsync(DP.LAST_RUN_DURATION, 0, { type: 'number', unit: 'min' });
            await createStateAsync(DP.LAST_RUN_ENERGY, 0, { type: 'number', unit: 'kWh' });
            await createStateAsync(DP.CURRENT_ENERGY, 0, { type: 'number', unit: 'kWh' });
            await createStateAsync(DP.RUN_START_TIME, 0, { type: 'number', role: 'value.time' });
            await createStateAsync(DP.RUN_START_ENERGY, 0, { type: 'number', unit: 'kWh' });
            await createStateAsync(DP.PREDICTED_END, '', { type: 'string', name: 'Voraussichtliche Endzeit' });
            await createStateAsync(DP.REMAINING_TIME, 0, { type: 'number', unit: 'min' });
            await createStateAsync(DP.ANOMALY_ALARM, false, { type: 'boolean', role: 'indicator.alarm' });
            await createStateAsync(DP.ANALYSE_START, false, { type: 'boolean', role: 'button' });
            await createStateAsync(DP.ANALYSE_STATUS, 'Bereit', { type: 'string' });
            await createStateAsync(DP.VORSCHLAG_START, 0, { type: 'number', unit: 'W' });
            await createStateAsync(DP.VORSCHLAG_FINISH, 0, { type: 'number', unit: 'W' });
        })();

        // Durchschnittliche Laufzeit aus InfluxDB ermitteln
        async function getAverageDuration() {
            return new Promise((resolve) => {
                const end = Date.now();
                const start = end - (30 * 24 * 60 * 60 * 1000);
                getHistory(INFLUXDB_INSTANCE, { id: DP.LAST_RUN_DURATION, start: start, end: end, aggregate: 'none' }, (err, result) => {
                    if (err || !result || result.length === 0) resolve(120); // Fallback 2h
                    const avg = result.reduce((a, b) => a + b.val, 0) / result.length;
                    resolve(Math.round(avg));
                });
            });
        }

        function updatePrediction(avgDuration) {
            const startTime = getState(DP.RUN_START_TIME).val;
            const elapsed = (Date.now() - startTime) / 60000;
            const remaining = Math.max(0, Math.round(avgDuration - elapsed));
            const end = new Date(Date.now() + remaining * 60000);
            
            setState(DP.REMAINING_TIME, remaining, true);
            setState(DP.PREDICTED_END, end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), true);
        }

        async function setApplianceState(newState) {
            const currentState = getState(DP.STATUS).val;
            if (currentState === newState) return;

            log(`${config.deviceName}: ${currentState} -> ${newState}`);
            setState(DP.STATUS, newState, true);
            setState(DP.STATUS_TIMESTAMP, Date.now(), true);
            setState(DP.LAEUFT, (newState !== STATES.IDLE), true);

            if (newState === STATES.RUNNING && currentState === STATES.STARTING) {
                const energyNow = getState(config.energySensorId).val || 0;
                setState(DP.RUN_START_TIME, Date.now(), true);
                setState(DP.RUN_START_ENERGY, energyNow, true);
                setState(DP.ANOMALY_ALARM, false, true);
                
                // Vorhersage starten
                const avg = await getAverageDuration();
                updatePrediction(avg);
                predictionInterval = setInterval(() => updatePrediction(avg), 60000);

                // Sicherheits-Timer
                safetyTimer = setTimeout(() => {
                    setState(DP.ANOMALY_ALARM, true, true);
                    sendSmartNotification("ALARM", `${config.deviceName} läuft ungewöhnlich lange (> ${SAFETY_TIMEOUT_MIN} Min)! Bitte prüfen.`, 2);
                }, SAFETY_TIMEOUT_MIN * 60000);

                sendSmartNotification(config.deviceName, "gestartet.");
            }

            if (currentState === STATES.PAUSED && newState === STATES.IDLE) {
                clearInterval(predictionInterval);
                clearTimeout(safetyTimer);
                
                const startTime = getState(DP.RUN_START_TIME).val;
                const startEnergy = getState(DP.RUN_START_ENERGY).val;
                const energyNow = getState(config.energySensorId).val || 0;
                const durationMin = (Date.now() - startTime) / 60000;
                const energyKWh = energyNow - startEnergy;

                setState(DP.LAST_RUN_DURATION, parseFloat(durationMin.toFixed(1)), true);
                setState(DP.LAST_RUN_ENERGY, parseFloat(energyKWh.toFixed(3)), true);
                setState(DP.REMAINING_TIME, 0, true);
                setState(DP.PREDICTED_END, '--:--', true);

                sendSmartNotification(config.deviceName, `${config.deviceName} ist fertig! Dauer: ${durationMin.toFixed(0)} Min, Verbrauch: ${energyKWh.toFixed(2)} kWh.`, 1);
                
                // Reminder-Timer starten
                reminderTimer = setInterval(() => {
                    sendSmartNotification(config.deviceName, "Erinnerung: Die Wäsche liegt noch im Gerät.", 1);
                }, REMINDER_INTERVAL_MIN * 60000);
            }
        }

        on({id: config.powerSensorId, change: "ne"}, (obj) => {
            const power = obj.state.val;
            const state = getState(DP.STATUS).val;

            // Aktuellen Verbrauch während des Laufs berechnen
            if (state !== STATES.IDLE && state !== STATES.STARTING) {
                const startE = getState(DP.RUN_START_ENERGY).val;
                const currE = getState(config.energySensorId).val || 0;
                setState(DP.CURRENT_ENERGY, parseFloat((currE - startE).toFixed(3)), true);
            }
            
            // Türöffnung / Entleerung erkennen (Power > 0.5W aber Status IDLE -> Reminder stoppen)
            if (power > 0.5 && state === STATES.IDLE && reminderTimer) {
                clearInterval(reminderTimer);
                reminderTimer = null;
                log(`${config.deviceName}: Gerät wurde geöffnet/entleert. Reminder gestoppt.`);
            }

            switch (state) {
                case STATES.IDLE: if (power > runtimeConfig.startingThreshold) setApplianceState(STATES.STARTING); break;
                case STATES.STARTING: if (power <= runtimeConfig.startingThreshold) { clearTimeout(startTimeout); setApplianceState(STATES.IDLE); } break;
                case STATES.RUNNING: if (power < runtimeConfig.finishingThreshold) setApplianceState(STATES.FINISHING); break;
                case STATES.FINISHING: if (power >= runtimeConfig.finishingThreshold) { clearTimeout(finishTimeout); setApplianceState(STATES.RUNNING); } break;
                case STATES.PAUSED: if (power >= runtimeConfig.finishingThreshold) { clearTimeout(pauseTimeout); setApplianceState(STATES.RUNNING); } break;
            }
        });

        on({id: DP.STATUS, change: "ne"}, (obj) => {
            const ns = obj.state.val;
            clearTimeout(startTimeout); clearTimeout(finishTimeout); clearTimeout(pauseTimeout);
            if (ns === STATES.STARTING) startTimeout = setTimeout(() => setApplianceState(STATES.RUNNING), runtimeConfig.startingHysteresisMin * 60000);
            if (ns === STATES.FINISHING) finishTimeout = setTimeout(() => setApplianceState(STATES.PAUSED), runtimeConfig.finishingHysteresisMin * 60000);
            if (ns === STATES.PAUSED) pauseTimeout = setTimeout(() => setApplianceState(STATES.IDLE), runtimeConfig.pauseHysteresisMin * 60000);
        });

        // Analyse bleibt wie im Original-Script (Histogramm-Methode)
        on({id: DP.ANALYSE_START, val: true}, () => {
            log(`Analyse für ${config.deviceName} gestartet...`);
            const end = Date.now();
            const start = end - (ANALYSIS_PERIOD_DAYS * 24 * 60 * 60 * 1000);
            getHistory(INFLUXDB_INSTANCE, { id: config.powerSensorId, start: start, end: end, aggregate: 'none' }, (err, result) => {
                if (err || !result || result.length === 0) { setState(DP.ANALYSE_STATUS, 'Fehler', true); return; }
                const lowPower = result.filter(i => i.val > 0.5 && i.val < 15);
                const histogram = {};
                lowPower.forEach(i => { const v = Math.round(i.val * 10) / 10; histogram[v] = (histogram[v] || 0) + 1; });
                let mostFreq = 0, maxC = 0;
                for (const v in histogram) { if (histogram[v] > maxC) { maxC = histogram[v]; mostFreq = parseFloat(v); } }
                setState(DP.VORSCHLAG_FINISH, parseFloat(mostFreq.toFixed(2)), true);
                setState(DP.VORSCHLAG_START, parseFloat((mostFreq + 5).toFixed(2)), true); 
                setState(DP.ANALYSE_STATUS, 'Fertig', true);
                setTimeout(() => setState(DP.ANALYSE_START, false), 2000);
            });
        });
    }

    for (const conf of APPLIANCES_CONFIG) { await setupApplianceMonitor(conf); }
    if (ANALYSIS_SCHEDULE) { schedule(ANALYSIS_SCHEDULE, () => { APPLIANCES_CONFIG.forEach(c => setState(`${BASE_DATA_POINT_PATH}.${c.deviceName}.Analyse.Starten`, true)); }); }
})();

