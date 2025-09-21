/**
 * @fileoverview Determines the heating period automatically based on the daily average temperature.
 * @version 2.5 (Log outputs clarified and timezone info added)
 * @author Sanweb
 * @license MIT
 *
 * SCRIPT CONVERSION & OPTIMIZATION FOR IOBROKER
 *
 * Improvements over the original Homematic script:
 * 1. Event-driven: The script only runs when necessary.
 * 2. Robust Average Calculation: Counts the measurements for a true average.
 * 3. Automatic Datapoint Creation: Significantly simplifies setup.
 * 4. Stability Check: Only processes valid numeric values from the sensor.
 *
 * REQUIRED DEVICES / DATA POINTS:
 * - An outdoor temperature sensor.
 * - The script automatically creates all other necessary datapoints under '0_userdata.0'.
 */

// --------------- ADJUSTABLE PARAMETERS ---------------

// ID of the outdoor temperature sensor
const SENSOR_TEMP_ID = "hm-rpc.0.000000000000000.1.ACTUAL_TEMPERATURE";

// Threshold in °C: The heating period becomes active below this daily average temperature.
const HEATING_LIMIT_TEMP = 18.0;

// Time for the daily calculation and reset.
const RESET_HOUR = 2;
const RESET_MINUTE = 50;

// --------------- DATAPOINTS (FULL PATHS) ---------------

const AVG_TEMP_DP = "0_userdata.0.Heizung.Allgemein.Tagesmittelwert";
const SUM_CACHE_DP = "0_userdata.0.Heizung.Allgemein.ZwischenspeicherSumme";
const COUNTER_DP = "0_userdata.0.Heizung.Allgemein.MessungenZaehler";
const HEATING_PERIOD_DP = "0_userdata.0.Heizung.Allgemein.HeizperiodeAktiv";
const LAST_RESET_DP = "0_userdata.0.Heizung.Allgemein.LetzterReset";


/**
 * Creates all necessary ioBroker datapoints if they do not yet exist.
 */
async function createDataPoints() {
    log("Checking and creating required datapoints...");
    const dataPoints = {
        [AVG_TEMP_DP]: { name: "Average temperature of the last day", type: "number", role: "value.temperature", unit: "°C", def: 0 },
        [SUM_CACHE_DP]: { name: "Accumulated temperature for the current day", type: "number", role: "value.temperature", unit: "°C", def: 0 },
        [COUNTER_DP]: { name: "Number of temperature measurements for the current day", type: "number", role: "value", unit: "", def: 0 },
        [HEATING_PERIOD_DP]: { name: "Heating period is active", type: "boolean", role: "indicator.heating", def: false },
        [LAST_RESET_DP]: { name: "Date of the last reset", type: "string", role: "date", unit: "", def: "never" }
    };

    for (const [id, common] of Object.entries(dataPoints)) {
        if (!await existsStateAsync(id)) {
            await createStateAsync(id, common.def, { name: common.name, type: common.type, role: common.role, unit: common.unit, read: true, write: true });
            log(`Datapoint '${id}' was created.`);
        }
    }
    log("All datapoints are present.");
}


// --- MAIN PROGRAM ---

// 1. Create all necessary states on script start.
createDataPoints();

// Write start message to log
log(`Script started. Monitoring temperature sensor: ${SENSOR_TEMP_ID}`);

/**
 * Trigger 1: Executes on every update of the temperature sensor.
 * Stores the temperature and counts the measurements for later averaging.
 */
on({ id: SENSOR_TEMP_ID, change: "any" }, async function (obj) {
    const currentTemp = obj.state.val;

    // Check if the value is a valid number.
    if (typeof currentTemp !== 'number') {
        log(`Invalid value received from sensor: ${currentTemp} (Type: ${typeof currentTemp}). Skipping processing.`, 'warn');
        return;
    }

    // Get old values and add the new value
    const oldSum = (await getStateAsync(SUM_CACHE_DP)).val || 0;
    const oldCounter = (await getStateAsync(COUNTER_DP)).val || 0;

    const newSum = oldSum + currentTemp;
    const newCounter = oldCounter + 1;

    // Write the new values back to the datapoints
    await setStateAsync(SUM_CACHE_DP, newSum, true);
    await setStateAsync(COUNTER_DP, newCounter, true);
});

/**
 * Trigger 2: Executes the daily calculation at the specified time (local server time).
 * Calculates the average, sets the heating period, and resets the storage.
 * INFO: 02:50 CET (Winter) = 01:50 UTC | 02:50 CEST (Summer) = 00:50 UTC.
 */
schedule(`${RESET_MINUTE} ${RESET_HOUR} * * *`, async function () {
    log("End-of-day process running: Calculating daily average and setting heating period.");

    // 1. Read values from datapoints
    const sum = (await getStateAsync(SUM_CACHE_DP)).val;
    const counter = (await getStateAsync(COUNTER_DP)).val;

    // 2. Calculate daily average (protection against division by zero)
    const dailyAverage = (counter > 0) ? (sum / counter) : 0;
    await setStateAsync(AVG_TEMP_DP, parseFloat(dailyAverage.toFixed(2)), true);
    log(`Daily average calculated: ${dailyAverage.toFixed(2)}°C (Sum: ${sum.toFixed(2)}°C / Counter: ${counter})`);

    // 3. Reset cache, counter, and reset date for the next day
    await setStateAsync(SUM_CACHE_DP, 0, true);
    await setStateAsync(COUNTER_DP, 0, true);
    
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const monthFormatted = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    const dateString = `${day}.${monthFormatted}.${year}`;
    await setStateAsync(LAST_RESET_DP, dateString, true);

    log("Cache, counter, and reset date have been updated.");

    // 4. Determine and set the heating period
    const month = now.getMonth() + 1; // getMonth() is 0-based (0=Jan), so +1
    const isHeatingTimeframe = (month >= 10 || month <= 5); // October to May
    const isBelowHeatingLimit = (dailyAverage <= HEATING_LIMIT_TEMP);
    const heatingPeriodActive = (isBelowHeatingLimit && isHeatingTimeframe);

    await setStateAsync(HEATING_PERIOD_DP, heatingPeriodActive, true);
    
    // OPTIMIZED: More detailed log output for better traceability
    if (!isHeatingTimeframe) {
        log(`Heating period set to: ${heatingPeriodActive}. Reason: Outside the timeframe (October-May).`);
    } else if (!isBelowHeatingLimit) {
        log(`Heating period set to: ${heatingPeriodActive}. Reason: Daily average (${dailyAverage.toFixed(2)}°C) is above the heating limit (${HEATING_LIMIT_TEMP}°C).`);
    } else {
        log(`Heating period set to: ${heatingPeriodActive}. Reason: Within heating timeframe and daily average (${dailyAverage.toFixed(2)}°C) is below the heating limit (${HEATING_LIMIT_TEMP}°C).`);
    }
});
