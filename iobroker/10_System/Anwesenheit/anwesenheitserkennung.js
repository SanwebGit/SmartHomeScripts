/*
================================================================================
Anwesenheitsskript für ioBroker
================================================================================
 * Author:         Sanweb
 * Version:        2.0.0 (Final)
 * Erstellt am:    28.09.2025
 *
 * Beschreibung:
 * Dieses Skript überwacht den Anwesenheitsstatus von mehreren Geräten (z.B.
 * Smartphones im WLAN) und fasst diesen in globalen Datenpunkten zusammen.
 * Es ist modular aufgebaut, sodass neue Personen und ihre Geräte einfach in
 * der Konfiguration hinzugefügt werden können.
 *
 * Erstellte Datenpunkte unter 0_userdata.0.Anwesenheit.*
 * - {Person}:               (boolean) Status der einzelnen Person.
 * - {Person}_ZuletztGesehen: (string)  Zeitstempel der letzten Anwesenheit.
 * - Status:                 (boolean) Globaler Status (mind. eine Person anwesend).
 * - StatusGesamt:           (string)  Globaler Status als Text ("anwesend"/"abwesend").
================================================================================
*/

(async () => { // Start der Kapselung, um globale Variablen zu vermeiden.
    "use strict";

    // ============================================================================
    // 1. KONFIGURATION
    // ============================================================================
    // Tragen Sie hier alle zu überwachenden Personen und die zugehörigen
    // Datenpunkte ihrer Geräte ein.
    const devices = [
        {
            name: "Alex",
            devicePath: "hm-rega.0.53756" // Datenpunkt, der 'true' ist, wenn Alex anwesend ist
        },
        {
            name: "Rosie",
            devicePath: "hm-rega.0.53755"
        },
        {
            name: "Ramona",
            devicePath: "hm-rega.0.53757"
        }
        // --- Beispiel für eine weitere Person ---
        // {
        //     name: "Gast",
        //     devicePath: "tr-064.0.devices.iPhone-von-Gast.active"
        // }
    ];

    // ============================================================================
    // 2. GLOBALE KONSTANTEN
    // ============================================================================
    // Basispfad, unter dem alle Datenpunkte für dieses Skript erstellt werden.
    const BASE_PATH = "0_userdata.0.Anwesenheit.";

    // Pfade für die globalen Status-Datenpunkte.
    const GLOBAL_STATUS_PATH = BASE_PATH + "Status";
    const GLOBAL_STATUS_TEXT_PATH = BASE_PATH + "StatusGesamt";


    // ============================================================================
    // 3. FUNKTIONEN
    // ============================================================================

    /**
     * Erstellt alle notwendigen ioBroker-Datenpunkte, falls sie noch nicht existieren.
     * Dies umfasst individuelle Status für jede Person sowie globale Status.
     */
    async function setupDataPoints() {
        log("[Hm-Rega - Anwesenheit] Initialisierung: Prüfe und erstelle Datenpunkte...");

        // Erstelle Datenpunkte für jede konfigurierte Person.
        for (const device of devices) {
            const presencePath = `${BASE_PATH}${device.name}`;
            const lastSeenPath = `${BASE_PATH}${device.name}_ZuletztGesehen`;

            if (!existsState(presencePath)) {
                await createStateAsync(presencePath, false, {
                    name: `Anwesenheit von ${device.name}`,
                    type: "boolean",
                    role: "indicator.present",
                    read: true, write: false, def: false
                });
            }
            if (!existsState(lastSeenPath)) {
                await createStateAsync(lastSeenPath, "", {
                    name: `Zuletzt gesehen von ${device.name}`,
                    type: "string",
                    role: "text.date",
                    read: true, write: false, def: ""
                });
            }
        }

        // Erstelle die globalen Status-Datenpunkte.
        if (!existsState(GLOBAL_STATUS_PATH)) {
            await createStateAsync(GLOBAL_STATUS_PATH, false, {
                name: "Anwesenheit globaler Schalter",
                type: "boolean",
                role: "indicator.present",
                read: true, write: false, def: false
            });
        }
        if (!existsState(GLOBAL_STATUS_TEXT_PATH)) {
            await createStateAsync(GLOBAL_STATUS_TEXT_PATH, "abwesend", {
                name: "Anwesenheit globaler Status",
                type: "string",
                role: "text",
                read: true, write: false, def: "abwesend"
            });
        }

        log("[Hm-Rega - Anwesenheit] Initialisierung abgeschlossen.");
    }

    /**
     * Hauptfunktion zur Aktualisierung des Anwesenheitsstatus.
     * Liest den Status jedes Geräts, aktualisiert die individuellen und globalen
     * Datenpunkte und setzt Zeitstempel.
     */
    function updatePresenceStatus() {
        let isAnyonePresent = false;

        // Iteriere durch alle konfigurierten Geräte.
        for (const device of devices) {
            const presencePath = `${BASE_PATH}${device.name}`;
            const lastSeenPath = `${BASE_PATH}${device.name}_ZuletztGesehen`;

            const sourceState = getState(device.devicePath);
            let isPresent = false;

            // Prüfe, ob der Quelldatenpunkt existiert und einen validen Wert hat.
            if (sourceState && sourceState.val !== null && sourceState.val !== undefined) {
                isPresent = sourceState.val;
            } else {
                log(`[Hm-Rega - Anwesenheit] Warnung: Quelldatenpunkt '${device.devicePath}' für ${device.name} nicht verfügbar. Annahme: abwesend.`, "warn");
            }

            // Setze den individuellen Status mit Bestätigung (ack = true).
            setState(presencePath, isPresent, true);

            // Wenn die Person anwesend ist, aktualisiere den "Zuletzt gesehen"-Zeitstempel.
            if (isPresent) {
                const timestamp = new Date().toLocaleString("de-DE");
                setState(lastSeenPath, timestamp, true);
                isAnyonePresent = true;
            }
        }

        // Aktualisiere die globalen Status-Datenpunkte.
        const globalStatusText = isAnyonePresent ? "anwesend" : "abwesend";
        setState(GLOBAL_STATUS_PATH, isAnyonePresent, true);
        setState(GLOBAL_STATUS_TEXT_PATH, globalStatusText, true);

        log(`[Hm-Rega - Anwesenheit] Status aktualisiert: Gesamtstatus ist '${globalStatusText}'.`);
    }


    // ============================================================================
    // 4. SKRIPT-START & HAUPTLOGIK
    // ============================================================================

    // Schritt 1: Erstelle alle Datenpunkte und warte auf die Fertigstellung.
    await setupDataPoints();

    // Schritt 2: Führe die Statusprüfung einmalig beim Start aus.
    updatePresenceStatus();

    // Schritt 3: Erstelle einen Trigger, der auf Änderungen bei allen Geräten reagiert.
    const devicePathsToMonitor = devices.map(d => d.devicePath);
    on({ id: devicePathsToMonitor, change: "any" }, function (obj) {
        log(`[Hm-Rega - Anwesenheit] Änderung bei '${obj.id}' erkannt. Neuer Wert: ${obj.state.val}.`);
        updatePresenceStatus();
    });

    log(`[Hm-Rega - Anwesenheit] Überwachung gestartet für: ${devices.map(d => d.name).join(', ')}.`);

})(); // Ende der Kapselung

