/**
 * =================================================================================
 * ioBroker Skript: Batterie-Status-Prüfung für Homematic(IP) (Enterprise Plus)
 * =================================================================================
 *
 * Version: 6.3
 * Letztes Update: 04.03.2026
 *
 * Änderungen in V6.3:
 * - Fix: 'getIsMemberAsync' entfernt (keine Standard-Funktion).
 * - Optimierung: Nutzt nun die 'common.members' der Enum zur Identifizierung der Geräte.
 * - Performance: Gezielte Suche nach LOWBAT-States nur innerhalb der Enum-Mitglieder.
 * =================================================================================
 */

(async () => {
    // --- KONFIGURATION ---
    const CONFIG = {
        ENUM_NAME: "enum.functions.batteriebetrieben",
        SCHEDULE: "30 0 * * *",                        
        NOTIFY_EVERY_H: 24,                            
        
        ENABLE_LOGGING: true,
        LOG_LEVEL: "info",                             // "info" oder "debug"
        ASYNC_TIMEOUT: 5000,                           // Globaler Timeout für async Calls
        CACHE_TTL_MS: 3600000,                         // Cache-Gültigkeit: 1 Stunde

        STATE_BASE_PATH: "0_userdata.0.System.Batterien.batterie_check.",

        NOTIFICATIONS: {
            SEND: true,
            PUSHOVER: { ENABLED: true, INSTANCE: 'pushover.0' },
            TELEGRAM: { ENABLED: true, INSTANCE: 'telegram.0' },
            GOTIFY: { ENABLED: false, INSTANCE: 'gotify.0' }
        },

        // Zuordnung der Batterietypen zur Information in der Nachricht
        BATTERY_TYPES: {
            "HMIP-eTRV-2":   { type: "AA" },
            "HmIP-STHD":     { type: "AA" },
            "HmIP-SWDO-I":   { type: "AAA" },
            "HmIP-WRC2":     { type: "AAA" },
            "HmIP-SWDO":     { type: "AAA" },
            "HmIP-SMI":      { type: "AA" },
            "HmIP-SMO":      { type: "AA" }
        }
    };

    const LOG_PREFIX = "[Batterie-Check] ";
    
    const deviceCache = new Map();
    const notificationCache = new Map();

    /**
     * Zentrales Logging
     */
    function logMsg(msg, level = "info") {
        if (level === "debug" && CONFIG.LOG_LEVEL !== "debug") return;
        const formattedMsg = LOG_PREFIX + (level === "debug" ? "DEBUG: " : "") + msg;
        if (level === "error") log(formattedMsg, "error");
        else if (level === "warn") log(formattedMsg, "warn");
        else log(formattedMsg, "info");
    }

    /**
     * Hilfsfunktion für asynchrone Aufrufe mit Timeout
     */
    async function withTimeout(promise, context = "Async Call") {
        let timeoutHandle;
        const timeoutPromise = new Promise((_, reject) => 
            timeoutHandle = setTimeout(() => reject(new Error(`Timeout (${CONFIG.ASYNC_TIMEOUT}ms): ${context}`)), CONFIG.ASYNC_TIMEOUT)
        );
        return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutHandle));
    }

    /**
     * Sicherer JSON-Parser
     */
    function safeJsonParse(str, fallback = {}) {
        try {
            return str ? JSON.parse(str) : fallback;
        } catch (e) {
            logMsg(`Fehler beim Parsen von JSON: ${e.message}. Nutze Fallback.`, "warn");
            return fallback;
        }
    }

    /**
     * Bereinigt veraltete Einträge aus dem Device-Cache
     */
    function performCacheHousekeeping() {
        const now = Date.now();
        let count = 0;
        for (const [key, val] of deviceCache.entries()) {
            if (now - val.ts > CONFIG.CACHE_TTL_MS) {
                deviceCache.delete(key);
                count++;
            }
        }
        if (count > 0) logMsg(`Cache bereinigt: ${count} veraltete Einträge entfernt.`, "debug");
    }

    /**
     * Caching-Logik für Objekte
     */
    async function getCachedObject(id) {
        const cached = deviceCache.get(id);
        if (cached && (Date.now() - cached.ts < CONFIG.CACHE_TTL_MS)) {
            return cached.obj;
        }
        const obj = await withTimeout(getObjectAsync(id), `getObject(${id})`);
        deviceCache.set(id, { obj, ts: Date.now() });
        return obj;
    }

    /**
     * Validiert die Konfiguration beim Start
     */
    async function validateConfig() {
        if (!CONFIG.ENUM_NAME) throw new Error("ENUM_NAME ist nicht definiert.");
        if (!CONFIG.STATE_BASE_PATH.endsWith('.')) CONFIG.STATE_BASE_PATH += '.';

        const enumObj = await getObjectAsync(CONFIG.ENUM_NAME);
        if (!enumObj) throw new Error(`Enum '${CONFIG.ENUM_NAME}' existiert nicht.`);

        if (CONFIG.NOTIFICATIONS.SEND) {
            for (const [key, service] of Object.entries(CONFIG.NOTIFICATIONS)) {
                if (typeof service === 'object' && service.ENABLED) {
                    const inst = await getObjectAsync(`system.adapter.${service.INSTANCE}`);
                    if (!inst) logMsg(`Instanz ${service.INSTANCE} (${key}) nicht gefunden!`, "error");
                }
            }
        }
    }

    /**
     * Initialisierung der States
     */
    async function init() {
        logMsg("Initialisiere System (V6.3)...", "debug");
        await validateConfig();

        await createStateAsync(CONFIG.STATE_BASE_PATH + "lastCheck", { name: "Letzter Check", type: "string", role: "date", read: true, write: false });
        await createStateAsync(CONFIG.STATE_BASE_PATH + "lowCount", { name: "Anzahl schwache Batterien", type: "number", role: "value", read: true, write: false, def: 0 });
        await createStateAsync(CONFIG.STATE_BASE_PATH + "jsonList", { name: "Geräteliste JSON", type: "string", role: "json", read: true, write: false });
        await createStateAsync(CONFIG.STATE_BASE_PATH + "lastNotifications", { name: "Benachrichtigungs-Historie", type: "string", role: "json", read: true, write: true, def: "{}" });

        const hist = await getStateAsync(CONFIG.STATE_BASE_PATH + "lastNotifications");
        const data = safeJsonParse(hist ? hist.val : "{}");
        Object.keys(data).forEach(k => notificationCache.set(k, data[k]));
    }

    /**
     * Sendet Benachrichtigungen über einen sicheren Wrapper mit Callback-Handling
     */
    async function sendNotification(service, instance, payload) {
        try {
            await withTimeout(new Promise((resolve) => {
                const callbackTimer = setTimeout(() => {
                    logMsg(`Callback-Timeout für ${service}, fahre fort...`, "debug");
                    resolve(); 
                }, 2000); 
                        
                sendTo(instance, payload, (res) => {
                    clearTimeout(callbackTimer);
                    resolve(res);
                });
            }), `sendTo(${instance})`);
        } catch (e) {
            logMsg(`Fehler beim Senden über ${service} (${instance}): ${e.message}`, "error");
        }
    }

    /**
     * Findet alle LOWBAT-States der Enum-Mitglieder
     */
    async function getProblematicDevices() {
        const enumObj = await getCachedObject(CONFIG.ENUM_NAME);
        if (!enumObj || !enumObj.common || !enumObj.common.members) {
            logMsg("Enum hat keine Mitglieder oder wurde nicht gefunden.", "warn");
            return [];
        }

        const members = enumObj.common.members;
        const resultIds = [];

        // Wir prüfen für jedes Mitglied der Enum, ob es (oder ein Unter-State) ein Batterieproblem hat
        await Promise.all(members.map(async (memberId) => {
            try {
                // Suche LOWBAT/LOW_BAT Zustände, die dem Mitglied zugeordnet sind
                const batteryStates = $(`state[id=${memberId}.LOWBAT], state[id=${memberId}.*.LOWBAT], state[id=${memberId}.LOW_BAT], state[id=${memberId}.*.LOW_BAT]`);
                
                for (const stateId of batteryStates) {
                    const state = await getStateAsync(stateId);
                    if (state && state.val === true) {
                        // Wir kürzen auf die Geräte-ID (erste 3 Segmente)
                        resultIds.push(stateId.split('.').slice(0, 3).join('.'));
                    }
                }
            } catch (e) {
                logMsg(`Fehler bei Prüfung von Mitglied ${memberId}: ${e.message}`, "debug");
            }
        }));

        return [...new Set(resultIds)];
    }

    /**
     * Verarbeitet Gerätedetails
     */
    async function processDevice(deviceId) {
        try {
            const obj = await getCachedObject(deviceId);
            if (!obj) return null;

            const model = obj.native.TYPE || obj.common.role || "Unbekannt";
            const batteryInfo = CONFIG.BATTERY_TYPES[model] || { type: "Unbekannt" };
            
            let voltage = "N/A";
            try {
                const vStates = await withTimeout($(`state[id=${deviceId}.*.OPERATING_VOLTAGE]`), `findVoltage(${deviceId})`);
                if (vStates && vStates.length > 0) {
                    const vVal = await getStateAsync(vStates[0]);
                    if (vVal) voltage = vVal.val;
                }
            } catch (vErr) {
                logMsg(`Konnte Spannung für ${deviceId} nicht ermitteln.`, "debug");
            }

            return { id: deviceId, name: obj.common.name || deviceId, model, battery: batteryInfo.type, voltage };
        } catch (e) {
            logMsg(`Fehler bei Verarbeitung von ${deviceId}: ${e.message}`, "error");
            return null;
        }
    }

    /**
     * Hauptprozess
     */
    async function checkBatteryStatus() {
        const startTime = Date.now();
        logMsg("Batteriestatus-Prüfung gestartet.");
        
        performCacheHousekeeping();

        try {
            const deviceIds = await getProblematicDevices();

            if (deviceIds.length === 0) {
                await setStateAsync(CONFIG.STATE_BASE_PATH + "lowCount", 0, true);
                await setStateAsync(CONFIG.STATE_BASE_PATH + "jsonList", "[]", true);
                logMsg("Keine kritischen Batteriestände gefunden.");
            } else {
                const results = (await Promise.all(deviceIds.map(id => processDevice(id)))).filter(r => r !== null);

                const now = Date.now();
                const toNotify = results.filter(d => {
                    const last = notificationCache.get(d.id) || 0;
                    return (now - last) > (CONFIG.NOTIFY_EVERY_H * 3600000);
                });

                if (toNotify.length > 0) {
                    let textMsg = `Batterie-Warnung: ${toNotify.length} Geräte melden niedrigen Stand.`;
                    let htmlMsg = `<b>Batterie-Warnung!</b><ul>`;
                    
                    toNotify.forEach(d => {
                        const vInfo = d.voltage !== "N/A" ? ` (Aktuell: ${d.voltage}V)` : "";
                        textMsg += `\n- ${d.name} (${d.model}): Typ ${d.battery}${vInfo}`;
                        htmlMsg += `<li><b>${d.name}</b> (${d.model}): Typ ${d.battery}${vInfo}</li>`;
                        notificationCache.set(d.id, now);
                    });
                    htmlMsg += "</ul>";

                    if (CONFIG.NOTIFICATIONS.SEND) {
                        const { PUSHOVER, TELEGRAM, GOTIFY } = CONFIG.NOTIFICATIONS;
                        if (PUSHOVER.ENABLED) await sendNotification("Pushover", PUSHOVER.INSTANCE, { message: htmlMsg, html: 1, title: "Batterie Check" });
                        if (TELEGRAM.ENABLED) await sendNotification("Telegram", TELEGRAM.INSTANCE, { text: htmlMsg, parse_mode: 'HTML' });
                        if (GOTIFY.ENABLED)   await sendNotification("Gotify", GOTIFY.INSTANCE, { message: textMsg, title: "Batterie Check" });
                    }
                    
                    const histObj = {};
                    notificationCache.forEach((val, key) => histObj[key] = val);
                    await setStateAsync(CONFIG.STATE_BASE_PATH + "lastNotifications", JSON.stringify(histObj), true);
                }

                await setStateAsync(CONFIG.STATE_BASE_PATH + "lowCount", results.length, true);
                await setStateAsync(CONFIG.STATE_BASE_PATH + "jsonList", JSON.stringify(results), true);
                logMsg(`Check beendet. ${results.length} Geräte betroffen.`);
            }

            await setStateAsync(CONFIG.STATE_BASE_PATH + "lastCheck", new Date().toISOString(), true);

        } catch (err) {
            logMsg("KRITISCHER FEHLER: " + err.message, "error");
        } finally {
            logMsg(`Ausführungsdauer: ${(Date.now() - startTime) / 1000}s`, "debug");
        }
    }

    // --- START ---
    try {
        await init();
        await checkBatteryStatus();

        if (CONFIG.SCHEDULE) {
            schedule(CONFIG.SCHEDULE, async () => {
                await checkBatteryStatus();
            });
            logMsg(`Zeitplan aktiv: ${CONFIG.SCHEDULE}`, "debug");
        }
    } catch (e) {
        logMsg("Initialisierungsfehler: " + e.message, "error");
    }
})();