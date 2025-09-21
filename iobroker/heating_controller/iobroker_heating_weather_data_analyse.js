/**
 * @fileoverview Weather Data Analysis Script for Proactive Heating Control
 * @version 1.0
 * @author Sanweb
 * @license MIT
 *
 * PURPOSE OF THE SCRIPT:
 * This script collects and analyzes current and historical weather data
 * to generate predictive metrics for heating control.
 * It serves as a central intelligence layer to transform the heating system
 * from a reactive to an anticipatory (forward-looking) system.
 *
 * ANALYSIS LAYERS:
 * 1. Current Weather Situation: Calculation of real-time factors (e.g., heat loss due to wind).
 * 2. Short-Term Analysis (48h): Detection of trends and forecast for the next few hours.
 * 3. Long-Term Analysis (168h): Assessment of the overall weather character of the week.
 *
 * FEEDBACK INTEGRATION:
 * The script can optionally analyze historical heating control data
 * (e.g., spread, controller performance) to learn how the system
 * has responded to specific weather conditions in the past.
 *
 * REQUIRED DEVICES / DATA POINTS:
 * - A weather station or weather service providing the necessary data points.
 * -> All datapoints listed in `weatherIds` must be available and logged in InfluxDB.
 * - An InfluxDB adapter instance for querying historical data.
 * - Optional: The output datapoints from other heating scripts for the feedback loop.
 */

// -------------------------------------------------------------------------------------
// 1. CENTRAL CONFIGURATION
// -------------------------------------------------------------------------------------
const CONFIG = {
    // --- A. BASIC SETTINGS ---
    debugLogAktiv: true,      // Master switch for log outputs.
    autoCreateStates: true,   // Should the target datapoints be created automatically?

    // --- B. INFLUXDB CONFIGURATION ---
    influxdbInstance: 'influxdb.0', // The name of your InfluxDB adapter instance.

    // --- C. INPUT IDs: WEATHER STATION ---
    // NOTE: Please enter the exact paths to your weather datapoints here.
    weatherIds: {
        solarradiation: '0_userdata.0.Wetter.solarradiation', // W/m² - Most important value for solar gain
        windspeed: '0_userdata.0.Wetter.windspeed',          // km/h - Most important value for heat loss
        temp: '0_userdata.0.Wetter.temp',                    // °C   - Outside temperature
        feelslike: '0_userdata.0.Wetter.feelslike',          // °C   - Feels-like temperature
        humidity: '0_userdata.0.Wetter.humidity',            // %    - Outside humidity
        dailyrain: '0_userdata.0.Wetter.dailyrain',          // mm   - Rainfall amount (indicator for clouds/cooling)
        winddir: '0_userdata.0.Wetter.winddir',              // °    - Wind direction for advanced logic
    },

    // --- D. INPUT IDs: HEATING SYSTEM (For optional feedback loop) ---
    // This data is read from InfluxDB to analyze the system's reaction.
    heatingSystemIds: {
        aktuelleSpreizung: '0_userdata.0.Heizung.Analyse.AktuelleSpreizung',
        reglerleistung: '0_userdata.0.Heizung.Optimierung.Reglerleistung',
        hoechsteAnforderung: '0_userdata.0.Heizung.Zentral.HoechsteAnforderungTemp',
    },

    // --- E. OUTPUT IDs: TARGET DATAPOINTS ---
    // These datapoints will be created and populated by the script.
    outputIds: {
        aktuellerZustand: '0_userdata.0.Heizung.Analyse.Wetter_AktuellerZustand',      // Text: e.g., "Sunny and calm"
        heizunterstuetzungSolar: '0_userdata.0.Heizung.Analyse.Wetter_Heizunterstuetzung_Solar', // Factor (0-1), how much the sun is helping
        waermeverlustWind: '0_userdata.0.Heizung.Analyse.Wetter_Waermeverlust_Wind',        // Factor (>1), how much the wind is cooling
        prognoseTrendKurz: '0_userdata.0.Heizung.Analyse.Wetter_Prognose_Trend_Kurz',       // Text: e.g., "Clearing up and cooler"
        prognoseTrendLang: '0_userdata.0.Heizung.Analyse.Wetter_Prognose_Trend_Lang',       // Text: e.g., "Stable high-pressure influence"
    },
};

// -------------------------------------------------------------------------------------
// 2. SCRIPT INITIALIZATION
// -------------------------------------------------------------------------------------

/**
 * Creates the target datapoints if they do not exist.
 */
async function createStates() {
    if (!CONFIG.autoCreateStates) return;
    if (CONFIG.debugLogAktiv) log('[Weather-Analysis] Checking and creating datapoints...');

    const statesToCreate = {
        [CONFIG.outputIds.aktuellerZustand]: { name: 'Weather: Current Condition', type: 'string', role: 'text', def: 'unknown' },
        [CONFIG.outputIds.heizunterstuetzungSolar]: { name: 'Weather: Heating Support from Sun', type: 'number', role: 'value', unit: 'Factor', def: 0 },
        [CONFIG.outputIds.waermeverlustWind]: { name: 'Weather: Heat Loss from Wind', type: 'number', role: 'value', unit: 'Factor', def: 1 },
        [CONFIG.outputIds.prognoseTrendKurz]: { name: 'Weather: Forecast Trend Short (48h)', type: 'string', role: 'text', def: 'unknown' },
        [CONFIG.outputIds.prognoseTrendLang]: { name: 'Weather: Forecast Trend Long (7d)', type: 'string', role: 'text', def: 'unknown' },
    };

    for (const id in statesToCreate) {
        if (!(await existsStateAsync(id))) {
            await createStateAsync(id, statesToCreate[id].def, { ...statesToCreate[id], read: true, write: false });
        }
    }
}

// -------------------------------------------------------------------------------------
// 3. DATA ACQUISITION
// -------------------------------------------------------------------------------------

/**
 * Fetches the current values of all required datapoints.
 * @returns {Promise<Object>} An object with the current values.
 */
async function getCurrentData() {
    const data = {};
    for (const key in CONFIG.weatherIds) {
        const state = await getStateAsync(CONFIG.weatherIds[key]);
        data[key] = state ? state.val : null;
    }
    return data;
}

/**
 * Fetches historical data for a list of IDs from InfluxDB.
 * @param {string[]} idList - List of datapoint IDs to query.
 * @param {number} hours - The time period in hours to look back.
 * @returns {Promise<Object>} An object with the historical data series.
 */
async function getHistoryData(idList, hours) {
    const history = {};
    const end = Date.now();
    const start = end - (hours * 3600 * 1000);

    for (const id of idList) {
        try {
            const result = await sendToAsync(CONFIG.influxdbInstance, 'getHistory', {
                id: id,
                options: { start: start, end: end, aggregate: 'mean', step: 3600 * 1000 } // Hourly mean values
            });
            if (result.result) {
                history[id] = result.result.filter(item => item.val !== null);
            } else {
                history[id] = [];
            }
        } catch (e) {
            log(`[Weather-Analysis] Error querying history for ${id}: ${e.message}`, 'error');
            history[id] = [];
        }
    }
    return history;
}

// -------------------------------------------------------------------------------------
// 4. ANALYSIS LAYERS
// -------------------------------------------------------------------------------------

/**
 * ANALYSIS LAYER 1: Processes the current data.
 * @param {Object} data - Object with the current weather values.
 * @returns {Object} Calculated real-time metrics.
 */
function analyseCurrentData(data) {
    let condition = 'Undetermined';
    if (data.solarradiation !== null && data.windspeed !== null && data.dailyrain !== null) {
        condition = data.solarradiation > 400 ? 'Sunny' : (data.dailyrain > 0.1 ? 'Rainy' : 'Cloudy');
        condition += data.windspeed > 25 ? ' & windy' : (data.windspeed < 5 ? ' & calm' : ' & moderate wind');
    }

    // Factor for solar support (0 = none, 1 = very strong).
    // Assumption: 800 W/m² is a very sunny day where the sun provides maximum support.
    const heizunterstuetzungSolar = Math.min(1, Math.max(0, (data.solarradiation || 0) / 800));

    // Factor for heat loss due to wind (1 = no wind, >1 = wind cools).
    // Assumption: At 35 km/h wind, heat loss increases significantly (factor 2).
    const waermeverlustWind = 1 + ((data.windspeed || 0) / 35);

    return {
        aktuellerZustand: condition,
        heizunterstuetzungSolar: parseFloat(heizunterstuetzungSolar.toFixed(3)),
        waermeverlustWind: parseFloat(waermeverlustWind.toFixed(3)),
    };
}

/**
 * ANALYSIS LAYER 2: Analyzes 48h trends.
 * @param {Object} history - Object with the 48h histories.
 * @returns {Object} Calculated short-term trends.
 */
function analyse48hData(history) {
    const tempHistory = history[CONFIG.weatherIds.temp] || [];
    const solarHistory = history[CONFIG.weatherIds.solarradiation] || [];

    let trendText = '';

    // Temperature trend
    if (tempHistory.length > 24) {
        const avgFirst24h = tempHistory.slice(0, 24).reduce((sum, item) => sum + item.val, 0) / 24;
        const avgLast24h = tempHistory.slice(-24).reduce((sum, item) => sum + item.val, 0) / 24;
        const diff = avgLast24h - avgFirst24h;
        if (diff > 1) trendText += 'Warming';
        else if (diff < -1) trendText += 'Cooling';
        else trendText += 'Stable';
    }

    // Solar trend / cloudiness
    if (solarHistory.length > 24) {
        const avgSolarLast24h = solarHistory.slice(-24).reduce((sum, item) => sum + item.val, 0) / 24;
        if (avgSolarLast24h > 200) trendText += ', sunny periods';
        else if (avgSolarLast24h < 50) trendText += ', heavily clouded';
    }

    return { prognoseTrendKurz: trendText || 'No data' };
}


/**
 * ANALYSIS LAYER 3: Analyzes 168h trends.
 * @param {Object} history - Object with the 168h histories.
 * @returns {Object} Calculated long-term trends.
 */
function analyse168hData(history) {
    const tempHistory = history[CONFIG.weatherIds.temp] || [];
    let trendText = 'No data';

    if (tempHistory.length > 100) { // Requires about 4 days of data
        const halfIndex = Math.floor(tempHistory.length / 2);
        const avgFirstHalf = tempHistory.slice(0, halfIndex).reduce((sum, item) => sum + item.val, 0) / halfIndex;
        const avgSecondHalf = tempHistory.slice(halfIndex).reduce((sum, item) => sum + item.val, 0) / (tempHistory.length - halfIndex);
        const diff = avgSecondHalf - avgFirstHalf;
        
        if (diff > 1.5) trendText = 'Significant warming trend';
        else if (diff < -1.5) trendText = 'Significant cooling trend';
        else trendText = 'Stable weather conditions';
    }

    return { prognoseTrendLang: trendText };
}

// -------------------------------------------------------------------------------------
// 5. MAIN FUNCTION & CONTROL
// -------------------------------------------------------------------------------------

/**
 * Executes the entire analysis process.
 */
async function runAnalysis() {
    if (CONFIG.debugLogAktiv) log('[Weather-Analysis] Starting new analysis run...');

    // 1. Acquire data
    const currentData = await getCurrentData();
    const historyIds = Object.values(CONFIG.weatherIds); // Optional: .concat(Object.values(CONFIG.heatingSystemIds));
    const history48h = await getHistoryData(historyIds, 48);
    const history168h = await getHistoryData(historyIds, 168);

    // 2. Analyze data
    const resultLayer1 = analyseCurrentData(currentData);
    const resultLayer2 = analyse48hData(history48h);
    const resultLayer3 = analyse168hData(history168h);

    // 3. Merge results and write to datapoints
    const finalResults = { ...resultLayer1, ...resultLayer2, ...resultLayer3 };
    for (const key in finalResults) {
        // Find the matching output ID key (e.g., 'aktuellerZustand')
        const outputKey = Object.keys(CONFIG.outputIds).find(k => k.toLowerCase().includes(key.toLowerCase()));
        if (outputKey) {
            await setStateAsync(CONFIG.outputIds[outputKey], finalResults[key], true);
        }
    }

    if (CONFIG.debugLogAktiv) {
        log(`[Weather-Analysis] Analysis complete. Condition: "${finalResults.aktuellerZustand}", Solar: ${finalResults.heizunterstuetzungSolar}, Wind: ${finalResults.waermeverlustWind}, Trend (48h): "${finalResults.prognoseTrendKurz}"`);
    }
}

// -------------------------------------------------------------------------------------
// 6. SCRIPT START & TRIGGERS
// -------------------------------------------------------------------------------------
(async () => {
    await createStates();
    
    // Periodic trigger for the analysis (every 15 minutes)
    schedule('*/15 * * * *', runAnalysis);
    
    // Run once after a short delay to ensure all adapters are ready.
    setTimeout(runAnalysis, 5000);
})();

