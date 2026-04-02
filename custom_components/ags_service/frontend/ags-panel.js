
import {
  LitElement,
  html,
  css,
} from "https://unpkg.com/lit-element@2.4.0/lit-element.js?module";

class AGSPanel extends LitElement {
  static get properties() {
    return {
      hass: { type: Object },
      config: { type: Object },
      activeTab: { type: String },
      logs: { type: Array },
      expandedRooms: { type: Array },
    };
  }

  constructor() {
    super();
    this.activeTab = "overview";
    this.config = null;
    this.logs = [];
    this.expandedRooms = [];
  }

  async connectedCallback() {
    super.connectedCallback();
    await this.fetchConfig();
    if (this.activeTab === "overview") {
      this.fetchLogs();
    }
  }

  async fetchConfig() {
    this.config = await this.hass.callWS({
      type: "ags_service/config/get",
    });
  }

  async fetchLogs() {
    this.logs = await this.hass.callWS({
      type: "ags_service/get_logs",
    });
  }

  async saveConfig() {
    try {
      await this.hass.callWS({
        type: "ags_service/config/save",
        config: this.config,
      });
      // Refresh local data
      await this.fetchConfig();
      alert("Configuration saved and Hot-Reloaded successfully!");
    } catch (err) {
      alert("Error saving configuration: " + err.message);
    }
  }

  render() {
    if (!this.config) return html`<ha-circular-progress active></ha-circular-progress>`;

    return html`
      <div class="header">
        <div class="title-section">
          <h1>${this.hass.states['media_player.ags_media_player']?.attributes.dynamic_title || "AGS Service"}</h1>
          <span class="version">v2.0.0</span>
        </div>
        <div class="tabs">
          <button class="${this.activeTab === 'overview' ? 'active' : ''}" @click="${() => { this.activeTab = 'overview'; this.fetchLogs(); }}">Overview</button>
          <button class="${this.activeTab === 'settings' ? 'active' : ''}" @click="${() => this.activeTab = 'settings'}">Settings</button>
          <button class="${this.activeTab === 'sources' ? 'active' : ''}" @click="${() => this.activeTab = 'sources'}">Sources</button>
        </div>
      </div>
      <div class="content">
        ${this.activeTab === 'overview' ? this.renderOverview() : 
          this.activeTab === 'settings' ? this.renderSettings() : this.renderSourceManager()}
      </div>
    `;
  }

  renderOverview() {
    const status = this.hass.states['media_player.ags_media_player'];
    return html`
      <div class="overview-grid">
        <ha-card header="Orchestration Logic">
          <div class="card-content">
            <div class="stepper">
              <div class="step ${status?.state !== 'off' ? 'active' : ''}">
                <ha-icon icon="mdi:magnify"></ha-icon> Scanning Rooms
              </div>
              <div class="step ${status?.attributes.ags_status !== 'OFF' ? 'active' : ''}">
                <ha-icon icon="mdi:crown"></ha-icon> Electing Master: ${status?.attributes.primary_speaker || "None"}
              </div>
              <div class="step ${status?.attributes.active_speakers?.length > 0 ? 'active' : ''}">
                <ha-icon icon="mdi:sync"></ha-icon> Syncing Groups (${status?.attributes.active_speakers?.length || 0} active)
              </div>
            </div>
          </div>
        </ha-card>

        <ha-card header="System Logs">
          <div class="card-content log-viewer">
            ${this.logs.map(log => html`<div class="log-entry">${log}</div>`)}
          </div>
          <div class="card-actions">
            <mwc-button @click="${this.fetchLogs}">Refresh Logs</mwc-button>
          </div>
        </ha-card>
      </div>
    `;
  }

  renderSettings() {
    return html`
      <div class="settings-container">
        <ha-card header="Global Configuration">
          <div class="card-content">
            <ha-textfield label="Static Player Name" .value="${this.config.static_name}" @change="${(e) => this.config.static_name = e.target.value}"></ha-textfield>
            <div class="toggle-row">
              <span>Batch Unjoin Speakers</span>
              <ha-switch .checked="${this.config.batch_unjoin}" @change="${(e) => this.config.batch_unjoin = e.target.checked}"></ha-switch>
            </div>
            <div class="toggle-row">
              <span>Disable Zone Check</span>
              <ha-switch .checked="${this.config.disable_zone}" @change="${(e) => this.config.disable_zone = e.target.checked}"></ha-switch>
            </div>
            <div class="utility-link">
              <span>Need a News Mode script?</span>
              <a href="https://github.com/ByteRookie/AGS_Service/blob/main/blueprints/script/ags_news_mode.yaml" target="_blank">Get the Blueprint</a>
            </div>
          </div>
        </ha-card>

        <h3>Rooms & Devices</h3>
        ${this.config.rooms.map((room, rIdx) => html`
          <ha-card class="room-card">
            <div class="room-header" @click="${() => this.toggleRoom(rIdx)}">
              <ha-icon icon="${this.expandedRooms.includes(rIdx) ? 'mdi:chevron-down' : 'mdi:chevron-right'}"></ha-icon>
              <span>${room.room}</span>
              <div class="room-actions">
                 <ha-icon-button icon="mdi:delete" @click="${(e) => { e.stopPropagation(); this.deleteRoom(rIdx); }}"></ha-icon-button>
              </div>
            </div>
            
            ${this.expandedRooms.includes(rIdx) ? html`
              <div class="card-content">
                <ha-textfield label="Room Name" .value="${room.room}" @change="${(e) => { room.room = e.target.value; this.requestUpdate(); }}"></ha-textfield>
                
                <h4>Devices</h4>
                ${room.devices.map((device, dIdx) => html`
                  <div class="device-item">
                    <div class="device-main">
                      <ha-entity-picker 
                        .hass="${this.hass}" 
                        .value="${device.device_id}" 
                        include-domains='["media_player"]'
                        @value-changed="${(e) => device.device_id = e.detail.value}">
                      </ha-entity-picker>
                      <select .value="${device.device_type}" @change="${(e) => device.device_type = e.target.value}">
                        <option value="speaker">Speaker</option>
                        <option value="tv">TV</option>
                      </select>
                      <ha-textfield type="number" label="Priority" .value="${device.priority}" @change="${(e) => device.priority = parseInt(e.target.value)}"></ha-textfield>
                      <ha-icon-button icon="mdi:delete" @click="${() => this.deleteDevice(rIdx, dIdx)}"></ha-icon-button>
                    </div>

                    <div class="overrides">
                       <h5>Source Overrides (News Mode)</h5>
                       ${(device.source_overrides || []).map((ovr, oIdx) => html`
                         <div class="override-item">
                           <select .value="${ovr.source_name}" @change="${(e) => ovr.source_name = e.target.value}">
                             ${this.config.Sources.map(s => html`<option value="${s.Source}">${s.Source}</option>`)}
                           </select>
                           <select .value="${ovr.mode}" @change="${(e) => ovr.mode = e.target.value}">
                             <option value="source">Source Value</option>
                             <option value="script">HA Script</option>
                           </select>
                           ${ovr.mode === 'script' ? html`
                             <ha-entity-picker .hass="${this.hass}" .value="${ovr.script_entity}" include-domains='["script"]' @value-changed="${(e) => ovr.script_entity = e.detail.value}"></ha-entity-picker>
                           ` : html`
                             <ha-textfield label="Value" .value="${ovr.source_value}" @change="${(e) => ovr.source_value = e.target.value}"></ha-textfield>
                           `}
                           <div class="toggle-row mini">
                             <span>Run when TV off</span>
                             <ha-switch .checked="${ovr.run_when_tv_off}" @change="${(e) => ovr.run_when_tv_off = e.target.checked}"></ha-switch>
                           </div>
                           <ha-icon-button icon="mdi:close" @click="${() => this.deleteOverride(rIdx, dIdx, oIdx)}"></ha-icon-button>
                         </div>
                       `)}
                       <mwc-button @click="${() => this.addOverride(rIdx, dIdx)}">Add Override</mwc-button>
                    </div>
                  </div>
                `)}
                <mwc-button icon="mdi:plus" @click="${() => this.addDevice(rIdx)}">Add Device</mwc-button>
              </div>
            ` : ""}
          </ha-card>
        `)}
        
        <div class="fab-container">
          <mwc-button raised icon="mdi:plus" @click="${this.addRoom}">Add New Room</mwc-button>
          <mwc-button raised class="save-btn" icon="mdi:content-save" @click="${this.saveConfig}">Save & Hot-Reload</mwc-button>
        </div>
      </div>
    `;
  }

  renderSourceManager() {
    return html`
      <div class="settings-container">
        <ha-card header="Global Music Sources">
          <div class="card-content">
            ${this.config.Sources.map((source, idx) => html`
              <div class="source-item card">
                <ha-textfield label="Display Name" .value="${source.Source}" @change="${(e) => source.Source = e.target.value}"></ha-textfield>
                <ha-textfield label="Source Value (ID)" .value="${source.Source_Value}" @change="${(e) => source.Source_Value = e.target.value}"></ha-textfield>
                <select .value="${source.media_content_type}" @change="${(e) => source.media_content_type = e.target.value}">
                   <option value="favorite_item_id">Sonos Favorite</option>
                   <option value="playlist">Playlist</option>
                   <option value="music">Music/URL</option>
                </select>
                <div class="toggle-row">
                   <span>Default Source</span>
                   <ha-switch .checked="${source.source_default}" @change="${(e) => this.setSourceDefault(idx)}"></ha-switch>
                </div>
                <ha-icon-button icon="mdi:delete" @click="${() => this.deleteSource(idx)}"></ha-icon-button>
              </div>
            `)}
            <mwc-button icon="mdi:plus" @click="${this.addSource}">Add New Source</mwc-button>
          </div>
        </ha-card>
        <div class="fab-container">
           <mwc-button raised class="save-btn" icon="mdi:content-save" @click="${this.saveConfig}">Save & Hot-Reload</mwc-button>
        </div>
      </div>
    `;
  }

  // Helper Methods
  toggleRoom(idx) {
    if (this.expandedRooms.includes(idx)) {
      this.expandedRooms = this.expandedRooms.filter(i => i !== idx);
    } else {
      this.expandedRooms = [...this.expandedRooms, idx];
    }
  }

  addRoom() {
    this.config.rooms.push({ room: "New Room", devices: [] });
    this.expandedRooms = [...this.expandedRooms, this.config.rooms.length - 1];
    this.requestUpdate();
  }

  deleteRoom(idx) {
    if (confirm("Delete this room and all its devices?")) {
      this.config.rooms.splice(idx, 1);
      this.requestUpdate();
    }
  }

  addDevice(rIdx) {
    this.config.rooms[rIdx].devices.push({ device_id: "", device_type: "speaker", priority: 1, source_overrides: [] });
    this.requestUpdate();
  }

  deleteDevice(rIdx, dIdx) {
    this.config.rooms[rIdx].devices.splice(dIdx, 1);
    this.requestUpdate();
  }

  addOverride(rIdx, dIdx) {
    const dev = this.config.rooms[rIdx].devices[dIdx];
    if (!dev.source_overrides) dev.source_overrides = [];
    dev.source_overrides.push({ source_name: this.config.Sources[0]?.Source || "", mode: "source", source_value: "", run_when_tv_off: false });
    this.requestUpdate();
  }

  deleteOverride(rIdx, dIdx, oIdx) {
    this.config.rooms[rIdx].devices[dIdx].source_overrides.splice(oIdx, 1);
    this.requestUpdate();
  }

  addSource() {
    this.config.Sources.push({ Source: "New Source", Source_Value: "", media_content_type: "favorite_item_id", source_default: false });
    this.requestUpdate();
  }

  deleteSource(idx) {
    this.config.Sources.splice(idx, 1);
    this.requestUpdate();
  }

  setSourceDefault(idx) {
    this.config.Sources.forEach((s, i) => s.source_default = (i === idx));
    this.requestUpdate();
  }

  static get styles() {
    return css`
      :host { display: block; height: 100%; overflow-y: auto; background: var(--secondary-background-color); }
      .header { background: var(--primary-background-color); padding: 16px; border-bottom: 1px solid var(--divider-color); }
      .title-section { display: flex; align-items: baseline; gap: 10px; }
      .version { font-size: 0.8em; opacity: 0.6; }
      .tabs { display: flex; gap: 8px; margin-top: 10px; }
      .tabs button { background: none; border: none; padding: 8px 16px; color: var(--secondary-text-color); cursor: pointer; border-bottom: 2px solid transparent; }
      .tabs button.active { color: var(--primary-color); border-bottom-color: var(--primary-color); font-weight: bold; }
      
      .content { padding: 16px; max-width: 1000px; margin: 0 auto; }
      .overview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      .stepper { display: flex; flex-direction: column; gap: 12px; }
      .step { padding: 12px; border-radius: 4px; background: var(--secondary-background-color); opacity: 0.5; display: flex; align-items: center; gap: 10px; }
      .step.active { opacity: 1; border-left: 4px solid var(--primary-color); }
      
      .log-viewer { height: 300px; overflow-y: auto; background: #111; color: #0f0; font-family: monospace; padding: 10px; font-size: 0.9em; }
      .log-entry { margin-bottom: 4px; border-bottom: 1px solid #222; }

      .settings-container { display: flex; flex-direction: column; gap: 16px; }
      .toggle-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; }
      .utility-link { margin-top: 12px; padding: 12px; background: var(--secondary-background-color); border-radius: 4px; display: flex; justify-content: space-between; align-items: center; }
      .utility-link a { color: var(--primary-color); text-decoration: none; font-weight: bold; }
      .room-card { margin-bottom: 8px; }
      .room-header { padding: 12px; display: flex; align-items: center; cursor: pointer; font-weight: bold; }
      .room-actions { margin-left: auto; }
      
      .device-item { border: 1px solid var(--divider-color); border-radius: 4px; padding: 12px; margin-bottom: 12px; background: var(--primary-background-color); }
      .device-main { display: grid; grid-template-columns: 2fr 1fr 0.5fr auto; gap: 12px; align-items: center; }
      .overrides { margin-top: 12px; padding-left: 20px; border-left: 2px dashed var(--divider-color); }
      .override-item { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr auto; gap: 8px; align-items: center; margin-bottom: 8px; }
      .mini { font-size: 0.8em; }

      .source-item { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr auto; gap: 12px; align-items: center; margin-bottom: 12px; padding: 12px; }
      
      .fab-container { position: sticky; bottom: 16px; display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px; }
      .save-btn { --mdc-theme-primary: var(--success-color, #4caf50); }
      
      ha-textfield, ha-entity-picker, select { width: 100%; }
      select { height: 40px; border: 1px solid var(--divider-color); background: var(--primary-background-color); color: var(--primary-text-color); border-radius: 4px; }
    `;
  }
}

customElements.define("ags-panel", AGSPanel);
