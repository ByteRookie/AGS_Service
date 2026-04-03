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
      
      // Initialize entity pickers after config is loaded
      this.initEntityPickers();
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
      homekit_player: normalizeEntityValue(config?.homekit_player || "") || null,
      create_sensors: config?.create_sensors !== false,
      default_on: Boolean(config?.default_on),
      static_name: config?.static_name || "",
      disable_Tv_Source: Boolean(config?.disable_Tv_Source),
      schedule_entity: config?.schedule_entity || null,
      default_source_schedule: config?.default_source_schedule || null,
      batch_unjoin: Boolean(config?.batch_unjoin),
    };

    normalized.rooms = normalized.rooms.map((room) => {
      const devices = Array.isArray(room?.devices)
        ? room.devices
            .map((device, deviceIndex) => {
              const rawPriority = Number(device?.priority);
              const normalizedDevice = {
                device_id: normalizeEntityValue(device?.device_id || ""),
                device_type: device?.device_type === "tv" ? "tv" : "speaker",
                priority:
                  Number.isFinite(rawPriority) && rawPriority > 0
                    ? rawPriority
                    : deviceIndex + 1,
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
                __sortIndex: deviceIndex,
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
            .sort((left, right) => {
              if (left.priority !== right.priority) {
                return left.priority - right.priority;
              }
              return left.__sortIndex - right.__sortIndex;
            })
            .map((device, index) => {
              const normalizedDevice = { ...device, priority: index + 1 };
              delete normalizedDevice.__sortIndex;
              return normalizedDevice;
            })
        : [];

      return {
        room: room?.room || "New Room",
        devices,
      };
    });

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

    let defaultAssigned = false;
    normalized.Sources = normalized.Sources.map((source) => {
      const isDefault = Boolean(source?.source_default) && !defaultAssigned;
      defaultAssigned = defaultAssigned || isDefault;
      return {
        Source: source?.Source || "",
        Source_Value: source?.Source_Value || "",
        media_content_type: source?.media_content_type || "favorite_item_id",
        source_default: isDefault,
      };
    });

    if (
      normalized.default_source_schedule &&
      !normalized.Sources.some(
        (source) => source.Source === normalized.default_source_schedule.source_name,
      )
    ) {
      normalized.default_source_schedule = null;
    }

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

  resolveMediaUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    if (/^(https?:|data:)/i.test(raw)) {
      return raw;
    }
    if (raw.startsWith("//")) {
      return `${window.location.protocol}${raw}`;
    }
    if (typeof this.hass?.hassUrl === "function") {
      return this.hass.hassUrl(raw.startsWith("/") ? raw : `/${raw}`);
    }
    return raw;
  }

  getConfigIssues(config = this.config) {
    const issues = [];
    const seenDevices = new Map();
    const seenSources = new Map();

    (config?.rooms || []).forEach((room) => {
      (room?.devices || []).forEach((device) => {
        const entityId = String(device?.device_id || "").trim();
        if (!entityId) {
          return;
        }
        if (seenDevices.has(entityId)) {
          issues.push(`Device ${entityId} is assigned more than once.`);
          return;
        }
        seenDevices.set(entityId, room.room || "room");
      });
    });

    (config?.Sources || []).forEach((source) => {
      const name = String(source?.Source || "").trim();
      if (!name) {
        return;
      }
      const key = name.toLowerCase();
      if (seenSources.has(key)) {
        issues.push(`Source name "${name}" is duplicated.`);
        return;
      }
      seenSources.set(key, true);
    });

    return issues;
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
    this.config = this.normalizeConfig(this.config);
    this.render();
  }

  removeAt(path, index) {
    const target = this.resolvePath(path);
    if (Array.isArray(target)) {
      target.splice(index, 1);
      this.config = this.normalizeConfig(this.config);
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
    this.config = this.normalizeConfig(this.config);
    this.selectedRoomIdx = this.config.rooms.length - 1;
    this.render();
  }

  deleteRoom(index) {
    if (!window.confirm("Delete this room?")) {
      return;
    }
    this.config.rooms.splice(index, 1);
    this.config = this.normalizeConfig(this.config);
    this.ensureRoomSelection();
    this.render();
  }

  addDevice(roomIndex) {
    this.config.rooms[roomIndex].devices.push({
      device_id: "",
      device_type: "speaker",
      priority: this.config.rooms[roomIndex].devices.length + 1,
      tv_mode: "tv_audio",
      ott_device: "",
      ott_devices: [],
      override_content: "",
      source_overrides: [],
    });
    this.config = this.normalizeConfig(this.config);
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
    this.config = this.normalizeConfig(this.config);
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
    this.config = this.normalizeConfig(this.config);
    this.render();
  }

  addSource() {
    this.config.Sources.push({
      Source: "",
      Source_Value: "",
      media_content_type: "favorite_item_id",
      source_default: false,
    });
    this.config = this.normalizeConfig(this.config);
    this.render();
  }

  setSourceDefault(index, isDefault) {
    this.config.Sources.forEach((source, sourceIndex) => {
      source.source_default = isDefault ? sourceIndex === index : false;
    });
    this.config = this.normalizeConfig(this.config);
    this.render();
  }

  setDevicePriority(roomIndex, deviceIndex, requestedPriority) {
    const room = this.config?.rooms?.[roomIndex];
    if (!room || !Array.isArray(room.devices)) {
      return;
    }

    const deviceCount = room.devices.length;
    if (!deviceCount) {
      return;
    }

    const safePriority = Math.max(
      1,
      Math.min(deviceCount, parseInt(requestedPriority, 10) || 1),
    );
    const [movedDevice] = room.devices.splice(deviceIndex, 1);
    room.devices.splice(safePriority - 1, 0, movedDevice);
    room.devices.forEach((device, index) => {
      device.priority = index + 1;
    });
    this.config = this.normalizeConfig(this.config);
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
      const normalizedConfig = this.normalizeConfig(this.config);
      const issues = this.getConfigIssues(normalizedConfig);
      this.config = normalizedConfig;
      if (issues.length) {
        this.error = issues.join(" ");
        this.render();
        return;
      }

      this.error = "";
      await this.hass.callWS({
        type: "ags_service/config/save",
        config: normalizedConfig,
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
    // Clear existing bindings first
    this.shadowRoot.querySelectorAll("ha-entity-picker").forEach(picker => {
      if (picker.__agsBound) {
        picker.removeEventListener("value-changed", picker.__agsValueChangeHandler);
        picker.__agsBound = false;
      }
    });

    // Bind new pickers
    this.shadowRoot.querySelectorAll("ha-entity-picker").forEach((picker) => {
      if (!picker.__agsBound) {
        picker.hass = this.hass;
        const includeDomains = picker.getAttribute("include-domains");
        
        try {
          if (includeDomains) {
            picker.includeDomains = JSON.parse(includeDomains);
          }
        } catch (error) {
          console.error("Failed to parse include-domains", error);
        }

        picker.allowCustomEntity = true;
        picker.clearable = true;
        const value = picker.getAttribute("data-value") || "";
        picker.value = value;

        // Store handler to avoid duplicates
        const handleValueChange = (event) => {
          const path = picker.getAttribute("data-path");
          if (!path) return;

          const nextValue = String(event.detail?.value || "").trim();
          const sanitized = nextValue.toLowerCase() === "entity id" 
            ? ""
            : nextValue;
          
          this.updateConfig(path, sanitized);
        };

        picker.__agsValueChangeHandler = handleValueChange;
        picker.addEventListener("value-changed", handleValueChange);
        picker.__agsBound = true;

        console.log(`Bound entity picker for path: ${picker.getAttribute("data-path")}`);
      }
    });
  }

  // Ensure entity pickers are bound after initial load
  initEntityPickers() {
    this.bindEntityPickers();
    console.log("Initialized entity pickers");
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
        </div>
        ${helper}
      </div>
    `;
  }

  getBrowseEntityId() {
    const ags = this.getAgsState();
    // browse_entity_id is always a speaker (never TV/OTT), falls back to highest-priority
    // configured speaker even when system is idle — safe for music library browsing
    const browseEid = ags?.attributes?.browse_entity_id;
    if (browseEid && browseEid !== "none" && this.hass.states[browseEid]) {
      return browseEid;
    }
    // Fall back to primary_speaker (also always a speaker)
    const primary = ags?.attributes?.primary_speaker;
    if (primary && primary !== "none" && this.hass.states[primary]) {
      return primary;
    }
    return null;
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

    this.config = this.normalizeConfig(this.config);
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
    const activeSpeakers = Array.isArray(attributes.active_speakers) ? attributes.active_speakers : [];
    const configuredRooms = Array.isArray(attributes.configured_rooms) ? attributes.configured_rooms : [];
    const roomDiagnostics = Array.isArray(attributes.room_diagnostics) ? attributes.room_diagnostics : [];
    const logicFlags = Array.isArray(attributes.logic_flags) ? attributes.logic_flags : [];
    const speakerCandidates = Array.isArray(attributes.speaker_candidates) ? attributes.speaker_candidates : [];
    const master = attributes.primary_speaker || "None";
    const dynamicTitle = attributes.dynamic_title || "AGS System";

    const includedCount = roomDiagnostics.filter((room) => room.included).length;
    const skippedCount = roomDiagnostics.filter((room) => room.state === "skipped").length;
    const blockedCount = roomDiagnostics.filter((room) => room.state === "blocked").length;
    const waitingCount = roomDiagnostics.filter((room) => room.state === "waiting").length;

    return `
      <div class="grid cols-2">
        <section class="panel-card hero-card">
          <div class="eyebrow">Overview</div>
          <div class="card-head" style="margin-bottom:12px;">
            <h3 style="font-size:1.2rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(dynamicTitle)}</h3>
            ${this.renderStatusPill(attributes.ags_status)}
          </div>
          <div class="metric-grid" style="grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));">
            <div class="metric-card" style="padding:12px;">
              <div class="metric-label" style="font-size:0.7rem;">Primary</div>
              <div class="metric-value" style="font-size:0.9rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this.escapeHtml(master.split('.').pop() || "None")}</div>
            </div>
            <div class="metric-card" style="padding:12px;">
              <div class="metric-label" style="font-size:0.7rem;">Active</div>
              <div class="metric-value" style="font-size:1.1rem;">${activeRooms.length}</div>
            </div>
            <div class="metric-card" style="padding:12px;">
              <div class="metric-label" style="font-size:0.7rem;">Grouped</div>
              <div class="metric-value" style="font-size:1.1rem;">${activeSpeakers.length}</div>
            </div>
            <div class="metric-card" style="padding:12px;">
              <div class="metric-label" style="font-size:0.7rem;">Total</div>
              <div class="metric-value" style="font-size:1.1rem;">${configuredRooms.length}</div>
            </div>
          </div>
        </section>

        <section class="panel-card">
          <div class="eyebrow">Logic State</div>
          <div class="stack" style="margin-top:12px; gap:8px;">
            ${logicFlags.map(flag => `
              <div class="device-card" style="padding:8px 16px; margin:0; border-radius:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                  <div style="font-weight:800; font-size:0.85rem; white-space:nowrap;">${this.escapeHtml(flag.label)}</div>
                  <div style="display:flex; align-items:center; gap:8px; overflow:hidden;">
                    <span style="font-weight:800; color:var(--ags-primary); font-size:0.85rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(flag.value)}</span>
                    ${this.renderTonePill(flag.value, flag.tone)}
                  </div>
                </div>
              </div>
            `).join("")}
          </div>
        </section>
      </div>

      <div class="grid cols-2" style="margin-top:24px;">
        <section class="panel-card">
          <div class="card-head" style="margin-bottom:12px;">
            <div class="eyebrow">Room Logic</div>
          </div>
          <div style="display:flex; gap:4px; margin-bottom:12px; flex-wrap:wrap;">
            <span class="status-pill active" style="font-size:0.6rem; padding:2px 6px;">${includedCount} IN</span>
            <span class="status-pill info" style="font-size:0.6rem; padding:2px 6px;">${waitingCount} WAIT</span>
            <span class="status-pill warn" style="font-size:0.6rem; padding:2px 6px;">${skippedCount} SKIP</span>
            <span class="status-pill status-off" style="font-size:0.6rem; padding:2px 6px;">${blockedCount} BLOCK</span>
          </div>
          <div class="stack" style="gap:8px;">
            ${roomDiagnostics.map(r => `
              <div class="device-card" style="padding:10px 14px; border-radius:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                  <div style="overflow:hidden;">
                    <div style="font-weight:800; font-size:0.95rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(r.name)}</div>
                    <div class="section-help" style="font-size:0.75rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(r.reason)}</div>
                  </div>
                  ${this.renderTonePill(r.state, r.tone)}
                </div>
              </div>
            `).join("")}
          </div>
        </section>

        <section class="panel-card">
          <div class="card-head" style="margin-bottom:12px;">
            <div class="eyebrow">Election</div>
          </div>
          <div class="stack" style="gap:8px;">
            ${speakerCandidates.slice(0,6).map(c => `
              <div class="device-card ${c.selected ? 'candidate-selected' : ''}" style="padding:10px 14px; border-radius:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                  <div style="display:flex; align-items:center; gap:8px; overflow:hidden;">
                    <div style="width:20px; height:20px; border-radius:50%; background:${c.selected ? 'var(--ags-primary)' : 'rgba(var(--rgb-primary-text-color),0.1)'}; color:${c.selected ? '#fff' : 'inherit'}; display:flex; align-items:center; justify-content:center; font-size:0.65rem; font-weight:900; flex-shrink:0;">${c.rank}</div>
                    <div style="font-weight:800; font-size:0.95rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(c.friendly_name)}</div>
                  </div>
                  ${c.selected ? this.renderTonePill("Winner", "good") : this.renderTonePill(c.state, c.available ? "info" : "warn")}
                </div>
              </div>
            `).join("")}
          </div>
        </section>
      </div>

      <section class="panel-card" style="margin-top:24px; padding:20px;">
        <div class="card-head" style="margin-bottom:12px;">
          <div class="eyebrow">Logs</div>
          <button class="secondary-btn" style="padding:4px 12px; font-size:0.8rem;" onclick="this.getRootNode().host.fetchLogs()">Refresh</button>
        </div>
        <div class="log-view" style="max-height:200px; font-size:0.75rem; padding:12px;">
          ${this.logs.slice(-20).map(line => `<div style="padding:2px 0; border-bottom:1px solid rgba(255,255,255,0.05); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(line)}</div>`).join("")}
        </div>
      </section>
    `;
  }

  renderHome(agsState) {
    const ags = this.getAgsState();
    return `
      <div class="grid home-grid" style="grid-template-columns: 400px 1fr; max-width: 1200px; margin: 0 auto; gap: 24px; align-items: stretch; height: calc(100vh - 240px);">

        <section class="home-dashboard-wrap" style="display:flex; flex-direction:column; height: 100%;">
          <ags-media-card class="embedded-dashboard" style="width:100%; flex: 1;"></ags-media-card>
        </section>
        <section class="panel-card" style="padding:20px; border-radius:24px; display:flex; flex-direction:column; height: 100%; overflow: hidden;">
          <div class="card-head" style="margin-bottom:12px; flex-shrink: 0;">
            <div>
              <div class="eyebrow">System Status</div>
              <h3>Active Entities</h3>
            </div>
          </div>
          <div style="flex: 1; overflow-y: auto; padding-right: 4px; scroll-behavior: smooth;">
            ${this.renderEntitiesContent()}
          </div>
        </section>
      </div>
    `;
  }

  renderEntitiesContent() {
    const entities = Object.values(this.hass.states)
      .filter((entity) => {
        if (entity.entity_id === "media_player.ags_media_player") return true;
        if (entity.entity_id.includes("ags_")) return true;
        return entity.entity_id.startsWith("switch.") && entity.entity_id.endsWith("_media");
      })
      .sort((left, right) => left.entity_id.localeCompare(right.entity_id));

    return `
      <div class="table">
        <div class="table-row table-head" style="grid-template-columns: 1.5fr 1fr 80px; padding: 0 16px;">
          <div>Entity ID</div>
          <div>Status</div>
          <div style="text-align:right;">Action</div>
        </div>
        ${entities
          .map((entity) => {
            const isToggle = entity.entity_id.startsWith("switch.");
            return `
              <div class="table-row" style="grid-template-columns: 1.5fr 1fr 80px; padding: 12px 16px; margin-bottom: 8px;">
                <div class="mono" style="font-size:0.75rem; opacity:0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 8px;">${this.escapeHtml(entity.entity_id)}</div>
                <div style="display: flex;">${this.renderStatusPill(entity.state)}</div>
                <div style="text-align:right;">
                  ${
                    isToggle
                      ? `<button class="secondary-btn" style="padding:4px 8px; font-size:0.7rem; min-width: 60px;" onclick="this.getRootNode().host.hass.callService('switch', '${entity.state === "on" ? "turn_off" : "turn_on"}', { entity_id: '${entity.entity_id}' })">Toggle</button>`
                      : '<span class="muted" style="font-size:0.7rem;">Fixed</span>'
                  }
                </div>
              </div>
            `;
          })
          .join("")}
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
    const stateText = stateObj?.state || "Unknown";
    const friendlyName = stateObj?.attributes?.friendly_name || device.device_id || "Select Entity";
    const deviceKey = `${roomIndex}:${deviceIndex}`;
    const isEditing = this.editingDeviceKey === deviceKey;

    return `
      <div class="device-card" style="border-radius:24px; background:rgba(var(--rgb-primary-text-color), 0.03);">
        <div class="device-summary" style="align-items:center;">
          <div style="display:flex; align-items:center; gap:16px;">
            <div style="width:40px; height:40px; border-radius:10px; background:var(--ags-primary); display:flex; align-items:center; justify-content:center; color:#fff;">
              <ha-icon icon="${device.device_type === 'tv' ? 'mdi:television' : 'mdi:speaker'}"></ha-icon>
            </div>
            <div>
              <div class="section-title" style="margin:0; font-size:1.1rem;">${this.escapeHtml(friendlyName)}</div>
              <div class="section-help">${this.escapeHtml(device.device_id)}</div>
            </div>
          </div>
          <div class="header-meta">
            ${this.renderTonePill(stateText, stateObj ? "info" : "warn")}
            <button class="secondary-btn" style="padding:6px 14px; font-size:0.85rem;" onclick="this.getRootNode().host.setEditingDevice('${deviceKey}')">${isEditing ? "Close" : "Edit"}</button>
            <button class="danger-btn" style="padding:6px 14px; font-size:0.85rem;" onclick="this.getRootNode().host.removeAt('rooms.${roomIndex}.devices', ${deviceIndex})">Remove</button>
          </div>
        </div>

        ${isEditing ? `
          <div style="margin-top:24px; padding-top:24px; border-top:1px solid var(--ags-border);">
            <div class="grid cols-2" style="gap:20px;">
              ${this.renderEntityField("Media Player Entity", `rooms.${roomIndex}.devices.${deviceIndex}.device_id`, device.device_id, ["media_player"])}
                <div class="grid cols-2" style="gap:16px;">
                  <div>
                    <label>Device Type</label>
                    <select onchange="this.getRootNode().host.updateConfig('rooms.${roomIndex}.devices.${deviceIndex}.device_type', this.value); this.getRootNode().host.render();">
                    <option value="speaker" ${device.device_type === "speaker" ? "selected" : ""}>Speaker</option>
                    <option value="tv" ${device.device_type === "tv" ? "selected" : ""}>Television</option>
                  </select>
                </div>
                  <div>
                    <label>Election Priority</label>
                  <input type="number" min="1" max="${this.config.rooms[roomIndex].devices.length}" value="${device.priority}" onchange="this.getRootNode().host.setDevicePriority(${roomIndex}, ${deviceIndex}, this.value)" />
                  </div>
                </div>
              </div>

            ${device.device_type === "tv" ? `
              <div class="grid cols-2" style="margin-top:20px; gap:20px;">
                <div>
                  <label>TV Behavior</label>
                  <select onchange="this.getRootNode().host.updateConfig('rooms.${roomIndex}.devices.${deviceIndex}.tv_mode', this.value)">
                    <option value="tv_audio" ${device.tv_mode === "tv_audio" ? "selected" : ""}>TV Audio (Include Room)</option>
                    <option value="no_music" ${device.tv_mode === "no_music" ? "selected" : ""}>No Music (Isolate Room)</option>
                  </select>
                </div>
                ${this.renderEntityField("Target OTT Player", `rooms.${roomIndex}.devices.${deviceIndex}.ott_device`, device.ott_device, ["media_player"], { helper: "Default player for this TV." })}
              </div>
              <div style="margin-top:20px;">
                ${this.renderOttMappings(roomIndex, deviceIndex, device)}
              </div>
            ` : ""}

            <div style="margin-top:24px;">
              ${this.renderOverrides(roomIndex, deviceIndex, device)}
            </div>

            <div style="margin-top:24px;">
              <label>Off Override</label>
              <input type="text" placeholder="Title/Source keyword to trigger override" value="${this.escapeHtml(device.override_content || "")}" onchange="this.getRootNode().host.updateConfig('rooms.${roomIndex}.devices.${deviceIndex}.override_content', this.value)" />
            </div>
          </div>
        ` : ""}
      </div>
    `;
  }

  renderRooms() {
    this.ensureRoomSelection();
    const room = this.config.rooms[this.selectedRoomIdx];

    return `
      <div class="room-layout">
        <aside class="panel-card" style="padding:24px;">
          <div class="eyebrow">House Map</div>
          <h3 style="margin-bottom:20px;">Rooms</h3>
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
                        <span class="status-pill ${index === this.selectedRoomIdx ? 'active' : 'status-off'}" style="padding:4px 10px; font-size:0.7rem;">${entry.devices.length}</span>
                      </button>
                    `,
                  )
                  .join("")
              : '<div class="empty-state">No rooms yet.</div>'}
          </div>
          <button class="primary-btn" style="width:100%; margin-top:20px;" onclick="this.getRootNode().host.addRoom()">+ Add Room</button>
        </aside>

        <section class="panel-card">
          ${
            room
              ? `
                <div class="card-head">
                  <div>
                    <div class="eyebrow">Configuration</div>
                    <h3>${this.escapeHtml(room.room)} Details</h3>
                  </div>
                  <button class="danger-btn" onclick="this.getRootNode().host.deleteRoom(${this.selectedRoomIdx})">Delete Room</button>
                </div>

                <div class="inline-grid">
                  <div>
                    <label>Room Name</label>
                    <input
                      type="text"
                      value="${this.escapeHtml(room.room)}"
                      onchange="this.getRootNode().host.updateConfig('rooms.${this.selectedRoomIdx}.room', this.value); this.getRootNode().host.render();"
                    />
                  </div>
                  <div>
                    <label>Switch Entity</label>
                    <div class="mono" style="background:rgba(var(--rgb-primary-text-color), 0.03); padding:12px; border-radius:12px; border:1px solid var(--ags-border);">switch.${this.escapeHtml(this.slugify(room.room))}_media</div>
                  </div>
                </div>

                <div class="eyebrow" style="margin:32px 0 16px;">Devices</div>
                <div class="stack">
                  ${room.devices.length
                    ? room.devices
                        .map((device, deviceIndex) =>
                          this.renderDeviceCard(this.selectedRoomIdx, deviceIndex, device),
                        )
                        .join("")
                    : '<div class="empty-state">No devices in this room.</div>'}
                </div>

                <button class="primary-btn" style="margin-top:24px;" onclick="this.getRootNode().host.addDevice(${this.selectedRoomIdx})">+ Add Device</button>
              `
              : `
                <div class="empty-state">
                  Select a room to configure its speakers and TVs.
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
            <div class="eyebrow">Library</div>
            <h3>Music Sources</h3>
          </div>
          <div class="header-meta">
            <button class="secondary-btn" onclick="this.getRootNode().host.importSpeakerSourceList()">Import</button>
            <button class="secondary-btn" onclick="this.getRootNode().host.browseMediaFavorites()">Browse</button>
            <button class="primary-btn" onclick="this.getRootNode().host.addSource()">+ New Source</button>
          </div>
        </div>
        
        ${this.favoriteBrowseError ? `
          <div class="status-pill status-warn" style="margin-bottom:20px; width:100%; display:block; text-align:center;">
            ${this.escapeHtml(this.favoriteBrowseError)}
          </div>
        ` : ""}

        ${this.browseItems.length || this.discoveredFavorites.length || this.browsePath.length ? `
          <div class="panel-card" style="margin-bottom:32px; background:rgba(var(--rgb-primary-text-color), 0.02); border:2px dashed var(--ags-border); padding:24px;">
            <div class="card-head" style="margin-bottom:16px;">
              <div>
                <div class="eyebrow">Browse Results</div>
                <div class="section-help">${this.escapeHtml(this.browsePath.map(e => e.title).join(" / ") || "Top level")}</div>
              </div>
              <button class="secondary-btn" onclick="this.getRootNode().host.browseBack()">${this.browsePath.length ? "Back" : "Clear"}</button>
            </div>
            <div class="browse-results-grid">
              ${this.browseItems.map((item, index) => `
                <div class="browse-result-card" onclick="this.getRootNode().host.openBrowseItem(${index})">
                  <div class="browse-result-art">
                    ${item.thumbnail ? `<img src="${this.resolveMediaUrl(item.thumbnail)}" style="width:100%; height:100%; object-fit:cover;" />` : `
                      <div style="width:100%; height:100%; background:rgba(var(--rgb-primary-text-color), 0.05); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                        <ha-icon icon="${item.can_expand ? 'mdi:folder' : 'mdi:music-note'}"></ha-icon>
                      </div>
                    `}
                  </div>
                  <div class="browse-result-copy">
                    <div style="font-weight:700; font-size:0.95rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(item.title || "Untitled")}</div>
                    <div class="section-help" style="font-size:0.78rem;">${this.escapeHtml(item.media_content_type || "media")}</div>
                  </div>
                  <button class="secondary-btn" style="padding:4px 10px; font-size:0.75rem; flex-shrink:0;">${item.can_expand ? "Open" : "Add"}</button>
                </div>
              `).join("")}
            </div>
          </div>
        ` : ""}

        <div class="grid cols-2">
          ${this.config.Sources.length ? this.config.Sources.map((source, index) => `
            <div class="source-card" style="padding:20px; border-radius:20px;">
              <div class="card-head" style="margin-bottom:16px;">
                <div style="display:flex; align-items:center; gap:10px;">
                  <div style="width:24px; height:24px; border-radius:6px; background:var(--ags-primary); color:#fff; display:flex; align-items:center; justify-content:center; font-size:0.75rem; font-weight:900;">${index + 1}</div>
                  <h4 style="margin:0; font-size:1rem; font-weight:800;">${this.escapeHtml(source.Source || "Unnamed Source")}</h4>
                </div>
                <button class="danger-btn" style="padding:4px 10px; font-size:0.75rem;" onclick="this.getRootNode().host.removeAt('Sources', ${index})">Delete</button>
              </div>
              <div class="stack" style="gap:16px;">
                <div class="grid cols-2" style="gap:12px;">
                  <div>
                    <label style="font-size:0.75rem;">Label</label>
                    <input type="text" style="padding:8px 12px; font-size:0.9rem;" value="${this.escapeHtml(source.Source)}" onchange="this.getRootNode().host.updateConfig('Sources.${index}.Source', this.value)" />
                  </div>
                  <div>
                    <label style="font-size:0.75rem;">Type</label>
                    <select style="padding:8px 12px; font-size:0.9rem;" onchange="this.getRootNode().host.updateConfig('Sources.${index}.media_content_type', this.value)">
                      <option value="favorite_item_id" ${source.media_content_type === "favorite_item_id" ? "selected" : ""}>Sonos Fav</option>
                      <option value="playlist" ${source.media_content_type === "playlist" ? "selected" : ""}>Playlist</option>
                      <option value="music" ${source.media_content_type === "music" ? "selected" : ""}>Music/URL</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label style="font-size:0.75rem;">Value</label>
                  <input type="text" style="padding:8px 12px; font-size:0.9rem;" value="${this.escapeHtml(source.Source_Value)}" onchange="this.getRootNode().host.updateConfig('Sources.${index}.Source_Value', this.value)" />
                </div>
                <label class="list-select" style="margin:0; border:none; background:rgba(var(--rgb-primary-text-color), 0.03); padding:8px 16px;">
                  <span style="font-size:0.8rem; font-weight:700;">Set Default</span>
                  <input type="checkbox" style="width:18px; height:18px;" ${source.source_default ? "checked" : ""} onchange="this.getRootNode().host.setSourceDefault(${index}, this.checked)" />
                </label>
              </div>
            </div>
          `).join("") : '<div class="empty-state">No sources defined yet.</div>'}
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
              <div class="eyebrow">Core</div>
              <h3>System Settings</h3>
            </div>
          </div>
          <div class="stack">
            <div>
              <label>AGS Display Name</label>
              <input
                type="text"
                placeholder="e.g. Whole Home Audio"
                value="${this.escapeHtml(this.config.static_name || "")}"
                onchange="this.getRootNode().host.updateConfig('static_name', this.value)"
              />
              <div class="section-help" style="margin-top:8px;">Sets the name of the primary AGS media player.</div>
            </div>

            <div style="margin-top:24px;">
              ${this.renderEntityField(
                "HomeKit Bridge Player",
                "homekit_player",
                this.config.homekit_player || "",
                ["media_player"],
                { helper: "Mirror this entity for Apple Home integration." }
              )}
            </div>

            <div class="grid" style="margin-top:32px; gap:12px;">
              <label class="list-select" style="margin:0;">
                <span>Default enabled on boot</span>
                <input type="checkbox" style="width:20px; height:20px;" ${this.config.default_on ? "checked" : ""} onchange="this.getRootNode().host.updateConfig('default_on', this.checked)" />
              </label>

              <label class="list-select" style="margin:0;">
                <span>Expose diagnostic sensors</span>
                <input type="checkbox" style="width:20px; height:20px;" ${this.config.create_sensors ? "checked" : ""} onchange="this.getRootNode().host.updateConfig('create_sensors', this.checked)" />
              </label>

              <label class="list-select" style="margin:0;">
                <span>Enable batch ungrouping</span>
                <input type="checkbox" style="width:20px; height:20px;" ${this.config.batch_unjoin ? "checked" : ""} onchange="this.getRootNode().host.updateConfig('batch_unjoin', this.checked)" />
              </label>

              <label class="list-select" style="margin:0;">
                <span>Ignore occupancy (zone.home)</span>
                <input type="checkbox" style="width:20px; height:20px;" ${this.config.disable_zone ? "checked" : ""} onchange="this.getRootNode().host.updateConfig('disable_zone', this.checked)" />
              </label>

              <label class="list-select" style="margin:0;">
                <span>Persistent TV source</span>
                <input type="checkbox" style="width:20px; height:20px;" ${this.config.disable_Tv_Source ? "checked" : ""} onchange="this.getRootNode().host.updateConfig('disable_Tv_Source', this.checked)" />
              </label>
            </div>
          </div>
        </section>

        <section class="panel-card">
          <div class="card-head">
            <div>
              <div class="eyebrow">Automations</div>
              <h3>Schedules</h3>
            </div>
          </div>
          <div class="stack">
            <div class="device-card" style="padding:24px;">
              <div class="card-head" style="margin-bottom:16px;">
                <div>
                  <div style="font-weight:800; font-size:1.1rem;">Media System Schedule</div>
                  <div class="section-help">Disable AGS during specific hours.</div>
                </div>
                <button class="secondary-btn" onclick="this.getRootNode().host.ensureScheduleEntity(); this.getRootNode().host.render();">
                  ${schedule ? "Edit" : "Enable"}
                </button>
              </div>
              ${schedule ? `
                <div class="stack">
                  ${this.renderEntityField("Schedule Entity", "schedule_entity.entity_id", schedule.entity_id || "", ["schedule", "input_boolean"])}
                  <div class="inline-grid" style="margin:0;">
                    <div>
                      <label>On State</label>
                      <input type="text" value="${this.escapeHtml(schedule.on_state || "on")}" onchange="this.getRootNode().host.updateConfig('schedule_entity.on_state', this.value)" />
                    </div>
                    <div>
                      <label>Off State</label>
                      <input type="text" value="${this.escapeHtml(schedule.off_state || "off")}" onchange="this.getRootNode().host.updateConfig('schedule_entity.off_state', this.value)" />
                    </div>
                  </div>
                  <label class="list-select" style="margin-top:12px; border:none; background:transparent; padding:0;">
                    <span style="font-size:0.9rem;">Allow manual override when off</span>
                    <input type="checkbox" style="width:20px; height:20px;" ${schedule.schedule_override ? "checked" : ""} onchange="this.getRootNode().host.updateConfig('schedule_entity.schedule_override', this.checked)" />
                  </label>
                  <button class="danger-btn" style="margin-top:12px;" onclick="this.getRootNode().host.config.schedule_entity = null; this.getRootNode().host.render();">Remove</button>
                </div>
              ` : ''}
            </div>

            <div class="device-card" style="padding:24px; margin-top:24px;">
              <div class="card-head" style="margin-bottom:16px;">
                <div>
                  <div style="font-weight:800; font-size:1.1rem;">Default Source Schedule</div>
                  <div class="section-help">Switch music based on time of day.</div>
                </div>
                <button class="secondary-btn" onclick="this.getRootNode().host.ensureDefaultSourceSchedule(); this.getRootNode().host.render();">
                  ${defaultSourceSchedule ? "Edit" : "Enable"}
                </button>
              </div>
              ${defaultSourceSchedule ? `
                <div class="stack">
                  ${this.renderEntityField("Trigger Entity", "default_source_schedule.entity_id", defaultSourceSchedule.entity_id || "", ["schedule", "input_boolean"])}
                  <div>
                    <label>Target Favorite</label>
                    <select onchange="this.getRootNode().host.updateConfig('default_source_schedule.source_name', this.value)">
                      <option value="">Select source</option>
                      ${this.config.Sources.map(s => `<option value="${this.escapeHtml(s.Source)}" ${s.Source === defaultSourceSchedule.source_name ? "selected" : ""}>${this.escapeHtml(s.Source)}</option>`).join("")}
                    </select>
                  </div>
                  <button class="danger-btn" style="margin-top:12px;" onclick="this.getRootNode().host.config.default_source_schedule = null; this.getRootNode().host.render();">Remove</button>
                </div>
              ` : ''}
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
    const activeRooms = Array.isArray(attributes.active_rooms) ? attributes.active_rooms : [];
    const headerInfo = activeRooms.length > 0 ? `Active in ${activeRooms[0]}${activeRooms.length > 1 ? ` + ${activeRooms.length-1}` : ''}` : 'System Idle';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          min-height: 100vh;
          background: rgba(17, 24, 39, 1);
          color: var(--primary-text-color, #111827);
          font-family: var(--ha-font-family-body, Roboto, sans-serif);
          --ags-primary: var(--primary-color, #ff9800);
          --ags-surface: rgba(var(--rgb-card-background-color), 0.82);
          --ags-surface-soft: rgba(var(--rgb-card-background-color), 0.64);
          --ags-glass: rgba(var(--rgb-card-background-color), 0.5);
          --ags-border: rgba(var(--rgb-primary-text-color), 0.12);
          --ags-shadow: 0 18px 48px rgba(15, 23, 42, 0.16);
          --ags-muted: var(--secondary-text-color, #6b7280);
        }

        * {
          box-sizing: border-box;
        }

        .shell {
          max-width: 1400px;
          margin: 0 auto;
          padding: 24px 32px 100px;
          min-height: 100vh;
        }

        .page-header {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 20px;
          margin-bottom: 24px;
        }

        .title-block h1 {
          margin: 0;
          font-size: 2.2rem;
          font-weight: 900;
          line-height: 1;
          letter-spacing: -0.04em;
          background: linear-gradient(135deg, var(--ags-primary), rgba(var(--rgb-primary-color), 0.6));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .title-block p {
          margin: 8px 0 0;
          color: var(--ags-muted);
          font-size: 1rem;
          font-weight: 600;
          max-width: 600px;
        }

        .header-meta {
          display: flex;
          gap: 12px;
          align-items: center;
        }

        .tabs {
          display: flex;
          gap: 8px;
          margin-bottom: 32px;
          overflow-x: auto;
          padding-bottom: 8px;
          scrollbar-width: none;
        }

        .tabs::-webkit-scrollbar { display: none; }

        .tab-btn {
          border: 1px solid var(--ags-border);
          border-radius: 12px;
          background: var(--ags-glass);
          color: var(--primary-text-color);
          cursor: pointer;
          font: inherit;
          padding: 12px 20px;
          font-weight: 700;
          white-space: nowrap;
          transition: all 0.2s ease;
        }

        .tab-btn:hover {
          background: rgba(var(--rgb-primary-text-color), 0.05);
          border-color: rgba(var(--rgb-primary-color), 0.3);
        }

        .tab-btn.active {
          background: var(--ags-primary);
          color: #fff;
          border-color: var(--ags-primary);
          box-shadow: 0 8px 20px rgba(var(--rgb-primary-color), 0.25);
        }

        .primary-btn {
          background: var(--ags-primary);
          color: #fff;
          border: none;
          padding: 12px 24px;
          border-radius: 12px;
          font-weight: 800;
          cursor: pointer;
          box-shadow: 0 8px 20px rgba(var(--rgb-primary-color), 0.3);
          transition: all 0.2s ease;
        }

        .primary-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 25px rgba(var(--rgb-primary-color), 0.4);
        }

        .secondary-btn, .danger-btn {
          padding: 10px 18px;
          border-radius: 10px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.2s ease;
          border: 1px solid var(--ags-border);
          background: var(--ags-glass);
          color: var(--primary-text-color);
        }

        .secondary-btn:hover {
          background: rgba(var(--rgb-primary-text-color), 0.05);
        }

        .danger-btn {
          color: var(--error-color);
          border-color: rgba(var(--rgb-error-color), 0.2);
        }

        .danger-btn:hover {
          background: rgba(var(--rgb-error-color), 0.1);
        }

        .save-bar {
          position: fixed;
          bottom: 0;
          right: 0;
          left: 0;
          display: flex;
          justify-content: center;
          padding: 24px;
          background: linear-gradient(0deg, var(--primary-background-color) 0%, transparent 100%);
          z-index: 100;
          pointer-events: none;
        }

        .save-bar .primary-btn {
          pointer-events: auto;
          padding: 16px 48px;
          border-radius: 24px;
          font-size: 1.1rem;
          backdrop-filter: blur(20px);
          border: 1px solid rgba(255,255,255,0.1);
        }

        .panel-card {
          background: var(--ags-surface);
          backdrop-filter: blur(20px);
          border: 1px solid var(--ags-border);
          border-radius: 28px;
          padding: 32px;
          box-shadow: var(--ags-shadow);
        }

        .grid {
          display: grid;
          gap: 24px;
        }

        .cols-2 {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .home-grid {
          grid-template-columns: 1fr 1fr;
          align-items: start;
        }

        .room-layout {
          display: grid;
          grid-template-columns: 320px 1fr;
          gap: 32px;
        }

        .card-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 20px;
          margin-bottom: 24px;
        }

        .card-head h3 {
          margin: 4px 0 0;
          font-size: 1.5rem;
          font-weight: 800;
          letter-spacing: -0.02em;
        }

        .eyebrow {
          text-transform: uppercase;
          letter-spacing: 0.1em;
          font-size: 0.8rem;
          font-weight: 800;
          color: var(--ags-primary);
        }

        .metric-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
          margin-top: 24px;
        }

        .metric-card {
          background: rgba(var(--rgb-primary-text-color), 0.03);
          border: 1px solid var(--ags-border);
          border-radius: 20px;
          padding: 20px;
        }

        .metric-label {
          color: var(--ags-muted);
          font-size: 0.85rem;
          font-weight: 700;
          text-transform: uppercase;
        }

        .metric-value {
          font-size: 1.5rem;
          font-weight: 900;
          margin-top: 4px;
          color: var(--ags-primary);
        }

        .status-pill {
          padding: 8px 16px;
          border-radius: 12px;
          font-weight: 800;
          font-size: 0.85rem;
          text-transform: uppercase;
          background: rgba(var(--rgb-primary-color), 0.1);
          color: var(--primary-color);
          border: 1px solid rgba(var(--rgb-primary-color), 0.2);
        }

        .status-off {
          background: rgba(var(--rgb-primary-text-color), 0.05);
          color: var(--ags-muted);
          border-color: var(--ags-border);
        }

        .table {
          width: 100%;
          border-collapse: separate;
          border-spacing: 0 12px;
        }

        .table-row {
          display: grid;
          grid-template-columns: 1.5fr 1fr 100px 100px;
          gap: 16px;
          align-items: center;
          padding: 16px 24px;
          background: rgba(var(--rgb-primary-text-color), 0.02);
          border: 1px solid var(--ags-border);
          border-radius: 16px;
          transition: all 0.2s ease;
        }

        .table-row:hover {
          background: rgba(var(--rgb-primary-text-color), 0.04);
          transform: scale(1.01);
        }

        .table-head {
          background: transparent !important;
          border: none !important;
          padding: 0 24px;
          font-weight: 800;
          font-size: 0.8rem;
          text-transform: uppercase;
          color: var(--ags-muted);
        }

        .mono {
          font-family: var(--code-font-family, monospace);
          font-size: 0.9rem;
          color: var(--ags-primary);
          font-weight: 600;
        }

        .list-select {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-radius: 16px;
          text-align: left;
          background: rgba(var(--rgb-primary-text-color), 0.02);
          border: 1px solid var(--ags-border);
          color: var(--primary-text-color);
          cursor: pointer;
          font-weight: 700;
          margin-bottom: 8px;
          transition: all 0.2s ease;
        }

        .list-select.active {
          background: rgba(var(--rgb-primary-color), 0.1);
          border-color: var(--ags-primary);
          color: var(--ags-primary);
        }

        .device-card, .source-card {
          background: rgba(var(--rgb-primary-text-color), 0.02);
          border: 1px solid var(--ags-border);
          border-radius: 20px;
          padding: 24px;
          margin-bottom: 16px;
        }

        .device-summary {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
        }

        .section-title {
          font-size: 1.2rem;
          font-weight: 800;
          margin-bottom: 4px;
        }

        .section-help {
          color: var(--ags-muted);
          font-size: 0.9rem;
          font-weight: 500;
        }

        input, select {
          width: 100%;
          background: var(--ags-surface-soft);
          border: 1px solid var(--ags-border);
          border-radius: 12px;
          padding: 12px 16px;
          color: var(--primary-text-color);
          font: inherit;
          font-weight: 600;
          transition: all 0.2s ease;
        }

        input:focus, select:focus {
          outline: none;
          border-color: var(--ags-primary);
          background: rgba(var(--rgb-primary-text-color), 0.05);
        }

        .inline-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 20px;
          margin: 20px 0;
        }

        label {
          display: block;
          margin-bottom: 8px;
          font-size: 0.85rem;
          font-weight: 800;
          text-transform: uppercase;
          color: var(--ags-muted);
        }

        .entity-field {
          display: flex;
          flex-direction: column;
          gap: 0;
        }

        .entity-field ha-entity-picker {
          display: block;
          width: 100%;
        }

        .entity-helper {
          margin-top: 6px;
          font-size: 0.8rem;
          color: var(--ags-muted);
          font-weight: 500;
        }

        .loading,
        .error {
          text-align: center;
          font-weight: 700;
        }

        .error {
          color: var(--error-color);
          border-color: rgba(var(--rgb-error-color), 0.24);
          background: rgba(var(--rgb-error-color), 0.08);
        }

        .browse-results-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 14px;
        }

        .browse-result-card {
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 12px;
          border-radius: 18px;
          background: var(--ags-surface-soft);
          border: 1px solid var(--ags-border);
          cursor: pointer;
          transition: transform 0.2s ease, border-color 0.2s ease;
        }

        .browse-result-card:hover {
          transform: translateY(-2px);
          border-color: rgba(var(--rgb-primary-color), 0.28);
        }

        .browse-result-art {
          aspect-ratio: 1.1 / 1;
          overflow: hidden;
          border-radius: 16px;
          background:
            linear-gradient(140deg, rgba(var(--rgb-primary-color), 0.18), rgba(var(--rgb-primary-text-color), 0.04)),
            rgba(var(--rgb-primary-text-color), 0.04);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .browse-result-copy {
          min-width: 0;
        }

        .log-view {
          background: #0d1117;
          color: #e6edf3;
          padding: 24px;
          border-radius: 20px;
          font-family: var(--code-font-family, monospace);
          font-size: 0.9rem;
          line-height: 1.6;
          max-height: 500px;
          overflow-y: auto;
          border: 1px solid var(--ags-border);
        }

        @media (max-width: 1024px) {
          .shell { padding: 24px 16px 100px; }
          .home-grid, .cols-2, .room-layout { grid-template-columns: 1fr; }
          .table-row { grid-template-columns: 1fr 1fr; }
          .table-head { display: none; }
        }
      </style>

      <div class="shell">
        <div class="page-header">
          <div class="title-block">
            <h1>AGS Service</h1>
            <p>${this.escapeHtml(headerInfo)}</p>
          </div>
          <div class="header-meta">
            ${this.renderStatusPill(status)}
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
