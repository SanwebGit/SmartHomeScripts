/**
 * -----------------------------------------------------------------------------
 * @file        heizung_sollwerte.js
 * @author      Sanweb
 * @version     1.4.1
 * @date        2026-03-06
 * * @description Dieses Wartungs-Skript stellt sicher, dass die notwendigen Datenpunkte für 
 * die Heizungssteuerung vorhanden und korrekt konfiguriert sind. 
 * Es prüft beim Start und einmal täglich in der Nacht, ob die 
 * Datenpunkte existieren, und korrigiert bei Bedarf ihre 
 * Eigenschaften (Name, Typ, Rolle etc.), ohne den aktuellen Wert 
 * zu verändern.
 * * @environment ioBroker JavaScript Adapter
 * * @note        WICHTIG: In den Instanz-Einstellungen des JavaScript-Adapters 
 * (z.B. javascript.0) MUSS der Haken bei "Erlaube das Kommando 
 * setObject" gesetzt sein!
 * @changelog
 * - 1.4.1: Bugfix - Ersetze nicht verfügbares setObjectNotExistsAsync durch setObjectAsync
 * - 1.4.0: Object-Cache Integration, lastChanges Tracking, Memory Management
 * - 1.3.0: JSON-Status-DP, Batch-Processing Struktur, Race-Condition Schutz
 * - 1.2.0: Retry/Timeout-Logik, Schutz für systemrelevante Eigenschaften
 * - 1.1.0: Initiale Erstellung & Konfigurations-Validierung
 * -----------------------------------------------------------------------------
 */

/**
 * @typedef {Object} StateConfig
 * @property {string} id
 * @property {Object} common
 * @property {Object} native
 */

/**
 * @typedef {Object} Stats
 * @property {number} created
 * @property {number} updated
 * @property {number} errors
 * @property {number} clamped
 */

// Kapselung des gesamten Skripts in einer anonymen async-Funktion, um den globalen Namespace zu schützen
(async () => {
    "use strict";
    /**
     * Globale Skript-Konfiguration
     * * --- Einsatzempfehlungen (Best Practices) ---
     * * 1. Standard-Nutzung (sicher & informativ):
     * batchSize: 1, logLevel: 'info', correctValues: true
     * * 2. Große Installationen (50+ DPs, performant):
     * batchSize: 5, timeoutMs: 10000, retryCount: 2, logLevel: 'warn'
     * * 3. Entwicklungs-/Testumgebung (schnelles Feedback):
     * batchSize: 1, logLevel: 'debug', correctValues: true, retryCount: 1
     */
    const config = {
        cronExpression: '0 3 * * *', // Standard: 3 Uhr nachts
        runOnStart: true,            // Beim Skriptstart einmalig ausführen
        logLevel: 'info',            // Mögliche Werte: 'debug', 'info', 'warn', 'error'
        retryCount: 3,               // Anzahl Wiederholungen bei Fehlern
        timeoutMs: 5000,             // Timeout in ms für ioBroker-Operationen
        correctValues: true,         // Sollen Werte außerhalb min/max korrigiert werden?
        batchSize: 1                 // 1 = sequentiell, >1 für parallele Verarbeitung bei vielen DP
    };

    /** @type {Stats} */
    const stats = {
        created: 0,
        updated: 0,
        errors: 0,
        clamped: 0
    };

    // Schutz vor parallelen Ausführungen (Race Conditions)
    let isRunning = false;

    // Object-Cache für wiederholte Zugriffe (wird pro Durchlauf zurückgesetzt)
    const objectCache = new Map();

    /**
     * Helper: Deep Equal für genauen Objekt-Vergleich (inkl. Zirkel-Erkennung)
     */
    function deepEqual(obj1, obj2, visited = new Set()) {
        if (obj1 === obj2) return true;
        if (!obj1 || !obj2 || typeof obj1 !== 'object' || typeof obj2 !== 'object') return false;
        
        // Zirkuläre Referenzen erkennen
        if (visited.has(obj1) || visited.has(obj2)) return true;
        visited.add(obj1);
        visited.add(obj2);
        
        const keys1 = Object.keys(obj1);
        const keys2 = Object.keys(obj2);
        
        if (keys1.length !== keys2.length) return false;
        
        for (const key of keys1) {
            if (!keys2.includes(key)) return false;
            if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object') {
                if (!deepEqual(obj1[key], obj2[key], visited)) return false;
            } else if (obj1[key] !== obj2[key]) return false;
        }
        return true;
    }

    /**
     * Helper: Timeout für asynchrone Operationen
     */
    async function withTimeout(promise, ms = config.timeoutMs, errorMsg = 'Timeout') {
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(errorMsg)), ms);
        });
        
        return Promise.race([promise, timeoutPromise]).finally(() => {
            clearTimeout(timeoutId);
        });
    }

    /**
     * Helper: Retry-Logik für fehlgeschlagene Operationen
     */
    async function withRetry(fn, maxRetries = config.retryCount, delay = 1000) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await fn();
            } catch (error) {
                if (i === maxRetries - 1) throw error;
                customLog(`Retry ${i + 1}/${maxRetries} nach Fehler: ${error.message || error}`, 'debug');
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    /**
     * Hilfsfunktion für strukturiertes Logging basierend auf dem konfigurierten Log-Level
     * @param {string} message Die zu loggende Nachricht
     * @param {'debug' | 'info' | 'warn' | 'error'} [level='info'] Das Log-Level
     */
    function customLog(message, level = 'info') {
        const levels = { 'debug': 0, 'info': 1, 'warn': 2, 'error': 3 };
        const currentLevel = levels[config.logLevel] !== undefined ? levels[config.logLevel] : 1;
        const msgLevel = levels[level] !== undefined ? levels[level] : 1;
        
        if (msgLevel >= currentLevel) {
            log(message, level);
        }
    }

    /**
     * Konfiguration der Datenpunkte
     * @type {StateConfig[]}
     */
    const statesToCreate = [
        {
            id: '0_userdata.0.Heizung.sollTempAnwesend',
            common: {
                name: 'Soll Temperatur Anwesend',
                desc: 'Solltemperatur, wenn jemand anwesend ist',
                type: 'number',
                role: 'level.temperature',
                read: true,
                write: true,
                def: 18,
                unit: '°C',
                min: 5,
                max: 30,
                step: 0.5
            },
            native: {}
        },
        {
            id: '0_userdata.0.Heizung.sollTempAbwesend',
            common: {
                name: 'Soll Temperatur Abwesend',
                desc: 'Solltemperatur, wenn niemand anwesend ist (Absenktemperatur)',
                type: 'number',
                role: 'level.temperature',
                read: true,
                write: true,
                def: 16,
                unit: '°C',
                min: 5,
                max: 30,
                step: 0.5
            },
            native: {}
        }
    ];

    /**
     * Verarbeitet einen einzelnen Datenpunkt isoliert (ermöglicht Batch-Processing)
     * @param {StateConfig} state 
     */
    async function processState(state) {
        try {
            // Prüfung für Pflichtfelder
            const requiredFields = ['type', 'role', 'name'];
            for (const field of requiredFields) {
                if (!state.common[field]) {
                    customLog(`Warnung: Pflichtfeld '${field}' fehlt bei der Definition von ${state.id}`, 'warn');
                }
            }

            // Cache nutzen, falls vorhanden
            let obj = objectCache.get(state.id);
            if (!obj) {
                obj = await getObjectAsync(state.id);
                if (obj) objectCache.set(state.id, obj);
            }

            if (!obj) {
                // 1. Fall: Datenpunkt existiert nicht -> Neu anlegen
                await withRetry(() => withTimeout(setObjectAsync(state.id, {
                    type: 'state',
                    common: state.common,
                    native: state.native || {}
                })));
                customLog(`Datenpunkt '${state.id}' wurde neu erstellt.`, 'info');
                stats.created++;
                
                // 2. Fall: Initialen Wert setzen
                await withRetry(() => withTimeout(setStateAsync(state.id, { val: state.common.def, ack: true }))).catch(e => {
                    customLog(`Timeout/Fehler beim Setzen des Initialwerts für '${state.id}': ${e}`, 'warn');
                });
                customLog(`Initialwert für '${state.id}' auf '${state.common.def}' gesetzt.`, 'info');

            } else {
                // 3. Fall: Datenpunkt existiert -> Konfiguration überprüfen
                let needsUpdate = false;
                const updateCommon = {};
                
                const commonKeys = Object.keys(state.common);
                const objCommonKeys = obj.common ? Object.keys(obj.common) : [];
                
                // Prüfen auf fehlende oder abweichende Eigenschaften mit deepEqual
                for (const key of commonKeys) {
                    if (!deepEqual(obj.common[key], state.common[key])) {
                        needsUpdate = true;
                        updateCommon[key] = state.common[key];
                    }
                }

                // Prüfen, ob überflüssige Eigenschaften entfernt werden müssen
                if (obj.common) {
                    const protectedKeys = ['history', 'custom', 'alias', 'smartName', 'enums'];
                    for (const key of objCommonKeys) {
                        if (!state.common.hasOwnProperty(key) && !protectedKeys.includes(key)) {
                            needsUpdate = true;
                            updateCommon[key] = null; 
                        }
                    }
                }

                if (needsUpdate) {
                    try {
                        await withRetry(() => withTimeout(extendObjectAsync(state.id, { common: updateCommon })));
                        customLog(`Konfiguration von '${state.id}' wurde korrigiert.`, 'info');
                        stats.updated++;
                    } catch (extErr) {
                        if (extErr.toString().includes('not allowed')) {
                            customLog(`WICHTIG: 'extendObject' ist blockiert! Bitte in den Instanz-Einstellungen (z.B. javascript.0) den Haken bei "Erlaube das Kommando setObject" setzen.`, 'error');
                        }
                        throw extErr;
                    }
                } else {
                    customLog(`Datenpunkt '${state.id}' existiert bereits und ist korrekt konfiguriert.`, 'debug');
                }

                // 4. Fall: Existierende Werte prüfen und ggf. korrigieren (Bereichsgrenzen)
                if (config.correctValues && (state.common.min !== undefined || state.common.max !== undefined)) {
                    const currentVal = await getStateAsync(state.id);
                    if (currentVal && currentVal.val !== undefined && currentVal.val !== null) {
                        let newVal = currentVal.val;
                        if (state.common.min !== undefined && newVal < state.common.min) newVal = state.common.min;
                        if (state.common.max !== undefined && newVal > state.common.max) newVal = state.common.max;
                        
                        if (newVal !== currentVal.val) {
                            await withRetry(() => withTimeout(setStateAsync(state.id, { val: newVal, ack: true }))).catch(e => {
                                customLog(`Fehler beim Korrigieren des Werts für '${state.id}': ${e}`, 'warn');
                            });
                            customLog(`Wert von '${state.id}' auf Bereichsgrenze korrigiert (${currentVal.val} -> ${newVal})`, 'info');
                            stats.clamped++;
                        }
                    }
                }
            }
        } catch (error) {
            customLog(`Fehler bei der Verarbeitung des Datenpunkts '${state.id}': ${error}`, 'error');
            stats.errors++;
        }
    }

    /**
     * Hauptfunktion zur Ausführung
     */
    async function checkAndCreateStates() {
        if (isRunning) {
            customLog('Vorheriger Durchlauf läuft noch - überspringe', 'warn');
            return;
        }
        
        isRunning = true;
        
        // Cache zu Beginn leeren (verhindert veraltete Objekte bei Dauerbetrieb)
        objectCache.clear();
        
        try {
            customLog('Überprüfe und korrigiere die erforderlichen Heizungs-Datenpunkte...', 'info');
            
            // Status-Datenpunkte (JSON) anlegen/prüfen
            const statusStateId = '0_userdata.0.Heizung.Wartung.dpCheck.status';
            const changesStateId = '0_userdata.0.Heizung.Wartung.dpCheck.lastChanges';
            
            for (const id of [statusStateId, changesStateId]) {
                try {
                    const stateObj = await getObjectAsync(id);
                    if (!stateObj) {
                        const name = id.includes('lastChanges') ? 'Letzte Änderungen' : 'Datenpunkt-Überprüfung Status';
                        await withRetry(() => withTimeout(setObjectAsync(id, {
                            type: 'state',
                            common: {
                                name: name,
                                type: 'string', 
                                role: 'json',
                                read: true,
                                write: false,
                                def: JSON.stringify({ lastRun: null, stats: {} })
                            },
                            native: {}
                        })));
                    }
                } catch (e) {
                    customLog(`Konnte Management-Datenpunkt ${id} nicht erstellen: ${e}`, 'warn');
                }
            }

            // Batch-Processing der Datenpunkte
            for (let i = 0; i < statesToCreate.length; i += config.batchSize) {
                const batch = statesToCreate.slice(i, i + config.batchSize);
                await Promise.all(batch.map(state => processState(state)));
                
                // Optional: Memory Management bei sehr großen Arrays
                if (objectCache.size > 100) {
                    objectCache.clear();
                    customLog('Object-Cache geleert (Memory Management)', 'debug');
                }
            }

            // Status-Datenpunkt updaten
            try {
                await setStateAsync(statusStateId, { 
                    val: JSON.stringify({
                        lastRun: new Date().toISOString(),
                        stats: { ...stats }
                    }), 
                    ack: true 
                });
            } catch (e) {
                customLog(`Konnte LastRun Status nicht aktualisieren: ${e}`, 'warn');
            }

            // lastChanges updaten, falls es Änderungen gab
            if (stats.created > 0 || stats.updated > 0 || stats.clamped > 0) {
                try {
                    await setStateAsync(changesStateId, {
                        val: JSON.stringify({
                            timestamp: new Date().toISOString(),
                            changes: { ...stats }
                        }),
                        ack: true
                    });
                    customLog('Datenpunkt lastChanges wurde aktualisiert.', 'debug');
                } catch (e) {
                    customLog(`Konnte lastChanges Status nicht aktualisieren: ${e}`, 'warn');
                }
            }

            customLog(`Überprüfung abgeschlossen. Statistik: ${stats.created} erstellt, ${stats.updated} aktualisiert, ${stats.clamped} Werte korrigiert, ${stats.errors} Fehler.`, 'info');
            
        } finally {
            isRunning = false; // Lock immer aufheben
        }
    }

    // --- Skript-Start ---

    if (config.runOnStart) {
        customLog('Skript-Start: Initiale Überprüfung wird ausgeführt...', 'info');
        await checkAndCreateStates();
    }

    // Richte den konfigurierten Cronjob ein
    schedule(config.cronExpression, async () => {
        customLog('Cronjob: Geplante Überprüfung der Datenpunkte wird gestartet.', 'info');
        // Zähler für neuen Lauf zurücksetzen
        stats.created = 0;
        stats.updated = 0;
        stats.errors = 0;
        stats.clamped = 0;
        await checkAndCreateStates();
    });

    customLog('Skript zur Überprüfung der Heizungs-Datenpunkte wurde gestartet und ist betriebsbereit.', 'info');

})();