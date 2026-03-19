/**
 * ==============================================================================
 * ioBroker Script: Automatische Bettbeleuchtung
 * ==============================================================================
 * @version   1.0.8
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
    forceSend: true,          // HACK: Auf true setzen, um die Zigbee-Schonung zu ignorieren (wird bei useToggle ignoriert!)
    invertMatte: true,        // Auf true setzen, falls die Matte 1/true sendet, wenn sie LEER ist
    sendAsString: false,      // Setze auf true, falls Zigbee2MQTT zwingend "ON"/"OFF" als Text verlangt
    useToggle: true,          // FIX: Nutzt den state_toggle Button zum Schalten, liest aber den Status von state (für zickige Zigbee-Relais)
    logPrefix: '[Bettlicht] ' // Präfix für alle Log-Ausgaben
  };

  // ============================================
  // Datenpunkte
  // ============================================
  const DP = {
    links: {
      led:      'zigbee2mqtt.0.0xa4c13852a863096b.state',        // Lese-Status der LED
      toggle:   'zigbee2mqtt.0.0xa4c13852a863096b.state_toggle', // Toggle-Button der LED
      motion:   'zigbee2mqtt.0.0xa4c1387d7ee56494.presence',     // Zigbee Bewegungsmelder
      matte:    'hm-rpc.0.001E1D899E94B0.1.STATE'                // Homematic Kontaktmatte
    },
    rechts: {
      led:      'zigbee2mqtt.0.0xa4c138da7c22e582.state',        // Lese-Status der LED
      toggle:   'zigbee2mqtt.0.0xa4c138da7c22e582.state_toggle', // Toggle-Button der LED
      motion:   'zigbee2mqtt.0.0xa4c138f5aeea45b6.presence',     // Zigbee Bewegungsmelder
      matte:    'hm-rpc.0.001E1D899E922D.1.STATE'                // Homematic Kontaktmatte
    },
    nacht:    '0_userdata.0.System.Astro.TagNacht'               // Globale Astro-Variable (Tag/Nacht)
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
    if (val === null || val === undefined) return false;
    
    if (typeof val === 'string') {
      const lower = val.trim().toLowerCase();
      if (lower === 'true' || lower === '1' || lower === 'on') return true;
      if (lower === 'false' || lower === '0' || lower === 'off') return false;
    }
    
    if (typeof val === 'number') {
      return val > 0;
    }
    
    return Boolean(val);
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
  
  const requiredDPs = [
    DP.links.led, DP.links.toggle, DP.links.motion, DP.links.matte,
    DP.rechts.led, DP.rechts.toggle, DP.rechts.motion, DP.rechts.matte,
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
    const ledId = DP[side].led;
    const rawCurrent = getState(ledId)?.val;
    const currentVal = parseBool(rawCurrent);

    // TOGGLE-MODUS (Hardware Workaround)
    if (CONFIG.useToggle) {
      if (currentVal === state) {
        debugLog(`Licht ${side}: ist bereits ${state ? 'AN' : 'AUS'} (RAW: ${rawCurrent}), Toggle wird übersprungen`);
        return;
      }
      const toggleId = DP[side].toggle;
      setState(toggleId, true, false); // Button in ioBroker drücken
      scriptLog(`Licht ${side}: ${state ? 'AN' : 'AUS'} (Befehl gesendet via TOGGLE)`, 'info');
      return;
    }

    // NORMALER MODUS
    if (!CONFIG.forceSend && currentVal === state) {
      debugLog(`Licht ${side}: bereits ${state ? 'AN' : 'AUS'}, blockiert durch Schonung`);
      return;
    }

    let payload = state; 
    if (CONFIG.sendAsString) {
      payload = state ? 'ON' : 'OFF';
    }

    setState(ledId, payload, false);
    scriptLog(`Licht ${side}: ${state ? 'AN' : 'AUS'} (Befehl gesendet als: ${payload})`, 'info');
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