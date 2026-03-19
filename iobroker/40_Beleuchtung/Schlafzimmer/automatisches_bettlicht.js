/**
 * ==============================================================================
 * ioBroker Script: Automatische Bettbeleuchtung
 * ==============================================================================
 * @version   1.1.0
 * @author    Sanweb
 * @license   MIT License
 * @description
 * Automatische Bettbeleuchtung mit Nacht-Logik.
 * Logik: Licht nur bei Nacht, wenn Kontaktmatte=false UND Bewegung=true.
 * Timer: 2 Minuten, retriggert bei erneuter Bewegung.
 * ==============================================================================
 */
(function() {
  "use strict";

  // ============================================
  // Konfiguration
  // ============================================
  const CONFIG = {
    timerMs: 2 * 60 * 1000,   // 2 Minuten Timer-Dauer
    defaultNachtWert: 'Tag',  // Fallback-Wert für Tag/Nacht
    nachtWert: 'Nacht',       // Expliziter Vergleichswert für Nacht. ACHTUNG: Groß/Kleinschreibung beachten!
    enableDebug: true,        // Diagnose-Logging steuern
    forceSend: true,          // Empfohlen bei MQTT .set Datenpunkten: Befehle immer senden
    invertMatte: true,        // Auf true setzen, falls die Matte 1/true sendet, wenn sie LEER ist
    logPrefix: '[Bettlicht] ' // Präfix für alle Log-Ausgaben
  };

  // ============================================
  // Datenpunkte
  // ============================================
  const DP = {
    links: {
      ledCmd:   'mqtt.1.zigbee2mqtt.Bettlicht_Rosie.set',     // MQTT Set-Datenpunkt für links
      motion:   'zigbee2mqtt.0.0xa4c1387d7ee56494.presence',  // Zigbee Bewegungsmelder
      matte:    'hm-rpc.0.001E1D899E94B0.1.STATE'             // Homematic Kontaktmatte
    },
    rechts: {
      ledCmd:   'mqtt.1.zigbee2mqtt.Bettlicht_Alex.set',      // MQTT Set-Datenpunkt für rechts
      motion:   'zigbee2mqtt.0.0xa4c138f5aeea45b6.presence',  // Zigbee Bewegungsmelder
      matte:    'hm-rpc.0.001E1D899E922D.1.STATE'             // Homematic Kontaktmatte
    },
    nacht:    '0_userdata.0.System.Astro.TagNacht'            // Globale Astro-Variable (Tag/Nacht)
  };

  // Timer-Referenz-Objekt
  const TIMERS = {
    links: null,
    rechts: null
  };

  // ============================================
  // Hilfsfunktionen: Datentypen normieren
  // ============================================
  
  /**
   * Kompakte Prüfung für Sensor-Eingänge (Motion & Matte).
   * Erfasst true, "true", 1 und "1" sicher als wahr. Alles andere ist false.
   */
  function parseBool(val) {
    return (val === true || val === 'true' || val === 1 || val === '1');
  }

  // Wandelt den rohen Mattenwert in einen logischen "Belegt"-Zustand um
  function getMatteOccupiedState(rawVal) {
    let isOccupied = parseBool(rawVal);
    if (CONFIG.invertMatte) {
      isOccupied = !isOccupied; // Dreht die Logik um, falls invertMatte true ist
    }
    return isOccupied;
  }

  // ============================================
  // Hilfsfunktionen: Logging & Timer Cleanup
  // ============================================
  
  /**
   * Loggt eine Nachricht mit dem konfigurierten Präfix
   * @param {string} msg - Die Log-Nachricht
   * @param {'info' | 'warn' | 'error' | 'debug' | 'silly'} [level='info'] - Das ioBroker Log-Level
   */
  function scriptLog(msg, level = 'info') {
    log(CONFIG.logPrefix + msg, level);
  }

  function debugLog(msg) {
    if (CONFIG.enableDebug) scriptLog(msg, 'info'); 
  }

  function clearSideTimer(side) {
    if (TIMERS[side]) {
      clearTimeout(TIMERS[side]);
      TIMERS[side] = null;
      debugLog(`Timer ${side} zurückgesetzt`);
    }
  }

  function clearAllTimers() {
    clearSideTimer('links');
    clearSideTimer('rechts');
  }

  // ============================================
  // Systemprüfung: Vorhandensein der Datenpunkte
  // ============================================
  scriptLog('Führe Systemprüfung der Datenpunkte durch...', 'info');
  
  // MQTT Datenpunkte prüfen und ggf. automatisch anlegen
  const mqttDPs = [DP.links.ledCmd, DP.rechts.ledCmd];
  for (const id of mqttDPs) {
    if (!existsState(id)) {
      scriptLog(`MQTT Datenpunkt ${id} fehlt. Versuche Erstellung in fremdem Namensraum...`, 'warn');
      
      setObject(id, {
        type: 'state',
        common: {
          name: id.split('.').pop(),
          type: 'string',
          role: 'state',
          read: true,
          write: true,
          desc: 'Automatisch angelegt durch Bettlicht-Skript'
        },
        native: {}
      }, function(err) {
        if (err) {
          scriptLog(`FEHLER beim Anlegen von ${id}: ${err} -> Bitte in den JavaScript-Instanz-Einstellungen "Erlaube das Kommando setObj" aktivieren!`, 'error');
        } else {
          scriptLog(`Erfolgreich angelegt: ${id}`, 'info');
          // Startwert setzen
          setState(id, JSON.stringify({ state: "OFF" }), true);
        }
      });
    }
  }

  // Für Sensoren wird strikt geprüft (Skriptabbruch bei Fehlen)
  const requiredDPs = [
    DP.links.motion, DP.links.matte,
    DP.rechts.motion, DP.rechts.matte,
    DP.nacht
  ];
  
  let hasMissingDP = false;
  for (const id of requiredDPs) {
    if (!existsState(id)) {
      scriptLog(`FEHLER: Datenpunkt fehlt im System -> ${id}`, 'error');
      hasMissingDP = true;
    }
  }

  if (hasMissingDP) {
    scriptLog('Skriptabbruch! Es fehlen Datenpunkte. Keine Trigger registriert.', 'error');
    return;
  }
  
  scriptLog('Systemprüfung bestanden. Alle Datenpunkte vorhanden.', 'info');

  onStop(function() {
    clearAllTimers();
    scriptLog('Skript wurde gestoppt. Alle aktiven Beleuchtungs-Timer wurden bereinigt.', 'info');
  }, 1000);

  // ============================================
  // Hilfsfunktionen: Zustände lesen & schreiben
  // ============================================
  function getSideStates(side) {
    return {
      motion: parseBool(getState(DP[side].motion)?.val),
      isOccupied: getMatteOccupiedState(getState(DP[side].matte)?.val)
    };
  }

  function setLight(side, state) {
    const ledCmdId = DP[side].ledCmd;
    const payloadString = JSON.stringify({ state: state ? "ON" : "OFF" });

    // Letzter gesendeter Befehl (da .set kein echter Status-DP ist, enthält er nur den letzten String)
    const rawCurrent = existsState(ledCmdId) ? getState(ledCmdId)?.val : null;

    if (!CONFIG.forceSend && rawCurrent === payloadString) {
      debugLog(`Licht ${side}: bereits ${state ? 'AN' : 'AUS'}, blockiert durch Schonung`);
      return;
    }

    // WICHTIG: Das 'false' als 3. Parameter ist das ack-Flag. 
    // false = Befehl an Hardware senden (Command)
    setState(ledCmdId, payloadString, false);
    scriptLog(`Licht ${side}: ${state ? 'AN' : 'AUS'} (MQTT Payload: ${payloadString})`, 'info');
  }

  // ============================================
  // Hauptlogik: Seite verarbeiten
  // ============================================
  function processSide(side, isMotion, isMatteOccupied, nachtVal) {
    const isNight = (nachtVal === CONFIG.nachtWert);
    const isMatteEmpty = !isMatteOccupied;

    debugLog(`[Logik-Prüfung ${side}] Nacht? ${isNight} ('${nachtVal}') | Matte leer? ${isMatteEmpty} (Occupied:${isMatteOccupied}) | Bewegung? ${isMotion}`);

    if (!isNight) {
      setLight(side, false);
      clearSideTimer(side);
      return;
    }

    // Logik: Matte = leer UND Motion = true
    if (isMatteEmpty && isMotion) {
      setLight(side, true);

      clearSideTimer(side);
      TIMERS[side] = setTimeout(() => {
        setLight(side, false);
        TIMERS[side] = null;
      }, CONFIG.timerMs);

      debugLog(`Timer ${side} gestartet (${CONFIG.timerMs / 60000} Min)`);
    } else if (isMatteOccupied) {
      setLight(side, false);
      clearSideTimer(side);
      debugLog(`Seite ${side}: Person im Bett, Licht bleibt AUS`);
    }
  }

  // ============================================
  // Trigger Generierung
  // ============================================
  ['links', 'rechts'].forEach(side => {
    
    // Trigger: Bewegung
    on({ id: DP[side].motion, change: 'any' }, function(obj) {
      const motionVal = parseBool(obj.state?.val);
      const isOccupied = getMatteOccupiedState(getState(DP[side].matte)?.val);
      const nachtVal  = getState(DP.nacht)?.val ?? CONFIG.defaultNachtWert;
      
      debugLog(`[Trigger Bewegung ${side}] Motion RAW: ${obj.state?.val} -> normiert: ${motionVal}`);
      processSide(side, motionVal, isOccupied, nachtVal);
    });

    // Trigger: Kontaktmatte
    on({ id: DP[side].matte, change: 'any' }, function(obj) {
      const isOccupied = getMatteOccupiedState(obj.state?.val);
      const motionVal = parseBool(getState(DP[side].motion)?.val);
      const nachtVal  = getState(DP.nacht)?.val ?? CONFIG.defaultNachtWert;
      
      debugLog(`[Trigger Matte ${side}] Matte RAW: ${obj.state?.val} -> Belegt: ${isOccupied}`);
      processSide(side, motionVal, isOccupied, nachtVal);
    });

  });

  // ============================================
  // Trigger: Tag/Nacht Wechsel
  // ============================================
  on({ id: DP.nacht, change: 'ne' }, function(obj) {
    const nachtVal = obj.state?.val ?? CONFIG.defaultNachtWert;

    if (nachtVal !== CONFIG.nachtWert) {
      setLight('links', false);
      setLight('rechts', false);
      clearAllTimers();
      scriptLog('INFO: Tag erkannt → Beleuchtung deaktiviert, alle aktiven Timer gelöscht.', 'info');
    } else {
      scriptLog('Nacht erkannt → Beleuchtung aktiv, prüfe aktuelle Zustände', 'info');
      const links = getSideStates('links');
      const rechts = getSideStates('rechts');
      
      processSide('links', links.motion, links.isOccupied, nachtVal);
      processSide('rechts', rechts.motion, rechts.isOccupied, nachtVal);
    }
  });

  // ============================================
  // Initialisierung beim Start
  // ============================================
  scriptLog('Bettbeleuchtung-Skript wird initialisiert...', 'info');
  
  const nachtVal = getState(DP.nacht)?.val ?? CONFIG.defaultNachtWert;
  const links    = getSideStates('links');
  const rechts   = getSideStates('rechts');
  
  scriptLog(`Start-Zustände geladen - Modus: ${nachtVal}`, 'info');
  
  processSide('links', links.motion, links.isOccupied, nachtVal);
  processSide('rechts', rechts.motion, rechts.isOccupied, nachtVal);
  
  scriptLog('Bettbeleuchtung-Skript erfolgreich gestartet.', 'info');

})();