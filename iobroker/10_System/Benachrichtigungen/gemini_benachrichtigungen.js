/*
 * NEXT-LEVEL ioBroker Ollama Integration
 *
 * Features:
 * - Dynamische Benachrichtigungen mit lokalem Ollama-Modell
 * - Spamschutz (Debouncing) für flatternde Sensoren
 * - Eigene "Personas" (Charaktere) pro Gerät
 * - Tageszeit-Kontext für natürlichere Antworten
 * - Optimiertes Prompting für lokale LLMs (Ollama-kompatibel)
 * - Automatisches Modell-Fallback
 */

(function() {
    "use strict";
    
    // @ts-ignore
    const axios = require('axios');

    // +++++ KONFIGURATION +++++

    // Ollama Endpunkt & Modelle
    const OLLAMA_BASE_URL = 'http://192.168.50.6:11434';
    const OLLAMA_MODEL_PRIMARY  = 'gemma4:31b-cloud';
    const OLLAMA_MODEL_FALLBACK = ['qwen3-coder-next:cloud', 'gpt-oss:20b-cloud'];

    // Generierungs-Parameter (für lokale Modelle wichtiger als bei Cloud-APIs)
    const GENERATION_OPTIONS = {
        temperature:  0.85,  // Kreativität: 0.0 = deterministisch, 1.0 = sehr kreativ
        top_p:        0.92,
        top_k:        40,
        num_predict:  80,    // Max. Token-Ausgabe; kurz halten für kompakte Benachrichtigungen
        repeat_penalty: 1.15 // Verhindert Wiederholungen im Text
    };

    // Globale Standard-Persona, falls beim Gerät keine angegeben ist
    const DEFAULT_PERSONA = 'eine freundliche und leicht humorvolle Smart-Home KI';

    const DEVICES = [
        {
            triggerId:  '0_userdata.0.briefkasten.post_war_da',
            targetId:   '0_userdata.0.Ollama.Notification.Briefkasten',
            deviceName: 'Briefkasten im Außenbereich',
            stateMapping: { true: 'Post eingeworfen', false: 'Post geleert' },
            triggerOn:  [true, false],
            tense:      'Vergangenheit',
            persona:    'ein extrem höflicher, britischer Butler namens James',
            debounceTime: 5000
        },
        // Beispiel für ein weiteres Gerät:
        // {
        //     triggerId:  'alias.0.Wohnzimmer.Fenster.ACTUAL',
        //     targetId:   '0_userdata.0.Ollama.Notification.Fenster_Wohnzimmer',
        //     deviceName: 'Wohnzimmerfenster',
        //     stateMapping: { true: 'geöffnet', false: 'geschlossen' },
        //     triggerOn:  [true],
        //     tense:      'Gegenwart',
        //     persona:    'eine leicht besorgte Mutter, die Angst vor Zugluft hat',
        //     debounceTime: 2000
        // }
    ];

    // +++++ INTERNE LOGIK +++++

    const OLLAMA_GENERATE_URL = `${OLLAMA_BASE_URL}/api/generate`;
    const debounceTimers = {};

    function getTimeOfDayContext() {
        const hour = new Date().getHours();
        if (hour >= 5  && hour < 12) return "Es ist Vormittag.";
        if (hour >= 12 && hour < 18) return "Es ist Nachmittag.";
        if (hour >= 18 && hour < 22) return "Es ist Abend.";
        return "Es ist mitten in der Nacht.";
    }

    /**
     * Baut den optimierten Prompt für lokale Ollama-Modelle.
     * Lokale LLMs reagieren besser auf explizite, direkte Anweisungen
     * als auf abstrakte Rollenspiel-Konstrukte.
     */
    function buildPrompt(deviceConfig, stateName) {
        const tenseMap = {
            'vergangenheit': 'Schreibe im Perfekt (Vergangenheit).',
            'zukunft':       'Schreibe im Futur I (Zukunft).',
            'gegenwart':     'Schreibe im Präsens (Gegenwart).'
        };
        const tenseInstruction = tenseMap[(deviceConfig.tense || 'gegenwart').toLowerCase()] || tenseMap['gegenwart'];
        const persona    = deviceConfig.persona || DEFAULT_PERSONA;
        const timeCtx    = getTimeOfDayContext();

        // Für lokale Modelle: Klarer Aufbau mit System-Block, dann direkter Aufgabe.
        // Viele Ollama-Modelle unterstützen keinen separaten system-Parameter im /api/generate
        // Endpunkt, daher wird alles in einen einzigen strukturierten Prompt gebettet.
        return `### SYSTEM
Du bist ${persona}.
Deine einzige Aufgabe: Formuliere eine einzige, knappe Smart-Home-Benachrichtigung.

STRIKTE REGELN — halte sie ohne Ausnahme ein:
- Erwähne NUR das angegebene Gerät. Erfinde nichts dazu.
- ${tenseInstruction}
- Maximal 1 Satz, maximal 12 Wörter.
- Sprich den Nutzer passend zur Persona an (z. B. "Sir", "Du" o. Ä.).
- Gib NUR den reinen Benachrichtigungstext aus — keine Anführungszeichen, keine Einleitungen, kein Kommentar.
- Antworte ausschließlich auf Deutsch.

### AUFGABE
${timeCtx}
Gerät: ${deviceConfig.deviceName}
Ereignis: ${stateName}

### BENACHRICHTIGUNG`;
    }

    /**
     * Versucht die Generierung mit dem primären Modell,
     * fällt bei Fehler automatisch auf die Fallback-Modelle zurück.
     */
    async function generateWithFallback(prompt) {
        const modelQueue = [OLLAMA_MODEL_PRIMARY, ...OLLAMA_MODEL_FALLBACK];

        for (const model of modelQueue) {
            try {
                log(`Versuche Modell: ${model}`);
                const payload = {
                    model:   model,
                    prompt:  prompt,
                    stream:  false,      // Wichtig: false für eine einzelne vollständige Antwort
                    options: GENERATION_OPTIONS
                };

                const response = await axios.post(OLLAMA_GENERATE_URL, payload, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 60000  // 60 Sekunden Timeout (lokale Modelle können langsam laden)
                });

                if (response.status === 200 && response.data?.response) {
                    log(`Erfolg mit Modell: ${model}`);
                    return { text: response.data.response, model };
                }

            } catch (e) {
                const status  = e.response?.status;
                const errMsg  = e.message;

                if (status === 404) {
                    log(`Modell "${model}" nicht gefunden auf Ollama-Server. Versuche nächstes...`, 'warn');
                } else if (e.code === 'ECONNREFUSED' || e.code === 'ECONNABORTED') {
                    log(`Ollama-Server nicht erreichbar (${OLLAMA_BASE_URL}): ${errMsg}`, 'error');
                    return null; // Kein Fallback nötig, Server ist weg
                } else {
                    log(`Fehler mit Modell "${model}" (HTTP ${status || 'N/A'}): ${errMsg}`, 'warn');
                }
            }
        }

        log('Alle Modelle fehlgeschlagen. Keine Benachrichtigung generiert.', 'error');
        return null;
    }

    async function getOllamaResponse(deviceConfig, stateName) {
        const prompt = buildPrompt(deviceConfig, stateName);
        log(`Sende Anfrage für "${deviceConfig.deviceName}" an Ollama...`);

        const result = await generateWithFallback(prompt);

        if (!result) {
            setState(deviceConfig.targetId, 'Fehler: Ollama nicht erreichbar.', true);
            return;
        }

        // Bereinigung: Anführungszeichen, Zeilenumbrüche und Modell-Artefakte entfernen
        let cleanText = result.text
            .trim()
            .replace(/^["'„»«]|["'""»«]$/g, '')  // Anführungszeichen am Rand
            .replace(/\n.*/s, '')                   // Alles nach dem ersten Zeilenumbruch
            .replace(/^(Benachrichtigung:|Antwort:|Output:)\s*/i, '') // Modell-Präfixe
            .trim();

        log(`[${result.model}] Antwort für "${deviceConfig.deviceName}": ${cleanText}`);
        setState(deviceConfig.targetId, cleanText, true);
    }

    async function main() {
        // Zieldatenpunkte anlegen
        for (const device of DEVICES) {
            await createStateAsync(device.targetId, {
                name:  `Ollama Info: ${device.deviceName}`,
                desc:  `KI generierter Text für ${device.deviceName}`,
                type:  'string',
                role:  'text',
                read:  true,
                write: false,
                def:   ''
            });
        }

        // Verbindung zum Ollama-Server beim Start prüfen
        try {
            await axios.get(`${OLLAMA_BASE_URL}/api/tags`, { timeout: 5000 });
            log(`Ollama-Server erreichbar unter ${OLLAMA_BASE_URL}. Skript bereit.`);
        } catch (e) {
            log(`WARNUNG: Ollama-Server unter ${OLLAMA_BASE_URL} nicht erreichbar. Bitte Server prüfen!`, 'warn');
        }

        const allTriggerIds = DEVICES.map(device => device.triggerId);
        log('Ollama-Skript gestartet. Alle Zieldatenpunkte sind bereit.');

        on({ id: allTriggerIds, change: 'ne' }, async (obj) => {
            const device = DEVICES.find(d => d.triggerId === obj.id);
            if (!device) return;

            const stateVal = obj.state.val;
            const triggerOn = device.triggerOn || [true];

            if (!triggerOn.includes(stateVal)) return;

            const stateName = device.stateMapping[stateVal.toString()] || (stateVal ? 'aktiviert' : 'deaktiviert');
            log(`Trigger erkannt: ${device.deviceName} → "${stateName}". Starte Debounce-Timer...`);

            // Debouncing: Bei erneutem Trigger innerhalb der Wartezeit alten Timer verwerfen
            if (debounceTimers[device.triggerId]) {
                clearTimeout(debounceTimers[device.triggerId]);
            }

            const debounceMs = device.debounceTime || 1000;

            debounceTimers[device.triggerId] = setTimeout(() => {
                log(`Debounce abgelaufen. Generiere Text für ${device.deviceName}...`);
                getOllamaResponse(device, stateName);
                delete debounceTimers[device.triggerId];
            }, debounceMs);
        });
    }

    main().catch(err => {
        log('Fehler bei der Skript-Initialisierung: ' + err, 'error');
    });

})();