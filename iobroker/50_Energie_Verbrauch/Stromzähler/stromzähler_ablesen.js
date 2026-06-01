/**
 * =============================================================================
 * @file         stromzaehler.js
 * @description Skript zur Erfassung, Berechnung und Historisierung von
 * Stromverbrauchsdaten (Tages-, Wochen-, Monats- und Jahreswerte).
 * Liest Daten eines Zigbee-Sensors, erkennt Sensor-Resets und
 * gleicht diese über einen dynamischen Offset automatisch ab.
 * Erweitert um Balkonkraftwerk-Integration: PV-Ertrag wird aus
 * load_power (W) per Trapezintegration selbst akkumuliert.
 * @version      1.9.0 (PV Eigenakkumulation aus load_power)
 * @date         2026-06-02
 * @author       Sanweb
 * =============================================================================
 */

(function() {
    "use strict";

const CONFIG = {
    basePath: '0_userdata.0.Haushalt.Strom.',

    // Haushaltszähler
    sources: {
        energy: 'zigbee2mqtt.0.0x0015bc001b10168f.energy',
        power:  'zigbee2mqtt.0.0x0015bc001b10168f.load_power'
    },

    // Balkonkraftwerk — einzige Quelle: Momentanleistung in Watt
    pv: {
        power: 'zigbee2mqtt.0.0xa4c1380557aaffff.load_power'
    },

    // Schwellwerte Hauptzähler-Validierung
    maxZulaessigerSprungKwh: 5.0,
    minResetSchwelleKwh:     0.01,

    // Metriken
    metrikSpeichern:         true,
    metrikUpdateIntervall:   10,

    debug: false
};

// ---------------------------------------------------------------------------
// DATENPUNKTE
// ---------------------------------------------------------------------------
const DATENPUNKTE = [
    // Haushalt — Bestand
    { id: "Strom_Aktualisierung",                 name: "Strom Aktualisierung",                    type: "string",  role: "text",         unit: "",    def: "YYYY-MM-DD 00:00:00" },
    { id: "Strom_Referenz_Ablesung",              name: "Strom Referenz Ablesung",                 type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Referenz_heute",                 name: "Strom Referenz heute",                    type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Referenz_Kalenderjahr",          name: "Strom Referenz Kalenderjahr",             type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Referenz_Monat",                 name: "Strom Referenz Monat",                    type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Referenz_Woche",                 name: "Strom Referenz Woche",                    type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_aktuell",              name: "Strom Verbrauch aktuell (Brutto)",         type: "number",  role: "value.power",  unit: "W"   },
    { id: "Strom_Verbrauch_gestern",              name: "Strom Verbrauch gestern",                 type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_heute",                name: "Strom Verbrauch heute",                   type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_Kalenderjahr",         name: "Strom Verbrauch Kalenderjahr",            type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_letzte_Ablesung",      name: "Strom Verbrauch letzte Ablesung",         type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_letzter_Monat",        name: "Strom Verbrauch letzter Monat",           type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_letztes_Kalenderjahr", name: "Strom Verbrauch letztes Kalenderjahr",    type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_letzte_Woche",         name: "Strom Verbrauch letzte Woche",            type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_Monat",                name: "Strom Verbrauch Monat",                   type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Verbrauch_Woche",                name: "Strom Verbrauch Woche",                   type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Zaehlerstand",                   name: "Strom: Aktueller Zählerstand (Live)",     type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Geraete_Offset",                 name: "Strom Geräte Offset",                     type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Letzter_Rohwert",                name: "Strom Letzter Rohwert",                   type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Ablesung_Trigger",               name: "Strom Ablesung auslösen",                 type: "boolean", role: "button",       unit: "",    def: false },
    { id: "Strom_Datum_letzte_Ablesung",          name: "Strom Datum letzte Ablesung",             type: "string",  role: "text",         unit: "",    def: "" },
    { id: "Strom_Letztes_Speicher_Datum",         name: "Strom Letztes Speicher Datum",            type: "string",  role: "text",         unit: "",    def: "" },
    { id: "Strom_Datum_Batterietausch",           name: "Strom Datum Batterietausch",              type: "string",  role: "text",         unit: "",    def: "" },
    { id: "Strom_Zaehler_Startoffset",            name: "Zählerwechsel: Fester Startwert (Basis)", type: "number",  role: "value.energy", unit: "kWh", def: 9863 },
    { id: "Strom_Zaehlerwechsel_Neuer_Wert",      name: "Zählerwechsel: Neuer Zählerstand",        type: "number",  role: "value.energy", unit: "kWh", def: 0 },
    { id: "Strom_Zaehlerwechsel_Trigger",         name: "Zählerwechsel: Auslösen",                 type: "boolean", role: "button",       unit: "",    def: false },

    // PV — Momentanleistung (Rohwert vom Sensor)
    { id: "PV_Leistung_aktuell",                  name: "PV Leistung aktuell",                     type: "number",  role: "value.power",  unit: "W"   },

    // PV — eigenakkumulierte Ertragswerte (kWh)
    { id: "PV_Ertrag_heute",                      name: "PV Ertrag heute",                         type: "number",  role: "value.energy", unit: "kWh" },
    { id: "PV_Ertrag_gestern",                    name: "PV Ertrag gestern",                       type: "number",  role: "value.energy", unit: "kWh" },
    { id: "PV_Ertrag_Woche",                      name: "PV Ertrag Woche",                         type: "number",  role: "value.energy", unit: "kWh" },
    { id: "PV_Ertrag_letzte_Woche",               name: "PV Ertrag letzte Woche",                  type: "number",  role: "value.energy", unit: "kWh" },
    { id: "PV_Ertrag_Monat",                      name: "PV Ertrag Monat",                         type: "number",  role: "value.energy", unit: "kWh" },
    { id: "PV_Ertrag_letzter_Monat",              name: "PV Ertrag letzter Monat",                 type: "number",  role: "value.energy", unit: "kWh" },
    { id: "PV_Ertrag_Kalenderjahr",               name: "PV Ertrag Kalenderjahr",                  type: "number",  role: "value.energy", unit: "kWh" },
    { id: "PV_Ertrag_letztes_Kalenderjahr",       name: "PV Ertrag letztes Kalenderjahr",          type: "number",  role: "value.energy", unit: "kWh" },
    // Interner Hilfswert: Zeitstempel des letzten PV-Watt-Wertes (Unix ms)
    { id: "PV_Letzter_Timestamp",                 name: "PV Letzter Timestamp (intern)",           type: "number",  role: "value",        unit: "",    def: 0 },
    // Interner Hilfswert: Letzter PV-Wattwert für Trapezintegration
    { id: "PV_Letzter_Wattwert",                  name: "PV Letzter Wattwert (intern)",            type: "number",  role: "value.power",  unit: "W",   def: 0 },

    // Netto-Bezug (Haushalt − PV)
    { id: "Strom_Netto_Leistung",                 name: "Strom Netto-Bezug aktuell",               type: "number",  role: "value.power",  unit: "W",   desc: "Netzbezug nach PV-Abzug. Negativ = Einspeisung." },
    { id: "Strom_Netto_Verbrauch_heute",          name: "Strom Netto-Bezug heute",                 type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Netto_Verbrauch_gestern",        name: "Strom Netto-Bezug gestern",               type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Netto_Verbrauch_Woche",          name: "Strom Netto-Bezug Woche",                 type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Netto_Verbrauch_Monat",          name: "Strom Netto-Bezug Monat",                 type: "number",  role: "value.energy", unit: "kWh" },
    { id: "Strom_Netto_Verbrauch_Kalenderjahr",   name: "Strom Netto-Bezug Kalenderjahr",          type: "number",  role: "value.energy", unit: "kWh" },

    // Metriken — Bestand
    { id: "Strom_Metriken_Updates_verarbeitet",   name: "Metriken: Updates verarbeitet",           type: "number",  role: "value",        unit: "",    def: 0 },
    { id: "Strom_Metriken_Letztes_Update",        name: "Metriken: Letztes Update",                type: "string",  role: "text",         unit: "",    def: "" },
    { id: "Strom_Metriken_Fehleranzahl",          name: "Metriken: Fehleranzahl",                  type: "number",  role: "value",        unit: "",    def: 0 },
    { id: "Strom_Metriken_Resets_erkannt",        name: "Metriken: Resets erkannt",                type: "number",  role: "value",        unit: "",    def: 0 },
    { id: "Strom_Metriken_Letzter_Fehler",        name: "Metriken: Letzter Fehler",                type: "string",  role: "text",         unit: "",    def: "" }
];

// ---------------------------------------------------------------------------
// UTILS
// ---------------------------------------------------------------------------
const Utils = {
    rundenKwh: (wert) => Number(Math.round(parseFloat(wert + 'e3')) + 'e-3'),

    formatiereDatum: (date) => {
        const p = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
    },

    heuteIso: () => new Date().toISOString().split('T')[0],

    getIsoWeek: (d) => {
        const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        const day = dt.getUTCDay() || 7;
        dt.setUTCDate(dt.getUTCDate() + 4 - day);
        const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
        return Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
    }
};

// ---------------------------------------------------------------------------
// HAUPTKLASSE
// ---------------------------------------------------------------------------
class StromZaehlerManager {
    constructor(config, datenpunkte) {
        this.config      = config;
        this.datenpunkte = datenpunkte;
        this.subscriptions = [];

        this.pendingResetVerdacht = false;
        this.pendingResetTimer    = null;
        this.processingLock       = false;

        this.metrics = { updatesProcessed: 0, lastUpdateTime: "", errors: 0, resetsDetected: 0 };

        this.stateCache  = new Map();
        this.cacheTTL    = 5000;

        this.updateQueue  = [];
        this.batchTimeout = null;

        this.letzterPlausiblerZaehlerstand = null;
    }

    // -------------------------------------------------------------------------
    // START
    // -------------------------------------------------------------------------
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
            log("Stromzähler-Skript (inkl. PV-Eigenakkumulation) erfolgreich gestartet.", "info");
        } catch (e) {
            log(`Kritischer Fehler beim Starten: ${e.message}`, "error");
        }
    }

    // -------------------------------------------------------------------------
    // VALIDIERUNG
    // -------------------------------------------------------------------------
    validiereConfig() {
        if (!this.config.basePath.endsWith('.'))
            throw new Error("basePath muss mit '.' enden.");
        if (!existsState(this.config.sources.energy))
            throw new Error(`Energy-Datenpunkt nicht gefunden: ${this.config.sources.energy}`);
        if (!existsState(this.config.sources.power))
            throw new Error(`Power-Datenpunkt nicht gefunden: ${this.config.sources.power}`);
        if (!existsState(this.config.pv.power))
            log(`WARNUNG: PV-Datenpunkt nicht gefunden: ${this.config.pv.power}`, "warn");
    }

    // -------------------------------------------------------------------------
    // DATENPUNKTE ERSTELLEN
    // -------------------------------------------------------------------------
    async erstelleDatenpunkte() {
        for (const dp of this.datenpunkte) {
            const fullId = this.config.basePath + dp.id;
            const def    = dp.type === "number" ? (dp.def !== undefined ? dp.def : 0)
                                                : (dp.def !== undefined ? dp.def : "");
            await createStateAsync(fullId, def, false, {
                name: dp.name, desc: dp.desc || dp.name,
                type: dp.type, role: dp.role, unit: dp.unit,
                read: true, write: true
            });
        }
    }

    // -------------------------------------------------------------------------
    // METRIKEN
    // -------------------------------------------------------------------------
    async ladeMetriken() {
        if (!this.config.metrikSpeichern) return;
        const laden = async (id, prop) => {
            const s = await getStateAsync(this.config.basePath + id);
            if (s) this.metrics[prop] = s.val || 0;
        };
        await laden("Strom_Metriken_Updates_verarbeitet", "updatesProcessed");
        await laden("Strom_Metriken_Fehleranzahl",        "errors");
        await laden("Strom_Metriken_Resets_erkannt",      "resetsDetected");
    }

    async speichereMetriken(force = false) {
        if (!this.config.metrikSpeichern) return;
        if (!force && !(this.config.metrikUpdateIntervall > 0 && this.metrics.updatesProcessed % this.config.metrikUpdateIntervall === 0)) return;
        await this.schreibeWertAsync("Strom_Metriken_Updates_verarbeitet", this.metrics.updatesProcessed);
        await this.schreibeWertAsync("Strom_Metriken_Letztes_Update",      this.metrics.lastUpdateTime);
        await this.schreibeWertAsync("Strom_Metriken_Resets_erkannt",      this.metrics.resetsDetected);
        await this.schreibeWertAsync("Strom_Metriken_Fehleranzahl",        this.metrics.errors);
    }

    async handleError(method, error) {
        this.metrics.errors++;
        log(`Fehler in ${method}: ${error.message}`, "error");
        if (this.config.metrikSpeichern) {
            await this.schreibeWertAsync("Strom_Metriken_Fehleranzahl",  this.metrics.errors);
            await this.schreibeWertAsync("Strom_Metriken_Letzter_Fehler", `${Utils.formatiereDatum(new Date())}: ${error.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // INITIALRUN
    // -------------------------------------------------------------------------
    async fuehreInitialRunAus() {
        // Hauptzähler Referenz initialisieren falls erster Start
        const refHeute = await getStateAsync(this.config.basePath + "Strom_Referenz_heute");
        if (!refHeute || !refHeute.val) {
            log("Erster Start: Initialisiere Referenzwerte...", "info");
            const initEnergy = await getStateAsync(this.config.sources.energy);
            if (initEnergy && typeof initEnergy.val === "number") {
                const startOffset    = this.holeWert("Strom_Zaehler_Startoffset") || 0;
                const geraeteOffset  = Utils.rundenKwh(-initEnergy.val);
                await this.schreibeWertAsync("Strom_Geraete_Offset", geraeteOffset);
                const stand = Utils.rundenKwh(initEnergy.val + startOffset + geraeteOffset);
                for (const ref of ["Strom_Referenz_heute","Strom_Referenz_Woche","Strom_Referenz_Monat","Strom_Referenz_Kalenderjahr","Strom_Referenz_Ablesung"])
                    await this.schreibeWertAsync(ref, stand);
            }
        }

        // Hauptzähler initial verarbeiten
        const initEnergy = await getStateAsync(this.config.sources.energy);
        if (initEnergy && typeof initEnergy.val === "number")
            await this.verarbeiteNeuenZaehlerstand(initEnergy.val);

        const initPower = await getStateAsync(this.config.sources.power);
        if (initPower && typeof initPower.val === "number") {
            await this.schreibeWertAsync("Strom_Verbrauch_aktuell", initPower.val, true);
            await this.aktualisiereNettoLeistung();
        }

        // PV Timestamp initialisieren, falls noch 0 (verhindert Riesenwert beim ersten Watt-Update)
        const pvTs = await getStateAsync(this.config.basePath + "PV_Letzter_Timestamp");
        if (!pvTs || pvTs.val === 0)
            await this.schreibeWertAsync("PV_Letzter_Timestamp", Date.now());

        const initPvPower = await getStateAsync(this.config.pv.power);
        if (initPvPower && typeof initPvPower.val === "number") {
            await this.schreibeWertAsync("PV_Leistung_aktuell",   initPvPower.val, true);
            await this.schreibeWertAsync("PV_Letzter_Wattwert",   initPvPower.val);
            await this.aktualisiereNettoLeistung();
        }
    }

    // -------------------------------------------------------------------------
    // VERPASSTE WECHSEL
    // -------------------------------------------------------------------------
    async pruefeVerpassteWechsel() {
        const letztes = this.holeWert("Strom_Letztes_Speicher_Datum");
        if (!letztes) return;
        const heute = new Date();
        if (letztes === Utils.heuteIso()) return;

        log(`Verpasster Tageswechsel (letzte Speicherung: ${letztes}). Hole nach...`, "warn");
        await this.schichteTagesWerteUm();

        const letztesDatum = new Date(letztes);
        let missedWeeks = Utils.getIsoWeek(heute) - Utils.getIsoWeek(letztesDatum);
        if (missedWeeks < 0) missedWeeks += 52;
        if (missedWeeks > 0 || letztesDatum.getFullYear() !== heute.getFullYear())
            for (let i = 0; i < (missedWeeks || 1); i++) await this.schichteWochenWerteUm();
        if (letztesDatum.getMonth() !== heute.getMonth() || letztesDatum.getFullYear() !== heute.getFullYear())
            await this.schichteMonatsWerteUm();
        if (letztesDatum.getFullYear() !== heute.getFullYear())
            await this.schichteJahresWerteUm();
    }

    // -------------------------------------------------------------------------
    // TRIGGER
    // -------------------------------------------------------------------------
    registriereTrigger() {
        // Hauptzähler Energie
        this.subscriptions.push(on({ id: this.config.sources.energy, change: "ne" }, async (obj) => {
            try { this.queueUpdate(obj.state.val); }
            catch (e) { await this.handleError("Trigger: energy", e); }
        }));

        // Hauptzähler Leistung
        this.subscriptions.push(on({ id: this.config.sources.power, change: "ne" }, async (obj) => {
            try {
                await this.schreibeWertAsync("Strom_Verbrauch_aktuell", obj.state.val, true);
                await this.aktualisiereNettoLeistung();
            } catch (e) { await this.handleError("Trigger: power", e); }
        }));

        // PV Leistung → Trapezintegration + Netto
        this.subscriptions.push(on({ id: this.config.pv.power, change: "ne" }, async (obj) => {
            try {
                const neuerWatt = obj.state.val;
                await this.schreibeWertAsync("PV_Leistung_aktuell", neuerWatt, true);
                await this.akkumulierePvErtrag(neuerWatt);
                await this.aktualisiereNettoLeistung();
                await this.aktualisiereNettoEnergiePerioden();
            } catch (e) { await this.handleError("Trigger: PV power", e); }
        }));

        // Manuelle Ablesung
        this.subscriptions.push(on({ id: this.config.basePath + "Strom_Ablesung_Trigger", change: "any", val: true }, async () => {
            try { await this.fuehreManuelleAblesungAus(); }
            catch (e) { await this.handleError("Trigger: Manuelle Ablesung", e); }
        }));

        // Zählerwechsel
        this.subscriptions.push(on({ id: this.config.basePath + "Strom_Zaehlerwechsel_Trigger", change: "any", val: true }, async () => {
            try { await this.fuehreZaehlerwechselAus(); }
            catch (e) { await this.handleError("Trigger: Zählerwechsel", e); }
        }));
    }

    // -------------------------------------------------------------------------
    // CRONJOBS
    // -------------------------------------------------------------------------
    registriereCronjobs() {
        schedule("59 59 23 * * *",   async () => { try { await this.schichteTagesWerteUm();  } catch (e) { await this.handleError("Cron: Tageswechsel",   e); } });
        schedule("59 59 23 * * 0",   async () => { try { await this.schichteWochenWerteUm(); } catch (e) { await this.handleError("Cron: Wochenwechsel",  e); } });
        schedule("59 59 23 28-31 * *", async () => {
            try {
                const morgen = new Date(); morgen.setDate(morgen.getDate() + 1);
                if (morgen.getDate() === 1) await this.schichteMonatsWerteUm();
            } catch (e) { await this.handleError("Cron: Monatswechsel", e); }
        });
        schedule("59 59 23 31 12 *", async () => { try { await this.schichteJahresWerteUm(); } catch (e) { await this.handleError("Cron: Jahreswechsel",  e); } });
        schedule("55 23 * * *",       async () => { try { await this.speichereMetriken(true); } catch (e) { await this.handleError("Cron: Metriken",       e); } });
    }

    // -------------------------------------------------------------------------
    // BATCH-SCHUTZ
    // -------------------------------------------------------------------------
    queueUpdate(wert) {
        this.updateQueue.push(wert);
        if (!this.batchTimeout) this.batchTimeout = setTimeout(() => this.processBatch(), 100);
    }

    async processBatch() {
        this.batchTimeout = null;
        const updates = [...this.updateQueue];
        this.updateQueue = [];
        for (const w of updates) {
            try { await this.verarbeiteNeuenZaehlerstand(w); }
            catch (e) { await this.handleError("Batch", e); }
        }
    }

    // -------------------------------------------------------------------------
    // STATE CACHE & HELPER
    // -------------------------------------------------------------------------
    async getStateCached(id) {
        const now = Date.now();
        const hit = this.stateCache.get(id);
        if (hit && (now - hit.timestamp < this.cacheTTL)) return hit.value;
        const s = await getStateAsync(id);
        const v = (s && s.val !== null && s.val !== undefined) ? s.val : null;
        this.stateCache.set(id, { value: v, timestamp: now });
        return v;
    }

    holeWert(idSuffix) {
        const s = getState(this.config.basePath + idSuffix);
        if (!s || s.val === null || s.val === undefined || s.val === "") return null;
        return s.val;
    }

    async schreibeWertAsync(idSuffix, wert, ack = true) {
        const fullId = this.config.basePath + idSuffix;
        const aktuell = await this.getStateCached(fullId);
        if (aktuell !== wert) {
            this.stateCache.set(fullId, { value: wert, timestamp: Date.now() });
            typeof setStateAsync === 'function'
                ? await setStateAsync(fullId, wert, ack)
                : setState(fullId, wert, ack);
        }
    }

    // -------------------------------------------------------------------------
    // PV — TRAPEZINTEGRATION
    // Energie (kWh) = (W_alt + W_neu) / 2 × Δt(h)
    // Wird bei jedem neuen load_power-Wert aufgerufen.
    // -------------------------------------------------------------------------
    async akkumulierePvErtrag(neuerWattWert) {
        const jetzt        = Date.now();
        const letzterTs    = await this.getStateCached(this.config.basePath + "PV_Letzter_Timestamp") ?? jetzt;
        const letzterWatt  = await this.getStateCached(this.config.basePath + "PV_Letzter_Wattwert")  ?? 0;

        const deltaStunden = (jetzt - letzterTs) / 3_600_000; // ms → h

        // Plausibilitätsprüfung: Intervall > 2h oder < 1s ignorieren
        if (deltaStunden > 2 || deltaStunden < 0.0003) {
            await this.schreibeWertAsync("PV_Letzter_Timestamp", jetzt);
            await this.schreibeWertAsync("PV_Letzter_Wattwert",  neuerWattWert);
            if (this.config.debug) log(`[PV] Trapez übersprungen: Δt=${deltaStunden.toFixed(4)}h`, "info");
            return;
        }

        // Trapezregel: Fläche unter der Leistungskurve
        const deltaKwh = Utils.rundenKwh(((letzterWatt + neuerWattWert) / 2) * deltaStunden / 1000);

        if (deltaKwh < 0) {
            // Negative Leistung ignorieren (Sensor-Artefakt)
            await this.schreibeWertAsync("PV_Letzter_Timestamp", jetzt);
            await this.schreibeWertAsync("PV_Letzter_Wattwert",  neuerWattWert);
            return;
        }

        if (this.config.debug)
            log(`[PV] Trapez: ${letzterWatt}W → ${neuerWattWert}W, Δt=${deltaStunden.toFixed(4)}h, +${deltaKwh}kWh`, "info");

        // Auf alle Akkumulatoren addieren
        for (const id of ["PV_Ertrag_heute","PV_Ertrag_Woche","PV_Ertrag_Monat","PV_Ertrag_Kalenderjahr"]) {
            const aktuell = await this.getStateCached(this.config.basePath + id) ?? 0;
            await this.schreibeWertAsync(id, Utils.rundenKwh(aktuell + deltaKwh));
        }

        // Hilfswerte aktualisieren
        await this.schreibeWertAsync("PV_Letzter_Timestamp", jetzt);
        await this.schreibeWertAsync("PV_Letzter_Wattwert",  neuerWattWert);
    }

    // -------------------------------------------------------------------------
    // NETTO-BERECHNUNGEN
    // -------------------------------------------------------------------------
    async aktualisiereNettoLeistung() {
        const brutto = await this.getStateCached(this.config.basePath + "Strom_Verbrauch_aktuell") ?? 0;
        const pv     = await this.getStateCached(this.config.basePath + "PV_Leistung_aktuell")    ?? 0;
        await this.schreibeWertAsync("Strom_Netto_Leistung", Math.round(brutto - pv), true);
    }

    async aktualisiereNettoEnergiePerioden() {
        const perioden = [
            { brutto: "Strom_Verbrauch_heute",        pv: "PV_Ertrag_heute",        netto: "Strom_Netto_Verbrauch_heute"         },
            { brutto: "Strom_Verbrauch_gestern",      pv: "PV_Ertrag_gestern",      netto: "Strom_Netto_Verbrauch_gestern"       },
            { brutto: "Strom_Verbrauch_Woche",        pv: "PV_Ertrag_Woche",        netto: "Strom_Netto_Verbrauch_Woche"         },
            { brutto: "Strom_Verbrauch_Monat",        pv: "PV_Ertrag_Monat",        netto: "Strom_Netto_Verbrauch_Monat"         },
            { brutto: "Strom_Verbrauch_Kalenderjahr", pv: "PV_Ertrag_Kalenderjahr", netto: "Strom_Netto_Verbrauch_Kalenderjahr"  }
        ];
        for (const p of perioden) {
            const b = await this.getStateCached(this.config.basePath + p.brutto) ?? 0;
            const v = await this.getStateCached(this.config.basePath + p.pv)    ?? 0;
            await this.schreibeWertAsync(p.netto, Utils.rundenKwh(b - v));
        }
    }

    // -------------------------------------------------------------------------
    // HAUPTVERARBEITUNG HAUSHALTSZÄHLER
    // -------------------------------------------------------------------------
    async verarbeiteNeuenZaehlerstand(neuerWertKwh) {
        if (this.processingLock) return;
        this.processingLock = true;
        const t0 = Date.now();
        try {
            if (typeof neuerWertKwh !== "number" || isNaN(neuerWertKwh)) return;

            const letzterRohwert = await this.getStateCached(this.config.basePath + "Strom_Letzter_Rohwert") ?? 0;
            let   geraeteOffset  = await this.getStateCached(this.config.basePath + "Strom_Geraete_Offset")  ?? 0;

            const status = this.pruefeAufReset(neuerWertKwh, letzterRohwert, geraeteOffset);
            if (status.aktion !== "PENDING" && this.pendingResetTimer) { clearTimeout(this.pendingResetTimer); this.pendingResetTimer = null; }
            if (status.aktion === "ABBRUCH" || status.aktion === "PENDING") return;

            if (status.neuerOffset !== null) {
                geraeteOffset = status.neuerOffset;
                await this.schreibeWertAsync("Strom_Geraete_Offset",       geraeteOffset);
                await this.schreibeWertAsync("Strom_Datum_Batterietausch",  Utils.formatiereDatum(new Date()));
                this.metrics.resetsDetected++;
                await this.speichereMetriken(true);
            }

            await this.schreibeWertAsync("Strom_Letzter_Rohwert", neuerWertKwh);

            const startOffset = await this.getStateCached(this.config.basePath + "Strom_Zaehler_Startoffset") ?? 0;
            let stand         = Utils.rundenKwh(neuerWertKwh + startOffset + geraeteOffset);

            if (stand < 0) { log(`WARNUNG: Zählerstand negativ (${stand} kWh)!`, "warn"); stand = 0; }
            if (this.letzterPlausiblerZaehlerstand !== null && stand < this.letzterPlausiblerZaehlerstand)
                log(`WARNUNG: Zählerstand gesunken (${this.letzterPlausiblerZaehlerstand} → ${stand} kWh).`, "warn");
            this.letzterPlausiblerZaehlerstand = stand;

            await this.schreibeWertAsync("Strom_Zaehlerstand",  stand);
            await this.schreibeWertAsync("Strom_Aktualisierung", Utils.formatiereDatum(new Date()));

            await this.aktualisiereVerbrauchswerte(stand);
            await this.aktualisiereNettoEnergiePerioden();

            this.metrics.updatesProcessed++;
            this.metrics.lastUpdateTime = new Date().toISOString();
            await this.speichereMetriken();

        } finally {
            this.processingLock = false;
            const d = Date.now() - t0;
            if (d > 500) log(`WARN: Verarbeitung dauerte ${d}ms`, "warn");
        }
    }

    // -------------------------------------------------------------------------
    // RESET-ERKENNUNG
    // -------------------------------------------------------------------------
    pruefeAufReset(neu, letzt, offset) {
        if (letzt === 0 && neu > 0) return { aktion: "OK", neuerOffset: null };
        const diff = neu - letzt;
        if (this.config.debug) log(`[DEBUG] Reset-Check: neu=${neu}, letzt=${letzt}, diff=${Utils.rundenKwh(diff)}`, "info");

        if (diff > this.config.maxZulaessigerSprungKwh) {
            log(`Unrealistischer Sprung (+${Utils.rundenKwh(diff)} kWh). Ignoriere Wert!`, "warn");
            return { aktion: "ABBRUCH", neuerOffset: null };
        }

        if (neu < letzt) {
            if (Math.abs(diff) < this.config.minResetSchwelleKwh) return { aktion: "ABBRUCH", neuerOffset: null };

            if (this.pendingResetVerdacht) {
                if (neu < this.config.maxZulaessigerSprungKwh) {
                    log("Sensor-Reset bestätigt. Setze neuen Offset.", "info");
                    this.pendingResetVerdacht = false;
                    return { aktion: "OK", neuerOffset: Utils.rundenKwh(offset + (letzt - neu)) };
                } else {
                    log('"Falsche 0" abgewehrt.', "info");
                    this.pendingResetVerdacht = false;
                    return { aktion: "OK", neuerOffset: null };
                }
            } else {
                log(`Wert fiel auf ${neu} kWh. Warte auf Bestätigung...`, "warn");
                this.pendingResetVerdacht = true;
                if (this.pendingResetTimer) clearTimeout(this.pendingResetTimer);
                this.pendingResetTimer = setTimeout(() => {
                    log("Pending-Reset nach 1h zurückgesetzt.", "warn");
                    this.pendingResetVerdacht = false;
                }, 3_600_000);
                return { aktion: "PENDING", neuerOffset: null };
            }
        } else {
            if (this.pendingResetVerdacht) { this.pendingResetVerdacht = false; }
            return { aktion: "OK", neuerOffset: null };
        }
    }

    // -------------------------------------------------------------------------
    // VERBRAUCHSWERTE
    // -------------------------------------------------------------------------
    async aktualisiereVerbrauchswerte(stand) {
        const perioden = [
            { ref: "Strom_Referenz_heute",        ziel: "Strom_Verbrauch_heute"          },
            { ref: "Strom_Referenz_Woche",        ziel: "Strom_Verbrauch_Woche"          },
            { ref: "Strom_Referenz_Monat",        ziel: "Strom_Verbrauch_Monat"          },
            { ref: "Strom_Referenz_Kalenderjahr", ziel: "Strom_Verbrauch_Kalenderjahr"   },
            { ref: "Strom_Referenz_Ablesung",     ziel: "Strom_Verbrauch_letzte_Ablesung"}
        ];
        for (const p of perioden) {
            let ref = await this.getStateCached(this.config.basePath + p.ref);
            if (ref === null) { await this.schreibeWertAsync(p.ref, stand); ref = stand; }
            await this.schreibeWertAsync(p.ziel, Utils.rundenKwh(stand - ref));
        }
    }

    // -------------------------------------------------------------------------
    // MANUELLE ABLESUNG
    // -------------------------------------------------------------------------
    async fuehreManuelleAblesungAus() {
        log("Manuelle Ablesung ausgelöst.", "info");
        const stand = this.holeWert("Strom_Zaehlerstand") || 0;
        await this.schreibeWertAsync("Strom_Datum_letzte_Ablesung",     Utils.formatiereDatum(new Date()));
        await this.schreibeWertAsync("Strom_Referenz_Ablesung",         stand);
        await this.schreibeWertAsync("Strom_Verbrauch_letzte_Ablesung", 0);
        await this.schreibeWertAsync("Strom_Ablesung_Trigger",          false, true);
    }

    // -------------------------------------------------------------------------
    // ZÄHLERWECHSEL
    // -------------------------------------------------------------------------
    async fuehreZaehlerwechselAus() {
        if (this.processingLock) { log("Lock aktiv. Später erneut versuchen.", "warn"); return; }
        this.processingLock = true;
        try {
            const neuer = this.holeWert("Strom_Zaehlerwechsel_Neuer_Wert");
            if (typeof neuer !== "number" || isNaN(neuer)) { log("Zählerwechsel: Ungültiger Wert.", "error"); return; }
            const aktuell = await this.getStateCached(this.config.basePath + "Strom_Zaehlerstand") ?? 0;
            const diff    = neuer - aktuell;
            if (Math.abs(diff) < 0.001) { log("Zählerwechsel: Wert bereits aktuell.", "info"); return; }

            log(`Zählerwechsel: ${aktuell} → ${neuer} kWh (Δ${diff})`, "info");
            const altOffset = await this.getStateCached(this.config.basePath + "Strom_Zaehler_Startoffset") ?? 0;
            await this.schreibeWertAsync("Strom_Zaehler_Startoffset", Utils.rundenKwh(altOffset + diff));

            for (const ref of ["Strom_Referenz_heute","Strom_Referenz_Woche","Strom_Referenz_Monat","Strom_Referenz_Kalenderjahr","Strom_Referenz_Ablesung"]) {
                const alt = await this.getStateCached(this.config.basePath + ref) ?? 0;
                await this.schreibeWertAsync(ref, Utils.rundenKwh(alt + diff));
            }
            this.letzterPlausiblerZaehlerstand = neuer;
            await this.schreibeWertAsync("Strom_Zaehlerstand", neuer);
            log("Zählerwechsel abgeschlossen.", "info");
        } catch (e) { await this.handleError("Zählerwechsel", e); }
        finally {
            this.processingLock = false;
            await this.schreibeWertAsync("Strom_Zaehlerwechsel_Trigger", false, true);
        }
    }

    // -------------------------------------------------------------------------
    // ROLLOVER
    // -------------------------------------------------------------------------
    async schichteTagesWerteUm() {
        if (this.config.debug) log("Tageswechsel...", "info");
        const stand          = this.holeWert("Strom_Zaehlerstand")       || 0;
        const verbrauchHeute = this.holeWert("Strom_Verbrauch_heute")    || 0;
        const pvHeute        = this.holeWert("PV_Ertrag_heute")          || 0;
        const nettoHeute     = this.holeWert("Strom_Netto_Verbrauch_heute") || 0;

        await this.schreibeWertAsync("Strom_Verbrauch_gestern",      verbrauchHeute);
        await this.schreibeWertAsync("PV_Ertrag_gestern",            pvHeute);
        await this.schreibeWertAsync("Strom_Netto_Verbrauch_gestern",nettoHeute);
        await this.schreibeWertAsync("Strom_Referenz_heute",         stand);
        await this.schreibeWertAsync("Strom_Verbrauch_heute",        0);
        await this.schreibeWertAsync("PV_Ertrag_heute",              0);
        await this.schreibeWertAsync("Strom_Netto_Verbrauch_heute",  0);
        await this.schreibeWertAsync("Strom_Letztes_Speicher_Datum", Utils.heuteIso());
        // PV Timestamp zurücksetzen damit die erste Messung des neuen Tages
        // nicht eine riesige Zeitlücke akkumuliert
        await this.schreibeWertAsync("PV_Letzter_Timestamp",         Date.now());
    }

    async schichteWochenWerteUm() {
        if (this.config.debug) log("Wochenwechsel...", "info");
        const stand   = this.holeWert("Strom_Zaehlerstand")    || 0;
        const brutto  = this.holeWert("Strom_Verbrauch_Woche") || 0;
        const pv      = this.holeWert("PV_Ertrag_Woche")       || 0;
        const netto   = this.holeWert("Strom_Netto_Verbrauch_Woche") || 0;

        await this.schreibeWertAsync("Strom_Verbrauch_letzte_Woche",  brutto);
        await this.schreibeWertAsync("PV_Ertrag_letzte_Woche",        pv);
        await this.schreibeWertAsync("Strom_Referenz_Woche",          stand);
        await this.schreibeWertAsync("Strom_Verbrauch_Woche",         0);
        await this.schreibeWertAsync("PV_Ertrag_Woche",               0);
        await this.schreibeWertAsync("Strom_Netto_Verbrauch_Woche",   0);
    }

    async schichteMonatsWerteUm() {
        if (this.config.debug) log("Monatswechsel...", "info");
        const stand  = this.holeWert("Strom_Zaehlerstand")    || 0;
        const brutto = this.holeWert("Strom_Verbrauch_Monat") || 0;
        const pv     = this.holeWert("PV_Ertrag_Monat")       || 0;
        const netto  = this.holeWert("Strom_Netto_Verbrauch_Monat") || 0;

        await this.schreibeWertAsync("Strom_Verbrauch_letzter_Monat", brutto);
        await this.schreibeWertAsync("PV_Ertrag_letzter_Monat",       pv);
        await this.schreibeWertAsync("Strom_Referenz_Monat",          stand);
        await this.schreibeWertAsync("Strom_Verbrauch_Monat",         0);
        await this.schreibeWertAsync("PV_Ertrag_Monat",               0);
        await this.schreibeWertAsync("Strom_Netto_Verbrauch_Monat",   0);
    }

    async schichteJahresWerteUm() {
        if (this.config.debug) log("Jahreswechsel...", "info");
        const stand  = this.holeWert("Strom_Zaehlerstand")          || 0;
        const brutto = this.holeWert("Strom_Verbrauch_Kalenderjahr") || 0;
        const pv     = this.holeWert("PV_Ertrag_Kalenderjahr")       || 0;
        const netto  = this.holeWert("Strom_Netto_Verbrauch_Kalenderjahr") || 0;

        await this.schreibeWertAsync("Strom_Verbrauch_letztes_Kalenderjahr", brutto);
        await this.schreibeWertAsync("PV_Ertrag_letztes_Kalenderjahr",       pv);
        await this.schreibeWertAsync("Strom_Referenz_Kalenderjahr",          stand);
        await this.schreibeWertAsync("Strom_Verbrauch_Kalenderjahr",         0);
        await this.schreibeWertAsync("PV_Ertrag_Kalenderjahr",               0);
        await this.schreibeWertAsync("Strom_Netto_Verbrauch_Kalenderjahr",   0);
    }

    // -------------------------------------------------------------------------
    // STOP
    // -------------------------------------------------------------------------
    stop() {
        this.subscriptions.forEach(sub => unsubscribe(sub));
        if (this.pendingResetTimer) clearTimeout(this.pendingResetTimer);
        if (this.config.metrikSpeichern)
            this.speichereMetriken(true).catch(e => log("Metrik-Sync Fehler: " + e, "error"));
        if (this.config.debug)
            log(`Beendet. Updates: ${this.metrics.updatesProcessed}, Fehler: ${this.metrics.errors}`, "info");
    }
}

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
const stromZaehler = new StromZaehlerManager(CONFIG, DATENPUNKTE);
stromZaehler.start();
onStop(() => stromZaehler.stop(), 1000);

})();