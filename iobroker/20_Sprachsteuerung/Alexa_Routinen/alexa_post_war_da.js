/**
 * @file      Briefkasten Komplett-System (Ollama + Telegram + Alexa)
 * @version   2.0.0
 * @description Kombiniertes Script: Erkennt Post, generiert KI-Text via Ollama,
 *              sendet Telegram-Benachrichtigung und gibt Alexa-Ansage beim
 *              Betreten der Wohnung aus.
 */

(function () {
    "use strict";

    // @ts-ignore
    const axios = require('axios');

    // ==========================================
    // 1. KONFIGURATION
    // ==========================================
    const CONFIG = {
        sensors: {
            mailbox: 'hm-rpc.0.001E1D899E942E.1.STATE',
            door:    'hm-rpc.0.0023DA49A3AFF8.1.STATE'
        },
        states: {
            mailArrived:          '0_userdata.0.briefkasten.post_war_da',
            inhabitantsInformed:  '0_userdata.0.briefkasten.bewohner_informiert',
            notificationText:     '0_userdata.0.Ollama.Notification.Briefkasten'
        },
        alexa: {
            speak:          'alexa2.0.Echo-Devices.G0911M10020400F5.Commands.speak',
            volume:         'alexa2.0.Echo-Devices.G0911M10020400F5.Commands.speak-volume',
            announceVolume: 30,
            restoreDelayMs: 10000
        },
        telegram: {
            instance: 'telegram.0'
        },
        ollama: {
            baseUrl:       'http://192.168.50.6:11434',
            modelPrimary:  'gemma4:31b-cloud',
            modelFallback: ['qwen3-coder-next:cloud', 'gpt-oss:20b-cloud'],
            options: {
                temperature:    0.85,
                top_p:          0.92,
                top_k:          40,
                num_predict:    80,
                repeat_penalty: 1.15
            }
        },
        mailboxDebounceMs: 60000  // Entprellzeit Briefkasten (1 Minute)
    };

    // ==========================================
    // 2. INTERNE VARIABLEN
    // ==========================================
    let timeoutMailbox    = null;
    let timeoutAlexaVolume = null;

    // ==========================================
    // 3. OLLAMA-LOGIK
    // ==========================================

    function getTimeOfDayContext() {
        const hour = new Date().getHours();
        if (hour >= 5  && hour < 12) return "Es ist Vormittag.";
        if (hour >= 12 && hour < 18) return "Es ist Nachmittag.";
        if (hour >= 18 && hour < 22) return "Es ist Abend.";
        return "Es ist mitten in der Nacht.";
    }

    function buildPrompt() {
        const persona  = 'ein extrem höflicher, britischer Butler namens James';
        const timeCtx  = getTimeOfDayContext();
        return `### SYSTEM
Du bist ${persona}.
Deine einzige Aufgabe: Formuliere eine einzige, knappe Smart-Home-Benachrichtigung.

STRIKTE REGELN — halte sie ohne Ausnahme ein:
- Erwähne NUR den Briefkasten. Erfinde nichts dazu.
- Schreibe im Perfekt (Vergangenheit).
- Maximal 1 Satz, maximal 12 Wörter.
- Sprich den Nutzer passend an (z. B. "Hallo", "Guten Tag" o. Ä.).
- Gib NUR den reinen Benachrichtigungstext aus — keine Anführungszeichen, keine Einleitungen, kein Kommentar.
- Antworte ausschließlich auf Deutsch.

### AUFGABE
${timeCtx}
Gerät: Briefkasten im Außenbereich
Ereignis: Post eingeworfen

### BENACHRICHTIGUNG`;
    }

    async function generateWithFallback(prompt) {
        const modelQueue = [CONFIG.ollama.modelPrimary, ...CONFIG.ollama.modelFallback];
        const url = `${CONFIG.ollama.baseUrl}/api/generate`;

        for (const model of modelQueue) {
            try {
                log(`Ollama: Versuche Modell "${model}"...`);
                const response = await axios.post(url, {
                    model:   model,
                    prompt:  prompt,
                    stream:  false,
                    options: CONFIG.ollama.options
                }, {
                    headers:  { 'Content-Type': 'application/json' },
                    timeout:  60000
                });

                if (response.status === 200 && response.data?.response) {
                    log(`Ollama: Erfolg mit Modell "${model}".`);
                    return response.data.response;
                }
            } catch (e) {
                if (e.response?.status === 404) {
                    log(`Ollama: Modell "${model}" nicht gefunden. Versuche nächstes...`, 'warn');
                } else if (e.code === 'ECONNREFUSED' || e.code === 'ECONNABORTED') {
                    log(`Ollama: Server nicht erreichbar (${CONFIG.ollama.baseUrl}): ${e.message}`, 'error');
                    return null; // Server weg, kein weiterer Versuch
                } else {
                    log(`Ollama: Fehler mit "${model}" (HTTP ${e.response?.status || 'N/A'}): ${e.message}`, 'warn');
                }
            }
        }
        log('Ollama: Alle Modelle fehlgeschlagen.', 'error');
        return null;
    }

    /**
     * Generiert den Benachrichtigungstext via Ollama und gibt ihn bereinigt zurück.
     * Gibt einen Fallback-Text zurück, falls Ollama nicht erreichbar ist.
     */
    async function generateNotificationText() {
        const rawText = await generateWithFallback(buildPrompt());

        if (!rawText) {
            return 'Es wurde Post in den Briefkasten eingeworfen.'; // Fallback
        }

        return rawText
            .trim()
            .replace(/^["'„»«]|["'""»«]$/g, '')
            .replace(/\n.*/s, '')
            .replace(/^(Benachrichtigung:|Antwort:|Output:)\s*/i, '')
            .trim();
    }

    // ==========================================
    // 4. BENACHRICHTIGUNGS-LOGIK
    // ==========================================

    function sendTelegramNotification(text) {
        sendTo(CONFIG.telegram.instance, 'send', { text });
        log(`Telegram: Nachricht versendet: "${text}"`, 'info');
    }

    function announceViaAlexa(text) {
        const previousVolume = getState(CONFIG.alexa.volume).val;
        setState(CONFIG.alexa.volume, CONFIG.alexa.announceVolume, false);
        setState(CONFIG.alexa.speak, text, false);

        if (timeoutAlexaVolume) clearTimeout(timeoutAlexaVolume);
        timeoutAlexaVolume = setTimeout(() => {
            setState(CONFIG.alexa.volume, previousVolume, false);
            log(`Alexa: Lautstärke wieder auf ${previousVolume} gesetzt.`, 'info');
        }, CONFIG.alexa.restoreDelayMs);
    }

    // ==========================================
    // 5. HAUPT-TRIGGER
    // ==========================================

    function init() {
        log('Briefkasten-Script v2.0 gestartet.', 'info');

        // --------------------------------------------------------
        // TRIGGER 1: Briefkasten wird geöffnet
        // Ablauf: Ollama-Text generieren → Telegram senden → Status setzen
        // --------------------------------------------------------
        on({ id: CONFIG.sensors.mailbox, change: 'ne' }, async function (obj) {
            if (obj.state.val !== 1 && obj.state.val !== true) return;
            if (timeoutMailbox) return; // Entprellung aktiv

            log('Briefkasten geöffnet — starte Textgenerierung...', 'info');

            // Debounce sofort aktivieren
            timeoutMailbox = setTimeout(() => { timeoutMailbox = null; }, CONFIG.mailboxDebounceMs);

            // Status zurücksetzen: Bewohner müssen neu informiert werden
            setState(CONFIG.states.inhabitantsInformed, false, true);
            setState(CONFIG.states.mailArrived, false, true); // Erst am Ende auf true

            // *** KERNFIX: Text ZUERST generieren, dann alles andere ***
            const msgText = await generateNotificationText();

            // Generierten Text persistieren (für Alexa-Ansage später)
            setState(CONFIG.states.notificationText, msgText, true);

            // Telegram-Benachrichtigung mit frischem Text
            sendTelegramNotification(msgText);

            // Jetzt erst mailArrived = true setzen (Alexa-Trigger wartet darauf)
            setState(CONFIG.states.mailArrived, true, true);

            log(`Briefkasten-Benachrichtigung abgeschlossen: "${msgText}"`, 'info');
        });

        // --------------------------------------------------------
        // TRIGGER 2: Bewohner kommt nach Hause / Tür öffnet
        // Alexa liest den bereits gespeicherten Text vor
        // --------------------------------------------------------
        on({ id: CONFIG.sensors.door, change: 'ne' }, function (obj) {
            if (obj.state.val !== 1 && obj.state.val !== true) return;

            const mailArrived         = getState(CONFIG.states.mailArrived).val;
            const inhabitantsInformed = getState(CONFIG.states.inhabitantsInformed).val;

            if (mailArrived === true && inhabitantsInformed === false) {
                log('Bewohner erkannt — starte Alexa-Ansage.', 'info');

                const msgText = getState(CONFIG.states.notificationText).val;
                announceViaAlexa(msgText);

                setState(CONFIG.states.inhabitantsInformed, true, true);
                setState(CONFIG.states.mailArrived, false, true);
            }
        });

        // --------------------------------------------------------
        // ZEITPLAN: Täglicher Reset um 00:05 Uhr
        // --------------------------------------------------------
        schedule('5 0 * * *', function () {
            log('Täglicher Reset: Post-Status wird zurückgesetzt.', 'info');
            setState(CONFIG.states.mailArrived, false, true);
        });
    }

    // ==========================================
    // 6. START
    // ==========================================
    init();

})();