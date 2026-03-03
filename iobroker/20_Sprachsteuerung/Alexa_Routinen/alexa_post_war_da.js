/**
 * @file      Briefkasten Benachrichtigungs- und Ansagesystem
 * @version   1.1.0
 * @author    Sanweb
 * @description Überwacht den Briefkasten, sendet eine Telegram-Nachricht und
 * informiert die Bewohner beim Betreten der Wohnung/Haus über Alexa.
 * * Changelog:
 * - 1.1.0: Gotify durch Telegram ersetzt, IIFE Kapselung hinzugefügt
 * - 1.0.0: Initial release
 */

(function() {
    "use strict";

// ==========================================
// 1. KONFIGURATION
// ==========================================
const CONFIG = {
    sensors: {
        mailbox: 'hm-rpc.0.001E1D899E942E.1.STATE', // Sensor Briefkasten
        door: 'hm-rpc.0.0023DA49A3AFF8.1.STATE'     // Sensor Haustür / Bewegungsmelder
    },
    states: {
        mailArrived: '0_userdata.0.briefkasten.post_war_da',
        inhabitantsInformed: '0_userdata.0.briefkasten.bewohner_informiert',
        notificationText: '0_userdata.0.Gemini.Notification.Briefkasten'
    },
    alexa: {
        speak: 'alexa2.0.Echo-Devices.G0911M10020400F5.Commands.speak',
        volume: 'alexa2.0.Echo-Devices.G0911M10020400F5.Commands.speak-volume',
        announceVolume: 30,          // Gewünschte Lautstärke für die Ansage
        restoreDelayMs: 10000        // Zeit in ms, bevor alte Lautstärke wiederhergestellt wird
    },
    telegram: {
        instance: 'telegram.0'
    },
    debounceMs: 60000 // Entprellzeit für den Briefkasten (1 Minute)
};

// ==========================================
// 2. INTERNE VARIABLEN
// ==========================================
let timeoutMailbox = null;
let timeoutAlexaVolume = null;

// ==========================================
// 3. HAUPT-LOGIK
// ==========================================

/**
 * Sendet eine Nachricht über Telegram
 * @param {string} text - Der zu sendende Text
 */
function sendTelegramNotification(text) {
    sendTo(CONFIG.telegram.instance, 'send', {
        text: text
    });
    log(`Telegram Nachricht versendet: ${text}`, 'info');
}

/**
 * Initialisiert alle Trigger und Zeitpläne
 */
function init() {
    log('Briefkasten-Script gestartet.', 'info');

    // --------------------------------------------------------
    // TRIGGER 1: Briefkasten wird geöffnet
    // --------------------------------------------------------
    on({ id: CONFIG.sensors.mailbox, change: 'ne' }, function (obj) {
        // Homematic liefert bei STATE oft 1/0 oder true/false. Wir prüfen auf 1 oder true.
        if (obj.state.val === 1 || obj.state.val === true) {
            
            // Entprellung: Verhindert mehrfaches Auslösen innerhalb kurzer Zeit
            if (!timeoutMailbox) {
                log('Briefkasten wurde geöffnet. Post ist da!', 'info');

                // Status aktualisieren (true = Update/Acknowledge)
                setState(CONFIG.states.mailArrived, true, true);
                setState(CONFIG.states.inhabitantsInformed, false, true);

                // Text abrufen und senden
                const msgText = getState(CONFIG.states.notificationText).val;
                sendTelegramNotification(msgText);

                // Timeout setzen, damit für die konfigurierte Zeit keine weitere Meldung rausgeht
                timeoutMailbox = setTimeout(() => {
                    timeoutMailbox = null;
                }, CONFIG.debounceMs);
            }
        }
    });

    // --------------------------------------------------------
    // TRIGGER 2: Bewohner kommt nach Hause / Tür öffnet
    // --------------------------------------------------------
    on({ id: CONFIG.sensors.door, change: 'ne' }, function (obj) {
        if (obj.state.val === 1 || obj.state.val === true) {
            
            // Aktuelle Statuswerte abrufen
            const mailArrived = getState(CONFIG.states.mailArrived).val;
            const inhabitantsInformed = getState(CONFIG.states.inhabitantsInformed).val;

            // Prüfen, ob Post da ist und Bewohner noch NICHT informiert wurden
            if (mailArrived === true && inhabitantsInformed === false) {
                log('Bewohner erkannt. Starte Alexa-Ansage zur Post.', 'info');
                
                const msgText = getState(CONFIG.states.notificationText).val;
                const previousVolume = getState(CONFIG.alexa.volume).val;

                // Lautstärke setzen (false = Steuern/Command)
                setState(CONFIG.alexa.volume, CONFIG.alexa.announceVolume, false);
                
                // Ansage ausgeben
                setState(CONFIG.alexa.speak, msgText, false);

                // Status aktualisieren
                setState(CONFIG.states.inhabitantsInformed, true, true);
                setState(CONFIG.states.mailArrived, false, true);

                // Alte Lautstärke nach X Sekunden wiederherstellen
                if (timeoutAlexaVolume) clearTimeout(timeoutAlexaVolume);
                timeoutAlexaVolume = setTimeout(() => {
                    setState(CONFIG.alexa.volume, previousVolume, false);
                    log(`Alexa Lautstärke wieder auf ${previousVolume} gesetzt.`, 'info');
                }, CONFIG.alexa.restoreDelayMs);
            }
        }
    });

    // --------------------------------------------------------
    // ZEITPLAN: Reset um 00:05 Uhr jeden Tag
    // --------------------------------------------------------
    schedule('5 0 * * *', function () {
        log('Täglicher Reset: Post-Status wird zurückgesetzt.', 'info');
        setState(CONFIG.states.mailArrived, false, true);
        // Hinweis: bewohner_informiert wird hier bewusst nicht zurückgesetzt,
        // da es beim Einwurf neuer Post ohnehin auf false geht.
    });
}

// ==========================================
// 4. SCRIPT START
// ==========================================
init();

})();