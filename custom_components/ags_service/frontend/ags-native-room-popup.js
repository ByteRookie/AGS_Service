(function () {
  if (window.__agsNativeRoomPopupInstalled) return;
  window.__agsNativeRoomPopupInstalled = true;

  class AgsRoomDialog extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._hass = null;
      this._entityId = "";
      this._pendingVolume = new Map();
      this._pendingRoomToggles = new Map();
      this._timers = new Map();
      this._previousBodyOverflow = "";
      this._handleKeydown = this._handleKeydown.bind(this);
    }

    connectedCallback() {
      this._previousBodyOverflow = document.body.style.overflow || "";
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", this._handleKeydown, true);
    }

    disconnectedCallback() {
      document.body.style.overflow = this._previousBodyOverflow;
      document.removeEventListener("keydown", this._handleKeydown, true);
      for (const timer of this._timers.values()) window.clearTimeout(timer);
      this._timers.clear();
    }

    _handleKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    }

    set hass(hass) {
      this._hass = hass;
      this.render();
    }

    open(hass, entityId) {
      this._hass = hass;
      this._entityId = entityId;
      this.render();
    }

    get stateObj() {
      return this._hass?.states?.[this._entityId];
    }

    escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    displayedVolume(entityId, stateObj) {
      if (!entityId) return 0;
      if (this._pendingVolume.has(entityId)) return this._pendingVolume.get(entityId);
      return Math.round((stateObj?.attributes?.volume_level || 0) * 100);
    }

    setVolume(entityId, value) {
      if (!this._hass || !entityId) return;
      this._pendingVolume.set(entityId, Number(value));
      this.unmuteForVolumeChange(entityId);
      if (this._timers.has(entityId)) window.clearTimeout(this._timers.get(entityId));
      this._timers.set(entityId, window.setTimeout(() => this.flushVolume(entityId), 180));
      this.render();
    }

    unmuteForVolumeChange(entityId) {
      if (!this._hass || !entityId) return;
      if (entityId === this._entityId) {
        const active = this.stateObj?.attributes?.active_speakers || [];
        const muted = active.length > 0 && active.every((id) => this._hass?.states?.[id]?.attributes?.is_volume_muted);
        if (muted) {
          this._hass.callService("media_player", "volume_mute", {
            entity_id: active,
            is_volume_muted: false,
          });
        }
        return;
      }
      if (this._hass.states?.[entityId]?.attributes?.is_volume_muted) {
        this._hass.callService("media_player", "volume_mute", {
          entity_id: entityId,
          is_volume_muted: false,
        });
      }
    }

    flushVolume(entityId) {
      if (!this._hass || !entityId || !this._pendingVolume.has(entityId)) return;
      this._hass.callService("media_player", "volume_set", {
        entity_id: entityId,
        volume_level: this._pendingVolume.get(entityId) / 100,
      });
    }

    toggleMute(entityId, muted) {
      if (!this._hass || !entityId) return;
      if (entityId === this._entityId) {
        const active = this.stateObj?.attributes?.active_speakers || [];
        if (!active.length) return;
        this._hass.callService("media_player", "volume_mute", {
          entity_id: active,
          is_volume_muted: !muted,
        });
        return;
      }
      this._hass.callService("media_player", "volume_mute", {
        entity_id: entityId,
        is_volume_muted: !muted,
      });
    }

    async toggleRoom(switchEntityId, switchOn) {
      if (!this._hass || !switchEntityId || this._pendingRoomToggles.has(switchEntityId)) return;
      const next = !switchOn;
      this._pendingRoomToggles.set(switchEntityId, next);
      this.render();
      await this._hass.callService("switch", next ? "turn_on" : "turn_off", { entity_id: switchEntityId });
      window.setTimeout(() => {
        this._pendingRoomToggles.delete(switchEntityId);
        this.render();
      }, 3000);
    }

    close() {
      this.remove();
    }

    getRoomSpeaker(room) {
      const devices = Array.isArray(room?.devices) ? room.devices : [];
      return devices.find((device) => device.device_type === "speaker")
        || devices.find((device) => {
          const entityId = device.entity_id || device.device_id || "";
          return entityId && this.stateObj?.attributes?.active_speakers?.includes(entityId);
        })
        || devices.find((device) => device.entity_id || device.device_id)
        || null;
    }

    renderRoomRow(room) {
      const speaker = this.getRoomSpeaker(room);
      const speakerId = speaker?.entity_id || speaker?.device_id || "";
      const speakerState = speakerId ? this._hass?.states?.[speakerId] : null;
      const volume = this.displayedVolume(speakerId, speakerState);
      const muted = Boolean(speakerState?.attributes?.is_volume_muted);
      const switchId = room.switch_entity_id || "";
      const switchOn = String(room.switch_state || "").toLowerCase() === "on";
      const pending = this._pendingRoomToggles.has(switchId);
      return `
        <div class="room-row ${room.active ? "active" : ""} ${switchOn ? "" : "off"}">
          <div class="room-main">
            <span class="status-dot"></span>
            <div class="room-copy">
              <div class="room-name">${this.escapeHtml(room.name || "Room")}</div>
              <div class="room-meta">${this.escapeHtml(speaker?.friendly_name || speakerId || "No speaker")}</div>
            </div>
            <button class="icon-btn mute-btn ${muted ? "active" : ""}" title="${muted ? "Unmute" : "Mute"}" aria-label="${muted ? "Unmute" : "Mute"}" data-entity="${this.escapeHtml(speakerId)}" data-muted="${muted ? "true" : "false"}" ${speakerId ? "" : "disabled"}>
              <ha-icon icon="${muted ? "mdi:volume-off" : "mdi:volume-high"}"></ha-icon>
            </button>
            <button class="icon-btn room-power ${switchOn ? "active" : ""}" data-switch="${this.escapeHtml(switchId)}" data-on="${switchOn ? "true" : "false"}" ${switchId ? "" : "disabled"} style="${pending ? "opacity:.5" : ""}">
              <ha-icon icon="${switchOn ? "mdi:power" : "mdi:power-off"}"></ha-icon>
            </button>
          </div>
          <div class="volume-line">
            <input class="volume-slider" type="range" min="0" max="100" value="${volume}" data-entity="${this.escapeHtml(speakerId)}" ${speakerId ? "" : "disabled"} />
            <span>${volume}%</span>
          </div>
        </div>
      `;
    }

    render() {
      const stateObj = this.stateObj;
      const attrs = stateObj?.attributes || {};
      const rooms = Array.isArray(attrs.room_details) ? attrs.room_details : [];
      const activeSpeakers = Array.isArray(attrs.active_speakers) ? attrs.active_speakers : [];
      const groupMuted = activeSpeakers.length > 0 && activeSpeakers.every((id) => this._hass?.states?.[id]?.attributes?.is_volume_muted);
      const groupVolume = this.displayedVolume(this._entityId, stateObj);
      this.shadowRoot.innerHTML = `
        <style>
          :host { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); pointer-events: auto; touch-action: none; }
          .backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.42); pointer-events: auto; }
          ha-card { position: relative; width: min(520px, calc(100vw - 32px)); max-height: min(720px, calc(100vh - 48px)); overflow: auto; padding: 18px; box-sizing: border-box; }
          .head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
          .title { font-weight: 800; font-size: 1.15rem; }
          .sub { color: var(--secondary-text-color); font-size: .86rem; margin-top: 2px; }
          .icon-btn { width: 38px; height: 38px; border: 0; border-radius: 50%; background: transparent; color: inherit; display: inline-grid; place-items: center; cursor: pointer; }
          .icon-btn.active { color: var(--primary-color); background: color-mix(in srgb, var(--primary-color) 12%, transparent); }
          .icon-btn:disabled { opacity: .45; cursor: default; }
          .master, .volume-line { display: grid; grid-template-columns: minmax(0, 1fr) 46px; gap: 10px; align-items: center; }
          .master { grid-template-columns: 38px minmax(0, 1fr) 46px; margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--divider-color, rgba(127,127,127,.24)); }
          .room-list { display: flex; flex-direction: column; gap: 10px; }
          .room-row { border: 1px solid var(--divider-color, rgba(127,127,127,.24)); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 10px; background: var(--secondary-background-color, rgba(127,127,127,.06)); }
          .room-row.off { opacity: .68; }
          .room-main { display: grid; grid-template-columns: 12px minmax(0, 1fr) 38px 38px; gap: 8px; align-items: center; }
          .status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--disabled-text-color, #999); }
          .room-row.active .status-dot { background: var(--success-color, #4caf50); }
          .room-copy { min-width: 0; }
          .room-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .room-meta { color: var(--secondary-text-color); font-size: .8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          input[type="range"] { width: 100%; accent-color: var(--primary-color); }
          .empty { padding: 18px; text-align: center; color: var(--secondary-text-color); }
        </style>
        <div class="backdrop"></div>
        <ha-card>
          <div class="head">
            <div>
              <div class="title">Rooms</div>
              <div class="sub">${this.escapeHtml(attrs.dynamic_title || attrs.friendly_name || this._entityId)}</div>
            </div>
            <button class="icon-btn close-btn" title="Close"><ha-icon icon="mdi:close"></ha-icon></button>
          </div>
          <div class="master">
            <button class="icon-btn master-mute ${groupMuted ? "active" : ""}" title="${groupMuted ? "Unmute group" : "Mute group"}" aria-label="${groupMuted ? "Unmute group" : "Mute group"}" data-muted="${groupMuted ? "true" : "false"}"><ha-icon icon="${groupMuted ? "mdi:volume-off" : "mdi:volume-high"}"></ha-icon></button>
            <input class="volume-slider" type="range" min="0" max="100" value="${groupVolume}" data-entity="${this.escapeHtml(this._entityId)}" />
            <span>${groupVolume}%</span>
          </div>
          <div class="room-list">
            ${rooms.length ? rooms.map((room) => this.renderRoomRow(room)).join("") : `<div class="empty">No AGS rooms are available.</div>`}
          </div>
        </ha-card>
      `;
      this.bindEvents();
    }

    bindEvents() {
      const root = this.shadowRoot;
      root.querySelector(".backdrop")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      });
      root.querySelector(".backdrop")?.addEventListener("wheel", (event) => {
        event.preventDefault();
        event.stopPropagation();
      }, { passive: false });
      root.querySelector(".backdrop")?.addEventListener("touchmove", (event) => {
        event.preventDefault();
        event.stopPropagation();
      }, { passive: false });
      root.querySelector("ha-card")?.addEventListener("click", (event) => event.stopPropagation());
      root.querySelector("ha-card")?.addEventListener("pointerdown", (event) => event.stopPropagation());
      root.querySelector(".close-btn")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      });
      root.querySelector(".master-mute")?.addEventListener("click", (event) => {
        event.stopPropagation();
        this.toggleMute(this._entityId, event.currentTarget.dataset.muted === "true");
      });
      root.querySelectorAll(".volume-slider").forEach((slider) => {
        slider.addEventListener("pointerdown", (event) => event.stopPropagation());
        slider.addEventListener("click", (event) => event.stopPropagation());
        slider.addEventListener("input", (event) => {
          event.stopPropagation();
          this.setVolume(event.currentTarget.dataset.entity, event.currentTarget.value);
        });
        slider.addEventListener("change", (event) => {
          event.stopPropagation();
          this.flushVolume(event.currentTarget.dataset.entity);
        });
      });
      root.querySelectorAll(".mute-btn").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          this.toggleMute(button.dataset.entity, button.dataset.muted === "true");
        });
      });
      root.querySelectorAll(".room-power").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          this.toggleRoom(button.dataset.switch, button.dataset.on === "true");
        });
      });
    }
  }

  if (!customElements.get("ags-room-dialog")) {
    customElements.define("ags-room-dialog", AgsRoomDialog);
  }

  function findHass(node) {
    let current = node;
    while (current) {
      if (current.hass) return current.hass;
      current = current.parentNode || current.host;
    }
    return document.querySelector("home-assistant")?.hass || window.hassConnection?.hass;
  }

  function findEntityId(node) {
    let current = node;
    while (current) {
      const config = current._config || current.config;
      const entity = config?.entity || current.entityId || current.entity_id;
      if (typeof entity === "string" && entity.startsWith("media_player.")) return entity;
      current = current.parentNode || current.host;
    }
    return "";
  }

  function openAgsRoomDialog(hass, entityId) {
    let dialog = document.querySelector("ags-room-dialog");
    if (!dialog) {
      dialog = document.createElement("ags-room-dialog");
      document.body.appendChild(dialog);
    }
    dialog.open(hass, entityId);
  }

  document.addEventListener("click", (event) => {
    const path = event.composedPath ? event.composedPath() : [];
    const target = path.find((node) => node?.classList?.contains?.("join-media"));
    if (!target) return;

    const hass = findHass(target);
    const entityId = findEntityId(target);
    const stateObj = entityId ? hass?.states?.[entityId] : null;
    if (!stateObj || stateObj.attributes?.ags_status === undefined) return;
    if (stateObj.attributes?.native_room_popup === false) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openAgsRoomDialog(hass, entityId);
  }, true);
})();
