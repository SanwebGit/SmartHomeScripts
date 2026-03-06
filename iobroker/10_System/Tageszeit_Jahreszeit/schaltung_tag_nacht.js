/*
 * -----------------------------------------------------------------------------
 * ioBroker JavaScript: Tag/Nacht-Umschaltung per Astro-Funktion
 * -----------------------------------------------------------------------------
 * Version 6.3 (Strict Mode & Clean Scope)
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
 * OFFSETS:
 * Mit OFFSET_TAG und OFFSET_NACHT kann der Schaltzeitpunkt in Minuten verschoben werden.
 * Ein negativer Wert schaltet FRÜHER, ein positiver Wert SPÄTER.
 * (Maximal zulässige Werte: -720 bis +720 Minuten).
 *
 * POLARREGIONEN & FALLBACK:
 * In Regionen mit Polartag oder Polarnacht kann 'getAstroDate' null zurückgeben.
 * Das Skript erkennt dies und fällt auf statische, konfigurierbare Zeiten zurück.
 * Auch im Fallback-Modus werden die eingestellten Offsets berücksichtigt!
 * -----------------------------------------------------------------------------
 */



(async () => {
"use strict";
    // --- KONFIGURATION ---

    const ID_TAG = "0_userdata.0.System.Astro.Tag";
    const ID_NACHT = "0_userdata.0.System.Astro.Nacht";
    const ID_TAG_NACHT_TEXT = "0_userdata.0.System.Astro.TagNacht";
    const ID_LETZTER_WECHSEL = "0_userdata.0.System.Astro.LetzterWechsel";
    const ID_FALLBACK_AKTIV = "0_userdata.0.System.Astro.FallbackAktiv";

    const GEWUENSCHTER_MODUS = "geometric"; 

    // Offsets in Minuten
    const OFFSET_TAG = 0;     
    const OFFSET_NACHT = -10; 

    // Fallback-Zeiten für Polarregionen/Fehlerfälle (in Stunden, 0-23)
    const FALLBACK_HOUR_DAY = 6;  // 06:00 Uhr
    const FALLBACK_HOUR_NIGHT = 22; // 22:00 Uhr

    // --- VALIDIERUNG & SETUP ---

    // Validierung der Offsets (Begrenzung auf +/- 12 Stunden)
    const validOffsetTag = Math.max(-720, Math.min(720, OFFSET_TAG));
    const validOffsetNacht = Math.max(-720, Math.min(720, OFFSET_NACHT));

    const astroMapping = {
        'geometric':    { day: 'sunrise',      night: 'sunset' },
        'civil':        { day: 'dawn',         night: 'dusk' },
        'nautical':     { day: 'nauticalDawn', night: 'nauticalDusk' },
        'astronomical': { day: 'nightEnd',     night: 'night' }
    };

    // Fallback-Logik für den Modus
    let triggerEvents = astroMapping[GEWUENSCHTER_MODUS];
    if (!triggerEvents) {
        log(`Warnung: Unbekannter Modus '${GEWUENSCHTER_MODUS}'. Fallback auf 'geometric'.`, "warn");
        triggerEvents = astroMapping['geometric'];
    }

    // Speicher für registrierte Trigger (für sauberen Cleanup bei Neustart)
    const registeredTriggers = { astro: [], cron: [] };

    // Globale Skript-Variablen für den aktuellen Lauf
    let isPolarFallback = false;
    let baseAstroDay = null;
    let baseAstroNight = null;

    // --- HILFSFUNKTIONEN ---

    // Formatiert Stunden und Minuten mit führender Null (z.B. 06:05)
    const formatTime = (h, m) => `${h}:${m.toString().padStart(2, '0')}`;

    // Klont ein Date-Objekt und addiert einen Offset in Minuten
    const withOffset = (date, offset) => {
        const newDate = new Date(date.getTime());
        newDate.setMinutes(newDate.getMinutes() + offset);
        return newDate;
    };

    async function initialize() {
        if (!ID_TAG || !ID_NACHT || !ID_TAG_NACHT_TEXT) {
            log("Konfigurationsfehler: Die Datenpunkt-IDs dürfen nicht leer sein.", "error");
            return false;
        }

        await createStateAsync(ID_TAG, false, { name: "Status Tag", type: "boolean", role: "indicator.day", read: true, write: false });
        await createStateAsync(ID_NACHT, true, { name: "Status Nacht", type: "boolean", role: "indicator.night", read: true, write: false });
        await createStateAsync(ID_TAG_NACHT_TEXT, "Nacht", { name: "Tag/Nacht Status als Text", type: "string", role: "text", read: true, write: false });
        await createStateAsync(ID_LETZTER_WECHSEL, "", { name: "Letzter Tag/Nacht Wechsel", type: "string", role: "text", read: true, write: false });
        await createStateAsync(ID_FALLBACK_AKTIV, false, { name: "Astro Fallback Modus aktiv", type: "boolean", role: "indicator", read: true, write: false });
        
        log("Astro-Datenpunkte initialisiert und verifiziert.", "debug");
        return true;
    }

    // Berechnet neue Stunde/Minute basierend auf einer Basis-Stunde und einem Minuten-Offset
    function calculateTimeWithOffset(baseHour, offsetMinutes) {
        let totalMinutes = (baseHour * 60) + offsetMinutes;
        // Unterlauf (z.B. Tagwechsel rückwärts) abfangen
        while (totalMinutes < 0) totalMinutes += 24 * 60;
        
        const hour = Math.floor(totalMinutes / 60) % 24;
        const minute = totalMinutes % 60;
        return { hour, minute };
    }

    // Zentrale Funktion zum Setzen des Status
    async function setDayNightState(isDay) {
        const stateText = isDay ? "Tag" : "Nacht";
        
        // Aktuellen Status prüfen
        const currentStateObj = await getStateAsync(ID_TAG);
        
        // Falls Datenpunkt existiert und der Wert bereits stimmt (!= null prüft auf null UND undefined)
        if (currentStateObj && currentStateObj.val != null && currentStateObj.val === isDay) {
            log(`Zustand ist bereits auf '${stateText}'. Keine Änderung erforderlich.`, "debug");
            return;
        }

        log(`Schalte auf ${stateText.toUpperCase()}.`, "info");
        await setStateAsync(ID_TAG, isDay, true);
        await setStateAsync(ID_NACHT, !isDay, true);
        await setStateAsync(ID_TAG_NACHT_TEXT, stateText, true);
        await setStateAsync(ID_LETZTER_WECHSEL, formatDate(new Date(), "DD.MM.YYYY hh:mm:ss"), true);
    }

    function setupTriggers() {
        if (isPolarFallback) {
            log("Astro-Zeiten fehlen (Polarregion?). Aktiviere Fallback-Modus (Cron).", "warn");
            setState(ID_FALLBACK_AKTIV, true, true);

            // Fallback Zeiten inkl. Offsets berechnen
            const dayTime = calculateTimeWithOffset(FALLBACK_HOUR_DAY, validOffsetTag);
            const nightTime = calculateTimeWithOffset(FALLBACK_HOUR_NIGHT, validOffsetNacht);

            // Cron-Trigger erstellen
            // @ts-ignore
            const cronDay = schedule(`${dayTime.minute} ${dayTime.hour} * * *`, async function () {
                log(`Fallback-Cron Event: Tag ausgelöst.`, "info");
                await setDayNightState(true);
            });
            registeredTriggers.cron.push(cronDay);

            // @ts-ignore
            const cronNight = schedule(`${nightTime.minute} ${nightTime.hour} * * *`, async function () {
                log(`Fallback-Cron Event: Nacht ausgelöst.`, "info");
                await setDayNightState(false);
            });
            registeredTriggers.cron.push(cronNight);
            
            log(`Fallback-Trigger aktiv. Tag: ${formatTime(dayTime.hour, dayTime.minute)}, Nacht: ${formatTime(nightTime.hour, nightTime.minute)}.`, "info");
            
        } else {
            setState(ID_FALLBACK_AKTIV, false, true);

            // Normaler Modus: Astro-Trigger
            // @ts-ignore
            const astroDay = on({ astro: triggerEvents.day, shift: validOffsetTag }, async function () {
                log(`Astro-Trigger Event: '${triggerEvents.day}' ausgelöst (Offset: ${validOffsetTag} Min).`, "info");
                await setDayNightState(true);
            });
            registeredTriggers.astro.push(astroDay);

            // @ts-ignore
            const astroNight = on({ astro: triggerEvents.night, shift: validOffsetNacht }, async function () {
                log(`Astro-Trigger Event: '${triggerEvents.night}' ausgelöst (Offset: ${validOffsetNacht} Min).`, "info");
                await setDayNightState(false);
            });
            registeredTriggers.astro.push(astroNight);

            log(`Astro Tag/Nacht-Umschaltung ist aktiv. Modus: '${GEWUENSCHTER_MODUS}'.`, "info");
        }
    }

    async function initialCheck() {
        const now = new Date();
        let dayEventTime, nightEventTime;

        if (isPolarFallback) {
            // Fallback: Fixe Zeiten für heute inkl. Offset berechnen
            const dayTimeCalc = calculateTimeWithOffset(FALLBACK_HOUR_DAY, validOffsetTag);
            const nightTimeCalc = calculateTimeWithOffset(FALLBACK_HOUR_NIGHT, validOffsetNacht);
            
            dayEventTime = new Date();
            dayEventTime.setHours(dayTimeCalc.hour, dayTimeCalc.minute, 0, 0);
            
            nightEventTime = new Date();
            nightEventTime.setHours(nightTimeCalc.hour, nightTimeCalc.minute, 0, 0);
        } else {
            // Normal: Einmalig abgerufene Astro-Zeiten über Hilfsfunktion klonen und Offset addieren
            dayEventTime = withOffset(baseAstroDay, validOffsetTag);
            nightEventTime = withOffset(baseAstroNight, validOffsetNacht);
        }

        let isCurrentlyDay;

        // Zeitlogik inkl. Fallback für Überschneidungen um Mitternacht
        if (dayEventTime < nightEventTime) {
            isCurrentlyDay = now >= dayEventTime && now < nightEventTime;
        } else {
            isCurrentlyDay = now >= dayEventTime || now < nightEventTime;
        }
        
        const stateObj = await getStateAsync(ID_TAG);
        const currentlyStoredStateIsDay = stateObj ? stateObj.val : null;

        log(`Initialprüfung: Ist-Zustand laut Zeit: ${isCurrentlyDay ? 'Tag' : 'Nacht'}. Gespeicherter ioBroker Zustand: ${currentlyStoredStateIsDay === null ? 'Unbekannt (null)' : (currentlyStoredStateIsDay ? 'Tag' : 'Nacht')}.`, "debug");
        
        // Korrektur, falls der System-Status vom errechneten Status abweicht
        if (isCurrentlyDay && currentlyStoredStateIsDay !== true) {
            log("Initialer Zustand ist inkorrekt (sollte Tag sein). Führe Korrektur aus...", "warn");
            await setDayNightState(true);
        } else if (!isCurrentlyDay && currentlyStoredStateIsDay === true) {
            log("Initialer Zustand ist inkorrekt (sollte Nacht sein). Führe Korrektur aus...", "warn");
            await setDayNightState(false);
        } else {
            log("Initialer Zustand ist korrekt. Keine Aktion erforderlich.", "debug");
        }
    }

    // --- SKRIPT-ABLAUF & CLEANUP ---

    try {
        const isInitialized = await initialize();
        
        if (isInitialized) {
            // Einmaliges Abrufen der Astro-Zeiten für diesen Skriptlauf
            baseAstroDay = getAstroDate(triggerEvents.day);
            baseAstroNight = getAstroDate(triggerEvents.night);

            if (!baseAstroDay || !baseAstroNight) {
                isPolarFallback = true;
            }

            // WICHTIG: Erst Trigger setzen, dann Status checken (Race Condition Vermeidung)
            setupTriggers();
            await initialCheck();
        }

    } catch (error) {
        log(`Fehler beim Starten des Astro-Skripts: ${error.message}`, "error");
    }

    // Sauberes Aufräumen bei Skript-Neustart oder Stopp
    // @ts-ignore
    onStop(function (cb) {
        log("Skript wird gestoppt. Bereinige Trigger...", "debug");
        
        // Cron Jobs bereinigen
        registeredTriggers.cron.forEach(trigger => {
            if (trigger && typeof clearSchedule === 'function') {
                clearSchedule(trigger);
            }
        });

        // Astro/State Trigger bereinigen
        registeredTriggers.astro.forEach(trigger => {
            if (trigger && typeof unsubscribe === 'function') {
                unsubscribe(trigger);
            }
        });
        
        cb();
    }, 2000);

})();