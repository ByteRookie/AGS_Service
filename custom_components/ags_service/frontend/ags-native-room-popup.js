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
      this._stateRefreshTimer = null;
      this._lastStateSignature = "";
      this._handleKeydown = this._handleKeydown.bind(this);
    }

    connectedCallback() {
      this._previousBodyOverflow = document.body.style.overflow || "";
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", this._handleKeydown, true);
      this.startStateRefresh();
    }

    disconnectedCallback() {
      document.body.style.overflow = this._previousBodyOverflow;
      document.removeEventListener("keydown", this._handleKeydown, true);
      this.stopStateRefresh();
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
      this.startStateRefresh();
    }

    open(hass, entityId) {
      this._hass = hass;
      this._entityId = entityId;
      this.render();
      this.startStateRefresh();
    }

    get stateObj() {
      return this._hass?.states?.[this._entityId];
    }

    parseRgbColor(value) {
      const text = String(value || "").trim();
      const match = text.match(/rgba?\(([^)]+)\)/i);
      if (!match) return null;
      const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
      if (parts.length < 3 || parts.some((part, index) => index < 3 && Number.isNaN(part))) return null;
      return { r: parts[0], g: parts[1], b: parts[2] };
    }

    isDarkTheme() {
      const styles = getComputedStyle(document.documentElement);
      const candidates = [
        styles.getPropertyValue("--primary-background-color"),
        styles.getPropertyValue("--card-background-color"),
        styles.getPropertyValue("--ha-card-background"),
      ];
      for (const candidate of candidates) {
        const rgb = this.parseRgbColor(candidate);
        if (!rgb) continue;
        const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
        return luminance < 0.5;
      }
      return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
    }

    getLatestHass() {
      return document.querySelector("home-assistant")?.hass || window.hassConnection?.hass || this._hass;
    }

    startStateRefresh() {
      if (this._stateRefreshTimer || !this.isConnected) return;
      this._stateRefreshTimer = window.setInterval(() => this.refreshLiveState(), 500);
    }

    stopStateRefresh() {
      if (!this._stateRefreshTimer) return;
      window.clearInterval(this._stateRefreshTimer);
      this._stateRefreshTimer = null;
    }

    getStateSignature() {
      const latestHass = this.getLatestHass();
      if (latestHass) this._hass = latestHass;
      const stateObj = this.stateObj;
      const attrs = stateObj?.attributes || {};
      const rooms = Array.isArray(attrs.room_details) ? attrs.room_details : [];
      const speakerIds = new Set(Array.isArray(attrs.active_speakers) ? attrs.active_speakers : []);
      const switchIds = new Set();
      rooms.forEach((room) => {
        if (room?.switch_entity_id) switchIds.add(room.switch_entity_id);
        const speaker = this.getRoomSpeaker(room);
        const speakerId = speaker?.entity_id || speaker?.device_id || "";
        if (speakerId) speakerIds.add(speakerId);
      });
      return JSON.stringify({
        entity: this._entityId,
        entityState: stateObj?.state || "",
        roomTitle: attrs.dynamic_title || attrs.friendly_name || "",
        rooms: rooms.map((room) => [room?.name, room?.active, room?.switch_state, room?.switch_entity_id]),
        switches: Array.from(switchIds).sort().map((id) => [id, this._hass?.states?.[id]?.state || ""]),
        speakers: Array.from(speakerIds).sort().map((id) => {
          const speakerState = this._hass?.states?.[id];
          return [
            id,
            speakerState?.state || "",
            speakerState?.attributes?.is_volume_muted ?? "",
            speakerState?.attributes?.volume_level ?? "",
          ];
        }),
      });
    }

    refreshLiveState() {
      if (!this.isConnected || !this._entityId) return;
      const signature = this.getStateSignature();
      if (signature && signature !== this._lastStateSignature) {
        this._lastStateSignature = signature;
        this.render();
      }
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
        window.setTimeout(() => this.refreshLiveState(), 250);
        return;
      }
      this._hass.callService("media_player", "volume_mute", {
        entity_id: entityId,
        is_volume_muted: !muted,
      });
      window.setTimeout(() => this.refreshLiveState(), 250);
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

    getRoomSpeakers(room) {
      const devices = Array.isArray(room?.devices) ? room.devices : [];
      const speakers = devices.filter((device) => device.device_type === "speaker" && (device.entity_id || device.device_id));
      return speakers.length ? speakers : devices.filter((device) => device.entity_id || device.device_id);
    }

    getRoomRank(room) {
      const ranks = this.getRoomSpeakers(room)
        .map((device) => Number(device.priority))
        .filter((priority) => Number.isFinite(priority) && priority > 0);
      return ranks.length ? Math.min(...ranks) : 9999;
    }

    getRoomSwitchOn(room) {
      const switchId = room?.switch_entity_id || "";
      const liveSwitchState = switchId ? this._hass?.states?.[switchId] : null;
      return String(liveSwitchState?.state || room?.switch_state || "").toLowerCase() === "on";
    }

    getSortedRooms(rooms) {
      return [...rooms].sort((a, b) => {
        const aOn = this.getRoomSwitchOn(a);
        const bOn = this.getRoomSwitchOn(b);
        if (aOn !== bOn) return aOn ? -1 : 1;
        const rankDelta = this.getRoomRank(a) - this.getRoomRank(b);
        if (rankDelta) return rankDelta;
        return String(a?.name || "").localeCompare(String(b?.name || ""));
      });
    }

    getMediaSummary(stateObj) {
      if (!stateObj) return "";
      const attrs = stateObj.attributes || {};
      const title = attrs.media_title || attrs.media_series_title || attrs.media_artist || "";
      const source = attrs.source || attrs.app_name || attrs.media_channel || "";
      if (title && source && String(title).toLowerCase() !== String(source).toLowerCase()) {
        return `${title} • ${source}`;
      }
      return title || source || "";
    }

    getRoomPlaybackStatus(room) {
      const speakers = this.getRoomSpeakers(room)
        .map((device) => {
          const entityId = device.entity_id || device.device_id || "";
          return {
            device,
            entityId,
            stateObj: entityId ? this._hass?.states?.[entityId] : null,
          };
        });
      const activePlayback = speakers.find((entry) => ["playing", "buffering"].includes(String(entry.stateObj?.state || "").toLowerCase()));
      if (activePlayback) {
        const summary = this.getMediaSummary(activePlayback.stateObj);
        return {
          tone: "playing",
          label: summary ? `Playing ${summary}` : "Playing",
        };
      }
      const available = speakers.find((entry) => entry.stateObj);
      if (!available) {
        return { tone: "unknown", label: "No speaker state" };
      }
      const state = String(available.stateObj.state || "").toLowerCase();
      const summary = this.getMediaSummary(available.stateObj);
      if (state === "paused" && summary) return { tone: "paused", label: `Paused ${summary}` };
      if (state === "paused") return { tone: "paused", label: "Paused" };
      if (["idle", "standby", "off"].includes(state)) return { tone: "idle", label: this.humanizeState(state) };
      if (["unavailable", "unknown"].includes(state)) return { tone: "unknown", label: this.humanizeState(state) };
      return { tone: "idle", label: summary ? `${this.humanizeState(state)} • ${summary}` : this.humanizeState(state) };
    }

    humanizeState(value) {
      const normalized = String(value || "").trim();
      if (!normalized) return "Unknown";
      return normalized.charAt(0).toUpperCase() + normalized.slice(1).replace(/_/g, " ");
    }

    renderRoomRow(room) {
      const speaker = this.getRoomSpeaker(room);
      const speakerId = speaker?.entity_id || speaker?.device_id || "";
      const speakerState = speakerId ? this._hass?.states?.[speakerId] : null;
      const volume = this.displayedVolume(speakerId, speakerState);
      const muted = Boolean(speakerState?.attributes?.is_volume_muted);
      const switchId = room.switch_entity_id || "";
      const switchOn = this.getRoomSwitchOn(room);
      const pending = this._pendingRoomToggles.has(switchId);
      const playback = this.getRoomPlaybackStatus(room);
      const speakerName = speaker?.friendly_name || speakerId || "No speaker";
      const statusLabel = `${speakerName} • ${playback.label}`;
      return `
        <div class="room-row ${switchOn ? "active" : "off"}">
          <div class="room-main">
            <span class="status-dot"></span>
            <div class="room-copy">
              <div class="room-title-line">
                <div class="room-name">${this.escapeHtml(room.name || "Room")}</div>
                <span class="ags-state-pill ${switchOn ? "on" : "off"}">${switchOn ? "On" : "Off"}</span>
              </div>
              <div class="room-status-line ${this.escapeHtml(playback.tone)}" title="${this.escapeHtml(statusLabel)}">
                <span class="playback-dot"></span>
                <span>${this.escapeHtml(statusLabel)}</span>
              </div>
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
      const sortedRooms = this.getSortedRooms(rooms);
      const activeSpeakers = Array.isArray(attrs.active_speakers) ? attrs.active_speakers : [];
      const groupMuted = activeSpeakers.length > 0 && activeSpeakers.every((id) => this._hass?.states?.[id]?.attributes?.is_volume_muted);
      const groupVolume = this.displayedVolume(this._entityId, stateObj);
      const themeClass = this.isDarkTheme() ? "theme-dark" : "theme-light";
      this.shadowRoot.innerHTML = `
        <style>
          :host { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); pointer-events: auto; touch-action: none; }
          .backdrop {
            position: absolute;
            inset: 0;
            background:
              radial-gradient(circle at 50% 18%, rgba(255, 255, 255, .10), transparent 34%),
              rgba(3, 7, 18, .34);
            pointer-events: auto;
            backdrop-filter: blur(4px) saturate(1.08);
            -webkit-backdrop-filter: blur(4px) saturate(1.08);
          }
          ha-card {
            position: relative;
            width: min(520px, calc(100vw - 32px));
            max-height: min(720px, calc(100vh - 48px));
            overflow: auto;
            padding: 20px;
            box-sizing: border-box;
            border-radius: 22px;
            backdrop-filter: blur(24px) saturate(1.18);
            -webkit-backdrop-filter: blur(24px) saturate(1.18);
          }
          ha-card.theme-dark {
            color: #f8fafc;
            --primary-text-color: #f8fafc;
            --secondary-text-color: rgba(226, 232, 240, .82);
            border: 1px solid rgba(255, 255, 255, .18);
            background:
              linear-gradient(180deg, rgba(255, 255, 255, .12), rgba(255, 255, 255, .04)),
              linear-gradient(135deg, color-mix(in srgb, var(--primary-color, #3498db) 14%, transparent), transparent 42%),
              rgba(13, 20, 31, .76);
            box-shadow: 0 28px 90px rgba(0, 0, 0, .42);
          }
          ha-card.theme-light {
            color: var(--primary-text-color, #111827);
            border: 1px solid rgba(15, 23, 42, .12);
            background:
              linear-gradient(180deg, rgba(255, 255, 255, .82), rgba(255, 255, 255, .68)),
              linear-gradient(135deg, color-mix(in srgb, var(--primary-color, #3498db) 12%, transparent), transparent 42%),
              rgba(255, 255, 255, .72);
            box-shadow: 0 28px 90px rgba(15, 23, 42, .22);
          }
          .head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
          .title { font-weight: 800; font-size: 1.15rem; }
          .sub { color: var(--secondary-text-color); font-size: .86rem; margin-top: 2px; }
          .icon-btn { width: 38px; height: 38px; border: 1px solid transparent; border-radius: 50%; background: transparent; color: inherit; display: inline-grid; place-items: center; cursor: pointer; }
          .icon-btn.active { color: #fff; background: color-mix(in srgb, var(--primary-color, #3498db) 44%, rgba(255, 255, 255, .10)); border-color: rgba(255, 255, 255, .16); }
          .icon-btn:disabled { opacity: .45; cursor: default; }
          .master, .volume-line { display: grid; grid-template-columns: minmax(0, 1fr) 46px; gap: 10px; align-items: center; }
          .master { grid-template-columns: 38px minmax(0, 1fr) 46px; margin-bottom: 16px; padding: 4px 0 18px; border-bottom: 1px solid var(--ags-room-popup-line); }
          .room-list { display: flex; flex-direction: column; gap: 10px; }
          .room-row {
            border: 1px solid var(--ags-room-popup-row-border);
            border-radius: 14px;
            padding: 11px 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            color: inherit;
            background: var(--ags-room-popup-row-bg);
            box-shadow: inset 0 1px 0 var(--ags-room-popup-row-highlight);
            backdrop-filter: blur(14px) saturate(1.12);
            -webkit-backdrop-filter: blur(14px) saturate(1.12);
          }
          ha-card.theme-dark {
            --ags-room-popup-line: rgba(255, 255, 255, .20);
            --ags-room-popup-row-border: rgba(255, 255, 255, .16);
            --ags-room-popup-row-bg: linear-gradient(180deg, rgba(255, 255, 255, .12), rgba(255, 255, 255, .07)), rgba(255, 255, 255, .06);
            --ags-room-popup-row-highlight: rgba(255, 255, 255, .08);
            --ags-room-popup-hover: rgba(255, 255, 255, .10);
            --ags-room-popup-muted: rgba(226, 232, 240, .82);
          }
          ha-card.theme-light {
            --ags-room-popup-line: rgba(15, 23, 42, .14);
            --ags-room-popup-row-border: rgba(15, 23, 42, .12);
            --ags-room-popup-row-bg: linear-gradient(180deg, rgba(255, 255, 255, .62), rgba(255, 255, 255, .42)), rgba(255, 255, 255, .34);
            --ags-room-popup-row-highlight: rgba(255, 255, 255, .70);
            --ags-room-popup-hover: rgba(15, 23, 42, .07);
            --ags-room-popup-muted: rgba(55, 65, 81, .74);
          }
          .room-row.off { opacity: .74; }
          .room-main { display: grid; grid-template-columns: 10px minmax(0, 1fr) 36px 36px; gap: 8px; align-items: center; }
          .status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--disabled-text-color, #999); }
          .room-row.active .status-dot { background: var(--success-color, #4caf50); }
          .room-copy { min-width: 0; display: grid; gap: 3px; }
          .room-title-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
          .room-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .ags-state-pill { flex: 0 0 auto; min-height: 18px; padding: 2px 7px; border-radius: 999px; font-size: .62rem; font-weight: 800; line-height: 1; display: inline-flex; align-items: center; text-transform: uppercase; letter-spacing: .02em; }
          .ags-state-pill.on { color: #fff; background: color-mix(in srgb, var(--success-color, #4caf50) 62%, rgba(255,255,255,.12)); }
          .ags-state-pill.off { color: var(--ags-room-popup-muted); background: var(--ags-room-popup-hover); }
          .room-status-line { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--ags-room-popup-muted); font-size: .78rem; font-weight: 650; line-height: 1.15; }
          .room-status-line span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .playback-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 6px; background: var(--ags-room-popup-muted); opacity: .64; }
          .room-status-line.playing { color: var(--primary-color, #3498db); }
          .room-status-line.playing .playback-dot { background: currentColor; opacity: 1; box-shadow: 0 0 10px currentColor; }
          .room-status-line.paused .playback-dot { background: #f59e0b; opacity: 1; }
          .icon-btn { color: inherit; }
          .close-btn:hover,
          .mute-btn:hover,
          .room-power:hover,
          .master-mute:hover { background: var(--ags-room-popup-hover); border-color: var(--ags-room-popup-row-border); }
          input[type="range"] { width: 100%; accent-color: var(--primary-color); }
          .empty { padding: 18px; text-align: center; color: var(--ags-room-popup-muted); }
        </style>
        <div class="backdrop"></div>
        <ha-card class="${themeClass}">
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
            ${sortedRooms.length ? sortedRooms.map((room) => this.renderRoomRow(room)).join("") : `<div class="empty">No AGS rooms are available.</div>`}
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
