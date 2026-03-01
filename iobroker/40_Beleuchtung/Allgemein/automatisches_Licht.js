// Kapselung in einer anonymen Funktion
(function () {
    "use strict";

    // ================= KONFIGURATION =================
    const CONFIG = {
        idAstro: "0_userdata.0.System.Astro.TagNacht",
        
        // Zeitfenster für Nacht-Geräte
        uhrzeitNachtAus: "22:30",  // Spätestens hier ist Schluss
        fruehesterStart: 12,       // Stunde (0-23): Verhindert Einschalten nach Mitternacht (z.B. 4 Uhr morgens)

        // Liste aller zu steuernden Geräte
        geraeteListe: [
            { 
                id: "zigbee2mqtt.0.0xa4c138055afdffff.state", 
                modus: "Tag",       
                name: "Aquariumlicht Esszimmer" 
            },
            { 
                id: "zigbee2mqtt.0.0xa4c1380557daffff.state", 
                modus: "Tag",       
                name: "Aquariumlicht Wohnzimmer" 
            },         
            { 
                id: "zigbee2mqtt.0.0xa4c138053a14ffff.state", 
                modus: "Tag",       
                name: "Vogelkäfig Wohnzimmer" 
            },  
            { 
                id: "zigbee2mqtt.0.0xa4c138059e34ffff.state", 
                modus: "Tag",       
                name: "Vogelkäfig Esszimmer" 
            },
            { 
                id: "zigbee2mqtt.0.0xf0d1b8be240a9f22.state", 
                modus: "Nacht",       
                name: "Tischlampe Wohnzimmer" 
            },
            { 
                id: "zigbee2mqtt.0.0xa4c13805390dffff.state", 
                modus: "Nacht",       
                name: "Wohnzimmerfenster Lampe" 
            }, 
            { 
                id: "zigbee2mqtt.0.0xa4c13805a79bffff.state", 
                modus: "Nacht",       
                name: "Schlafzimmerfenster Lampe" 
            },
            { 
                id: "zigbee2mqtt.0.0xa4c138055ee2ffff.state", 
                modus: "Nacht",       
                name: "Insektenlampe Küche" 
            },
            { 
                id: "zigbee2mqtt.0.0xf0d1b8be24081cd0.state", 
                modus: "Nacht",       
                name: "Stehlampe Aquarium Esszimmer" 
            },
            { 
                id: "zigbee2mqtt.0.0xf0d1b8be24082029.state", 
                modus: "Nacht",       
                name: "Stehlampe Eckbank Esszimmer" 
            }
        ]
    };
    // =================================================

    /**
     * Hilfsfunktion: Prüft, ob wir uns im erlaubten Zeitfenster für "Nacht"-Geräte befinden.
     * Logik: Es muss nach 12:00 Uhr sein UND vor der eingestellten Endzeit (z.B. 22:30).
     * @returns {boolean} true wenn im Zeitfenster, sonst false
     */
    function checkZeitfenster() {
        const jetzt = new Date();
        
        // Sicherheitscheck: Verhindert Einschalten am frühen Morgen (z.B. 01:00 - 11:59)
        if (jetzt.getHours() < CONFIG.fruehesterStart) {
            return false;
        }

        // Endzeit berechnen
        const [stundeAus, minuteAus] = CONFIG.uhrzeitNachtAus.split(':').map(Number);
        const zeitLimit = new Date();
        zeitLimit.setHours(stundeAus, minuteAus, 0, 0);

        return (jetzt < zeitLimit);
    }

    /**
     * Hilfsfunktion: Liest den Astro-Status sicher aus
     * @returns {string|null} "Tag", "Nacht" oder null bei Fehler
     */
    function getAstroStatus() {
        if (!existsState(CONFIG.idAstro)) {
            log(`[Astro-Skript] Fehler: Astro-Objekt ${CONFIG.idAstro} nicht gefunden!`, "error");
            return null;
        }
        return getState(CONFIG.idAstro).val;
    }

    /**
     * Hauptfunktion: Steuert die Geräte basierend auf Logik und Config
     */
    function steuereGeraete() {
        try {
            const astroStatus = getAstroStatus();
            if (!astroStatus) return; // Abbruch bei Fehler

            const istAbendfenster = checkZeitfenster();

            CONFIG.geraeteListe.forEach(geraet => {
                if (!existsState(geraet.id)) {
                    log(`[Astro-Skript] Warnung: Gerät ${geraet.name} (${geraet.id}) nicht gefunden.`, "warn");
                    return;
                }

                let sollAn = false;

                // Logik-Entscheidung
                switch (geraet.modus) {
                    case "Tag":
                        sollAn = (astroStatus === "Tag");
                        break;
                    case "Nacht":
                        // Nur AN, wenn es wirklich Nacht ist UND wir noch vor 22:30 sind
                        sollAn = (astroStatus === "Nacht" && istAbendfenster);
                        break;
                    default:
                        log(`[Astro-Skript] Unbekannter Modus "${geraet.modus}" bei ${geraet.name}`, "warn");
                        return;
                }

                // Schalten mit Traffic-Check (verhindert unnötige Zigbee-Signale)
                const rawVal = getState(geraet.id).val;
                // Sichere Konvertierung in einen Boolean-Wert, um Typ-Fehler und Endlosschleifen zu vermeiden
                const aktuellerStatus = (rawVal === true || rawVal === "true" || rawVal === 1);
                
                if (aktuellerStatus !== sollAn) {
                    setState(geraet.id, sollAn);
                    log(`[Astro-Skript] ${geraet.name}: Schalte ${sollAn ? "AN" : "AUS"} (Modus: ${geraet.modus}, Astro: ${astroStatus}, Zeitfenster: ${istAbendfenster})`);
                }
            });

        } catch (e) {
            log(`[Astro-Skript] Unerwarteter Fehler in steuereGeraete: ${e}`, "error");
        }
    }

    // ================= TRIGGER =================

    // 1. Trigger: Astro-Status Änderung
    on({ id: CONFIG.idAstro, change: "ne" }, function (obj) {
        log(`[Astro-Skript] Astro-Wechsel auf ${obj.state.val} erkannt.`);
        steuereGeraete();
    });

    // 2. Trigger: Zeitplan (Jeden Tag um XX:XX Uhr ausschalten)
    const [stunde, minute] = CONFIG.uhrzeitNachtAus.split(':');
    schedule(`${minute} ${stunde} * * *`, function () {
        log(`[Astro-Skript] Zeitplan ${CONFIG.uhrzeitNachtAus} erreicht.`);
        steuereGeraete();
    });

    // 3. Initiale Ausführung
    steuereGeraete();

})();