
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
    };
  }

  constructor() {
    super();
    this.activeTab = "overview";
    this.config = null;
  }

  async connectedCallback() {
    super.connectedCallback();
    this.fetchConfig();
  }

  async fetchConfig() {
    this.config = await this.hass.callWS({
      type: "ags_service/config/get",
    });
  }

  async saveConfig() {
    await this.hass.callWS({
      type: "ags_service/config/save",
      config: this.config,
    });
    this.fetchConfig();
  }

  render() {
    if (!this.config) return html`<p>Loading...</p>`;

    return html`
      <div class="header">
        <h1>${this.hass.states['media_player.ags_media_player']?.attributes.dynamic_title || "AGS Service"}</h1>
        <div class="tabs">
          <button class="${this.activeTab === 'overview' ? 'active' : ''}" @click="${() => this.activeTab = 'overview'}">Overview</button>
          <button class="${this.activeTab === 'settings' ? 'active' : ''}" @click="${() => this.activeTab = 'settings'}">Settings</button>
        </div>
      </div>
      <div class="content">
        ${this.activeTab === 'overview' ? this.renderOverview() : this.renderSettings()}
      </div>
    `;
  }

  renderOverview() {
    const status = this.hass.states['media_player.ags_media_player'];
    return html`
      <div class="overview-grid">
        <div class="card logic-visualizer">
          <h2>Orchestration Logic</h2>
          <div class="stepper">
            <div class="step ${status?.state !== 'off' ? 'active' : ''}">Scanning Rooms</div>
            <div class="step ${status?.attributes.ags_status !== 'OFF' ? 'active' : ''}">Electing Master</div>
            <div class="step ${status?.attributes.active_speakers?.length > 0 ? 'active' : ''}">Syncing Groups</div>
          </div>
        </div>
        <div class="card room-grid">
          <h2>Active Rooms</h2>
          <ul>
            ${status?.attributes.active_rooms?.map(room => html`<li>${room}</li>`)}
          </ul>
        </div>
      </div>
    `;
  }

  renderSettings() {
    return html`
      <div class="settings-form">
        <h2>Global Settings</h2>
        <div class="field">
          <label>Static Name</label>
          <input type="text" .value="${this.config.static_name}" @change="${(e) => this.config.static_name = e.target.value}">
        </div>
        <div class="field">
          <label>Batch Unjoin</label>
          <input type="checkbox" ?checked="${this.config.batch_unjoin}" @change="${(e) => this.config.batch_unjoin = e.target.checked}">
        </div>
        
        <h2>Rooms</h2>
        ${this.config.rooms.map((room, idx) => html`
          <div class="room-item">
            <input type="text" .value="${room.room}" @change="${(e) => room.room = e.target.value}">
            <button @click="${() => { this.config.rooms.splice(idx, 1); this.requestUpdate(); }}">Delete</button>
          </div>
        `)}
        <button @click="${() => { this.config.rooms.push({ room: "New Room", devices: [] }); this.requestUpdate(); }}">Add Room</button>

        <div class="actions">
          <button class="save" @click="${this.saveConfig}">Save and Apply</button>
        </div>
      </div>
    `;
  }

  static get styles() {
    return css`
      :host {
        display: block;
        padding: 20px;
        color: var(--primary-text-color);
      }
      .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #ccc; padding-bottom: 10px; }
      .tabs button { background: none; border: none; padding: 10px 20px; cursor: pointer; font-size: 1.1em; }
      .tabs button.active { border-bottom: 2px solid var(--primary-color); color: var(--primary-color); }
      .content { margin-top: 20px; }
      .overview-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }
      .card { background: var(--card-background-color); padding: 15px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
      .stepper { display: flex; flex-direction: column; gap: 10px; }
      .step { padding: 10px; border-left: 4px solid #ccc; }
      .step.active { border-left-color: var(--primary-color); font-weight: bold; }
      .settings-form { max-width: 600px; margin: 0 auto; }
      .field { margin-bottom: 15px; display: flex; flex-direction: column; }
      .actions { margin-top: 30px; text-align: right; }
      .save { background: var(--primary-color); color: white; border: none; padding: 10px 25px; border-radius: 4px; cursor: pointer; font-size: 1.1em; }
    `;
  }
}

customElements.define("ags-panel", AGSPanel);
