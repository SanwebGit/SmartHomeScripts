/**
 * ==============================================================================
 * SCRIPT: Heizperioden-Monitor für ioBroker
 * ==============================================================================
 * Autor:         Sanweb
 * Version:       6.1
 * Letzte Änderung: 2026-04-25
 * Zweck:         Automatisierte Bestimmung der Heizperiode basierend auf der 
 * Tagesmitteltemperatur und kalendarischen Zeiträumen.
 * Historie:
 * - 6.1: State-Machine entkoppelt (retryPending vs. RESETTING), persistenter
 *        lastValidSensorValue, Override über Queue (Race-Fix), errors24h
 *        eigener Mitternachts-Schedule, getFallbackTemperature mit Quelle,
 *        maxOverrideLimit hot-reloadable, isHeatingSeason-Guard für
 *        Ganzjahresbetrieb, Metrik umbenannt zu avgEventHandlingTimeMs.
 * - 6.0: Config Hot-Reloading, Performance-Metriken (Microseconds), 
 *        erweiterter Health-Monitor (Errors24h, Overflows), dynamischer EWMA.
 * - 5.9: Queue-Überlaufschutz, EWMA-Cache-Limitierung, konsistente Fallbacks
 * - 5.8: Sensor-Queue, Cache-Limitierung, Retry-Logik, Plausibilitätsprüfung
 * - 5.7: Write-Through-Cache, Fallback-Werte
 * ==============================================================================
 */

(async () => {
    // --------------- KONSTANTEN & TYPEN ---------------
    const MS_PER_MINUTE = 60000;
    
    // Präzise Zeitmessung (Fallback auf Date.now, falls performance.now in der Sandbox fehlt)
    const getNow = typeof performance !== 'undefined' ? performance.now.bind(performance) : Date.now;
    
    /** @enum {string} */
    const SCRIPT_STATE = {
        IDLE: 'IDLE',
        RESETTING: 'RESETTING',
        ERROR: 'ERROR'
    };

    // --------------- UTILS ---------------
    const logger = {
        _log: (level, msg, context) => {
            const contextStr = Object.keys(context).length > 0 ? ` | ${JSON.stringify(context)}` : '';
            log(`${msg}${contextStr}`, level);
        },
        info: (msg, context = {}) => logger._log('info', msg, context),
        warn: (msg, context = {}) => logger._log('warn', msg, context),
        error: (msg, context = {}) => logger._log('error', msg, context)
    };

    async function setStateWithRetry(path, value, ack, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await setStateAsync(path, value, ack);
                return;
            } catch (e) {
                if (i === maxRetries - 1) throw e;
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i))); 
            }
        }
    }

    // --------------- KONFIGURATION (Statisch) ---------------
    const CONFIG = {
        // ID des Außentemperatur-Sensors
        sensor: "hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE",
        // Uhrzeit für den täglichen Abschluss
        resetTime: { hour: 2, minute: 50 },
        // Wartezeit bei Fehlern (in Minuten)
        retryDelayMin: 15, 
        // Maximale Wiederholungsversuche
        maxRetries: 3,
        // Heizperiode: Start- und Endmonat (10=Okt, 5=Mai)
        months: { start: 10, end: 5 }, 
        // Plausibilitäts-Grenzen für Sensorwerte (°C)
        limits: { min: -40, max: 60 },  

        // ioBroker Zielpfade
        paths: {
            mittelwert: "0_userdata.0.Heizung.Allgemein.Tagesmittelwert",
            summe: "0_userdata.0.Heizung.Allgemein.ZwischenspeicherSumme",
            zaehler: "0_userdata.0.Heizung.Allgemein.MessungenZaehler",
            aktiv: "0_userdata.0.Heizung.Allgemein.HeizperiodeAktiv",
            letzterReset: "0_userdata.0.Heizung.Allgemein.LetzterReset",
            letzterResetTS: "0_userdata.0.Heizung.Allgemein.LetzterResetTimestamp",
            
            // Konfiguration per UI (Hot-Reload)
            config: {
                heizgrenze: "0_userdata.0.Heizung.Wartung.Heizgrenze",
                fallbackTemperature: "0_userdata.0.Heizung.Wartung.FallbackTemperatur",
                maxCacheSize: "0_userdata.0.Heizung.Wartung.MaxCacheSize",
                maxQueueSize: "0_userdata.0.Heizung.Wartung.MaxQueueSize",
                maxOverrideLimit: "0_userdata.0.Heizung.Wartung.MaxOverrideLimit"
            },
            
            // Erweitertes Health-Monitoring
            monitoring: {
                lastSensorUpdate: "0_userdata.0.Heizung.Monitoring.LastSensorUpdate",
                queueSize: "0_userdata.0.Heizung.Monitoring.QueueSize",
                state: "0_userdata.0.Heizung.Monitoring.ScriptState",
                queueOverflows: "0_userdata.0.Heizung.Monitoring.QueueOverflows",
                errors24h: "0_userdata.0.Heizung.Monitoring.Errors24h",
                avgProcessingTimeMs: "0_userdata.0.Heizung.Monitoring.AvgProcessingTimeMs",
                lastResetDurationMs: "0_userdata.0.Heizung.Monitoring.LastResetDurationMs"
            }
        }
    };

    // --------------- DYNAMISCHE KONFIGURATION (Hot-Reloadable) ---------------
    // Standardwerte, falls die ioBroker-Datenpunkte noch leer sind
    const DYNAMIC_CONFIG = {
        // Tagesmittel-Grenzwert für Heizbedarf in °C
        heizgrenze: 18.0,
        // Fester Fallback bei fehlenden historischen Daten
        fallbackTemperature: 10.0,
        // Cache-Limit (wandelt Summe in gleitenden Durchschnitt um)
        maxCacheSize: 10000,
        // Schützt vor Memory Leaks bei Sensor-Spam
        maxQueueSize: 1000,
        // Obergrenze für manuelle Cache-Korrekturen
        maxOverrideLimit: 10000
    };

    // --------------- INTERNER STATUS & METRIKEN ---------------
    /** @type {{summe: number, zaehler: number}} */
    let stateCache = { summe: 0, zaehler: 0 };
    let currentState = SCRIPT_STATE.IDLE;
    // Während retryPending=true wartet ein verzögerter Retry des Tagesabschlusses,
    // der Hauptzustand ist aber IDLE -> Sensor-Events werden weiter verarbeitet.
    let retryPending = false;
    let lastValidSensorValue = null; 
    
    // Queue
    let processingSensor = false;
    const sensorQueue = [];
    
    // Performance & Health Metrics
    let healthMonitorTimer = null;
    let metrics = {
        queueOverflows: 0,
        errors24h: 0,
        // Beinhaltet bewusst auch IO-Zeit (await setStateWithRetry); siehe avgEventHandlingTimeMs
        totalEventHandlingTimeMs: 0,
        processedEventsCount: 0,
        lastResetDurationMs: 0
    };

    // ==========================================================================
    // PERSISTENZ-HELFER
    // ==========================================================================

    /**
     * Setzt lastValidSensorValue im RAM und schreibt ihn in den Monitoring-Datenpunkt,
     * damit er über Skript-Neustarts hinweg verfügbar bleibt (Fallback bei Init).
     * Fehler beim Persistieren sind nicht kritisch (RAM-Wert bleibt aktuell).
     */
    async function setLastValidSensorValue(val) {
        lastValidSensorValue = val;
        try {
            await setStateWithRetry(CONFIG.paths.monitoring.lastSensorUpdate, val, true, 2);
        } catch (e) {
            // Bewusst nur warn (nicht trackError): Persistenz-Lücke ist kein Fehler im Sinne des Health-Monitors
            logger.warn("Konnte lastValidSensorValue nicht persistieren", { error: e.message });
        }
    }

    // ==========================================================================
    // PURE FUNCTIONS
    // ==========================================================================

    function isHeatingSeason(currentMonth, monthConfig) {
        // Guard: Bei start === end gilt Ganzjahresbetrieb (vermeidet Endlosschleife).
        if (monthConfig.start === monthConfig.end) return true;

        let activeMonths = [];
        let curr = monthConfig.start;
        while (curr !== monthConfig.end) {
            activeMonths.push(curr);
            curr = curr === 12 ? 1 : curr + 1;
        }
        activeMonths.push(monthConfig.end);
        return activeMonths.includes(currentMonth);
    }

    function calculateHeatingStatus(tagesMittel, monat, limitConfig) {
        const inSeason = isHeatingSeason(monat, CONFIG.months);
        const belowThreshold = (tagesMittel <= limitConfig.heizgrenze);
        return inSeason && belowThreshold;
    }

    // ==========================================================================
    // INFRASTRUKTUR & IOBROKER
    // ==========================================================================

    function validateConfig() {
        if (typeof CONFIG.sensor !== 'string' || CONFIG.sensor === "") {
            throw new Error("Kritisch: Sensor-ID ist ungültig oder leer.");
        }
    }

    async function initDataPoints() {
        // Allgemeine States
        const generalDefs = {
            [CONFIG.paths.mittelwert]: { name: "Tagesmittelwert", type: "number", role: "value.temperature", unit: "°C", def: 0 },
            [CONFIG.paths.summe]: { name: "Akkumulierte Temperaturwerte", type: "number", role: "value.temperature", unit: "°C", def: 0 },
            [CONFIG.paths.zaehler]: { name: "Anzahl der Messungen", type: "number", role: "value", unit: "", def: 0 },
            [CONFIG.paths.aktiv]: { name: "Status der Heizperiode", type: "boolean", role: "indicator.heating", def: false },
            [CONFIG.paths.letzterReset]: { name: "Datum letzter Reset", type: "string", role: "date", def: "nie" },
            [CONFIG.paths.letzterResetTS]: { name: "Timestamp letzter Reset", type: "number", role: "value.datetime", def: 0 }
        };

        // Hot-Reload Config States (mit Default-Werten aus DYNAMIC_CONFIG)
        const configDefs = {
            [CONFIG.paths.config.heizgrenze]: { name: "Config: Heizgrenze", type: "number", role: "value.temperature", unit: "°C", def: DYNAMIC_CONFIG.heizgrenze },
            [CONFIG.paths.config.fallbackTemperature]: { name: "Config: Fallback Temperatur", type: "number", role: "value.temperature", unit: "°C", def: DYNAMIC_CONFIG.fallbackTemperature },
            [CONFIG.paths.config.maxCacheSize]: { name: "Config: Max Cache Size (EWMA)", type: "number", role: "value", def: DYNAMIC_CONFIG.maxCacheSize },
            [CONFIG.paths.config.maxQueueSize]: { name: "Config: Max Queue Size", type: "number", role: "value", def: DYNAMIC_CONFIG.maxQueueSize },
            [CONFIG.paths.config.maxOverrideLimit]: { name: "Config: Max Override Limit", type: "number", role: "value", def: DYNAMIC_CONFIG.maxOverrideLimit }
        };

        // Monitoring States
        const monitoringDefs = {
            [CONFIG.paths.monitoring.lastSensorUpdate]: { name: "Letzter gültiger Sensorwert", type: "number", role: "value.temperature", unit: "°C", def: 0 },
            [CONFIG.paths.monitoring.queueSize]: { name: "Aktuelle Queue-Größe", type: "number", role: "value", def: 0 },
            [CONFIG.paths.monitoring.state]: { name: "Aktueller Skript-Status", type: "string", role: "state", def: SCRIPT_STATE.IDLE },
            [CONFIG.paths.monitoring.queueOverflows]: { name: "Anzahl Queue Overflows", type: "number", role: "value", def: 0 },
            [CONFIG.paths.monitoring.errors24h]: { name: "Fehler der letzten 24h", type: "number", role: "value", def: 0 },
            [CONFIG.paths.monitoring.avgProcessingTimeMs]: { name: "Ø Event-Handling-Zeit (ms, inkl. IO)", type: "number", role: "value.interval", unit: "ms", def: 0 },
            [CONFIG.paths.monitoring.lastResetDurationMs]: { name: "Dauer letzter Reset (ms)", type: "number", role: "value.interval", unit: "ms", def: 0 }
        };

        /** @type {Record<string, any>} */
        const allDefinitions = { ...generalDefs, ...configDefs, ...monitoringDefs };

        for (const [id, common] of Object.entries(allDefinitions)) {
            if (!(await existsStateAsync(id))) {
                await createStateAsync(id, common.def, { 
                    name: common.name, type: common.type, role: common.role, 
                    unit: common.unit || "", read: true, write: true 
                });
            }
        }
    }

    async function loadDynamicConfig() {
        for (const [key, path] of Object.entries(CONFIG.paths.config)) {
            const state = await getStateAsync(path);
            if (state && typeof state.val === 'number') {
                DYNAMIC_CONFIG[key] = state.val;
            }
        }
        logger.info("Dynamische Konfiguration geladen.", DYNAMIC_CONFIG);
    }

    function trackError(e, contextMsg) {
        metrics.errors24h++;
        logger.error(contextMsg, { error: e.message });
    }

    /**
     * Liefert eine Fallback-Temperatur und deren Herkunft.
     * @returns {Promise<{value: number, source: 'yesterday' | 'config'}>}
     */
    async function getFallbackTemperature() {
        try {
            const lastMittelState = await getStateAsync(CONFIG.paths.mittelwert);
            if (lastMittelState && typeof lastMittelState.val === 'number' &&
                lastMittelState.val >= CONFIG.limits.min &&
                lastMittelState.val <= CONFIG.limits.max) {
                return { value: lastMittelState.val, source: 'yesterday' };
            }
        } catch (e) {
            trackError(e, "Fehler beim Lesen des Vortageswerts");
        }

        logger.warn("Kein plausibler Vortageswert verfügbar, nutze Fix-Fallback", { fallback: DYNAMIC_CONFIG.fallbackTemperature });
        return { value: DYNAMIC_CONFIG.fallbackTemperature, source: 'config' };
    }

    async function updateHealthMonitor() {
        try {
            const avgProcTime = metrics.processedEventsCount > 0 
                ? (metrics.totalEventHandlingTimeMs / metrics.processedEventsCount) 
                : 0;

            await Promise.all([
                setStateWithRetry(CONFIG.paths.monitoring.queueSize, sensorQueue.length, true, 2),
                setStateWithRetry(CONFIG.paths.monitoring.state, currentState, true, 2),
                setStateWithRetry(CONFIG.paths.monitoring.lastSensorUpdate, lastValidSensorValue !== null ? lastValidSensorValue : 0, true, 2),
                setStateWithRetry(CONFIG.paths.monitoring.queueOverflows, metrics.queueOverflows, true, 2),
                setStateWithRetry(CONFIG.paths.monitoring.errors24h, metrics.errors24h, true, 2),
                setStateWithRetry(CONFIG.paths.monitoring.avgProcessingTimeMs, parseFloat(avgProcTime.toFixed(2)), true, 2),
                setStateWithRetry(CONFIG.paths.monitoring.lastResetDurationMs, parseFloat(metrics.lastResetDurationMs.toFixed(2)), true, 2)
            ]);
        } catch (e) {
            logger.error("Fehler beim Update der Health-Metriken", { error: e.message });
        } finally {
            healthMonitorTimer = setTimeout(updateHealthMonitor, 60000);
        }
    }

    async function performDailyReset(attempt = 1) {
        // Reentrancy-Schutz: Ein neuer Schedule-Trigger darf nicht starten, solange entweder
        // der eigentliche Reset läuft (RESETTING) oder ein verzögerter Retry pending ist.
        if (attempt === 1 && (currentState === SCRIPT_STATE.RESETTING || retryPending)) {
            logger.warn("Tagesabschluss läuft bereits oder Retry pending.", { currentState, retryPending });
            return;
        }

        const resetStartTime = getNow();
        currentState = SCRIPT_STATE.RESETTING;
        // Wir sind jetzt aktiv im Reset; falls dieser Aufruf der Retry war, ist das Pending vorbei.
        retryPending = false;

        try {
            logger.info("Starte Tagesabschluss", { attempt, maxRetries: CONFIG.maxRetries });
            let tagesMittel = 0;
            let fallbackSource = null; // 'yesterday' | 'config' | null (kein Fallback)

            // 1. Vorberechnung prüfen
            if (stateCache.zaehler === 0) {
                logger.warn("Keine Messwerte für heute! Nutze Fallback-Logik.");
                const fb = await getFallbackTemperature();
                tagesMittel = fb.value;
                fallbackSource = fb.source;
            } else {
                tagesMittel = stateCache.summe / stateCache.zaehler;

                // 2. Nach Berechnung auf Plausibilität prüfen
                if (tagesMittel < CONFIG.limits.min || tagesMittel > CONFIG.limits.max) {
                    logger.warn("Berechneter Mittelwert unplausibel! Nutze Fallback-Logik.", { unplausiblerWert: tagesMittel });
                    const fb = await getFallbackTemperature();
                    tagesMittel = fb.value;
                    fallbackSource = fb.source;
                }
            }

            const jetzt = new Date();
            const aktuellerMonat = jetzt.getMonth() + 1;
            
            // Business Logik (nutzt DYNAMIC_CONFIG)
            const aktiv = calculateHeatingStatus(tagesMittel, aktuellerMonat, DYNAMIC_CONFIG);

            // States schreiben
            await Promise.all([
                setStateWithRetry(CONFIG.paths.mittelwert, parseFloat(tagesMittel.toFixed(2)), true),
                setStateWithRetry(CONFIG.paths.aktiv, aktiv, true),
                setStateWithRetry(CONFIG.paths.letzterReset, jetzt.toLocaleDateString('de-DE'), true),
                setStateWithRetry(CONFIG.paths.letzterResetTS, jetzt.getTime(), true)
            ]);

            // Cache Reset
            stateCache.summe = 0;
            stateCache.zaehler = 0;
            await Promise.all([
                setStateWithRetry(CONFIG.paths.summe, 0, true),
                setStateWithRetry(CONFIG.paths.zaehler, 0, true)
            ]);

            // Performance-Metriken aktualisieren.
            // Hinweis: errors24h wird NICHT hier zurückgesetzt – das macht ein eigener
            // Mitternachts-Schedule, damit "Fehler der letzten 24h" semantisch sauber bleibt.
            metrics.lastResetDurationMs = getNow() - resetStartTime;

            // Verarbeitungszeit-Metriken sanft glätten (EWMA-ähnlich) statt hart zurücksetzen.
            metrics.totalEventHandlingTimeMs = metrics.processedEventsCount > 0 ? (metrics.totalEventHandlingTimeMs / metrics.processedEventsCount) : 0;
            metrics.processedEventsCount = metrics.processedEventsCount > 0 ? 1 : 0;

            logger.info("Tagesabschluss erfolgreich.", {
                tagesMittel: parseFloat(tagesMittel.toFixed(2)),
                aktiv,
                fallbackSource,
                durationMs: parseFloat(metrics.lastResetDurationMs.toFixed(2))
            });
            currentState = SCRIPT_STATE.IDLE;
        } catch (e) {
            trackError(e, "Fehler beim Tagesabschluss");
            if (attempt <= CONFIG.maxRetries) {
                // Wichtig: Während der Retry-Wartezeit gehört das System wieder dem
                // Sensor-Loop. Status zurück auf IDLE, retryPending markiert den Pending-Retry.
                currentState = SCRIPT_STATE.IDLE;
                retryPending = true;
                logger.warn("Tagesabschluss-Retry geplant; verarbeite Sensor-Events während Wartezeit weiter.", {
                    attempt,
                    nextAttempt: attempt + 1,
                    delayMin: CONFIG.retryDelayMin
                });
                setTimeout(() => performDailyReset(attempt + 1), CONFIG.retryDelayMin * MS_PER_MINUTE);
            } else {
                logger.error("Maximale Retries erreicht. Tagesabschluss abgebrochen.");
                retryPending = false;
                currentState = SCRIPT_STATE.ERROR;
            }
        }
    }

    // ==========================================================================
    // EVENT QUEUE VERARBEITUNG
    // ==========================================================================
    // Die Queue verarbeitet getaggte Events ({type, payload}). Sowohl Sensor-Werte
    // als auch manuelle Overrides laufen durch dieselbe Queue, dadurch kann es
    // niemals einen parallelen Schreibzugriff auf stateCache geben (Race-Fix P1 #3).

    async function processSingleSensor(obj) {
        const procStartTime = getNow();
        let val = obj.state.val;

        // Validierung & Fallback
        if (typeof val !== 'number' || val < CONFIG.limits.min || val > CONFIG.limits.max) {
            if (lastValidSensorValue !== null) {
                logger.warn("Ungültiger Sensorwert. Nutze Fallback.", { rawValue: val, fallbackValue: lastValidSensorValue });
                val = lastValidSensorValue;
            } else {
                logger.error("Ungültiger Sensorwert und kein Fallback verfügbar. Event ignoriert.", { rawValue: val });
                return;
            }
        } else {
            // Persistiert lastValidSensorValue auch in den Monitoring-Datenpunkt
            await setLastValidSensorValue(val);
        }

        stateCache.summe += val;
        stateCache.zaehler++;

        // EWMA-Cache-Begrenzung (Nutzt DYNAMIC_CONFIG)
        if (stateCache.zaehler > DYNAMIC_CONFIG.maxCacheSize) {
            const currentAvg = stateCache.summe / stateCache.zaehler;
            stateCache.summe = currentAvg;
            stateCache.zaehler = 1;
            logger.info("Cache auf gleitenden Durchschnitt zurückgesetzt", { newAvg: parseFloat(currentAvg.toFixed(2)) });
        }

        await Promise.all([
            setStateWithRetry(CONFIG.paths.summe, stateCache.summe, true),
            setStateWithRetry(CONFIG.paths.zaehler, stateCache.zaehler, true)
        ]);

        // Performance Tracking
        metrics.totalEventHandlingTimeMs += (getNow() - procStartTime);
        metrics.processedEventsCount++;
    }

    /**
     * Verarbeitet einen manuellen Override (Schreiben auf summe oder zaehler durch User).
     * Läuft seriell mit Sensor-Events durch dieselbe Queue – kein paralleler Cache-Zugriff.
     * @param {{datapointId: string, rawValue: any}} payload
     */
    async function processSingleOverride(payload) {
        const procStartTime = getNow();
        let val = payload.rawValue;

        // Validierung
        if (typeof val !== 'number' || isNaN(val)) {
            logger.warn("Override ignoriert: Wert ist keine gültige Zahl", { rawValue: payload.rawValue });
            return;
        }
        if (val < 0) val = 0;

        if (val > DYNAMIC_CONFIG.maxOverrideLimit) {
            logger.warn("Manueller Wert überschreitet Limit. Kappe auf Limit.", {
                rawValue: val, limit: DYNAMIC_CONFIG.maxOverrideLimit
            });
            val = DYNAMIC_CONFIG.maxOverrideLimit;
        }

        if (payload.datapointId === CONFIG.paths.summe) {
            stateCache.summe = val;
        } else if (payload.datapointId === CONFIG.paths.zaehler) {
            stateCache.zaehler = Math.floor(val);
            val = stateCache.zaehler;
        } else {
            logger.warn("Override mit unbekanntem Datenpunkt verworfen.", { datapointId: payload.datapointId });
            return;
        }

        logger.info("Manuelle Korrektur übernommen", {
            datapoint: payload.datapointId.split('.').pop(),
            newValue: val
        });
        await setStateWithRetry(payload.datapointId, val, true);

        // Performance Tracking (Override durchläuft denselben Pfad wie Sensor-Events)
        metrics.totalEventHandlingTimeMs += (getNow() - procStartTime);
        metrics.processedEventsCount++;
    }

    async function processSensorQueue() {
        if (processingSensor) return;
        processingSensor = true;

        try {
            while (sensorQueue.length > 0) {
                const event = sensorQueue.shift();
                try {
                    if (event.type === 'sensor') {
                        await processSingleSensor(event.payload);
                    } else if (event.type === 'override') {
                        await processSingleOverride(event.payload);
                    } else {
                        logger.warn("Unbekannter Event-Typ in Queue, ignoriert.", { type: event.type });
                    }
                } catch (e) {
                    trackError(e, `Fehler bei ${event.type}-Event, fahre mit nächstem fort`);
                }
            }
        } finally {
            processingSensor = false;
            if (sensorQueue.length > 0) {
                processSensorQueue();
            }
        }
    }

    // ==========================================================================
    // INITIALISIERUNG & TRIGGER
    // ==========================================================================

    try {
        validateConfig();
        await initDataPoints();
        await loadDynamicConfig();
        
        const [summeState, zaehlerState, mittelState, lastSensorState] = await Promise.all([
            getStateAsync(CONFIG.paths.summe),
            getStateAsync(CONFIG.paths.zaehler),
            getStateAsync(CONFIG.paths.mittelwert),
            getStateAsync(CONFIG.paths.monitoring.lastSensorUpdate)
        ]);

        stateCache.summe = (summeState && typeof summeState.val === 'number') ? summeState.val : 0;
        stateCache.zaehler = (zaehlerState && typeof zaehlerState.val === 'number') ? zaehlerState.val : 0;

        // Persistierten letzten gültigen Sensorwert wiederherstellen, sofern plausibel.
        // Der Default-Wert 0 (aus initDataPoints) wird bewusst NICHT als Fallback akzeptiert,
        // sonst würde ein Erst-Start als "0 °C als plausibler Vortageswert" interpretiert.
        if (lastSensorState && typeof lastSensorState.val === 'number' &&
            lastSensorState.val >= CONFIG.limits.min &&
            lastSensorState.val <= CONFIG.limits.max &&
            lastSensorState.val !== 0) {
            lastValidSensorValue = lastSensorState.val;
        }

        const initMittel = (mittelState && typeof mittelState.val === 'number') ? mittelState.val : 0;
        const initialStatus = calculateHeatingStatus(initMittel, new Date().getMonth() + 1, DYNAMIC_CONFIG);
        await setStateWithRetry(CONFIG.paths.aktiv, initialStatus, true);

        logger.info("Skript v6.1 gestartet.", {
            initialStatus,
            cacheSumme: parseFloat(stateCache.summe.toFixed(2)),
            cacheZaehler: stateCache.zaehler,
            lastValidSensorValue
        });
        
        updateHealthMonitor();

    } catch (error) {
        logger.error("Initialisierungsfehler", { error: error.message });
        currentState = SCRIPT_STATE.ERROR;
        return; 
    }

    /**
     * Trigger 1: Sensor (mit Queue Overflow Protection)
     * Während retryPending=true ist der Hauptzustand IDLE und Events werden
     * weiter angenommen – das ist genau der Sinn der entkoppelten State-Machine (P0 #1).
     */
    on({ id: CONFIG.sensor, change: "any" }, (obj) => {
        if (currentState !== SCRIPT_STATE.IDLE) return;

        if (sensorQueue.length >= DYNAMIC_CONFIG.maxQueueSize) {
            metrics.queueOverflows++;
            logger.warn("Sensor-Queue überläuft - verwerfe ältestes Event", { queueSize: sensorQueue.length, overflows: metrics.queueOverflows });
            sensorQueue.shift();
        }

        sensorQueue.push({ type: 'sensor', payload: obj });
        processSensorQueue();
    });

    /**
     * Trigger 2: Config Hot-Reloading
     */
    const configPathValues = Object.values(CONFIG.paths.config);
    on({ id: configPathValues, change: "ne", ack: false }, async (obj) => {
        const configKey = Object.keys(CONFIG.paths.config).find(key => CONFIG.paths.config[key] === obj.id);
        
        if (configKey && typeof obj.state.val === 'number') {
            DYNAMIC_CONFIG[configKey] = obj.state.val;
            logger.info(`Hot-Reload: Konfiguration aktualisiert`, { key: configKey, newValue: obj.state.val });
            
            // Bestätigen (Ack=true)
            await setStateAsync(obj.id, obj.state.val, true);
            
            // Heizstatus sofort mit neuen Parametern re-evaluieren
            if (configKey === 'heizgrenze') {
                const mittelState = await getStateAsync(CONFIG.paths.mittelwert);
                const currentMittel = (mittelState && typeof mittelState.val === 'number') ? mittelState.val : 0;
                const newStatus = calculateHeatingStatus(currentMittel, new Date().getMonth() + 1, DYNAMIC_CONFIG);
                await setStateWithRetry(CONFIG.paths.aktiv, newStatus, true);
                logger.info("Heizstatus aufgrund geänderter Heizgrenze neu berechnet.", { neuerStatus: newStatus });
            }
        }
    });

    /**
     * Trigger 3: Manueller Override
     * WICHTIG: Schreibt NICHT direkt in stateCache, sondern reiht den Override
     * als getaggtes Event in die Queue ein. Damit ist garantiert, dass kein
     * paralleler Schreibzugriff zwischen processSingleSensor und Override
     * stattfindet (Race-Fix P1 #3).
     */
    on({ id: [CONFIG.paths.summe, CONFIG.paths.zaehler], change: "ne", ack: false }, (obj) => {
        if (currentState !== SCRIPT_STATE.IDLE) {
            logger.warn("Manueller Eingriff ignoriert (System blockiert/resetting).", { currentState });
            return;
        }

        // Overflow-Schutz auch hier: Override soll Sensor-Events nicht verdrängen können,
        // daher gleicher Mechanismus.
        if (sensorQueue.length >= DYNAMIC_CONFIG.maxQueueSize) {
            metrics.queueOverflows++;
            logger.warn("Queue überläuft beim Override - verwerfe ältestes Event", {
                queueSize: sensorQueue.length, overflows: metrics.queueOverflows
            });
            sensorQueue.shift();
        }

        sensorQueue.push({
            type: 'override',
            payload: { datapointId: obj.id, rawValue: obj.state.val }
        });
        processSensorQueue();
    });

    /**
     * Zeitplan: Täglicher Abschluss
     */
    schedule(`${CONFIG.resetTime.minute} ${CONFIG.resetTime.hour} * * *`, () => performDailyReset());

    /**
     * Zeitplan: 24h-Fehler-Counter um Mitternacht zurücksetzen.
     * Bewusst entkoppelt vom Tagesabschluss um 02:50, damit "errors24h" semantisch
     * tatsächlich die Fehler des laufenden Kalendertages widerspiegelt (Issue #6).
     */
    schedule('0 0 * * *', () => {
        const previous = metrics.errors24h;
        metrics.errors24h = 0;
        logger.info("errors24h-Counter um Mitternacht zurückgesetzt.", { previous });
    });

    // Clean-up bei Skript-Stop
    onStop(async (cb) => {
        logger.info("Skript wird gestoppt. Führe Clean-up durch.");
        if (healthMonitorTimer) clearTimeout(healthMonitorTimer);
        if (typeof cb === 'function') cb();
    });

})();