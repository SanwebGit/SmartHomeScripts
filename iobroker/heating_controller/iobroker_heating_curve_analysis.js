/**
 * @fileoverview Heating Curve Analysis Script ("Air Traffic Control")
 * @version 2.1 - Intelligent comparison with adaptive boiler automation
 * @author Sanweb
 * @license MIT
 *
 * PURPOSE OF THE SCRIPT:
 * This script is a higher-level analysis instance. It periodically analyzes
 * the historical performance data of the entire system and compares it with the
 * boiler's own adaptive control to provide well-founded recommendations for
 * optimizing the fundamental heating curve parameters.
 *
 * REQUIRED DEVICES / DATA POINTS:
 * - A datapoint that measures the temperature spread between flow and return.
 * -> This datapoint MUST be logged in an InfluxDB instance.
 * - An adapter that can read data directly from your boiler (e.g., ebus, KM200).
 * -> Required values: Damped average outdoor temperature, current base heating curve,
 * and the current adaptive offset of the boiler.
 * - A system variable indicating if the heating period is active.
 */

// -------------------------------------------------------------------------------------
// 1. CENTRAL CONFIGURATION
// -------------------------------------------------------------------------------------
const CONFIG = {
    // --- A. BASIC SETTINGS ---
    debugLogAktiv: true,
    historyHours: 48,       // How many hours of history data to fetch from the database.
    analyseHours: 6,        // How many of the most recent hours to use for the analysis.

    // --- B. TEMPERATURE THRESHOLDS FOR ANALYSIS ---
    tempGrenzeSteilheit: 0.0, // Below this outdoor temperature, the slope is analyzed.
    tempGrenzeNiveau: 5.0,    // Above this outdoor temperature, the level (offset) is analyzed.

    // --- C. ioBroker OBJECT IDs (INPUTS) ---
    ids: {
        svHeizperiodeId: 'hm-rega.0.Heizung.Heizperiode',
        // CORRECTED: Now uses the boiler's internal, damped average outdoor temperature.
        aussenTempId: 'ebus.0.700.messages.OutsideTempAvg.fields.tempv.value',
        // Datapoint measuring the difference between flow and return. MUST be logged in InfluxDB!
        spreizungSensorId: 'hm-rpc.0.000000000000000.3.ACTUAL_TEMPERATURE',
        // CORRECTED: Reads the manually set base heating curve.
        aktuelleHeizkurveId: 'ebus.0.700.messages.Hc1HeatCurve.fields.0.value',
        // NEW: Reads the current shift by the boiler's adaptive automation.
        adaptiveHeizkurveId: 'ebus.0.700.messages.Hc1HeatCurveAdaption.fields.value.value',
    },

    // --- D. TARGET DATAPOINTS (OUTPUTS) ---
    output: {
        empfohleneSteilheitId: '0_userdata.0.Heizung.Analyse.EmpfohleneSteilheit', // Recommended slope (e.g., 1.2)
        empfohlenesNiveauId: '0_userdata.0.Heizung.Analyse.EmpfohlenesNiveau',     // Recommended level/offset in K
        letzteAnalyseSteilheit: '0_userdata.0.Heizung.Analyse.LetzteAnalyseSteilheit', // Timestamp and result of the last slope analysis
        letzteAnalyseNiveau: '0_userdata.0.Heizung.Analyse.LetzteAnalyseNiveau',     // Timestamp and result of the last level analysis
    },
    
    // --- E. INFLUXDB CONFIGURATION ---
    influxdbInstance: 'influxdb.0',
};

// -------------------------------------------------------------------------------------
// 2. SCRIPT INITIALIZATION
// -------------------------------------------------------------------------------------
// This function creates the necessary states in '0_userdata.0' if they don't exist.
async function createStates() {
    if (!(await existsStateAsync(CONFIG.output.empfohleneSteilheitId))) {
        await createStateAsync(CONFIG.output.empfohleneSteilheitId, 1.2, { name: 'Analysis: Recommended Heating Curve Slope', type: 'number', role: 'value', read: true, write: true, def: 1.2, unit: '' });
    }
    if (!(await existsStateAsync(CONFIG.output.empfohlenesNiveauId))) {
        await createStateAsync(CONFIG.output.empfohlenesNiveauId, 0.0, { name: 'Analysis: Recommended Heating Curve Level', type: 'number', role: 'value', read: true, write: true, def: 0.0, unit: 'K' });
    }
    if (!(await existsStateAsync(CONFIG.output.letzteAnalyseSteilheit))) {
        await createStateAsync(CONFIG.output.letzteAnalyseSteilheit, "never", { name: 'Analysis: Last analysis of slope', type: 'string', role: 'text', read: true, write: false });
    }
     if (!(await existsStateAsync(CONFIG.output.letzteAnalyseNiveau))) {
        await createStateAsync(CONFIG.output.letzteAnalyseNiveau, "never", { name: 'Analysis: Last analysis of level', type: 'string', role: 'text', read: true, write: false });
    }
}


// -------------------------------------------------------------------------------------
// 3. MAIN FUNCTION (called periodically)
// -------------------------------------------------------------------------------------
async function analyseSystem() {
    if (CONFIG.debugLogAktiv) log('[Analysis] Starting periodic system analysis...');

    // Exit if the heating period is not active.
    const heizperiodeState = await getStateAsync(CONFIG.ids.svHeizperiodeId);
    if (!heizperiodeState || !heizperiodeState.val) {
        if (CONFIG.debugLogAktiv) log("[Analysis] Heating period is 'off'. Skipping analysis.");
        return;
    }

    // Get current values from the heating system.
    const aussenTempState = await getStateAsync(CONFIG.ids.aussenTempId);
    const kurveState = await getStateAsync(CONFIG.ids.aktuelleHeizkurveId);
    const adaptiveKurveState = await getStateAsync(CONFIG.ids.adaptiveHeizkurveId);

    // Exit if any of the required datapoints cannot be read.
    if (!aussenTempState || !kurveState || !adaptiveKurveState) {
        if (CONFIG.debugLogAktiv) log('[Analysis] One of the required input datapoints could not be read. Skipping analysis.', 'warn');
        return;
    }

    const aussenTemp = aussenTempState.val;
    const aktuelleBasisKurve = kurveState.val;
    const aktuelleAdaption = adaptiveKurveState.val;
    const jetzt = new Date().toLocaleString('en-US');
    
    // Fetch historical data for the temperature spread from InfluxDB.
    let historyData;
    try {
        const end = new Date().getTime();
        const start = end - (CONFIG.historyHours * 3600 * 1000);
        const result = await sendToAsync(CONFIG.influxdbInstance, 'getHistory', {
            id: CONFIG.ids.spreizungSensorId,
            options: { start: start, end: end, aggregate: 'none' } // 'none' retrieves raw data
        });

        if (result.error) throw new Error(result.error);
        if (!result.result || result.result.length === 0) throw new Error('Received no or empty data from InfluxDB.');
        
        // Filter out null values and implausible low values (e.g., when the pump is off).
        historyData = result.result.map(item => item.val).filter(v => v !== null && v > 1.0);
    
    } catch (e) {
        log(`[Analysis] ERROR querying InfluxDB: ${e.message}`, 'error');
        return;
    }
    
    // Use only the most recent part of the data for the analysis.
    const analyseWindow = historyData.slice(- (CONFIG.analyseHours * 2)); // Assuming data every 30 minutes
    if (analyseWindow.length < 5) {
        if (CONFIG.debugLogAktiv) log(`[Analysis] Not enough active heating data points (${analyseWindow.length}) available for analysis.`);
        return;
    }

    // Calculate the average spread in the analysis window.
    const avgSpreizung = analyseWindow.reduce((a, b) => a + b, 0) / analyseWindow.length;
    
    // --- LOGIC FOR SLOPE ANALYSIS (at low outdoor temperatures) ---
    if (aussenTemp <= CONFIG.tempGrenzeSteilheit) {
        if (CONFIG.debugLogAktiv) log(`[Analysis] OT (${aussenTemp}°C) is suitable. Checking slope with avg spread ${avgSpreizung.toFixed(1)}°C & adaptation ${aktuelleAdaption}...`);

        // A high spread indicates the system is delivering too little heat.
        if (avgSpreizung > 15.0) {
             // If the boiler is not already compensating, recommend a higher base slope.
             if (aktuelleAdaption < 0.1) {
                 if (CONFIG.debugLogAktiv) log(`[Analysis] System undersupplied, boiler is not adapting. Recommending higher slope.`);
                 const neueEmpfehlung = parseFloat((aktuelleBasisKurve + 0.1).toFixed(1));
                 await setStateAsync(CONFIG.output.empfohleneSteilheitId, neueEmpfehlung, true);
                 await setStateAsync(CONFIG.output.letzteAnalyseSteilheit, `${jetzt}: Recommendation increased to ${neueEmpfehlung}.`, true);
             } else {
                 if (CONFIG.debugLogAktiv) log(`[Analysis] System undersupplied, but boiler is already adapting (${aktuelleAdaption}). No recommendation needed.`);
                 await setStateAsync(CONFIG.output.letzteAnalyseSteilheit, `${jetzt}: No change (boiler is adapting itself).`, true);
             }
        } 
        // A low spread indicates too much heat is being delivered.
        else if (avgSpreizung < 5.0) {
            if (CONFIG.debugLogAktiv) log(`[Analysis] System oversupplied. Recommending lower slope.`);
            const neueEmpfehlung = parseFloat((aktuelleBasisKurve - 0.1).toFixed(1));
            await setStateAsync(CONFIG.output.empfohleneSteilheitId, neueEmpfehlung, true);
            await setStateAsync(CONFIG.output.letzteAnalyseSteilheit, `${jetzt}: Recommendation decreased to ${neueEmpfehlung}.`, true);
        }
        // The spread is in the optimal range.
        else {
             if (CONFIG.debugLogAktiv) log(`[Analysis] System in optimal range. No change in slope recommended.`);
             await setStateAsync(CONFIG.output.letzteAnalyseSteilheit, `${jetzt}: No change recommended.`, true);
        }
    }
    // --- LOGIC FOR LEVEL ANALYSIS (at mild outdoor temperatures) ---
    else if (aussenTemp >= CONFIG.tempGrenzeNiveau) {
        if (CONFIG.debugLogAktiv) log(`[Analysis] OT (${aussenTemp}°C) is suitable. Checking level... (Logic not yet implemented)`);
        await setStateAsync(CONFIG.output.letzteAnalyseNiveau, `${jetzt}: Analysis not yet implemented.`, true);
    } 
    // The outdoor temperature is in a neutral range where a clear analysis is difficult.
    else {
        if (CONFIG.debugLogAktiv) log(`[Analysis] OT (${aussenTemp}°C) is in a 'neutral' range. No analysis.`);
    }
}

// -------------------------------------------------------------------------------------
// 4. SCRIPT START & TRIGGER
// -------------------------------------------------------------------------------------
(async () => {
    await createStates();
    // This script intentionally runs infrequently as it performs a long-term analysis.
    schedule('0 */4 * * *', analyseSystem); // Every 4 hours
    setTimeout(analyseSystem, 30000); // Run once 30 seconds after script start.
})();

