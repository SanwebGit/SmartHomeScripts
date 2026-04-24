/**
 * @fileoverview Wetterdaten-Analyse-Skript für proaktive Heizungssteuerung
 * @version 5.2 (Micro-Optimized)
 * @author Sanweb
 * @license MIT
 *
 * -------------------------------------------------------------------------------------
 * ZWECK DES SKRIPTS:
 * -------------------------------------------------------------------------------------
 * Zentrale Intelligenz-Schicht für die Wetteranalyse. Ermittelt proaktiv den Einfluss 
 * von Sonne und Wind auf das Gebäude und berechnet richtungsspezifische Faktoren.
 *
 * NEU IN V5.2 (Micro-Optimierungen):
 * - Dämmerungserkennung dynamisch über Sonnenhöhe (< 15°) statt fester Uhrzeiten
 * - Asynchrone Batch-Updates (Promise.all) für minimierte I/O-Latenz
 * - Start-Validierung der Konfiguration (validateConfig)
 * * NEU IN V5.4 (System-Integration):
 * - Automatisches Laden der Längen- und Breitengrade aus der ioBroker Systemkonfiguration
 */

(function() { // Start der Kapselung
    "use strict";

    // -------------------------------------------------------------------------------------
    // 1. ZENTRALE KONFIGURATION
    // -------------------------------------------------------------------------------------
    const CONFIG = {
        // --- A. GRUNDEINSTELLUNGEN ---
        debugLogAktiv: true,
        autoCreateStates: true,

        // --- B. STEUERUNG ---
        steuerung: {
            updateIntervall: '*/15 * * * *', // Cron-Job Intervall
            startVerzoegerungMs: 5000,       // Verzögerung beim ersten Start
        },

        // --- C. STANDORT-KONFIGURATION ---
        // Wenn null, wird automatisch der Standort aus den ioBroker-Haupteinstellungen geladen.
        standort: {
            breitengrad: null, // Optionaler Fallback, z.B. 52.042402
            laengengrad: null, // Optionaler Fallback, z.B. 8.488758
        },

        // --- D. SCHWELLWERTE & DYNAMIK ---
        schwellwerte: {
            // Solar
            minSolarstrahlung: 50,        // Mindeststrahlung in W/m² für Solaranalyse
            maxSolarstrahlung: 1000,      // Maximalwert in W/m² für Normierung (Bewölkungsfaktor)
            grenzeSonnig: 600,            // Ab dieser Strahlung gilt es als "Sonnig"
            grenzeTeilsBewoelkt: 200,     // Ab dieser Strahlung gilt es als "Teils bewölkt"
            solarGlaettungsfaktor: 0.4,   // 0 = sehr träge, 1 = sofortige Übernahme
            hystereseSolar: 0.05,         // Mindeständerung des Faktors vor neuem Schreiben
            
            // Wind
            minWindgeschwindigkeit: 5,    // Wind ab dieser Geschw. in km/h berücksichtigen
            maxWindgeschwindigkeit: 65,   // Maximalwert in km/h für Normierung des Windfaktors
            windGlaettungsfaktor: 0.3,    // 0 = sehr träge, 1 = sofortige Übernahme
            hystereseWind: 0.05,          // Mindeständerung des Faktors vor neuem Schreiben
        },

        // --- E. GEBÄUDEEIGENSCHAFTEN ---
        gebaeude: {
            waermekapazitaet: 0.8,        // Trägheit des Gebäudes (0-1)
            daemmstandard: 0.5,           // Dämmung (0=schlecht, 1=sehr gut)
            windAbschwaechung: 0.25,      // Auskühlung an nicht direkt vom Wind getroffenen Wänden
        },

        // --- F. KONFIGURATION DER FENSTER UND SONNENEINSTRAHLUNG ---
        fensterAusrichtung: {
            'Sued':  { minHoehe: 12, azimutVon: 130, azimutBis: 230 },
            'West':  { minHoehe: 10, azimutVon: 230, azimutBis: 280 },
            'Ost':   { minHoehe: 10, azimutVon: 80,  azimutBis: 130 },
            'Nord':  { minHoehe: 15, azimutVon: 330, azimutBis: 30 } 
        },

        // --- G. INPUT-IDs: WETTERSTATION ---
        weatherIds: {
            solarradiation: '0_userdata.0.Wetter.solarradiation',
            windspeed: '0_userdata.0.Wetter.windspeed',
            winddir: '0_userdata.0.Wetter.winddir',
        },

        // --- H. OUTPUT-IDs: ZIEL-DATENPUNKTE ---
        outputIds: {
            aktuellerZustand: '0_userdata.0.Heizung.Analyse.Wetter_AktuellerZustand',
            basisPfadSolar: '0_userdata.0.Heizung.Analyse.Wetter_Heizunterstuetzung_Solar',
            basisPfadWind: '0_userdata.0.Heizung.Analyse.Wetter_Waermeverlust_Wind',
        },
    };

    // -------------------------------------------------------------------------------------
    // 2. HILFSKLASSE: HYSTERESE MIT PERSISTENZ & I/O-OPTIMIERUNG
    // -------------------------------------------------------------------------------------
    class WertMitHysterese {
        constructor(minAenderung = 0.05, stateId = null) {
            this.minAenderung = minAenderung;
            this.stateId = stateId;
            this.letzterWert = null;
        }
        
        async init() {
            if (this.stateId && (await existsStateAsync(this.stateId))) {
                const state = await getStateAsync(this.stateId);
                if (state && state.val !== null && !isNaN(state.val)) {
                    this.letzterWert = parseFloat(state.val);
                }
            }
        }

        async aktualisierenUndSpeichern(neuerWert) {
            let geaendert = false;
            
            // Prüfen, ob eine Änderung außerhalb der Hysterese vorliegt
            if (this.letzterWert === null || Math.abs(neuerWert - this.letzterWert) > this.minAenderung) {
                this.letzterWert = neuerWert;
                geaendert = true;
                
                // Nur bei echter Änderung den State beschreiben (I/O Optimierung)
                if (this.stateId) {
                    await setStateAsync(this.stateId, parseFloat(neuerWert.toFixed(3)), true);
                }
            }
            
            return { 
                wert: parseFloat(this.letzterWert.toFixed(3)), 
                geaendert: geaendert 
            };
        }
    }

    // -------------------------------------------------------------------------------------
    // 3. HAUPTKLASSE: WETTER ANALYSE
    // -------------------------------------------------------------------------------------
    class WetterAnalyse {
        constructor(config) {
            this.config = config;
            this.suncalc = null;
            this.suncalcAvailable = false;
            
            // Caching
            this.cachedSunPosition = null;
            this.lastSunCalcTime = 0;
            this.richtungsCache = new Map();
            
            // Einheitliche Datenstruktur für Glättungsspeicher
            this.richtungen = ['Nord', 'Ost', 'Sued', 'West'];
            this.faktoren = {
                wind: { Nord: 1.0, Ost: 1.0, Sued: 1.0, West: 1.0 },
                solar: { Nord: 0.0, Ost: 0.0, Sued: 0.0, West: 0.0 }
            };

            // Memory-Optimierung: Wiederverwendbare Objekte für die Analyse
            this.tempObjekte = {
                windRoh: { Nord: 1.0, Ost: 1.0, Sued: 1.0, West: 1.0 },
                solarRoh: { Nord: 0.0, Ost: 0.0, Sued: 0.0, West: 0.0 }
            };
            
            // Hysterese-Instanzen
            this.hystereseSolar = {};
            this.hystereseWind = {};
        }

        // --- Logging ---
        /**
         * @param {string} message 
         * @param {'info' | 'warn' | 'error' | 'debug' | 'silly'} level 
         */
        debugLog(message, level = 'info') {
            if (this.config.debugLogAktiv) {
                log(`[Wetter-Analyse] ${message}`, level);
            }
        }

        // --- Initialisierung & Validierung ---
        async loadSystemLocation() {
            // Nur laden, wenn sie nicht manuell in der CONFIG überschrieben wurden
            if (!this.config.standort.breitengrad || !this.config.standort.laengengrad) {
                try {
                    const systemConfig = await getObjectAsync('system.config');
                    if (systemConfig && systemConfig.common && systemConfig.common.latitude && systemConfig.common.longitude) {
                        this.config.standort.breitengrad = Number(systemConfig.common.latitude);
                        this.config.standort.laengengrad = Number(systemConfig.common.longitude);
                        log(`[Wetter-Analyse] Standort automatisch aus ioBroker-Systemkonfiguration geladen: ${this.config.standort.breitengrad}, ${this.config.standort.laengengrad}`, 'info');
                    } else {
                        throw new Error('Keine Koordinaten in system.config gefunden.');
                    }
                } catch (e) {
                    log(`[Wetter-Analyse] Warnung: Konnte Standort nicht aus ioBroker laden (${e.message}). Bitte in CONFIG eintragen!`, 'warn');
                }
            } else {
                log('[Wetter-Analyse] Verwende manuell konfigurierte Standortdaten aus dem Skript.', 'info');
            }
        }

        validateConfig() {
            const requiredStandort = ['breitengrad', 'laengengrad'];
            for (const field of requiredStandort) {
                if (this.config.standort[field] === undefined || this.config.standort[field] === null) {
                    throw new Error(`Standort-Konfiguration fehlt: ${field}`);
                }
            }
            
            if (this.config.schwellwerte.minSolarstrahlung >= this.config.schwellwerte.maxSolarstrahlung) {
                log('[Wetter-Analyse] Warnung: minSolarstrahlung sollte kleiner als maxSolarstrahlung sein', 'warn');
            }
        }

        async init() {
            this.debugLog('Initialisiere Wetter-Analyse V5.4...');
            
            await this.loadSystemLocation();
            this.validateConfig();
            this.initSuncalc();
            await this.createStates();
            await this.initHysterese();

            // Initiale Glättungswerte aus States laden
            for (const r of this.richtungen) {
                if (this.hystereseWind[r].letzterWert !== null) this.faktoren.wind[r] = this.hystereseWind[r].letzterWert;
                if (this.hystereseSolar[r].letzterWert !== null) this.faktoren.solar[r] = this.hystereseSolar[r].letzterWert;
            }

            // Schedule einrichten
            schedule(this.config.steuerung.updateIntervall, () => this.run());
            
            // Erster Start
            setTimeout(() => this.run(), this.config.steuerung.startVerzoegerungMs);
        }

        initSuncalc() {
            try {
                // @ts-ignore
                this.suncalc = require('suncalc');
                this.suncalcAvailable = true;
                this.debugLog('suncalc-Bibliothek erfolgreich geladen.');
            } catch (e) {
                log('[Wetter-Analyse] FEHLER: Die "suncalc"-Bibliothek wurde nicht im JavaScript-Adapter gefunden. Solar-Analyse wird übersprungen.', 'error');
            }
        }

        async createStates() {
            if (!this.config.autoCreateStates) return;

            const idZustand = this.config.outputIds.aktuellerZustand;
            if (!(await existsStateAsync(idZustand))) {
                await createStateAsync(idZustand, 'unbekannt', { name: 'Wetter: Aktueller Zustand', type: 'string', role: 'text', def: 'unbekannt', read: true, write: false });
            }

            for (const richtung of this.richtungen) {
                const solarId = `${this.config.outputIds.basisPfadSolar}_${richtung}`;
                if (!(await existsStateAsync(solarId))) {
                    await createStateAsync(solarId, 0, { name: `Wetter: Heizunterstützung Solar ${richtung}`, type: 'number', role: 'value', unit: 'Faktor', def: 0, read: true, write: false });
                }
                const windId = `${this.config.outputIds.basisPfadWind}_${richtung}`;
                if (!(await existsStateAsync(windId))) {
                    await createStateAsync(windId, 1, { name: `Wetter: Wärmeverlust Wind ${richtung}`, type: 'number', role: 'value', unit: 'Faktor', def: 1, read: true, write: false });
                }
            }
        }

        async initHysterese() {
            for (const r of this.richtungen) {
                this.hystereseSolar[r] = new WertMitHysterese(this.config.schwellwerte.hystereseSolar, `${this.config.outputIds.basisPfadSolar}_${r}`);
                this.hystereseWind[r] = new WertMitHysterese(this.config.schwellwerte.hystereseWind, `${this.config.outputIds.basisPfadWind}_${r}`);
                
                await this.hystereseSolar[r].init();
                await this.hystereseWind[r].init();
            }
        }

        // --- Datenbeschaffung ---
        async getCurrentData() {
            const data = { solarradiation: null, windspeed: null, winddir: null };
            
            for (const key in this.config.weatherIds) {
                try {
                    const state = await getStateAsync(this.config.weatherIds[key]);
                    if (state && state.val !== null && state.val !== undefined && !isNaN(parseFloat(state.val))) {
                        data[key] = parseFloat(state.val);
                    } else {
                        log(`[Wetter-Analyse] Warnung: Ungültiger oder fehlender Wert für ${key}`, 'warn');
                    }
                } catch (error) {
                    log(`[Wetter-Analyse] Fehler beim Lesen von ${key}: ${error.message}`, 'error');
                }
            }
            return data;
        }

        // --- Logik & Berechnungen ---
        gradToHimmelsrichtung(deg) {
            if (deg === null || typeof deg === 'undefined') return 'Nord';
            
            // Caching-Logik (auf 5° gerundet zur Erhöhung der Trefferquote)
            const rounded = Math.round(deg / 5) * 5;
            if (this.richtungsCache.has(rounded)) return this.richtungsCache.get(rounded);

            let result = 'Nord';
            if (deg > 315 || deg <= 45) result = 'Nord';
            else if (deg > 45 && deg <= 135) result = 'Ost';
            else if (deg > 135 && deg <= 225) result = 'Sued';
            else if (deg > 225 && deg <= 315) result = 'West';
            
            this.richtungsCache.set(rounded, result);
            return result;
        }

        getWetterZustand(data) {
            let zustand = '';
            
            if (data.solarradiation > this.config.schwellwerte.grenzeSonnig) zustand = 'Sonnig';
            else if (data.solarradiation > this.config.schwellwerte.grenzeTeilsBewoelkt) zustand = 'Teils bewölkt';
            else zustand = 'Bedeckt';
            
            const minWind = this.config.schwellwerte.minWindgeschwindigkeit;
            if (data.windspeed > 40) zustand += ' & stürmisch';
            else if (data.windspeed > 20) zustand += ' & windig';
            else if (data.windspeed >= minWind) zustand += ' & mäßiger Wind';
            else zustand += ' & windstill'; 
            
            return zustand;
        }

        getSunPosition(now) {
            const nowMs = now.getTime();
            
            // Dynamisches Caching: Asymmetrische Dämmerungsgrenzen
            let isDaemmerung = true; // Fallback für ersten Durchlauf
            if (this.cachedSunPosition) {
                const altDeg = this.cachedSunPosition.altitude * 180 / Math.PI;
                const isMorgen = now.getHours() < 12;
                const daemmerungsGrenze = isMorgen ? 12 : 18;
                isDaemmerung = Math.abs(altDeg) < daemmerungsGrenze;
            }
            
            const cacheDauer = isDaemmerung ? 120000 : 300000;
            
            if (!this.cachedSunPosition || (nowMs - this.lastSunCalcTime) > cacheDauer) { 
                this.cachedSunPosition = this.suncalc.getPosition(now, this.config.standort.breitengrad, this.config.standort.laengengrad);
                this.lastSunCalcTime = nowMs;
            }
            return this.cachedSunPosition;
        }

        glaetteWindFaktoren(neueFaktoren) {
            const gFaktor = this.config.schwellwerte.windGlaettungsfaktor;
            for (const r of this.richtungen) {
                this.faktoren.wind[r] = gFaktor * neueFaktoren[r] + (1 - gFaktor) * this.faktoren.wind[r];
            }
            return this.faktoren.wind;
        }

        glaetteSolarFaktoren(neueFaktoren) {
            const gFaktor = this.config.schwellwerte.solarGlaettungsfaktor;
            for (const r of this.richtungen) {
                this.faktoren.solar[r] = gFaktor * neueFaktoren[r] + (1 - gFaktor) * this.faktoren.solar[r];
            }
            return this.faktoren.solar;
        }

        resetTempObjekte() {
            for (const r of this.richtungen) {
                this.tempObjekte.windRoh[r] = 1.0;
                this.tempObjekte.solarRoh[r] = 0.0;
            }
        }

        analyseCurrentData(data) {
            this.resetTempObjekte();

            // --- Windanalyse ---
            let waermeverlustWindRoh = this.tempObjekte.windRoh;
            
            if (data.windspeed >= this.config.schwellwerte.minWindgeschwindigkeit) {
                const windRichtung = data.winddir !== null ? this.gradToHimmelsrichtung(data.winddir) : 'Nord';
                
                const maxWindFaktor = 1.0 + (0.8 * (1 - this.config.gebaeude.daemmstandard));
                const zusaetzlicherFaktor = Math.min(maxWindFaktor - 1, (data.windspeed || 0) / this.config.schwellwerte.maxWindgeschwindigkeit);
                
                waermeverlustWindRoh[windRichtung] = 1 + zusaetzlicherFaktor;

                for (const r of this.richtungen) {
                    if (r !== windRichtung) {
                        waermeverlustWindRoh[r] = 1 + (zusaetzlicherFaktor * this.config.gebaeude.windAbschwaechung);
                    }
                }
            }
            const waermeverlustWind = this.glaetteWindFaktoren(waermeverlustWindRoh);
            
            // --- Solaranalyse ---
            let heizunterstuetzungSolarRoh = this.tempObjekte.solarRoh;
            
            if (this.suncalcAvailable && data.solarradiation >= this.config.schwellwerte.minSolarstrahlung) {
                const now = new Date();
                const sunPos = this.getSunPosition(now);
                const sunAltitudeDeg = sunPos.altitude * 180 / Math.PI;
                
                if (sunAltitudeDeg > 0) {
                    let sunAzimutDeg = (sunPos.azimuth * 180 / Math.PI) + 180;
                    if (sunAzimutDeg >= 360) sunAzimutDeg -= 360;

                    for (const richtung in this.config.fensterAusrichtung) {
                        const fenster = this.config.fensterAusrichtung[richtung];
                        
                        let isAzimutInRange;
                        if (fenster.azimutVon > fenster.azimutBis) {
                            isAzimutInRange = (sunAzimutDeg >= fenster.azimutVon || sunAzimutDeg <= fenster.azimutBis);
                        } else {
                            isAzimutInRange = (sunAzimutDeg >= fenster.azimutVon && sunAzimutDeg <= fenster.azimutBis);
                        }

                        if (sunAltitudeDeg >= fenster.minHoehe && isAzimutInRange) {
                            const intensitaetsFaktor = Math.max(0, Math.sin(sunPos.altitude)); 
                            const bewoelkungsFaktor = Math.min(1, Math.max(0, (data.solarradiation || 0) / this.config.schwellwerte.maxSolarstrahlung));
                            
                            heizunterstuetzungSolarRoh[richtung] = intensitaetsFaktor * bewoelkungsFaktor;
                        }
                    }
                }
            }
            const heizunterstuetzungSolar = this.glaetteSolarFaktoren(heizunterstuetzungSolarRoh);

            return {
                aktuellerZustand: this.getWetterZustand(data),
                heizunterstuetzungSolar: heizunterstuetzungSolar,
                waermeverlustWind: waermeverlustWind,
            };
        }

        // --- Hauptablauf ---
        async run() {
            try {
                this.debugLog(`Starte Analyse-Zyklus...`);

                const currentData = await this.getCurrentData();
                
                if (currentData.windspeed === null && currentData.solarradiation === null) {
                    log('[Wetter-Analyse] Keine gültigen Wetterdaten verfügbar. Zyklus übersprungen.', 'warn');
                    return;
                }

                const result = this.analyseCurrentData(currentData);

                // Zustand schreiben (einzeln, da anderer Datentyp)
                await setStateAsync(this.config.outputIds.aktuellerZustand, result.aktuellerZustand, true);
                
                // --- Parallele Batch-Updates (I/O Optimierung) ---
                const solarPromises = this.richtungen.map(r => 
                    this.hystereseSolar[r].aktualisierenUndSpeichern(result.heizunterstuetzungSolar[r])
                );
                const windPromises = this.richtungen.map(r => 
                    this.hystereseWind[r].aktualisierenUndSpeichern(result.waermeverlustWind[r])
                );

                const solarUpdates = await Promise.all(solarPromises);
                const windUpdates = await Promise.all(windPromises);

                // --- Logging ---
                const solarLogParts = [];
                const windLogParts = [];

                for (let i = 0; i < this.richtungen.length; i++) {
                    const r = this.richtungen[i];
                    if (solarUpdates[i].wert > 0.01) {
                        solarLogParts.push(`Solar(${r}):${solarUpdates[i].wert}${solarUpdates[i].geaendert ? '*' : ''}`);
                    }
                    if (windUpdates[i].wert > 1.01) {
                        windLogParts.push(`Wind(${r}):${windUpdates[i].wert}${windUpdates[i].geaendert ? '*' : ''}`);
                    }
                }

                let logMessage = `Abgeschlossen. Zustand: "${result.aktuellerZustand}".`;
                if (solarLogParts.length > 0) logMessage += ` ${solarLogParts.join(' ')}`;
                if (windLogParts.length > 0) logMessage += ` ${windLogParts.join(' ')}`;
                
                this.debugLog(logMessage);
                
            } catch (error) {
                log(`[Wetter-Analyse] KRITISCHER FEHLER: ${error.message}`, 'error');
                if (error.stack) log(error.stack, 'error');
                await setStateAsync(this.config.outputIds.aktuellerZustand, 'Fehler bei der Analyse', true);
            }
        }
    }

    // -------------------------------------------------------------------------------------
    // 4. SKRIPT-START
    // -------------------------------------------------------------------------------------
    const wetterAnalyse = new WetterAnalyse(CONFIG);
    wetterAnalyse.init();

})(); // Ende der Kapselung