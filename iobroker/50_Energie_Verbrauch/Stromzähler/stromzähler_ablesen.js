/**
 * =============================================================================
 * @file        stromzaehler.js
 * @description Skript zur Erfassung, Berechnung und Historisierung von 
 * Stromverbrauchsdaten (Tages-, Wochen-, Monats- und Jahreswerte).
 * Liest Daten eines Zigbee-Sensors, erkennt Sensor-Resets und 
 * gleicht diese über einen dynamischen Offset automatisch ab.
 * @version     1.6.0 (Enterprise Architecture, Caching, Batching & Metrics)
 * @date        2026-03-04
 * @author      Sanweb
 * =============================================================================
 */

/**
 * TypeScript Configuration Interface (optional, für IDEs)
 * @typedef {Object} Config
 * @property {string} basePath
 * @property {{energy: string, power: string}} sources
 * @property {number} startOffsetKwh
 * @property {number} maxZulaessigerSprungKwh
 * @property {number} minResetSchwelleKwh
 * @property {boolean} debug
 * @property {boolean} metrikSpeichern
 * @property {number} metrikUpdateIntervall
 */

/**
 * =========================================================================
 * KONFIGURATION
 * =========================================================================
 */

(function() {
    "use strict";

const CONFIG = {
    // Basis-Pfad unterhalb von 0_userdata.0, wo die neuen Punkte erstellt werden
    basePath: '0_userdata.0.Haushalt.Strom.',
    
    // Quell-Datenpunkte (z.B. Zigbee-Geräte)
    sources: {
        energy: 'zigbee2mqtt.0.0x0015bc001b10168f.energy',      // Kumulierter Verbrauch in kWh
        power:  'zigbee2mqtt.0.0x0015bc001b10168f.load_power'   // Aktuelle Leistung in W
    },
    
    // Start-Zählerstand deines physischen Zählers im Schaltschrank (in kWh)
    startOffsetKwh: 9863,

    // Schwellwerte für die Validierung
    maxZulaessigerSprungKwh: 5.0, // Schützt vor utopischen Messfehlern
    minResetSchwelleKwh: 0.01,    // Ignoriert minimale Fluktuationen beim Reset-Check

    // Metriken & Speicherschonung (I/O Reduzierung)
    metrikSpeichern: true,
    metrikUpdateIntervall: 10,    // Speichert Metriken nur bei jedem 10. Update in die DB (0 = nur bei Timer/Fehler)

    // Erweitertes Debug-Logging für die Fehlersuche
    debug: false 
};

/**
 * Definition der benötigten Datenpunkte
 */
const DATENPUNKTE = [
    { id: "Strom_Aktualisierung", name: "Strom Aktualisierung", type: "string", role: "text", unit: "", def: "YYYY-MM-DD 00:00:00" },
    { id: "Strom_Referenz_Ablesung", name: "Strom Referenz Ablesung", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Referenz_heute", name: "Strom Referenz heute", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Referenz_Kalenderjahr", name: "Strom Referenz Kalenderjahr", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Referenz_Monat", name: "Strom Referenz Monat", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Referenz_Woche", name: "Strom Referenz Woche", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_aktuell", name: "Strom Verbrauch aktuell", type: "number", role: "value.power", unit: "W" },
    { id: "Strom_Verbrauch_gestern", name: "Strom Verbrauch gestern", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_heute", name: "Strom Verbrauch heute", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_Kalenderjahr", name: "Strom Verbrauch Kalenderjahr", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_letzte_Ablesung", name: "Strom Verbrauch letzte Ablesung", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_letzter_Monat", name: "Strom Verbrauch letzter Monat", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_letztes_Kalenderjahr", name: "Strom Verbrauch letztes Kalenderjahr", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_letzte_Woche", name: "Strom Verbrauch letzte Woche", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_Monat", name: "Strom Verbrauch Monat", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_Woche", name: "Strom Verbrauch Woche", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Zaehlerstand", name: "Strom Zaehlerstand", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Geraete_Offset", name: "Strom Geräte Offset", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Letzter_Rohwert", name: "Strom Letzter Rohwert", type: "number", role: "value.energy", unit: "kWh" },
    { id: "Strom_Ablesung_Trigger", name: "Strom Ablesung auslösen", type: "boolean", role: "button", unit: "", def: false },
    { id: "Strom_Datum_letzte_Ablesung", name: "Strom Datum letzte Ablesung", type: "string", role: "text", unit: "", def: "" },
    { id: "Strom_Letztes_Speicher_Datum", name: "Strom Letztes Speicher Datum", type: "string", role: "text", unit: "", def: "" },
    { id: "Strom_Datum_Batterietausch", name: "Strom Datum Batterietausch", type: "string", role: "text", unit: "", def: "" },
    
    // Exportierte Health-Check & Monitoring Metriken
    { id: "Strom_Metriken_Updates_verarbeitet", name: "Metriken: Updates verarbeitet", type: "number", role: "value", unit: "", def: 0 },
    { id: "Strom_Metriken_Letztes_Update", name: "Metriken: Letztes Update", type: "string", role: "text", unit: "", def: "" },
    { id: "Strom_Metriken_Fehleranzahl", name: "Metriken: Fehleranzahl", type: "number", role: "value", unit: "", def: 0 },
    { id: "Strom_Metriken_Resets_erkannt", name: "Metriken: Resets erkannt", type: "number", role: "value", unit: "", def: 0 },
    { id: "Strom_Metriken_Letzter_Fehler", name: "Metriken: Letzter Fehler", type: "string", role: "text", unit: "", def: "" }
];

/**
 * =========================================================================
 * UTILS (Ausgelagerte Hilfsfunktionen)
 * =========================================================================
 */
const Utils = {
    rundenKwh: (wert) => Number(Math.round(parseFloat(wert + 'e' + 3)) + 'e-' + 3),
    
    formatiereDatum: (date) => {
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const min = String(date.getMinutes()).padStart(2, '0');
        const ss = String(date.getSeconds()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
    },

    heuteIso: () => new Date().toISOString().split('T')[0],

    getIsoWeek: (dateObj) => {
        const d = new Date(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()));
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    }
};

/**
 * =========================================================================
 * HAUPTKLASSE
 * =========================================================================
 */
class StromZaehlerManager {
    constructor(config, datenpunkte) {
        this.config = config;
        this.datenpunkte = datenpunkte;
        this.subscriptions = [];
        
        // Zustandsverwaltung Reset-Erkennung
        this.pendingResetVerdacht = false;
        this.pendingResetTimer = null;
        
        // Mutex Lock zur Vermeidung von Race Conditions
        this.processingLock = false;

        // Health-Check und Metriken
        this.metrics = {
            updatesProcessed: 0,
            lastUpdateTime: "",
            errors: 0,
            resetsDetected: 0
        };

        // 1. Cache für häufige State-Zugriffe
        this.stateCache = new Map();
        this.cacheTTL = 5000; // 5 Sekunden

        // 2. Update-Queue für Burst-Situationen
        this.updateQueue = [];
        this.batchTimeout = null;

        // 3. & 4. Erweiterte Plausibilitätsprüfung & Systematische Fehler
        this.letzterPlausiblerZaehlerstand = null;
        this.systematischeAbweichung = 0; // Hook für zukünftige Kalibrierungen
    }

    async start() {
        try {
            log("Starte Initialisierung des Stromzählers...", "info");
            
            this.validiereConfig();
            await this.erstelleDatenpunkte();
            await this.ladeMetriken();
            
            await this.pruefeVerpassteWechsel();
            this.registriereTrigger();
            this.registriereCronjobs();
            
            await this.fuehreInitialRunAus();

            log("Stromzähler-Skript erfolgreich gestartet.", "info");
        } catch (error) {
            log(`Kritischer Fehler beim Starten des Skripts: ${error.message}`, "error");
        }
    }

    validiereConfig() {
        if (!this.config.basePath.endsWith('.')) throw new Error("Konfigurationsfehler: basePath muss mit einem Punkt '.' enden.");
        if (this.config.startOffsetKwh < 0) throw new Error("Konfigurationsfehler: startOffsetKwh muss >= 0 sein.");
        if (this.config.maxZulaessigerSprungKwh <= 0) throw new Error("Konfigurationsfehler: maxZulaessigerSprungKwh muss > 0 sein.");
        if (!existsState(this.config.sources.energy)) throw new Error(`Quell-Datenpunkt für Energy (${this.config.sources.energy}) existiert nicht! Abbruch.`);
        if (!existsState(this.config.sources.power)) throw new Error(`Quell-Datenpunkt für Power (${this.config.sources.power}) existiert nicht! Abbruch.`);
    }

    async erstelleDatenpunkte() {
        for (const dp of this.datenpunkte) {
            const fullId = this.config.basePath + dp.id;
            let initialValue = dp.type === "number" ? 0 : (dp.def !== undefined ? dp.def : "");
            
            await createStateAsync(fullId, initialValue, false, {
                name: dp.name, desc: dp.name, type: dp.type, role: dp.role, unit: dp.unit, read: true, write: true
            });
        }
    }

    async ladeMetriken() {
        if (!this.config.metrikSpeichern) return;
        let uP = await getStateAsync(this.config.basePath + "Strom_Metriken_Updates_verarbeitet");
        if (uP) this.metrics.updatesProcessed = uP.val || 0;

        let err = await getStateAsync(this.config.basePath + "Strom_Metriken_Fehleranzahl");
        if (err) this.metrics.errors = err.val || 0;

        let rD = await getStateAsync(this.config.basePath + "Strom_Metriken_Resets_erkannt");
        if (rD) this.metrics.resetsDetected = rD.val || 0;

        let lU = await getStateAsync(this.config.basePath + "Strom_Metriken_Letztes_Update");
        if (lU) this.metrics.lastUpdateTime = lU.val || "";
    }

    async speichereMetriken(force = false) {
        if (!this.config.metrikSpeichern) return;
        
        // Nur speichern, wenn force true ist oder das definierte Intervall erreicht wurde
        if (force || (this.config.metrikUpdateIntervall > 0 && this.metrics.updatesProcessed % this.config.metrikUpdateIntervall === 0)) {
            await this.schreibeWertAsync("Strom_Metriken_Updates_verarbeitet", this.metrics.updatesProcessed);
            await this.schreibeWertAsync("Strom_Metriken_Letztes_Update", this.metrics.lastUpdateTime);
            await this.schreibeWertAsync("Strom_Metriken_Resets_erkannt", this.metrics.resetsDetected);
            await this.schreibeWertAsync("Strom_Metriken_Fehleranzahl", this.metrics.errors);
        }
    }

    /**
     * Zentralisierte Fehlerbehandlung
     */
    async handleError(method, error) {
        this.metrics.errors++;
        log(`Fehler in ${method}: ${error.message}`, "error");
        
        if (this.config.metrikSpeichern) {
            await this.schreibeWertAsync("Strom_Metriken_Fehleranzahl", this.metrics.errors);
            await this.schreibeWertAsync("Strom_Metriken_Letzter_Fehler", `${Utils.formatiereDatum(new Date())}: ${error.message}`);
        }
    }

    async fuehreInitialRunAus() {
        const referenzHeute = await getStateAsync(this.config.basePath + "Strom_Referenz_heute");
        if (!referenzHeute || referenzHeute.val === null || referenzHeute.val === 0) {
            log("Erster Start erkannt: Initialisiere Referenzwerte auf aktuellen Zählerstand...", "info");
            const initialEnergy = await getStateAsync(this.config.sources.energy);
            
            if (initialEnergy && typeof initialEnergy.val === "number") {
                let geraeteOffset = this.holeWert("Strom_Geraete_Offset") || 0;
                let calcZaehlerstand = Utils.rundenKwh(initialEnergy.val + this.config.startOffsetKwh + geraeteOffset);
                
                await this.schreibeWertAsync("Strom_Referenz_heute", calcZaehlerstand);
                await this.schreibeWertAsync("Strom_Referenz_Woche", calcZaehlerstand);
                await this.schreibeWertAsync("Strom_Referenz_Monat", calcZaehlerstand);
                await this.schreibeWertAsync("Strom_Referenz_Kalenderjahr", calcZaehlerstand);
                await this.schreibeWertAsync("Strom_Referenz_Ablesung", calcZaehlerstand);
            }
        }

        let initialEnergy = await getStateAsync(this.config.sources.energy);
        if (initialEnergy && typeof initialEnergy.val === "number") {
            await this.verarbeiteNeuenZaehlerstand(initialEnergy.val);
        }
        let initialPower = await getStateAsync(this.config.sources.power);
        if (initialPower && typeof initialPower.val === "number") {
            await this.schreibeWertAsync("Strom_Verbrauch_aktuell", initialPower.val, true);
        }
    }

    async pruefeVerpassteWechsel() {
        const letztesSpeicherDatum = this.holeWert("Strom_Letztes_Speicher_Datum");
        if (!letztesSpeicherDatum) return;

        const heute = new Date();
        const heuteString = Utils.heuteIso();
        
        if (letztesSpeicherDatum !== heuteString) {
            log(`Verpasster Tageswechsel erkannt (Letzte Speicherung: ${letztesSpeicherDatum}). Hole Daten nach...`, "warn");
            await this.schichteTagesWerteUm();

            const letztesDatumObj = new Date(letztesSpeicherDatum);
            
            let missedWeeks = Utils.getIsoWeek(heute) - Utils.getIsoWeek(letztesDatumObj);
            if (missedWeeks < 0) missedWeeks += 52; 
            
            if (missedWeeks > 0 || letztesDatumObj.getFullYear() !== heute.getFullYear()) {
                let iterations = missedWeeks > 0 ? missedWeeks : 1;
                for (let i = 0; i < iterations; i++) {
                    await this.schichteWochenWerteUm();
                }
            }
            if (letztesDatumObj.getMonth() !== heute.getMonth() || letztesDatumObj.getFullYear() !== heute.getFullYear()) {
                await this.schichteMonatsWerteUm();
            }
            if (letztesDatumObj.getFullYear() !== heute.getFullYear()) {
                await this.schichteJahresWerteUm();
            }
        }
    }

    registriereTrigger() {
        this.subscriptions.push(on({ id: this.config.sources.energy, change: "ne" }, async (obj) => {
            try {
                // Batch-Processing anstelle direkter Verarbeitung
                this.queueUpdate(obj.state.val);
            } catch (error) {
                await this.handleError("Trigger: energy", error);
            }
        }));

        this.subscriptions.push(on({ id: this.config.sources.power, change: "ne" }, async (obj) => {
            try {
                await this.schreibeWertAsync("Strom_Verbrauch_aktuell", obj.state.val, true);
            } catch (error) {
                await this.handleError("Trigger: power", error);
            }
        }));

        this.subscriptions.push(on({ id: this.config.basePath + "Strom_Ablesung_Trigger", change: "any", val: true }, async () => {
            try {
                await this.fuehreManuelleAblesungAus();
            } catch (error) {
                await this.handleError("Trigger: Manuelle Ablesung", error);
            }
        }));
    }

    registriereCronjobs() {
        schedule("59 59 23 * * *", async () => {
            try { await this.schichteTagesWerteUm(); } catch(e) { await this.handleError("Cron: Tageswechsel", e); }
        });
        
        schedule("59 59 23 * * 0", async () => {
            try { await this.schichteWochenWerteUm(); } catch(e) { await this.handleError("Cron: Wochenwechsel", e); }
        });
        
        schedule("59 59 23 28-31 * *", async () => {
            try {
                let morgen = new Date();
                morgen.setDate(morgen.getDate() + 1);
                if (morgen.getDate() === 1) await this.schichteMonatsWerteUm();
            } catch(e) { await this.handleError("Cron: Monatswechsel", e); }
        });
        
        schedule("59 59 23 31 12 *", async () => {
            try { await this.schichteJahresWerteUm(); } catch(e) { await this.handleError("Cron: Jahreswechsel", e); }
        });

        // Tägliche Zwangs-Speicherung der Metriken kurz vor dem Tageswechsel
        schedule("55 23 * * *", async () => {
            try { await this.speichereMetriken(true); } catch(e) { await this.handleError("Cron: Metriken Sync", e); }
        });
    }

    /**
     * Fügt einen Wert der Queue hinzu (Burst-Schutz).
     */
    queueUpdate(wert) {
        this.updateQueue.push(wert);
        if (!this.batchTimeout) {
            this.batchTimeout = setTimeout(() => this.processBatch(), 100);
        }
    }

    /**
     * Verarbeitet gepufferte Updates in einem Rutsch.
     */
    async processBatch() {
        this.batchTimeout = null;
        const updates = [...this.updateQueue];
        this.updateQueue = [];

        for (const wert of updates) {
            try {
                await this.verarbeiteNeuenZaehlerstand(wert);
            } catch (error) {
                await this.handleError("Batch-Verarbeitung", error);
            }
        }
    }

    /**
     * Holt States aus dem internen Memory-Cache (Reduziert DB-Abfragen).
     */
    async getStateCached(id) {
        const now = Date.now();
        if (this.stateCache.has(id) && (now - this.stateCache.get(id).timestamp < this.cacheTTL)) {
            return this.stateCache.get(id).value;
        }
        const stateObj = await getStateAsync(id);
        const value = (stateObj && stateObj.val !== null && stateObj.val !== undefined) ? stateObj.val : null;
        this.stateCache.set(id, { value, timestamp: now });
        return value;
    }

    /**
     * Holt einen Wert synchron ab (hauptsächlich intern als Fallback genutzt).
     */
    holeWert(idSuffix) {
        let state = getState(this.config.basePath + idSuffix);
        if (!state || state.val === null || state.val === undefined || state.val === "") return null;
        return state.val;
    }

    /**
     * Asynchrones, versionssicheres Schreiben in die Datenbank mit Cache-Check.
     */
    async schreibeWertAsync(idSuffix, wert, ack = true) {
        const fullId = this.config.basePath + idSuffix;
        const currentStateVal = await this.getStateCached(fullId);
        
        if (currentStateVal !== wert) {
            if (typeof setStateAsync === 'function') {
                await setStateAsync(fullId, wert, ack);
            } else {
                setState(fullId, wert, ack); // Fallback für ältere ioBroker Installationen
            }
            // Cache direkt nach dem Schreiben aktualisieren (Cache-Invalidation)
            this.stateCache.set(fullId, { value: wert, timestamp: Date.now() });
        }
    }

    /**
     * Hauptverarbeitungslogik für eingehende Energiewerte.
     */
    async verarbeiteNeuenZaehlerstand(neuerWertKwh) {
        if (this.processingLock) {
            if (this.config.debug) log("Update wird bereits verarbeitet, ignoriere parallelen Aufruf (Mutex)", "debug");
            return;
        }
        
        this.processingLock = true;
        const startTime = Date.now();
        
        try {
            if (typeof neuerWertKwh !== "number" || isNaN(neuerWertKwh)) return;

            // Nutzung des neuen Memory-Caches anstelle von getStatesAsync Bulk-Reads
            let letzterRohwert = await this.getStateCached(this.config.basePath + "Strom_Letzter_Rohwert") ?? 0;
            let geraeteOffset = await this.getStateCached(this.config.basePath + "Strom_Geraete_Offset") ?? 0;
            
            // 1. Reset- und Fehlererkennung
            const status = this.pruefeAufReset(neuerWertKwh, letzterRohwert, geraeteOffset);
            
            // Reset-Timer aufräumen, falls der Status sich geklärt hat
            if (status.aktion !== "PENDING" && this.pendingResetTimer) {
                clearTimeout(this.pendingResetTimer);
                this.pendingResetTimer = null;
            }

            if (status.aktion === "ABBRUCH" || status.aktion === "PENDING") return;

            if (status.neuerOffset !== null) {
                geraeteOffset = status.neuerOffset;
                await this.schreibeWertAsync("Strom_Geraete_Offset", geraeteOffset);
                await this.schreibeWertAsync("Strom_Datum_Batterietausch", Utils.formatiereDatum(new Date()));
                
                this.metrics.resetsDetected++;
                await this.speichereMetriken(true); // Bei Resets Metriken immer sofort sichern
            }

            await this.schreibeWertAsync("Strom_Letzter_Rohwert", neuerWertKwh);

            // 2. Gesamtzählerstand berechnen
            let aktuellerZaehlerstand = Utils.rundenKwh(neuerWertKwh + this.config.startOffsetKwh + geraeteOffset);
            
            // Plausibilitätsprüfung
            if (aktuellerZaehlerstand < 0) {
                log(`WARNUNG: Zählerstand negativ (${aktuellerZaehlerstand} kWh)! Offset oder Startwert prüfen.`, "warn");
                aktuellerZaehlerstand = 0; 
            }
            
            // Erweiterte Plausibilitätsprüfung
            if (this.letzterPlausiblerZaehlerstand !== null && aktuellerZaehlerstand < this.letzterPlausiblerZaehlerstand) {
                log(`WARNUNG: Zählerstand ist gesunken (${this.letzterPlausiblerZaehlerstand} -> ${aktuellerZaehlerstand} kWh).`, "warn");
            }
            this.letzterPlausiblerZaehlerstand = aktuellerZaehlerstand;

            // Automatische Korrektur bei systematischen Fehlern (Hook)
            if (this.systematischeAbweichung > 0.1) {
                log(`Systematische Abweichung erkannt: ${this.systematischeAbweichung} kWh. Automatische Kalibrierung empfohlen.`, "warn");
                // Hier kann zukünftig eine automatische Offset-Korrektur eingefügt werden
            }
            
            await this.schreibeWertAsync("Strom_Zaehlerstand", aktuellerZaehlerstand);
            await this.schreibeWertAsync("Strom_Aktualisierung", Utils.formatiereDatum(new Date()));

            // 3. Verbräuche aktualisieren
            await this.aktualisiereVerbrauchswerte(aktuellerZaehlerstand);

            // Metriken pflegen & ressourcenschonend speichern
            this.metrics.updatesProcessed++;
            this.metrics.lastUpdateTime = new Date().toISOString();
            await this.speichereMetriken();

        } finally {
            this.processingLock = false;
            
            // Performance-Monitoring
            const duration = Date.now() - startTime;
            if (duration > 100) {
                log(`WARN: Verarbeitung des Zählerstands dauerte ${duration}ms. Das Event-Loop wird stark belastet.`, "warn");
            }
        }
    }

    /**
     * @returns {{aktion: "OK" | "ABBRUCH" | "PENDING", neuerOffset: number | null}}
     */
    pruefeAufReset(neuerWertKwh, letzterRohwert, aktuellerOffset) {
        if (letzterRohwert === 0 && neuerWertKwh > 0) return { aktion: "OK", neuerOffset: null };

        let differenz = neuerWertKwh - letzterRohwert;

        if (this.config.debug) {
            log(`[DEBUG] Reset-Prüfung: pending=${this.pendingResetVerdacht}, neuerWert=${neuerWertKwh}, letzter=${letzterRohwert}, diff=${Utils.rundenKwh(differenz)}`, "info");
        }

        if (differenz > this.config.maxZulaessigerSprungKwh) {
            if (this.config.debug) log(`[DEBUG] Aktion: ABBRUCH (Unrealistischer Sprung nach oben)`, "info");
            log(`Unrealistischer Sprung (+${Utils.rundenKwh(differenz)} kWh). Ignoriere Wert!`, "warn");
            return { aktion: "ABBRUCH", neuerOffset: null };
        }

        if (neuerWertKwh < letzterRohwert) {
            if (Math.abs(differenz) < this.config.minResetSchwelleKwh) {
                if (this.config.debug) log(`[DEBUG] Aktion: ABBRUCH (Mikro-Jitter)`, "info");
                return { aktion: "ABBRUCH", neuerOffset: null };
            }

            if (this.pendingResetVerdacht) {
                if (neuerWertKwh < this.config.maxZulaessigerSprungKwh) {
                    log(`Sensor-Reset bestätigt! Setze neuen Offset.`, "info");
                    let neuerOffset = Utils.rundenKwh(aktuellerOffset + (letzterRohwert - neuerWertKwh));
                    this.pendingResetVerdacht = false;
                    return { aktion: "OK", neuerOffset: neuerOffset };
                } else {
                    log(`"Falsche 0" abgewehrt! Sensor liefert wieder normale Werte.`, "info");
                    this.pendingResetVerdacht = false;
                    return { aktion: "OK", neuerOffset: null };
                }
            } else {
                log(`Wert fiel plötzlich auf ${neuerWertKwh} kWh. Warte auf Bestätigung...`, "warn");
                this.pendingResetVerdacht = true;
                
                // Timeout-Schutz: Falls der Sensor nach einem Absturz ewig offline bleibt
                if (this.pendingResetTimer) clearTimeout(this.pendingResetTimer);
                this.pendingResetTimer = setTimeout(() => {
                    log("Pending-Reset-Status nach 1 Stunde ohne Bestätigung zurückgesetzt. Sensor evtl. defekt/offline.", "warn");
                    this.pendingResetVerdacht = false;
                }, 60 * 60 * 1000); // 1 Stunde

                return { aktion: "PENDING", neuerOffset: null };
            }
        } else {
            if (this.pendingResetVerdacht) {
                this.pendingResetVerdacht = false;
                if (this.config.debug) log(`[DEBUG] Pending-Status verworfen, Wert steigt wieder normal.`, "info");
            }
            return { aktion: "OK", neuerOffset: null };
        }
    }

    async aktualisiereVerbrauchswerte(aktuellerZaehlerstand) {
        const perioden = [
            { ref: "Strom_Referenz_heute", ziel: "Strom_Verbrauch_heute" },
            { ref: "Strom_Referenz_Woche", ziel: "Strom_Verbrauch_Woche" },
            { ref: "Strom_Referenz_Monat", ziel: "Strom_Verbrauch_Monat" },
            { ref: "Strom_Referenz_Kalenderjahr", ziel: "Strom_Verbrauch_Kalenderjahr" },
            { ref: "Strom_Referenz_Ablesung", ziel: "Strom_Verbrauch_letzte_Ablesung" }
        ];

        // Die Werte werden einzeln via Cache bezogen, was DB-Abfragen eliminiert
        for (const p of perioden) {
            const fullId = this.config.basePath + p.ref;
            let referenz = await this.getStateCached(fullId);

            if (referenz === null || referenz === undefined) {
                await this.schreibeWertAsync(p.ref, aktuellerZaehlerstand);
                referenz = aktuellerZaehlerstand;
            }
            
            let verbrauch = Utils.rundenKwh(aktuellerZaehlerstand - referenz);
            await this.schreibeWertAsync(p.ziel, verbrauch);
        }
    }

    async fuehreManuelleAblesungAus() {
        log("Manuelle Ablesung ausgelöst.", "info");
        let aktuellerZaehlerstand = this.holeWert("Strom_Zaehlerstand") || 0;
        await this.schreibeWertAsync("Strom_Datum_letzte_Ablesung", Utils.formatiereDatum(new Date()));
        await this.schreibeWertAsync("Strom_Referenz_Ablesung", aktuellerZaehlerstand);
        await this.schreibeWertAsync("Strom_Verbrauch_letzte_Ablesung", 0);
        
        await this.schreibeWertAsync("Strom_Ablesung_Trigger", false, true);
    }

    async schichteTagesWerteUm() {
        if (this.config.debug) log("Führe Tageswechsel aus...", "info");
        let aktuellerZaehlerstand = this.holeWert("Strom_Zaehlerstand") || 0;
        let verbrauchHeute = this.holeWert("Strom_Verbrauch_heute") || 0;

        await this.schreibeWertAsync("Strom_Verbrauch_gestern", verbrauchHeute);
        await this.schreibeWertAsync("Strom_Referenz_heute", aktuellerZaehlerstand);
        await this.schreibeWertAsync("Strom_Verbrauch_heute", 0);
        await this.schreibeWertAsync("Strom_Letztes_Speicher_Datum", Utils.heuteIso());
    }

    async schichteWochenWerteUm() {
        if (this.config.debug) log("Führe Wochenwechsel aus...", "info");
        let aktuellerZaehlerstand = this.holeWert("Strom_Zaehlerstand") || 0;
        let verbrauchWoche = this.holeWert("Strom_Verbrauch_Woche") || 0;
        
        await this.schreibeWertAsync("Strom_Verbrauch_letzte_Woche", verbrauchWoche);
        await this.schreibeWertAsync("Strom_Referenz_Woche", aktuellerZaehlerstand);
        await this.schreibeWertAsync("Strom_Verbrauch_Woche", 0);
    }

    async schichteMonatsWerteUm() {
        if (this.config.debug) log("Führe Monatswechsel aus...", "info");
        let aktuellerZaehlerstand = this.holeWert("Strom_Zaehlerstand") || 0;
        let verbrauchMonat = this.holeWert("Strom_Verbrauch_Monat") || 0;
        
        await this.schreibeWertAsync("Strom_Verbrauch_letzter_Monat", verbrauchMonat);
        await this.schreibeWertAsync("Strom_Referenz_Monat", aktuellerZaehlerstand);
        await this.schreibeWertAsync("Strom_Verbrauch_Monat", 0);
    }

    async schichteJahresWerteUm() {
        if (this.config.debug) log("Führe Jahreswechsel aus...", "info");
        let aktuellerZaehlerstand = this.holeWert("Strom_Zaehlerstand") || 0;
        let verbrauchJahr = this.holeWert("Strom_Verbrauch_Kalenderjahr") || 0;
        
        await this.schreibeWertAsync("Strom_Verbrauch_letztes_Kalenderjahr", verbrauchJahr);
        await this.schreibeWertAsync("Strom_Referenz_Kalenderjahr", aktuellerZaehlerstand);
        await this.schreibeWertAsync("Strom_Verbrauch_Kalenderjahr", 0);
    }
    
    stop() {
        this.subscriptions.forEach(sub => unsubscribe(sub));
        if (this.pendingResetTimer) clearTimeout(this.pendingResetTimer);
        
        // Letzte Speicherung erzwingen vor dem Beenden
        if (this.config.metrikSpeichern) {
            this.speichereMetriken(true).catch(e => log("Fehler beim abschließenden Metrik-Sync: " + e, "error"));
        }
        
        if (this.config.debug) log(`Skript beendet. Verarbeitete Updates: ${this.metrics.updatesProcessed}, Fehler: ${this.metrics.errors}`, "info");
    }
}

// =========================================================================
// START
// =========================================================================
const stromZaehler = new StromZaehlerManager(CONFIG, DATENPUNKTE);
stromZaehler.start();

onStop(() => stromZaehler.stop(), 1000);

})();