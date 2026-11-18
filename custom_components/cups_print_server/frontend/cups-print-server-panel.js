/*
 * CUPS Print Server - sidebar panel.
 *
 * Shows every CUPS printer queue of the integration as its own card with the
 * live status sensors and the power-management controls (power switch,
 * auto on/off toggles and the power-off delay).
 *
 * Runs in the Home Assistant page context, so `hass.entities` / `hass.devices`
 * (the entity and device registries) are available without any extra token.
 */

const DOMAIN = "cups_print_server";

const SENSOR_ORDER = [
  "printer_state",
  "queued_jobs",
  "current_job",
  "current_job_id",
  "current_job_state",
  "pages_completed",
  "last_job",
  "last_job_time",
  "printer_online",
];

const PRINTER_STATE_CLASS = {
  idle: "ok",
  processing: "busy",
  stopped: "bad",
  unknown: "muted",
};

const PRINTER_STATE_LABELS = {
  idle: "Bereit",
  processing: "Druckt",
  stopped: "Gestoppt",
  unknown: "Unbekannt",
};

const JOB_STATE_LABELS = {
  idle: "Leerlauf",
  pending: "Wartend",
  pending_held: "Zurückgehalten",
  processing: "Wird gedruckt",
  processing_stopped: "Druck angehalten",
  canceled: "Abgebrochen",
  aborted: "Fehlgeschlagen",
  completed: "Abgeschlossen",
  unknown: "Unbekannt",
};

const COUNTDOWN_SUFFIX = "verbleibende_ausschaltzeit";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function shortName(fullName, deviceName) {
  if (!fullName) return "";
  if (deviceName && fullName.startsWith(deviceName + " ")) {
    return fullName.slice(deviceName.length + 1);
  }
  return fullName;
}

function formatCountdown(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "aus";
  const mins = Math.floor(value / 60);
  const secs = Math.round(value % 60);
  if (mins <= 0) return `${secs} s`;
  return `${mins} min ${secs} s`;
}

class CupsPrintServerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._pending = false;
  }

  set hass(hass) {
    this._hass = hass;
    // Do not clobber a field the user is editing right now.
    if (this._inputFocused()) {
      this._pending = true;
      return;
    }
    this._render();
  }

  get hass() {
    return this._hass;
  }

  set narrow(value) {
    this._narrow = value;
  }

  set route(value) {
    this._route = value;
  }

  set panel(value) {
    this._panel = value;
  }

  connectedCallback() {
    if (this._hass) this._render();
  }

  _inputFocused() {
    const active = this.shadowRoot.activeElement;
    return !!active && active.tagName === "INPUT";
  }

  _sensorKey(entityId) {
    const entry = (this._hass.entities || {})[entityId];
    if (entry && entry.translation_key) return entry.translation_key;

    const stateObj = this._hass.states[entityId];
    if (stateObj && stateObj.attributes) {
      const dc = stateObj.attributes.device_class;
      if (dc === "timestamp") return "last_job_time";
      if (dc === "enum") {
        const opts = stateObj.attributes.options || [];
        return opts.includes("pending") ? "current_job_state" : "printer_state";
      }
    }

    const oid = entityId.split(".")[1] || "";
    if (oid.endsWith(COUNTDOWN_SUFFIX)) return "power_countdown";
    if (oid.endsWith("online")) return "printer_online";
    for (const key of SENSOR_ORDER) {
      if (oid.endsWith(key)) return key;
    }
    return "";
  }

  _deviceIds() {
    const hass = this._hass;
    const ids = new Set();
    for (const [deviceId, device] of Object.entries(hass.devices || {})) {
      const identifiers = device.identifiers || [];
      if (identifiers.some((id) => Array.isArray(id) && id[0] === DOMAIN)) {
        ids.add(deviceId);
      }
    }
    return ids;
  }

  _registry() {
    const hass = this._hass;
    const printers = new Map();
    if (!hass || !hass.entities) return printers;

    const deviceIds = this._deviceIds();

    for (const [entityId, entry] of Object.entries(hass.entities)) {
      if (!entry) continue;
      const byPlatform = entry.platform === DOMAIN;
      const byDevice = entry.device_id && deviceIds.has(entry.device_id);
      if (!byPlatform && !byDevice) continue;
      const deviceId = entry.device_id || "__none__";
      if (!printers.has(deviceId)) {
        printers.set(deviceId, { deviceId, entities: [] });
      }
      printers.get(deviceId).entities.push(entityId);
    }

    for (const printer of printers.values()) {
      const device = (hass.devices || {})[printer.deviceId];
      printer.device = device || null;
      printer.name =
        (device && (device.name_by_user || device.name)) ||
        (device && device.model) ||
        printer.deviceId;

      printer.switches = [];
      printer.numbers = [];
      printer.sensors = [];
      printer.countdown = null;

      for (const entityId of printer.entities) {
        if (!hass.states[entityId]) continue;
        const domain = entityId.split(".")[0];
        if (domain === "switch") {
          printer.switches.push(entityId);
        } else if (domain === "number") {
          printer.numbers.push(entityId);
        } else if (domain === "sensor" || domain === "binary_sensor") {
          if (this._sensorKey(entityId) === "power_countdown") {
            printer.countdown = entityId;
          } else {
            printer.sensors.push(entityId);
          }
        }
      }

      printer.sensors.sort((a, b) => {
        const orderA = SENSOR_ORDER.indexOf(this._sensorKey(a));
        const orderB = SENSOR_ORDER.indexOf(this._sensorKey(b));
        return (orderA < 0 ? 99 : orderA) - (orderB < 0 ? 99 : orderB);
      });
    }

    return printers;
  }

  _friendlyName(entityId) {
    const stateObj = this._hass.states[entityId];
    return (stateObj && stateObj.attributes.friendly_name) || entityId;
  }

  _stateValue(entityId) {
    const stateObj = this._hass.states[entityId];
    if (!stateObj) return "unbekannt";
    const state = stateObj.state;
    if (state === "unavailable") return "nicht verfügbar";
    if (state === "unknown") return "unbekannt";
    return state;
  }

  _render() {
    const hass = this._hass;
    if (!hass || !hass.states) return;

    const printers = this._registry();
    const cards = [...printers.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((printer) => this._renderPrinter(printer))
      .join("");

    const body = cards
      ? `<div class="printers">${cards}</div>`
      : `<div class="empty">
           <ha-icon icon="mdi:printer-off"></ha-icon>
           <p>Keine CUPS-Drucker gefunden.</p>
           <p class="hint">Sobald die Integration <code>${DOMAIN}</code>
              eingerichtet ist, erscheinen die Warteschlangen hier.</p>
         </div>`;

    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <div class="wrap">
        <header class="page-head">
          <div>
            <h1>CUPS Print Server</h1>
            <p class="sub">Drucker-Status und Power-Management</p>
          </div>
          <span class="count">${printers.size} Drucker</span>
        </header>
        ${body}
      </div>
    `;

    this._bindEvents();
    this._pending = false;
  }

  _renderPrinter(printer) {
    const hass = this._hass;
    const printerState = printer.sensors.find((e) => {
      const s = hass.states[e];
      return (
        s &&
        s.attributes &&
        s.attributes.device_class === "enum" &&
        ["idle", "processing", "stopped", "unknown"].includes(s.state)
      );
    });

    const stateValue = printerState ? hass.states[printerState].state : "unknown";
    const stateClass = PRINTER_STATE_CLASS[stateValue] || "muted";
    const stateLabel = PRINTER_STATE_LABELS[stateValue] || stateValue;

    const model = printer.device
      ? [printer.device.manufacturer, printer.device.model].filter(Boolean).join(" ")
      : "";
    const configUrl = printer.device && printer.device.configuration_url;

    const sensorRows = printer.sensors
      .map((e) => this._renderSensorRow(printer, e))
      .join("");

    const switchRows = printer.switches
      .map((e) => this._renderSwitchRow(printer, e))
      .join("");

    const numberRows = printer.numbers
      .map((e) => this._renderNumberRow(printer, e))
      .join("");

    const countdownRow = printer.countdown
      ? this._renderCountdownRow(printer, printer.countdown)
      : "";

    return `
      <section class="card">
        <div class="card-head">
          <div class="title">
            <ha-icon icon="mdi:printer"></ha-icon>
            <div class="title-text">
              <span class="name">${esc(printer.name)}</span>
              ${model ? `<span class="model">${esc(model)}</span>` : ""}
            </div>
          </div>
          <span class="chip ${stateClass}">${esc(stateLabel)}</span>
        </div>

        ${sensorRows ? `
          <div class="section">
            <div class="section-title">Status &amp; Sensoren</div>
            <div class="rows">${sensorRows}</div>
          </div>` : ""}

        ${switchRows || numberRows || countdownRow ? `
          <div class="section">
            <div class="section-title">Power-Management</div>
            <div class="rows">${switchRows}${numberRows}${countdownRow}</div>
          </div>` : ""}

        ${configUrl ? `
          <div class="card-foot">
            <a href="${esc(configUrl)}" target="_blank" rel="noopener">
              <ha-icon icon="mdi:open-in-new"></ha-icon> Drucker-Seite öffnen
            </a>
          </div>` : ""}
      </section>
    `;
  }

  _renderSensorRow(printer, entityId) {
    const stateObj = this._hass.states[entityId];
    if (!stateObj) return "";
    const label = shortName(this._friendlyName(entityId), printer.name);
    let value = this._stateValue(entityId);

    if (stateObj.attributes.device_class === "enum") {
      value = JOB_STATE_LABELS[value] || PRINTER_STATE_LABELS[value] || value;
    }

    const unit = stateObj.attributes.unit_of_measurement
      ? ` ${stateObj.attributes.unit_of_measurement}`
      : "";

    const isBinary = entityId.startsWith("binary_sensor.");
    const badge = isBinary
      ? `<span class="dot ${stateObj.state === "on" ? "ok" : "bad"}"></span>`
      : "";

    return `
      <div class="row">
        <span class="label">${esc(label)}</span>
        <span class="value">${badge}${esc(value)}${esc(unit)}</span>
      </div>
    `;
  }

  _renderCountdownRow(printer, entityId) {
    const stateObj = this._hass.states[entityId];
    if (!stateObj) return "";
    const label = shortName(this._friendlyName(entityId), printer.name);
    return `
      <div class="row">
        <span class="label">${esc(label)}</span>
        <span class="value">${esc(formatCountdown(stateObj.state))}</span>
      </div>
    `;
  }

  _renderSwitchRow(printer, entityId) {
    const stateObj = this._hass.states[entityId];
    if (!stateObj) return "";
    const on = stateObj.state === "on";
    const unavailable = stateObj.state === "unavailable";
    const label = shortName(this._friendlyName(entityId), printer.name);
    return `
      <div class="row">
        <span class="label">${esc(label)}</span>
        <button class="toggle ${on ? "on" : ""}"
                data-entity="${esc(entityId)}" data-on="${on}"
                ${unavailable ? "disabled" : ""} aria-pressed="${on}">
          <span class="knob"></span>
        </button>
      </div>
    `;
  }

  _renderNumberRow(printer, entityId) {
    const stateObj = this._hass.states[entityId];
    if (!stateObj) return "";
    const label = shortName(this._friendlyName(entityId), printer.name);
    const unit = stateObj.attributes.unit_of_measurement || "";
    return `
      <div class="row">
        <span class="label">${esc(label)}</span>
        <span class="number">
          <input type="number" data-entity="${esc(entityId)}"
                 value="${esc(stateObj.state)}"
                 min="${esc(stateObj.attributes.min ?? 0)}"
                 max="${esc(stateObj.attributes.max ?? 100000)}"
                 step="${esc(stateObj.attributes.step ?? 1)}">
          <span class="unit">${esc(unit)}</span>
        </span>
      </div>
    `;
  }

  _bindEvents() {
    const root = this.shadowRoot;

    root.querySelectorAll("button.toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entityId = btn.dataset.entity;
        const isOn = btn.dataset.on === "true";
        this._hass.callService("switch", isOn ? "turn_off" : "turn_on", {
          entity_id: entityId,
        });
      });
    });

    root.querySelectorAll("input[type=number]").forEach((input) => {
      input.addEventListener("change", () => {
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        this._hass.callService("number", "set_value", {
          entity_id: input.dataset.entity,
          value,
        });
      });
      input.addEventListener("blur", () => {
        if (this._pending) {
          this._pending = false;
          this._render();
        }
      });
    });
  }

  _styles() {
    return `
      :host {
        display: block;
        background: var(--primary-background-color);
        color: var(--primary-text-color);
        font-family: var(--paper-font-body1_-_font-family, inherit);
        min-height: 100%;
      }
      .wrap { max-width: 60rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
      .page-head {
        display: flex; align-items: flex-end; justify-content: space-between;
        gap: 1rem; margin-bottom: 1.25rem;
      }
      h1 { font-size: 1.5rem; margin: 0; font-weight: 500; }
      .sub { margin: .15rem 0 0; opacity: .7; font-size: .9rem; }
      .count {
        font-size: .8rem; opacity: .8; white-space: nowrap;
        background: var(--secondary-background-color); border-radius: 999px;
        padding: .25rem .7rem;
      }
      .printers {
        display: grid; gap: 1rem;
        grid-template-columns: repeat(auto-fill, minmax(21rem, 1fr));
      }
      .card {
        background: var(--card-background-color, var(--ha-card-background, #fff));
        border-radius: var(--ha-card-border-radius, 12px);
        box-shadow: var(--ha-card-box-shadow, 0 1px 3px rgba(0,0,0,.2));
        overflow: hidden;
      }
      .card-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: .75rem; padding: 1rem 1rem .75rem;
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.08));
      }
      .title { display: flex; align-items: center; gap: .6rem; min-width: 0; }
      .title ha-icon { color: var(--primary-color); --mdc-icon-size: 24px; }
      .title-text { display: flex; flex-direction: column; min-width: 0; }
      .name { font-weight: 600; font-size: 1.05rem; }
      .model {
        font-size: .78rem; opacity: .65;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .chip { font-size: .75rem; font-weight: 600; border-radius: 999px; padding: .2rem .65rem; white-space: nowrap; }
      .chip.ok    { background: rgba(67,160,71,.18);  color: #2e7d32; }
      .chip.busy  { background: rgba(30,136,229,.18); color: #1565c0; }
      .chip.bad   { background: rgba(229,57,53,.18);  color: #c62828; }
      .chip.muted { background: rgba(120,120,120,.18);color: #616161; }
      .section { padding: .75rem 1rem; }
      .section + .section { border-top: 1px solid var(--divider-color, rgba(0,0,0,.08)); }
      .section-title {
        font-size: .72rem; text-transform: uppercase; letter-spacing: .05em;
        opacity: .6; margin-bottom: .5rem;
      }
      .rows { display: flex; flex-direction: column; }
      .row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 1rem; min-height: 2.25rem;
      }
      .row + .row { border-top: 1px solid var(--divider-color, rgba(0,0,0,.06)); }
      .label { font-size: .9rem; opacity: .85; }
      .value {
        font-size: .9rem; font-weight: 500;
        display: inline-flex; align-items: center; gap: .4rem;
      }
      .dot { width: .55rem; height: .55rem; border-radius: 50%; display: inline-block; }
      .dot.ok { background: #43a047; }
      .dot.bad { background: #e53935; }
      .toggle {
        position: relative; width: 3rem; height: 1.6rem; flex: none;
        border: none; border-radius: 999px; cursor: pointer; padding: 0;
        background: var(--disabled-color, #bdbdbd);
        transition: background .15s ease;
      }
      .toggle .knob {
        position: absolute; top: .2rem; left: .2rem;
        width: 1.2rem; height: 1.2rem; border-radius: 50%;
        background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3);
        transition: transform .15s ease;
      }
      .toggle.on { background: var(--primary-color, #03a9f4); }
      .toggle.on .knob { transform: translateX(1.4rem); }
      .toggle:disabled { opacity: .4; cursor: not-allowed; }
      .number { display: inline-flex; align-items: center; gap: .4rem; }
      .number input {
        width: 5rem; padding: .35rem .5rem; font-size: .9rem; text-align: right;
        border-radius: 6px; border: 1px solid var(--divider-color, #ccc);
        background: var(--secondary-background-color, transparent); color: inherit;
      }
      .unit { font-size: .8rem; opacity: .7; }
      .card-foot { padding: .6rem 1rem; border-top: 1px solid var(--divider-color, rgba(0,0,0,.08)); }
      .card-foot a {
        display: inline-flex; align-items: center; gap: .35rem;
        font-size: .82rem; color: var(--primary-color); text-decoration: none;
      }
      .card-foot a:hover { text-decoration: underline; }
      .empty { text-align: center; padding: 3rem 1rem; opacity: .75; }
      .empty ha-icon { --mdc-icon-size: 48px; opacity: .5; }
      .hint { font-size: .85rem; opacity: .8; }
      code { background: rgba(127,127,127,.15); padding: .1rem .3rem; border-radius: .25rem; }
    `;
  }
}

if (!customElements.get("cups-print-server-panel")) {
  customElements.define("cups-print-server-panel", CupsPrintServerPanel);
}
