// @ts-check
/* global clearInterval, clearSchedule, clearTimeout, createState,
   createStateAsync, existsState, existsStateAsync, getObjectAsync,
   getState, getStateAsync, log, on, onStop, require, schedule,
   sendTo, sendToAsync, setInterval, setObjectAsync, setState,
   setStateAsync, setTimeout */

/**
 * @fileoverview Universelle, intelligente Einzelraum-Heizungssteuerung für ioBroker
 * @version 6.15 (Paket 1: Global-Header + Lernwerte-Pfad-Bugfix + Math.log10-Bugfix)
 * @author Sanweb
 * @license MIT
 *
 * -------------------------------------------------------------------------------------
 * ZWECK DES SKRIPTS:
 * -------------------------------------------------------------------------------------
 * Dieses Skript ist die ausführende Steuerung ("Muskel") für einen einzelnen Raum.
 * Es berechnet die optimale Soll-Temperatur basierend auf Anwesenheit, Fenstersensoren,
 * physikalischen Modulen und den proaktiven Wetter-Faktoren.
 *
 * NEU in V6.15 (Paket 1 Bugfixes):
 * - BUGFIX: Lernwerte-Pfad zeigt nun korrekt auf Esszimmer (vorher: Badezimmer)
 * - BUGFIX: Magnus-Formel verwendet nun korrekt Math.log10() statt Math.log()
 * - NEU: @ts-check / global-Header eingefügt (unterdrückt Highlighter-Warnungen)
 * -------------------------------------------------------------------------------------
 */

(function () {
    'use strict';

    // -------------------------------------------------------------------------------------
    // 1. ZENTRALE KONFIGURATION
    // -------------------------------------------------------------------------------------
    const CONFIG = {
        // --- A. RAUMNAME & GRUNDEINSTELLUNGEN ---
        roomName: 'Esszimmer',
        nachtschaltungNutzen: true,
        tuerSensorNutzen: false,
        hysterese: 0.5,
        tempFensterOffen: 12.0,
        tempHeizperiodeAus: 4.5,
        temperaturOffset: 0.0,
        minSollTemp: 16.0,
        maxSollTemp: 24.0,

        // --- B. HIMMELSRICHTUNG DER FENSTER ---
        ausrichtungFenster: ['Nord', 'Ost'],

        // --- C. GLOBALE SYSTEMVARIABLE ---
        ids: {
            heizPeriode: '0_userdata.0.Heizung.Allgemein.HeizperiodeAktiv',
            anwesenheit: '0_userdata.0.Anwesenheit.Status',
            nachtschaltung: '0_userdata.0.System.Nachtschaltung.Aktiv',
            sollTempAnwesend: '0_userdata.0.Heizung.sollTempAnwesend',
            sollTempAbwesend: '0_userdata.0.Heizung.sollTempAbwesend',
        },

        // --- D. RAUMSPEZIFISCHE GERÄTE & SENSOREN ---
        devices: {
            thermostate: ['hm-rpc.2.INT0000004.1.SET_POINT_TEMPERATURE'],
            fensterKontakte: ['hm-rpc.0.0023DA49A3B05C.1.STATE'],
            tuerSensor: 'hm-rpc.0.00000000000000.0.STATE',
            aussenTempSensor: 'hm-rpc.0.0010DBE98CEC7B.1.ACTUAL_TEMPERATURE',
            feuchteSensor: 'hm-rpc.2.INT0000004.1.HUMIDITY',
            wandSensorOberflaeche: 'hm-rpc.0.002822699B7E86.1.ACTUAL_TEMPERATURE',
            wandSensorKern: 'hm-rpc.0.002822699B7E86.2.ACTUAL_TEMPERATURE',
        },

        // --- E. PFADE ZU DEN WETTER-FAKTOREN ---
        wetterDatenPfade: {
            basisPfadSolar: '0_userdata.0.Heizung.Analyse.Wetter_Heizunterstuetzung_Solar_',
            basisPfadWind: '0_userdata.0.Heizung.Analyse.Wetter_Waermeverlust_Wind_',
        },

        // --- F. PFADE ZU DEN GELERNTEN KORREKTURWERTEN (VOM ML-SKRIPT) ---
        // BUGFIX V6.15: Korrekter Pfad Esszimmer (vorher fälschlicherweise Badezimmer)
        lernwerte: {
            solarKorrekturId: '0_userdata.0.Heizung.Lernwerte.Esszimmer.Solar_Korrektur',
            windKorrekturId: '0_userdata.0.Heizung.Lernwerte.Esszimmer.Wind_Korrektur',
        },

        // --- G. BASIS-REGELUNG & PHYSIK-MODULE ---
        basisRegelung: {
            aussenTempNeutral: 12.0,
            heizkurvenfaktor: 0.1,
            luftfeuchteOptimal: 70.0,
            feuchteKorrekturfaktor: 0.02,
        },
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

        // --- H. DEBUG & TRIGGER-SCHWELLENWERTE ---
        debugLogAktiv: false,
        aussenTempTriggerThreshold: 1.0,
        raumTempTriggerThreshold: 0.3,
        luftfeuchteTriggerThreshold: 5.0,

        // --- I. DEBOUNCE & DUTY CYCLE SCHUTZ ---
        debounceConfig: {
            aktiv: true,
            delayHighPriority: 20000,
            delayLowPriority: 1000,
        },
    };

    // -------------------------------------------------------------------------------------
    // 2. HAUPTFUNKTION (wird durch Trigger aufgerufen)
    // -------------------------------------------------------------------------------------
    async function main() {
        try {
            const states = {
                heizPeriode: (await getStateAsync(CONFIG.ids.heizPeriode))?.val,
                anwesenheit: (await getStateAsync(CONFIG.ids.anwesenheit))?.val,
                nachtschaltung: (await getStateAsync(CONFIG.ids.nachtschaltung))?.val,
                sollTempAnwesend: (await getStateAsync(CONFIG.ids.sollTempAnwesend))?.val,
                sollTempAbwesend: (await getStateAsync(CONFIG.ids.sollTempAbwesend))?.val,
                tuerSensor: CONFIG.tuerSensorNutzen ? (await getStateAsync(CONFIG.devices.tuerSensor))?.val : null,
                aussenTempSensor: (await getStateAsync(CONFIG.devices.aussenTempSensor))?.val,
                feuchteSensor: (await getStateAsync(CONFIG.devices.feuchteSensor))?.val,
                wandSensorOberflaeche: (await getStateAsync(CONFIG.devices.wandSensorOberflaeche))?.val,
                wandSensorKern: (await getStateAsync(CONFIG.devices.wandSensorKern))?.val,
                solarKorrekturId: (await getStateAsync(CONFIG.lernwerte.solarKorrekturId))?.val,
                windKorrekturId: (await getStateAsync(CONFIG.lernwerte.windKorrekturId))?.val,
                fensterKontakte: []
            };

            for (const subId of CONFIG.devices.fensterKontakte) {
                states.fensterKontakte.push((await getStateAsync(subId))?.val);
            }

            const aussenSensorOK =
                typeof states.aussenTempSensor === 'number' && states.aussenTempSensor > -30.0 && states.aussenTempSensor < 60.0;
            const feuchteSensorOK =
                typeof states.feuchteSensor === 'number' && states.feuchteSensor >= 0.0 && states.feuchteSensor <= 100.0;

            let sollTempAnwesend = states.sollTempAnwesend || 21.0;
            const sollTempAbwesend = states.sollTempAbwesend || 16.0;

            if (CONFIG.nachtschaltungNutzen && states.nachtschaltung) {
                sollTempAnwesend = sollTempAbwesend;
            }

            const isDoorPhysicallyClosed =
                states.tuerSensor === 0 ||
                states.tuerSensor === false ||
                states.tuerSensor === '0' ||
                states.tuerSensor === 'false';

            const fensterIstOffen = states.fensterKontakte.some(
                state => state === true || state === 1 || state === 'true' || state === '1'
            );

            let logModuleAction = '';
            let logWetter = '';

            let neueSollTemp;
            let istSonderfall = false;

            if (states.heizPeriode) {
                if (fensterIstOffen) {
                    neueSollTemp = CONFIG.tempFensterOffen;
                    istSonderfall = true;
                } else if (states.anwesenheit) {
                    if (CONFIG.tuerSensorNutzen && isDoorPhysicallyClosed) {
                        neueSollTemp = sollTempAbwesend;
                    } else {
                        neueSollTemp = sollTempAnwesend;
                    }
                } else {
                    neueSollTemp = sollTempAbwesend;
                }
            } else {
                neueSollTemp = CONFIG.tempHeizperiodeAus;
                istSonderfall = true;
            }

            const basisSollTemp = neueSollTemp;

            if (!istSonderfall) {
                if (feuchteSensorOK && !states.anwesenheit) {
                    neueSollTemp +=
                        (CONFIG.basisRegelung.luftfeuchteOptimal - states.feuchteSensor) *
                        CONFIG.basisRegelung.feuchteKorrekturfaktor;
                }

                let maxSolarFaktor = 0;
                let maxWindFaktor = 1.0;

                for (const richtung of CONFIG.ausrichtungFenster) {
                    const solarState = await getStateAsync(CONFIG.wetterDatenPfade.basisPfadSolar + richtung);
                    if (solarState && typeof solarState.val === 'number' && solarState.val > maxSolarFaktor) {
                        maxSolarFaktor = solarState.val;
                    }

                    const windState = await getStateAsync(CONFIG.wetterDatenPfade.basisPfadWind + richtung);
                    if (windState && typeof windState.val === 'number' && windState.val > maxWindFaktor) {
                        maxWindFaktor = windState.val;
                    }
                }

                const gelernteSolarKorrektur = typeof states.solarKorrekturId === 'number' ? states.solarKorrekturId : 1.0;
                const gelernterWindKorrektur = typeof states.windKorrekturId === 'number' ? states.windKorrekturId : 1.0;

                if (maxSolarFaktor > 0) {
                    const solarOffset = -1.0 * maxSolarFaktor;
                    neueSollTemp += solarOffset * gelernteSolarKorrektur;
                    logWetter += `, Solar=${(solarOffset * gelernteSolarKorrektur).toFixed(2)} (F:${maxSolarFaktor.toFixed(2)}*K:${gelernteSolarKorrektur.toFixed(2)})`;
                }

                if (maxWindFaktor > 1.0) {
                    const windOffset = 1.0 * (maxWindFaktor - 1.0);
                    neueSollTemp += windOffset * gelernterWindKorrektur;
                    logWetter += `, Wind=+${(windOffset * gelernterWindKorrektur).toFixed(2)} (F:${maxWindFaktor.toFixed(2)}*K:${gelernterWindKorrektur.toFixed(2)})`;
                }

                let aufschlagWetter = 0;
                let aufschlagSchimmel = 0;
                let aufschlagBehaglichkeit = 0;
                let aufschlagHeizlast = 0;

                if (aussenSensorOK && states.aussenTempSensor < CONFIG.basisRegelung.aussenTempNeutral) {
                    aufschlagWetter =
                        (CONFIG.basisRegelung.aussenTempNeutral - states.aussenTempSensor) *
                        CONFIG.basisRegelung.heizkurvenfaktor;
                }

                const wandSensorOberflaecheOK =
                    typeof states.wandSensorOberflaeche === 'number' && states.wandSensorOberflaeche < 90.0;

                // BUGFIX V6.15: Math.log10() statt Math.log()
                if (CONFIG.module.schimmelSchutzAktiv && feuchteSensorOK && wandSensorOberflaecheOK) {
                    const MAGNUS_A = 7.5;
                    const MAGNUS_B = 237.3;
                    const sdd = (MAGNUS_A * basisSollTemp) / (MAGNUS_B + basisSollTemp) + Math.log10(states.feuchteSensor / 100);
                    const taupunkt = (MAGNUS_B * sdd) / (MAGNUS_A - sdd);
                    if (states.wandSensorOberflaeche < taupunkt + CONFIG.module.sicherheitsabstandTaupunkt) {
                        aufschlagSchimmel = CONFIG.module.offsetSchimmelSchutz;
                    }
                }

                if (CONFIG.module.behaglichkeitAktiv && wandSensorOberflaecheOK) {
                    if (basisSollTemp - states.wandSensorOberflaeche > CONFIG.module.maxTempDifferenzWand) {
                        aufschlagBehaglichkeit = CONFIG.module.offsetBehaglichkeit;
                    }
                }

                const wandSensorKernOK = typeof states.wandSensorKern === 'number' && states.wandSensorKern < 90.0;
                if (CONFIG.module.heizlastAktiv && wandSensorOberflaecheOK && wandSensorKernOK) {
                    const tempDifferenz = states.wandSensorKern - states.wandSensorOberflaeche;
                    if (tempDifferenz > 0) {
                        aufschlagHeizlast = tempDifferenz * CONFIG.module.heizlastKorrekturfaktor;
                    }
                }

                const finalerPhysikAufschlag = Math.max(
                    aufschlagWetter,
                    aufschlagSchimmel,
                    aufschlagBehaglichkeit,
                    aufschlagHeizlast,
                );

                if (finalerPhysikAufschlag > 0) {
                    neueSollTemp += finalerPhysikAufschlag;
                    logModuleAction += `, PhysikMax:+${finalerPhysikAufschlag.toFixed(2)} (Wetter(Kurve):${aufschlagWetter.toFixed(2)}|M1_Schimmel:${aufschlagSchimmel}|M2_Behag:${aufschlagBehaglichkeit}|M3_Last:${aufschlagHeizlast.toFixed(2)})`;
                }

                neueSollTemp += CONFIG.temperaturOffset;
            }

            if (!istSonderfall) {
                neueSollTemp = Math.max(CONFIG.minSollTemp, Math.min(CONFIG.maxSollTemp, neueSollTemp));
            }

            neueSollTemp = Math.round(neueSollTemp * 2) / 2;

            for (const thermostatId of CONFIG.devices.thermostate) {
                const aktuellEingestellteTemp = (await getStateAsync(thermostatId))?.val || 4.5;
                const sollwertGeaendert = Math.abs(neueSollTemp - aktuellEingestellteTemp) > CONFIG.hysterese;

                if (sollwertGeaendert) {
                    await setStateAsync(thermostatId, neueSollTemp);
                    const controlModeId = thermostatId.replace('SET_POINT_TEMPERATURE', 'CONTROL_MODE');
                    await setStateAsync(controlModeId, 1, true);
                }

                if (CONFIG.debugLogAktiv) {
                    let logMessage;
                    if (sollwertGeaendert) {
                        logMessage = `[${CONFIG.roomName}] Setze Soll von ${aktuellEingestellteTemp.toFixed(1)}°C auf ${neueSollTemp.toFixed(1)}°C (Basis=${basisSollTemp.toFixed(1)}°C)`;
                    } else {
                        logMessage = `[${CONFIG.roomName}] Keine Änderung (Ist=${aktuellEingestellteTemp.toFixed(1)}°C ~ Ziel=${neueSollTemp.toFixed(1)}°C (Basis=${basisSollTemp.toFixed(1)}°C), Hyst=${CONFIG.hysterese}°C)`;
                    }

                    const details = [
                        `HeizP=${!!states.heizPeriode}`,
                        `Anw=${!!states.anwesenheit}`,
                        `Win=${fensterIstOffen}`,
                    ];
                    if (CONFIG.tuerSensorNutzen) {
                        details.push(`TuerZu=${isDoorPhysicallyClosed}`);
                    }
                    details.push(`NachtSch=${!!states.nachtschaltung}`);

                    if (istSonderfall) {
                        details.push(`SONDERFALL`);
                    }

                    details.push(`Offset=${CONFIG.temperaturOffset}`);
                    details.push(`Mod1=${CONFIG.module.schimmelSchutzAktiv}`);
                    details.push(`Mod2=${CONFIG.module.behaglichkeitAktiv}`);
                    details.push(`Mod3=${CONFIG.module.heizlastAktiv}`);

                    const logDetails = `(${details.join(', ')})`;
                    const logActions = `${logWetter}${logModuleAction}`;

                    log(`${logMessage} ${logDetails}${logActions}`);
                }
            }
        } catch (e) {
            log(`[${CONFIG.roomName}] FEHLER in Hauptfunktion: ${e.message}`, 'error');
        }
    }

    // =====================================================================================
    // START: PRIORISIERTER DEBOUNCE-MANAGER ZUM SCHUTZ DES DUTY CYCLE
    // =====================================================================================
    let debounceTimerHighPriority = null;
    let debounceTimerLowPriority = null;

    function triggerCalculation(isHighPriority) {
        if (!CONFIG.debounceConfig.aktiv) {
            main();
            return;
        }

        const delay = isHighPriority ? CONFIG.debounceConfig.delayHighPriority : CONFIG.debounceConfig.delayLowPriority;
        const priorityText = isHighPriority ? 'HOCH' : 'NIEDRIG';

        if (isHighPriority) {
            if (debounceTimerLowPriority) clearTimeout(debounceTimerLowPriority);
            if (debounceTimerHighPriority) clearTimeout(debounceTimerHighPriority);

            debounceTimerHighPriority = setTimeout(async () => {
                if (CONFIG.debugLogAktiv)
                    log(`[${CONFIG.roomName}] Debounce (${priorityText}): Zeit abgelaufen, führe Hauptfunktion aus...`, 'info');
                await main();
                debounceTimerHighPriority = null;
            }, delay);
        } else {
            if (debounceTimerHighPriority) {
                if (CONFIG.debugLogAktiv)
                    log(`[${CONFIG.roomName}] Debounce (${priorityText}): Trigger ignoriert, da Hoch-Prioritäts-Timer aktiv ist.`, 'info');
                return;
            }
            if (debounceTimerLowPriority) clearTimeout(debounceTimerLowPriority);

            debounceTimerLowPriority = setTimeout(async () => {
                if (CONFIG.debugLogAktiv)
                    log(`[${CONFIG.roomName}] Debounce (${priorityText}): Zeit abgelaufen, führe Hauptfunktion aus...`, 'info');
                await main();
                debounceTimerLowPriority = null;
            }, delay);
        }

        if (CONFIG.debugLogAktiv)
            log(`[${CONFIG.roomName}] Debounce (${priorityText}): Trigger erhalten, starte ${delay} ms Timer.`, 'info');
    }
    // =====================================================================================
    // ENDE: DEBOUNCE-MANAGER
    // =====================================================================================

    // -------------------------------------------------------------------------------------
    // 3. TRIGGER-KONFIGURATION (mit priorisiertem Debounce-Schutz)
    // -------------------------------------------------------------------------------------

    const highPriorityTriggerIds = [CONFIG.ids.anwesenheit, ...CONFIG.devices.fensterKontakte];
    if (CONFIG.tuerSensorNutzen && CONFIG.devices.tuerSensor) {
        highPriorityTriggerIds.push(CONFIG.devices.tuerSensor);
    }
    on(highPriorityTriggerIds, () => triggerCalculation(true));

    const lowPriorityTriggerIds = [
        CONFIG.ids.heizPeriode,
        CONFIG.ids.nachtschaltung,
        CONFIG.lernwerte.solarKorrekturId,
        CONFIG.lernwerte.windKorrekturId,
    ];
    for (const richtung of CONFIG.ausrichtungFenster) {
        lowPriorityTriggerIds.push(CONFIG.wetterDatenPfade.basisPfadSolar + richtung);
        lowPriorityTriggerIds.push(CONFIG.wetterDatenPfade.basisPfadWind + richtung);
    }
    const raumTempIds = CONFIG.devices.thermostate.map(id => id.replace('SET_POINT_TEMPERATURE', 'ACTUAL_TEMPERATURE'));
    lowPriorityTriggerIds.push(...raumTempIds);

    function handleLowPriorityTrigger(obj) {
        if (obj && obj.state && obj.oldState && obj.state.val === obj.oldState.val) return;

        const isTempTrigger = raumTempIds.includes(obj.id);
        if (isTempTrigger) {
            if (
                obj.state &&
                obj.oldState &&
                Math.abs(obj.state.val - obj.oldState.val) >= CONFIG.raumTempTriggerThreshold
            ) {
                triggerCalculation(false);
            }
        } else {
            triggerCalculation(false);
        }
    }

    on(lowPriorityTriggerIds, handleLowPriorityTrigger);

    schedule('2,17,32,47 * * * *', () => triggerCalculation(false));
    setTimeout(() => triggerCalculation(true), 1500);
})(); // Ende der Kapselung
