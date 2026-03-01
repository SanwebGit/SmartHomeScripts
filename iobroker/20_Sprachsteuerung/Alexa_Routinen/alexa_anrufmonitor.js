/*
 * Dieses Skript überwacht eingehende Anrufe über den tr-064-Adapter,
 * kündigt den Anrufer über Alexa an und sendet eine Benachrichtigung via Pushover.
 * Die Ankündigung wird in einem definierten Intervall wiederholt, bis der Anruf
 * angenommen oder beendet wird.
 *
 * Optimierungen:
 * - Umgestellt auf moderne asynchrone Programmierung (async/await) für bessere Lesbarkeit.
 * - Detailliertes Logging für eine einfache Fehlersuche hinzugefügt.
 * - Pushover-Benachrichtigung um einen Titel erweitert.
 * - Log-Ausgaben haben das Präfix [TR064] -> für bessere Filterbarkeit.
 */

// ====================================================================
// KONFIGURATION
// ====================================================================
// Hier können alle anpassbaren Datenpunkte und Werte zentral bearbeitet werden.

// --- Ziel-Datenpunkte & Adapter ---
// Datenpunkt für die Alexa-Sprachausgabe
// @ts-ignore
const DP_ALEXA_SPEAK = 'alexa2.0.Echo-Devices.G2A14Q04010604DL.Commands.speak';
// Instanz des Pushover-Adapters (Standard: 'pushover.0')
const PUSHOVER_INSTANCE = 'pushover.0';

// --- TR-064 Adapter Datenpunkte (Quelle) ---
// Datenpunkt, der das Klingeln signalisiert
const DP_RINGING = 'tr-064.0.callmonitor.ringing';
// Datenpunkt, der den Status des Anrufs anzeigt (ring, connect, end)
const DP_CALL_STATUS = 'tr-064.0.callmonitor.toPauseState';
// Datenpunkt für den Namen des Anrufers
const DP_CALLER_NAME = 'tr-064.0.callmonitor.inbound.callerName';
// Datenpunkt für die Nummer des Anrufers
const DP_CALLER_NUMBER = 'tr-064.0.callmonitor.inbound.caller';

// --- Zeitsteuerung ---
// Wiederholungsintervall für die Alexa-Ansage in Millisekunden (z.B. 8000ms = 8s)
const REPEAT_INTERVAL_MS = 8000;
// Kurze Verzögerung nach dem Klingeln, um stabile Werte abzuwarten
const INITIAL_DELAY_MS = 1000;

// ====================================================================
// SKRIPT-LOGIK - AB HIER NORMALERWEISE KEINE ÄNDERUNGEN NÖTIG
// ====================================================================

// Hilfsfunktion, um eine Verzögerung in async Funktionen zu ermöglichen
const delay = ms => new Promise(res => setTimeout(res, ms));

// Definition der Timer-Variablen im globalen Geltungsbereich
let intervall; // Nur noch der Intervall-Timer wird global benötigt

/**
 * Erzeugt die Ansage- und Benachrichtigungexte und steuert die entsprechenden Datenpunkte.
 * @param {string} caller - Die Rufnummer des Anrufers.
 * @param {string} callerName - Der Name des Anrufers (falls bekannt).
 * @param {boolean} sendNotification - Wenn true, wird die Pushover-Nachricht gesendet.
 */
function announceCall(caller, callerName, sendNotification) {
  let speakMsg;
  let pushoverMsg;

  if (!callerName && !caller) {
    // Fall 1: Weder Name noch Nummer sind bekannt
    speakMsg = 'Ein Anruf von Unbekannt';
    pushoverMsg = 'Ein Anruf von Unbekannt';
  } else if (!callerName) {
    // Fall 2: Nur die Nummer ist bekannt
    speakMsg = `Ein Anruf von ${caller}`;
    pushoverMsg = `Ein Anruf von ${caller}!`;
  } else {
    // Fall 3: Der Name ist bekannt
    speakMsg = `Ein Anruf von ${callerName}`;
    pushoverMsg = `Ein Anruf von ${callerName}!`;
  }

  // Alexa-Ansage ausführen
  log(`[TR064] -> Spreche auf Alexa: "${speakMsg}"`);
  setState(DP_ALEXA_SPEAK, speakMsg);

  // Pushover-Nachricht nur beim ersten Klingeln senden
  if (sendNotification) {
    log(`[TR064] -> Sende Pushover-Nachricht: "${pushoverMsg}"`);
    sendTo(PUSHOVER_INSTANCE, 'send', {
        message: pushoverMsg,
        title: 'Eingehender Anruf', // Verbesserte Benachrichtigung mit Titel
        sound: 'none',
        priority: 0
    });
  }
}

// Trigger, der bei einem eingehenden Anruf ausgelöst wird
// Die Funktion ist jetzt 'async', um 'await' verwenden zu können
on({ id: DP_RINGING, val: true }, async function (obj) {
  log('[TR064] -> Eingehender Anruf erkannt. Starte Ablauf...');
  
  // Bestehenden Wiederholungs-Timer löschen, um Überschneidungen zu verhindern.
  if (intervall) clearInterval(intervall);

  // Warte, um sicherzustellen, dass der Anrufstatus stabil ist (ersetzt setTimeout).
  await delay(INITIAL_DELAY_MS);
  
  const initialCallStatusState = getState(DP_CALL_STATUS);
  if (!initialCallStatusState || initialCallStatusState.val !== 'ring') {
      log('[TR064] -> Anruf wurde anscheinend beendet, bevor die Verarbeitung gestartet wurde. Breche ab.', 'warn');
      return;
  }

  // Warte eine weitere Sekunde, bevor die finalen Anruferinformationen geholt werden.
  await delay(INITIAL_DELAY_MS);
  
  const callerName = getState(DP_CALLER_NAME).val;
  const caller = getState(DP_CALLER_NUMBER).val;
  log(`[TR064] -> Anrufer-Informationen abgerufen: Name="${callerName || 'nicht bekannt'}", Nummer="${caller || 'nicht bekannt'}"`);
  
  // Führe die erste Ansage aus und sende die Benachrichtigung.
  announceCall(caller, callerName, true);

  // Starte ein Intervall, um die Ansage zu wiederholen.
  log(`[TR064] -> Starte Wiederholungs-Intervall alle ${REPEAT_INTERVAL_MS / 1000} Sekunden.`);
  intervall = setInterval(() => {
    const callStatus = getState(DP_CALL_STATUS).val;
    
    // Stoppe die Wiederholung, wenn der Anruf angenommen ('connect') oder beendet ('end') wird.
    if (callStatus === 'end' || callStatus === 'connect') {
      log(`[TR064] -> Anrufstatus ist '${callStatus}'. Stoppe Wiederholungen.`);
      clearInterval(intervall);
    } else {
      // Wiederhole die Ansage über Alexa (ohne neue Pushover-Benachrichtigung).
      log('[TR064] -> Wiederhole Anruf-Ansage auf Alexa ...');
      announceCall(caller, callerName, false);
    }
  }, REPEAT_INTERVAL_MS);
});

log("[TR064] -> Anrufmonitor-Skript gestartet und bereit für eingehende Anrufe.");

