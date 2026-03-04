/*
================================================================================
Anwesenheitsskript für ioBroker
================================================================================
 * Author:         Sanweb (Optimiert)
 * Version:        2.5.0 (Performance Edition)
 * Erstellt am:    04.03.2026
 *
 * Beschreibung:
 * Dieses Skript überwacht den Anwesenheitsstatus von mehreren Geräten.
 * Es ist modular, robust und extrem performant dank Batching und Caching.
 *
 * Neue Features in 2.5.0:
 * - Parallele Cache-Befüllung beim Start (massiver Geschwindigkeitsboost)
 * - Gezielte Cache-Invalidierung bei echten Events
 * - Dynamische Batch-Zeit Anpassung bei Update-Stürmen
 * - Defekt-Markierung für fehlerhafte Datenpunkte
================================================================================
*/

(async () => { // Start der Kapselung
    "use strict";
    
    // ============================================================================
    // 1. KONFIGURATION
    // ============================================================================
    const DEBUG = false; // Für detailliertes Logging und Metriken
    const DEBOUNCE_MS = 10000; // Entprellzeit in Millisekunden (gegen WLAN-Flackern)
    const GLOBAL_BATCH_MS = 500; // Basis-Verzögerung für globale Auswertung (Batching)
    const TIMEOUT_MS = 5000; // Timeout für ioBroker Async-Aufrufe
    const MAX_HISTORY_ENTRIES = 10; // Maximale Anzahl an Historien-Einträgen pro Person
    const WATCHDOG_INTERVAL_MS = 3600000; // 1 Stunde: Prüft auf gelöschte Datenpunkte

    // Tragen Sie hier alle zu überwachenden Personen ein. 
    // Nutzen Sie 'devicePaths' (Array) für mehrere Geräte (ODER-verknüpft).
    const devices = [
        {
            name: "Alex",
            devicePaths: ["hm-rega.0.53756"] 
        },
        {
            name: "Rosie",
            devicePaths: ["hm-rega.0.53755"]
        },
        {
            name: "Ramona",
            devicePaths: ["hm-rega.0.53757"]
        }
    ];

    // ============================================================================
    // 2. GLOBALE KONSTANTEN & VARIABLEN
    // ============================================================================
    const BASE_PATH = "0_userdata.0.Anwesenheit.";
    const GLOBAL_STATUS_PATH = BASE_PATH + "Status";
    const GLOBAL_STATUS_TEXT_PATH = BASE_PATH + "StatusGesamt";
    const WARTUNGSMODUS_PATH = BASE_PATH + "Wartungsmodus";
    const STATS_PATH = BASE_PATH + "Statistiken_Updates";

    // Laufzeit-Variablen
    const presenceCache = {};    // Speichert den aktuellen Status pro Person
    const debounceTimers = {};   // Speichert die Timeout-Objekte fürs Geräte-Debouncing
    const clusterCache = {};     // Kurzzeit-Cache für Cluster-Abfragen
    const defectiveStates = new Set(); // Speichert unwiederbringlich defekte Datenpunkte
    
    let globalEvalTimer = null;  // Timer für das Batching der globalen Auswertung
    let lastGlobalStatus = null; // Für optimiertes Logging
    let subscriptions = [];      // Für sauberes Cleanup
    let updateCounter = 0;       // Metrik: Anzahl der Status-Updates gesamt
    let recentUpdates = 0;       // Metrik: Updates in der letzten Minute (für dyn. Batching)
    let watchdogTimer = null;    // Timer für den stündlichen System-Check
    let resetTimer = null;       // Timer für den Reset der recentUpdates

    // ============================================================================
    // 3. HILFSFUNKTIONEN
    // ============================================================================
    function debugLog(message) {
        if (DEBUG) log(`[DEBUG Anwesenheit] ${message}`);
    }

    /**
     * Führt ein Promise mit einem Timeout aus
     */
    async function asyncWithTimeout(promise, timeoutMs = TIMEOUT_MS) {
        let timeoutHandle;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error("Timeout überschritten")), timeoutMs);
        });
        return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutHandle));
    }

    /**
     * Wiederholt fehlgeschlagene ioBroker-Aufrufe mit exponentiellem Backoff
     */
    async function asyncWithRetry(fn, retries = 3, delay = 1000) {
        for (let i = 0; i < retries; i++) {
            try {
                return await asyncWithTimeout(fn());
            } catch (error) {
                if (i === retries - 1) throw error;
                debugLog(`Retry ${i+1}/${retries} nach Fehler: ${error.message}. Warte ${delay * (i + 1)}ms`);
                await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
            }
        }
    }

    /**
     * Robuste Typkonvertierung für Anwesenheitswerte
     */
    function parsePresenceValue(val) {
        if (val === null || val === undefined) return false;
        if (typeof val === 'boolean') return val;
        if (typeof val === 'number') return val > 0;
        if (typeof val === 'string') {
            const lowerVal = String(val).toLowerCase();
            return lowerVal === "true" || lowerVal === "1" || lowerVal === "on" || lowerVal === "online";
        }
        return false;
    }

    /**
     * Konvertiert alte devicePath (String) Konfigurationen zu devicePaths (Array)
     */
    function normalizeConfig() {
        devices.forEach(device => {
            if (device.devicePath && (!device.devicePaths || device.devicePaths.length === 0)) {
                log(`[Info] Konvertiere legacy devicePath für ${device.name} zu devicePaths Array.`, "info");
                device.devicePaths = [device.devicePath];
                delete device.devicePath; // Bereinigen
            }
        });
    }

    /**
     * Validiert die Konfiguration beim Start
     */
    function validateConfig() {
        debugLog("Validiere Konfiguration...");
        if (!devices || devices.length === 0) {
            throw new Error("Konfiguration leer! Es müssen 'devices' definiert werden.");
        }

        const names = new Set();
        for (const device of devices) {
            if (!device.name || !Array.isArray(device.devicePaths) || device.devicePaths.length === 0) {
                throw new Error(`Ungültige Konfiguration für: ${JSON.stringify(device)}`);
            }
            if (names.has(device.name)) {
                throw new Error(`Doppelter Name in Konfiguration gefunden: ${device.name}`);
            }
            names.add(device.name);
        }
        debugLog("Konfiguration erfolgreich validiert.");
    }

    // ============================================================================
    // 4. DATENPUNKTE & WATCHDOG
    // ============================================================================

    /**
     * Erstellt Datenpunkte mit Retry und merkt sich hartnäckige Fehler
     */
    async function safeCreateState(path, def, commonConfig) {
        if (defectiveStates.has(path)) return; // Ignoriere bekannte defekte DP

        try {
            if (!(await asyncWithRetry(() => existsStateAsync(path)))) {
                await asyncWithRetry(() => createStateAsync(path, def, commonConfig));
                debugLog(`Datenpunkt erstellt/wiederhergestellt: ${path}`);
            }
        } catch (e) {
            log(`[Warnung] Konnte Datenpunkt ${path} nach Retries nicht erstellen. Markiere als defekt: ${e.message}`, "warn");
            defectiveStates.add(path); // Fehlertoleranz erhöhen (Punkt 9)
        }
    }

    async function setupDataPoints() {
        debugLog("Prüfe und erstelle Datenpunkte...");

        for (const device of devices) {
            await safeCreateState(`${BASE_PATH}${device.name}`, false, { name: `Anwesenheit ${device.name}`, type: "boolean", role: "indicator.present", read: true, write: false, def: false });
            await safeCreateState(`${BASE_PATH}${device.name}_ZuletztGesehen`, "", { name: `Zuletzt gesehen: ${device.name}`, type: "string", role: "text.date", read: true, write: false, def: "" });
            await safeCreateState(`${BASE_PATH}${device.name}_Historie`, "[]", { name: `Historie: ${device.name}`, type: "string", role: "json", read: true, write: false, def: "[]" });
            await safeCreateState(`${BASE_PATH}${device.name}_Historie_Backup`, "[]", { name: `Historie Backup: ${device.name}`, type: "string", role: "json", read: true, write: false, def: "[]" });
        }

        await safeCreateState(GLOBAL_STATUS_PATH, false, { name: "Anwesenheit globaler Schalter", type: "boolean", role: "indicator.present", read: true, write: false, def: false });
        await safeCreateState(GLOBAL_STATUS_TEXT_PATH, "abwesend", { name: "Anwesenheit globaler Status", type: "string", role: "text", read: true, write: false, def: "abwesend" });
        await safeCreateState(WARTUNGSMODUS_PATH, false, { name: "Wartungsmodus Anwesenheit", type: "boolean", role: "switch", read: true, write: true, def: false });
        await safeCreateState(STATS_PATH, 0, { name: "Anzahl Status-Updates", type: "number", role: "value", read: true, write: false, def: 0 });
    }

    /**
     * Prüft regelmäßig ob Quelldatenpunkte oder eigene Datenpunkte gelöscht wurden (Ressourcen-schonend)
     */
    async function runWatchdog() {
        debugLog("Watchdog-Lauf: Prüfe Systemintegrität...");

        // Cluster-Cache bereinigen (verhindert Altlasten, falls sich Namen ändern)
        const now = Date.now();
        for (const person in clusterCache) {
            if (now - clusterCache[person].lastCheck > 60000) {
                delete clusterCache[person];
            }
        }

        // 1. Eigene Datenpunkte stichprobenartig prüfen
        let needsRestore = false;
        for (const device of devices) {
            const checkPaths = [
                `${BASE_PATH}${device.name}`,
                `${BASE_PATH}${device.name}_ZuletztGesehen`
            ];
            
            for (const path of checkPaths) {
                if (defectiveStates.has(path)) continue; // Defekte überspringen
                try {
                    if (!(await asyncWithRetry(() => existsStateAsync(path), 2, 500))) {
                        needsRestore = true;
                        break;
                    }
                } catch (e) {
                    debugLog(`Watchdog Fehler bei Check von ${path}: ${e.message}`);
                }
            }
            if (needsRestore) break;
        }

        if (needsRestore) {
            log("[Watchdog] Fehlende Ziel-Datenpunkte erkannt. Stelle Struktur wieder her...", "warn");
            await setupDataPoints();
        }

        // 2. Quelldatenpunkte prüfen
        for (const device of devices) {
            for (const path of device.devicePaths) {
                try {
                    const exists = await asyncWithRetry(() => existsStateAsync(path), 2, 500);
                    if (!exists) log(`[Watchdog Warnung] Quelldatenpunkt fehlt: '${path}' für ${device.name}`, "warn");
                } catch (e) {
                    // Ignorieren, um Watchdog nicht abstürzen zu lassen
                }
            }
        }
    }

    /**
     * Aktualisiert die Anwesenheitshistorie inkl. Backup bei Parsing-Fehlern
     */
    async function updateHistory(personName, isPresent, timestamp) {
        const historyPath = `${BASE_PATH}${personName}_Historie`;
        const backupPath = `${BASE_PATH}${personName}_Historie_Backup`;
        
        if (defectiveStates.has(historyPath)) return;

        try {
            let history = [];
            const historyState = await asyncWithRetry(() => getStateAsync(historyPath));
            
            if (historyState && historyState.val) {
                try {
                    history = JSON.parse(historyState.val);
                } catch (e) {
                    debugLog(`Konnte Historie für ${personName} nicht parsen. Erstelle Backup.`);
                    await asyncWithRetry(() => setStateAsync(backupPath, historyState.val, true));
                    history = []; // Neu beginnen
                }
            }

            history.unshift({ status: isPresent ? "anwesend" : "abwesend", zeit: timestamp });

            if (history.length > MAX_HISTORY_ENTRIES) {
                history = history.slice(0, MAX_HISTORY_ENTRIES);
            }

            await asyncWithRetry(() => setStateAsync(historyPath, JSON.stringify(history), true));
        } catch (error) {
            log(`[Hm-Rega] Fehler beim Schreiben der Historie für ${personName}: ${error.message}`, "error");
        }
    }

    // ============================================================================
    // 5. KERNLOGIK (Auswertung & Updates)
    // ============================================================================

    /**
     * Wertet den globalen Status aus (Batched)
     */
    async function evaluateGlobalStatus() {
        const startTime = Date.now();
        try {
            const updatePromises = [];
            let isAnyonePresent = false;
            let wartungsmodus = false;

            try {
                if (!defectiveStates.has(WARTUNGSMODUS_PATH)) {
                    const wartungState = await asyncWithRetry(() => getStateAsync(WARTUNGSMODUS_PATH));
                    if (wartungState && wartungState.val) wartungsmodus = true;
                }
            } catch (e) { debugLog("Fehler beim Lesen des Wartungsmodus."); }

            for (const person in presenceCache) {
                if (presenceCache[person]) {
                    isAnyonePresent = true;
                    break;
                }
            }

            if (!isAnyonePresent && wartungsmodus) {
                debugLog("Wartungsmodus aktiv: Überschreibe Global-Status auf 'anwesend'.");
                isAnyonePresent = true;
            }

            const globalStatusText = isAnyonePresent ? "anwesend" : "abwesend";

            if (lastGlobalStatus !== globalStatusText) {
                if (!defectiveStates.has(GLOBAL_STATUS_PATH)) updatePromises.push(asyncWithRetry(() => setStateAsync(GLOBAL_STATUS_PATH, isAnyonePresent, true)));
                if (!defectiveStates.has(GLOBAL_STATUS_TEXT_PATH)) updatePromises.push(asyncWithRetry(() => setStateAsync(GLOBAL_STATUS_TEXT_PATH, globalStatusText, true)));
                
                log(`[Hm-Rega] Gesamtstatus geändert: '${lastGlobalStatus}' -> '${globalStatusText}'`);
                lastGlobalStatus = globalStatusText;
            }

            if (updatePromises.length > 0) {
                await Promise.all(updatePromises);
            }

        } catch (error) {
            log(`[Hm-Rega] Fehler in evaluateGlobalStatus: ${error.message}`, "error");
        } finally {
            debugLog(`Globale Evaluierung abgeschlossen in ${Date.now() - startTime}ms.`);
        }
    }

    /**
     * Bündelt globale Auswertungen, um Lastspitzen zu vermeiden (Batching)
     * Inklusive dynamischer Anpassung bei Update-Stürmen (Punkt 10)
     */
    function triggerGlobalEvaluation() {
        if (globalEvalTimer) clearTimeout(globalEvalTimer);
        
        let currentBatchMs = GLOBAL_BATCH_MS;
        if (recentUpdates > 20) { // Ab 20 Updates pro Minute drosseln wir
            currentBatchMs = Math.min(2000, GLOBAL_BATCH_MS * 2);
            debugLog(`Hohe Systemlast erkannt (${recentUpdates} Updates/min). Batching auf ${currentBatchMs}ms erhöht.`);
        }

        globalEvalTimer = setTimeout(async () => {
            await evaluateGlobalStatus();
        }, currentBatchMs);
    }

    /**
     * Invalidiert den Cluster-Cache für eine Person bei echten Events (Punkt 6)
     */
    function invalidateClusterCache(personName) {
        if (clusterCache[personName]) {
            clusterCache[personName].lastCheck = 0; // Erzwingt Neuladen beim nächsten Check
            debugLog(`Cluster-Cache invalidiert für ${personName}`);
        }
    }

    /**
     * Prüft alle Geräte einer Person (inkl. 5-Sekunden Performance-Cache für Cluster)
     */
    async function checkPersonClusterStatus(deviceConfig) {
        const cacheKey = deviceConfig.name;
        const now = Date.now();
        
        // Cache nutzen, sofern jünger als 5 Sekunden
        if (clusterCache[cacheKey] && (now - clusterCache[cacheKey].lastCheck < 5000)) {
            return clusterCache[cacheKey].status;
        }

        // Normale Abfrage bei abgelaufenem/invalidiertem Cache
        for (const path of deviceConfig.devicePaths) {
            try {
                const sourceState = await asyncWithRetry(() => getStateAsync(path));
                if (parsePresenceValue(sourceState ? sourceState.val : null)) {
                    clusterCache[cacheKey] = { status: true, lastCheck: now };
                    return true; // Eines online reicht
                }
            } catch (e) {
                debugLog(`Fehler beim Cluster-Check für ${path}: ${e.message}`);
            }
        }
        
        clusterCache[cacheKey] = { status: false, lastCheck: now };
        return false;
    }

    /**
     * Verarbeitet die Statusänderung einer Person sicher
     */
    async function processDeviceChange(device, isPresent) {
        const presencePath = `${BASE_PATH}${device.name}`;
        const lastSeenPath = `${BASE_PATH}${device.name}_ZuletztGesehen`;

        const timestamp = new Date().toLocaleString("de-DE", {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });

        try {
            const updates = [];
            if (!defectiveStates.has(presencePath)) updates.push(asyncWithRetry(() => setStateAsync(presencePath, isPresent, true)));
            
            if (isPresent && !defectiveStates.has(lastSeenPath)) {
                updates.push(asyncWithRetry(() => setStateAsync(lastSeenPath, timestamp, true)));
            }

            // Metriken hochzählen
            updateCounter++;
            recentUpdates++;
            if (!defectiveStates.has(STATS_PATH)) updates.push(asyncWithRetry(() => setStateAsync(STATS_PATH, updateCounter, true)));

            // Warten bis Datenpunkte geschrieben sind
            await Promise.all(updates);
            
            // Erst jetzt Cache updaten
            presenceCache[device.name] = isPresent;
            
            await updateHistory(device.name, isPresent, timestamp);
            debugLog(`${device.name} ist nun ${isPresent ? 'anwesend' : 'abwesend'}.`);
            
            triggerGlobalEvaluation();
        } catch (e) {
            log(`[Hm-Rega] Kritischer Fehler beim Schreiben für ${device.name}: ${e.message}`, "error");
        }
    }

    /**
     * Initiale Datenbefüllung beim Start - Parallelisiert für Performance (Punkt 8)
     */
    async function populateInitialCache() {
        debugLog("Fülle initialen Status-Cache parallel...");
        
        const timestamp = new Date().toLocaleString("de-DE", {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });

        // Alle Personen gleichzeitig verarbeiten anstatt blockierend nacheinander
        await Promise.all(devices.map(async (device) => {
            const isPresent = await checkPersonClusterStatus(device);
            presenceCache[device.name] = isPresent;
            await updateHistory(device.name, isPresent, timestamp);
        }));

        triggerGlobalEvaluation();
    }

    // ============================================================================
    // 6. CLEANUP & SKRIPT-START
    // ============================================================================

    onStop(function (callback) {
        debugLog("Skript wird gestoppt. Bereinige Ressourcen...");
        
        for (const timer in debounceTimers) {
            if (debounceTimers[timer]) clearTimeout(debounceTimers[timer]);
        }
        if (globalEvalTimer) clearTimeout(globalEvalTimer);
        if (watchdogTimer) clearInterval(watchdogTimer);
        if (resetTimer) clearInterval(resetTimer);
        
        // Sauberes Subscription Cleanup (nur valide Funktionen ausführen)
        subscriptions.forEach(sub => {
            try {
                if (sub && typeof sub.unsubscribe === 'function') {
                    sub.unsubscribe();
                }
            } catch (e) {
                debugLog(`Fehler beim Unsubscribe: ${e.message}`);
            }
        });
        
        log("[Hm-Rega] Cleanup erfolgreich beendet.");
        callback();
    });

    try {
        log("[Hm-Rega] Skript wird gestartet (v2.5.0 Performance Edition)...");

        normalizeConfig(); // Abwärtskompatibilität herstellen
        validateConfig();
        await setupDataPoints();
        await populateInitialCache();

        // Metrik-Timer starten (setzt recentUpdates jede Minute zurück)
        resetTimer = setInterval(() => { recentUpdates = 0; }, 60000);

        // 1. Trigger für Wartungsmodus
        const subWartung = on({ id: WARTUNGSMODUS_PATH, change: "ne" }, (obj) => {
            debugLog(`Wartungsmodus geändert auf: ${obj.state.val}`);
            triggerGlobalEvaluation();
        });
        subscriptions.push(subWartung);

        // 2. Trigger für alle Gerätepfade
        const allPaths = [];
        const pathToPersonMap = {};
        
        devices.forEach(d => {
            d.devicePaths.forEach(path => {
                allPaths.push(path);
                pathToPersonMap[path] = d;
            });
        });

        const subDevices = on({ id: allPaths, change: "ne" }, function (obj) {
            const device = pathToPersonMap[obj.id];
            if (!device) return;

            debugLog(`Rohwert-Änderung bei '${obj.id}' erkannt.`);
            
            // Direkte Cache-Invalidierung für dieses Event
            invalidateClusterCache(device.name);

            if (debounceTimers[device.name]) {
                clearTimeout(debounceTimers[device.name]);
            }

            debounceTimers[device.name] = setTimeout(async () => {
                try {
                    // Erneuter Check inkl. Cluster-Logik & Caching
                    const currentVal = await checkPersonClusterStatus(device);
                    
                    if (presenceCache[device.name] !== currentVal) {
                        await processDeviceChange(device, currentVal);
                    }
                } catch (err) {
                    log(`[Hm-Rega] Fehler im Debounce-Timer für ${device.name}: ${err.message}`, "error");
                }
            }, DEBOUNCE_MS);
        });
        subscriptions.push(subDevices);

        // 3. Watchdog Timer aktivieren
        watchdogTimer = setInterval(runWatchdog, WATCHDOG_INTERVAL_MS);

        log(`[Hm-Rega] Überwachung gestartet für: ${devices.map(d => d.name).join(', ')}.`);

    } catch (error) {
        log(`[Hm-Rega] Kritischer Fehler beim Skript-Start. Skript abgebrochen: ${error.message}`, "error");
    }

})(); // Ende der Kapselung