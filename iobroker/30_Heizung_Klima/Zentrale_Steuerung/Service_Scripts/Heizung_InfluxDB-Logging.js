/**
 * @fileoverview Zentrales Konfigurations-Skript für InfluxDB-Logging
 * @version 1.0
 * @author Gemini (basierend auf der Analyse der Benutzerskripte)
 * @license MIT
 *
 * -------------------------------------------------------------------------------------
 * ZWECK DES SKRIPTS:
 * -------------------------------------------------------------------------------------
 * Dieses Skript aktiviert und konfiguriert das InfluxDB-Logging für alle relevanten
 * Datenpunkte des intelligenten Heizungssystems. Es wurde durch die Analyse aller
 * bereitgestellten Heizungsskripte (Einzelraum, Zentral, Wetter, Lernen) erstellt.
 *
 * ANWENDUNG:
 * Das Skript einmalig ausführen. Es prüft jeden Datenpunkt in der Konfiguration
 * und wendet die empfohlenen Logging-Parameter an. Bestehende Konfigurationen
 * werden dabei überschrieben und korrigiert.
 * -------------------------------------------------------------------------------------
 */

// =====================================================================================
// 1. ZENTRALE KONFIGURATION DER LOGGING-PARAMETER
// =====================================================================================

const INFLUXDB_INSTANCE = 'influxdb.0';
const LOG_PREFIX = '[InfluxDB-Konfigurator]';

// --- Vorlagen für verschiedene Datenpunkttypen ---

// Für langsam ändernde Temperaturwerte (Ist, Außen, Wand)
const tempConfig = {
    enabled: true,
    debounce: 2000,
    changesOnly: true,
    changesRelog: 0,
    changesMinDelta: 0.2, // Loggt nur bei Änderungen > 0.2°C
    storageType: 'Number'
};

// Für Soll-Temperaturen, die seltener geändert werden
const setpointConfig = {
    enabled: true,
    debounce: 500,
    changesOnly: true,
    changesRelog: 86400, // Logge den Wert 1x pro Tag erneut, um Graphen zu füllen
    changesMinDelta: 0,
    storageType: 'Number'
};

// Für Luftfeuchtigkeitswerte
const humidityConfig = {
    enabled: true,
    debounce: 5000,
    changesOnly: true,
    changesRelog: 0,
    changesMinDelta: 2, // Loggt nur bei Änderungen > 2%
    storageType: 'Number'
};

// Für Ventilöffnungsgrade (LEVEL)
const levelConfig = {
    enabled: true,
    debounce: 10000, // Starke Beruhigung, um nur stabile Zustände zu loggen
    changesOnly: true,
    changesRelog: 3600, // Alle Stunde loggen, um "hängende" Ventile zu erkennen
    changesMinDelta: 2, // Loggt nur bei Änderungen > 2%
    storageType: 'Number'
};

// Für reine Boolean-Werte (true/false)
const booleanConfig = {
    enabled: true,
    debounce: 0,
    changesOnly: true,
    changesRelog: 0,
    changesMinDelta: 0,
    storageType: 'Boolean'
};

// Für berechnete Analyse-Werte (Solar/Wind-Faktoren)
const analysisConfig = {
    enabled: true,
    debounce: 0,
    changesOnly: true,
    changesRelog: 0,
    changesMinDelta: 0.01, // Loggt nur bei signifikanten Faktor-Änderungen
    storageType: 'Number'
};

// Für die selten geänderten Lernwerte
const learningConfig = {
    enabled: true,
    debounce: 0,
    changesOnly: true,
    changesRelog: 0,
    changesMinDelta: 0,
    storageType: 'Number'
};


// =====================================================================================
// 2. LISTE ALLER ZU LOGGENDEN DATENPUNKTE
// =====================================================================================

const datenpunkte = {
    // --- Thermostate (Ist, Soll, Feuchte, Ventil) ---
    'hm-rpc.2.INT0000005.1.ACTUAL_TEMPERATURE': tempConfig,       // Wohnzimmer Ist-Temp
    'hm-rpc.2.INT0000005.1.SET_POINT_TEMPERATURE': setpointConfig, // Wohnzimmer Soll-Temp
    'hm-rpc.2.INT0000005.1.HUMIDITY': humidityConfig,             // Wohnzimmer Feuchte
    'hm-rpc.2.INT0000005.1.LEVEL': levelConfig,                  // Wohnzimmer Ventil

    'hm-rpc.2.INT0000001.1.ACTUAL_TEMPERATURE': tempConfig,       // Schlafzimmer Ist-Temp
    'hm-rpc.2.INT0000001.1.SET_POINT_TEMPERATURE': setpointConfig, // Schlafzimmer Soll-Temp
    'hm-rpc.2.INT0000001.1.HUMIDITY': humidityConfig,             // Schlafzimmer Feuchte
    'hm-rpc.2.INT0000001.1.LEVEL': levelConfig,                  // Schlafzimmer Ventil

    'hm-rpc.2.INT0000002.1.ACTUAL_TEMPERATURE': tempConfig,       // Badezimmer Ist-Temp
    'hm-rpc.2.INT0000002.1.SET_POINT_TEMPERATURE': setpointConfig, // Badezimmer Soll-Temp
    'hm-rpc.2.INT0000002.1.HUMIDITY': humidityConfig,             // Badezimmer Feuchte
    'hm-rpc.2.INT0000002.1.LEVEL': levelConfig,                  // Badezimmer Ventil

    'hm-rpc.2.INT0000003.1.ACTUAL_TEMPERATURE': tempConfig,       // Kueche Ist-Temp
    'hm-rpc.2.INT0000003.1.SET_POINT_TEMPERATURE': setpointConfig, // Kueche Soll-Temp
    'hm-rpc.2.INT0000003.1.HUMIDITY': humidityConfig,             // Kueche Feuchte
    'hm-rpc.2.INT0000003.1.LEVEL': levelConfig,                  // Kueche Ventil

    'hm-rpc.2.INT0000004.1.ACTUAL_TEMPERATURE': tempConfig,       // Esszimmer Ist-Temp
    'hm-rpc.2.INT0000004.1.SET_POINT_TEMPERATURE': setpointConfig, // Esszimmer Soll-Temp
    'hm-rpc.2.INT0000004.1.LEVEL': levelConfig,                  // Esszimmer Ventil

    // --- Externe Sensoren ---
    'hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE': tempConfig,  // Außentemperatur
    'hm-rpc.0.002822699B7D20.1.ACTUAL_TEMPERATURE': tempConfig,  // WandSensor Oberfläche (Wohnzimmer/Schlafzimmer)
    'hm-rpc.0.002822699B7D20.2.ACTUAL_TEMPERATURE_STATUS': tempConfig, // WandSensor Kern (Wohnzimmer/Schlafzimmer)
    'hm-rpc.0.002822699B7E86.1.ACTUAL_TEMPERATURE': tempConfig,  // WandSensor Kern (Bad/Küche/Esszimmer)
    'hm-rpc.0.002822699B7E86.2.ACTUAL_TEMPERATURE': tempConfig,  // WandSensor Oberfläche (Bad)
    
    // --- Fenster- & Türkontakte ---
    'hm-rpc.0.00109A49A44D25.1.STATE': booleanConfig, // Wohnzimmer Fenster
    'hm-rpc.0.0023DF299CD2BD.1.STATE': booleanConfig, // Wohnzimmer Tür
    'hm-rpc.0.00109A49A438EA.1.STATE': booleanConfig, // Schlafzimmer Fenster
    'hm-rpc.0.0023DA49A3B9FF.1.STATE': booleanConfig, // Schlafzimmer Tür
    'hm-rpc.0.0023DA49A3CC62.1.STATE': booleanConfig, // Bad Fenster
    'hm-rpc.0.0023DF299CC991.1.STATE': booleanConfig, // Bad Tür
    'hm-rpc.0.0023DA49A3CC5A.1.STATE': booleanConfig, // Küche Fenster
    'hm-rpc.0.0023DA49A3B05C.1.STATE': booleanConfig, // Esszimmer Fenster

    // --- Globale System-Zustände ---
    '0_userdata.0.Heizung.Allgemein.HeizperiodeAktiv': booleanConfig,
    '0_userdata.0.Anwesenheit.Status': booleanConfig,
    '0_userdata.0.System.Nachtschaltung.Aktiv': booleanConfig,
    '0_userdata.0.Heizung.sollTempAnwesend': setpointConfig,
    '0_userdata.0.Heizung.sollTempAbwesend': setpointConfig,
    
    // --- Wetter-Analyse-Ergebnisse ---
    '0_userdata.0.Heizung.Analyse.Wetter_Heizunterstuetzung_Solar_Nord': analysisConfig,
    '0_userdata.0.Heizung.Analyse.Wetter_Heizunterstuetzung_Solar_Ost': analysisConfig,
    '0_userdata.0.Heizung.Analyse.Wetter_Heizunterstuetzung_Solar_Sued': analysisConfig,
    '0_userdata.0.Heizung.Analyse.Wetter_Heizunterstuetzung_Solar_West': analysisConfig,
    '0_userdata.0.Heizung.Analyse.Wetter_Waermeverlust_Wind_Nord': analysisConfig,
    '0_userdata.0.Heizung.Analyse.Wetter_Waermeverlust_Wind_Ost': analysisConfig,
    '0_userdata.0.Heizung.Analyse.Wetter_Waermeverlust_Wind_Sued': analysisConfig,
    '0_userdata.0.Heizung.Analyse.Wetter_Waermeverlust_Wind_West': analysisConfig,

    // --- Lern-Werte (ML-Skript) ---
    '0_userdata.0.Heizung.Lernwerte.Wohnzimmer.Solar_Korrektur': learningConfig,
    '0_userdata.0.Heizung.Lernwerte.Wohnzimmer.Wind_Korrektur': learningConfig,
    '0_userdata.0.Heizung.Lernwerte.Schlafzimmer.Solar_Korrektur': learningConfig,
    '0_userdata.0.Heizung.Lernwerte.Schlafzimmer.Wind_Korrektur': learningConfig,
    '0_userdata.0.Heizung.Lernwerte.Badezimmer.Solar_Korrektur': learningConfig,
    '0_userdata.0.Heizung.Lernwerte.Badezimmer.Wind_Korrektur': learningConfig,
    '0_userdata.0.Heizung.Lernwerte.Kueche.Solar_Korrektur': learningConfig,
    '0_userdata.0.Heizung.Lernwerte.Kueche.Wind_Korrektur': learningConfig,
    '0_userdata.0.Heizung.Lernwerte.Esszimmer.Solar_Korrektur': learningConfig,
    '0_userdata.0.Heizung.Lernwerte.Esszimmer.Wind_Korrektur': learningConfig, // Tippfehler 'Esszimer' im Originalskript korrigiert

    // --- Zentrale Steuerung ---
    '0_userdata.0.Heizung.Zentral.StatusTherme': booleanConfig,
    '0_userdata.0.Heizung.Zentral.HoechsteAnforderungTemp': setpointConfig,
    'mqtt.0.ebusd.700.Hc1HeatCurve.set': analysisConfig, // Loggt die an die Therme gesendete Heizkurve
    'mqtt.0.ebusd.700.Z1DayTemp.set': setpointConfig, // Loggt die an die Therme gesendete Tagestemperatur
};


// =====================================================================================
// 3. AUSFÜHRUNGSLOGIK
// =====================================================================================

async function configureLogging() {
    log(`${LOG_PREFIX} Starte die Konfiguration von ${Object.keys(datenpunkte).length} Datenpunkten...`);

    for (const id in datenpunkte) {
        const config = datenpunkte[id];
        
        try {
            // Prüfen, ob der Datenpunkt existiert, bevor wir versuchen, ihn zu konfigurieren
            if (!(await existsStateAsync(id))) {
                log(`${LOG_PREFIX} WARNUNG: Datenpunkt '${id}' existiert nicht und wird übersprungen.`, 'warn');
                continue;
            }

            const result = await sendToAsync(INFLUXDB_INSTANCE, 'enableHistory', {
                id: id,
                options: config
            });

            if (result.error) {
                log(`${LOG_PREFIX} FEHLER bei '${id}': ${result.error}`, 'error');
            } else if (result.success) {
                log(`${LOG_PREFIX} ERFOLG: Logging für '${id}' wurde konfiguriert.`);
            }
        } catch (e) {
            log(`${LOG_PREFIX} KRITISCHER FEHLER bei der Verarbeitung von '${id}': ${e}`, 'error');
        }
    }

    log(`${LOG_PREFIX} Konfiguration für alle Datenpunkte abgeschlossen.`);
}

// --- Skriptstart ---
configureLogging();
