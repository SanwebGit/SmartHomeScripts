/*
================================================================================
Anwesenheitsskript für ioBroker
================================================================================
 * Author:         Sanweb
 * Version:        3.0.1 (Masterpiece - Syntax Fix)
 * Erstellt am:    04.03.2026
 *
 * Beschreibung:
 * Dieses Skript überwacht den Anwesenheitsstatus von mehreren Geräten.
 * Es ist modular, robust und extrem performant dank Batching und Caching.
 *
 * ===========================================================================
 * DYNAMISCHE KONFIGURATION (für Administratoren)
 * ===========================================================================
 * * Sie können zusätzliche Geräte über einen Datenpunkt hinzufügen, ohne das
 * Skript bearbeiten zu müssen. Das Skript erkennt Änderungen sofort!
 * * Datenpunkt: 0_userdata.0.Anwesenheit.Config.devices
 * Typ: JSON-String
 * * Beispiel für JSON-Inhalt:
 * [
 * {
 * "name": "Besucher",
 * "devicePaths": ["tr-064.0.devices.gast-handy.active"]
 * },
 * {
 * "name": "Putzkraft",
 * "devicePaths": ["hm-rega.0.53758", "ble.0.tag-putzkraft"]
 * }
 * ]
 * * Wichtig: Die Namen müssen eindeutig sein (keine Duplikate mit statischen!)
 * ===========================================================================
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
    const MAX_WINDOW_MS = 60000; // 1 Minute Fenster für die Update-Metriken

    /**
     * @typedef {Object} DeviceConfig
     * @property {string} name - Name der Person
     * @property {string[]} [devicePaths] - Array der zu überwachenden ioBroker-Datenpunkte (ODER-verknüpft)
     * @property {string} [devicePath] - Veraltet: Einzelner Datenpunkt (für Abwärtskompatibilität)
     */

    /** @type {DeviceConfig[]} */
    let devices = [ // 'let' statt 'const' für dynamische Reloads
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
    const DYNAMIC_CONFIG_PATH = BASE_PATH + "Config.devices"; // Für externe JSON Config

    // Laufzeit-Variablen
    const presenceCache = {};    // Speichert den aktuellen Status pro Person
    const debounceTimers = {};   // Speichert die Timeout-Objekte fürs Geräte-Debouncing
    const clusterCache = {};     // Kurzzeit-Cache für Cluster-Abfragen
    const defectiveStates = new Set(); // Speichert unwiederbringlich defekte Datenpunkte
    const updateTimestamps = []; // Rolling Window Array für Metriken
    
    let globalEvalTimer = null;  // Timer für das Batching der globalen Auswertung
    let lastGlobalStatus = null; // Für optimiertes Logging
    let subscriptions = [];      // Für sauberes Cleanup allgemeiner Trigger
    let deviceSubscription = null; // Spezieller Trigger für Geräte (wird bei Reload erneuert)
    
    let updateCounter = 0;       // Metrik: Anzahl der Status-Updates gesamt
    let watchdogTimer = null;    // Timer für den stündlichen System-Check
    let watchdogOffset = 0;      // Offset für deterministisch rotierende Stichproben
    let staticDeviceCount = 0;   // Merkt sich die Anzahl der fest codierten Geräte

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
                delete device.devicePath; 
            }
        });
    }

    /**
     * Lädt optionale zusätzliche Gerätekonfigurationen aus einem Datenpunkt
     */
    async function loadDynamicConfig() {
        debugLog("Prüfe auf dynamische Konfiguration...");
        try {
            if (!(await asyncWithRetry(() => existsStateAsync(DYNAMIC_CONFIG_PATH)))) {
                await asyncWithRetry(() => createStateAsync(DYNAMIC_CONFIG_PATH, "[]", {
                    name: "Dynamische Geräte-Konfiguration (JSON)",
                    type: "string", role: "json", read: true, write: true, def: "[]"
                }));
                debugLog("Leerer dynamischer Konfigurations-Datenpunkt erstellt.");
            }

            const configState = await asyncWithRetry(() => getStateAsync(DYNAMIC_CONFIG_PATH));
            if (configState && configState.val && configState.val !== "[]") {
                try {
                    const configDevices = JSON.parse(configState.val);
                    if (Array.isArray(configDevices) && configDevices.length > 0) {
                        debugLog(`${configDevices.length} Geräte aus dynamischer Konfiguration geladen.`);
                        
                        configDevices.forEach(device => {
                            if (device.devicePath && (!device.devicePaths || device.devicePaths.length === 0)) {
                                device.devicePaths = [device.devicePath];
                                delete device.devicePath;
                            }
                        });
                        
                        devices.push(...configDevices);
                    }
                } catch (e) {
                    log(`[Warnung] Dynamische Konfiguration konnte nicht geparst werden: ${e.message}`, "warn");
                }
            }
        } catch (e) {
            debugLog(`Fehler beim Laden der dynamischen Konfiguration: ${e.message}`);
        }
    }

    /**
     * Validiert die Konfiguration und prüft auf Duplikate
     */
    function validateConfig() {
        debugLog("Validiere finale Konfiguration...");
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

    /**
     * Bereinigt alte Einträge und gibt die Anzahl der Updates der letzten Minute zurück
     */
    function getRecentUpdateCount() {
        const now = Date.now();
        while (updateTimestamps.length > 0 && now - updateTimestamps[0] > MAX_WINDOW_MS) {
            updateTimestamps.shift();
        }
        return updateTimestamps.length;
    }

    /**
     * Fügt einen neuen Update-Zeitstempel hinzu (Rolling Window mit OOM-Schutz)
     */
    function recordUpdate() {
        updateTimestamps.push(Date.now());
        if (updateTimestamps.length > 1000) {
            updateTimestamps.splice(0, 500); 
        }
        return getRecentUpdateCount();
    }

    // ============================================================================
    // 4. DATENPUNKTE & WATCHDOG
    // ============================================================================

    /**
     * Erstellt Datenpunkte mit Retry und merkt sich hartnäckige Fehler
     */
    async function safeCreateState(path, def, commonConfig) {
        if (defectiveStates.has(path)) return; 

        try {
            if (!(await asyncWithRetry(() => existsStateAsync(path)))) {
                await asyncWithRetry(() => createStateAsync(path, def, commonConfig));
                debugLog(`Datenpunkt erstellt/wiederhergestellt: ${path}`);
            }
        } catch (e) {
            log(`[Warnung] Konnte Datenpunkt ${path} nach Retries nicht erstellen. Markiere als defekt: ${e.message}`, "warn");
            defectiveStates.add(path); 
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
     * Prüft, ob defekte Datenpunkte wieder verfügbar sind
     */
    async function revalidateDefectiveStates() {
        if (defectiveStates.size === 0) return;
        debugLog("Revalidiere defekte Datenpunkte...");
        
        const toRevalidate = Array.from(defectiveStates);
        for (const path of toRevalidate) {
            try {
                if (await asyncWithTimeout(existsStateAsync(path), 2000)) {
                    defectiveStates.delete(path);
                    debugLog(`Defekter Datenpunkt ${path} wurde revalidiert und ist wieder verfügbar.`);
                }
            } catch (e) {
                // Bleibt weiterhin als defekt markiert
            }
        }
    }

    /**
     * Prüft regelmäßig ob Quelldatenpunkte oder eigene Datenpunkte gelöscht wurden
     */
    async function runWatchdog() {
        debugLog("Watchdog-Lauf: Prüfe Systemintegrität...");

        getRecentUpdateCount(); 
        await revalidateDefectiveStates(); 

        const now = Date.now();
        for (const person in clusterCache) {
            if (now - clusterCache[person].lastCheck > 60000) {
                delete clusterCache[person];
            }
        }

        // Deterministisch rotierende Stichprobe (ca. 20%) prüfen
        const sampleSize = Math.max(1, Math.floor(devices.length * 0.2));
        const sampledDevices = [];
        for (let i = 0; i < sampleSize; i++) {
            sampledDevices.push(devices[(watchdogOffset + i) % devices.length]);
        }
        watchdogOffset = (watchdogOffset + sampleSize) % devices.length;

        // 1. Eigene Datenpunkte stichprobenartig prüfen
        let needsRestore = false;
        for (const device of sampledDevices) {
            const checkPaths = [
                `${BASE_PATH}${device.name}`,
                `${BASE_PATH}${device.name}_ZuletztGesehen`
            ];
            
            for (const path of checkPaths) {
                if (defectiveStates.has(path)) continue; 
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

        // 2. Quelldatenpunkte prüfen (ebenfalls rotierende Stichprobe)
        for (const device of sampledDevices) {
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
                    history = []; 
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
                const results = await Promise.allSettled(updatePromises);
                const failed = results.filter(r => r.status === 'rejected');
                if (failed.length > 0) debugLog(`${failed.length} globale Status-Updates fehlgeschlagen.`);
            }

        } catch (error) {
            log(`[Hm-Rega] Fehler in evaluateGlobalStatus: ${error.message}`, "error");
        } finally {
            debugLog(`Globale Evaluierung abgeschlossen in ${Date.now() - startTime}ms.`);
        }
    }

    /**
     * Bündelt globale Auswertungen, um Lastspitzen zu vermeiden (Batching)
     */
    function triggerGlobalEvaluation() {
        if (globalEvalTimer) clearTimeout(globalEvalTimer);
        
        let currentBatchMs = GLOBAL_BATCH_MS;
        const recent = getRecentUpdateCount();
        
        if (recent > 20) { 
            currentBatchMs = Math.min(2000, GLOBAL_BATCH_MS * 2);
            debugLog(`Hohe Systemlast erkannt (${recent} Updates/min). Batching auf ${currentBatchMs}ms erhöht.`);
        }

        globalEvalTimer = setTimeout(async () => {
            await evaluateGlobalStatus();
        }, currentBatchMs);
    }

    /**
     * Prüft alle Geräte einer Person. Parameter forceRefresh umgeht den Cache bei Events.
     */
    async function checkPersonClusterStatus(deviceConfig, forceRefresh = false) {
        const cacheKey = deviceConfig.name;
        const now = Date.now();
        
        if (!forceRefresh && clusterCache[cacheKey] && (now - clusterCache[cacheKey].lastCheck < 5000)) {
            return clusterCache[cacheKey].status;
        }

        for (const path of deviceConfig.devicePaths) {
            try {
                const sourceState = await asyncWithRetry(() => getStateAsync(path));
                if (parsePresenceValue(sourceState ? sourceState.val : null)) {
                    clusterCache[cacheKey] = { status: true, lastCheck: now };
                    return true; 
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

            updateCounter++;
            recordUpdate(); 
            if (!defectiveStates.has(STATS_PATH)) updates.push(asyncWithRetry(() => setStateAsync(STATS_PATH, updateCounter, true)));

            const results = await Promise.allSettled(updates);
            const failed = results.filter(r => r.status === 'rejected');
            
            if (failed.length > 0) {
                log(`[Hm-Rega] ${failed.length} ioBroker Updates für ${device.name} fehlgeschlagen. Cache wird sicherheitshalber nicht aktualisiert.`, "warn");
                return; 
            }
            
            presenceCache[device.name] = isPresent;
            
            await updateHistory(device.name, isPresent, timestamp);
            debugLog(`${device.name} ist nun ${isPresent ? 'anwesend' : 'abwesend'}.`);
            
            triggerGlobalEvaluation();
        } catch (e) {
            log(`[Hm-Rega] Kritischer Fehler beim Schreiben für ${device.name}: ${e.message}`, "error");
        }
    }

    /**
     * Initiale Datenbefüllung beim Start - Parallelisiert für Performance
     */
    async function populateInitialCache() {
        debugLog("Fülle initialen Status-Cache parallel...");
        
        const timestamp = new Date().toLocaleString("de-DE", {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });

        await Promise.allSettled(devices.map(async (device) => {
            const isPresent = await checkPersonClusterStatus(device, true);
            presenceCache[device.name] = isPresent;
            await updateHistory(device.name, isPresent, timestamp);
        }));

        triggerGlobalEvaluation();
    }

    // ============================================================================
    // 6. INITIALISIERUNG & DYNAMISCHER RELOAD
    // ============================================================================

    /**
     * Initialisiert alle Geräte-Trigger. Wird auch beim dynamischen Reload aufgerufen.
     */
    function setupDeviceSubscriptions() {
        // Alten Trigger sauber beenden, falls vorhanden
        if (deviceSubscription && typeof deviceSubscription.unsubscribe === 'function') {
            deviceSubscription.unsubscribe();
        }

        const allPaths = [];
        const pathToPersonMap = {};
        
        devices.forEach(d => {
            if (d.devicePaths) {
                d.devicePaths.forEach(path => {
                    allPaths.push(path);
                    pathToPersonMap[path] = d;
                });
            }
        });

        deviceSubscription = on({ id: allPaths, change: "ne" }, function (obj) {
            const device = pathToPersonMap[obj.id];
            if (!device) return;

            debugLog(`Rohwert-Änderung bei '${obj.id}' erkannt.`);

            if (debounceTimers[device.name]) {
                clearTimeout(debounceTimers[device.name]);
            }

            debounceTimers[device.name] = setTimeout(async () => {
                try {
                    const currentVal = await checkPersonClusterStatus(device, true);
                    
                    if (presenceCache[device.name] !== currentVal) {
                        await processDeviceChange(device, currentVal);
                    }
                } catch (err) {
                    log(`[Hm-Rega] Fehler im Debounce-Timer für ${device.name}: ${err.message}`, "error");
                }
            }, DEBOUNCE_MS);
        });
    }

    /**
     * Führt den kompletten Setup-Prozess durch (beim Start und bei Config-Änderungen)
     */
    async function bootSystem() {
        try {
            // Statische Geräte wiederherstellen (dynamische entfernen)
            devices.splice(staticDeviceCount); 
            
            normalizeConfig(); 
            await loadDynamicConfig(); 
            validateConfig();
            
            await setupDataPoints();
            await populateInitialCache();
            setupDeviceSubscriptions();
        } catch (e) {
            log(`[Hm-Rega] Fehler während des System-Starts/Reloads: ${e.message}`, "error");
        }
    }


    // ============================================================================
    // 7. CLEANUP & SKRIPT-START
    // ============================================================================

    onStop(function (callback) {
        debugLog("Skript wird gestoppt. Bereinige Ressourcen...");
        
        for (const timer in debounceTimers) {
            if (debounceTimers[timer]) clearTimeout(debounceTimers[timer]);
        }
        if (globalEvalTimer) clearTimeout(globalEvalTimer);
        if (watchdogTimer) clearInterval(watchdogTimer);
        updateTimestamps.length = 0; 
        
        subscriptions.forEach(sub => {
            try {
                if (sub && typeof sub.unsubscribe === 'function') {
                    sub.unsubscribe();
                }
            } catch (e) {
                debugLog(`Fehler beim Unsubscribe: ${e.message}`);
            }
        });

        if (deviceSubscription && typeof deviceSubscription.unsubscribe === 'function') {
            deviceSubscription.unsubscribe();
        }
        
        log("[Hm-Rega] Cleanup erfolgreich beendet.");
        callback();
    });

    try {
        log("[Hm-Rega] Skript wird gestartet (v3.0.1 Masterpiece - Syntax Fix)...");

        // Merke die Anzahl der statisch im Code hinterlegten Geräte
        staticDeviceCount = devices.length;

        // Führe initialen Start aus
        await bootSystem();

        // 1. Trigger für Wartungsmodus
        const subWartung = on({ id: WARTUNGSMODUS_PATH, change: "ne" }, (obj) => {
            debugLog(`Wartungsmodus geändert auf: ${obj.state.val}`);
            triggerGlobalEvaluation();
        });
        subscriptions.push(subWartung);

        // 2. Trigger für dynamische Konfigurations-Updates (Live-Reload)
        const subConfig = on({ id: DYNAMIC_CONFIG_PATH, change: "ne" }, async () => {
            log("[Hm-Rega] Änderung der dynamischen Konfiguration erkannt. Lade System live neu...", "info");
            await bootSystem();
        });
        subscriptions.push(subConfig);

        // 3. Watchdog Timer aktivieren
        watchdogTimer = setInterval(runWatchdog, WATCHDOG_INTERVAL_MS);

        log(`[Hm-Rega] System erfolgreich initialisiert. Überwache ${devices.length} Personen.`);

    } catch (error) {
        log(`[Hm-Rega] Kritischer Fehler beim Skript-Start. Skript abgebrochen: ${error.message}`, "error");
    }

})(); // Ende der Kapselung