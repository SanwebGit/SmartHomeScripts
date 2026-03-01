/*
 * Dieses Skript erstellt zwei Datenpunkte zur Steuerung der Heizung
 * unterhalb von 0_userdata.0.Heizung.
 */

// Hauptfunktion zum Erstellen der Datenpunkte
function erstelleHeizungsDatenpunkte() {
    const pfad = "0_userdata.0.Heizung.";
    const datenpunkte = [
        {
            id: pfad + "sollTempAnwesend",
            name: "Solltemperatur Anwesend",
            type: "number",
            role: "level.temperature",
            read: true,
            write: true,
            def: 19, // Standardwert in °C
            unit: "°C",
            desc: "Solltemperatur, wenn jemand anwesend ist"
        },
        {
            id: pfad + "sollTempAbwesend",
            name: "Solltemperatur Abwesend",
            type: "number",
            role: "level.temperature",
            read: true,
            write: true,
            def: 16, // Standardwert in °C
            unit: "°C",
            desc: "Solltemperatur, wenn niemand anwesend ist"
        }
    ];

    datenpunkte.forEach(dp => {
        createState(dp.id, dp.def, false, {
            name: dp.name,
            type: dp.type,
            role: dp.role,
            read: dp.read,
            write: dp.write,
            unit: dp.unit,
            desc: dp.desc
        }, () => {
            log("Datenpunkt '" + dp.id + "' wurde erstellt oder existiert bereits.", "info");
        });
    });
}

// Skript ausführen
erstelleHeizungsDatenpunkte();