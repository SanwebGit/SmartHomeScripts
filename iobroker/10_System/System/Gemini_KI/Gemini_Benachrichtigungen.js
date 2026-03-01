/*
 * NEXT-LEVEL ioBroker Gemini Integration
 * * Features:
 * - Dynamische Benachrichtigungen mit Google Gemini 2.5 Flash
 * - Spamschutz (Debouncing) für flatternde Sensoren
 * - Eigene "Personas" (Charaktere) pro Gerät
 * - Tageszeit-Kontext für natürlichere Antworten
 * - Natives API System-Prompting für strikte Regel-Einhaltung
 */

(function() {
    "use strict";

    // Das 'axios' Modul einmalig laden.
    // Muss als zusätzliches NPM-Modul in der Javascript-Adapter Konfiguration eingetragen werden!
    const axios = require('axios');

    // +++++ KONFIGURATION +++++

    const GEMINI_API_KEY = getState("0_userdata.0.API-Keys.GEMINI_API_KEY").val;
    const GEMINI_MODEL = 'gemini-2.5-flash';

    // Globale Standard-Persona, falls beim Gerät keine angegeben ist
    const DEFAULT_PERSONA = 'eine freundliche und leicht humorvolle Smart-Home KI';

    const DEVICES = [
        {
            triggerId: '0_userdata.0.briefkasten.post_war_da',
            targetId: '0_userdata.0.Gemini.Notification.Briefkasten',
            deviceName: 'Briefkasten im Außenbereich',
            stateMapping: { true: 'Post eingeworfen', false: 'Post geleert' },
            triggerOn: [true, false], 
            tense: 'Vergangenheit',
            // NEXT LEVEL FEATURES:
            persona: 'ein extrem höflicher, britischer Butler namens James', // KI spielt eine Rolle
            debounceTime: 5000 // Wartet 5 Sekunden nach dem letzten Trigger, um "Flattern" zu ignorieren
        },
        // Beispiel für ein weiteres Gerät:
        // {
        //     triggerId: 'alias.0.Wohnzimmer.Fenster.ACTUAL',
        //     targetId: '0_userdata.0.Gemini.Notification.Fenster_Wohnzimmer',
        //     deviceName: 'Wohnzimmerfenster',
        //     stateMapping: { true: 'geöffnet', false: 'geschlossen' },
        //     triggerOn: [true],
        //     tense: 'Gegenwart',
        //     persona: 'eine leicht besorgte Mutter, die Angst vor Zugluft hat',
        //     debounceTime: 2000
        // }
    ];

    // +++++ INTERNE LOGIK +++++

    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const debounceTimers = {}; // Speichert die Timer für den Spamschutz

    // Hilfsfunktion: Tageszeit ermitteln für mehr Kontext
    function getTimeOfDayContext() {
        const hour = new Date().getHours();
        if (hour >= 5 && hour < 12) return "Es ist Vormittag.";
        if (hour >= 12 && hour < 18) return "Es ist Nachmittag.";
        if (hour >= 18 && hour < 22) return "Es ist Abend.";
        return "Es ist mitten in der Nacht.";
    }

    async function getGeminiResponse(deviceConfig, stateName) {
        if (GEMINI_API_KEY === 'DEIN_API_SCHLUESSEL' || GEMINI_API_KEY.length < 10) {
            log('Bitte tragen Sie einen gültigen Gemini API-Schlüssel ein.', 'error');
            return;
        }

        const tenseMap = {
            'vergangenheit': 'Verwende zwingend die Vergangenheitsform (Perfekt).',
            'zukunft': 'Verwende zwingend die Zukunftsform (Futur I).',
            'gegenwart': 'Verwende zwingend die Gegenwartsform (Präsens).'
        };
        const tenseInstruction = tenseMap[(deviceConfig.tense || 'gegenwart').toLowerCase()] || tenseMap['gegenwart'];
        const persona = deviceConfig.persona || DEFAULT_PERSONA;
        const timeContext = getTimeOfDayContext();

        // NEXT LEVEL: Wir nutzen 'systemInstruction', um der KI unumstößliche Kern-Regeln zu geben
        const systemInstruction = `Du bist ${persona}. 
Deine Aufgabe ist es, den Nutzer über ein Smart-Home-Ereignis zu informieren.

STRENGE REGELN:
1. Erwähne AUSSCHLIESSLICH das vorgegebene Gerät. Erfinde niemals andere Geräte!
2. ${tenseInstruction}
3. Formuliere exakt einen einzigen, kompakten Satz (maximal 12 Worte).
4. Sprich den Nutzer direkt an (z.B. "Sir", "Du", "Euer Majestät" - passend zu deiner Persona).
5. Liefere nur den reinen Benachrichtigungstext, ohne Anführungszeichen oder Einleitungen.
6. Berücksichtige die aktuelle Tageszeit in deiner Formulierung, falls es sich natürlich anfühlt.`;

        // Der eigentliche User-Prompt enthält nur noch die reinen, nackten Fakten
        const userPrompt = `FAKTEN:
- Aktuelle Tageszeit: ${timeContext}
- Betroffenes Gerät: ${deviceConfig.deviceName}
- Neues Ereignis/Zustand: ${stateName}`;

        const payload = {
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ parts: [{ text: userPrompt }] }]
        };

        const MAX_RETRIES = 3;
        let delay = 2000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                log(`Sende Anfrage für "${deviceConfig.targetId}" an Gemini API...`);
                const response = await axios.post(GEMINI_API_URL, payload, {
                    headers: { 'Content-Type': 'application/json' }
                });

                if (response.status === 200) {
                    const generatedText = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (generatedText) {
                        const cleanText = generatedText.trim().replace(/^["']|["']$/g, ''); // Entfernt evtl. generierte Anführungszeichen
                        log(`Antwort für ${deviceConfig.targetId}: ${cleanText}`);
                        setState(deviceConfig.targetId, cleanText, true);
                        return;
                    }
                }
            } catch (e) {
                if ((e.response?.status === 503 || e.response?.status === 429) && attempt < MAX_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= 2; 
                } else {
                    log(`API Fehler bei ${deviceConfig.targetId}: ${e.message}`, 'error');
                    setState(deviceConfig.targetId, `API Fehler aufgetreten.`, true);
                    return;
                }
            }
        }
    }

    async function main() {
        // NEXT LEVEL: Saubere ioBroker Datenpunkt-Erstellung mit createStateAsync (kompatibel mit allen JS-Adapter Versionen)
        for (const device of DEVICES) {
            await createStateAsync(device.targetId, {
                name: `Gemini Info: ${device.deviceName}`,
                desc: `KI generierter Text für ${device.deviceName}`,
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: ''
            });
        }

        const allTriggerIds = DEVICES.map(device => device.triggerId);
        log('Gemini Skript gestartet. Alle Zieldatenpunkte sind bereit.');

        on({ id: allTriggerIds, change: 'ne' }, async (obj) => {
            const device = DEVICES.find(d => d.triggerId === obj.id);
            if (!device) return;

            const stateVal = obj.state.val;
            const triggerOn = device.triggerOn || [true];
            
            if (!triggerOn.includes(stateVal)) return;

            const stateName = device.stateMapping[stateVal.toString()] || (stateVal ? 'aktiviert' : 'deaktiviert');
            log(`Trigger erkannt: ${device.deviceName} -> "${stateName}". Starte Spamschutz-Timer...`);

            // NEXT LEVEL: Debouncing (Spamschutz)
            // Wenn der Trigger innerhalb der Wartezeit erneut auslöst, wird der alte Timer abgebrochen
            if (debounceTimers[device.triggerId]) {
                clearTimeout(debounceTimers[device.triggerId]);
            }

            const debounceMs = device.debounceTime || 1000; // Standard: 1 Sekunde
            
            debounceTimers[device.triggerId] = setTimeout(() => {
                log(`Spamschutz abgelaufen. Generiere Text für ${device.deviceName}...`);
                getGeminiResponse(device, stateName);
                delete debounceTimers[device.triggerId];
            }, debounceMs);
        });
    }

    main().catch(err => {
        log('Fehler bei der Skript-Initialisierung: ' + err, 'error');
    });

})();