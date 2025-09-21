/**
 * @fileoverview Universal, intelligent single-room heating control for ioBroker
 * @version 5.2 (Universal)
 * @author Sanweb
 * @license MIT
 *
 * PURPOSE OF THE SCRIPT:
 * This script controls the room temperature fully automatically, in an energy-efficient and 
 * building-physics-optimized manner. It serves as a central template for all rooms.
 *
 * INSTRUCTIONS:
 * 1. Create a new script instance in ioBroker for each room you want to control.
 * 2. Copy the entire content of this file into the new script.
 * 3. ONLY adjust the "1. CENTRAL CONFIGURATION" section for the respective room.
 * Changes below this section are not necessary.
 *
 * NEW in v5.1: Uses the learned 'controller performance' from a separate learning script
 * to dynamically adapt the heating curve to the thermal behavior of the room.
 *
 * -----------------------------------------------------------------------------------
 * REQUIRED DEVICES / DATA POINTS (Examples for Homematic):
 * -----------------------------------------------------------------------------------
 * A) Per Room (minimum required):
 * - 1x Radiator Thermostat (e.g., HM-CC-RT-DN)
 * -> Datapoint: '...SET_POINT_TEMPERATURE' (for setting the setpoint temperature)
 * -> Datapoint: '...ACTUAL_TEMPERATURE' (for reading the actual temperature)
 * -> Datapoint: '...CONTROL_MODE' (for switching to automatic mode)
 * - 1x Window/Door Contact (e.g., HM-Sec-SC-2)
 * -> Datapoint: '...STATE' (true/1 = open, false/0 = closed)
 *
 * B) Global (for all rooms, to be created in '0_userdata.0'):
 * - System variables for basic states (see CONFIG.ids)
 * -> e.g., '0_userdata.0.Heizung.Allgemein.HeizperiodeAktiv' (boolean)
 * -> e.g., '0_userdata.0.Anwesenheit.Status' (boolean)
 *
 * C) Optional (for advanced functions):
 * - 1x Outdoor Temperature Sensor (e.g., HM-WDS10-TH-O)
 * -> Datapoint: '...ACTUAL_TEMPERATURE'
 * - 1x Humidity Sensor (often included in the thermostat or outdoor sensor)
 * -> Datapoint: '...HUMIDITY'
 * - 2x Wall Temperature Sensors (for mold & comfort protection)
 * -> Datapoint: '...ACTUAL_TEMPERATURE' (one for surface, one for core)
 * -----------------------------------------------------------------------------------
 */

// -------------------------------------------------------------------------------------
// 1. CENTRAL CONFIGURATION
// All user-specific settings for the respective room are made here.
// -------------------------------------------------------------------------------------
const CONFIG = {
    // --- A. ROOM NAME & BASIC SETTINGS ---
    // Adjust these for the respective room (e.g., 'LivingRoom', 'Kitchen', 'Bathroom').
    roomName: 'RoomName', // IMPORTANT: Replace! E.g., 'Bedroom'
    nachtschaltungNutzen: true,     // true, if the global night mode should apply to this room
    tuerSensorNutzen: true,         // true, if a door sensor should lower the temperature
    hysterese: 0.5,                 // Hysteresis in °C to avoid frequent switching
    tempFensterOffen: 12.0,         // Setpoint temperature when a window is opened
    tempHeizperiodeAus: 4.5,        // Setpoint temperature when the heating period is deactivated (frost protection)
    temperaturOffset: 0.0,          // Manual offset in °C for fine-tuning
    minSollTemp: 16.0,              // Minimum allowed setpoint temperature (except in special cases)
    maxSollTemp: 24.0,              // Maximum allowed setpoint temperature

    // --- B. ioBroker OBJECT IDs: SYSTEM VARIABLES (usually global for all rooms) ---
    ids: {
        heizPeriode: '0_userdata.0.Heizung.Allgemein.HeizperiodeAktiv', // (boolean) true if heating should generally be active
        anwesenheit: '0_userdata.0.Anwesenheit.Status',                 // (boolean) true if someone is at home
        nachtschaltung: '0_userdata.0.System.Nachtschaltung.Aktiv',     // (boolean) true for general night setback
        sollTempAnwesend: '0_userdata.0.Heizung.sollTempAnwesend',       // (number) Target temperature when present, e.g., 21.5
        sollTempAbwesend: '0_userdata.0.Heizung.sollTempAbwesend',       // (number) Target temperature when absent/night, e.g., 16.0
        reglerleistung: '0_userdata.0.Heizung.Optimierung.Reglerleistung', // (number) Learned value from optimization script (Default: 1.0)
    },

    // --- C. ioBroker OBJECT IDs: DEVICES AND SENSORS (specific to this room) ---
    devices: {
        thermostate: ['hm-rpc.2.00000000000000.1.SET_POINT_TEMPERATURE'], // (array) List of thermostat DPs 'SET_POINT_TEMPERATURE'
        fensterKontakte: ['hm-rpc.0.00000000000000.1.STATE'],              // (array) List of window contact DPs 'STATE'
        tuerSensor: 'hm-rpc.0.00000000000000.1.STATE',                     // (string) Datapoint of the door contact 'STATE'
        aussenTempSensor: 'hm-rpc.0.00000000000000.1.ACTUAL_TEMPERATURE',  // (string) Datapoint of the outdoor temperature sensor
        feuchteSensor: 'hm-rpc.2.00000000000000.1.HUMIDITY',               // (string) Datapoint of the humidity sensor
        wandSensorOberflaeche: 'hm-rpc.0.00000000000000.1.ACTUAL_TEMPERATURE', // (string) Datapoint of the wall surface temperature sensor
        wandSensorKern: 'hm-rpc.0.00000000000000.2.ACTUAL_TEMPERATURE_STATUS', // (string) Datapoint of the wall core temperature sensor
    },

    // --- D. BASIC CONTROL (Dynamics & Comfort) ---
    aussenTempNeutral: 12.0,    // Outdoor temperature at which no weather adjustment occurs
    heizkurvenfaktor: 0.25,     // How strongly the outdoor temperature influences the setpoint temperature
    luftfeuchteOptimal: 50.0,   // Target humidity in %
    feuchteKorrekturfaktor: 0.02, // Influence of humidity on the setpoint temperature

    // --- E. ADVANCED MODULES (Building Physics & Protection) ---
    module: {
        schimmelSchutzAktiv: true,
        sicherheitsabstandTaupunkt: 2.5,
        offsetSchimmelSchutz: 0.5,
        behaglichkeitAktiv: true,
        maxTempDifferenzWand: 3.0,
        offsetBehaglichkeit: 0.5,
        heizlastAktiv: true,
        heizlastKorrekturfaktor: 0.1,
    },

    // --- F. DEBUG SETTINGS & TRIGGER THRESHOLDS ---
    debugLogAktiv: true,
    aussenTempTriggerThreshold: 1.0,
    raumTempTriggerThreshold: 0.3,
    luftfeuchteTriggerThreshold: 5.0,
};

// -------------------------------------------------------------------------------------
// 2. MAIN FUNCTION (called by triggers)
// From here on, no changes are normally necessary.
// -------------------------------------------------------------------------------------
async function main() {
    // --- 2.1 Collect all required states at once ---
    const states = {};
    const idsToFetch = { ...CONFIG.ids, ...CONFIG.devices };
    for (const key in idsToFetch) {
        if (Array.isArray(idsToFetch[key])) {
            states[key] = [];
            for (const id of idsToFetch[key]) {
                const state = await getStateAsync(id);
                // Store the value (.val) of the state, or null if the state does not exist
                states[key].push(state ? state.val : null);
            }
        } else if (idsToFetch[key]) {
            const state = await getStateAsync(idsToFetch[key]);
            states[key] = state ? state.val : null;
        }
    }

    // --- 2.2 Validate sensors and set fallback flags ---
    // Check if sensor values are plausible to avoid miscalculations.
    const aussenSensorOK = states.aussenTempSensor !== null && states.aussenTempSensor > -30.0 && states.aussenTempSensor < 60.0;
    const feuchteSensorOK = states.feuchteSensor !== null && states.feuchteSensor >= 0.0 && states.feuchteSensor <= 100.0;

    // --- 2.3 Prepare helper variables ---
    // Load the global setpoint temperatures, set default values (fallbacks) if not available.
    let sollTempAnwesend = states.sollTempAnwesend || 21.0;
    const sollTempAbwesend = states.sollTempAbwesend || 16.0;
    const reglerleistung = states.reglerleistung || 1.0; // Get learned factor, fallback to 1.0 (neutral)

    // If night mode is active for this room, the absence temperature is used as the base.
    if (CONFIG.nachtschaltungNutzen && states.nachtschaltung) {
        sollTempAnwesend = sollTempAbwesend;
    }

    // Check the state of doors and windows.
    const tuerIstGeschlossen = CONFIG.tuerSensorNutzen && states.tuerSensor === 0;
    const fensterIstOffen = states.fensterKontakte.some(state => state === true || state === 1);

    // --- 2.4 Prepare log strings for modules ---
    let logM1 = `, Mod1=${CONFIG.module.schimmelSchutzAktiv}`;
    let logM2 = `, Mod2=${CONFIG.module.behaglichkeitAktiv}`;
    let logM3 = `, Mod3=${CONFIG.module.heizlastAktiv}`;

    // --- 3. LOGIC: Determine base temperature ---
    let neueSollTemp;
    let istSonderfall = false; // Flag for states that override dynamic adjustments (e.g., window open)

    if (states.heizPeriode) {
        if (fensterIstOffen) {
            // If a window is open, set to a fixed setback temperature.
            neueSollTemp = CONFIG.tempFensterOffen;
            istSonderfall = true;
        } else if (states.anwesenheit) {
            // When present: Check if the door is closed (if configured), otherwise use normal presence temp.
            neueSollTemp = (CONFIG.tuerSensorNutzen && !tuerIstGeschlossen) ? sollTempAbwesend : sollTempAnwesend;
        } else {
            // When absent: Set to absence temperature.
            neueSollTemp = sollTempAbwesend;
        }
    } else {
        // Outside the heating period: Set to frost protection temperature.
        neueSollTemp = CONFIG.tempHeizperiodeAus;
        istSonderfall = true;
    }

    // --- 4. LOGIC: Dynamic adjustments & modules (only if not a special case) ---
    if (!istSonderfall) {
        // Module: Weather compensation based on outdoor temperature
        if (aussenSensorOK) {
            if (states.aussenTempSensor < CONFIG.aussenTempNeutral) {
                // Apply learned factor 'reglerleistung' to the weather compensation to adjust the heating curve.
                const angepassterHeizkurvenfaktor = CONFIG.heizkurvenfaktor * reglerleistung;
                neueSollTemp += (CONFIG.aussenTempNeutral - states.aussenTempSensor) * angepassterHeizkurvenfaktor;
            }
        }

        // Module: Adjustment based on humidity
        if (feuchteSensorOK) {
            // If the air is too dry, the perceived temperature is compensated by slightly increasing the setpoint temp (and vice versa).
            neueSollTemp += (CONFIG.luftfeuchteOptimal - states.feuchteSensor) * CONFIG.feuchteKorrekturfaktor;
        }

        const wandSensorOberflaecheOK = states.wandSensorOberflaeche !== null && states.wandSensorOberflaeche < 90.0;
        // Module: Mold protection
        if (CONFIG.module.schimmelSchutzAktiv && feuchteSensorOK && wandSensorOberflaecheOK) {
            // Calculate the dew point of the room air.
            const a = 7.5, b = 237.3;
            const sdd = (a * neueSollTemp) / (b + neueSollTemp) + Math.log(states.feuchteSensor / 100);
            const taupunkt = (b * sdd) / (a - sdd);
            // If the wall surface temperature is dangerously close to the dew point, slightly increase the setpoint temperature.
            if (states.wandSensorOberflaeche < (taupunkt + CONFIG.module.sicherheitsabstandTaupunkt)) {
                const offset = CONFIG.module.offsetSchimmelSchutz;
                neueSollTemp += offset;
                logM1 += `:+${offset}`;
            }
        }

        // Module: Comfort
        if (CONFIG.module.behaglichkeitAktiv && wandSensorOberflaecheOK) {
            // If the difference between room and wall surface temperature is too large (radiant cold), increase the setpoint temperature.
            if ((neueSollTemp - states.wandSensorOberflaeche) > CONFIG.module.maxTempDifferenzWand) {
                const offset = CONFIG.module.offsetBehaglichkeit;
                neueSollTemp += offset;
                logM2 += `:+${offset}`;
            }
        }

        const wandSensorKernOK = states.wandSensorKern !== null && states.wandSensorKern < 90.0;
        // Module: Heating load / wall buffering
        if (CONFIG.module.heizlastAktiv && wandSensorOberflaecheOK && wandSensorKernOK) {
            const tempDifferenz = states.wandSensorKern - states.wandSensorOberflaeche;
            // If the wall is cooling down from the inside out (releasing heat), the heating is slightly reduced.
            // If the wall is heating up from the outside in (absorbing heat), the setpoint is slightly increased to fill the buffer.
            if (tempDifferenz > 0) {
                const offset = tempDifferenz * CONFIG.module.heizlastKorrekturfaktor;
                neueSollTemp += offset;
                logM3 += `:+${offset.toFixed(1)}`;
            }
        }

        // Manual offset is added last.
        neueSollTemp += CONFIG.temperaturOffset;
    }

    // --- 5. LOGIC: Finalization & Execution ---
    // Limit the calculated setpoint temperature to the defined min/max values (except in special cases).
    if (!istSonderfall) {
        if (neueSollTemp > CONFIG.maxSollTemp) neueSollTemp = CONFIG.maxSollTemp;
        if (neueSollTemp < CONFIG.minSollTemp) neueSollTemp = CONFIG.minSollTemp;
    }

    // Round the final setpoint temperature to 0.5°C steps, as expected by most thermostats.
    neueSollTemp = Math.round(neueSollTemp * 2) / 2;

    // Send the new setpoint to all thermostats in this room.
    for (const thermostatId of CONFIG.devices.thermostate) {
        const aktuellEingestellteTemp = (await getStateAsync(thermostatId))?.val || 4.5;

        // Check if the change is greater than the set hysteresis to avoid constant switching.
        const sollwertGeaendert = Math.abs(neueSollTemp - aktuellEingestellteTemp) > CONFIG.hysterese;

        if (sollwertGeaendert) {
            await setStateAsync(thermostatId, neueSollTemp);
            // Ensure the thermostat is in automatic mode, in case it was manually adjusted.
            const controlModeId = thermostatId.replace('SET_POINT_TEMPERATURE', 'CONTROL_MODE');
            await setStateAsync(controlModeId, 1, true); // 1 = Automatic mode, ack=true confirms the command
        }

        // Detailed log output if debugging is enabled.
        if (CONFIG.debugLogAktiv) {
            let logMessage;
            if (sollwertGeaendert) {
                logMessage = `[${CONFIG.roomName}] Setting setpoint from ${aktuellEingestellteTemp.toFixed(1)}°C to ${neueSollTemp.toFixed(1)}°C`;
            } else {
                logMessage = `[${CONFIG.roomName}] No change (Is=${aktuellEingestellteTemp.toFixed(1)}°C ~ Target=${neueSollTemp.toFixed(1)}°C, Hyst=${CONFIG.hysterese}°C)`;
            }

            const tuerStatusLog = CONFIG.tuerSensorNutzen ? `, DoorClosed=${!tuerIstGeschlossen}` : '';
            const nachtschaltungStatusLog = CONFIG.nachtschaltungNutzen ? `, NightMode=${states.nachtschaltung}` : '';

            logMessage += ` (HeatP=${states.heizPeriode}, Pres=${states.anwesenheit}, Win=${fensterIstOffen}${tuerStatusLog}${nachtschaltungStatusLog}, Offset=${CONFIG.temperaturOffset}${logM1}${logM2}${logM3}, CtrlPerf=${reglerleistung.toFixed(2)}).`;
            log(logMessage);
        }
    }
}

// -------------------------------------------------------------------------------------
// 3. TRIGGER CONFIGURATION & RATE-LIMITER
// -------------------------------------------------------------------------------------
let lastRunTimestamp = 0;
const COOLDOWN_MS = 2000; // Prevents too frequent executions (min. 2 sec interval) to avoid overloading the system.

// This function acts as a "wrapper" around main() to catch rapid, repeated triggers.
async function rateLimitedMain(triggerInfo) {
    const now = Date.now();
    if (now - lastRunTimestamp < COOLDOWN_MS) {
        return; // Skip execution if the cooldown is still active
    }
    lastRunTimestamp = now;

    // Logs the trigger of the function for easier debugging.
    if (CONFIG.debugLogAktiv) {
        let triggerType = 'SafetyTrigger';
        let triggerName = 'Periodic Trigger';

        if (triggerInfo && triggerInfo.id) {
            const id = triggerInfo.id;
            if (id.startsWith('hm-rpc.')) {
                triggerType = 'Sensor';
            } else if (id.startsWith('0_userdata.')) {
                triggerType = 'SystemVariable';
            }
            if (triggerInfo.id === 'Initial Start') {
                triggerType = 'System';
            }
            triggerName = triggerInfo.name || id;
        }

        log(`[${CONFIG.roomName}] Trigger detected -> [${triggerType}] ${triggerName}`);
    }

    await main();
}

// --- Collect Trigger IDs ---
// All relevant data points that should trigger an immediate recalculation.
const triggerIds = [
    CONFIG.ids.heizPeriode,
    CONFIG.ids.anwesenheit,
    CONFIG.ids.nachtschaltung,
    CONFIG.ids.reglerleistung, // NEW: Also react to changes in controller performance
    ...CONFIG.devices.fensterKontakte,
];
if (CONFIG.tuerSensorNutzen && CONFIG.devices.tuerSensor) {
    triggerIds.push(CONFIG.devices.tuerSensor);
}

// Main trigger for state changes (e.g., presence on/off, window open/close)
on(triggerIds, rateLimitedMain);

// Trigger for sensor changes that must exceed a threshold to ignore fluctuations.
const raumTempIds = CONFIG.devices.thermostate.map(id => id.replace('SET_POINT_TEMPERATURE', 'ACTUAL_TEMPERATURE'));
on({ id: raumTempIds, change: "ne" }, async (obj) => {
    if (obj.state && obj.oldState && Math.abs(obj.state.val - obj.oldState.val) >= CONFIG.raumTempTriggerThreshold) {
        rateLimitedMain(obj);
    }
});

if (CONFIG.devices.feuchteSensor) {
    on({ id: CONFIG.devices.feuchteSensor, change: "ne" }, async (obj) => {
        if (obj.state && obj.oldState && Math.abs(obj.state.val - obj.oldState.val) >= CONFIG.luftfeuchteTriggerThreshold) {
            rateLimitedMain(obj);
        }
    });
}

if (CONFIG.devices.aussenTempSensor) {
    on({ id: CONFIG.devices.aussenTempSensor, change: "ne" }, async (obj) => {
        if (obj.state && obj.oldState && Math.abs(obj.state.val - obj.oldState.val) >= CONFIG.aussenTempTriggerThreshold) {
            rateLimitedMain(obj);
        }
    });
}

// --- Periodic Safety Trigger ---
// Runs the script every 15 minutes to ensure the state is correct,
// even if a trigger event was missed.
schedule('9,24,39,54 * * * *', rateLimitedMain);

// One-time start for initialization after script start to establish the correct state immediately.
setTimeout(() => rateLimitedMain({ id: 'Initial Start', name: 'Initial Start after Script Start' }), 1500);


