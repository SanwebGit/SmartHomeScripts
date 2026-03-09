/*
 * iobroker-skript: Wetterdaten-JSON-Parser
 *
 * Author: Sanweb
 * Version: 5.2 (State Cache Edition)
 * Datum: 09.03.2026
 *
 * Beschreibung:
 * Dieses Skript überwacht einen MQTT-Datenpunkt einer Wetterstation (ecowitt2mqtt), der Wetterdaten von dieser als JSON empfängt.
 * Es parst den JSON-String und erstellt bzw. aktualisiert separate Datenpunkte.
 * * Features v5.2 (State Cache Edition):
 * - Cache-Persistenz nativ über ioBroker-Datenpunkt (ohne lokales Dateisystem)
 * - Dynamische Thresholds (Auto-Tuning basierend auf RAM)
 * - Alerting-Integration (Telegram, Pushover)
 * - Historische Datenanalyse (24h Trend-Tracking im RAM)
 * - Konfigurations-Hot-Reload (_reload Button)
 */

(function() {
    "use strict";

    // --- KONFIGURATION ---
    const CONFIG = {
        sourceDpId: 'mqtt.0.wetter.gw1100',
        targetPath: '0_userdata.0.Wetter',
        roundingDecimals: 2,
        debounceTime: 1000,          
        maxRetries: 3,               
        retryDelayBase: 1000,        
        logLevel: 'info',            // 'info', 'debug', 'warn', 'error'
        cleanupObsoleteAfter: 3600000, 
        cleanupInterval: 300000,     
        validateData: true,          
        createMissingStates: true,   
        maxCacheSize: 200,           // Startwert, wird adaptiv/auto-tuned angepasst
        maxErrors: 10,               
        enableHealthStats: true,     // Aktiviert _health, _stats, _help und _reload
        cacheDpId: '0_userdata.0.Wetter.wetter-cache', // Datenpunkt für Persistenz
        alerts: {
            telegram: false,         // Auf true setzen, falls Telegram-Adapter installiert ist
            pushover: false          // Auf true setzen, falls Pushover-Adapter installiert ist
        }
    };

    const VALIDATION_RULES = {
        temp: { min: -50, max: 60 },
        humidity: { min: 0, max: 100 },
        baromrel: { min: 800, max: 1200 },
        baromabs: { min: 800, max: 1200 },
        uv: { min: 0, max: 20 },
        windspeed: { min: 0, max: 250 },
        windgust: { min: 0, max: 250 }
    };

    const ERROR_TYPES = {
        PARSE: 'parse',
        VALIDATION: 'validation',
        SYSTEM: 'system' 
    };

    const PERFORMANCE_THRESHOLDS = {
        processTime: 2000,       // Startwert, wird via autoTuneThresholds angepasst
        bulkOperations: 50       
    };
    // --------------------

    // --- GLOBALE VARIABLEN ---
    const stateCache = new Map();
    const historyCache = new Map(); // key -> array von {value, timestamp}
    let isProcessing = false;
    let lastCleanup = 0;
    let criticalErrorCount = 0;
    let circuitBreakerAlertSent = false;
    
    // Monitoring Metriken
    const stats = {
        updates: 0,
        parseErrors: 0,
        systemErrors: 0,
        lastUpdate: null,
        avgProcessTime: 0,
        uptime: 0
    };

    // Datenqualitäts-Metriken
    const qualityStats = {
        totalValues: 0,
        invalidValues: 0,
        missingFields: {}
    };

    const dpMappings = {
        // System & Infos
        runtime:         { name: "Laufzeit", type: "number", role: "value", unit: "s" },
        heap:            { name: "Heap-Speicher", type: "number", role: "value", unit: "bytes" },
        lastUpdate:      { name: "Letzte Aktualisierung", type: "string", role: "date", unit: "" },
        _reload:         { name: "Konfiguration neu laden", type: "boolean", role: "button", unit: "" },

        // Innen-Sensoren
        tempin:          { name: "Innentemperatur", type: "number", role: "value.temperature", unit: "°C" },
        humidityin:      { name: "Innenluftfeuchtigkeit", type: "number", role: "value.humidity", unit: "%" },

        // Außen-Sensoren
        temp:            { name: "Außentemperatur", type: "number", role: "value.temperature", unit: "°C" },
        humidity:        { name: "Außenluftfeuchtigkeit", type: "number", role: "value.humidity", unit: "%" },
        baromrel:        { name: "Relativer Luftdruck", type: "number", role: "value.pressure", unit: "hPa" },
        baromabs:        { name: "Absoluter Luftdruck", type: "number", role: "value.pressure", unit: "hPa" },
        solarradiation:  { name: "Sonneneinstrahlung", type: "number", role: "value.radiation", unit: "W/m²" },
        uv:              { name: "UV-Index", type: "number", role: "value.uv", unit: "" },

        // Wind
        winddir:         { name: "Windrichtung", type: "number", role: "value.direction", unit: "°" },
        winddir_avg10m:  { name: "Windrichtung (10min ø)", type: "number", role: "value.direction", unit: "°" },
        windspeed:       { name: "Windgeschwindigkeit", type: "number", role: "value.speed.wind", unit: "km/h" },
        windgust:        { name: "Windböe", type: "number", role: "value.speed.wind.gust", unit: "km/h" },
        maxdailygust:    { name: "Maximale tägliche Böe", type: "number", role: "value.speed.wind.max", unit: "km/h" },
        beaufortscale:   { name: "Beaufort-Skala", type: "number", role: "value", unit: "" },
        winddir_name:    { name: "Windrichtung (Name)", type: "string", role: "text", unit: "" },

        // Regen
        rainrate:        { name: "Regenrate", type: "number", role: "value.rain.rate", unit: "mm/h" },
        eventrain:       { name: "Regen (Ereignis)", type: "number", role: "value.rain", unit: "mm" },
        hourlyrain:      { name: "Regen (Stündlich)", type: "number", role: "value.rain", unit: "mm" },
        dailyrain:       { name: "Regen (Täglich)", type: "number", role: "value.rain.today", unit: "mm" },
        last24hrain:     { name: "Regen (Letzte 24h)", type: "number", role: "value.rain", unit: "mm" },
        weeklyrain:      { name: "Regen (Wöchentlich)", type: "number", role: "value.rain", unit: "mm" },
        monthlyrain:     { name: "Regen (Monatlich)", type: "number", role: "value.rain", unit: "mm" },
        yearlyrain:      { name: "Regen (Jährlich)", type: "number", role: "value.rain", unit: "mm" },
        totalrain:       { name: "Regen (Gesamt)", type: "number", role: "value.rain", unit: "mm" },

        // Boden & PM2.5
        soilmoisture1:   { name: "Bodenfeuchtigkeit 1", type: "number", role: "value.humidity", unit: "%" },
        pm25_ch1:        { name: "Feinstaub PM2.5 Ch 1", type: "number", role: "value.pm25", unit: "µg/m³" },

        // Blitze
        lightning_num:   { name: "Anzahl Blitze", type: "number", role: "value", unit: "" },
        lightning:       { name: "Entfernung letzter Blitz", type: "number", role: "value.distance", unit: "km" },
        lightning_time:  { name: "Zeitpunkt letzter Blitz", type: "string", role: "date", unit: "" },

        // berechnete Werte
        dewpoint:        { name: "Taupunkt", type: "number", role: "value.temperature", unit: "°C" },
        feelslike:       { name: "Gefühlte Temperatur", type: "number", role: "value.temperature.feelslike", unit: "°C" },
        heatindex:       { name: "Hitzeindex", type: "number", role: "value.temperature", unit: "°C" },
        windchill:       { name: "Windchill", type: "number", role: "value.temperature.windchill", unit: "°C" },
        thermalperception:{ name: "Thermisches Empfinden", type: "string", role: "text", unit: "" },
        solarradiation_perceived: { name: "Sonneneinstrahlung wahrgenommen.", type: "number", role: "value.radiation", unit: "W/m²" },
        humidex:         { name: "Feuchte-Index", type: "number", role: "value", unit: "" },
        frostpoint:      { name: "Frostpunkt", type: "number", role: "value.temperature", unit: "°C" },
        frostrisk:       { name: "Frostrisiko", type: "string", role: "text", unit: "" },
        humidityabs:     { name: "Absolute Luftfeuchtigkeit (Aussen)", type: "number", role: "value.humidity", unit: "g/m³" },
        humidityabsin:   { name: "Absolute Luftfeuchtigkeit (Innen)", type: "number", role: "value.humidity", unit: "g/m³" },

        // Batteriestatus
        wh65batt:        { name: "Batterie WH65", type: "string", role: "text", unit: "" },
        soilbatt1:       { name: "Batterie Bodenfeuchtesensor 1", type: "number", role: "value.voltage", unit: "V" },
        pm25batt1:       { name: "Batterie PM2.5 Sensor 1", type: "number", role: "value.battery", unit: "%" },
        wh57batt:        { name: "Batterie WH57", type: "number", role: "value.battery", unit: "%" }
    };

    // --- HILFSFUNKTIONEN ---

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    /**
     * Cache-Persistenz: Sichern als asynchrone Funktion
     */
    async function saveCacheAsync() {
        try {
            const cacheArray = Array.from(stateCache.keys());
            await setStateAsync(CONFIG.cacheDpId, JSON.stringify(cacheArray), true);
            if (CONFIG.logLevel === 'debug') {
                log(`[Wetter] -> Cache asynchron gesichert in ${CONFIG.cacheDpId}`, 'debug');
            }
        } catch (e) {
            log(`[Wetter] -> Konnte Cache nicht in Datenpunkt sichern: ${e.message}`, 'warn');
        }
    }

    /**
     * Cache-Persistenz: Laden aus dem Datenpunkt
     */
    async function loadCacheAsync() {
        try {
            // Stellen wir sicher, dass der Cache-DP existiert, um Fehler beim allerersten Start zu vermeiden
            const exists = await getObjectAsync(CONFIG.cacheDpId);
            if (!exists) {
                await setObjectAsync(CONFIG.cacheDpId, {
                    type: 'state',
                    common: {
                        name: "Wetter-Cache Persistenz",
                        type: "string",
                        role: "json",
                        read: true,
                        write: false,
                        def: "[]"
                    },
                    native: {}
                });
                await setStateAsync(CONFIG.cacheDpId, "[]", true);
                return false; // Es gibt noch nichts zu laden
            }

            const state = await getStateAsync(CONFIG.cacheDpId);
            if (state && state.val && typeof state.val === 'string') {
                const cacheArray = JSON.parse(state.val);
                if (Array.isArray(cacheArray) && cacheArray.length > 0) {
                    cacheArray.forEach(id => stateCache.set(id, true));
                    log(`[Wetter] -> Cache aus Datenpunkt geladen: ${stateCache.size} Einträge`, 'info');
                    return true;
                }
            }
        } catch (e) {
            log(`[Wetter] -> Konnte Cache nicht aus Datenpunkt laden: ${e.message}`, 'warn');
        }
        return false;
    }

    /**
     * Graceful Shutdown Handling (mit Callback, um Daten vor Prozessende sicher zu schreiben)
     */
    onStop(function (callback) {
        log('[Wetter] -> Skript wird beendet. Speichere Cache in DB...', 'info');
        
        const cacheArray = Array.from(stateCache.keys());
        
        // Cache sichern via direkter Callback-Verschachtelung
        setState(CONFIG.cacheDpId, JSON.stringify(cacheArray), true, () => {
            if (CONFIG.enableHealthStats) {
                const healthId = `${CONFIG.targetPath}._health`;
                setState(healthId, JSON.stringify({
                    status: 'STOPPED',
                    lastUpdate: new Date().toISOString(),
                    stats: stats
                }), true, () => {
                    if(callback) callback();
                });
            } else {
                if(callback) callback();
            }
        });
    }, 2000); // 2s Timeout für den Callback inkl. Datenbank-Operationen

    /**
     * Dynamische Thresholds basierend auf Hardware anpassen
     */
    function autoTuneThresholds() {
        const totalMemory = (typeof process !== 'undefined' && process.memoryUsage) ? process.memoryUsage().heapTotal / 1024 / 1024 : 512;
        
        if (totalMemory < 256) {
            // Auf kleinen Systemen (z.B. RPi Zero) konservativere Werte
            PERFORMANCE_THRESHOLDS.processTime = 3000;
            CONFIG.maxCacheSize = 100;
            if(CONFIG.logLevel === 'debug') log('[Wetter] -> Auto-Tune: Konservatives Profil geladen (< 256MB RAM)', 'debug');
        } else if (totalMemory > 1024) {
            // Auf großen Systemen (z.B. Intel NUC) aggressiver
            PERFORMANCE_THRESHOLDS.processTime = 1000;
            CONFIG.maxCacheSize = 500;
            if(CONFIG.logLevel === 'debug') log('[Wetter] -> Auto-Tune: Aggressives Profil geladen (> 1GB RAM)', 'debug');
        }
    }

    /**
     * Alerting Integration
     */
    function sendAlert(message, level = 'warning') {
        if (level === 'critical' && CONFIG.alerts.telegram) {
            sendTo('telegram', `🚨 *Wetter-Skript Alert* 🚨\n${message}`);
        }
        if (CONFIG.alerts.pushover) {
            sendTo('pushover', `Wetter: ${message}`, level);
        }
        log(`[Wetter] -> ALERT (${level.toUpperCase()}): ${message}`, level === 'critical' ? 'error' : 'warn');
    }

    /**
     * Historische Datenanalyse (Trends)
     */
    function trackHistoricalValue(key, value) {
        if (!historyCache.has(key)) {
            historyCache.set(key, []);
        }
        
        const history = historyCache.get(key);
        history.push({ value, timestamp: Date.now() });
        
        // Älter als 24h (86400000ms) entfernen
        const cutoff = Date.now() - 86400000;
        while (history.length > 0 && history[0].timestamp < cutoff) {
            history.shift();
        }
        
        // Safety Limit: Maximal 1000 Einträge pro Key im RAM
        if (history.length > 1000) history.shift();
    }

    function getTrend(key) {
        const history = historyCache.get(key) || [];
        if (history.length < 2) return 'stable';
        
        const first = history[0].value;
        const last = history[history.length-1].value;
        const change = last - first;
        
        if (Math.abs(change) < 0.1) return 'stable';
        return change > 0 ? 'rising' : 'falling';
    }

    /**
     * Cache-Invalidierung für bestimmte Bereiche
     */
    function invalidateCacheForPrefix(prefix) {
        let deletedCount = 0;
        for (const [key] of stateCache) {
            if (key.startsWith(prefix)) {
                stateCache.delete(key);
                deletedCount++;
            }
        }
        if (deletedCount > 0 && CONFIG.logLevel === 'debug') {
            log(`[Wetter] -> Cache invalidated für ${deletedCount} Einträge (${prefix}*)`, 'debug');
        }
    }

    async function prefillCache() {
        try {
            const existingDps = await $(`state[id=${CONFIG.targetPath}.*]`);
            for (const dpId of existingDps) {
                stateCache.set(dpId, true);
            }
            log(`[Wetter] -> DB-Prefill: ${stateCache.size} States durch Queries geladen.`, 'info');
        } catch (error) {
            log(`[Wetter] -> DB-Prefill fehlgeschlagen: ${error}`, 'warn');
        }
    }

    async function initSystemStates() {
        if (!CONFIG.enableHealthStats) return;

        const healthId = `${CONFIG.targetPath}._health`;
        const statsId = `${CONFIG.targetPath}._stats`;
        const helpId = `${CONFIG.targetPath}._help`;
        const reloadId = `${CONFIG.targetPath}._reload`;

        const HELP_TEXT = `Verfügbare Datenpunkte unter ${CONFIG.targetPath}:
- *: Alle Wetterdaten von der Wetterstation
- lastUpdate: ISO-Zeitstempel der letzten Aktualisierung
- _health: JSON mit System-Health (Status, Memory, Cache, Errors)
- _stats: JSON mit Statistiken (Updates, Errors, Prozesszeit)
- _reload: Button um Cache/Config neu zu laden
Konfiguration im Skript-Kopf anpassbar:
- sourceDpId: MQTT-Quelle (${CONFIG.sourceDpId})
- debounceTime: Verzögerung bei Bursts (${CONFIG.debounceTime}ms)
- maxRetries: Wiederholungen bei Fehlern (${CONFIG.maxRetries})
Fehlerbehandlung:
- Systemfehler zählen zum Circuit Breaker (Max: ${CONFIG.maxErrors})`;

        await ensureStateExistsCached(healthId, '_health', JSON.stringify({status: 'INIT'}));
        await ensureStateExistsCached(statsId, '_stats', JSON.stringify(stats));
        await ensureStateExistsCached(helpId, '_help', HELP_TEXT);
        await ensureStateExistsCached(reloadId, '_reload', false);
        await setStateChangedAsync(helpId, HELP_TEXT, true);

        // Hot-Reload Listener
        on({ id: reloadId, change: 'any', ack: false }, async (obj) => {
            if (obj.state.val === true) {
                log('[Wetter] -> Lade Konfiguration neu (Hot-Reload triggered)...', 'info');
                stateCache.clear();
                if (!(await loadCacheAsync())) await prefillCache();
                autoTuneThresholds();
                log('[Wetter] -> Konfiguration neu geladen, Cache resettet', 'info');
                setState(reloadId, false, true); // Button zurücksetzen
            }
        });

        // Metriken-Update-Zyklus (alle 5 Minuten)
        schedule("*/5 * * * *", async () => {
            const memoryUsage = (typeof process !== 'undefined' && process.memoryUsage) ? Math.round(process.memoryUsage().heapUsed / 1024 / 1024) : 0;
            
            const healthData = {
                status: criticalErrorCount > CONFIG.maxErrors ? 'DEGRADED' : 'HEALTHY',
                memoryMB: memoryUsage,
                cacheLimit: CONFIG.maxCacheSize,
                cacheUsed: stateCache.size,
                criticalErrors: criticalErrorCount,
                timestamp: new Date().toISOString()
            };
            
            stats.uptime = (typeof process !== 'undefined' && process.uptime) ? Math.round(process.uptime()) : 0;

            await setStateChangedAsync(healthId, JSON.stringify(healthData), true);
            await setStateChangedAsync(statsId, JSON.stringify(stats), true);
        });
    }

    async function ensureStateExistsCached(id, key, value) {
        if (stateCache.has(id)) return true;

        if (stateCache.size > CONFIG.maxCacheSize) {
            const oldestKey = stateCache.keys().next().value;
            stateCache.delete(oldestKey);
        }
        
        try {
            const exists = await getObjectAsync(id);
            if (!exists) {
                const mapping = dpMappings[key] || {};
                const defValue = typeof value === 'object' ? JSON.stringify(value) : value;
                
                await setObjectAsync(id, {
                    type: 'state',
                    common: {
                        name: mapping.name || key,
                        type: typeof value === 'object' ? 'string' : (mapping.type || typeof value),
                        role: key.startsWith('_') ? (mapping.role || 'json') : (mapping.role || (typeof value === 'number' ? 'value' : 'text')),
                        unit: mapping.unit || '',
                        read: true,
                        write: mapping.role === 'button', // Nur Buttons beschreibbar machen
                        def: defValue
                    },
                    native: {}
                });
                
                // Initialwert explizit schreiben, da setObjectAsync nur das Objekt anlegt
                if (defValue !== undefined && defValue !== null) {
                    await setStateAsync(id, defValue, true);
                }
            }
            stateCache.set(id, true);
        } catch (error) {
            handleError(ERROR_TYPES.SYSTEM, `Fehler beim Erstellen von ${id}: ${error}`);
            return false;
        }
        return true;
    }

    async function setStateWithRetry(id, value, ack = true, retryCount = 0) {
        try {
            await setStateChangedAsync(id, value, ack);
        } catch (error) {
            if (retryCount < CONFIG.maxRetries) {
                await delay(CONFIG.retryDelayBase * (retryCount + 1));
                return setStateWithRetry(id, value, ack, retryCount + 1);
            }
            throw error; 
        }
    }

    async function bulkStateUpdate(operations) {
        if (operations.length > PERFORMANCE_THRESHOLDS.bulkOperations && CONFIG.logLevel === 'debug') {
            log(`[Wetter] -> BULK: ${operations.length} parallele Updates werden ausgeführt.`, 'debug');
        }
        const results = await Promise.allSettled(operations);
        for (const result of results) {
            if (result.status === 'rejected') {
                handleError(ERROR_TYPES.SYSTEM, `Fehler beim Bulk-Update: ${result.reason}`);
            }
        }
    }

    function processValue(value, typeHint) {
        if (value === null || value === undefined) return null;
        const type = typeHint || typeof value;

        switch(type) {
            case 'number':
                const num = Number(value);
                if (isNaN(num)) return null;
                if (!Number.isInteger(num)) {
                    const factor = Math.pow(10, CONFIG.roundingDecimals);
                    return Math.round(num * factor) / factor;
                }
                return num;
            case 'boolean': return Boolean(value);
            case 'string': return String(value);
            default: return value;
        }
    }

    function trackDataQuality(key, isValid, isMissing = false) {
        qualityStats.totalValues++;
        if (!isValid) qualityStats.invalidValues++;
        if (isMissing) qualityStats.missingFields[key] = (qualityStats.missingFields[key] || 0) + 1;
    }

    function validateWeatherData(dataObj) {
        if (!CONFIG.validateData) return true;
        const requiredFields = ['temp', 'humidity', 'baromrel'];
        const missingFields = requiredFields.filter(field => !(field in dataObj));
        
        if (missingFields.length > 0) {
            missingFields.forEach(f => trackDataQuality(f, false, true));
            handleError(ERROR_TYPES.VALIDATION, `Eingehende Daten unvollständig (Fehlt: ${missingFields.join(', ')})`);
        }
        return true;
    }

    function isValueValid(key, value) {
        if (!CONFIG.validateData) return true;
        const rule = VALIDATION_RULES[key];
        
        if (rule && typeof value === 'number' && (value < rule.min || value > rule.max)) {
            trackDataQuality(key, false);
            handleError(ERROR_TYPES.VALIDATION, `Unplausibler Wert ignoriert für ${key}: ${value} (Erlaubt: ${rule.min} bis ${rule.max})`);
            return false;
        }
        
        trackDataQuality(key, true);
        return true;
    }

    function handleError(type, message) {
        if (type === ERROR_TYPES.SYSTEM) {
            criticalErrorCount++;
            stats.systemErrors++;
            log(`[Wetter] -> SYSTEM-FEHLER: ${message} (Kritisch: ${criticalErrorCount}/${CONFIG.maxErrors})`, 'error');
            
            if (criticalErrorCount > CONFIG.maxErrors && !circuitBreakerAlertSent) {
                sendAlert(`Circuit Breaker aktiviert! System pausiert wegen Systemfehlern (${criticalErrorCount}).`, 'critical');
                circuitBreakerAlertSent = true;
            }
        } else {
            stats.parseErrors++;
            log(`[Wetter] -> ${type.toUpperCase()}-WARNUNG: ${message}`, 'warn');
        }
    }

    async function cleanupObsoleteStates(receivedKeys) {
        const now = Date.now();
        if (now - lastCleanup < CONFIG.cleanupInterval) return; 
        lastCleanup = now;
        
        try {
            const existingDps = await $(`state[id=${CONFIG.targetPath}.*]`);
            for (const dpId of existingDps) {
                if (!receivedKeys.has(dpId) && !dpId.includes('._') && dpId !== CONFIG.cacheDpId) { 
                    const state = await getStateAsync(dpId);
                    if (state && state.val !== null) {
                        const stateAge = now - state.ts;
                        if (stateAge > CONFIG.cleanupObsoleteAfter) {
                            log(`[Wetter] -> Cleanup: Datenpunkt ${dpId} inaktiv. Setze auf null.`, 'info');
                            await setStateWithRetry(dpId, null, true);
                        }
                    }
                }
            }
        } catch (error) {
            handleError(ERROR_TYPES.SYSTEM, `Fehler während des Cleanups: ${error}`);
        }
    }

    // --- HAUPTVERARBEITUNG ---

    async function processWeatherData(jsonString) {
        if (criticalErrorCount > CONFIG.maxErrors) return; // Circuit Breaker aktiv

        if (isProcessing) return;
        
        isProcessing = true;
        const startTime = Date.now();

        try {
            let dataObj;
            try {
                dataObj = JSON.parse(jsonString);
            } catch (e) {
                handleError(ERROR_TYPES.PARSE, `JSON ungültig: ${e.message}`);
                return;
            }

            if (!validateWeatherData(dataObj)) return; 

            const receivedKeys = new Set();
            const updateOperations = [];

            for (const [key, rawValue] of Object.entries(dataObj)) {
                if (rawValue === null) continue;

                const mappingType = dpMappings[key] ? dpMappings[key].type : typeof rawValue;
                const processedValue = processValue(rawValue, mappingType);
                
                if (processedValue === null || !isValueValid(key, processedValue)) continue;

                // Historie & Trends aufzeichnen (nur für numerische Werte)
                if (typeof processedValue === 'number') {
                    trackHistoricalValue(key, processedValue);
                }

                const targetDpId = `${CONFIG.targetPath}.${key}`;
                receivedKeys.add(targetDpId);

                if (CONFIG.createMissingStates) {
                    const success = await ensureStateExistsCached(targetDpId, key, processedValue);
                    if (!success) continue; 
                }
                updateOperations.push(setStateWithRetry(targetDpId, processedValue, true));
            }
            
            const lastUpdateDpId = `${CONFIG.targetPath}.lastUpdate`;
            receivedKeys.add(lastUpdateDpId);
            const timestamp = new Date().toISOString();
            
            if (CONFIG.createMissingStates) {
                await ensureStateExistsCached(lastUpdateDpId, 'lastUpdate', timestamp);
            }
            updateOperations.push(setStateWithRetry(lastUpdateDpId, timestamp, true));

            await bulkStateUpdate(updateOperations);
            await cleanupObsoleteStates(receivedKeys);

            // Statistik & Performance Checking
            const processDuration = Date.now() - startTime;
            if (processDuration > PERFORMANCE_THRESHOLDS.processTime) {
                log(`[Wetter] -> LANGSAM: Verarbeitung dauerte ${processDuration}ms`, 'warn');
            }

            stats.updates++;
            stats.lastUpdate = timestamp;
            stats.avgProcessTime = (stats.avgProcessTime + processDuration) / 2;
            
            // Recovery
            if (criticalErrorCount > 0) {
                criticalErrorCount = Math.max(0, criticalErrorCount - 1);
                if (criticalErrorCount === 0 && circuitBreakerAlertSent) {
                    sendAlert('Circuit Breaker gelöst, System läuft wieder stabil.', 'info');
                    circuitBreakerAlertSent = false;
                }
            }

        } catch (error) {
            handleError(ERROR_TYPES.SYSTEM, `Unerwarteter Fehler in processWeatherData: ${error.message}`);
        } finally {
            isProcessing = false;
        }
    }

    // --- SKRIPT-START ---

    async function main() {
        let debounceTimer;

        // 1. Thresholds Auto-Tuning
        autoTuneThresholds();

        // 2. Initiale Setup-Schritte (Versuche DP Cache zu laden, sonst DB Query)
        if (!(await loadCacheAsync())) {
            await prefillCache();
        }
        await initSystemStates();

        // 3. Initiale Daten verarbeiten
        const initialState = getState(CONFIG.sourceDpId);
        if (initialState && initialState.val) {
            await processWeatherData(initialState.val);
        }

        // 4. MQTT Event-Listener (mit Debouncing)
        on({ id: CONFIG.sourceDpId, change: 'any' }, (obj) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
                if (obj.state && obj.state.val && typeof obj.state.val === 'string') {
                    await processWeatherData(obj.state.val);
                }
            }, CONFIG.debounceTime);
        });

        // 5. Langzeit-Logs, Cache-Tuning & Quality Reporting (Stündlich)
        schedule("0 * * * *", async () => {
            // Stats
            log(`[Wetter] -> System-Health: ${stats.updates} Updates/h | AvgTime: ~${Math.round(stats.avgProcessTime)}ms | Errors(Sys/Parse): ${stats.systemErrors}/${stats.parseErrors}`, 'info');
            
            // Regelmäßig Cache in den Datenpunkt wegschreiben
            await saveCacheAsync();

            // Quality Reporting
            if (qualityStats.totalValues > 0) {
                const qualityRate = ((qualityStats.totalValues - qualityStats.invalidValues) / qualityStats.totalValues * 100).toFixed(1);
                log(`[Wetter] -> Datenqualität: ${qualityRate}% gültig (${qualityStats.invalidValues} ungültige Werte/Ausfälle)`, 'info');
                
                const topMissing = Object.entries(qualityStats.missingFields)
                    .sort((a,b) => b[1] - a[1])
                    .slice(0, 5);
                if (topMissing.length > 0) {
                    log('[Wetter] -> Häufigste fehlende/defekte Felder: ' + topMissing.map(([k,v]) => `${k}(${v}x)`).join(', '), 'debug');
                }
                
                qualityStats.totalValues = 0;
                qualityStats.invalidValues = 0;
                qualityStats.missingFields = {};
            }
        });

        log(`[Wetter] -> Wetter-Parser-Skript V5.2 (State Cache) erfolgreich gestartet.`, 'info');
    }

    main().catch(err => {
        log(`[Wetter] -> Fataler Fehler beim Skript-Start: ${err}`, 'error');
    });

})();