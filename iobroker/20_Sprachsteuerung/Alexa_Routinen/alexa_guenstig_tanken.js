/*******************************************************************************
 * Scriptname:  Alexa_Tanken
 * Beschreibung: Fragt den aktuellen Benzinpreis (Tankerkönig) ab und gibt ihn 
 * über das zuletzt angesprochene Alexa Echo-Gerät aus.
 * * Benötigte Adapter:
 * - Alexa2 (alexa2)
 * - Tankerkönig (tankerkoenig)
 * - JavaScript (javascript)
 * * Autor:       Sanweb
 * * -----------------------------------------------------------------------------
 * Version History:
 * 1.1.1    01.03.2026  Hinweis auf benötigte Adapter im Header hinzugefügt
 * 1.1.0    01.03.2026  Umfassendes Refactoring (Best Practices, Timeout, RegEx, Error Handling)
 * 1.0.1    01.03.2026  Kapselung in IIFE und Strict Mode hinzugefügt
 * 1.0.0    01.03.2026  Initiale Erstellung
 * - Abfrage Seriennummer & Summary des Echo-Geräts
 * - Fallback-Meldung bei geschlossenen Tankstellen (3rd = 0)
 * - Dynamische Sprachausgabe von Name und Preis (Super E5)
 ******************************************************************************/

(function() {
    "use strict";

    // --- KONFIGURATION ---
    const CONFIG = {
        dpSummary:          'alexa2.0.History.summary',
        dpSerialNumber:     'alexa2.0.History.serialNumber',
        dpCheapestE5_3rd:   'tankerkoenig.0.stations.cheapest.e5.3rd',
        dpCheapestE5_Name:  'tankerkoenig.0.stations.cheapest.e5.name',
        dpCheapestE5_Feed:  'tankerkoenig.0.stations.cheapest.e5.feed',
        regexTrigger:       /(tanken|sprit|benzin)/i, // Reagiert auf diese Wörter (ignoriert Groß-/Kleinschreibung)
        delayMs:            1000 // Verzögerung in ms, damit die Seriennummer sicher aktualisiert ist
    };

    on({ id: CONFIG.dpSummary, change: 'ne' }, function (obj) {
        // 1. Performance: obj.state.val statt erneutem getState() nutzen
        let summary = obj.state ? obj.state.val : '';

        // 4. RegEx: Prüfen, ob eines der Trigger-Wörter vorkommt
        if (typeof summary === 'string' && CONFIG.regexTrigger.test(summary)) {
            
            // 3. Robustheit: Timeout, um sicherzustellen, dass die Seriennummer im Alexa-Adapter aktualisiert wurde
            setTimeout(function() {
                
                // Seriennummer des angesprochenen Echos abfragen inkl. Null-Check
                let serialState = getState(CONFIG.dpSerialNumber);
                if (!serialState || !serialState.val) {
                    console.warn('Alexa_Tanken: Fehler - Seriennummer konnte nicht ermittelt werden.');
                    return;
                }
                
                let seriennummer = serialState.val;
                let objekt_ID = 'alexa2.0.Echo-Devices.' + seriennummer + '.Commands.speak';

                // Prüfen, ob die Tankstellen geschlossen sind (Null-Check inklusive)
                let state3rd = getState(CONFIG.dpCheapestE5_3rd);
                if (!state3rd || state3rd.val === null) {
                    console.warn('Alexa_Tanken: Fehler - Status der Tankstelle (3rd) nicht lesbar.');
                    return;
                }

                if (state3rd.val == 0) {
                    let messageClosed = 'Es tut mir leid, aber die Tankstellen sind aktuell geschlossen!';
                    setState(objekt_ID, messageClosed);
                    console.debug(messageClosed);
                } else {
                    // Wenn geöffnet, Daten auslesen (mit Fehlerüberprüfung)
                    let stateName = getState(CONFIG.dpCheapestE5_Name);
                    let statePrice = getState(CONFIG.dpCheapestE5_Feed);
                    
                    if (!stateName || !statePrice || stateName.val === null || statePrice.val === null) {
                        console.warn('Alexa_Tanken: Fehler - Name oder Preis nicht lesbar.');
                        return;
                    }

                    let stationName = stateName.val;
                    let stationPriceRaw = parseFloat(statePrice.val);
                    
                    // 2. Sprachausgabe: Preis formatieren - Punkt durch Komma ersetzen, auf 2 Nachkommastellen runden
                    let stationPrice = isNaN(stationPriceRaw) ? statePrice.val : stationPriceRaw.toFixed(2).replace('.', ',');

                    // Nachricht zusammenbauen (Euro ausgeschrieben für flüssigere Aussprache)
                    let messageOpen = 'Aktuell ist die ' + stationName + ' mit ' + stationPrice + ' Euro pro Liter Super am günstigsten!';
                    
                    // Ausgabe an das jeweilige Echo-Gerät und ins ioBroker Log
                    setState(objekt_ID, messageOpen);
                    console.debug(messageOpen);
                }
            }, CONFIG.delayMs);
        }
    });

})();