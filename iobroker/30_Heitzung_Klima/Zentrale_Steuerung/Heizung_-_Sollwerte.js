/*
 * @author: Gemini
 * @description: Dieses Skript stellt sicher, dass die notwendigen Datenpunkte für die Heizungssteuerung
 * vorhanden und korrekt konfiguriert sind. Es prüft beim Start und einmal täglich
 * in der Nacht, ob die Datenpunkte existieren, und korrigiert bei Bedarf ihre
 * Eigenschaften (Name, Typ, Rolle etc.), ohne den aktuellen Wert zu verändern.
 * @version: 1.1.0
 * @last-modified: 2025-09-27
 */

// Kapselung des gesamten Skripts in einer anonymen async-Funktion, um den globalen Namespace zu schützen (Best Practice)
(async () => {

    /**
     * Konfiguration der Datenpunkte, die erstellt oder überprüft werden sollen.
     * Dies macht das Skript leicht erweiterbar für zukünftige Datenpunkte.
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
                def: 18, // Standardwert
                unit: '°C'
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
                def: 16, // Standardwert
                unit: '°C'
            },
            native: {}
        }
    ];

    /**
     * Asynchrone Funktion zur Überprüfung, Erstellung und Korrektur der definierten Datenpunkte.
     * Die Funktion durchläuft die Konfiguration und prüft für jeden Eintrag,
     * ob der Datenpunkt existiert. Wenn nicht, wird er angelegt.
     * Wenn er existiert, wird geprüft, ob die Konfiguration (Typ, Rolle, Name etc.) noch korrekt ist
     * und bei Bedarf korrigiert. Der eigentliche Wert (State) des Datenpunkts bleibt dabei unberührt.
     */
    async function checkAndCreateStates() {
        log('Überprüfe und korrigiere die erforderlichen Heizungs-Datenpunkte...', 'info');
        // for...of-Schleife für sauberes Arbeiten mit async/await
        for (const state of statesToCreate) {
            try {
                const obj = await getObjectAsync(state.id);

                if (!obj) {
                    // 1. Fall: Datenpunkt existiert nicht -> Neu anlegen
                    await createStateAsync(state.id, state.common, state.native);
                    log(`Datenpunkt '${state.id}' wurde neu erstellt.`, 'info');
                    
                    // 2. Fall: Initialen Wert setzen, um 'null' zu vermeiden (Best Practice)
                    await setStateAsync(state.id, { val: state.common.def, ack: true });
                    log(`Initialwert für '${state.id}' auf '${state.common.def}' gesetzt.`, 'info');

                } else {
                    // 3. Fall: Datenpunkt existiert -> Konfiguration überprüfen
                    let needsUpdate = false;
                    // Vergleiche die 'common'-Eigenschaften der Vorlage mit dem existierenden Objekt
                    for (const key of Object.keys(state.common)) {
                        if (JSON.stringify(obj.common[key]) !== JSON.stringify(state.common[key])) {
                            needsUpdate = true;
                            break; // Ein Unterschied reicht aus, um die Schleife abzubrechen
                        }
                    }

                    if (needsUpdate) {
                        // Nur die 'common' Eigenschaften aktualisieren, der Rest bleibt unberührt
                        await extendObjectAsync(state.id, { common: state.common });
                        log(`Konfiguration von '${state.id}' wurde korrigiert.`, 'info');
                    } else {
                        // Diese Meldung kann bei Bedarf zur Fehlersuche aktiviert werden.
                        // log(`Datenpunkt '${state.id}' existiert bereits und ist korrekt konfiguriert.`, 'debug');
                    }
                }
            } catch (error) {
                log(`Fehler bei der Verarbeitung des Datenpunkts '${state.id}': ${error}`, 'error');
            }
        }
        log('Überprüfung der Heizungs-Datenpunkte abgeschlossen.', 'info');
    }

    // --- Skript-Start ---

    // Führe die Überprüfung direkt beim Start des Skripts einmal aus.
    await checkAndCreateStates();

    // Richte einen täglichen Cronjob ein, der die Funktion jede Nacht um 3:00 Uhr ausführt.
    // Das Format ist "Minute Stunde TagMonat Monat Wochentag"
    schedule('0 3 * * *', async () => {
        log('Tägliche nächtliche Überprüfung der Datenpunkte wird gestartet.', 'info');
        await checkAndCreateStates();
    });

    log('Skript zur Überprüfung der Heizungs-Datenpunkte wurde gestartet und ist betriebsbereit.', 'info');

})();

