/**
 * @description Steuert einen Homematic-Aktor basierend auf Zigbee-Präsenzmeldern 
 * und einer definierten Zusatzbedingung.
 * @version     1.10.0
 * @author      Sanweb
 * @copyright   2026
 * @requires    javascript (ioBroker JavaScript Adapter)
 * @requires    zigbee2mqtt (ioBroker Zigbee2MQTT Adapter)
 * @requires    hm-rpc (ioBroker Homematic RPC Adapter)
 * @changelog
 * 1.11.1 - Bugfix: ReferenceError "process is not defined" im Heartbeat behoben
 * 1.11.0 - Mikroskopische Optimierungen: Erweiterte Config-Prüfung, Fail-Safe Mode 2, Performance-Monitoring
 * 1.10.0 - Finale Optimierungen: Konstanten ausgelagert, validateConfig erweitert, Status-Update robuster
 * 1.9.0 - Zwingende Prüfung auf Astro-Datenpunkt beim Start hinzugefügt
 * 1.8.0 - Config-Validierung, safeCreateState, Auto-Recovery, erweiterter Heartbeat
 * 1.7.0 - Auto-Creation für Datenpunkte, Statistik-Sammlung, Try/Catch für setState, Manueller Trigger
 * 1.6.0 - Fail-Safe für Sensoren, Heartbeat-Datenpunkt, Konstanten für Fenster, init/timer Handling optimiert
 * 1.5.0 - Zustandsmaschine, Debouncing für Fenster, State-Dumps und flexiblere Config integriert
 * 1.4.0 - Spezifische Fenster-Logik (gekippt vs. offen) und erweiterte Trigger hinzugefügt
 * 1.3.0 - Array für Bedingungen eingeführt und Tag/Nacht-Abfrage hinzugefügt
 * 1.2.0 - Implementierung von Ausschaltverzögerung, erweitertem Logging, Throttling & Fehlerbehandlung
 * 1.1.0 - Optimierung für Homematic Duty-Cycle und Multi-Sensor-Logik
 * 1.0.0 - Initiale Erstellung
 */

(function() {
    "use strict";

    // =============================================================================
    // KONFIGURATION
    // =============================================================================
    const CONFIG = {
        sensors: {
            presence: [
                'zigbee2mqtt.0.0xa4c138665cef7108.presence',
                'zigbee2mqtt.0.0xa4c138f24bb238a3.presence'
            ],
            // Fenster-Sensoren
            window: {
                bottom: 'hm-rpc.0.003A20C99025DB.1.STATE',
                top: 'hm-rpc.0.0023DA49A3CC62.1.STATE'
            },
            // Astrofunktion: Nacht (true = Nacht)
            nightMode: '0_userdata.0.System.Astro.Nacht'
        },
        actors: {
            target: 'hm-rpc.0.003AE0C9AD4F01.4.STATE' // zu schaltender Aktor
        },
        settings: {
            useMultiSensorLogic: true,
            turnOffDelay: 30000, // 30 Sekunden Ausschaltverzögerung in ms
            delayEnabled: true,  // Ausschaltverzögerung aktivieren/deaktivieren
            nightModeOnly: false, // true = Licht nur nachts, false = immer (außer Fenster offen)
            windowCheckEnabled: true // Fensterüberwachung ein/aus
        },
        status: {
            enabled: true,
            // Pfad änderbar: Wird automatisch angelegt, falls nicht vorhanden
            stateId: '0_userdata.0.Haushalt.Badezimmer.Status', 
            updateInterval: 60000 // 1 Minute in ms
        },
        testing: {
            enabled: false,
            // Optional: Datenpunkt für manuelle Trigger-Tests
            manualTriggerState: '0_userdata.0.Haushalt.Badezimmer.ManualTrigger' 
        },
        debug: {
            enabled: true,           // Debug-Modus aktivieren
            logStateId: '',          // Optional: Datenpunkt-ID für Debug-Ausgaben
            logLevel: 'debug'        // 'debug', 'info', 'warn', 'error'
        }
    };

    // =============================================================================
    // KONSTANTEN
    // =============================================================================
    const CONSTANTS = {
        WINDOW_DEBOUNCE_TIME: 2000,    // 2 Sekunden Entprellzeit für Fenster
        MIN_SWITCH_INTERVAL: 5000,     // Mindestens 5 Sekunden zwischen regulären Schaltvorgängen
        ERROR_RECOVERY_DELAY: 300000,  // 5 Minuten
        
        WINDOW_STATES: {            // Windows States basierend auf States von HmIP Aktoren,
            BOTTOM_CLOSED: 0,       // ggf. States auf andere vorhanden Aktoren anpassen
            BOTTOM_OPEN: 1,
            TOP_CLOSED: 0,
            TOP_OPEN: 1
        },
        
        State: {
            OFF: 'off',
            ON: 'on',
            DELAYED_OFF: 'delayed_off',
            BLOCKED: 'blocked'
        }
    };

    // =============================================================================
    // GLOBALE VARIABLEN & STATISTIKEN
    // =============================================================================
    const scriptStartTime = Date.now();
    let heartbeatInterval = null;
    let errorRecoveryTimer = null;
    let triggerCount = 0; 

    const stats = {
        totalSwitches: 0,
        windowOpenEvents: 0,
        errors: 0,
        avgResponseTime: 0,     // Durchschnittliche Reaktionszeit
        maxResponseTime: 0,     // Maximale Reaktionszeit
        lastResponseTimes: []   // Letzte 10 Reaktionszeiten
    };
    
    let currentState = CONSTANTS.State.OFF;
    let turnOffTimer = null;
    let lastPresenceState = false;
    let lastSwitchTime = 0;
    let windowDebounceTimer = null;

    // =============================================================================
    // LOGIK & FUNKTIONEN
    // =============================================================================

    /**
     * Erweiterte Log-Funktion mit verschiedenen Log-Leveln
     * @param {string} message - Die Log-Nachricht
     * @param {'debug' | 'info' | 'warn' | 'error'} [level='debug'] - Das ioBroker Log-Level
     * @param {Object|null} [data=null] - Zusätzliche Daten für die Fehlersuche
     */
    function logWithDetails(message, level = 'debug', data = null) {
        const logPrefix = '[Auto-Licht Bad]';
        let logMessage = `${logPrefix} ${message}`;
        
        if (data) {
            logMessage += ` | Details: ${JSON.stringify(data)}`;
        }
        
        if (CONFIG.debug.enabled && CONFIG.debug.logStateId && existsState(CONFIG.debug.logStateId)) {
            setState(CONFIG.debug.logStateId, logMessage, true);
        }
        
        if (level === 'debug' && !CONFIG.debug.enabled) return;
        log(logMessage, level);
    }

    /**
     * Validiert die Konfiguration beim Skriptstart
     */
    function validateConfig() {
        const issues = [];
        
        if (CONFIG.sensors.presence.length === 0) {
            issues.push('Keine Präsenzsensoren konfiguriert');
        } else {
            CONFIG.sensors.presence.forEach((id, index) => {
                if (typeof id !== 'string' || id.trim() === '') {
                    issues.push(`Presence-Sensor ${index}: ungültige ID`);
                }
            });
        }

        if (!CONFIG.actors.target || CONFIG.actors.target === '') {
            issues.push('Kein Aktor konfiguriert');
        }

        if (CONFIG.settings.turnOffDelay < 1000) {
            issues.push('Ausschaltverzögerung sehr kurz (< 1s)');
        } else if (CONFIG.settings.turnOffDelay > 3600000) {
            issues.push('Ausschaltverzögerung > 1 Stunde - ist das gewollt?');
        }

        if (CONFIG.status.enabled) {
            if (!CONFIG.status.stateId) {
                issues.push('Status aktiviert, aber keine stateId angegeben');
            }
            if (CONFIG.status.updateInterval < 10000) {
                issues.push('Status-Update-Interval sehr kurz (< 10s)');
            }
        }
        
        // Prüfung: nightModeOnly aktiviert, aber Datenpunkt fehlt
        if (CONFIG.settings.nightModeOnly && !existsState(CONFIG.sensors.nightMode)) {
            issues.push('nightModeOnly aktiv, aber Astro-Datenpunkt fehlt');
        }
        
        if (issues.length > 0) {
            logWithDetails('Konfigurations-Warnungen:', 'warn', { issues });
            return false;
        }
        
        return true;
    }

    /**
     * Sicheres Anlegen von Datenpunkten mit Fehlerbehandlung
     */
    function safeCreateState(id, initialValue, config) {
        try {
            if (!existsState(id)) {
                createState(id, initialValue, true, config, (err) => {
                    if (err) {
                        logWithDetails(`Fehler beim Anlegen von ${id}: ${err}`, 'error');
                        stats.errors++;
                    } else {
                        logWithDetails(`Datenpunkt ${id} erfolgreich angelegt`, 'info');
                    }
                });
            }
        } catch (e) {
            logWithDetails(`Exception beim Anlegen von ${id}: ${e.message}`, 'error');
            stats.errors++;
        }
    }

    /**
     * Prüft ob alle Sensoren erreichbar sind (für Heartbeat)
     */
    function checkAllSensors() {
        const result = { allOk: true, problems: [] };
        
        CONFIG.sensors.presence.forEach(id => {
            if (!existsState(id)) {
                result.allOk = false;
                result.problems.push({ sensor: id, issue: 'nicht gefunden' });
            }
        });
        
        return result;
    }

    /**
     * Schreibt einen erweiterten Heartbeat inkl. Statistiken
     */
    function updateStatusState() {
        if (!CONFIG.status.enabled || !CONFIG.status.stateId) return;
        
        try {
            if (!existsState(CONFIG.status.stateId)) {
                // Status-Datenpunkt nachträglich anlegen wenn möglich
                safeCreateState(CONFIG.status.stateId, '{}', {
                    name: 'Badezimmer Licht - Status',
                    type: 'string',
                    role: 'json',
                    read: true,
                    write: false
                });
                return; // Nächstes Update wird dann funktionieren
            }

            const sensorDetails = {};
            CONFIG.sensors.presence.forEach((id, index) => {
                sensorDetails[`sensor_${index + 1}`] = {
                    id: id,
                    exists: existsState(id),
                    value: existsState(id) ? getState(id)?.val : null,
                    lastUpdate: existsState(id) ? getState(id)?.ts : null
                };
            });

            const statusObj = {
                timestamp: Date.now(),
                state: currentState,
                presence: isAnyPresenceActive(),
                conditions: areConditionsMet(),
                actorState: existsState(CONFIG.actors.target) ? getState(CONFIG.actors.target)?.val : null,
                timerActive: turnOffTimer !== null,
                system: {
                    version: '1.11.1',
                    scriptUptime: Math.round((Date.now() - scriptStartTime) / 1000) + 's',
                    memory: typeof process !== 'undefined' ? Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB' : 'n/a',
                    triggers: triggerCount
                },
                sensors: sensorDetails,
                config: {
                    multiSensorLogic: CONFIG.settings.useMultiSensorLogic,
                    delayEnabled: CONFIG.settings.delayEnabled,
                    windowCheckEnabled: CONFIG.settings.windowCheckEnabled
                },
                stats: {
                    totalSwitches: stats.totalSwitches,
                    windowOpenEvents: stats.windowOpenEvents,
                    errors: stats.errors,
                    avgResponseTime: Math.round(stats.avgResponseTime) + 'ms',
                    maxResponseTime: stats.maxResponseTime + 'ms'
                }
            };
            
            setState(CONFIG.status.stateId, JSON.stringify(statusObj), true);
        } catch (e) {
            logWithDetails(`Fehler im Heartbeat: ${e.message}`, 'error');
            stats.errors++;
        }
    }

    /**
     * Prüft die Präsenzsensoren mit Error-Recovery
     */
    function isAnyPresenceActive() {
        let anyActive = false;
        let workingSensors = 0;
        
        CONFIG.sensors.presence.forEach(sensorId => {
            try {
                if (existsState(sensorId)) {
                    const state = getState(sensorId);
                    if (state && state.val === true) {
                        anyActive = true;
                    }
                    workingSensors++;
                } else {
                    stats.errors++;
                }
            } catch (e) {
                logWithDetails(`Fehler beim Lesen von ${sensorId}: ${e.message}`, 'error');
                stats.errors++;
            }
        });
        
        if (workingSensors === 0) {
            if (lastPresenceState === true) {
                logWithDetails('Alle Sensoren ausgefallen - Fail-Safe MODE 1: Licht bleibt an', 'warn');
                return true;
            } else {
                try {
                    const lastKnownState = existsState(CONFIG.actors.target) ? getState(CONFIG.actors.target)?.val : null;
                    if (lastKnownState === true) {
                        logWithDetails('Alle Sensoren ausgefallen - Fail-Safe MODE 2: Licht war an, bleibt an', 'warn');
                        return true;
                    }
                } catch(e) {
                    logWithDetails(`Fehler im Fail-Safe MODE 2: ${e.message}`, 'error');
                }
                return false;
            }
        }
        
        return anyActive;
    }

    /**
     * Prüft Fenster-Logik und Tag/Nacht-Bedingung
     */
    function areConditionsMet() {
        let conditionsOk = true;

        if (CONFIG.settings.nightModeOnly) {
            if (existsState(CONFIG.sensors.nightMode)) {
                const state = getState(CONFIG.sensors.nightMode);
                conditionsOk = conditionsOk && (state ? state.val === true : false);
            } else {
                conditionsOk = false;
            }
        }

        if (CONFIG.settings.windowCheckEnabled) {
            let windowBottomClosed = true;
            if (existsState(CONFIG.sensors.window.bottom)) {
                const state = getState(CONFIG.sensors.window.bottom);
                windowBottomClosed = state ? state.val === CONSTANTS.WINDOW_STATES.BOTTOM_CLOSED : true;
            }
            conditionsOk = conditionsOk && windowBottomClosed;
        }

        return conditionsOk;
    }

    /**
     * Schaltet den Aktor (mit Throttling, Try/Catch & Auto-Recovery)
     */
    function setActorState(shouldBeOn, triggerSource, force = false) {
        const now = Date.now();
        
        const criticalEvents = ['window_open', 'condition_not_met'];
        const isCritical = force || criticalEvents.includes(triggerSource);
        
        if (triggerSource === 'condition_not_met' && !shouldBeOn) {
            stats.windowOpenEvents++;
        }

        if (!isCritical && now - lastSwitchTime < CONSTANTS.MIN_SWITCH_INTERVAL) {
            return false;
        }
        
        const currentActorState = existsState(CONFIG.actors.target) ? getState(CONFIG.actors.target) : null;
        const currentActorVal = currentActorState ? currentActorState.val : null;
        
        if (currentActorVal !== shouldBeOn) {
            try {
                setState(CONFIG.actors.target, shouldBeOn, false);
                lastSwitchTime = now;
                stats.totalSwitches++;
                
                logWithDetails(`Aktor geschaltet`, 'info', {
                    source: triggerSource,
                    newState: shouldBeOn,
                    oldState: currentActorVal,
                    forced: isCritical
                });
                
                if (CONFIG.status.enabled) updateStatusState();
                return true;
            } catch (e) {
                stats.errors++;
                logWithDetails(`FEHLER beim Schalten des Aktors: ${e.message}`, 'error', {
                    target: CONFIG.actors.target,
                    desiredState: shouldBeOn
                });

                // Auto-Recovery bei zu vielen Fehlern
                if (stats.errors > 10 && !errorRecoveryTimer) {
                    logWithDetails('Zu viele Fehler - starte Recovery-Modus', 'warn');
                    
                    if (turnOffTimer) clearTimeout(turnOffTimer);
                    if (windowDebounceTimer) clearTimeout(windowDebounceTimer);
                    
                    errorRecoveryTimer = setTimeout(() => {
                        logWithDetails('Recovery-Versuch: Fehlerzähler zurückgesetzt', 'info');
                        stats.errors = 0; 
                        errorRecoveryTimer = null;
                    }, CONSTANTS.ERROR_RECOVERY_DELAY);
                }
                return false;
            }
        }
        
        return false;
    }

    /**
     * Debouncing für Fenster-Sensoren
     */
    function handleWindowChange(obj) {
        if (windowDebounceTimer) clearTimeout(windowDebounceTimer);
        
        windowDebounceTimer = setTimeout(() => {
            handlePresenceChange(obj);
            windowDebounceTimer = null;
        }, CONSTANTS.WINDOW_DEBOUNCE_TIME);
    }

    /**
     * Hauptlogik mit Zustandsmaschine
     */
    function handlePresenceChange(obj) {
        const responseStart = Date.now();
        const oldState = currentState;
        const conditionMet = areConditionsMet();
        
        const isPresence = (obj && obj.id === 'manual_trigger') ? 
            (obj.state.val === true) : 
            (CONFIG.settings.useMultiSensorLogic ? isAnyPresenceActive() : (obj && obj.state ? obj.state.val === true : false));
        
        const triggerSource = obj ? obj.id : 'unknown';

        if (turnOffTimer) {
            if (conditionMet === false || isPresence === true) {
                clearTimeout(turnOffTimer);
                turnOffTimer = null;
            }
        }

        // Zustandsmaschine
        if (!conditionMet) {
            currentState = CONSTANTS.State.BLOCKED;
            setActorState(false, 'condition_not_met', true);
            lastPresenceState = false;
        } else if (isPresence) {
            currentState = CONSTANTS.State.ON;
            setActorState(true, triggerSource, true);
            lastPresenceState = true;
        } else if (lastPresenceState && CONFIG.settings.delayEnabled && !turnOffTimer) {
            currentState = CONSTANTS.State.DELAYED_OFF;
            turnOffTimer = setTimeout(() => {
                currentState = CONSTANTS.State.OFF;
                setActorState(false, 'timeout');
                lastPresenceState = false;
                turnOffTimer = null;
            }, CONFIG.settings.turnOffDelay);
        } else if (!lastPresenceState && !turnOffTimer) {
            currentState = CONSTANTS.State.OFF;
            setActorState(false, triggerSource);
        }
        
        if (oldState !== currentState) {
            logWithDetails(`Zustandswechsel: ${oldState} -> ${currentState}`, 'info', { trigger: triggerSource });
            if (CONFIG.status.enabled) updateStatusState();
        }

        // Performance-Monitoring am Ende der Funktion
        const responseTime = Date.now() - responseStart;
        stats.lastResponseTimes.push(responseTime);
        if (stats.lastResponseTimes.length > 10) stats.lastResponseTimes.shift();
        stats.avgResponseTime = stats.lastResponseTimes.reduce((a,b) => a+b, 0) / stats.lastResponseTimes.length;
        stats.maxResponseTime = Math.max(stats.maxResponseTime, responseTime);
    }

    /**
     * Initialisierung, Auto-Creation & System-Dump
     */
    function initPresenceControl() {
        logWithDetails('Initialisiere Präsenzsteuerung...', 'info');

        // Zwingende Prüfung auf den Astro-Datenpunkt
        if (!existsState(CONFIG.sensors.nightMode)) {
            logWithDetails(`Eine Astrosteuerung über den Datenpunkt "${CONFIG.sensors.nightMode}" wird benötigt. Datenpunkt nicht vorhanden! Skript wird gestoppt.`, 'warn');
            return;
        }

        if (!validateConfig()) {
            logWithDetails('Konfigurationsprobleme festgestellt - Skript wird trotzdem gestartet', 'warn');
        }

        // 1. Datenpunkte anlegen & Heartbeat starten
        if (CONFIG.status.enabled && CONFIG.status.stateId) {
            safeCreateState(CONFIG.status.stateId, '{}', {
                name: 'Badezimmer Licht - Status',
                type: 'string',
                role: 'json',
                read: true,
                write: false
            });
            
            setTimeout(() => {
                updateStatusState();
                heartbeatInterval = setInterval(() => {
                    try {
                        updateStatusState();
                        const sensorStatus = checkAllSensors();
                        if (!sensorStatus.allOk) {
                            logWithDetails('Sensor-Problem erkannt', 'warn', sensorStatus);
                        }
                    } catch (e) {
                        logWithDetails(`Heartbeat-Fehler: ${e.message}`, 'error');
                        stats.errors++;
                    }
                }, CONFIG.status.updateInterval);
            }, 2000);
        }

        // 2. Manuellen Trigger für Tests aktivieren
        if (CONFIG.testing.enabled && CONFIG.testing.manualTriggerState) {
            safeCreateState(CONFIG.testing.manualTriggerState, false, {
                name: 'Badezimmer Licht - Manueller Test-Trigger',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true
            });
            
            setTimeout(() => {
                if (existsState(CONFIG.testing.manualTriggerState)) {
                    on({ id: CONFIG.testing.manualTriggerState, change: 'any' }, (obj) => {
                        logWithDetails('MANUELLER TRIGGER', 'warn', { value: obj.state.val });
                        handlePresenceChange({ 
                            id: 'manual_trigger', 
                            state: { val: obj.state.val === true || obj.state.val === 'true' } 
                        });
                    });
                }
            }, 2000);
        }

        handlePresenceChange({ id: 'init', state: { val: null } });

        // 3. Sensoren-Trigger einrichten
        CONFIG.sensors.presence.forEach(id => {
            if (existsState(id)) {
                on({ id: id, change: 'ne', ack: true }, handlePresenceChange);
                triggerCount++;
            }
        });
        
        if (CONFIG.settings.windowCheckEnabled) {
            if (existsState(CONFIG.sensors.window.bottom)) {
                on({ id: CONFIG.sensors.window.bottom, change: 'ne', ack: true }, handleWindowChange);
                triggerCount++;
            }
            if (existsState(CONFIG.sensors.window.top)) {
                on({ id: CONFIG.sensors.window.top, change: 'ne', ack: true }, handleWindowChange);
                triggerCount++;
            }
        }
        
        if (CONFIG.settings.nightModeOnly && existsState(CONFIG.sensors.nightMode)) {
            on({ id: CONFIG.sensors.nightMode, change: 'ne', ack: true }, handlePresenceChange);
            triggerCount++;
        }
        
        logWithDetails(`${triggerCount} Sensor-Trigger erfolgreich eingerichtet`, 'info');
    }

    // =============================================================================
    // SKRIPT START & ENDE
    // =============================================================================
    
    initPresenceControl();

    onStop(() => {
        if (turnOffTimer) clearTimeout(turnOffTimer);
        if (windowDebounceTimer) clearTimeout(windowDebounceTimer);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (errorRecoveryTimer) clearTimeout(errorRecoveryTimer);
        logWithDetails('Skript gestoppt. Alle Timer und Intervalle gelöscht.', 'info');
    }, 1000);

})();