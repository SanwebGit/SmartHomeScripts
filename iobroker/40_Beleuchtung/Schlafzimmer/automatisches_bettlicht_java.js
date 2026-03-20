/**
 * ==============================================================================
 * ioBroker Script: Automatische Bettbeleuchtung
 * ==============================================================================
 * @version   1.2.0 (Native Zigbee2MQTT Version)
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
    nachtWert: 'Nacht',       // Expliziter Vergleichswert für Nacht.
    enableDebug: true,        // Diagnose-Logging steuern
    forceSend: true,          // true = Befehle immer senden (auch wenn Status schon scheinbar korrekt)
    invertMatte: true,        // Auf true setzen, falls die Matte 1/true sendet, wenn sie LEER ist
    logPrefix: '[Bettlicht] ' // Präfix für alle Log-Ausgaben
  };

  // ============================================
  // Datenpunkte (Native Zigbee2MQTT)
  // ============================================
  const DP = {
    links: {
      ledCmd:   'zigbee2mqtt.0.0xa4c13852a863096b.state',     // Native LED State (Links)
      motion:   'zigbee2mqtt.0.0xa4c1387d7ee56494.presence',  // Zigbee Bewegungsmelder
      matte:    'hm-rpc.0.001E1D899E94B0.1.STATE'             // Homematic Kontaktmatte
    },
    rechts: {
      ledCmd:   'zigbee2mqtt.0.0xa4c138da7c22e582.state',     // Native LED State (Rechts)
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
  
  function parseBool(val) {
    return (val === true || val === 'true' || val === 1 || val === '1');
  }

  function getMatteOccupiedState(rawVal) {
    let isOccupied = parseBool(rawVal);
    if (CONFIG.invertMatte) {
      isOccupied = !isOccupied; 
    }
    return isOccupied;
  }

  // ============================================
  // Hilfsfunktionen: Logging & Timer Cleanup
  // ============================================
  
  /**
   * @param {string} msg 
   * @param {'info' | 'warn' | 'error' | 'debug'} [level='info']
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

  const requiredDPs = [
    DP.links.ledCmd, DP.links.motion, DP.links.matte,
    DP.rechts.ledCmd, DP.rechts.motion, DP.rechts.matte,
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
    const rawCurrent = existsState(ledCmdId) ? getState(ledCmdId)?.val : null;

    // Nur schalten, wenn forceSend aktiv ist oder der Zustand abweicht
    if (!CONFIG.forceSend && rawCurrent === state) {
      debugLog(`Licht ${side}: bereits ${state ? 'AN' : 'AUS'}, blockiert durch Schonung`);
      return;
    }

    // Nativer Blockly-Weg: Boolean senden mit ack=false (als 3. Parameter explizit auf false)
    setState(ledCmdId, state, false);
    scriptLog(`Licht ${side}: ${state ? 'AN' : 'AUS'} (Native State: ${state})`, 'info');
  }

  // ============================================
  // Hauptlogik: Seite verarbeiten
  // ============================================
  function processSide(side, isMotion, isMatteOccupied, nachtVal) {
    const isNight = (nachtVal === CONFIG.nachtWert);
    const isMatteEmpty = !isMatteOccupied;

    debugLog(`[Logik-Prüfung ${side}] Nacht? ${isNight} ('${nachtVal}') | Matte leer? ${isMatteEmpty} | Bewegung? ${isMotion}`);

    if (!isNight) {
      setLight(side, false);
      clearSideTimer(side);
      return;
    }

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
    }
  }

  // ============================================
  // Trigger Generierung
  // ============================================
  ['links', 'rechts'].forEach(side => {
    
    on({ id: DP[side].motion, change: 'any' }, function(obj) {
      const motionVal = parseBool(obj.state?.val);
      const isOccupied = getMatteOccupiedState(getState(DP[side].matte)?.val);
      const nachtVal  = getState(DP.nacht)?.val ?? CONFIG.defaultNachtWert;
      
      debugLog(`[Trigger Bewegung ${side}] Motion: ${motionVal}`);
      processSide(side, motionVal, isOccupied, nachtVal);
    });

    on({ id: DP[side].matte, change: 'any' }, function(obj) {
      const isOccupied = getMatteOccupiedState(obj.state?.val);
      const motionVal = parseBool(getState(DP[side].motion)?.val);
      const nachtVal  = getState(DP.nacht)?.val ?? CONFIG.defaultNachtWert;
      
      debugLog(`[Trigger Matte ${side}] Belegt: ${isOccupied}`);
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
      scriptLog('INFO: Tag erkannt → Beleuchtung deaktiviert.', 'info');
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
  scriptLog('Bettbeleuchtung-Skript (Native Version) wird initialisiert...', 'info');
  
  const nachtVal = getState(DP.nacht)?.val ?? CONFIG.defaultNachtWert;
  const links    = getSideStates('links');
  const rechts   = getSideStates('rechts');
  
  processSide('links', links.motion, links.isOccupied, nachtVal);
  processSide('rechts', rechts.motion, rechts.isOccupied, nachtVal);
  
  scriptLog('Bettbeleuchtung-Skript erfolgreich gestartet.', 'info');

})();