/**
 * @fileoverview Heating Optimization (Learning Script) for ioBroker
 * @version 1.6 (Final)
 * @author Sanweb
 * @license MIT
 *
 * PURPOSE OF THE SCRIPT:
 * This script is the "intelligence engine" for the heating control system. It
 * runs periodically in the background, queries the historical flow/return spread
 * from an InfluxDB database, and analyzes it. Based on this analysis,
 * it adjusts "learning" control parameters that are used by the individual room
 * heating scripts to increase their efficiency.
 *
 * REQUIRED DEVICES / DATA POINTS:
 * - A datapoint that measures the temperature spread between flow and return.
 * -> This datapoint MUST be logged in an InfluxDB instance.
 * - A system variable indicating if the heating period is active (summer/winter mode).
 */

// -------------------------------------------------------------------------------------
// 1. CENTRAL CONFIGURATION
// All user-specific settings are made here.
// -------------------------------------------------------------------------------------
const CONFIG = {
    // --- A. BASIC SETTINGS & SIMULATION ---
    
    /** @type {boolean} - If 'true', the script checks on startup if the target datapoints exist and creates them automatically if needed. */
    autoCreateOutputStates: true,

    /** @type {boolean} - Master switch for simulation mode. */
    simulationAktiv: false,
    
    /** @type {boolean} - Master switch for log outputs. */
    debugLogAktiv: true,

    /** @type {number} - The period in hours for which historical data is loaded from InfluxDB for analysis. */
    historyHours: 48,

    /** @type {number} - The number of recent hours from the history used to calculate the current system stability. */
    stabilityCalculationHours: 3,

    /** @type {number} - The base adjustment rate of the learning algorithm. */
    basisLernrate: 0.02,

    /** @type {number} - The minimum flow/return spread in °C that must be present for the script to start a learning cycle. */
    minSpreizungForLearning: 2.0,

    // --- B. ioBroker OBJECT IDs ---

    devices: {
        /** @type {string} - The ID of the datapoint or HmIP-STE2-PCB that measures the spread. */
        spreizungSensorId: 'hm-rpc.0.00000000000000.3.ACTUAL_TEMPERATURE',
    },
    ids: {
        /** @type {string} - The ID of the system variable for the heating mode (summer/winter). */
        svHeizperiodeId: 'hm-rega.0.Heizung.Heizperiode',
    },
    
    // --- C. TARGET DATAPOINTS ---
    output: {
        /** @type {string} - The ID of the datapoint for the learned performance factor. */
        reglerleistungId: '0_userdata.0.Heizung.Optimierung.Reglerleistung',

        /** @type {string} - The ID of the datapoint for the calculated system stability. */
        systemStabilitaetId: '0_userdata.0.Heizung.Optimierung.SystemStabilitaet',
    },

    // --- D. INFLUXDB CONFIGURATION ---

    /** @type {string} - The name of your InfluxDB adapter instance in ioBroker (e.g., 'influxdb.0'). */
    influxdbInstance: 'influxdb.0',

    // --- E. SIMULATION VALUES ---
    simulationValues: {
        /** @type {boolean} - Simulates the state of the heating period (true = winter, false = summer). */
        heizperiode: true,

        /** @type {number} - Simulates a current spread to test the learning trigger. */
        aktuelleSpreizung: 5.5,
    }
};

// -------------------------------------------------------------------------------------
// 2. SCRIPT INITIALIZATION
// -------------------------------------------------------------------------------------
// This function creates the necessary states in '0_userdata.0' if they don't exist.
async function createStates() {
    if (!CONFIG.autoCreateOutputStates) {
        if (CONFIG.debugLogAktiv) log("Learning-Script: Automatic creation of datapoints is disabled.");
        return;
    }

    if (!(await existsStateAsync(CONFIG.output.reglerleistungId))) {
        if (CONFIG.debugLogAktiv) log(`Learning-Script: Datapoint ${CONFIG.output.reglerleistungId} not found. Will be created automatically...`, 'info');
        await createStateAsync(CONFIG.output.reglerleistungId, 1.0, { name: 'Heating Optimization Controller Performance', type: 'number', role: 'value', read: true, write: true, min: 0.0, max: 2.0, def: 1.0, unit: 'Factor' });
    }
    if (!(await existsStateAsync(CONFIG.output.systemStabilitaetId))) {
        if (CONFIG.debugLogAktiv) log(`Learning-Script: Datapoint ${CONFIG.output.systemStabilitaetId} not found. Will be created automatically...`, 'info');
        await createStateAsync(CONFIG.output.systemStabilitaetId, 0.5, { name: 'Heating Optimization System Stability', type: 'number', role: 'value', read: true, write: false, min: 0.0, max: 1.0, def: 0.5, unit: '%' });
    }
}

// -------------------------------------------------------------------------------------
// 3. MAIN FUNCTION (called periodically)
// -------------------------------------------------------------------------------------
async function main() {
    if (CONFIG.debugLogAktiv) log('Learning-Script: Starting learning cycle...');

    let heizperiodeAktiv;
    let aktuelleSpreizung;

    // --- Step 1: Get current system state (either simulated or real) ---
    if (CONFIG.simulationAktiv) {
        if (CONFIG.debugLogAktiv) log("Learning-Script: SIMULATION MODE ACTIVE!");
        heizperiodeAktiv = CONFIG.simulationValues.heizperiode;
        aktuelleSpreizung = CONFIG.simulationValues.aktuelleSpreizung;
    } else {
        const heizperiodeState = await getStateAsync(CONFIG.ids.svHeizperiodeId);
        heizperiodeAktiv = heizperiodeState ? heizperiodeState.val : false;
        
        const aktuelleSpreizungState = await getStateAsync(CONFIG.devices.spreizungSensorId);
        aktuelleSpreizung = aktuelleSpreizungState ? aktuelleSpreizungState.val : 0;
    }

    // Exit if heating period is not active.
    if (!heizperiodeAktiv) {
        if (CONFIG.debugLogAktiv) log("Learning-Script: Heating period is 'off'. Script will not be executed.");
        return;
    }
    
    // Exit if the current spread is too low, indicating the boiler is likely inactive.
    if (typeof aktuelleSpreizung !== 'number' || aktuelleSpreizung < CONFIG.minSpreizungForLearning) {
        if (CONFIG.debugLogAktiv) {
            log(`Learning-Script: Current spread (${aktuelleSpreizung}°C) is below the threshold of ${CONFIG.minSpreizungForLearning}°C. No learning cycle, as the boiler is probably inactive.`);
        }
        return;
    }

    // --- Step 2: Query historical data from InfluxDB (via getHistory) ---
    let historyData;
    try {
        const end = new Date().getTime();
        const start = end - (CONFIG.historyHours * 3600 * 1000);

        const result = await sendToAsync(CONFIG.influxdbInstance, 'getHistory', {
            id: CONFIG.devices.spreizungSensorId,
            options: {
                start: start,
                end: end,
                aggregate: 'none', // We want the raw data
            }
        });

        if (result.error) throw new Error(result.error);
        if (!result.result || result.result.length === 0) throw new Error('Received no or empty data from InfluxDB.');
        
        // Sanitize the received data.
        historyData = result.result.map(item => item.val).filter(v => v !== null && v >= 0);
        if (CONFIG.debugLogAktiv) log(`Learning-Script: ${historyData.length} historical spread values loaded from InfluxDB (via getHistory).`);

    } catch (e) {
        const errorMessage = e.message || JSON.stringify(e);
        log(`Learning-Script: ERROR querying InfluxDB: ${errorMessage}.`, 'error');
        return;
    }

    // Exit if there is not enough data for a meaningful analysis.
    if (historyData.length < 3) {
        if (CONFIG.debugLogAktiv) log(`Learning-Script: Not enough historical data (${historyData.length}) available for analysis.`);
        return;
    }

    // --- Step 3: Calculate system stability ---
    // Use the most recent data window for calculation.
    const stabilityWindow = historyData.slice(- (CONFIG.stabilityCalculationHours * 2)); // Assuming data points every 30 minutes
    const sum = stabilityWindow.reduce((a, b) => a + b, 0);
    const mean = sum / stabilityWindow.length;
    // Variance measures how much the values fluctuate around the average.
    const variance = stabilityWindow.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / stabilityWindow.length;
    // A high variance leads to low stability and vice versa.
    const stability = 1.0 / (1.0 + variance);
    
    // --- Step 4: Learning logic - Adjust controller performance ---
    const currentReglerleistungState = await getStateAsync(CONFIG.output.reglerleistungId);
    let newReglerleistung = currentReglerleistungState ? currentReglerleistungState.val : 1.0;
    const avg3h = mean;
    let adjustmentCase = "Default-Convergence";

    // Case 1: Low spread and low stability -> System is sluggish/unstable. Increase performance factor more aggressively.
    if (avg3h < 7.0 && stability < 0.4) {
        newReglerleistung += ((7.0 - avg3h) / 7.0) * (CONFIG.basisLernrate * 2.0);
        adjustmentCase = "Case 1: System sluggish/unstable";
    // Case 2: High spread and high stability -> System is overreacting. Dampen the performance factor.
    } else if (avg3h > 16.0 && stability > 0.6) {
        newReglerleistung *= 0.95;
        adjustmentCase = "Case 2: System overreacting";
    // Case 3: Spread and stability are in the optimal range. Gently converge towards the ideal value of 1.0.
    } else if (avg3h >= 8.0 && avg3h <= 12.0 && stability > 0.7) {
        newReglerleistung = newReglerleistung * 0.99 + 0.01;
        adjustmentCase = "Case 3: System in optimal range";
    // Default Case: Gently converge the performance factor towards 1.0, influenced by current stability.
    } else {
        newReglerleistung += (1.0 - newReglerleistung) * (CONFIG.basisLernrate * stability);
    }

    // Set hard limits for the performance factor to prevent extreme values.
    if (newReglerleistung < 0.3) newReglerleistung = 0.3;
    if (newReglerleistung > 1.7) newReglerleistung = 1.7;

    // --- Step 5: Write results (only in normal operation) ---
    const simHinweis = CONFIG.simulationAktiv ? " (SIMULATION - values will not be written)" : "";
    if (!CONFIG.simulationAktiv) {
        await setStateAsync(CONFIG.output.systemStabilitaetId, parseFloat(stability.toFixed(4)), true);
        await setStateAsync(CONFIG.output.reglerleistungId, parseFloat(newReglerleistung.toFixed(4)), true);
    }
    
    if (CONFIG.debugLogAktiv) {
        log(`Learning-Script: System stability calculated: ${stability.toFixed(2)}${simHinweis}`);
        log(`Learning-Script: LEARNING (${adjustmentCase}). New controller performance: ${newReglerleistung.toFixed(3)}${simHinweis}`);
    }
}

// -------------------------------------------------------------------------------------
// 4. SCRIPT START & TRIGGER
// -------------------------------------------------------------------------------------
(async () => {
    await createStates();
    // Schedule the main function to run periodically.
    schedule('*/30 * * * *', main); // Every 30 minutes
    // Run once shortly after the script starts for immediate initialization.
    setTimeout(main, 10000); // After 10 seconds
})();

