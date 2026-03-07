/*
 * @author      Ihr Name / Pseudonym
 * @version     1.7
 * @date        24.09.2025
 * @description Dieses Skript prüft auf Anfrage via Alexa, welche Fenster geöffnet sind
 * und gibt eine entsprechende Sprachausgabe auf dem anfragenden Gerät aus.
 *
 * v1.7: Trigger auf 'any' geändert für höhere Zuverlässigkeit.
 * Umfangreiche Log-Ausgaben für einfacheres Debugging hinzugefügt.
 * Logik zur Satzbildung auf Array.join() umgestellt.
 * v1.6: Skript gekapselt (IIFE), um globale Konflikte zu vermeiden.
 * v1.5: Zählt die Anzahl der offenen Fenster und gibt diese in der Antwort aus.
 * v1.4: Sprachausgabe leicht verzögert für sichere Lautstärkenanpassung.
 * Sensor-Status in Konfiguration flexibler gemacht.
 * v1.3: Kommentare im Konfigurationsbereich hinzugefügt.
 * v1.2: Konfigurationsbereich für Sensoren und Geräte hinzugefügt und Logik optimiert.
 * v1.1: Headerbereich hinzugefügt
 */

(function() {
    "use strict";

    // ============== KONFIGURATION ==============
    const config = {
        // --- Alexa Datenpunkte ---
        alexa: {
            // Datenpunkt, der den zuletzt gesprochenen Text enthält.
            historySummary: 'alexa2.0.History.summary',
            // Datenpunkt, der die Seriennummer des zuletzt angesprochenen Geräts enthält.
            historySerialNumber: 'alexa2.0.History.serialNumber',
            // Basispfad für alle Echo-Geräte.
            echoDevicesPath: 'alexa2.0.Echo-Devices.'
        },

        // --- Liste der Fenstersensoren ---
        // Trage hier alle Fenstersensoren ein, die geprüft werden sollen.
        // 'raum': Name des Raumes für die Sprachausgabe.
        // 'id': Die Objekt-ID des Sensors.
        // 'offenWert': Der Wert des Datenpunkts, der als "offen" interpretiert wird (z.B. 1, true, "OPEN").
        fensterSensoren: [
            { raum: 'Badezimmer', id: 'hm-rpc.0.0023DA49A3CC62.1.STATE', offenWert: 1 },
            { raum: 'Küche', id: 'hm-rpc.0.0023DA49A3CC5A.1.STATE', offenWert: 1 },
            { raum: 'Esszimmer', id: 'hm-rpc.0.0023DA49A3B05C.1.STATE', offenWert: 1 },
            { raum: 'Wohnzimmer', id: 'hm-rpc.0.00109A49A44D25.1.STATE', offenWert: 1 },
            { raum: 'Schlafzimmer', id: 'hm-rpc.0.00109A49A438EA.1.STATE', offenWert: 1 }
        ],

        // --- Sprachausgabe ---
        // Die Lautstärke, mit der Alexa antworten soll (0-100).
        speakVolume: 30,
    };
    // ===========================================


    // Trigger: Wird ausgeführt, wenn sich der Wert von 'alexa2.0.History.summary' ändert.
    // 'change: any' ist zuverlässiger als 'ne' für diesen Anwendungsfall.
    on({ id: config.alexa.historySummary, change: 'any' }, function (obj) {
      log("Trigger für Alexa-Fenster-Status wurde ausgelöst.", "info");
      
      const summary = obj.state.val;
      if (!summary) {
        log("Kein Text im Summary gefunden. Skript wird beendet.", "warn");
        return;
      }

      const summaryLowerCase = summary.toLowerCase();
      log(`Alexa hat verstanden: "${summaryLowerCase}"`);
      
      // Prüft, ob der Befehl die relevanten Schlüsselwörter enthält.
      const isTriggered = (summaryLowerCase.includes('fenster') && summaryLowerCase.includes('offen')) || 
                          (summaryLowerCase.includes('fenster') && summaryLowerCase.includes('geöffnet'));

      if (isTriggered) {
        log("Schlüsselwörter 'fenster' und 'offen/geöffnet' erkannt. Skript wird ausgeführt.", "info");

        const seriennummer = getState(config.alexa.historySerialNumber).val;
        if (!seriennummer) {
            log("Konnte die Seriennummer des Echo-Geräts nicht ermitteln.", "error");
            return;
        }
        log(`Echo-Seriennummer: ${seriennummer}`);
        
        const echoDeviceBasePath = config.alexa.echoDevicesPath + seriennummer;
        const objekt_ID_speak = echoDeviceBasePath + '.Commands.speak';
        const objekt_ID_volume = echoDeviceBasePath + '.Commands.speak-volume';
        
        const offeneFensterRaeume = [];

        // Prüfe alle konfigurierten Fenster-Sensoren
        config.fensterSensoren.forEach(function(sensor) {
            const state = getState(sensor.id);
            // Prüfen, ob der Zustand existiert und dem "offenWert" entspricht
            if (state && state.val == sensor.offenWert) {
                offeneFensterRaeume.push(sensor.raum);
            }
        });

        // Setze zuerst die Lautstärke
        setState(objekt_ID_volume, config.speakVolume);
        log(`Setze Lautstärke auf ${config.speakVolume} für Gerät ${seriennummer}.`);

        // Finale Sprachausgabe zusammenstellen
        let finaleNachricht;
        const offeneFensterAnzahl = offeneFensterRaeume.length;
        const raumListe = offeneFensterRaeume.join(', ');

        if (offeneFensterAnzahl === 0) {
          finaleNachricht = 'Alle Fenster sind geschlossen.';
        } else if (offeneFensterAnzahl === 1) {
          finaleNachricht = `Es ist 1 Fenster geöffnet: ${raumListe}.`;
        } else {
          finaleNachricht = `Es sind ${offeneFensterAnzahl} Fenster geöffnet: ${raumListe}.`;
        }

        // Sprachausgabe mit einer kleinen Verzögerung, um sicherzustellen,
        // dass der Lautstärke-Befehl zuerst verarbeitet wird.
        setTimeout(function() {
            setState(objekt_ID_speak, finaleNachricht);
            log(`Sprachausgabe wird gesendet: "${finaleNachricht}"`, "info");
        }, 250); // 250 Millisekunden Verzögerung

      } else {
        log("Schlüsselwörter nicht im Befehl gefunden. Skript wird nicht ausgeführt.", "debug");
      }
    });

    log("[Alexa] Alexa Fenster-Status Skript gestartet und wartet auf Befehle.", "info");

})();
