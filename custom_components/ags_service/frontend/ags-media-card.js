class AgsMediaCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._section = "player";
    this._favoriteCatalog = [];
    this._favoriteBrowseKey = "";
  }

  setConfig(config) {
    this._config = {
      entity: "media_player.ags_media_player",
      sections: ["player", "favorites", "rooms", "volumes"],
      start_section: "player",
      ...config,
    };
    this._section = this._config.start_section || this._config.sections[0] || "player";
  }

  getCardSize() {
    return 6;
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config) {
      this.render();
    }
  }

  getAgsPlayer() {
    if (!this._hass || !this._config) {
      return null;
    }

    return (
      this._hass.states[this._config.entity] ||
      Object.values(this._hass.states).find(
        (stateObj) => stateObj?.attributes?.ags_status !== undefined,
      ) ||
      null
    );
  }

  getControlPlayer() {
    const ags = this.getAgsPlayer();
    const controlId =
      ags?.attributes?.control_device_id || ags?.attributes?.primary_speaker || null;
    return controlId && this._hass?.states?.[controlId] ? this._hass.states[controlId] : null;
  }

  escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  formatTime(totalSeconds) {
    const value = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const seconds = value % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  getLiveMediaPosition(player) {
    if (!player) {
      return 0;
    }

    const basePosition = Number(player.attributes.media_position || 0);
    const updatedAt = player.attributes.media_position_updated_at;
    const isPlaying = ["playing", "buffering"].includes(player.state);

    if (!updatedAt || !isPlaying) {
      return basePosition;
    }

    const updated = new Date(updatedAt).getTime();
    if (Number.isNaN(updated)) {
      return basePosition;
    }

    const deltaSeconds = (Date.now() - updated) / 1000;
    return basePosition + Math.max(0, deltaSeconds);
  }

  cycleRepeat(currentValue) {
    const order = ["off", "all", "one"];
    const index = order.indexOf(currentValue);
    return order[(index + 1) % order.length];
  }

  setSection(section) {
    this._section = section;
    this.render();
  }

  callMediaService(service, serviceData = {}) {
    const ags = this.getAgsPlayer();
    if (!ags) {
      return;
    }

    this._hass.callService("media_player", service, {
      entity_id: ags.entity_id,
      ...serviceData,
    });
  }

  toggleRoom(entityId) {
    if (!entityId || !this._hass?.states?.[entityId]) {
      return;
    }

    const current = this._hass.states[entityId];
    const service = current.state === "on" ? "turn_off" : "turn_on";
    this._hass.callService("switch", service, { entity_id: entityId });
  }

  setVolume(entityId, value) {
    if (!entityId) {
      return;
    }

    this._hass.callService("media_player", "volume_set", {
      entity_id: entityId,
      volume_level: Math.max(0, Math.min(1, Number(value) / 100)),
    });
  }

  openPortal() {
    window.history.pushState(null, "", "/ags-service");
    window.dispatchEvent(new Event("location-changed", { bubbles: true, composed: true }));
  }

  openMoreInfo(entityId) {
    if (!entityId) {
      return;
    }

    const event = new Event("hass-more-info", { bubbles: true, composed: true });
    event.detail = { entityId };
    this.dispatchEvent(event);
  }

  openPrimarySpeakerMoreInfo() {
    const control = this.getControlPlayer();
    this.openMoreInfo(control?.entity_id || this.getAgsPlayer()?.entity_id);
  }

  openBrowseTarget() {
    const control = this.getControlPlayer();
    if (control?.entity_id) {
      this.openMoreInfo(control.entity_id);
      return;
    }
    this.openPortal();
  }

  renderStatusPill(status) {
    const safeStatus = status || "OFF";
    const statusClass =
      safeStatus === "ON TV" ? "info" : safeStatus === "Override" ? "warn" : "active";
    return `<span class="status-pill ${statusClass}">${this.escapeHtml(safeStatus)}</span>`;
  }

  renderFooter(sections) {
    const iconMap = {
      player: "mdi:home",
      favorites: "mdi:star-outline",
      rooms: "mdi:speaker-multiple",
      volumes: "mdi:tune",
    };

    return `
      <div class="footer">
        ${sections
          .map(
            (section) => `
              <button
                class="footer-btn ${this._section === section ? "active" : ""}"
                title="${this.escapeHtml(section)}"
                aria-label="${this.escapeHtml(section)}"
                onclick="this.getRootNode().host.setSection('${section}')"
              >
                <ha-icon icon="${iconMap[section] || "mdi:view-grid-outline"}"></ha-icon>
              </button>
            `,
          )
          .join("")}
      </div>
    `;
  }

  getBrowseEntityId(ags) {
    return (
      ags?.attributes?.browse_entity_id ||
      ags?.attributes?.control_device_id ||
      ags?.attributes?.primary_speaker ||
      ags?.entity_id ||
      null
    );
  }

  collectBrowseMetadata(node, results = []) {
    if (!node || typeof node !== "object") {
      return results;
    }

    const thumbnail =
      node.thumbnail ||
      node.media_image_url ||
      node.media_image ||
      node.entity_picture ||
      "";

    if (node.title || node.media_content_id) {
      results.push({
        title: node.title || "",
        media_content_id: node.media_content_id || "",
        media_content_type: node.media_content_type || "",
        can_play: Boolean(node.can_play),
        can_expand: Boolean(node.can_expand),
        thumbnail,
      });
    }

    if (Array.isArray(node.children)) {
      node.children.forEach((child) => this.collectBrowseMetadata(child, results));
    }

    return results;
  }

  async ensureFavoriteCatalog(ags) {
    const browseEntityId = this.getBrowseEntityId(ags);
    const sources = this.toArray(ags?.attributes?.ags_sources);
    const key = `${browseEntityId || "none"}::${sources.map((source) => `${source.name}|${source.value}`).join("||")}`;

    if (!browseEntityId || key === this._favoriteBrowseKey) {
      return;
    }

    this._favoriteBrowseKey = key;

    try {
      const result = await this._hass.callWS({
        type: "media_player/browse_media",
        entity_id: ags.entity_id,
      });
      this._favoriteCatalog = this.collectBrowseMetadata(result, []);
      this.render();
    } catch (_error) {
      this._favoriteCatalog = [];
      this.render();
    }
  }

  getFavoriteArtwork(source, fallbackPicture = "") {
    const match = this._favoriteCatalog.find(
      (item) =>
        (source.Source_Value && item.media_content_id === source.Source_Value) ||
        (source.name && item.title === source.name) ||
        (source.Source && item.title === source.Source),
    );

    return match?.thumbnail || fallbackPicture || "";
  }

  getSourceChoices(ags, details) {
    const agsSources = this.toArray(details.agsSources).map((source) => ({
      value: source.name,
      label: source.name,
      kind: "AGS Favorite",
    }));
    const seen = new Set(agsSources.map((source) => source.value));
    const nativeSources = this.toArray(ags.attributes.source_list)
      .filter((source) => source && !seen.has(source))
      .map((source) => ({
        value: source,
        label: source,
        kind: "Speaker Input",
      }));

    return [...agsSources, ...nativeSources];
  }

  renderPlayerSection(ags, control, details) {
    const activeSource = ags.attributes.source || ags.attributes.selected_source_name || "No source";
    const title = control?.attributes?.media_title || "No media selected";
    const subtitle =
      control?.attributes?.media_artist ||
      control?.attributes?.media_album_name ||
      control?.attributes?.media_channel ||
      "Choose a source to start playback";
    const picture =
      control?.attributes?.entity_picture || ags.attributes?.entity_picture || "";
    const duration = Number(control?.attributes?.media_duration || ags.attributes?.media_duration || 0);
    const position = this.getLiveMediaPosition(control || ags);
    const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
    const shuffle = Boolean(ags.attributes.shuffle);
    const repeat = ags.attributes.repeat || "off";
    const isPlaying = ["playing", "buffering"].includes(control?.state || ags.state);
    const activeRooms = this.toArray(details.roomDetails).filter((room) => room.active);
    const activeSpeakerCount = this.toArray(details.activeSpeakerStates).length;
    const groupVolume = Math.round((Number(ags.attributes.volume_level || 0) || 0) * 100);
    const sourceChoices = this.getSourceChoices(ags, details);
    const groupLabel =
      activeRooms.length > 0
        ? activeRooms.map((room) => room.name).join(" · ")
        : "No rooms included";
    const summaryLabel =
      activeSpeakerCount > 0
        ? `${activeSpeakerCount} speaker${activeSpeakerCount === 1 ? "" : "s"} grouped`
        : "No grouped speakers";

    return `
      <div class="player-section">
        <div class="player-container">
          <div class="panel player-header">
            <div class="player-meta">${this.escapeHtml(groupLabel)}</div>
            <div class="player-title">${this.escapeHtml(title)}</div>
            <div class="player-subtitle">${this.escapeHtml(subtitle)}</div>
            <div class="player-summary">
              ${this.renderStatusPill(ags.attributes.ags_status)}
              <span class="meta-pill">${this.escapeHtml(activeSource)}</span>
              <span class="meta-pill">${this.escapeHtml(summaryLabel)}</span>
            </div>
          </div>

          <div class="artwork-wrap">
            <div class="artwork-frame">
              ${
                picture
                  ? `<img class="artwork" src="${picture}" alt="${this.escapeHtml(title)}" />`
                  : `<div class="artwork fallback-art"><ha-icon icon="mdi:speaker-wireless"></ha-icon></div>`
              }
            </div>
          </div>

          <div class="panel controls-panel">
            <div class="progress-block">
              <div class="progress-track">
                <div class="progress-fill" style="width:${progress}%;"></div>
              </div>
              <div class="progress-meta">
                <span>${this.formatTime(position)}</span>
                <span>${duration > 0 ? this.formatTime(duration) : "--:--"}</span>
              </div>
            </div>

            <div class="controls">
              <button class="control-btn" onclick="this.getRootNode().host.setSection('favorites')">
                <ha-icon icon="mdi:star-outline"></ha-icon>
              </button>
              <button class="control-btn" onclick="this.getRootNode().host.callMediaService('media_previous_track')">
                <ha-icon icon="mdi:skip-previous"></ha-icon>
              </button>
              <button class="play-btn" onclick="this.getRootNode().host.callMediaService('media_play_pause')">
                <ha-icon icon="${isPlaying ? "mdi:pause" : "mdi:play"}"></ha-icon>
              </button>
              <button class="control-btn" onclick="this.getRootNode().host.callMediaService('media_next_track')">
                <ha-icon icon="mdi:skip-next"></ha-icon>
              </button>
              <button class="control-btn" onclick="this.getRootNode().host.openBrowseTarget()">
                <ha-icon icon="mdi:folder-music-outline"></ha-icon>
              </button>
            </div>

            <div class="toggle-row">
              <button class="soft-btn ${shuffle ? "active" : ""}" onclick="this.getRootNode().host.callMediaService('shuffle_set', { shuffle: ${!shuffle} })">
                <ha-icon icon="mdi:shuffle"></ha-icon>
              </button>
              <button class="soft-btn ${repeat !== "off" ? "active" : ""}" onclick="this.getRootNode().host.callMediaService('repeat_set', { repeat: '${this.cycleRepeat(repeat)}' })">
                <ha-icon icon="${repeat === "one" ? "mdi:repeat-once" : "mdi:repeat"}"></ha-icon>
              </button>
              <button class="soft-btn" onclick="this.getRootNode().host.openPrimarySpeakerMoreInfo()">
                <ha-icon icon="mdi:dots-horizontal-circle-outline"></ha-icon>
              </button>
              <button class="soft-btn" onclick="this.getRootNode().host.setSection('rooms')">
                <ha-icon icon="mdi:speaker-multiple"></ha-icon>
              </button>
              <button class="soft-btn" onclick="this.getRootNode().host.setSection('volumes')">
                <ha-icon icon="mdi:volume-high"></ha-icon>
              </button>
            </div>

            <div class="picker-grid">
              <label class="picker-field">
                <span class="mini-label">Source</span>
                <select
                  class="picker-select"
                  onchange='this.getRootNode().host.callMediaService("select_source", { source: this.value })'
                >
                  ${sourceChoices
                    .map(
                      (source) => `
                        <option value="${this.escapeHtml(source.value)}" ${source.value === activeSource ? "selected" : ""}>
                          ${this.escapeHtml(source.label)}${source.kind ? ` · ${this.escapeHtml(source.kind)}` : ""}
                        </option>
                      `,
                    )
                    .join("")}
                </select>
              </label>

              <div class="compact-stat">
                <span class="mini-label">Rooms</span>
                <div class="compact-value">${activeRooms.length || 0}</div>
                <div class="compact-help">${this.escapeHtml(groupLabel)}</div>
              </div>

              <div class="compact-stat">
                <span class="mini-label">Group Volume</span>
                <div class="compact-value">${groupVolume}%</div>
                <div class="compact-help">${this.escapeHtml(summaryLabel)}</div>
              </div>
            </div>

            <div class="volume-inline compact-volume">
              <span class="mini-label">Volume</span>
              <input
                class="volume-slider"
                type="range"
                min="0"
                max="100"
                value="${groupVolume}"
                onchange="this.getRootNode().host.setVolume('${ags.entity_id}', this.value)"
              />
              <span class="volume-value">${groupVolume}%</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderRoomsSection(details) {
    const rooms = this.toArray(details.roomDetails);

    return `
      <div class="stack-section">
        ${
          rooms.length
            ? rooms
                .map(
                  (room) => `
                    <div class="list-card">
                      <div class="list-head">
                        <div class="list-copy">
                          <div class="list-title">${this.escapeHtml(room.name)}</div>
                          <div class="list-subtitle">
                            ${this.escapeHtml(
                              `${this.toArray(room.devices).length} device${this.toArray(room.devices).length === 1 ? "" : "s"}${room.tv_active ? " · TV active" : ""}`,
                            )}
                          </div>
                        </div>
                        <button
                          class="toggle-btn ${room.active ? "active" : ""}"
                          ${room.switch_entity_id ? "" : "disabled"}
                          onclick="this.getRootNode().host.toggleRoom('${room.switch_entity_id || ""}')"
                        >
                          ${room.active ? "Included" : "Off"}
                        </button>
                      </div>
                      <div class="chip-row">
                        ${this.toArray(room.devices)
                          .map(
                            (device) => `
                              <span class="meta-pill ${device.active ? "active" : ""}">
                                ${this.escapeHtml(device.friendly_name || device.entity_id)}
                              </span>
                            `,
                          )
                          .join("")}
                      </div>
                    </div>
                  `,
                )
                .join("")
            : '<div class="empty-state">No rooms are configured yet.</div>'
        }
      </div>
    `;
  }

  renderVolumesSection(ags, details) {
    const speakers = this.toArray(details.activeSpeakerStates);
    const groupVolume = Math.round((Number(ags.attributes.volume_level || 0) || 0) * 100);

    return `
      <div class="stack-section">
        <div class="list-card emphasis-card">
          <div class="list-head">
            <div class="list-copy">
              <div class="list-title">Whole Home Audio</div>
              <div class="list-subtitle">Shared level for the active AGS group</div>
            </div>
            <span class="value-pill">${groupVolume}%</span>
          </div>
          <input
            class="volume-slider"
            type="range"
            min="0"
            max="100"
            value="${groupVolume}"
            onchange="this.getRootNode().host.setVolume('${ags.entity_id}', this.value)"
          />
        </div>

        ${
          speakers.length
            ? speakers
                .map((speaker) => {
                  const level = Math.round((Number(speaker.attributes.volume_level || 0) || 0) * 100);
                  return `
                    <div class="list-card">
                      <div class="list-head">
                        <div class="list-copy">
                          <div class="list-title">${this.escapeHtml(
                            speaker.attributes.friendly_name || speaker.entity_id,
                          )}</div>
                          <div class="list-subtitle">${this.escapeHtml(speaker.state)}</div>
                        </div>
                        <span class="value-pill">${level}%</span>
                      </div>
                      <input
                        class="volume-slider"
                        type="range"
                        min="0"
                        max="100"
                        value="${level}"
                        onchange="this.getRootNode().host.setVolume('${speaker.entity_id}', this.value)"
                      />
                    </div>
                  `;
                })
                .join("")
            : '<div class="empty-state">No active speakers are available for individual volume control.</div>'
        }
      </div>
    `;
  }

  renderFavoritesSection(ags, details) {
    const agsSources = this.toArray(details.agsSources);
    const currentSource = ags.attributes.source || ags.attributes.selected_source_name || "";
    const configuredNames = new Set(agsSources.map((source) => source.name));
    const nativeSources = this.toArray(ags.attributes.source_list).filter(
      (sourceName) => !configuredNames.has(sourceName),
    );

    return `
      <div class="stack-section">
        <div class="list-card">
          <div class="list-head">
            <div class="list-copy">
              <div class="list-title">AGS Favorites</div>
              <div class="list-subtitle">Configured favorites with artwork-first launch cards</div>
            </div>
            <button class="link-btn" onclick="this.getRootNode().host.openPortal()">Portal</button>
          </div>
          <div class="favorites-grid">
            ${
              agsSources.length
                ? agsSources
                    .map(
                      (source) => {
                        const art = this.getFavoriteArtwork(source, ags.attributes.entity_picture || "");
                        return `
                        <button
                          class="favorite-card art-card ${source.name === currentSource ? "active" : ""}"
                          onclick='this.getRootNode().host.callMediaService("select_source", { source: ${JSON.stringify(source.name)} })'
                        >
                          <div class="favorite-art-shell">
                            <div class="favorite-blur" style="background-image:${art ? `url(${art})` : "none"};"></div>
                            <div class="favorite-cover">
                              ${
                                art
                                  ? `<img class="favorite-art" src="${art}" alt="${this.escapeHtml(source.name)}" />`
                                  : `<div class="favorite-art fallback-favorite"><ha-icon icon="mdi:star-outline"></ha-icon></div>`
                              }
                            </div>
                          </div>
                          <div class="favorite-copy">
                            <div class="favorite-name">${this.escapeHtml(source.name)}</div>
                            <div class="favorite-meta">${this.escapeHtml(
                              source.media_content_type || "source",
                            )}</div>
                          </div>
                        </button>
                      `;
                      },
                    )
                    .join("")
                : '<div class="empty-state compact">No AGS favorites configured yet.</div>'
            }
          </div>
        </div>

        <div class="list-card">
          <div class="list-head">
            <div class="list-copy">
              <div class="list-title">Speaker Inputs</div>
              <div class="list-subtitle">Native inputs exposed by the current control speaker</div>
            </div>
            <button class="link-btn" onclick="this.getRootNode().host.openBrowseTarget()">Browse</button>
          </div>
          <div class="chip-row">
            ${
              nativeSources.length
                ? nativeSources
                    .map(
                      (source) => `
                        <button
                          class="chip-btn ${source === currentSource ? "active" : ""}"
                          onclick='this.getRootNode().host.callMediaService("select_source", { source: ${JSON.stringify(source)} })'
                        >
                          ${this.escapeHtml(source)}
                        </button>
                      `,
                    )
                    .join("")
                : '<span class="empty-inline">No extra speaker inputs are available.</span>'
            }
          </div>
        </div>
      </div>
    `;
  }

  renderActiveSection(ags, control, details) {
    switch (this._section) {
      case "favorites":
        return this.renderFavoritesSection(ags, details);
      case "rooms":
        return this.renderRoomsSection(details);
      case "volumes":
        return this.renderVolumesSection(ags, details);
      default:
        return this.renderPlayerSection(ags, control, details);
    }
  }

  render() {
    const ags = this.getAgsPlayer();
    if (!ags) {
      this.shadowRoot.innerHTML = `<ha-card class="fallback-card">AGS media player not found.</ha-card>`;
      return;
    }

    const control = this.getControlPlayer();
    const picture = control?.attributes?.entity_picture || ags.attributes?.entity_picture || "";
    const sections = this.toArray(this._config.sections).length
      ? this.toArray(this._config.sections)
      : ["player", "favorites", "rooms", "volumes"];

    if (!sections.includes(this._section)) {
      this._section = sections[0];
    }

    const details = {
      agsSources: this.toArray(ags.attributes.ags_sources),
      roomDetails: this.toArray(ags.attributes.room_details),
      activeSpeakerStates: this.toArray(ags.attributes.active_speakers)
        .map((entityId) => this._hass.states[entityId])
        .filter(Boolean),
    };

    const dynamicTitle = ags.attributes.dynamic_title || "AGS Media System";
    const roomTitle = ags.attributes.primary_speaker_room || "No active room";
    this.ensureFavoriteCatalog(ags);

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          min-width: 0;
        }

        * {
          box-sizing: border-box;
        }

        ha-card {
          position: relative;
          overflow: hidden;
          border-radius: 22px;
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.08);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
        }

        .backdrop {
          position: absolute;
          inset: 0;
          background-image: ${picture ? `url(${picture})` : "none"};
          background-position: center;
          background-size: cover;
          filter: blur(36px) saturate(1.1);
          transform: scale(1.12);
          opacity: 0.14;
          pointer-events: none;
        }

        .surface {
          position: relative;
          z-index: 1;
          display: grid;
          grid-template-rows: auto 1fr auto;
          min-height: 100%;
        }

        .card-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 14px;
          padding: 16px 18px 8px;
        }

        .card-header > * {
          min-width: 0;
        }

        .card-kicker {
          color: var(--secondary-text-color);
          font-size: 0.78rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .card-title {
          margin-top: 6px;
          font-size: 1.1rem;
          font-weight: 700;
          line-height: 1.15;
          overflow-wrap: anywhere;
        }

        .card-subtitle {
          margin-top: 4px;
          color: var(--secondary-text-color);
          font-size: 0.92rem;
          overflow-wrap: anywhere;
        }

        .header-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }

        .icon-action,
        .control-btn,
        .play-btn,
        .soft-btn,
        .chip-btn,
        .toggle-btn,
        .favorite-card,
        .footer-btn {
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.1);
          background: rgba(var(--rgb-primary-text-color), 0.03);
          color: inherit;
          font: inherit;
          cursor: pointer;
          transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
        }

        .icon-action:hover,
        .control-btn:hover,
        .play-btn:hover,
        .soft-btn:hover,
        .chip-btn:hover,
        .toggle-btn:hover,
        .favorite-card:hover,
        .footer-btn:hover {
          border-color: rgba(var(--rgb-primary-color), 0.24);
          background: rgba(var(--rgb-primary-color), 0.08);
        }

        .icon-action {
          width: 42px;
          height: 42px;
          border-radius: 14px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }

        .section-body {
          padding: 8px 18px 18px;
          min-width: 0;
        }

        .panel,
        .list-card {
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.08);
          border-radius: 18px;
          background: rgba(var(--rgb-card-background-color, 255, 255, 255), 0.68);
          backdrop-filter: blur(14px) saturate(1.06);
        }

        .player-container {
          display: grid;
          grid-template-rows: min-content minmax(180px, 1fr) min-content;
          gap: 14px;
          min-height: 395px;
        }

        .player-header {
          padding: 14px 16px;
          text-align: center;
        }

        .player-meta {
          color: var(--secondary-text-color);
          font-size: 0.92rem;
          overflow-wrap: anywhere;
        }

        .player-title {
          margin-top: 8px;
          font-size: 1.55rem;
          line-height: 1.08;
          font-weight: 700;
          letter-spacing: -0.02em;
          overflow-wrap: anywhere;
        }

        .player-subtitle {
          margin-top: 6px;
          color: var(--secondary-text-color);
          font-size: 0.98rem;
          overflow-wrap: anywhere;
        }

        .player-summary,
        .chip-row,
        .toggle-row {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          justify-content: center;
        }

        .player-summary {
          margin-top: 12px;
        }

        .status-pill,
        .meta-pill,
        .value-pill {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          max-width: 100%;
          gap: 6px;
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.1);
          background: rgba(var(--rgb-primary-text-color), 0.04);
          font-size: 0.8rem;
          font-weight: 700;
          overflow-wrap: anywhere;
        }

        .status-pill.active,
        .meta-pill.active,
        .soft-btn.active,
        .chip-btn.active,
        .toggle-btn.active,
        .favorite-card.active,
        .footer-btn.active {
          color: var(--primary-color);
          border-color: rgba(var(--rgb-primary-color), 0.24);
          background: rgba(var(--rgb-primary-color), 0.12);
        }

        .status-pill.info {
          color: var(--info-color);
          border-color: rgba(var(--rgb-info-color, 3, 169, 244), 0.22);
          background: rgba(var(--rgb-info-color, 3, 169, 244), 0.1);
        }

        .status-pill.warn {
          color: var(--warning-color);
          border-color: rgba(var(--rgb-warning-color, 255, 152, 0), 0.22);
          background: rgba(var(--rgb-warning-color, 255, 152, 0), 0.1);
        }

        .artwork-wrap {
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 0;
          padding-inline: 10px;
        }

        .artwork-frame {
          width: min(100%, 260px);
          aspect-ratio: 1;
          border-radius: 20px;
          overflow: hidden;
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.08);
          background: rgba(var(--rgb-primary-text-color), 0.05);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
        }

        .artwork {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .fallback-art {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--secondary-text-color);
        }

        .fallback-art ha-icon {
          --mdc-icon-size: 72px;
        }

        .controls-panel {
          display: flex;
          flex-direction: column;
          gap: 14px;
          padding: 14px 16px;
        }

        .progress-block {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .progress-track {
          height: 7px;
          border-radius: 999px;
          overflow: hidden;
          background: rgba(var(--rgb-primary-text-color), 0.08);
        }

        .progress-fill {
          height: 100%;
          border-radius: inherit;
          background: linear-gradient(
            90deg,
            var(--primary-color),
            rgba(var(--rgb-primary-color), 0.55)
          );
        }

        .progress-meta {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          color: var(--secondary-text-color);
          font-size: 0.82rem;
        }

        .controls {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          flex-wrap: wrap;
        }

        .control-btn,
        .play-btn {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }

        .play-btn {
          width: 64px;
          height: 64px;
          background: var(--primary-color);
          color: var(--text-primary-color, #fff);
          border-color: var(--primary-color);
        }

        .control-btn ha-icon,
        .play-btn ha-icon,
        .icon-action ha-icon,
        .footer-btn ha-icon,
        .soft-btn ha-icon {
          --mdc-icon-size: 24px;
        }

        .soft-btn,
        .chip-btn,
        .toggle-btn {
          min-height: 38px;
          padding: 8px 12px;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-width: 0;
          overflow-wrap: anywhere;
        }

        .picker-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.5fr) repeat(2, minmax(0, 0.75fr));
          gap: 12px;
          align-items: stretch;
        }

        .picker-field,
        .compact-stat {
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-width: 0;
        }

        .picker-select {
          width: 100%;
          min-height: 44px;
          border-radius: 14px;
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.1);
          background: rgba(var(--rgb-primary-text-color), 0.04);
          color: var(--primary-text-color);
          padding: 10px 12px;
          font: inherit;
        }

        .compact-stat {
          padding: 10px 12px;
          border-radius: 16px;
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.08);
          background: rgba(var(--rgb-primary-text-color), 0.03);
          justify-content: center;
        }

        .compact-value {
          font-size: 1.15rem;
          font-weight: 700;
          line-height: 1;
        }

        .compact-help {
          color: var(--secondary-text-color);
          font-size: 0.8rem;
          overflow-wrap: anywhere;
        }

        .volume-inline {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          gap: 12px;
          align-items: center;
        }

        .mini-label,
        .mini-title,
        .list-subtitle,
        .favorite-meta,
        .empty-inline {
          color: var(--secondary-text-color);
        }

        .mini-label {
          font-size: 0.84rem;
          font-weight: 600;
        }

        .volume-value {
          font-weight: 700;
          font-size: 0.92rem;
        }

        .volume-slider {
          width: 100%;
          accent-color: var(--primary-color);
        }

        .mini-block {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .compact-volume {
          margin-top: 2px;
        }

        .mini-head,
        .list-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .mini-head > *,
        .list-head > * {
          min-width: 0;
        }

        .link-btn {
          border: 0;
          background: transparent;
          color: var(--primary-color);
          font: inherit;
          font-weight: 700;
          cursor: pointer;
          padding: 0;
        }

        .stack-section {
          display: flex;
          flex-direction: column;
          gap: 12px;
          min-width: 0;
        }

        .list-card {
          padding: 14px 16px;
        }

        .list-copy {
          min-width: 0;
        }

        .list-title,
        .favorite-name {
          font-size: 1rem;
          font-weight: 700;
          overflow-wrap: anywhere;
        }

        .list-subtitle,
        .favorite-meta {
          margin-top: 4px;
          font-size: 0.84rem;
          overflow-wrap: anywhere;
        }

        .emphasis-card {
          background: rgba(var(--rgb-primary-color), 0.08);
          border-color: rgba(var(--rgb-primary-color), 0.18);
        }

        .favorites-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 10px;
          margin-top: 12px;
        }

        .favorite-card {
          border-radius: 16px;
          padding: 12px;
          text-align: left;
          min-width: 0;
        }

        .art-card {
          position: relative;
          overflow: hidden;
          padding: 0;
          display: flex;
          flex-direction: column;
          min-height: 230px;
          background: rgba(var(--rgb-primary-text-color), 0.04);
        }

        .favorite-art-shell {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 148px;
          overflow: hidden;
        }

        .favorite-blur {
          position: absolute;
          inset: 0;
          background-position: center;
          background-size: cover;
          filter: blur(22px) saturate(1.14);
          transform: scale(1.12);
          opacity: 0.28;
        }

        .favorite-cover {
          position: relative;
          z-index: 1;
          width: 112px;
          height: 112px;
          border-radius: 18px;
          overflow: hidden;
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.1);
          background: rgba(var(--rgb-primary-text-color), 0.05);
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.12);
        }

        .favorite-art {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .favorite-copy {
          position: relative;
          z-index: 1;
          padding: 0 14px 14px;
        }

        .fallback-favorite {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
          color: var(--secondary-text-color);
        }

        .fallback-favorite ha-icon {
          --mdc-icon-size: 36px;
        }

        .empty-state {
          padding: 24px 18px;
          border-radius: 18px;
          border: 1px dashed rgba(var(--rgb-primary-text-color), 0.16);
          color: var(--secondary-text-color);
          text-align: center;
        }

        .empty-state.compact {
          padding: 16px 14px;
        }

        .footer {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 14px 14px;
          border-top: 1px solid rgba(var(--rgb-primary-text-color), 0.08);
        }

        .footer-btn {
          flex: 1 1 0;
          height: 44px;
          border-radius: 14px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }

        .fallback-card {
          padding: 20px;
        }

        .chip-btn[disabled],
        .toggle-btn[disabled] {
          cursor: default;
          opacity: 0.55;
        }

        @media (max-width: 640px) {
          .card-header,
          .section-body,
          .footer {
            padding-left: 14px;
            padding-right: 14px;
          }

          .card-header,
          .header-actions,
          .mini-head,
          .list-head {
            flex-direction: column;
            align-items: stretch;
          }

          .header-actions {
            justify-content: flex-start;
          }

          .picker-grid,
          .volume-inline {
            grid-template-columns: 1fr;
          }

          .player-container {
            min-height: 0;
          }

          .player-title {
            font-size: 1.32rem;
          }

          .artwork-frame {
            width: min(100%, 220px);
          }

          .favorites-grid {
            grid-template-columns: 1fr;
          }

          .footer-btn {
            min-width: 0;
          }
        }
      </style>

      <ha-card>
        <div class="backdrop"></div>
        <div class="surface">
          <div class="card-header">
            <div>
              <div class="card-kicker">AGS Dashboard</div>
              <div class="card-title">${this.escapeHtml(dynamicTitle)}</div>
              <div class="card-subtitle">${this.escapeHtml(roomTitle)}</div>
            </div>
            <div class="header-actions">
              <button class="icon-action" title="Player info" onclick="this.getRootNode().host.openPrimarySpeakerMoreInfo()">
                <ha-icon icon="mdi:playlist-music"></ha-icon>
              </button>
              <button class="icon-action" title="Open portal" onclick="this.getRootNode().host.openPortal()">
                <ha-icon icon="mdi:cog-outline"></ha-icon>
              </button>
            </div>
          </div>

          <div class="section-body">
            ${this.renderActiveSection(ags, control, details)}
          </div>

          ${this.renderFooter(sections)}
        </div>
      </ha-card>
    `;
  }
}

if (!customElements.get("ags-media-card")) {
  customElements.define("ags-media-card", AgsMediaCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.find((card) => card.type === "ags-media-card")) {
  window.customCards.push({
    type: "ags-media-card",
    name: "AGS Media Card",
    description: "Sonos-style AGS dashboard card for whole-home audio control.",
    preview: true,
  });
}
