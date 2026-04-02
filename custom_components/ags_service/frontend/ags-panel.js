class AGSPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this.config = null;
    this.logs = [];
    this.activeTab = "home";
    this.selectedRoomIdx = 0;
    this.loading = false;
    this.error = "";
    this.discoveredFavorites = [];
    this.favoriteBrowseError = "";
    this.browseItems = [];
    this.browsePath = [];
    this.editingDeviceKey = null;
  }

  set hass(hass) {
    const oldHass = this._hass;
    this._hass = hass;

    if (!oldHass && hass) {
      this.initData();
      return;
    }

    if (hass && this.config) {
      this.render();
    }
  }

  get hass() {
    return this._hass;
  }

  async initData() {
    if (!this.hass) {
      return;
    }

    this.loading = true;
    this.error = "";
    this.render();

    try {
      const [config, logs] = await Promise.all([
        this.hass.callWS({ type: "ags_service/config/get" }),
        this.hass.callWS({ type: "ags_service/get_logs" }),
      ]);
      this.config = this.normalizeConfig(config);
      this.logs = Array.isArray(logs) ? logs : [];
      this.ensureRoomSelection();
    } catch (error) {
      this.error = error.message || String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  normalizeConfig(config) {
    const normalizeEntityValue = (value) => {
      const text = String(value || "").trim();
      if (!text) {
        return "";
      }
      return /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(text) ? text : "";
    };

    const normalized = {
      rooms: Array.isArray(config?.rooms) ? config.rooms : [],
      Sources: Array.isArray(config?.Sources) ? config.Sources : [],
      disable_zone: Boolean(config?.disable_zone),
      homekit_player: normalizeEntityValue(config?.homekit_player || ""),
      create_sensors: config?.create_sensors !== false,
      default_on: Boolean(config?.default_on),
      static_name: config?.static_name || "",
      disable_Tv_Source: Boolean(config?.disable_Tv_Source),
      schedule_entity: config?.schedule_entity || null,
      default_source_schedule: config?.default_source_schedule || null,
      batch_unjoin: Boolean(config?.batch_unjoin),
    };

    normalized.rooms = normalized.rooms.map((room) => ({
      room: room?.room || "New Room",
      devices: Array.isArray(room?.devices)
        ? room.devices.map((device) => {
            const normalizedDevice = {
              device_id: normalizeEntityValue(device?.device_id || ""),
              device_type: device?.device_type || "speaker",
              priority: Number.isFinite(device?.priority) ? device.priority : 1,
              override_content: device?.override_content || "",
              source_overrides: Array.isArray(device?.source_overrides)
                ? device.source_overrides.map((override) => {
                    const normalizedOverride = {
                      source_name: override?.source_name || "",
                      mode: override?.mode || "source",
                      run_when_tv_off: Boolean(override?.run_when_tv_off),
                    };
                    if (normalizedOverride.mode === "script") {
                      const scriptEntity = normalizeEntityValue(
                        override?.script_entity || "",
                      );
                      if (scriptEntity) {
                        normalizedOverride.script_entity = scriptEntity;
                      }
                    } else {
                      normalizedOverride.source_value = override?.source_value || "";
                    }
                    return normalizedOverride;
                  })
                : [],
            };

            if (normalizedDevice.device_type === "tv") {
              normalizedDevice.tv_mode = device?.tv_mode || "tv_audio";
              const ottDevice = normalizeEntityValue(device?.ott_device || "");
              if (ottDevice) {
                normalizedDevice.ott_device = ottDevice;
              }
              normalizedDevice.ott_devices = Array.isArray(device?.ott_devices)
                ? device.ott_devices
                    .map((mapping) => ({
                      ott_device: normalizeEntityValue(mapping?.ott_device || ""),
                      tv_input: mapping?.tv_input || "",
                    }))
                    .filter((mapping) => mapping.ott_device || mapping.tv_input)
                : [];
            }

            return normalizedDevice;
          })
        : [],
    }));

    normalized.schedule_entity =
      normalized.schedule_entity && normalizeEntityValue(normalized.schedule_entity.entity_id)
        ? {
            entity_id: normalizeEntityValue(normalized.schedule_entity.entity_id),
            on_state: normalized.schedule_entity.on_state || "on",
            off_state: normalized.schedule_entity.off_state || "off",
            schedule_override: Boolean(normalized.schedule_entity.schedule_override),
          }
        : null;

    normalized.default_source_schedule =
      normalized.default_source_schedule &&
      normalizeEntityValue(normalized.default_source_schedule.entity_id)
        ? {
            entity_id: normalizeEntityValue(normalized.default_source_schedule.entity_id),
            source_name: normalized.default_source_schedule.source_name || "",
            on_state: normalized.default_source_schedule.on_state || "on",
          }
        : null;

    normalized.Sources = normalized.Sources.map((source) => ({
      Source: source?.Source || "",
      Source_Value: source?.Source_Value || "",
      media_content_type: source?.media_content_type || "favorite_item_id",
      source_default: Boolean(source?.source_default),
    }));

    return normalized;
  }

  ensureRoomSelection() {
    const roomCount = this.config?.rooms?.length || 0;
    if (!roomCount) {
      this.selectedRoomIdx = 0;
      return;
    }
    this.selectedRoomIdx = Math.min(this.selectedRoomIdx, roomCount - 1);
    this.selectedRoomIdx = Math.max(this.selectedRoomIdx, 0);
  }

  getAgsState() {
    if (!this.hass) {
      return null;
    }

    return (
      this.hass.states["media_player.ags_media_player"] ||
      Object.values(this.hass.states).find(
        (stateObj) => stateObj?.attributes?.ags_status !== undefined,
      ) ||
      null
    );
  }

  escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  slugify(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
  }

  setTab(tab) {
    this.activeTab = tab;
    this.render();
  }

  updateConfig(path, value) {
    if (!this.config || !path) {
      return;
    }

    const parts = path.split(".");
    let obj = this.config;

    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      const nextPart = parts[index + 1];

      if (obj[part] === undefined || obj[part] === null) {
        obj[part] = /^\d+$/.test(nextPart) ? [] : {};
      }

      obj = obj[part];
    }

    obj[parts[parts.length - 1]] = value;
  }

  removeAt(path, index) {
    const target = this.resolvePath(path);
    if (Array.isArray(target)) {
      target.splice(index, 1);
      this.ensureRoomSelection();
      this.render();
    }
  }

  resolvePath(path) {
    return path.split(".").reduce((acc, part) => acc?.[part], this.config);
  }

  ensureScheduleEntity() {
    if (!this.config.schedule_entity) {
      this.config.schedule_entity = {
        entity_id: "",
        on_state: "on",
        off_state: "off",
        schedule_override: false,
      };
    }
  }

  ensureDefaultSourceSchedule() {
    if (!this.config.default_source_schedule) {
      this.config.default_source_schedule = {
        entity_id: "",
        source_name: "",
        on_state: "on",
      };
    }
  }

  addRoom() {
    this.config.rooms.push({
      room: `Room ${this.config.rooms.length + 1}`,
      devices: [],
    });
    this.selectedRoomIdx = this.config.rooms.length - 1;
    this.render();
  }

  deleteRoom(index) {
    if (!window.confirm("Delete this room?")) {
      return;
    }
    this.config.rooms.splice(index, 1);
    this.ensureRoomSelection();
    this.render();
  }

  addDevice(roomIndex) {
    this.config.rooms[roomIndex].devices.push({
      device_id: "",
      device_type: "speaker",
      priority: 1,
      tv_mode: "tv_audio",
      ott_device: "",
      ott_devices: [],
      override_content: "",
      source_overrides: [],
    });
    this.render();
  }

  setEditingDevice(key) {
    this.editingDeviceKey = this.editingDeviceKey === key ? null : key;
    this.render();
  }

  addOttMapping(roomIndex, deviceIndex) {
    const device = this.config.rooms[roomIndex].devices[deviceIndex];
    if (!Array.isArray(device.ott_devices)) {
      device.ott_devices = [];
    }
    device.ott_devices.push({ ott_device: "", tv_input: "" });
    this.render();
  }

  addOverride(roomIndex, deviceIndex) {
    const device = this.config.rooms[roomIndex].devices[deviceIndex];
    if (!Array.isArray(device.source_overrides)) {
      device.source_overrides = [];
    }
    device.source_overrides.push({
      source_name: "",
      mode: "source",
      source_value: "",
      script_entity: "",
      run_when_tv_off: false,
    });
    this.render();
  }

  addSource() {
    this.config.Sources.push({
      Source: "",
      Source_Value: "",
      media_content_type: "favorite_item_id",
      source_default: false,
    });
    this.render();
  }

  async fetchLogs() {
    try {
      this.logs = await this.hass.callWS({ type: "ags_service/get_logs" });
      this.render();
    } catch (error) {
      // no-op, the logs panel is optional
      // eslint-disable-next-line no-console
      console.error(error);
    }
  }

  async saveConfig() {
    if (!this.hass || !this.config) {
      return;
    }

    try {
      await this.hass.callWS({
        type: "ags_service/config/save",
        config: this.normalizeConfig(this.config),
      });
      this.hass.callService("persistent_notification", "create", {
        title: "AGS Service",
        message: "Settings saved and reloaded.",
      });
      await this.initData();
    } catch (error) {
      this.error = error.message || String(error);
      this.render();
    }
  }

  bindEntityPickers() {
    this.shadowRoot.querySelectorAll("ha-entity-picker").forEach((picker) => {
      picker.hass = this.hass;
      const includeDomains = picker.getAttribute("include-domains");
      if (includeDomains) {
        try {
          picker.includeDomains = JSON.parse(includeDomains);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error("Failed to parse include-domains", error);
        }
      }
      picker.allowCustomEntity = true;
      picker.clearable = true;
      const value = picker.getAttribute("data-value") || "";
      picker.value = value;
      if (picker.__agsBound) {
        return;
      }
      picker.__agsBound = true;
      picker.addEventListener("value-changed", (event) => {
        const path = picker.getAttribute("data-path");
        if (!path) {
          return;
        }
        const nextValue = String(event.detail?.value || "").trim();
        const sanitized =
          nextValue.toLowerCase() === "entity id" || nextValue.toLowerCase() === "choose entity"
            ? ""
            : nextValue;
        this.updateConfig(path, sanitized);
      });
    });
  }

  bindEmbeddedDashboard() {
    const dashboard = this.shadowRoot.querySelector(".embedded-dashboard");
    if (!dashboard || typeof dashboard.setConfig !== "function") {
      return;
    }

    dashboard.setConfig({
      entity: "media_player.ags_media_player",
      sections: ["player", "favorites", "rooms", "volumes"],
      start_section: "player",
    });
    dashboard.hass = this.hass;
  }

  renderEntityField(label, path, value, domains = ["media_player"], options = {}) {
    const encodedValue = this.escapeHtml(value || "");
    const encodedLabel = this.escapeHtml(label);
    const encodedDomains = this.escapeHtml(JSON.stringify(domains));
    const helper = options.helper
      ? `<div class="entity-helper">${this.escapeHtml(options.helper)}</div>`
      : "";

    return `
      <div>
        <label>${encodedLabel}</label>
        <div class="entity-field">
          <ha-entity-picker
            data-path="${this.escapeHtml(path)}"
            data-value="${encodedValue}"
            include-domains='${encodedDomains}'
          ></ha-entity-picker>
          <input
            type="text"
            class="entity-fallback"
            placeholder="Or enter entity_id manually"
            value="${encodedValue}"
            onchange="this.getRootNode().host.updateConfig('${this.escapeHtml(path)}', this.value)"
          />
        </div>
        ${helper}
      </div>
    `;
  }

  getBrowseEntityId() {
    const ags = this.getAgsState();
    if (ags?.entity_id && this.hass.states[ags.entity_id]) {
      return ags.entity_id;
    }
    const control = ags?.attributes?.control_device_id;
    if (control && this.hass.states[control]) {
      return control;
    }
    const primary = ags?.attributes?.primary_speaker;
    if (primary && this.hass.states[primary]) {
      return primary;
    }
    return ags?.entity_id || null;
  }

  mergeSources(sourceEntries) {
    const existingKeys = new Set(
      this.config.Sources.map((entry) => `${entry.Source}::${entry.Source_Value}`),
    );
    let added = 0;

    sourceEntries.forEach((entry) => {
      const normalized = {
        Source: entry.Source || "",
        Source_Value: entry.Source_Value || "",
        media_content_type: entry.media_content_type || "music",
        source_default: false,
      };
      const key = `${normalized.Source}::${normalized.Source_Value}`;
      if (!normalized.Source || !normalized.Source_Value || existingKeys.has(key)) {
        return;
      }
      existingKeys.add(key);
      this.config.Sources.push(normalized);
      added += 1;
    });

    this.render();
    return added;
  }

  collectPlayableBrowseItems(node, results = []) {
    if (!node || typeof node !== "object") {
      return results;
    }

    if (node.can_play && node.title && node.media_content_id) {
      results.push({
        Source: node.title,
        Source_Value: node.media_content_id,
        media_content_type: node.media_content_type || "music",
      });
    }

    if (Array.isArray(node.children)) {
      node.children.forEach((child) => this.collectPlayableBrowseItems(child, results));
    }

    return results;
  }

  async importSpeakerSourceList() {
    const entityId = this.getBrowseEntityId();
    if (!entityId) {
      this.favoriteBrowseError = "No active speaker is available for source import.";
      this.render();
      return;
    }

    const state = this.hass.states[entityId];
    const sourceList = Array.isArray(state?.attributes?.source_list)
      ? state.attributes.source_list
      : [];

    const added = this.mergeSources(
      sourceList
        .filter((source) => source && source !== "TV")
        .map((source) => ({
          Source: source,
          Source_Value: source,
          media_content_type: "music",
        })),
    );

    this.favoriteBrowseError = added
      ? ""
      : "No new speaker inputs were found to import.";
    this.render();
  }

  async browseMediaFavorites() {
    const entityId = this.getBrowseEntityId();
    if (!entityId) {
      this.favoriteBrowseError = "No active speaker is available for media browsing.";
      this.render();
      return;
    }

    this.favoriteBrowseError = "";
    this.discoveredFavorites = [];
    this.browseItems = [];
    this.browsePath = [];
    this.render();

    try {
      await this.loadBrowseNode();
    } catch (error) {
      this.favoriteBrowseError = error.message || "Browse media request failed.";
    }

    this.render();
  }

  async loadBrowseNode(node = null) {
    const entityId = this.getBrowseEntityId();
    if (!entityId) {
      throw new Error("No active speaker is available for media browsing.");
    }

    const payload = {
      type: "media_player/browse_media",
      entity_id: entityId,
    };

    if (node?.media_content_type) {
      payload.media_content_type = node.media_content_type;
    }
    if (node?.media_content_id) {
      payload.media_content_id = node.media_content_id;
    }

    const result = await this.hass.callWS(payload);
    const children = Array.isArray(result?.children) ? result.children : [];
    this.browseItems = children;
    this.discoveredFavorites = this.collectPlayableBrowseItems({ children });

    if (!children.length && !this.discoveredFavorites.length) {
      this.favoriteBrowseError = "Browse media returned no folders or playable items.";
    } else {
      this.favoriteBrowseError = "";
    }
  }

  async openBrowseItem(index) {
    const item = this.browseItems[index];
    if (!item) {
      return;
    }

    if (item.can_expand) {
      this.browsePath.push({
        title: item.title,
        media_content_id: item.media_content_id,
        media_content_type: item.media_content_type,
      });
      try {
        await this.loadBrowseNode(item);
      } catch (error) {
        this.favoriteBrowseError = error.message || "Failed to open media folder.";
      }
      this.render();
      return;
    }

    if (item.can_play) {
      const added = this.mergeSources([
        {
          Source: item.title,
          Source_Value: item.media_content_id,
          media_content_type: item.media_content_type || "music",
        },
      ]);
      if (!added) {
        this.favoriteBrowseError = "That media item is already in your AGS source list.";
        this.render();
      }
    }
  }

  async browseBack() {
    if (!this.browsePath.length) {
      this.browseItems = [];
      this.favoriteBrowseError = "";
      this.render();
      return;
    }

    this.browsePath.pop();
    const previous = this.browsePath[this.browsePath.length - 1] || null;
    try {
      await this.loadBrowseNode(previous);
    } catch (error) {
      this.favoriteBrowseError = error.message || "Failed to load previous media folder.";
    }
    this.render();
  }

  addBrowsedFavorite(index) {
    const favorite = this.discoveredFavorites[index];
    if (!favorite) {
      return;
    }

    const added = this.mergeSources([favorite]);
    if (!added) {
      this.favoriteBrowseError = "That favorite is already in your AGS source list.";
      this.render();
    }
  }

  renderStatusPill(status) {
    const safeStatus = this.escapeHtml(status || "OFF");
    return `<span class="status-pill status-${safeStatus.toLowerCase().replace(/[^a-z]+/g, "-")}">${safeStatus}</span>`;
  }

  renderTonePill(label, tone = "neutral") {
    return `<span class="tone-pill tone-${this.escapeHtml(tone)}">${this.escapeHtml(label)}</span>`;
  }

  renderDiagnostics(agsState) {
    const attributes = agsState?.attributes || {};
    const activeRooms = Array.isArray(attributes.active_rooms) ? attributes.active_rooms : [];
    const activeSpeakers = Array.isArray(attributes.active_speakers)
      ? attributes.active_speakers
      : [];
    const configuredRooms = Array.isArray(attributes.configured_rooms)
      ? attributes.configured_rooms
      : [];
    const roomDiagnostics = Array.isArray(attributes.room_diagnostics)
      ? attributes.room_diagnostics
      : [];
    const logicFlags = Array.isArray(attributes.logic_flags) ? attributes.logic_flags : [];
    const speakerCandidates = Array.isArray(attributes.speaker_candidates)
      ? attributes.speaker_candidates
      : [];
    const master = attributes.primary_speaker || "No primary speaker";
    const dynamicTitle = attributes.dynamic_title || "AGS Media System";
    const includedCount = roomDiagnostics.filter((room) => room.included).length;
    const skippedCount = roomDiagnostics.filter((room) => room.state === "skipped").length;
    const blockedCount = roomDiagnostics.filter((room) => room.state === "blocked").length;
    const waitingCount = roomDiagnostics.filter((room) => room.state === "waiting").length;

    return `
      <div class="grid cols-2">
        <section class="panel-card hero-card">
          <div class="eyebrow">Diagnostics</div>
          <div class="hero-line">
            ${this.renderStatusPill(attributes.ags_status)}
            <span class="hero-title">${this.escapeHtml(dynamicTitle)}</span>
          </div>
          <div class="metric-grid">
            <div class="metric-card">
              <div class="metric-label">Primary Speaker</div>
              <div class="metric-value">${this.escapeHtml(master)}</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Active Rooms</div>
              <div class="metric-value">${activeRooms.length}</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Grouped Speakers</div>
              <div class="metric-value">${activeSpeakers.length}</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Configured Rooms</div>
              <div class="metric-value">${configuredRooms.length}</div>
            </div>
          </div>
          <div class="chip-row">
            ${activeRooms.length
              ? activeRooms
                  .map((room) => `<span class="chip">${this.escapeHtml(room)}</span>`)
                  .join("")
              : '<span class="muted">No rooms are currently active.</span>'}
          </div>
        </section>

        <section class="panel-card">
          <div class="card-head">
            <div>
              <div class="eyebrow">Selection</div>
              <h3>Current primary and active scope</h3>
            </div>
          </div>
          <div class="stack">
            <div class="logic-flag-card">
              <div class="logic-flag-head">
                <span class="list-title">Primary speaker</span>
                ${this.renderTonePill(master, master && master !== "none" ? "good" : "warn")}
              </div>
              <div class="list-subtitle">AGS currently routes control through the selected master device.</div>
            </div>
            <div class="logic-flag-card">
              <div class="logic-flag-head">
                <span class="list-title">Included rooms</span>
                ${this.renderTonePill(String(includedCount), "info")}
              </div>
              <div class="list-subtitle">Active room switches that are currently participating in AGS.</div>
            </div>
            <div class="logic-flag-card">
              <div class="logic-flag-head">
                <span class="list-title">Grouped speakers</span>
                ${this.renderTonePill(String(activeSpeakers.length), activeSpeakers.length ? "good" : "neutral")}
              </div>
              <div class="list-subtitle">Speakers actively being managed as part of the current session.</div>
            </div>
          </div>
        </section>
      </div>

      <div class="grid cols-2 diagnostics-grid">
        <section class="panel-card">
          <div class="card-head">
            <div>
              <div class="eyebrow">Room Logic</div>
              <h3>Why rooms are included, skipped, or waiting</h3>
            </div>
          </div>
          <div class="chip-row">
            <span class="chip">${includedCount} included</span>
            <span class="chip">${skippedCount} skipped</span>
            <span class="chip">${blockedCount} blocked</span>
            <span class="chip">${waitingCount} waiting</span>
          </div>
          <div class="stack">
            ${roomDiagnostics.length
              ? roomDiagnostics
                  .map((room) => {
                    return `
                      <div class="diagnostic-card">
                        <div>
                          <div class="list-title">${this.escapeHtml(room.name)}</div>
                          <div class="list-subtitle">${this.escapeHtml(room.reason)}</div>
                        </div>
                        <div class="diag-meta">
                          ${this.renderTonePill(room.state, room.tone)}
                          <span class="pill ${room.switch_on ? "pill-on" : ""}">
                            ${room.switch_on ? "SWITCH ON" : "SWITCH OFF"}
                          </span>
                        </div>
                        <div class="diagnostic-subrow">
                          <span>${room.device_count} device(s)</span>
                          <span>${room.speaker_count} speaker(s)</span>
                          ${room.active_tv_names?.length ? `<span>TV: ${this.escapeHtml(room.active_tv_names.join(", "))}</span>` : ""}
                        </div>
                      </div>
                    `;
                  })
                  .join("")
              : '<div class="empty-state">Add your first room in the Rooms tab to start building the graph.</div>'}
          </div>
        </section>

        <section class="panel-card">
          <div class="card-head">
            <div>
              <div class="eyebrow">Election Ranking</div>
              <h3>Which speakers are winning and why</h3>
            </div>
          </div>
          <div class="stack">
            ${speakerCandidates.length
              ? speakerCandidates
                  .map(
                    (candidate) => `
                      <div class="candidate-card ${candidate.selected ? "candidate-selected" : ""}">
                        <div class="candidate-head">
                          <div>
                            <div class="list-title">#${candidate.rank} ${this.escapeHtml(candidate.friendly_name)}</div>
                            <div class="list-subtitle">${this.escapeHtml(candidate.room)} · priority ${candidate.priority}</div>
                          </div>
                          <div class="diag-meta">
                            ${candidate.selected ? this.renderTonePill("Primary", "good") : ""}
                            ${candidate.preferred ? this.renderTonePill("Preferred", "info") : ""}
                            ${this.renderTonePill(candidate.state, candidate.available ? "good" : "warn")}
                          </div>
                        </div>
                        <div class="candidate-reason">${this.escapeHtml(candidate.reason)}</div>
                        <div class="diagnostic-subrow">
                          <span>${this.escapeHtml(candidate.entity_id)}</span>
                          <span>Source: ${this.escapeHtml(candidate.source || "Unknown")}</span>
                        </div>
                      </div>
                    `,
                  )
                  .join("")
              : '<div class="empty-state">Turn on a room to see the speaker ranking and sticky-master logic.</div>'}
          </div>
        </section>
      </div>

      <div class="grid">
        <section class="panel-card">
          <div class="card-head">
            <div>
              <div class="eyebrow">Control Flags</div>
              <h3>Home Assistant conditions affecting AGS right now</h3>
            </div>
          </div>
          <div class="logic-flag-grid">
            ${logicFlags.length
              ? logicFlags
                  .map(
                    (flag) => `
                      <div class="logic-flag-card">
                        <div class="logic-flag-head">
                          <span class="list-title">${this.escapeHtml(flag.label)}</span>
                          ${this.renderTonePill(flag.value, flag.tone)}
                        </div>
                        <div class="list-subtitle">${this.escapeHtml(flag.detail)}</div>
                      </div>
                    `,
                  )
                  .join("")
              : '<div class="empty-state">No live flags available.</div>'}
          </div>
        </section>
      </div>

      <div class="grid">
        <section class="panel-card">
          <div class="card-head">
            <div>
              <div class="eyebrow">Service Logs</div>
              <h3>Recent AGS activity</h3>
            </div>
            <button class="secondary-btn" onclick="this.getRootNode().host.fetchLogs()">Refresh</button>
          </div>
          <div class="log-view full-width-log">
            ${this.logs.length
              ? this.logs.map((line) => `<div>${this.escapeHtml(line)}</div>`).join("")
              : '<div class="muted">No AGS logs captured yet.</div>'}
          </div>
        </section>
      </div>
    `;
  }

  renderEntitiesContent() {
    const entities = Object.values(this.hass.states)
      .filter((entity) => {
        if (entity.entity_id === "media_player.ags_media_player") {
          return true;
        }
        if (entity.entity_id.includes("ags_")) {
          return true;
        }
        return entity.entity_id.startsWith("switch.") && entity.entity_id.endsWith("_media");
      })
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id));

    return `
      <section class="panel-card">
        <div class="card-head">
          <div>
            <div class="eyebrow">Home Assistant Entities</div>
            <h3>Everything AGS exposes</h3>
          </div>
        </div>
        <div class="table">
          <div class="table-row table-head">
            <div>Entity</div>
            <div>Friendly Name</div>
            <div>State</div>
            <div>Action</div>
          </div>
          ${entities
            .map((entity) => {
              const isToggle = entity.entity_id.startsWith("switch.");
              return `
                <div class="table-row">
                  <div class="mono">${this.escapeHtml(entity.entity_id)}</div>
                  <div>${this.escapeHtml(entity.attributes.friendly_name || entity.entity_id)}</div>
                  <div>${this.renderStatusPill(entity.state)}</div>
                  <div>
                    ${
                      isToggle
                        ? `<button class="secondary-btn" onclick="this.getRootNode().host.hass.callService('switch', '${entity.state === "on" ? "turn_off" : "turn_on"}', { entity_id: '${entity.entity_id}' })">Toggle</button>`
                        : '<span class="muted">Read only</span>'
                    }
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </section>
    `;
  }

  renderHome(agsState) {
    return `
      <div class="grid cols-2 home-grid">
        <section class="home-dashboard-wrap">
          <ags-media-card class="embedded-dashboard"></ags-media-card>
        </section>
        ${this.renderEntitiesContent()}
      </div>
    `;
  }

  renderOttMappings(roomIndex, deviceIndex, device) {
    if (device.device_type !== "tv") {
      return "";
    }

    const mappings = Array.isArray(device.ott_devices) ? device.ott_devices : [];
    return `
      <div class="nested-section">
        <div class="section-line">
          <div>
            <div class="section-title">TV Input Mapping</div>
            <div class="section-help">Route different TV inputs to different player entities when needed.</div>
          </div>
          <button class="secondary-btn" onclick="this.getRootNode().host.addOttMapping(${roomIndex}, ${deviceIndex})">Add Mapping</button>
        </div>
        ${mappings.length
          ? mappings
              .map(
                (mapping, mappingIndex) => `
	                  <div class="inline-grid auto-fit">
	                    <div>
	                      <label>TV Input Name</label>
                      <input
                        type="text"
                        value="${this.escapeHtml(mapping.tv_input || "")}"
                        onchange="this.getRootNode().host.updateConfig('rooms.${roomIndex}.devices.${deviceIndex}.ott_devices.${mappingIndex}.tv_input', this.value)"
	                      />
	                    </div>
	                    ${this.renderEntityField(
                        "OTT Player",
                        `rooms.${roomIndex}.devices.${deviceIndex}.ott_devices.${mappingIndex}.ott_device`,
                        mapping.ott_device || "",
                        ["media_player"],
                      )}
	                    <div class="compact-action">
	                      <button class="danger-btn" onclick="this.getRootNode().host.removeAt('rooms.${roomIndex}.devices.${deviceIndex}.ott_devices', ${mappingIndex})">Remove</button>
	                    </div>
	                  </div>
                `,
              )
              .join("")
          : '<div class="muted">No per-input mappings configured.</div>'}
      </div>
    `;
  }

  renderOverrides(roomIndex, deviceIndex, device) {
    const overrides = Array.isArray(device.source_overrides) ? device.source_overrides : [];
    return `
      <div class="nested-section">
        <div class="section-line">
          <div>
            <div class="section-title">Source Overrides</div>
            <div class="section-help">Set source-specific fallback behavior for TVs or speakers.</div>
          </div>
          <button class="secondary-btn" onclick="this.getRootNode().host.addOverride(${roomIndex}, ${deviceIndex})">Add Route</button>
        </div>
        ${overrides.length
          ? overrides
              .map(
                (override, overrideIndex) => `
                  <div class="override-card">
                    <div class="inline-grid auto-fit">
                      <div>
                        <label>Trigger Source</label>
                        <select onchange="this.getRootNode().host.updateConfig('rooms.${roomIndex}.devices.${deviceIndex}.source_overrides.${overrideIndex}.source_name', this.value)">
                          <option value="">Select source</option>
                          ${this.config.Sources.map(
                            (source) => `
                              <option value="${this.escapeHtml(source.Source)}" ${source.Source === override.source_name ? "selected" : ""}>
                                ${this.escapeHtml(source.Source)}
                              </option>
                            `,
                          ).join("")}
                        </select>
                      </div>
                      <div>
                        <label>Action Type</label>
                        <select onchange="this.getRootNode().host.updateConfig('rooms.${roomIndex}.devices.${deviceIndex}.source_overrides.${overrideIndex}.mode', this.value); this.getRootNode().host.render();">
                          <option value="source" ${override.mode === "source" ? "selected" : ""}>Source ID</option>
                          <option value="script" ${override.mode === "script" ? "selected" : ""}>Script</option>
                        </select>
                      </div>
	                      ${
	                        override.mode === "script"
	                          ? `
	                            ${this.renderEntityField(
                                  "Script Entity",
                                  `rooms.${roomIndex}.devices.${deviceIndex}.source_overrides.${overrideIndex}.script_entity`,
                                  override.script_entity || "",
                                  ["script"],
                                )}
	                          `
	                          : `
	                            <div>
                              <label>Source Value</label>
                              <input
                                type="text"
                                value="${this.escapeHtml(override.source_value || "")}"
                                onchange="this.getRootNode().host.updateConfig('rooms.${roomIndex}.devices.${deviceIndex}.source_overrides.${overrideIndex}.source_value', this.value)"
                              />
                            </div>
                          `
                      }
                      <div>
                        <label class="checkbox-row">
                          <input
                            type="checkbox"
                            ${override.run_when_tv_off ? "checked" : ""}
                            onchange="this.getRootNode().host.updateConfig('rooms.${roomIndex}.devices.${deviceIndex}.source_overrides.${overrideIndex}.run_when_tv_off', this.checked)"
                          />
                          Only if TVs are idle
                        </label>
                      </div>
                      <div class="compact-action">
                        <button class="danger-btn" onclick="this.getRootNode().host.removeAt('rooms.${roomIndex}.devices.${deviceIndex}.source_overrides', ${overrideIndex})">Remove</button>
                      </div>
                    </div>
                  </div>
                `,
              )
              .join("")
          : '<div class="muted">No source overrides configured for this device.</div>'}
      </div>
    `;
  }

  renderDeviceCard(roomIndex, deviceIndex, device) {
    const stateObj = device.device_id ? this.hass.states[device.device_id] : null;
    const stateText = stateObj?.state || "unconfigured";
    const friendlyName =
      stateObj?.attributes?.friendly_name || device.device_id || "Select an entity";
    const deviceKey = `${roomIndex}:${deviceIndex}`;
    const isEditing = this.editingDeviceKey === deviceKey;

    return `
      <div class="device-card">
        <div class="device-summary">
          <div>
            <div class="section-title">${this.escapeHtml(friendlyName)}</div>
            <div class="section-help">${device.device_type === "tv" ? "TV device" : "Speaker device"} · priority ${device.priority || 1}</div>
          </div>
          <div class="diag-meta">
            ${this.renderTonePill(stateText, stateObj ? "info" : "warn")}
            <button class="secondary-btn" onclick="this.getRootNode().host.setEditingDevice('${deviceKey}')">${isEditing ? "Done" : "Edit"}</button>
            <button class="danger-btn" onclick="this.getRootNode().host.removeAt('rooms.${roomIndex}.devices', ${deviceIndex})">Delete</button>
          </div>
        </div>

        <div class="diagnostic-subrow">
          <span>${this.escapeHtml(device.device_id || "No entity selected")}</span>
          ${stateObj?.attributes?.source ? `<span>Source: ${this.escapeHtml(stateObj.attributes.source)}</span>` : ""}
        </div>

        ${
          isEditing
            ? `
              <div class="device-editor">
                <div class="inline-grid auto-fit">
                  ${this.renderEntityField(
                    "Entity",
                    `rooms.${roomIndex}.devices.${deviceIndex}.device_id`,
                    device.device_id || "",
                    ["media_player"],
                  )}
                  <div>
                    <label>Type</label>
                    <select onchange="this.getRootNode().host.updateConfig('rooms.${roomIndex}.devices.${deviceIndex}.device_type', this.value); this.getRootNode().host.render();">
                      <option value="speaker" ${device.device_type === "speaker" ? "selected" : ""}>Speaker</option>
                      <option value="tv" ${device.device_type === "tv" ? "selected" : ""}>TV</option>
                    </select>
                  </div>
                  <div>
                    <label>Priority</label>
                    <input
                      type="number"
                      min="1"
                      value="${this.escapeHtml(device.priority || 1)}"
                      onchange="this.getRootNode().host.updateConfig('rooms.${roomIndex}.devices.${deviceIndex}.priority', parseInt(this.value, 10) || 1)"
                    />
                  </div>
                </div>

                ${
                  device.device_type === "tv"
                    ? `
                      <div class="inline-grid auto-fit">
                        <div>
                          <label>TV Mode</label>
                          <select onchange="this.getRootNode().host.updateConfig('rooms.${roomIndex}.devices.${deviceIndex}.tv_mode', this.value)">
                            <option value="tv_audio" ${device.tv_mode === "tv_audio" ? "selected" : ""}>TV Audio</option>
                            <option value="no_music" ${device.tv_mode === "no_music" ? "selected" : ""}>No Music</option>
                          </select>
                        </div>
                        ${this.renderEntityField(
                          "Default OTT Player",
                          `rooms.${roomIndex}.devices.${deviceIndex}.ott_device`,
                          device.ott_device || "",
                          ["media_player"],
                        )}
                      </div>
                      ${this.renderOttMappings(roomIndex, deviceIndex, device)}
                    `
                    : ""
                }

                ${this.renderOverrides(roomIndex, deviceIndex, device)}

                <div class="nested-section">
                  <label>Legacy Auto-Switch Matcher</label>
                  <input
                    type="text"
                    value="${this.escapeHtml(device.override_content || "")}"
                    onchange="this.getRootNode().host.updateConfig('rooms.${roomIndex}.devices.${deviceIndex}.override_content', this.value)"
                  />
                </div>
              </div>
            `
            : ""
        }
      </div>
    `;
  }

  renderRooms() {
    this.ensureRoomSelection();
    const room = this.config.rooms[this.selectedRoomIdx];

    return `
      <div class="room-layout">
        <aside class="panel-card room-list">
          <div class="card-head">
            <div>
              <div class="eyebrow">Rooms</div>
              <h3>Group and routing layout</h3>
            </div>
          </div>
          <div class="stack">
            ${this.config.rooms.length
              ? this.config.rooms
                  .map(
                    (entry, index) => `
                      <button
                        class="list-select ${index === this.selectedRoomIdx ? "active" : ""}"
                        onclick="this.getRootNode().host.selectedRoomIdx=${index}; this.getRootNode().host.render();"
                      >
                        <span>${this.escapeHtml(entry.room)}</span>
                        <span class="count-pill">${entry.devices.length}</span>
                      </button>
                    `,
                  )
                  .join("")
              : '<div class="empty-state">No rooms configured yet.</div>'}
          </div>
          <button class="primary-btn" onclick="this.getRootNode().host.addRoom()">Add Room</button>
        </aside>

        <section class="panel-card room-detail">
          ${
            room
              ? `
                <div class="card-head">
                  <div>
                    <div class="eyebrow">Room Details</div>
                    <h3>Switches, speakers, TVs, and overrides</h3>
                  </div>
                  <button class="danger-btn" onclick="this.getRootNode().host.deleteRoom(${this.selectedRoomIdx})">Delete Room</button>
                </div>

                <div class="inline-grid auto-fit">
                  <div>
                    <label>Room Name</label>
                    <input
                      type="text"
                      value="${this.escapeHtml(room.room)}"
                      onchange="this.getRootNode().host.updateConfig('rooms.${this.selectedRoomIdx}.room', this.value); this.getRootNode().host.render();"
                    />
                  </div>
                  <div>
                    <label>Generated Switch Entity</label>
                    <input type="text" value="switch.${this.escapeHtml(this.slugify(room.room))}_media" disabled />
                  </div>
                </div>

                <div class="stack">
                  ${room.devices.length
                    ? room.devices
                        .map((device, deviceIndex) =>
                          this.renderDeviceCard(this.selectedRoomIdx, deviceIndex, device),
                        )
                        .join("")
                    : '<div class="empty-state">Add a speaker or TV to this room to get started.</div>'}
                </div>

                <button class="primary-btn" onclick="this.getRootNode().host.addDevice(${this.selectedRoomIdx})">Add Device</button>
              `
              : `
                <div class="empty-state">
                  Choose a room on the left, or create one to start modeling your house.
                </div>
              `
          }
        </section>
      </div>
    `;
  }

  renderSources() {
    return `
      <section class="panel-card">
        <div class="card-head">
          <div>
            <div class="eyebrow">Sources</div>
            <h3>Global favorites and default playback targets</h3>
          </div>
          <div class="card-actions-wrap">
            <button class="secondary-btn" onclick="this.getRootNode().host.importSpeakerSourceList()">Import Inputs</button>
            <button class="secondary-btn" onclick="this.getRootNode().host.browseMediaFavorites()">Browse Media</button>
            <button class="primary-btn" onclick="this.getRootNode().host.addSource()">Add Source</button>
          </div>
        </div>
        ${
          this.favoriteBrowseError
            ? `<div class="inline-alert">${this.escapeHtml(this.favoriteBrowseError)}</div>`
            : ""
        }
        ${
          this.browseItems.length || this.discoveredFavorites.length || this.browsePath.length
            ? `
              <div class="browse-results">
                <div class="section-line">
                  <div>
                    <div class="section-title">Browsable media</div>
                    <div class="section-help">${this.escapeHtml(this.browsePath.map((entry) => entry.title).join(" / ") || "Top level")}</div>
                  </div>
                  <button class="secondary-btn" onclick="this.getRootNode().host.browseBack()">${this.browsePath.length ? "Back" : "Clear"}</button>
                </div>
                <div class="stack">
                  ${this.browseItems
                    .map(
                      (item, index) => `
                        <div class="browse-row">
                          <div>
                            <div class="list-title">${this.escapeHtml(item.title || "Untitled")}</div>
                            <div class="list-subtitle">${this.escapeHtml(item.media_content_type || "media")}</div>
                          </div>
                          <button class="secondary-btn" onclick="this.getRootNode().host.openBrowseItem(${index})">${item.can_expand ? "Open" : item.can_play ? "Add" : "View"}</button>
                        </div>
                      `,
                    )
                    .join("")}
                </div>
                <div class="section-title browse-subtitle">Playable items in this view</div>
                <div class="stack">
                  ${this.discoveredFavorites
                    .map(
                      (favorite, index) => `
                        <div class="browse-row">
                          <div>
                            <div class="list-title">${this.escapeHtml(favorite.Source)}</div>
                            <div class="list-subtitle">${this.escapeHtml(favorite.media_content_type)} · ${this.escapeHtml(favorite.Source_Value)}</div>
                          </div>
                          <button class="secondary-btn" onclick="this.getRootNode().host.addBrowsedFavorite(${index})">Add</button>
                        </div>
                      `,
                    )
                    .join("")}
                </div>
              </div>
            `
            : ""
        }
        <div class="stack">
          ${
            this.config.Sources.length
              ? this.config.Sources.map(
                  (source, index) => `
                    <div class="source-card">
                      <div class="inline-grid auto-fit">
                        <div>
                          <label>Name</label>
                          <input
                            type="text"
                            value="${this.escapeHtml(source.Source || "")}"
                            onchange="this.getRootNode().host.updateConfig('Sources.${index}.Source', this.value)"
                          />
                        </div>
                        <div>
                          <label>Source Value / ID</label>
                          <input
                            type="text"
                            value="${this.escapeHtml(source.Source_Value || "")}"
                            onchange="this.getRootNode().host.updateConfig('Sources.${index}.Source_Value', this.value)"
                          />
                        </div>
                        <div>
                          <label>Media Type</label>
                          <select onchange="this.getRootNode().host.updateConfig('Sources.${index}.media_content_type', this.value)">
                            <option value="favorite_item_id" ${source.media_content_type === "favorite_item_id" ? "selected" : ""}>Sonos Favorite</option>
                            <option value="playlist" ${source.media_content_type === "playlist" ? "selected" : ""}>Playlist</option>
                            <option value="music" ${source.media_content_type === "music" ? "selected" : ""}>Music / URL</option>
                          </select>
                        </div>
                        <div>
                          <label class="checkbox-row">
                            <input
                              type="checkbox"
                              ${source.source_default ? "checked" : ""}
                              onchange="this.getRootNode().host.config.Sources.forEach((entry, entryIndex) => { entry.source_default = entryIndex === ${index} ? this.checked : false; }); this.getRootNode().host.render();"
                            />
                            Default source
                          </label>
                        </div>
                        <div class="compact-action">
                          <button class="danger-btn" onclick="this.getRootNode().host.removeAt('Sources', ${index})">Delete</button>
                        </div>
                      </div>
                    </div>
                  `,
                ).join("")
              : '<div class="empty-state">No global sources yet. Add one to power the dashboard card and News Mode routes.</div>'
          }
        </div>
      </section>
    `;
  }

  renderSettings() {
    const schedule = this.config.schedule_entity;
    const defaultSourceSchedule = this.config.default_source_schedule;

    return `
      <div class="grid cols-2">
        <section class="panel-card">
          <div class="card-head">
            <div>
              <div class="eyebrow">System</div>
              <h3>Core AGS behavior</h3>
            </div>
          </div>
          <div class="stack">
            <div class="setting-row">
              <div>
                <div class="list-title">Static player name</div>
                <div class="list-subtitle">Keeps the AGS player entity stable for Apple Home and dashboards.</div>
              </div>
              <input
                class="setting-input"
                type="text"
                value="${this.escapeHtml(this.config.static_name || "")}"
                onchange="this.getRootNode().host.updateConfig('static_name', this.value)"
              />
            </div>

            <div class="nested-section">
              ${this.renderEntityField(
                "HomeKit Player",
                "homekit_player",
                this.config.homekit_player || "",
                ["media_player"],
                {
                  helper:
                    "Optional media_player entity to mirror for HomeKit-facing behavior.",
                },
              )}
            </div>

            <label class="toggle-row">
              <div>
                <div class="list-title">Default on</div>
                <div class="list-subtitle">Start AGS automatically after Home Assistant boots.</div>
              </div>
              <input type="checkbox" ${this.config.default_on ? "checked" : ""} onchange="this.getRootNode().host.updateConfig('default_on', this.checked)" />
            </label>

            <label class="toggle-row">
              <div>
                <div class="list-title">Expose AGS sensors</div>
                <div class="list-subtitle">Create helper sensors and the AGS actions switch.</div>
              </div>
              <input type="checkbox" ${this.config.create_sensors ? "checked" : ""} onchange="this.getRootNode().host.updateConfig('create_sensors', this.checked)" />
            </label>

            <label class="toggle-row">
              <div>
                <div class="list-title">Batch unjoin</div>
                <div class="list-subtitle">Ungroup all speakers in a single action when AGS shuts down.</div>
              </div>
              <input type="checkbox" ${this.config.batch_unjoin ? "checked" : ""} onchange="this.getRootNode().host.updateConfig('batch_unjoin', this.checked)" />
            </label>

            <label class="toggle-row">
              <div>
                <div class="list-title">Ignore zone.home occupancy</div>
                <div class="list-subtitle">Keep AGS active even when nobody is home.</div>
              </div>
              <input type="checkbox" ${this.config.disable_zone ? "checked" : ""} onchange="this.getRootNode().host.updateConfig('disable_zone', this.checked)" />
            </label>

            <label class="toggle-row">
              <div>
                <div class="list-title">Do not force TV input on idle TV rooms</div>
                <div class="list-subtitle">Leave speakers alone instead of pushing them back to the TV source.</div>
              </div>
              <input type="checkbox" ${this.config.disable_Tv_Source ? "checked" : ""} onchange="this.getRootNode().host.updateConfig('disable_Tv_Source', this.checked)" />
            </label>
          </div>
        </section>

        <section class="panel-card">
          <div class="card-head">
            <div>
              <div class="eyebrow">Automation</div>
              <h3>Home Assistant schedules and source switching</h3>
            </div>
          </div>
          <div class="stack">
            <div class="nested-section">
              <div class="section-line">
                <div>
                  <div class="section-title">Media System Schedule</div>
                  <div class="section-help">Use a schedule or input_boolean to disable AGS at certain times.</div>
                </div>
                <button class="secondary-btn" onclick="this.getRootNode().host.ensureScheduleEntity(); this.getRootNode().host.render();">
                  ${schedule ? "Edit" : "Enable"}
                </button>
              </div>
              ${
                schedule
                  ? `
                    <div class="stack">
                      ${this.renderEntityField(
                        "Schedule Entity",
                        "schedule_entity.entity_id",
                        schedule.entity_id || "",
                        ["schedule", "input_boolean"],
                      )}
                      <div class="inline-grid auto-fit">
                        <div>
                          <label>On State</label>
                          <input
                            type="text"
                            value="${this.escapeHtml(schedule.on_state || "on")}"
                            onchange="this.getRootNode().host.updateConfig('schedule_entity.on_state', this.value)"
                          />
                        </div>
                        <div>
                          <label>Off State</label>
                          <input
                            type="text"
                            value="${this.escapeHtml(schedule.off_state || "off")}"
                            onchange="this.getRootNode().host.updateConfig('schedule_entity.off_state', this.value)"
                          />
                        </div>
                      </div>
                      <label class="checkbox-row">
                        <input
                          type="checkbox"
                          ${schedule.schedule_override ? "checked" : ""}
                          onchange="this.getRootNode().host.updateConfig('schedule_entity.schedule_override', this.checked)"
                        />
                        Let users manually turn AGS back on after the schedule shuts it off
                      </label>
                      <button class="danger-btn" onclick="this.getRootNode().host.config.schedule_entity = null; this.getRootNode().host.render();">Remove Schedule</button>
                    </div>
                  `
                  : '<div class="muted">No schedule is attached to AGS right now.</div>'
              }
            </div>

            <div class="nested-section">
              <div class="section-line">
                <div>
                  <div class="section-title">Default Source Schedule</div>
                  <div class="section-help">Override the default source when a schedule is active.</div>
                </div>
                <button class="secondary-btn" onclick="this.getRootNode().host.ensureDefaultSourceSchedule(); this.getRootNode().host.render();">
                  ${defaultSourceSchedule ? "Edit" : "Enable"}
                </button>
              </div>
              ${
                defaultSourceSchedule
                  ? `
                    <div class="stack">
                      ${this.renderEntityField(
                        "Schedule Entity",
                        "default_source_schedule.entity_id",
                        defaultSourceSchedule.entity_id || "",
                        ["schedule", "input_boolean"],
                      )}
                      <div>
                        <label>Target Source</label>
                        <select onchange="this.getRootNode().host.updateConfig('default_source_schedule.source_name', this.value)">
                          <option value="">Select source</option>
                          ${this.config.Sources.map(
                            (source) => `
                              <option value="${this.escapeHtml(source.Source)}" ${source.Source === defaultSourceSchedule.source_name ? "selected" : ""}>
                                ${this.escapeHtml(source.Source)}
                              </option>
                            `,
                          ).join("")}
                        </select>
                      </div>
                      <div>
                        <label>Trigger State</label>
                        <input
                          type="text"
                          value="${this.escapeHtml(defaultSourceSchedule.on_state || "on")}"
                          onchange="this.getRootNode().host.updateConfig('default_source_schedule.on_state', this.value)"
                        />
                      </div>
                      <button class="danger-btn" onclick="this.getRootNode().host.config.default_source_schedule = null; this.getRootNode().host.render();">Remove Source Schedule</button>
                    </div>
                  `
                  : '<div class="muted">No default source automation is configured.</div>'
              }
            </div>
          </div>
        </section>
      </div>
    `;
  }

  renderView(agsState) {
    if (this.activeTab === "home") {
      return this.renderHome(agsState);
    }
    if (this.activeTab === "diagnostics") {
      return this.renderDiagnostics(agsState);
    }
    if (this.activeTab === "rooms") {
      return this.renderRooms();
    }
    if (this.activeTab === "sources") {
      return this.renderSources();
    }
    return this.renderSettings();
  }

  render() {
    const agsState = this.getAgsState();
    const attributes = agsState?.attributes || {};
    const status = attributes.ags_status || "OFF";
    const primaryRoom = attributes.primary_speaker_room || "No active room";

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          min-height: 100%;
          background:
            radial-gradient(circle at top left, rgba(var(--rgb-primary-color), 0.08), transparent 32%),
            linear-gradient(180deg, var(--primary-background-color), var(--secondary-background-color, var(--primary-background-color)));
          color: var(--primary-text-color);
          font-family: var(--ha-font-family-body, Roboto, sans-serif);
        }

        * {
          box-sizing: border-box;
        }

        .shell {
          max-width: 1240px;
          margin: 0 auto;
          padding: 24px 24px 96px;
        }

        .page-header {
          display: flex;
          flex-wrap: wrap;
          align-items: flex-end;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 20px;
        }

        .title-block h1 {
          margin: 0;
          font-size: 2rem;
          line-height: 1.1;
          letter-spacing: -0.02em;
        }

        .title-block p {
          margin: 8px 0 0;
          color: var(--secondary-text-color);
        }

        .header-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          align-items: center;
        }

        .tabs {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-bottom: 24px;
        }

        .tab-btn,
        .primary-btn,
        .secondary-btn,
        .danger-btn,
        .list-select {
          border: 1px solid var(--divider-color);
          border-radius: 999px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
          font: inherit;
          transition: background 160ms ease, border-color 160ms ease, color 160ms ease, transform 160ms ease;
        }

        .tab-btn:hover,
        .primary-btn:hover,
        .secondary-btn:hover,
        .danger-btn:hover,
        .list-select:hover {
          border-color: rgba(var(--rgb-primary-color), 0.4);
        }

        .tab-btn {
          padding: 10px 16px;
          font-weight: 600;
        }

        .tab-btn.active {
          border-color: rgba(var(--rgb-primary-color), 0.38);
          background: rgba(var(--rgb-primary-color), 0.12);
          color: var(--primary-color);
        }

        .primary-btn,
        .secondary-btn,
        .danger-btn {
          padding: 10px 16px;
          font-weight: 600;
        }

        .primary-btn {
          background: var(--primary-color);
          border-color: var(--primary-color);
          color: var(--text-primary-color, #fff);
        }

        .secondary-btn {
          background: rgba(var(--rgb-primary-color), 0.08);
          border-color: rgba(var(--rgb-primary-color), 0.18);
        }

        .danger-btn {
          color: var(--error-color);
          border-color: rgba(var(--rgb-error-color, 211, 47, 47), 0.22);
          background: rgba(var(--rgb-error-color, 211, 47, 47), 0.06);
        }

        .save-bar {
          position: sticky;
          bottom: 16px;
          margin-top: 24px;
          display: flex;
          justify-content: flex-end;
          z-index: 2;
        }

        .panel-card {
          background: var(--card-background-color);
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.08);
          border-radius: 24px;
          padding: 22px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
        }

        .hero-card {
          background:
            linear-gradient(135deg, rgba(var(--rgb-primary-color), 0.12), rgba(var(--rgb-primary-color), 0.03)),
            var(--card-background-color);
        }

        .grid {
          display: grid;
          gap: 20px;
        }

        .grid > *,
        .cols-2 > *,
        .room-layout > *,
        .home-grid > *,
        .diagnostics-grid > * {
          min-width: 0;
        }

        .cols-2 {
          grid-template-columns: repeat(2, minmax(0, 1fr));
          margin-bottom: 20px;
        }

        .home-grid {
          grid-template-columns: minmax(0, 1.18fr) minmax(320px, 0.82fr);
        }

        .room-layout {
          display: grid;
          grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
          gap: 20px;
        }

        .card-head,
        .section-line,
        .hero-line {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .card-head h3 {
          margin: 4px 0 0;
          font-size: 1.2rem;
        }

        .eyebrow {
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 0.72rem;
          font-weight: 700;
          color: var(--secondary-text-color);
        }

        .hero-title {
          font-size: 1.1rem;
          font-weight: 700;
        }

        .metric-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
          margin-top: 18px;
        }

        .metric-card,
        .device-card,
        .source-card,
        .override-card,
        .nested-section {
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.08);
          border-radius: 18px;
          padding: 16px;
          background: rgba(var(--rgb-primary-text-color), 0.015);
        }

        .metric-label,
        .list-subtitle,
        .section-help,
        .muted {
          color: var(--secondary-text-color);
        }

        .metric-value {
          font-size: 1.35rem;
          font-weight: 700;
          margin-top: 6px;
        }

        .chip-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 16px;
        }

        .chip,
        .pill,
        .count-pill,
        .status-pill,
        .tone-pill {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          padding: 6px 10px;
          font-size: 0.8rem;
          font-weight: 700;
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.1);
          background: rgba(var(--rgb-primary-text-color), 0.04);
          max-width: 100%;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .status-pill {
          background: rgba(var(--rgb-primary-color), 0.12);
          border-color: rgba(var(--rgb-primary-color), 0.18);
          color: var(--primary-color);
        }

        .status-on-tv {
          color: var(--info-color);
          border-color: rgba(var(--rgb-info-color, 3, 169, 244), 0.2);
          background: rgba(var(--rgb-info-color, 3, 169, 244), 0.1);
        }

        .status-override {
          color: var(--warning-color);
          border-color: rgba(var(--rgb-warning-color, 255, 152, 0), 0.2);
          background: rgba(var(--rgb-warning-color, 255, 152, 0), 0.1);
        }

        .status-off {
          color: var(--secondary-text-color);
        }

        .tone-pill {
          background: rgba(var(--rgb-primary-text-color), 0.04);
        }

        .tone-good {
          color: var(--success-color);
          border-color: rgba(var(--rgb-success-color, 67, 160, 71), 0.22);
          background: rgba(var(--rgb-success-color, 67, 160, 71), 0.1);
        }

        .tone-warn {
          color: var(--warning-color);
          border-color: rgba(var(--rgb-warning-color, 255, 152, 0), 0.22);
          background: rgba(var(--rgb-warning-color, 255, 152, 0), 0.1);
        }

        .tone-info {
          color: var(--info-color);
          border-color: rgba(var(--rgb-info-color, 3, 169, 244), 0.22);
          background: rgba(var(--rgb-info-color, 3, 169, 244), 0.1);
        }

        .tone-neutral {
          color: var(--secondary-text-color);
        }

        .pill-on {
          color: var(--success-color);
          border-color: rgba(var(--rgb-success-color, 67, 160, 71), 0.2);
          background: rgba(var(--rgb-success-color, 67, 160, 71), 0.1);
        }

        .step-list,
        .stack {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .step {
          display: grid;
          grid-template-columns: 34px 1fr;
          align-items: center;
          gap: 12px;
          padding: 12px 14px;
          border-radius: 16px;
          background: rgba(var(--rgb-primary-text-color), 0.02);
          opacity: 0.72;
        }

        .step.active {
          opacity: 1;
          background: rgba(var(--rgb-primary-color), 0.08);
        }

        .step-index {
          width: 34px;
          height: 34px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(var(--rgb-primary-text-color), 0.08);
          font-weight: 700;
        }

        .step.active .step-index {
          background: var(--primary-color);
          color: var(--text-primary-color, #fff);
        }

        .table {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .table-row {
          display: grid;
          grid-template-columns: minmax(0, 1.6fr) minmax(0, 1.2fr) minmax(120px, 0.8fr) minmax(100px, 0.7fr);
          gap: 12px;
          align-items: center;
          padding: 14px 12px;
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.08);
          border-radius: 16px;
          background: rgba(var(--rgb-primary-text-color), 0.015);
        }

        .table-row > * {
          min-width: 0;
        }

        .table-head {
          background: transparent;
          border: none;
          padding: 0 12px 4px;
          font-size: 0.76rem;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--secondary-text-color);
        }

        .mono {
          font-family: var(--code-font-family, "SFMono-Regular", Consolas, monospace);
          font-size: 0.85rem;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .room-list,
        .room-detail {
          min-height: 560px;
        }

        .list-select {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 14px;
          border-radius: 16px;
          text-align: left;
        }

        .list-select.active {
          background: rgba(var(--rgb-primary-color), 0.12);
          border-color: rgba(var(--rgb-primary-color), 0.24);
          color: var(--primary-color);
        }

        .count-pill {
          min-width: 28px;
          padding-inline: 8px;
        }

        .list-row,
        .setting-row,
        .toggle-row {
          display: flex;
          gap: 16px;
          align-items: center;
          justify-content: space-between;
        }

        .list-title,
        .section-title {
          font-weight: 700;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .list-subtitle,
        .section-help,
        .entity-helper,
        .diagnostic-subrow,
        .hero-title,
        .title-block p {
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .inline-grid {
          display: grid;
          gap: 14px;
          margin-top: 14px;
        }

        .auto-fit {
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        }

        .compact-action {
          display: flex;
          align-items: flex-end;
        }

        .card-actions-wrap {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          min-width: 0;
        }

        label {
          display: block;
          margin-bottom: 6px;
          font-size: 0.84rem;
          font-weight: 600;
        }

        input,
        select,
        ha-entity-picker {
          width: 100%;
        }

        input,
        select,
        .setting-input {
          min-height: 44px;
          padding: 10px 12px;
          border-radius: 14px;
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.12);
          background: rgba(var(--rgb-primary-text-color), 0.02);
          color: var(--primary-text-color);
          font: inherit;
        }

        input[disabled] {
          color: var(--secondary-text-color);
        }

        .checkbox-row {
          display: flex;
          align-items: center;
          gap: 10px;
          min-height: 44px;
          margin: 0;
        }

        .checkbox-row input,
        .toggle-row input {
          width: 18px;
          height: 18px;
          margin: 0;
        }

        .setting-input {
          max-width: 220px;
        }

        .entity-field {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .entity-fallback {
          font-family: var(--code-font-family, "SFMono-Regular", Consolas, monospace);
          font-size: 0.9rem;
        }

        .entity-helper {
          margin-top: 6px;
          color: var(--secondary-text-color);
          font-size: 0.78rem;
        }

        .inline-alert {
          margin: 14px 0;
          padding: 12px 14px;
          border-radius: 14px;
          border: 1px solid rgba(var(--rgb-warning-color, 255, 152, 0), 0.22);
          background: rgba(var(--rgb-warning-color, 255, 152, 0), 0.08);
          color: var(--warning-color);
        }

        .browse-results {
          margin-bottom: 16px;
          padding: 16px;
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.08);
          border-radius: 18px;
          background: rgba(var(--rgb-primary-text-color), 0.02);
        }

        .browse-row {
          display: flex;
          gap: 12px;
          align-items: center;
          justify-content: space-between;
          padding: 12px 0;
          border-top: 1px solid rgba(var(--rgb-primary-text-color), 0.06);
        }

        .browse-row > * {
          min-width: 0;
        }

        .browse-row:first-of-type {
          border-top: 0;
          padding-top: 0;
        }

        .log-view {
          min-height: 280px;
          max-height: 360px;
          overflow: auto;
          border-radius: 18px;
          padding: 14px;
          background: #11161d;
          color: #d9f8d7;
          font-family: var(--code-font-family, "SFMono-Regular", Consolas, monospace);
          font-size: 0.82rem;
          line-height: 1.45;
        }

        .empty-state {
          padding: 28px 20px;
          border-radius: 18px;
          border: 1px dashed rgba(var(--rgb-primary-text-color), 0.16);
          color: var(--secondary-text-color);
          text-align: center;
        }

        .diagnostics-grid {
          align-items: start;
        }

        .home-grid {
          align-items: start;
        }

        .home-dashboard-wrap,
        .embedded-dashboard {
          display: block;
          min-width: 0;
        }

        .diagnostic-card,
        .candidate-card,
        .logic-flag-card {
          border: 1px solid rgba(var(--rgb-primary-text-color), 0.08);
          border-radius: 18px;
          padding: 14px 16px;
          background: rgba(var(--rgb-primary-text-color), 0.02);
        }

        .candidate-selected {
          border-color: rgba(var(--rgb-primary-color), 0.24);
          background: rgba(var(--rgb-primary-color), 0.08);
        }

        .diag-meta,
        .candidate-head,
        .logic-flag-head {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
        }

        .diag-meta > *,
        .candidate-head > *,
        .logic-flag-head > *,
        .device-summary > *,
        .card-head > *,
        .page-header > *,
        .header-meta > * {
          min-width: 0;
        }

        .diagnostic-subrow,
        .candidate-reason {
          margin-top: 10px;
        }

        .diagnostic-subrow {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          color: var(--secondary-text-color);
          font-size: 0.84rem;
        }

        .candidate-reason {
          font-weight: 600;
        }

        .device-summary {
          display: flex;
          gap: 12px;
          align-items: flex-start;
          justify-content: space-between;
        }

        .device-editor {
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid rgba(var(--rgb-primary-text-color), 0.08);
        }

        .logic-flag-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }

        .full-width-log {
          max-height: 440px;
        }

        .loading,
        .error {
          padding: 32px 24px;
          text-align: center;
          color: var(--secondary-text-color);
        }

        .error {
          color: var(--error-color);
        }

        @media (max-width: 960px) {
          .cols-2,
          .room-layout,
          .table-row,
          .logic-flag-grid,
          .home-grid {
            grid-template-columns: 1fr;
          }

          .table-head {
            display: none;
          }

          .panel-card {
            padding: 18px;
            border-radius: 20px;
          }

          .shell {
            padding: 18px 16px 88px;
          }

          .browse-row,
          .device-summary {
            flex-direction: column;
            align-items: flex-start;
          }

          .diag-meta,
          .card-actions-wrap,
          .header-meta {
            width: 100%;
          }
        }
      </style>

      <div class="shell">
        <div class="page-header">
          <div class="title-block">
            <h1>AGS Service</h1>
            <p>Manage whole-home grouping, sources, and TV routing with Home Assistant-native controls.</p>
          </div>
          <div class="header-meta">
            ${this.renderStatusPill(status)}
            <span class="pill">${this.escapeHtml(primaryRoom)}</span>
          </div>
        </div>

        <div class="tabs">
          ${[
            ["home", "Home"],
            ["diagnostics", "Diagnostics"],
            ["rooms", "Rooms"],
            ["sources", "Sources"],
            ["settings", "Settings"],
          ]
            .map(
              ([key, label]) => `
                <button class="tab-btn ${this.activeTab === key ? "active" : ""}" onclick="this.getRootNode().host.setTab('${key}')">
                  ${label}
                </button>
              `,
            )
            .join("")}
        </div>

        ${
          this.loading
            ? '<div class="panel-card loading">Loading AGS configuration…</div>'
            : this.error
              ? `<div class="panel-card error">${this.escapeHtml(this.error)}</div>`
              : this.renderView(agsState)
        }

        <div class="save-bar">
          <button class="primary-btn" onclick="this.getRootNode().host.saveConfig()">Save and Hot-Reload</button>
        </div>
      </div>
    `;

    this.bindEntityPickers();
    this.bindEmbeddedDashboard();
  }
}

if (!customElements.get("ags-panel")) {
  customElements.define("ags-panel", AGSPanel);
}
