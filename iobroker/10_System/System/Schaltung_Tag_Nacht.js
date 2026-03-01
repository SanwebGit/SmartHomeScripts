/*
 * -----------------------------------------------------------------------------
 * ioBroker JavaScript: Tag/Nacht-Umschaltung per Astro-Funktion
 * -----------------------------------------------------------------------------
 * Version 3.4 (Mit Offset-Funktion)
 *
 * Dieses Skript schaltet basierend auf den in ioBroker integrierten Astro-Zeiten
 * zwischen Tag und Nacht um. Beim Start wird der aktuelle Zustand sofort
 * ermittelt und gesetzt.
 *
 * KONFIGURATION:
 * Ändern Sie die Konstante 'GEWUENSCHTER_MODUS', um den Schaltzeitpunkt anzupassen.
 * Mögliche Werte:
 * • "geometric":    Schaltet bei Sonnenauf- und -untergang (0°). Standard.
 * • "civil":        Schaltet bei bürgerlicher Dämmerung (-6°).
 * • "nautical":     Schaltet bei nautischer Dämmerung (-12°).
 * • "astronomical": Schaltet bei astronomischer Dämmerung (-18°).
 *
 * NEU: OFFSETS
 * Mit OFFSET_TAG und OFFSET_NACHT kann der Schaltzeitpunkt in Minuten verschoben werden.
 * Ein negativer Wert schaltet FRÜHER, ein positiver Wert SPÄTER.
 * * ERFORDERLICHE DATENPUNKTE (werden vom Skript automatisch angelegt):
 * • 0_userdata.0.System.Astro.Tag            -> Typ: Logikwert (true/false)
 * • 0_userdata.0.System.Astro.Nacht          -> Typ: Logikwert (true/false)
 * • 0_userdata.0.System.Astro.TagNacht       -> Typ: Zeichenkette ("Tag" oder "Nacht")
 * • 0_userdata.0.System.Astro.LetzterWechsel -> Typ: Zeichenkette
 * -----------------------------------------------------------------------------
 */

// --- KONFIGURATION ---

// IDs der Datenpunkte
const ID_TAG = "0_userdata.0.System.Astro.Tag"; // Zustand Tag: true/false
const ID_NACHT = "0_userdata.0.System.Astro.Nacht"; // Zustand Nacht: true/false
const ID_TAG_NACHT_TEXT = "0_userdata.0.System.Astro.TagNacht"; // Zustand als Text "Tag" oder "Nacht"
const ID_LETZTER_WECHSEL = "0_userdata.0.System.Astro.LetzterWechsel";

// WÄHLEN SIE HIER DEN GEWÜNSCHTEN MODUS
const GEWUENSCHTER_MODUS = "geometric"; // Mögliche Werte: "geometric", "civil", "nautical", "astronomical"

// OFFSETS IN MINUTEN (negativ = früher, positiv = später)
const OFFSET_TAG = 0;     // 0 = Pünktlich zum gewählten Astro-Event
const OFFSET_NACHT = -10; // -30 = Die Nacht wird 30 Minuten FRÜHER getriggert

// --- HILFSFUNKTIONEN UND INITIALISIERUNG ---

// Erstelle die benötigten Datenpunkte, falls sie nicht existieren
async function initialize() {
    await createStateAsync(ID_TAG, false, { name: "Status Tag", type: "boolean", role: "indicator.day", read: true, write: true });
    await createStateAsync(ID_NACHT, true, { name: "Status Nacht", type: "boolean", role: "indicator.night", read: true, write: true });
    await createStateAsync(ID_TAG_NACHT_TEXT, "Nacht", { name: "Tag/Nacht Status als Text", type: "string", role: "text", read: true, write: true });
    await createStateAsync(ID_LETZTER_WECHSEL, "", { name: "Letzter Tag/Nacht Wechsel", type: "string", role: "text", read: true, write: true });
    log("Skript für Tag/Nacht-Umschaltung gestartet und Datenpunkte sichergestellt.");
}

// Funktion zum Setzen des "Tag"-Zustands
function setStateToDay() {
    log("Schalte auf TAG.");
    setState(ID_TAG, true, true);
    setState(ID_NACHT, false, true);
    setState(ID_TAG_NACHT_TEXT, "Tag", true);
    const timestamp = formatDate(new Date(), "DD.MM.YYYY hh:mm:ss");
    setState(ID_LETZTER_WECHSEL, timestamp, true);
}

// Funktion zum Setzen des "Nacht"-Zustands
function setStateToNight() {
    log("Schalte auf NACHT.");
    setState(ID_TAG, false, true);
    setState(ID_NACHT, true, true);
    setState(ID_TAG_NACHT_TEXT, "Nacht", true);
    const timestamp = formatDate(new Date(), "DD.MM.YYYY hh:mm:ss");
    setState(ID_LETZTER_WECHSEL, timestamp, true);
}

// --- HAUPTLOGIK ---

// Mapping der Modi auf die ioBroker Astro-Event-Namen
const astroMapping = {
    'geometric':    { day: 'sunrise',      night: 'sunset' },
    'civil':        { day: 'dawn',         night: 'dusk' },
    'nautical':     { day: 'nauticalDawn', night: 'nauticalDusk' },
    'astronomical': { day: 'nightEnd',     night: 'night' }
};

// Ausgewählte Trigger-Events basierend auf der Konfiguration (mit Fallback auf 'geometric')
const triggerEvents = astroMapping[GEWUENSCHTER_MODUS] || astroMapping['geometric'];


// Einmalige Prüfung und Setzen des Status bei Skriptstart
function initialCheck() {
    const now = new Date();
    
    // Astro-Zeiten holen
    const dayEventTime = getAstroDate(triggerEvents.day);
    const nightEventTime = getAstroDate(triggerEvents.night);

    // Offsets für die initiale Prüfung auf die Zeiten addieren/subtrahieren
    if (dayEventTime) dayEventTime.setMinutes(dayEventTime.getMinutes() + OFFSET_TAG);
    if (nightEventTime) nightEventTime.setMinutes(nightEventTime.getMinutes() + OFFSET_NACHT);

    let isCurrentlyDay;

    // Prüfen, ob Sonnenauf- und -untergang (inkl. Offset) am selben Tag sind
    if (dayEventTime < nightEventTime) {
        // Normalfall: Sonnenaufgang -> Sonnenuntergang am selben Tag
        isCurrentlyDay = now >= dayEventTime && now < nightEventTime;
    } else {
        // Sonderfall (z.B. Polartag/-nacht oder extreme Offsets): Sonnenaufgang -> Sonnenuntergang über Mitternacht
        isCurrentlyDay = now >= dayEventTime || now < nightEventTime;
    }
    
    const currentlyStoredStateIsDay = getState(ID_TAG).val;

    log(`Initialprüfung: Aktueller Zustand sollte sein: ${isCurrentlyDay ? 'Tag' : 'Nacht'}. Gespeicherter Zustand ist: ${currentlyStoredStateIsDay ? 'Tag' : 'Nacht'}.`);
    
    // Nur umschalten, wenn der gespeicherte Zustand falsch ist
    if (isCurrentlyDay && !currentlyStoredStateIsDay) {
        log("Initialer Zustand ist falsch (sollte Tag sein). Korrigiere...");
        setStateToDay();
    } else if (!isCurrentlyDay && currentlyStoredStateIsDay) {
        log("Initialer Zustand ist falsch (sollte Nacht sein). Korrigiere...");
        setStateToNight();
    } else {
        log("Initialer Zustand ist bereits korrekt. Keine Aktion erforderlich.");
    }
}


// --- SKRIPT-ABLAUF ---

(async () => {
    // 1. Warten, bis die Datenpunkte erstellt sind
    await initialize();

    // 2. Initiale Prüfung bei Skriptstart durchführen
    initialCheck();

    // 3. Astro-Trigger für die täglichen Änderungen einrichten (inkl. Offset per shift-Parameter)
    // @ts-ignore
    on({ astro: triggerEvents.day, shift: OFFSET_TAG }, function () {
        log(`Astro-Trigger: '${triggerEvents.day}' mit Offset ${OFFSET_TAG} Min.`);
        setStateToDay();
    });

    // @ts-ignore
    on({ astro: triggerEvents.night, shift: OFFSET_NACHT }, function () {
        log(`Astro-Trigger: '${triggerEvents.night}' mit Offset ${OFFSET_NACHT} Min.`);
        setStateToNight();
    });

    log(`Astro-gesteuertes Skript für Tag/Nacht-Umschaltung ist aktiv. Modus: '${GEWUENSCHTER_MODUS}' (Trigger: ${triggerEvents.day} [Offset: ${OFFSET_TAG}m] / ${triggerEvents.night} [Offset: ${OFFSET_NACHT}m]).`);
})();