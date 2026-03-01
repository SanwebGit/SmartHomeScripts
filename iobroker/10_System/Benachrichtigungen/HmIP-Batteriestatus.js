/*
 * =================================================================================
 * ioBroker Skript: Batterie-Status-Prüfung für Homematic(IP)
 * =================================================================================
 *
 * Autor: Gemini
 * Version: 3.1 (Skript gekapselt)
 * Erstellt am: 19.09.2025
 *
 * Beschreibung:
 * Dieses Skript überwacht alle batteriebetriebenen Homematic(IP)-Geräte, die einer
 * bestimmten Aufzählung (z.B. "Batteriebetrieben") zugeordnet sind. Es prüft
 * zyklisch den Batteriestatus und versendet eine zusammenfassende Benachrichtigung,
 * wenn bei einem oder mehreren Geräten die Batterie schwach ist.
 *
 * Features:
 * - Automatische Erkennung von Geräten mit schwacher Batterie (`LOW_BAT`/`LOWBAT`).
 * - Zusätzliches Auslesen der Betriebsspannung (`OPERATING_VOLTAGE`) für eine
 * detailliertere Analyse.
 * - Bestimmung des benötigten Batterietyps (z.B. AA, AAA) basierend auf dem
 * Gerätemodell.
 * - Versand von Benachrichtigungen über Pushover, Telegram und Gotify.
 * - Konfigurierbarer Zeitplan für die automatische Ausführung.
 * - Saubere und übersichtliche Log-Ausgaben.
 *
 * --- Versionshistorie ---
 * V 1.0 - 1.8: Initialentwicklung und Hinzufügen verschiedener Benachrichtigungsdienste.
 * V 2.0:         Großes Refactoring mit zentraler Konfiguration, Spannungsabfrage
 * und effizienterer Datenverarbeitung.
 * V 2.1:         Entfernung der VIS-Integration zur Vereinfachung.
 * V 2.2:         Einführung eines Log-Präfixes zur besseren Filterung.
 * V 3.0 (Final): Kommentare vollständig überarbeitet, Code-Struktur finalisiert
 * und JSDoc-Dokumentation für bessere Wartbarkeit ergänzt.
 * V 3.1:         Gesamtes Skript in eine IIFE gekapselt, um globale Konflikte zu vermeiden.
 * =================================================================================
 */

(async () => {

    // --- KONFIGURATION ---
    // In diesem Bereich können alle benutzerspezifischen Einstellungen vorgenommen werden.
    const CONFIG = {
        // Name der Aufzählung (Gewerk), der alle batteriebetriebenen Geräte zugeordnet sind.
        // Beispiel: "enum.functions.batterie" oder "enum.functions.battery"
        ENUM_NAME: "enum.functions.batteriebetrieben",

        // Bei 'true' werden detaillierte Informationen im Log ausgegeben, auch wenn keine
        // Batterie schwach ist. Nützlich für die Fehlersuche.
        ENABLE_LOGGING: true,

        // Konfiguration der Benachrichtigungsdienste
        NOTIFICATIONS: {
            // Genereller Schalter: 'true', um Benachrichtigungen zu senden, 'false' zum Deaktivieren.
            SEND: true,

            // Pushover-Adapter-Einstellungen
            PUSHOVER: {
                ENABLED: true,
                INSTANCE: 'pushover.0' // Instanz des Pushover-Adapters
            },

            // Telegram-Adapter-Einstellungen
            TELEGRAM: {
                ENABLED: true,
                INSTANCE: 'telegram.0' // Instanz des Telegram-Adapters
            },

            // Gotify-Adapter-Einstellungen
            GOTIFY: {
                ENABLED: false,
                INSTANCE: 'gotify.0' // Instanz des Gotify-Adapters
            }
        },

        // Mapping von Gerätemodellen zu Batterietypen und deren Minimalspannung.
        // Diese Liste kann bei Bedarf für eigene Geräte erweitert werden.
        // Die Minimalspannung dient als Referenzwert für die `OPERATING_VOLTAGE`.
        BATTERY_TYPES: {
            // AA Batterien
            "HMIP-eTRV-2":   { type: "AA", minVoltage: 2.2 },
            "HmIP-STHD":     { type: "AA", minVoltage: 2.2 },
            "HmIP-SLO":      { type: "AA", minVoltage: 2.2 },
            "HmIP-SPI":      { type: "AA", minVoltage: 2.2 },
            "HmIP-STHO-A":   { type: "AA", minVoltage: 2.2 },
            "HmIP-DSD-PCB":  { type: "AA", minVoltage: 2.2 },
            "HM-ES-TX-WM":   { type: "AA", minVoltage: 2.2 },
            "HmIP-STE2-PCB": { type: "AA", minVoltage: 2.2 },
            // AAA Batterien
            "HmIP-SWDO-I":   { type: "AAA", minVoltage: 2.2 },
            "HmIP-SCI":      { type: "AAA", minVoltage: 2.2 },
            "HmIP-SWDO-PL":  { type: "AAA", minVoltage: 2.2 },
            "HmIP-WKP":      { type: "AAA", minVoltage: 2.2 },
            "HmIP-WRC2":     { type: "AAA", minVoltage: 2.2 }
        }
    };

    // =================================================================================
    // --- SKRIPT-LOGIK (ab hier sind keine Änderungen erforderlich) ---
    // =================================================================================

    const LOG_PREFIX = "[Batterie-Check] ";

    /**
     * Sammelt die Geräte-IDs aller Geräte, bei denen LOW_BAT oder LOWBAT `true` ist
     * und die der konfigurierten Aufzählung angehören.
     * @returns {string[]} Ein Array mit eindeutigen ioBroker-Geräte-IDs.
     */
    function getLowBatteryDeviceIds() {
        // Selektoren für beide gängigen Datenpunktnamen (LOW_BAT und LOWBAT)
        const lowBatSelector = $(`state[id$=.0.LOW_BAT][state.val=true][${CONFIG.ENUM_NAME}]`);
        const lowbatSelector = $(`state[id$=.0.LOWBAT][state.val=true][${CONFIG.ENUM_NAME}]`);
        
        // Beide Selektor-Ergebnisse zusammenführen
        const stateIds = [...new Set([...lowBatSelector, ...lowbatSelector])];
        
        // Von den Datenpunkt-IDs auf die übergeordnete Geräte-ID extrahieren
        // z.B. von "hm-rpc.0.ABC1234567.0.LOW_BAT" zu "hm-rpc.0.ABC1234567"
        const deviceIds = stateIds.map(id => id.split('.').slice(0, 3).join('.'));

        // Sicherstellen, dass jede Geräte-ID nur einmal vorkommt
        return [...new Set(deviceIds)];
    }

    /**
     * Ruft für eine Liste von Geräte-IDs die Detailinformationen (Name, Typ, Spannung) ab.
     * @param {string[]} deviceIds - Ein Array von zu verarbeitenden Geräte-IDs.
     * @returns {Promise<object[]>} Ein Promise, das ein Array von Objekten mit Gerätedetails zurückgibt.
     */
    async function processDevices(deviceIds) {
        // Alle Abfragen parallel ausführen, um Zeit zu sparen
        const devicePromises = deviceIds.map(async (deviceId) => {
            const deviceObject = await getObjectAsync(deviceId);
            if (!deviceObject) return null; // Gerät nicht gefunden, überspringen

            // Spannungswert des Geräts abfragen
            const voltageStateId = `${deviceId}.0.OPERATING_VOLTAGE`;
            const voltageState = await getStateAsync(voltageStateId);
            
            // Batterietyp und Minimalspannung aus der Konfiguration ermitteln
            const deviceType = deviceObject.native.TYPE || '';
            const batteryInfo = CONFIG.BATTERY_TYPES[deviceType] || { type: "Unbekannt", minVoltage: 0 };

            return {
                name: deviceObject.common.name,
                type: batteryInfo.type,
                voltage: voltageState ? voltageState.val : 'N/A', // N/A, falls keine Spannung gelesen werden kann
                minVoltage: batteryInfo.minVoltage
            };
        });

        // Warten, bis alle Abfragen abgeschlossen sind
        const devices = await Promise.all(devicePromises);
        
        // Leere Ergebnisse (falls ein Gerät nicht gefunden wurde) herausfiltern
        return devices.filter(d => d !== null);
    }

    /**
     * Erstellt die finale Nachricht (als reinen Text und als HTML) aus den Gerätedaten.
     * @param {object[]} devices - Eine Liste der Geräte mit schwacher Batterie.
     * @returns {{summaryText: string, summaryHtml: string}} Ein Objekt mit der Text- und HTML-Nachricht.
     */
    function buildMessages(devices) {
        // Fall 1: Keine Geräte gefunden
        if (devices.length === 0) {
            const message = "Keine Geräte mit schwacher Batterie gefunden. Alles in Ordnung.";
            return { summaryText: message, summaryHtml: message };
        }

        // Fall 2: Mindestens ein Gerät gefunden
        const count = devices.length;
        let textList = "";
        let htmlList = "";

        // Liste für die Nachricht zusammenbauen
        devices.forEach((device) => {
            const voltageInfo = device.voltage !== 'N/A' ? `(${device.voltage}V / min ${device.minVoltage}V)` : '';
            textList += `\n- ${device.name} (benötigt ${device.type}) ${voltageInfo}`;
            htmlList += `\n- <b>${device.name}</b> (benötigt ${device.type}) ${voltageInfo}`;
        });

        const summaryText = `Insgesamt ${count} Geräte mit schwacher Batterie gefunden.${textList}`;
        const summaryHtml = `Insgesamt <b>${count}</b> Geräte mit schwacher Batterie gefunden.${htmlList}`;
        
        return { summaryText, summaryHtml };
    }

    /**
     * Sendet die erstellten Nachrichten an alle aktivierten Benachrichtigungsdienste.
     * @param {string} text - Die reine Textnachricht für Dienste, die kein HTML unterstützen (z.B. Gotify).
     * @param {string} html - Die HTML-formatierte Nachricht für Dienste wie Pushover und Telegram.
     */
    function sendAllNotifications(text, html) {
        if (!CONFIG.NOTIFICATIONS.SEND) return;

        const { PUSHOVER, TELEGRAM, GOTIFY } = CONFIG.NOTIFICATIONS;
        const title = 'Batterie-Status-Meldung';

        if (PUSHOVER.ENABLED) {
            // @ts-ignore
            sendTo(PUSHOVER.INSTANCE, { message: html, title: title, html: 1 });
            log(LOG_PREFIX + "INFO: Benachrichtigung an Pushover gesendet.");
        }
        if (TELEGRAM.ENABLED) {
            // @ts-ignore
            sendTo(TELEGRAM.INSTANCE, { text: html, parse_mode: 'HTML' });
            log(LOG_PREFIX + "INFO: Benachrichtigung an Telegram gesendet.");
        }
        if (GOTIFY.ENABLED) {
            // @ts-ignore
            sendTo(GOTIFY.INSTANCE, { message: text, title: title });
            log(LOG_PREFIX + "INFO: Benachrichtigung an Gotify gesendet.");
        }
    }

    /**
     * Hauptfunktion, die den gesamten Prozess steuert.
     */
    async function checkBatteryStatus() {
        log(LOG_PREFIX + `--- Starte Batteriestatus-Prüfung (v3.1) ---`);
        
        const deviceIds = getLowBatteryDeviceIds();
        const devices = await processDevices(deviceIds);
        const { summaryText, summaryHtml } = buildMessages(devices);

        // Log-Ausgabe nur, wenn Logging aktiviert ist oder tatsächlich Geräte gefunden wurden
        if (CONFIG.ENABLE_LOGGING || devices.length > 0) {
            log(LOG_PREFIX + summaryText);
        }
        
        // Benachrichtigungen nur senden, wenn Geräte gefunden wurden
        if (devices.length > 0) {
            sendAllNotifications(summaryText, summaryHtml);
        }
        
        log(LOG_PREFIX + "--- Skriptausführung beendet ---");
    }

    // --- SKRIPTAUSFÜHRUNG ---

    // Das Skript wird einmal direkt bei Start ausgeführt.
    checkBatteryStatus();

    // Anschließend wird es nach dem definierten Zeitplan täglich wiederholt.
    // CRON-Syntax: 'Minute Stunde * * *' -> '30 0 * * *' bedeutet täglich um 00:30 Uhr.
    // @ts-ignore
    schedule('30 0 * * *', checkBatteryStatus);

})();

