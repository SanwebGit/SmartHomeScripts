/**
 * ==============================================================================
 * ioBroker Script: Automatische Bettbeleuchtung
 * ==============================================================================
 * @version   1.0.0
 * @author    Sanweb
 * @license   MIT License
 * * @description
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
    timerMs: 2 * 60 * 1000,  // 2 Minuten Timer-Dauer
    defaultNachtWert: 'Tag', // Fallback-Wert für Tag/Nacht
    nachtWert: 'Nacht',      // Expliziter Vergleichswert für Nacht
    enableDebug: true,       // Debug-Logging steuern (auf false setzen für produktiven, leisen Betrieb)
    logPrefix: '[Bettlicht] ' // Präfix für alle Log-Ausgaben zur besseren Übersicht
  };

  // ============================================
  // Datenpunkte
  // ============================================
  const DP = {
    links: {
      led:      'zigbee2mqtt.0.0xa4c13852a863096b.state',      // Zigbee LED-Lichtschalter
      motion:   'zigbee2mqtt.0.0xa4c1387d7ee56494.presence',  // Zigbee Bewegungsmelder
      matte:    'hm-rpc.0.001E1D899E94B0.1.STATE'             // Homematic Kontaktmatte (Bett belegt)
    },
    rechts: {
      led:      'zigbee2mqtt.0.0xa4c138da7c22e582.state',      // Zigbee LED-Lichtschalter
      motion:   'zigbee2mqtt.0.0xa4c138f5aeea45b6.presence',  // Zigbee Bewegungsmelder
      matte:    'hm-rpc.0.001E1D899E922D.1.STATE'             // Homematic Kontaktmatte (Bett belegt)
    },
    nacht:    '0_userdata.0.System.Astro.TagNacht'            // Globale Astro-Variable (Tag/Nacht)
  };

  // Timer-Referenz-Objekt
  const TIMERS = {
    links: null,
    rechts: null
  };

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
    if (CONFIG.enableDebug) scriptLog(msg, 'debug');
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
    DP.links.led, DP.links.motion, DP.links.matte,
    DP.rechts.led, DP.rechts.motion, DP.rechts.matte,
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
    return; // Beendet die IIFE hier -> Skript läuft nicht weiter
  }
  
  scriptLog('Systemprüfung bestanden. Alle Datenpunkte vorhanden.', 'info');

  // Skript-Stop-Handler (Verhindert Memory Leaks/Geister-Schaltungen beim Neustart)
  onStop(function() {
    clearAllTimers();
    scriptLog('Skript wurde gestoppt. Alle aktiven Beleuchtungs-Timer wurden bereinigt.', 'info');
  }, 1000);

  // ============================================
  // Hilfsfunktionen: Zustände lesen & schreiben
  // ============================================
  function getSideStates(side) {
    return {
      motion: getState(DP[side].motion)?.val ?? false,
      matte:  getState(DP[side].matte)?.val ?? false
    };
  }

  function setLight(side, state) {
    const ledId = DP[side].led;
    // Typsicherheit: Falls getState null zurückgibt, gehen wir von false (aus) aus
    const currentVal = getState(ledId)?.val ?? false;

    // Nur schalten, wenn sich der Zustand ändert (Zigbee-Schonung)
    if (currentVal === state) {
      debugLog(`Licht ${side}: bereits ${state ? 'AN' : 'AUS'}, kein Schaltbefehl`);
      return;
    }

    setState(ledId, state);
    scriptLog(`Licht ${side}: ${state ? 'AN' : 'AUS'}`, 'info');
  }

  // ============================================
  // Hauptlogik: Seite verarbeiten
  // ============================================
  function processSide(side, motionVal, matteVal, nachtVal) {
    // Nur bei Nacht verarbeiten
    if (nachtVal !== CONFIG.nachtWert) {
      setLight(side, false);
      clearSideTimer(side);
      return;
    }

    // Logik: Matte=false (niemand im Bett) UND Motion=true (Bewegung)
    if (matteVal === false && motionVal === true) {
      // Licht einschalten
      setLight(side, true);

      // Vorherigen Timer löschen und neuen setzen
      clearSideTimer(side);
      TIMERS[side] = setTimeout(() => {
        setLight(side, false);
        TIMERS[side] = null;
      }, CONFIG.timerMs);

      debugLog(`Timer ${side} gestartet (${CONFIG.timerMs / 60000} Min)`);
    } else if (matteVal === true) {
      // Person im Bett → Licht aus, Timer löschen
      setLight(side, false);
      clearSideTimer(side);
      debugLog(`Seite ${side}: Person im Bett, Licht bleibt AUS`);
    }
  }

  // ============================================
  // Trigger Generierung (DRY)
  // ============================================
  ['links', 'rechts'].forEach(side => {
    function handleTrigger() {
      const states = getSideStates(side);
      const nachtVal = getState(DP.nacht)?.val ?? CONFIG.defaultNachtWert;
      processSide(side, states.motion, states.matte, nachtVal);
    }

    on(DP[side].motion, handleTrigger);
    on(DP[side].matte, handleTrigger);
  });

  // ============================================
  // Trigger: Tag/Nacht Wechsel
  // ============================================
  on(DP.nacht, function(obj) {
    const nachtVal = obj.state?.val ?? CONFIG.defaultNachtWert;

    if (nachtVal !== CONFIG.nachtWert) {
      // Tag → beide Lichter aus, Timer explizit löschen
      setLight('links', false);
      setLight('rechts', false);
      clearAllTimers();
      scriptLog('INFO: Tag erkannt → Beleuchtung deaktiviert, alle aktiven Timer wurden gelöscht.', 'info');
    } else {
      scriptLog('Nacht erkannt → Beleuchtung aktiv, prüfe aktuelle Zustände', 'info');
      // Bei Nacht-Wechsel beide Seiten prüfen
      const links = getSideStates('links');
      const rechts = getSideStates('rechts');
      
      processSide('links', links.motion, links.matte, nachtVal);
      processSide('rechts', rechts.motion, rechts.matte, nachtVal);
    }
  });

  // ============================================
  // Initialisierung beim Start
  // ============================================
  scriptLog('Bettbeleuchtung-Skript wird initialisiert...', 'info');
  
  const nachtVal = getState(DP.nacht)?.val ?? CONFIG.defaultNachtWert;
  const links    = getSideStates('links');
  const rechts   = getSideStates('rechts');
  
  // Startup-Log für leichteres Debugging
  scriptLog(`Start-Zustände geladen - Modus: ${nachtVal}`, 'info');
  debugLog(`Werte Links  -> Matte belegt: ${links.matte}, Bewegung: ${links.motion}`);
  debugLog(`Werte Rechts -> Matte belegt: ${rechts.matte}, Bewegung: ${rechts.motion}`);
  
  processSide('links', links.motion, links.matte, nachtVal);
  processSide('rechts', rechts.motion, rechts.matte, nachtVal);
  
  scriptLog('Bettbeleuchtung-Skript erfolgreich gestartet.', 'info');

})();