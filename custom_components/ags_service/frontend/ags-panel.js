class AGSPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._hasRendered = false;
    this._lastAgsSignature = "";
    this.config = null;
    this.logs = [];
    this.activeTab = "home";
    this.selectedRoomIdx = 0;
    this.loading = false;
    this.error = "";
    this._lastThemeSignature = "";
    this.discoveredFavorites = [];
    this.favoriteBrowseError = "";
    this.browseItems = [];
    this.browsePath = [];
    this.editingDeviceKey = null;
    this._resetScrollAfterRender = false;
    this.loadingBrowseResults = false;
    this.refreshingSources = false;
    this.loadingSourceCatalog = false;
    this.browserCatalogSources = [];
    this._sourceCatalogLoaded = false;
    this._initRunId = 0;
    this.sourceSearch = "";
    this.sourcesFolderView = false;
    this.roomsSubTab = "room";
    this.areaImportOpen = false;
    this.areaImportLoading = false;
    this.areaImportError = "";
    this.haAreas = [];
    this.draggingDeviceKey = null;
    this.draggingSourceId = null;
    this._configDirty = false;
    this._savingConfig = false;
    this._saveStatus = "";
    this._stopInputPropagation = this.stopInputPropagation.bind(this);
  }

  connectedCallback() {
    this.shadowRoot.addEventListener("keydown", this._stopInputPropagation, true);
    this.shadowRoot.addEventListener("keypress", this._stopInputPropagation, true);
    this.shadowRoot.addEventListener("keyup", this._stopInputPropagation, true);
  }

  disconnectedCallback() {
    this.shadowRoot.removeEventListener("keydown", this._stopInputPropagation, true);
    this.shadowRoot.removeEventListener("keypress", this._stopInputPropagation, true);
    this.shadowRoot.removeEventListener("keyup", this._stopInputPropagation, true);
    if (this._configDirty) {
      this.saveConfig({ silent: true });
    }
  }

  stopInputPropagation(event) {
    const path = event.composedPath ? event.composedPath() : [];
    const isTextInput = path.some((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const tag = node.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "HA-ENTITY-PICKER";
    });
    if (isTextInput) {
      event.stopPropagation();
    }
  }

  set hass(hass) {
    const oldHass = this._hass;
    this._hass = hass;

    if (!oldHass && hass) {
      this.initData();
      return;
    }

    if (hass && this.config) {
      const nextSignature = this.getAgsStateSignature();
      const nextThemeSignature = this.getThemeSignature();

      if (!this._hasRendered) {
        this.render();
        return;
      }

      if (nextThemeSignature !== this._lastThemeSignature) {
        this.render();
        return;
      }

      if (this.activeTab === "home") {
        this.updateLiveHeader();
        this.updateHomeEntitiesContent();
        this.bindEmbeddedDashboard();
      } else if ((this.activeTab === "diagnostics" || this.activeTab === "sources") && nextSignature !== this._lastAgsSignature) {
        this.render();
      }

      this._lastAgsSignature = nextSignature;
      this._lastThemeSignature = nextThemeSignature;
    }
  }

  get hass() {
    return this._hass;
  }

  isScrollableNode(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const style = window.getComputedStyle(node);
    const overflowY = `${style.overflowY} ${style.overflow}`;
    const overflowX = `${style.overflowX} ${style.overflow}`;
    const canScrollY = /(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight;
    const canScrollX = /(auto|scroll|overlay)/.test(overflowX) && node.scrollWidth > node.clientWidth;
    return canScrollY || canScrollX || Boolean(node.scrollTop || node.scrollLeft);
  }

  getShadowScrollSelector(node) {
    if (!(node instanceof HTMLElement)) {
      return null;
    }
    const stableClasses = [
      "shell",
      "tabs",
      "home-entities-scroll",
      "log-view",
      "source-list-scroll",
    ];
    const stableClass = stableClasses.find((className) => node.classList.contains(className));
    if (stableClass) {
      return `.${stableClass}`;
    }
    return null;
  }

  getScrollTargets() {
    const targets = [];
    const seen = new Set();

    if (this.shadowRoot) {
      const shadowCandidates = [
        this.shadowRoot.querySelector(".shell"),
        ...this.shadowRoot.querySelectorAll(".tabs, .home-entities-scroll, .log-view, .source-list-scroll"),
      ].filter(Boolean);

      shadowCandidates.forEach((node) => {
        const selector = this.getShadowScrollSelector(node);
        if (!selector || seen.has(`shadow:${selector}`) || !this.isScrollableNode(node)) {
          return;
        }
        targets.push({ node, key: `shadow:${selector}` });
        seen.add(`shadow:${selector}`);
      });
    }

    let node = this;

    while (node) {
      node = node.parentNode || node.host || null;

      if (node instanceof HTMLElement) {
        if (this.isScrollableNode(node) && !seen.has(node)) {
          targets.push({ node, key: null });
          seen.add(node);
        }
        continue;
      }

      if (node instanceof Document) {
        const scrollRoot = node.scrollingElement || node.documentElement;
        if (scrollRoot && !seen.has(scrollRoot)) {
          targets.push({ node: scrollRoot, key: "document" });
        }
        break;
      }
    }

    return targets;
  }

  captureScrollState() {
    return {
      targets: this.getScrollTargets().map((target) => ({
        key: target.key,
        node: target.key ? null : target.node,
        top: target.node.scrollTop,
        left: target.node.scrollLeft,
      })),
      windowX: window.scrollX,
      windowY: window.scrollY,
    };
  }

  resolveScrollTarget(target) {
    if (!target) {
      return null;
    }
    if (target.key === "document") {
      return document.scrollingElement || document.documentElement;
    }
    if (target.key?.startsWith("shadow:")) {
      return this.shadowRoot?.querySelector(target.key.slice("shadow:".length)) || null;
    }
    return target.node && target.node.isConnected !== false ? target.node : null;
  }

  restoreScrollState(state, resetToTop = false) {
    if (!state) return;

    state.targets.forEach((target) => {
      const node = this.resolveScrollTarget(target);
      if (!node) return;
      const { top, left } = target;
      node.scrollTop = resetToTop ? 0 : top;
      node.scrollLeft = resetToTop ? 0 : left;
    });

    window.scrollTo({
      left: resetToTop ? 0 : state.windowX,
      top: resetToTop ? 0 : state.windowY,
      behavior: "auto",
    });
  }

  async initData() {
    if (!this.hass) {
      return;
    }

    const runId = ++this._initRunId;
    this.loading = true;
    this.error = "";
    this.render();

    try {
      let config = null;
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          config = await this.hass.callWS({ type: "ags_service/config/get" });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
        }
      }
      if (lastError) {
        throw lastError;
      }
      if (runId !== this._initRunId) {
        return;
      }
      this.config = this.normalizeConfig(config);
      this.ensureRoomSelection();
      this._configDirty = false;
      this._saveStatus = "";

      this.loading = false;
      this.render();

      this.hass.callWS({ type: "ags_service/get_logs" })
        .then((logs) => {
          if (runId !== this._initRunId) return;
          this.logs = Array.isArray(logs) ? logs : [];
          this.render();
        })
        .catch(() => {});
      return;
    } catch (error) {
      this.error = error.message || String(error);
    }

    this.loading = false;
    this.render();
  }

  normalizeConfig(config) {
    const normalizeEntityValue = (value) => {
      const text = String(value || "").trim().toLowerCase();
      if (!text) {
        return "";
      }
      // Home Assistant entity IDs usually use underscores, but allow dashes just in case for robustness.
      return /^[a-z0-9_-]+\.[a-z0-9_-]+$/.test(text) ? text : "";
    };

    if (!config) {
      return {
        rooms: [],
        source_favorites: [],
        hidden_source_ids: [],
        source_display_names: {},
        default_source_id: null,
        last_discovered_sources: [],
        off_override: false,
        create_sensors: true,
        default_on: false,
        static_name: "",
        disable_tv_source: false,
        interval_sync: 30,
        schedule_entity: null,
        default_source_schedule: null,
        batch_unjoin: false,
      };
    }

    const normalized = {
      rooms: Array.isArray(config.rooms) ? config.rooms : [],
      source_favorites: this.normalizeSourceEntries(
        Array.isArray(config.source_favorites)
          ? config.source_favorites
          : (Array.isArray(config.favorite_sources)
            ? config.favorite_sources
            : (Array.isArray(config.Sources) ? config.Sources : [])),
      ),
      hidden_source_ids: Array.isArray(config.hidden_source_ids)
        ? config.hidden_source_ids.map((id) => String(id || "").trim()).filter(Boolean)
        : (Array.isArray(config.ExcludedSources)
          ? config.ExcludedSources.map((id) => String(id || "").trim()).filter(Boolean)
          : []),
      source_display_names: config.source_display_names && typeof config.source_display_names === "object"
        ? { ...config.source_display_names }
        : {},
      default_source_id: config.default_source_id || null,
      last_discovered_sources: this.normalizeSourceEntries(config.last_discovered_sources || []),
      off_override: Boolean(config.off_override),
      create_sensors: config.create_sensors !== false,
      default_on: Boolean(config.default_on),
      static_name: config.static_name || "",
      disable_tv_source: Boolean(config.disable_tv_source ?? config.disable_Tv_Source),
      interval_sync: Number.isFinite(Number(config.interval_sync)) ? Number(config.interval_sync) : 30,
      schedule_entity: config.schedule_entity || null,
      default_source_schedule: config.default_source_schedule || null,
      batch_unjoin: Boolean(config.batch_unjoin),
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
            .map((device) => {
              const normalizedDevice = { ...device };
              delete normalizedDevice.__sortIndex;
              return normalizedDevice;
            })
        : [];

      return {
        room: room?.room || "New Room",
        ha_area_id: String(room?.ha_area_id || "").trim(),
        ha_area_name: String(room?.ha_area_name || "").trim(),
        ha_area_linked: Boolean(room?.ha_area_linked),
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

    const legacyDefault = normalized.source_favorites.find((source) => source.source_default);
    if (!normalized.default_source_id && legacyDefault) {
      normalized.default_source_id = legacyDefault.id;
    }
    normalized.source_favorites = normalized.source_favorites
      .filter((source) => !this.isLegacyConfigSource(source))
      .map((source, sourceIndex) => ({
        ...source,
        priority: Number.isFinite(Number(source.priority)) && Number(source.priority) > 0
          ? Number(source.priority)
          : sourceIndex + 1,
        source_default: source.id === normalized.default_source_id,
      }))
      .sort((a, b) => (a.priority || 999) - (b.priority || 999));
    if (
      normalized.default_source_id
      && !normalized.source_favorites.some((source) => source.id === normalized.default_source_id)
    ) {
      normalized.default_source_id = normalized.source_favorites[0]?.id || null;
      normalized.source_favorites = normalized.source_favorites.map((source) => ({
        ...source,
        source_default: source.id === normalized.default_source_id,
      }));
    }
    normalized.Sources = normalized.source_favorites;

    if (
      normalized.default_source_schedule &&
      !this.getAllKnownSources(normalized).some(
        (source) => this.getSourceDisplayName(source, normalized) === normalized.default_source_schedule.source_name,
      )
    ) {
      normalized.default_source_schedule = null;
    }

    return normalized;
  }

  getSourceId(source) {
    const mediaType = String(source?.media_content_type || "music").trim() || "music";
    const value = String(source?.Source_Value || source?.value || source?.media_content_id || "").trim();
    return String(source?.id || (value ? `${mediaType}::${value}` : "")).trim();
  }

  getBrowserSourceId(item) {
    const mediaType = String(item?.media_content_type || "music").trim() || "music";
    const value = String(item?.media_content_id || item?.Source_Value || "").trim();
    const title = String(item?.title || item?.Source || "").trim();
    const path = Array.isArray(item?.folder_path)
      ? item.folder_path.map((part) => String(part || "").trim().toLowerCase()).filter(Boolean).join("::")
      : "";
    if (!value) return "";
    return `browser::${[mediaType.toLowerCase(), value.toLowerCase(), ...(path ? path.split("::") : []), title.toLowerCase()].join("::")}`;
  }

  normalizeSourceEntries(sources) {
    const seenIds = new Set();
    const seenNames = new Set();
    return (Array.isArray(sources) ? sources : [])
      .map((source) => {
        const value = String(source?.Source_Value || source?.value || source?.media_content_id || "").trim();
        if (!value) return null;
        const mediaType = String(source?.media_content_type || "music").trim() || "music";
        const id = this.getSourceId({ ...source, Source_Value: value, media_content_type: mediaType });
        const name = String(source?.Source || source?.name || source?.title || value).trim();
        if (!id || !name) return null;
        return {
          id,
          Source: name,
          Source_Value: value,
          media_content_type: mediaType,
          source_default: Boolean(source?.source_default),
          ...(source?.origin ? { origin: String(source.origin) } : {}),
          ...(source?.folder_path ? { folder_path: source.folder_path } : {}),
          ...(source?.priority ? { priority: Number(source.priority) } : {}),
          ...(source?.can_play !== undefined ? { can_play: Boolean(source.can_play) } : {}),
          ...(source?.can_expand !== undefined ? { can_expand: Boolean(source.can_expand) } : {}),
          ...(source?.media_class ? { media_class: String(source.media_class) } : {}),
          ...(Array.isArray(source?.available_on) ? { available_on: source.available_on } : {}),
        };
      })
      .filter((source) => {
        if (!source) return false;
        const nameKey = source.Source.toLowerCase();
        if (seenIds.has(source.id) || seenNames.has(nameKey)) return false;
        seenIds.add(source.id);
        seenNames.add(nameKey);
        return true;
      });
  }

  isLegacyConfigSource(source) {
    const mediaType = String(source?.media_content_type || "").trim().toLowerCase();
    const name = String(source?.Source || source?.name || "").trim();
    const value = String(source?.Source_Value || source?.value || "").trim();
    const id = String(source?.id || "").trim();
    return source?.origin === "legacy_config"
      || (mediaType === "source" && name && name.toLowerCase() === value.toLowerCase() && id.startsWith("source::"));
  }

  getConfigFavoriteSources(config = this.config) {
    return this.normalizeSourceEntries(config?.source_favorites || [])
      .filter((source) => !this.isLegacyConfigSource(source));
  }

  getAgsSourceEntries(attributeName) {
    const ags = this.getAgsState();
    const entries = ags?.attributes?.[attributeName];
    if (!Array.isArray(entries)) return [];
    return this.normalizeSourceEntries(entries.map((source) => ({
      id: source.id,
      Source: source.name || source.Source,
      Source_Value: source.value || source.Source_Value,
      media_content_type: source.media_content_type,
      source_default: source.default || source.source_default,
      folder_path: source.folder_path,
      can_play: source.can_play,
      can_expand: source.can_expand,
      media_class: source.media_class,
      available_on: source.available_on,
    })));
  }

  getAllKnownSources(config = this.config) {
    if (this.browserCatalogSources.length) {
      return this.browserCatalogSources;
    }
    const fromEntity = this.getAgsSourceEntries("ags_all_sources");
    if (fromEntity.length) return fromEntity;

    const sources = [];
    const seen = new Set();
    [
      ...(config?.last_discovered_sources || []),
    ].forEach((source) => {
      const normalized = this.normalizeSourceEntries([source])[0];
      if (!normalized || seen.has(normalized.id)) return;
      seen.add(normalized.id);
      sources.push(normalized);
    });
    return sources;
  }

  getVisibleSources(config = this.config) {
    const configSources = this.getConfigFavoriteSources(config);
    if (configSources.length) return configSources;
    return this.getAgsSourceEntries("ags_sources");
  }

  getHiddenSources(config = this.config) {
    const fromEntity = this.getAgsSourceEntries("ags_hidden_sources");
    if (fromEntity.length) return fromEntity;

    const visibleIds = new Set(this.getVisibleSources(config).map((source) => this.getSourceId(source)));
    const visibleValues = new Set(this.getVisibleSources(config).map((source) => String(source.Source_Value || "").trim()).filter(Boolean));
    return this.getAllKnownSources(config).filter((source) => {
      const id = this.getSourceId(source);
      const value = String(source.Source_Value || "").trim();
      return id && !visibleIds.has(id) && !visibleValues.has(value);
    });
  }

  getSourceDisplayName(source, config = this.config) {
    const id = this.getSourceId(source);
    return (id && config?.source_display_names?.[id]) || source?.Source || source?.name || source?.title || "";
  }

  getSourceFolderLabel(source) {
    const path = source?.folder_path;
    if (Array.isArray(path) && path.length) {
      return path.filter(Boolean).join(" / ");
    }
    if (typeof path === "string" && path.trim()) {
      return path.trim();
    }
    return "Media Browser";
  }

  sourceMatchesSearch(source) {
    const query = String(this.sourceSearch || "").trim().toLowerCase();
    if (!query) return true;
    return [
      this.getSourceDisplayName(source),
      source?.Source,
      source?.Source_Value,
      source?.media_content_type,
      this.getSourceFolderLabel(source),
    ].some((value) => String(value || "").toLowerCase().includes(query));
  }

  getFilteredSourceRows(sources) {
    return (sources || []).filter((source) => this.sourceMatchesSearch(source));
  }

  groupSourcesByFolder(sources) {
    const groups = new Map();
    (sources || []).forEach((source) => {
      const label = this.getSourceFolderLabel(source);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(source);
    });
    return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
  }

  updateSourceSearch(value) {
    this.sourceSearch = String(value || "");
    this.render();
  }

  toggleSourcesFolderView() {
    this.sourcesFolderView = !this.sourcesFolderView;
    this.render();
  }

  async refreshSources() {
    if (!this.hass || this.refreshingSources) return;
    this.refreshingSources = true;
    this.error = "";
    this.render();
    try {
      const result = await this.hass.callWS({ type: "ags_service/sources/refresh" });
      const config = await this.hass.callWS({ type: "ags_service/config/get" });
      this.config = this.normalizeConfig(config);
      this._sourceCatalogLoaded = false;
      await this.ensureSourceCatalogLoaded(true);
      this.logs = await this.hass.callWS({ type: "ags_service/get_logs" });
      this.hass.callService("persistent_notification", "create", {
        title: "AGS Source Refresh",
        message: `Discovered ${result.last_discovered_sources || 0} source(s); ${result.source_favorites || 0} visible.`,
      });
    } catch (error) {
      this.error = error.message || String(error);
    } finally {
      this.refreshingSources = false;
      this.render();
    }
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

  getHeaderSummary(agsState = this.getAgsState()) {
    const attributes = agsState?.attributes || {};
    const status = attributes.ags_status || "OFF";
    const activeRooms = Array.isArray(attributes.active_rooms) ? attributes.active_rooms : [];
    const headerInfo =
      status === "OFF"
        ? "Off"
        : activeRooms.length > 0
          ? `Active in ${activeRooms[0]}${activeRooms.length > 1 ? ` + ${activeRooms.length - 1}` : ""}`
          : "Active";

    return { headerInfo, status };
  }

  getAgsStateSignature(hass = this.hass) {
    if (!hass) {
      return "missing-hass";
    }

    const agsState =
      hass.states["media_player.ags_media_player"] ||
      Object.values(hass.states).find((stateObj) => stateObj?.attributes?.ags_status !== undefined) ||
      null;

    if (!agsState) {
      return "missing-ags";
    }

    const attributes = agsState.attributes || {};
    return JSON.stringify({
      entity_id: agsState.entity_id,
      state: agsState.state,
      ags_status: attributes.ags_status,
      active_rooms: attributes.active_rooms || [],
      active_speakers: attributes.active_speakers || [],
      primary_speaker: attributes.primary_speaker,
      preferred_primary_speaker: attributes.preferred_primary_speaker,
      selected_source_name: attributes.selected_source_name,
      source_mode: attributes.source_mode,
      source_list_revision: attributes.source_list_revision,
      ags_sources: attributes.ags_sources || [],
      ags_hidden_sources: attributes.ags_hidden_sources || [],
      ags_all_sources: attributes.ags_all_sources || [],
      dynamic_title: attributes.dynamic_title,
      room_details: attributes.room_details || [],
      room_diagnostics: attributes.room_diagnostics || [],
      logic_flags: attributes.logic_flags || [],
      speaker_candidates: attributes.speaker_candidates || [],
    });
  }

  getThemeSignature(hass = this.hass) {
    return JSON.stringify({
      darkMode: Boolean(hass?.themes?.darkMode),
      selectedTheme: hass?.selectedTheme?.theme || hass?.themes?.default_theme || "",
    });
  }

  updateLiveHeader() {
    if (!this.shadowRoot) {
      return;
    }

    const { headerInfo } = this.getHeaderSummary();
    const infoNode = this.shadowRoot.querySelector(".live-header-info");

    if (infoNode) {
      infoNode.textContent = headerInfo;
    }
  }

  updateHomeEntitiesContent() {
    if (!this.shadowRoot || this.activeTab !== "home") {
      return;
    }

    const container = this.shadowRoot.querySelector(".home-entities-content");
    if (container) {
      container.innerHTML = this.renderEntitiesContent();
    }
  }

  escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  escapeJsString(value) {
    return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  slugify(value) {
    let slug = String(value || "")
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
    while (slug.includes("__")) {
      slug = slug.replace("__", "_");
    }
    return slug;
  }

  resolveMediaUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }
    if (/^data:/i.test(raw)) {
      return raw;
    }
    let resolved = raw;
    if (raw.startsWith("//")) {
      resolved = `${window.location.protocol}${raw}`;
    } else if (!/^https?:/i.test(raw) && typeof this.hass?.hassUrl === "function") {
      resolved = this.hass.hassUrl(raw.startsWith("/") ? raw : `/${raw}`);
    }
    const auth = this.hass?.auth || {};
    const token = auth.data?.access_token || auth.accessToken;
    if (!token) {
      return resolved;
    }
    try {
      const url = new URL(resolved, window.location.origin);
      if (url.origin === window.location.origin) {
        url.searchParams.set("authSig", token);
        return url.toString();
      }
    } catch (error) {
      // Fall back to the resolved value when the URL cannot be normalized.
    }
    return resolved;
  }

  getPreferredSpeakerEntityId() {
    if (!this.config?.rooms) return null;

    const allSpeakers = [];
    this.config.rooms.forEach((room) => {
      if (room.devices) {
        room.devices.forEach((device) => {
          if (device.device_type === "speaker" && device.device_id) {
            allSpeakers.push(device);
          }
        });
      }
    });

    if (!allSpeakers.length) return null;

    allSpeakers.sort((a, b) => (a.priority || 999) - (b.priority || 999));
    const targetId = allSpeakers[0].device_id;

    return this.hass.states[targetId] ? targetId : null;
  }

  getBrowseEntityCandidates() {
    const ags = this.getAgsState();
    const candidates = [
      ags?.entity_id,
      ags?.attributes?.control_device_id,
      ags?.attributes?.browse_entity_id,
      ags?.attributes?.primary_speaker,
      ags?.attributes?.preferred_primary_speaker,
      ...(ags?.attributes?.active_speakers || []),
      this.getPreferredSpeakerEntityId(),
    ];
    const seen = new Set();
    return candidates.filter((entityId) => {
      const normalized = String(entityId || "").trim();
      if (!normalized || normalized === "none" || seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      const state = this.hass?.states[normalized];
      return state && state.state !== "unavailable";
    });
  }

  browseResponseHasRealContent(response) {
    const children = Array.isArray(response?.children) ? response.children : [];
    if (!children.length) {
      return !this.isEmptyBrowsePlaceholder(response);
    }
    return children.some((child) => !this.isEmptyBrowsePlaceholder(child));
  }

  humanizeBrowseLabel(value, fallback = "Media") {
    const normalized = String(value || "").trim();
    if (!normalized) {
      return fallback;
    }
    return normalized
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\b\w/g, (match) => match.toUpperCase());
  }

  hasCompleteBrowseTarget(node) {
    if (!node || typeof node !== "object") {
      return false;
    }
    return Boolean(String(node.media_content_type || "").trim() && String(node.media_content_id || "").trim());
  }

  normalizeBrowseItem(item) {
    if (!item || typeof item !== "object") {
      return null;
    }
    if (this.isEmptyBrowsePlaceholder(item)) {
      return null;
    }

    const children = Array.isArray(item.children)
      ? item.children.map((child) => this.normalizeBrowseItem(child)).filter(Boolean)
      : [];
    const rawTitle = String(
      item.title || item.name || item.media_title || item.media_content_id || item.media_class || "",
    ).trim();
    const mediaContentType = String(item.media_content_type || "").trim();
    const mediaContentId = String(item.media_content_id || "").trim();
    const canExpand = Boolean(item.can_expand || children.length);
    const canPlay = Boolean(item.can_play || (!canExpand && mediaContentType && mediaContentId));

    return {
      ...item,
      title: rawTitle || (canExpand ? "Untitled Folder" : "Untitled Item"),
      media_class: String(item.media_class || mediaContentType || (canExpand ? "folder" : "media")).trim(),
      media_content_type: mediaContentType,
      media_content_id: mediaContentId,
      thumbnail: String(item.thumbnail || item.entity_picture || item.media_image_url || item.image || "").trim(),
      can_expand: canExpand,
      can_play: canPlay,
      children,
    };
  }

  isEmptyBrowsePlaceholder(item) {
    if (!item || typeof item !== "object") {
      return false;
    }
    const values = [
      item.title,
      item.name,
      item.media_content_id,
      item.media_class,
    ].map((value) => String(value || "").trim().toLowerCase());
    return values.some((value) =>
      ["no item", "no items", "nothing found", "empty"].includes(value),
    );
  }

  normalizeBrowseResponse(response) {
    const children = Array.isArray(response?.children)
      ? response.children.map((child) => this.normalizeBrowseItem(child)).filter(Boolean)
      : [];

    return {
      ...response,
      children,
    };
  }

  getBrowseItemIcon(item) {
    if (item?.can_expand) return "mdi:folder";
    const mediaClass = String(item?.media_class || item?.media_content_type || "").toLowerCase();
    if (mediaClass.includes("playlist")) return "mdi:playlist-music";
    if (mediaClass.includes("album")) return "mdi:album";
    if (mediaClass.includes("artist")) return "mdi:account-music";
    if (mediaClass.includes("podcast")) return "mdi:podcast";
    if (mediaClass.includes("radio")) return "mdi:radio";
    if (mediaClass.includes("channel")) return "mdi:television-play";
    if (mediaClass.includes("movie") || mediaClass.includes("episode") || mediaClass.includes("video")) return "mdi:movie-open";
    if (mediaClass.includes("app")) return "mdi:apps";
    if (mediaClass.includes("image") || mediaClass.includes("photo")) return "mdi:image";
    return item?.can_play ? "mdi:play-circle" : "mdi:music-note";
  }

  getBrowseItemMeta(item) {
    const kind = this.humanizeBrowseLabel(item?.media_class || item?.media_content_type, item?.can_expand ? "Folder" : "Media");
    if (item?.can_expand && item?.can_play) return `${kind} • Open or add`;
    if (item?.can_expand) return `${kind} • Open`;
    if (item?.can_play) return `${kind} • Add`;
    return `${kind} • Unavailable`;
  }

  renderBrowseArtwork(item, className = "browse-result-art") {
    const thumbnail = item?.thumbnail ? this.resolveMediaUrl(item.thumbnail) : "";
    const icon = this.getBrowseItemIcon(item);
    return `
      <div class="${className}${thumbnail ? "" : " no-image"}" data-browse-art>
        ${thumbnail
          ? `<img src="${this.escapeHtml(thumbnail)}" alt="" loading="lazy" style="width:100%; height:100%; object-fit:cover;" onerror="const host=this.closest('[data-browse-art]'); if (host) host.classList.add('image-failed'); this.remove();" />`
          : ""}
        <span class="browse-art-fallback" aria-hidden="true">
          <ha-icon icon="${icon}"></ha-icon>
        </span>
      </div>
    `;
  }

  getBrowseErrorMessage(error) {
    const detail = String(error?.message || error || "").trim();
    if (!detail) {
      return "Browse media request failed.";
    }
    if (/media_content_type.*media_content_id.*provided together/i.test(detail)) {
      return "Could not open that media folder because the speaker returned an incomplete browse target.";
    }
    if (/browse media/i.test(detail) || /entity not found/i.test(detail)) {
      return "Browse media failed for AGS and the active speaker.";
    }
    return detail;
  }

  applyBrowseNodeResults(node) {
    const normalized = this.normalizeBrowseItem(node);
    const children = Array.isArray(normalized?.children) ? normalized.children : [];
    this.browseItems = children;
    this.discoveredFavorites = this.collectPlayableBrowseItems({ children });

    if (!children.length && !this.discoveredFavorites.length) {
      this.favoriteBrowseError = "Browse media returned no folders or playable items.";
    } else {
      this.favoriteBrowseError = "";
    }
  }

  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  getCssColorValue(names, fallback = "") {
    const styles = getComputedStyle(this);
    for (const name of names) {
      const value = styles.getPropertyValue(name)?.trim();
      if (value) return value;
    }
    return fallback;
  }

  parseColor(value, fallback = [17, 24, 39, 1]) {
    const raw = String(value || "").trim();
    if (!raw) return fallback;

    if (raw.startsWith("#")) {
      const hex = raw.slice(1);
      const normalized = hex.length === 3 || hex.length === 4
        ? hex.split("").map((char) => char + char).join("")
        : hex;
      if (normalized.length === 6 || normalized.length === 8) {
        return [
          parseInt(normalized.slice(0, 2), 16),
          parseInt(normalized.slice(2, 4), 16),
          parseInt(normalized.slice(4, 6), 16),
          normalized.length === 8 ? parseInt(normalized.slice(6, 8), 16) / 255 : 1,
        ];
      }
    }

    const rgbMatch = raw.match(/^rgba?\(([^)]+)\)$/i);
    if (rgbMatch) {
      const parts = rgbMatch[1].split(",").map((part) => part.trim());
      if (parts.length >= 3) {
        return [
          this.clamp(Number(parts[0]), 0, 255),
          this.clamp(Number(parts[1]), 0, 255),
          this.clamp(Number(parts[2]), 0, 255),
          parts[3] !== undefined ? this.clamp(Number(parts[3]), 0, 1) : 1,
        ];
      }
    }

    return fallback;
  }

  toOpaque(color, background = [255, 255, 255]) {
    const [r, g, b, alpha = 1] = color;
    if (alpha >= 0.999) {
      return [Math.round(r), Math.round(g), Math.round(b)];
    }
    return [r, g, b].map((channel, index) =>
      Math.round((channel * alpha) + (background[index] * (1 - alpha))),
    );
  }

  mixColors(first, second, amount = 0.5) {
    const weight = this.clamp(amount, 0, 1);
    return [0, 1, 2].map((index) =>
      Math.round(first[index] + ((second[index] - first[index]) * weight)),
    );
  }

  getLuminance(color) {
    const normalized = color.map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * normalized[0]) + (0.7152 * normalized[1]) + (0.0722 * normalized[2]);
  }

  getContrastRatio(first, second) {
    const lighter = Math.max(this.getLuminance(first), this.getLuminance(second));
    const darker = Math.min(this.getLuminance(first), this.getLuminance(second));
    return (lighter + 0.05) / (darker + 0.05);
  }

  getReadableTextColor(background, preferred = null) {
    const candidates = [];
    if (preferred) candidates.push(preferred);
    candidates.push([15, 23, 42], [255, 255, 255]);

    let best = candidates[0];
    let bestRatio = 0;
    for (const candidate of candidates) {
      const ratio = this.getContrastRatio(background, candidate);
      if (ratio > bestRatio) {
        best = candidate;
        bestRatio = ratio;
      }
    }
    return best;
  }

  rgb(color) {
    return `rgb(${color.map((channel) => Math.round(channel)).join(", ")})`;
  }

  rgba(color, alpha) {
    return `rgba(${color.map((channel) => Math.round(channel)).join(", ")}, ${alpha})`;
  }

  getThemePalette() {
    const background = this.toOpaque(
      this.parseColor(
        this.getCssColorValue(
          ["--primary-background-color", "--lovelace-background", "--app-header-background-color"],
          "#f5f7fb",
        ),
        [245, 247, 251, 1],
      ),
      [255, 255, 255],
    );
    const surface = this.toOpaque(
      this.parseColor(
        this.getCssColorValue(["--card-background-color", "--ha-card-background"], "#ffffff"),
        [255, 255, 255, 1],
      ),
      background,
    );
    const primary = this.toOpaque(
      this.parseColor(this.getCssColorValue(["--primary-color", "--accent-color"], "#2563eb"), [37, 99, 235, 1]),
      surface,
    );
    const text = this.getReadableTextColor(
      surface,
      this.toOpaque(
        this.parseColor(this.getCssColorValue(["--primary-text-color"], "#111827"), [17, 24, 39, 1]),
        surface,
      ),
    );
    const muted = this.getReadableTextColor(
      surface,
      this.toOpaque(
        this.parseColor(this.getCssColorValue(["--secondary-text-color"], "#475569"), [71, 85, 105, 1]),
        surface,
      ),
    );
    const isDark = this.getLuminance(background) < 0.42;
    const surfaceSoft = this.mixColors(surface, background, isDark ? 0.14 : 0.38);
    const surfaceElevated = this.mixColors(surface, background, isDark ? 0.08 : 0.18);
    const onPrimary = this.getReadableTextColor(primary, text);

    return {
      colorScheme: isDark ? "dark" : "light",
      shellBg: this.rgb(this.mixColors(background, primary, isDark ? 0.06 : 0.025)),
      chromeBg: `linear-gradient(180deg, ${this.rgba(surface, isDark ? 0.96 : 0.92)} 0%, ${this.rgba(surfaceElevated, isDark ? 0.9 : 0.78)} 82%, ${this.rgba(background, 0)} 100%)`,
      surface: this.rgba(surface, isDark ? 0.82 : 0.9),
      surfaceSoft: this.rgba(surfaceSoft, isDark ? 0.7 : 0.82),
      glass: this.rgba(surfaceElevated, isDark ? 0.66 : 0.78),
      border: this.rgba(text, isDark ? 0.18 : 0.12),
      borderStrong: this.rgba(primary, isDark ? 0.26 : 0.22),
      text: this.rgb(text),
      muted: this.rgb(muted),
      primary: this.rgb(primary),
      primarySoft: this.rgba(primary, isDark ? 0.18 : 0.12),
      primaryStrong: this.rgba(primary, isDark ? 0.28 : 0.18),
      onPrimary: this.rgb(onPrimary),
      subtle: this.rgba(text, isDark ? 0.08 : 0.04),
      subtleStrong: this.rgba(text, isDark ? 0.12 : 0.06),
      errorSoft: this.getCssColorValue(["--error-color"], "#b91c1c"),
      errorBg: this.rgba(this.toOpaque(this.parseColor(this.getCssColorValue(["--error-color"], "#b91c1c"), [185, 28, 28, 1]), surface), isDark ? 0.18 : 0.1),
      shadow: isDark ? "0 18px 48px rgba(2, 6, 23, 0.34)" : "0 18px 48px rgba(15, 23, 42, 0.12)",
      logBg: this.rgb(this.mixColors(surface, isDark ? [2, 6, 23] : [226, 232, 240], isDark ? 0.24 : 0.42)),
      logText: this.rgb(this.getReadableTextColor(this.mixColors(surface, isDark ? [2, 6, 23] : [226, 232, 240], isDark ? 0.24 : 0.42), text)),
    };
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

    this.getVisibleSources(config).forEach((source) => {
      const name = String(this.getSourceDisplayName(source, config) || "").trim();
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

  markConfigDirty() {
    this._configDirty = true;
    this._saveStatus = "Unsaved changes";
  }

  async setTab(tab) {
    if (this.activeTab === tab) {
      return;
    }
    const shouldAutosave = this._configDirty;
    this.activeTab = tab;
    this._resetScrollAfterRender = true;
    this.render();
    requestAnimationFrame(() => {
      const shell = this.shadowRoot?.querySelector(".shell");
      if (shell) shell.scrollTop = 0;
    });
    if (shouldAutosave) {
      await this.saveConfig({ silent: true });
    }
    if (tab === "sources") {
      this.ensureSourceCatalogLoaded();
    }
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

    const key = parts[parts.length - 1];
    if (obj[key] === value) {
      return;
    }

    obj[key] = value;
    this.config = this.normalizeConfig(this.config);
    this.markConfigDirty();
    this.render();
  }

  removeAt(path, index) {
    const target = this.resolvePath(path);
    if (Array.isArray(target)) {
      target.splice(index, 1);
      this.renumberAfterArrayEdit(path, target);
      this.config = this.normalizeConfig(this.config);
      this.ensureRoomSelection();
      this.markConfigDirty();
      this.render();
    }
  }

  renumberAfterArrayEdit(path, target) {
    if (/^rooms\.\d+\.devices$/.test(path)) {
      target.forEach((device, deviceIndex) => {
        device.priority = deviceIndex + 1;
      });
      this.editingDeviceKey = null;
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
      this.markConfigDirty();
    }
  }

  ensureDefaultSourceSchedule() {
    if (!this.config.default_source_schedule) {
      this.config.default_source_schedule = {
        entity_id: "",
        source_name: "",
        on_state: "on",
      };
      this.markConfigDirty();
    }
  }

  clearConfigValue(path) {
    this.updateConfig(path, null);
  }

  addRoom() {
    this.config.rooms.push({
      room: `Room ${this.config.rooms.length + 1}`,
      devices: [],
    });
    this.config = this.normalizeConfig(this.config);
    this.selectedRoomIdx = this.config.rooms.length - 1;
    this.markConfigDirty();
    this.render();
  }

  deleteRoom(index) {
    if (!window.confirm("Delete this room?")) {
      return;
    }
    this.config.rooms.splice(index, 1);
    this.config = this.normalizeConfig(this.config);
    this.ensureRoomSelection();
    this.markConfigDirty();
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
    });
    this.config = this.normalizeConfig(this.config);
    this.renumberGlobalDevicePriorities();
    this.markConfigDirty();
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
    this.markConfigDirty();
    this.render();
  }

  addSource() {
    this.config.source_favorites.push({
      Source: "",
      Source_Value: "",
      media_content_type: "music",
      source_default: false,
    });
    this.config = this.normalizeConfig(this.config);
    this.markConfigDirty();
    this.render();
  }

  setSourceDefault(index, isDefault) {
    this.config.source_favorites.forEach((source, sourceIndex) => {
      source.source_default = isDefault ? sourceIndex === index : false;
      if (source.source_default) this.config.default_source_id = this.getSourceId(source);
    });
    this.config = this.normalizeConfig(this.config);
    this.markConfigDirty();
    this.render();
  }

  setSourceDefaultByName(name) {
    this.config.source_favorites.forEach((source) => {
      source.source_default = source.Source === name;
      if (source.source_default) this.config.default_source_id = this.getSourceId(source);
    });
    this.config = this.normalizeConfig(this.config);
    this.render();
  }

  findKnownSourceById(sourceId) {
    return this.getAllKnownSources().find((source) => this.getSourceId(source) === sourceId) || null;
  }

  rememberSourceSnapshot(source) {
    const normalized = this.normalizeSourceEntries([source])[0];
    if (!normalized) return;
    const existing = new Set((this.config.last_discovered_sources || []).map((entry) => this.getSourceId(entry)));
    if (!existing.has(normalized.id)) {
      this.config.last_discovered_sources = [
        ...(this.config.last_discovered_sources || []),
        normalized,
      ];
    }
  }

  renameSource(sourceId, value) {
    const name = String(value || "").trim();
    if (!sourceId || !name) return;
    this.config.source_display_names = {
      ...(this.config.source_display_names || {}),
      [sourceId]: name,
    };
    this.markConfigDirty();
    this.render();
  }

  setDefaultSourceId(sourceId) {
    this.config.default_source_id = sourceId || null;
    this.config.source_favorites = (this.config.source_favorites || []).map((source) => ({
      ...source,
      source_default: this.getSourceId(source) === sourceId,
    }));
    this.markConfigDirty();
    this.render();
  }

  hideSource(sourceId) {
    const source = this.findKnownSourceById(sourceId);
    if (source) this.rememberSourceSnapshot(source);
    const hidden = new Set(this.config.hidden_source_ids || []);
    hidden.add(sourceId);
    this.config.hidden_source_ids = Array.from(hidden);
    this.config.source_favorites = (this.config.source_favorites || []).filter(
      (entry) => this.getSourceId(entry) !== sourceId,
    );
    if (this.config.default_source_id === sourceId) {
      const nextDefault = this.getVisibleSources({
        ...this.config,
        hidden_source_ids: this.config.hidden_source_ids,
      }).find((entry) => this.getSourceId(entry) !== sourceId);
      this.config.default_source_id = nextDefault ? this.getSourceId(nextDefault) : null;
    }
    this.markConfigDirty();
    this.render();
  }

  restoreSource(sourceId) {
    const source = this.findKnownSourceById(sourceId);
    this.config.hidden_source_ids = (this.config.hidden_source_ids || []).filter((id) => id !== sourceId);
    if (source) {
      const existing = new Set((this.config.source_favorites || []).map((entry) => this.getSourceId(entry)));
      if (!existing.has(sourceId)) {
        this.config.source_favorites = [
          ...(this.config.source_favorites || []),
          { ...source, origin: "user_favorite" },
        ];
      }
    }
    const visible = this.getVisibleSources();
    if (
      visible.length
      && !visible.some((entry) => this.getSourceId(entry) === this.config.default_source_id)
    ) {
      this.config.default_source_id = this.getSourceId(visible[0]);
    }
    this.markConfigDirty();
    this.render();
  }

  getRankedDevices() {
    const rows = [];
    (this.config?.rooms || []).forEach((room, roomIndex) => {
      (room.devices || []).forEach((device, deviceIndex) => {
        if (!device?.device_id || device.device_type === "ott") return;
        rows.push({ room, roomIndex, device, deviceIndex });
      });
    });
    return rows.sort((a, b) => (a.device.priority || 999) - (b.device.priority || 999));
  }

  renumberGlobalDevicePriorities() {
    this.getRankedDevices().forEach((row, index) => {
      row.device.priority = index + 1;
    });
  }

  moveDeviceRankByKey(deviceKey, targetIndex) {
    const ranked = this.getRankedDevices();
    const fromIndex = ranked.findIndex((row) => `${row.roomIndex}:${row.deviceIndex}` === deviceKey);
    if (fromIndex < 0 || targetIndex < 0 || targetIndex >= ranked.length || fromIndex === targetIndex) {
      return;
    }
    const [moved] = ranked.splice(fromIndex, 1);
    ranked.splice(targetIndex, 0, moved);
    ranked.forEach((row, index) => {
      row.device.priority = index + 1;
    });
    this.config = this.normalizeConfig(this.config);
    this.markConfigDirty();
    this.render();
  }

  moveDeviceRank(roomIndex, deviceIndex, direction) {
    const key = `${roomIndex}:${deviceIndex}`;
    const ranked = this.getRankedDevices();
    const currentIndex = ranked.findIndex((row) => `${row.roomIndex}:${row.deviceIndex}` === key);
    this.moveDeviceRankByKey(key, currentIndex + direction);
  }

  setDevicePriority(roomIndex, deviceIndex, requestedPriority) {
    const safePriority = Math.max(1, parseInt(requestedPriority, 10) || 1);
    this.moveDeviceRankByKey(`${roomIndex}:${deviceIndex}`, safePriority - 1);
  }

  handleDeviceDragStart(event, roomIndex, deviceIndex) {
    this.draggingDeviceKey = `${roomIndex}:${deviceIndex}`;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", this.draggingDeviceKey);
  }

  handleDeviceDrop(event, targetIndex) {
    event.preventDefault();
    const sourceKey = event.dataTransfer.getData("text/plain") || this.draggingDeviceKey;
    this.draggingDeviceKey = null;
    if (sourceKey) {
      this.moveDeviceRankByKey(sourceKey, targetIndex);
    }
  }

  getRankedSources() {
    return [...(this.config?.source_favorites || [])]
      .filter((source) => !this.isLegacyConfigSource(source))
      .sort((a, b) => (a.priority || 999) - (b.priority || 999));
  }

  moveSourceRankById(sourceId, targetIndex) {
    const ranked = this.getRankedSources();
    const fromIndex = ranked.findIndex((source) => this.getSourceId(source) === sourceId);
    if (fromIndex < 0 || targetIndex < 0 || targetIndex >= ranked.length || fromIndex === targetIndex) {
      return;
    }
    const [moved] = ranked.splice(fromIndex, 1);
    ranked.splice(targetIndex, 0, moved);
    ranked.forEach((source, index) => {
      source.priority = index + 1;
    });
    this.config.source_favorites = ranked;
    this.config = this.normalizeConfig(this.config);
    this.markConfigDirty();
    this.render();
  }

  moveSourceRank(sourceId, direction) {
    const ranked = this.getRankedSources();
    const currentIndex = ranked.findIndex((source) => this.getSourceId(source) === sourceId);
    this.moveSourceRankById(sourceId, currentIndex + direction);
  }

  setSourcePriority(sourceId, requestedPriority) {
    const safePriority = Math.max(1, parseInt(requestedPriority, 10) || 1);
    this.moveSourceRankById(sourceId, safePriority - 1);
  }

  handleSourceDragStart(event, sourceId) {
    this.draggingSourceId = sourceId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", sourceId);
  }

  handleSourceDrop(event, targetIndex) {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain") || this.draggingSourceId;
    this.draggingSourceId = null;
    if (sourceId) {
      this.moveSourceRankById(sourceId, targetIndex);
    }
  }

  setRoomsSubTab(tab) {
    this.roomsSubTab = tab;
    this.render();
  }

  changeDeviceType(roomIndex, deviceIndex, nextType) {
    const device = this.config?.rooms?.[roomIndex]?.devices?.[deviceIndex];
    if (!device || device.device_type === nextType) return;
    if (
      device.device_type === "tv"
      && nextType === "speaker"
      && ((device.ott_devices || []).length || device.ott_device)
      && !window.confirm("Changing this TV to a speaker removes its nested OTT mappings.")
    ) {
      return;
    }
    device.device_type = nextType === "tv" ? "tv" : "speaker";
    if (device.device_type === "tv") {
      device.tv_mode = device.tv_mode || "tv_audio";
      device.ott_devices = Array.isArray(device.ott_devices) ? device.ott_devices : [];
    } else {
      delete device.tv_mode;
      delete device.ott_device;
      delete device.ott_devices;
    }
    this.config = this.normalizeConfig(this.config);
    this.markConfigDirty();
    this.render();
  }

  async loadHaAreas() {
    if (!this.hass) return;
    this.areaImportOpen = true;
    this.areaImportLoading = true;
    this.areaImportError = "";
    this.render();
    try {
      const response = await this.hass.callWS({ type: "ags_service/areas/list" });
      this.haAreas = Array.isArray(response?.areas) ? response.areas : [];
    } catch (error) {
      this.areaImportError = error.message || String(error);
    } finally {
      this.areaImportLoading = false;
      this.render();
    }
  }

  closeAreaImport() {
    this.areaImportOpen = false;
    this.areaImportError = "";
    this.render();
  }

  importHaArea(areaId) {
    const area = this.haAreas.find((entry) => entry.area_id === areaId);
    if (!area) return;
    const existingIndex = this.config.rooms.findIndex((room) => room.ha_area_id === areaId);
    const existingRoom = existingIndex >= 0 ? this.config.rooms[existingIndex] : null;
    const existingById = new Map((existingRoom?.devices || []).map((device) => [device.device_id, device]));
    const nextDevices = (area.media_players || []).map((entity, index) => {
      const existing = existingById.get(entity.entity_id);
      return existing
        ? { ...existing }
        : {
            device_id: entity.entity_id,
            device_type: entity.device_type === "tv" ? "tv" : "speaker",
            priority: this.getRankedDevices().length + index + 1,
            override_content: "",
          };
    });
    const room = {
      ...(existingRoom || {}),
      room: existingRoom?.room || area.name || "Imported Room",
      ha_area_id: area.area_id,
      ha_area_name: area.name || "",
      ha_area_linked: true,
      devices: nextDevices,
    };
    if (existingIndex >= 0) {
      this.config.rooms[existingIndex] = room;
      this.selectedRoomIdx = existingIndex;
    } else {
      this.config.rooms.push(room);
      this.selectedRoomIdx = this.config.rooms.length - 1;
    }
    this.areaImportOpen = false;
    this.config = this.normalizeConfig(this.config);
    this.renumberGlobalDevicePriorities();
    this.markConfigDirty();
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

  async saveConfig(options = {}) {
    if (!this.hass || !this.config) {
      return;
    }
    const { silent = false } = options;

    try {
      this._savingConfig = true;
      this._saveStatus = "Saving...";
      if (!silent) this.render();
      const normalizedConfig = this.normalizeConfig(this.config);
      const issues = this.getConfigIssues(normalizedConfig);
      this.config = normalizedConfig;
      if (issues.length) {
        this.error = issues.join(" ");
        this._savingConfig = false;
        this.render();
        return;
      }

      this.error = "";

      this.renumberGlobalDevicePriorities();
      const globalPriorities = new Map();
      this.getRankedDevices().forEach((row, index) => {
        globalPriorities.set(row.device.device_id, index + 1);
      });
      normalizedConfig.rooms.forEach((room) => {
        room.devices.forEach((device) => {
          device.priority = globalPriorities.get(device.device_id) || device.priority || 999;
        });
      });

      // Sanitize schedule objects to be null if empty
      if (normalizedConfig.schedule_entity && !normalizedConfig.schedule_entity.entity_id) {
        normalizedConfig.schedule_entity = null;
      }
      if (
        normalizedConfig.default_source_schedule &&
        !normalizedConfig.default_source_schedule.entity_id
      ) {
        normalizedConfig.default_source_schedule = null;
      }

      const payload = {
        ...normalizedConfig,
        source_favorites: this.normalizeSourceEntries(normalizedConfig.source_favorites || []),
        hidden_source_ids: normalizedConfig.hidden_source_ids || [],
        source_display_names: normalizedConfig.source_display_names || {},
        default_source_id: normalizedConfig.default_source_id || null,
        last_discovered_sources: this.normalizeSourceEntries(normalizedConfig.last_discovered_sources || []),
      };
      delete payload.Sources;
      delete payload.favorite_sources;
      delete payload.ExcludedSources;
      delete payload.homekit_player;

      await this.hass.callWS({
        type: "ags_service/config/save",
        config: payload,
      });
      this._configDirty = false;
      this._savingConfig = false;
      this._saveStatus = "Saved";
      if (!silent) {
        this.hass.callService("persistent_notification", "create", {
          title: "AGS Service",
          message: "Settings saved and reloaded.",
        });
      }
      await this.initData();
    } catch (error) {
      this.error = error.message || String(error);
      this._savingConfig = false;
      this._saveStatus = "Save failed";
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

          if (String(this.resolvePath(path) || "").trim() === sanitized) {
            return;
          }

          this.updateConfig(path, sanitized);
        };

        picker.__agsValueChangeHandler = handleValueChange;
        picker.addEventListener("value-changed", handleValueChange);
        picker.__agsBound = true;
      }
    });
  }

  // Ensure entity pickers are bound after initial load
  initEntityPickers() {
    this.bindEntityPickers();
  }

  bindEmbeddedDashboard() {
   const dashboard = this.shadowRoot.querySelector(".embedded-dashboard");
   if (!dashboard || typeof dashboard.setConfig !== "function") {
     return;
   }

   const ags = this.getAgsState();
   if (!ags) {
     console.warn("Could not find AGS entity for embedded dashboard");
     return;
   }

   const config = {
     entity: ags.entity_id,
     sections: ["player", "browse", "rooms", "sources"],
     start_section: "player",
   };
   const configKey = JSON.stringify(config);
   if (dashboard.__agsConfigKey !== configKey) {
     dashboard.setConfig(config);
     dashboard.__agsConfigKey = configKey;
   }
   dashboard.hass = this.hass;
  }
  renderEntityField(label, path, value, domains = ["media_player"], options = {}) {
    return `
      <div>
        <label>${this.escapeHtml(label)}</label>
        <ha-entity-picker
          data-path="${path}"
          ${domains.length ? `include-domains='${this.escapeHtml(JSON.stringify(domains))}'` : ""}
          data-value="${this.escapeHtml(value || "")}"
        ></ha-entity-picker>
      </div>
    `;
  }

  mergeSources(sourceEntries) {
    const existingKeys = new Set(
      this.config.source_favorites.map((entry) => `${entry.Source}::${entry.Source_Value}`),
    );
    let added = 0;

    sourceEntries.forEach((entry) => {
      if (this.isEmptyBrowsePlaceholder({
        title: entry.Source,
        media_content_id: entry.Source_Value,
      })) {
        return;
      }
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
      const normalizedEntry = this.normalizeSourceEntries([normalized])[0];
      if (!normalizedEntry) return;
      this.config.source_favorites.push(normalizedEntry);
      added += 1;
    });

    this.config = this.normalizeConfig(this.config);
    if (added) {
      this.markConfigDirty();
    }
    this.render();
    return added;
  }

  collectPlayableBrowseItems(node, results = [], seen = new Set()) {
    if (!node || typeof node !== "object") {
      return results;
    }
    if (this.isEmptyBrowsePlaceholder(node)) {
      return results;
    }

    if (node.can_play && node.title && node.media_content_id) {
      const key = this.getBrowserSourceId(node);
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          id: key,
          Source: node.title,
          Source_Value: node.media_content_id,
          media_content_type: node.media_content_type || "music",
          can_play: Boolean(node.can_play),
          can_expand: Boolean(node.can_expand),
          origin: "user_favorite",
        });
      }
    }

    if (Array.isArray(node.children)) {
      node.children.forEach((child) => this.collectPlayableBrowseItems(child, results, seen));
    }

    return results;
  }

  sourceFromBrowseItem(item, folderPath = []) {
    if (!item || typeof item !== "object" || this.isEmptyBrowsePlaceholder(item)) {
      return null;
    }
    const mediaContentId = String(item.media_content_id || "").trim();
    if (!mediaContentId) {
      return null;
    }
    const mediaContentType = String(item.media_content_type || "music").trim() || "music";
    const title = String(item.title || item.name || mediaContentId).trim();
    const canExpand = Boolean(item.can_expand || (Array.isArray(item.children) && item.children.length));
    const canPlay = Boolean(item.can_play || (!canExpand && mediaContentType && mediaContentId));
    if (!canPlay && !canExpand) {
      return null;
    }
    const sourceLike = {
      ...item,
      title,
      media_content_id: mediaContentId,
      media_content_type: mediaContentType,
      folder_path: folderPath,
    };
    return {
      id: this.getBrowserSourceId(sourceLike),
      Source: title,
      Source_Value: mediaContentId,
      media_content_type: mediaContentType,
      can_play: canPlay,
      can_expand: canExpand,
      media_class: String(item.media_class || mediaContentType || (canExpand ? "folder" : "music")).trim(),
      folder_path: folderPath,
      origin: "media_browser",
    };
  }

  appendBrowseCatalogItem(item, folderPath, results, seen) {
    const source = this.sourceFromBrowseItem(item, folderPath);
    if (!source) return;
    const id = this.getSourceId(source);
    if (!id || seen.has(id)) return;
    seen.add(id);
    results.push(source);
  }

  async browseCatalogNode(entityId, node = null, folderPath = [], results = [], seen = new Set(), depth = 0) {
    if (results.length >= 250 || depth > 2) {
      return results;
    }

    let response = node;
    if (!response || this.hasCompleteBrowseTarget(response)) {
      const payload = { type: "media_player/browse_media", entity_id: entityId };
      if (response) {
        let type = String(response.media_content_type || "").trim();
        let id = String(response.media_content_id || "").trim();
        if (id && !type) type = response.can_expand ? "library" : "music";
        if (type) payload.media_content_type = type;
        if (id) payload.media_content_id = id;
      }
      response = await this.hass.callWS(payload);
    }

    const normalized = this.normalizeBrowseResponse(response);
    const children = Array.isArray(normalized?.children) ? normalized.children : [];
    for (const child of children) {
      if (results.length >= 250) break;
      const childTitle = String(child.title || child.name || "").trim();
      this.appendBrowseCatalogItem(child, folderPath, results, seen);
      const canExpand = Boolean(child.can_expand || (Array.isArray(child.children) && child.children.length));
      if (!canExpand) continue;
      const nextPath = [...folderPath, childTitle || "Folder"];
      if (Array.isArray(child.children) && child.children.length) {
        await this.browseCatalogNode(entityId, child, nextPath, results, seen, depth + 1);
      } else if (this.hasCompleteBrowseTarget(child)) {
        try {
          await this.browseCatalogNode(entityId, child, nextPath, results, seen, depth + 1);
        } catch (error) {
          console.warn("AGS source catalog crawl skipped folder", child.title, error);
        }
      }
    }
    return results;
  }

  async ensureSourceCatalogLoaded(force = false) {
    if (!this.hass || this.loadingSourceCatalog) return;
    if (!force && this._sourceCatalogLoaded) return;
    this.loadingSourceCatalog = true;
    this.render();
    try {
      const candidates = this.getBrowseEntityCandidates();
      let catalog = [];
      for (const entityId of candidates) {
        try {
          const seen = new Set();
          catalog = await this.browseCatalogNode(entityId, null, [], [], seen);
          if (catalog.length) break;
        } catch (error) {
          console.warn("AGS source catalog browse failed for", entityId, error);
        }
      }
      this.browserCatalogSources = this.normalizeSourceEntries(catalog);
      this._sourceCatalogLoaded = true;
    } catch (error) {
      this.error = error.message || String(error);
    } finally {
      this.loadingSourceCatalog = false;
      this.render();
    }
  }

  async importSpeakerSourceList() {
    const nativeSources = [];
    const seenNative = new Set();
    this.getBrowseEntityCandidates().forEach((entityId) => {
      const state = this.hass?.states?.[entityId];
      const sourceList = state?.attributes?.source_list;
      if (!Array.isArray(sourceList)) {
        return;
      }
      sourceList.forEach((source) => {
        const sourceName = String(source || "").trim();
        const key = sourceName.toLowerCase();
        if (!sourceName || sourceName === "TV" || sourceName === "Unknown" || seenNative.has(key)) {
          return;
        }
        seenNative.add(key);
        nativeSources.push({
          Source: sourceName,
          Source_Value: sourceName,
          media_content_type: "source",
        });
      });
    });
    if (nativeSources.length) {
      this.mergeSources(nativeSources);
      await this.saveConfig();
    }
    await this.browseMediaFavorites();
  }

  async browseMediaFavorites() {
    const candidates = this.getBrowseEntityCandidates();
    if (!candidates.length) {
      this.favoriteBrowseError = "No active speaker is available for media browsing.";
      this.render();
      return;
    }

    this.favoriteBrowseError = "";
    this.discoveredFavorites = [];
    this.browseItems = [];
    this.browsePath = [];
    this.loadingBrowseResults = true;
    this.render();

    try {
      let result = null;
      let favoritesNode = null;
      let usedEntityId = null;

      for (const entityId of candidates) {
        try {
          const root = await this.hass.callWS({ type: "media_player/browse_media", entity_id: entityId });
          const children = root.children || [];
          favoritesNode = children.find(c =>
            String(c.media_class || "").toLowerCase().includes("favorites") ||
            String(c.title || "").toLowerCase().includes("favorites") ||
            String(c.media_content_id || "").toLowerCase().includes("favorites")
          );
          if (favoritesNode) {
            usedEntityId = entityId;
            break;
          }
        } catch (e) {
          console.warn("AGS panel favorites search failed for", entityId, e);
        }
      }

      if (favoritesNode) {
        this.browsePath.push({
          title: favoritesNode.title,
          media_content_id: favoritesNode.media_content_id,
          media_content_type: favoritesNode.media_content_type,
          media_class: favoritesNode.media_class,
          children: Array.isArray(favoritesNode.children) ? favoritesNode.children : [],
        });
        await this.loadBrowseNode(favoritesNode, usedEntityId);
      } else {
        await this.loadBrowseNode();
      }
    } catch (error) {
      this.favoriteBrowseError = this.getBrowseErrorMessage(error);
    } finally {
      this.loadingBrowseResults = false;
    }

    this.render();
  }

  async loadBrowseNode(node = null, preferredEntityId = null) {
    const candidates = this.getBrowseEntityCandidates();
    if (!candidates.length) {
      throw new Error("No active speaker is available for media browsing.");
    }

    if (node && !this.hasCompleteBrowseTarget(node) && Array.isArray(node.children) && node.children.length) {
      this.applyBrowseNodeResults(node);
      return;
    }

    let result = null;
    let lastError = null;

    const orderedCandidates = preferredEntityId
      ? [preferredEntityId, ...candidates.filter((entityId) => entityId !== preferredEntityId)]
      : candidates;

    for (const entityId of orderedCandidates) {
      const payload = {
        type: "media_player/browse_media",
        entity_id: entityId,
      };

      if (node) {
        let type = String(node.media_content_type || "").trim();
        let id = String(node.media_content_id || "").trim();

        if (id && !type) {
          type = node.can_expand ? "library" : "music";
        } else if (type && !id) {
          id = "";
        }

        if (type) payload.media_content_type = type;
        if (id !== undefined) payload.media_content_id = id;
      }

      try {
        result = await this.hass.callWS(payload);
        if (!node && !this.browseResponseHasRealContent(result)) {
          lastError = new Error(`${entityId} returned no browse items.`);
          continue;
        }
        break;
      } catch (error) {
        lastError = error;
        console.warn("AGS panel browse failed for", entityId, error);
      }
    }

    if (!result) {
      throw lastError || new Error("Browse media request failed.");
    }

    const normalized = this.normalizeBrowseResponse(result);
    const children = Array.isArray(normalized?.children) ? normalized.children : [];
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
        media_class: item.media_class,
        children: Array.isArray(item.children) ? item.children : [],
      });
      this.loadingBrowseResults = true;
      this.render();
      try {
        await this.loadBrowseNode(item);
      } catch (error) {
        this.favoriteBrowseError = this.getBrowseErrorMessage(error);
      } finally {
        this.loadingBrowseResults = false;
      }
      this.render();
      return;
    }

    if (item.can_play) {
      const added = this.mergeSources([
        {
          id: this.getBrowserSourceId(item),
          Source: item.title,
          Source_Value: item.media_content_id,
          media_content_type: item.media_content_type || "music",
          can_play: Boolean(item.can_play),
          can_expand: Boolean(item.can_expand),
          origin: "user_favorite",
        },
      ]);
      if (!added) {
        this.favoriteBrowseError = "That media item is already in your AGS source list.";
        this.render();
      } else {
        this.favoriteBrowseError = "";
      }
    }
  }

  async browseBack() {
    if (!this.browsePath.length) {
      this.browseItems = [];
      this.discoveredFavorites = [];
      this.loadingBrowseResults = false;
      this.favoriteBrowseError = "";
      this.render();
      return;
    }

    this.browsePath.pop();
    const previous = this.browsePath[this.browsePath.length - 1] || null;
    this.loadingBrowseResults = true;
    this.render();
    try {
      await this.loadBrowseNode(previous);
    } catch (error) {
      this.favoriteBrowseError = this.getBrowseErrorMessage(error);
    } finally {
      this.loadingBrowseResults = false;
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
    } else {
      this.favoriteBrowseError = "";
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
                    <div style="width:20px; height:20px; border-radius:50%; background:${c.selected ? 'var(--ags-primary)' : 'var(--ags-subtle-strong)'}; color:${c.selected ? 'var(--ags-on-primary)' : 'inherit'}; display:flex; align-items:center; justify-content:center; font-size:0.65rem; font-weight:900; flex-shrink:0;">${c.rank}</div>
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
          ${this.logs.slice(-20).map(line => `<div style="padding:2px 0; border-bottom:1px solid var(--ags-border); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(line)}</div>`).join("")}
        </div>
      </section>
    `;
  }

  renderHome(agsState) {
    return `
      <div class="grid home-grid">
        <section class="home-dashboard-wrap">
          <ags-media-card class="embedded-dashboard"></ags-media-card>
        </section>
        <section class="panel-card home-entities-panel">
          <div class="card-head home-entities-head">
            <div>
              <div class="eyebrow">System Status</div>
              <h3>Active Entities</h3>
            </div>
          </div>
          <div class="home-entities-scroll">
            <div class="home-entities-content">${this.renderEntitiesContent()}</div>
          </div>
        </section>
      </div>
    `;
  }

  navigate(path, replace = false) {
    if (!path) {
      return;
    }
    if (replace) {
      window.history.replaceState(null, "", path);
    } else {
      window.history.pushState(null, "", path);
    }
    window.dispatchEvent(new Event("location-changed", { bubbles: true, composed: true }));
  }

  exitPortal() {
    try {
      if (document.referrer) {
        const referrer = new URL(document.referrer, window.location.origin);
        if (
          referrer.origin === window.location.origin &&
          !referrer.pathname.includes("/ags-service") &&
          window.history.length > 1
        ) {
          window.history.back();
          return;
        }
      }
    } catch (error) {
      // Ignore malformed referrer and fall through to the HA root route.
    }

    this.navigate("/");
  }

  toggleMenu() {
    this.dispatchEvent(new CustomEvent("hass-toggle-menu", {
      bubbles: true,
      composed: true,
    }));
    window.dispatchEvent(new CustomEvent("hass-toggle-menu", {
      bubbles: true,
      composed: true,
    }));
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
        <div class="table-row table-head entities-head">
          <div>Entity ID</div>
          <div>Status</div>
          <div style="text-align:right;">Action</div>
        </div>
        ${entities
          .map((entity) => {
            const isToggle = entity.entity_id.startsWith("switch.");
            return `
              <div class="table-row entities-row">
                <div class="mono" style="font-size:0.75rem; opacity:0.8; padding-right: 8px;">${this.escapeHtml(entity.entity_id)}</div>
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
      <div class="nested-section ott-stack">
        <div class="section-line">
          <div>
            <div class="section-title">Nested OTT Devices</div>
            <div class="section-help">OTT players live under this TV and are not included in global ranking.</div>
          </div>
          <button class="secondary-btn icon-text-btn" onclick="this.getRootNode().host.addOttMapping(${roomIndex}, ${deviceIndex})">
            <ha-icon icon="mdi:plus"></ha-icon>
            <span>Add OTT</span>
          </button>
        </div>
        ${mappings.length
          ? mappings
              .map(
                (mapping, mappingIndex) => `
                  <div class="ott-card">
                    <div class="device-icon ott-icon"><ha-icon icon="mdi:cast-connected"></ha-icon></div>
                    <div class="ott-fields">
                      ${this.renderEntityField(
                        "OTT Player",
                        `rooms.${roomIndex}.devices.${deviceIndex}.ott_devices.${mappingIndex}.ott_device`,
                        mapping.ott_device || "",
                        ["media_player"],
                      )}
                      <div>
                        <label>TV Input Name</label>
                      <input
                        type="text"
                        value="${this.escapeHtml(mapping.tv_input || "")}"
                        onchange="this.getRootNode().host.updateConfig('rooms.${roomIndex}.devices.${deviceIndex}.ott_devices.${mappingIndex}.tv_input', this.value)"
                      />
                      </div>
                    </div>
                    <button class="danger-btn icon-only-btn" title="Remove OTT" onclick="this.getRootNode().host.removeAt('rooms.${roomIndex}.devices.${deviceIndex}.ott_devices', ${mappingIndex})">
                      <ha-icon icon="mdi:delete"></ha-icon>
                    </button>
                  </div>
                `,
              )
              .join("")
          : '<div class="muted">No per-input mappings configured.</div>'}
      </div>
    `;
  }

  renderDeviceCard(roomIndex, deviceIndex, device) {
    const stateObj = device.device_id ? this.hass.states[device.device_id] : null;
    const stateText = stateObj?.state || "Unknown";
    const friendlyName = stateObj?.attributes?.friendly_name || device.device_id || "Select Entity";
    const deviceKey = `${roomIndex}:${deviceIndex}`;
    const isEditing = this.editingDeviceKey === deviceKey;
    const globalRank = this.getRankedDevices().findIndex((row) => row.roomIndex === roomIndex && row.deviceIndex === deviceIndex) + 1;
    const icon = device.device_type === "tv" ? "mdi:television" : "mdi:speaker";
    const typeLabel = device.device_type === "tv" ? "TV" : "Speaker";

    return `
      <div class="device-card room-device-card">
        <div class="device-summary">
          <div class="device-title-row">
            <div class="rank-badge">${globalRank || "-"}</div>
            <div class="device-icon"><ha-icon icon="${icon}"></ha-icon></div>
            <div class="device-copy">
              <div class="section-title">${this.escapeHtml(friendlyName)}</div>
              <div class="section-help">${this.escapeHtml(device.device_id || "Choose a media player")}</div>
            </div>
          </div>
          <div class="header-meta">
            ${this.renderTonePill(typeLabel, device.device_type === "tv" ? "good" : "neutral")}
            ${this.renderTonePill(stateText, stateObj ? "info" : "warn")}
            <button class="secondary-btn icon-only-btn" title="${isEditing ? "Close" : "Edit"}" onclick="this.getRootNode().host.setEditingDevice('${deviceKey}')"><ha-icon icon="${isEditing ? "mdi:close" : "mdi:pencil"}"></ha-icon></button>
            <button class="danger-btn icon-only-btn" title="Remove" onclick="this.getRootNode().host.removeAt('rooms.${roomIndex}.devices', ${deviceIndex})"><ha-icon icon="mdi:delete"></ha-icon></button>
          </div>
        </div>

        ${isEditing ? `
          <div class="device-editor">
            <div class="grid cols-2">
              ${this.renderEntityField("Media Player Entity", `rooms.${roomIndex}.devices.${deviceIndex}.device_id`, device.device_id, ["media_player"])}
              <div class="grid cols-2" style="gap:16px;">
                  <div>
                    <label>Device Type</label>
                    <select onchange="this.getRootNode().host.changeDeviceType(${roomIndex}, ${deviceIndex}, this.value)">
                    <option value="speaker" ${device.device_type === "speaker" ? "selected" : ""}>Speaker</option>
                    <option value="tv" ${device.device_type === "tv" ? "selected" : ""}>Television</option>
                  </select>
                </div>
                  <div>
                    <label>Global Rank</label>
                  <input type="number" min="1" max="${this.getRankedDevices().length}" value="${globalRank || device.priority}" onchange="this.getRootNode().host.setDevicePriority(${roomIndex}, ${deviceIndex}, this.value)" />
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
              <label>Off Overrides (Playback Matcher)</label>
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
      <div class="section-tabs">
        <button class="tab-btn ${this.roomsSubTab === "room" ? "active" : ""}" onclick="this.getRootNode().host.setRoomsSubTab('room')">Room View</button>
        <button class="tab-btn ${this.roomsSubTab === "device" ? "active" : ""}" onclick="this.getRootNode().host.setRoomsSubTab('device')">Device View</button>
      </div>
      ${this.roomsSubTab === "device" ? this.renderDeviceView() : `
      <div class="room-layout">
        <aside class="panel-card" style="padding:24px;">
          <div class="card-head compact-head">
            <div>
              <div class="eyebrow">House Map</div>
              <h3>Rooms</h3>
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
                        <span style="min-width:0;">
                          <span style="display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this.escapeHtml(entry.room)}</span>
                          ${entry.ha_area_linked ? '<span class="section-help" style="font-size:0.72rem;">Linked HA area</span>' : ''}
                        </span>
                        <span class="status-pill ${index === this.selectedRoomIdx ? 'active' : 'status-off'}" style="padding:4px 10px; font-size:0.7rem;">${entry.devices.length}</span>
                      </button>
                    `,
                  )
                  .join("")
              : '<div class="empty-state">No rooms yet.</div>'}
          </div>
          <div class="stack" style="margin-top:20px;">
            <button class="primary-btn icon-text-btn" onclick="this.getRootNode().host.addRoom()"><ha-icon icon="mdi:plus"></ha-icon><span>Add Room</span></button>
            <button class="secondary-btn icon-text-btn" onclick="this.getRootNode().host.loadHaAreas()"><ha-icon icon="mdi:home-import-outline"></ha-icon><span>Import HA Area</span></button>
          </div>
        </aside>

        <section class="panel-card">
          ${
            room
              ? `
                <div class="card-head">
                  <div style="display:flex; align-items:center; gap:8px;">
                    <ha-icon icon="mdi:speaker" style="--mdc-icon-size: 28px; color: var(--ags-primary);"></ha-icon>
                    <div>
                      <div class="eyebrow">Configuration</div>
                      <h3>${this.escapeHtml(room.room)} Details</h3>
                      ${room.ha_area_linked ? `<div class="section-help">Live linked with ${this.escapeHtml(room.ha_area_name || "a Home Assistant area")}</div>` : ""}
                    </div>
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
                    <div class="mono" style="background:var(--ags-subtle); padding:12px; border-radius:12px; border:1px solid var(--ags-border);">switch.${this.escapeHtml(this.slugify(room.room))}_media</div>
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
      ${this.renderAreaImportModal()}
      `}
    `;
  }

  renderDeviceView() {
    const ranked = this.getRankedDevices();
    return `
      <section class="panel-card">
        <div class="card-head">
          <div>
            <div class="eyebrow">Global Ranking</div>
            <h3>Device View</h3>
            <div class="section-help">Drag devices to rank election priority. Nested OTT devices stay under TVs and are not listed here.</div>
          </div>
          <span class="source-count">${ranked.length}</span>
        </div>
        <div class="rank-list">
          ${ranked.length ? ranked.map((row, index) => {
            const stateObj = row.device.device_id ? this.hass.states[row.device.device_id] : null;
            const friendlyName = stateObj?.attributes?.friendly_name || row.device.device_id || "Select Entity";
            const key = `${row.roomIndex}:${row.deviceIndex}`;
            const icon = row.device.device_type === "tv" ? "mdi:television" : "mdi:speaker";
            return `
              <div
                class="rank-row"
                draggable="true"
                ondragstart="this.getRootNode().host.handleDeviceDragStart(event, ${row.roomIndex}, ${row.deviceIndex})"
                ondragover="event.preventDefault()"
                ondrop="this.getRootNode().host.handleDeviceDrop(event, ${index})"
              >
                <div class="drag-handle" title="Drag to rank"><ha-icon icon="mdi:drag"></ha-icon></div>
                <div class="rank-badge">${index + 1}</div>
                <div class="device-icon"><ha-icon icon="${icon}"></ha-icon></div>
                <div class="rank-copy">
                  <div class="section-title">${this.escapeHtml(friendlyName)}</div>
                  <div class="section-help">${this.escapeHtml(row.room.room)} · ${this.escapeHtml(row.device.device_id)}</div>
                </div>
                <div class="rank-actions">
                  ${this.renderTonePill(row.device.device_type === "tv" ? "TV" : "Speaker", row.device.device_type === "tv" ? "good" : "neutral")}
                  <button class="secondary-btn icon-only-btn" title="Move up" ${index === 0 ? "disabled" : ""} onclick="this.getRootNode().host.moveDeviceRank(${row.roomIndex}, ${row.deviceIndex}, -1)"><ha-icon icon="mdi:chevron-up"></ha-icon></button>
                  <button class="secondary-btn icon-only-btn" title="Move down" ${index === ranked.length - 1 ? "disabled" : ""} onclick="this.getRootNode().host.moveDeviceRank(${row.roomIndex}, ${row.deviceIndex}, 1)"><ha-icon icon="mdi:chevron-down"></ha-icon></button>
                </div>
              </div>
            `;
          }).join("") : '<div class="empty-state">No ranked devices yet.</div>'}
        </div>
      </section>
    `;
  }

  renderAreaImportModal() {
    if (!this.areaImportOpen) return "";
    const rows = this.haAreas.filter((area) => (area.media_players || []).length);
    return `
      <div class="modal-backdrop" onclick="this.getRootNode().host.closeAreaImport()">
        <div class="modal-card" onclick="event.stopPropagation()">
          <div class="card-head">
            <div>
              <div class="eyebrow">Home Assistant</div>
              <h3>Import Area</h3>
            </div>
            <button class="secondary-btn icon-only-btn" onclick="this.getRootNode().host.closeAreaImport()"><ha-icon icon="mdi:close"></ha-icon></button>
          </div>
          ${this.areaImportLoading ? '<div class="empty-state">Loading areas...</div>' : ""}
          ${this.areaImportError ? `<div class="error" style="padding:12px; border-radius:12px;">${this.escapeHtml(this.areaImportError)}</div>` : ""}
          <div class="stack">
            ${!this.areaImportLoading && rows.length ? rows.map((area) => `
              <button class="list-select area-import-row" onclick="this.getRootNode().host.importHaArea('${this.escapeJsString(area.area_id)}')">
                <span style="min-width:0;">
                  <span style="display:block; font-weight:900; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(area.name)}</span>
                  <span class="section-help">${(area.media_players || []).map((entity) => this.escapeHtml(entity.name)).join(", ")}</span>
                </span>
                <span class="status-pill">${(area.media_players || []).length}</span>
              </button>
            `).join("") : ""}
            ${!this.areaImportLoading && !rows.length ? '<div class="empty-state">No HA areas with media players were found.</div>' : ""}
          </div>
        </div>
      </div>
    `;
  }

  renderSources() {
    if (!this._sourceCatalogLoaded && !this.loadingSourceCatalog) {
      setTimeout(() => this.ensureSourceCatalogLoaded(), 0);
    }
    const visibleSources = this.getFilteredSourceRows(this.getVisibleSources());
    const hiddenSources = this.getFilteredSourceRows(this.getHiddenSources());
    const rankedSourceIds = this.getRankedSources().map((source) => this.getSourceId(source));
    const sourceRow = (source, index, hidden = false) => {
      const id = this.getSourceId(source);
      const rankIndex = hidden ? index : Math.max(0, rankedSourceIds.indexOf(id));
      const name = this.getSourceDisplayName(source);
      const isDefault = this.config.default_source_id === id || source.source_default;
      const mediaType = this.humanizeBrowseLabel(source.media_content_type || "music", "Music");
      const folderLabel = this.getSourceFolderLabel(source);
      return `
        <div
          class="list-select source-rank-row"
          style="padding:12px 14px; min-height:0; gap:12px; align-items:center;"
          ${hidden ? "" : `
            draggable="true"
            ondragstart="this.getRootNode().host.handleSourceDragStart(event, '${this.escapeJsString(id)}')"
            ondragover="event.preventDefault()"
            ondrop="this.getRootNode().host.handleSourceDrop(event, ${rankIndex})"
          `}
        >
          ${hidden ? "" : `<div class="drag-handle" title="Drag to rank"><ha-icon icon="mdi:drag"></ha-icon></div>`}
          <div class="rank-badge">${rankIndex + 1}</div>
          <div style="flex:1; min-width:0;">
            ${hidden ? `
              <div style="font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this.escapeHtml(name)}</div>
            ` : `
              <input
                type="text"
                style="padding:4px 8px; min-height:32px; font-size:0.9rem;"
                value="${this.escapeHtml(name)}"
                onchange="this.getRootNode().host.renameSource('${this.escapeJsString(id)}', this.value)"
              />
            `}
            <div class="section-help" style="margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(mediaType)} · ${this.escapeHtml(folderLabel)} · ${this.escapeHtml(source.Source_Value || "")}</div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            ${hidden ? `
              <button class="secondary-btn" style="padding:6px; border-radius:50%; width:34px; height:34px; display:flex; align-items:center; justify-content:center;" title="Add to Favorites" onclick="this.getRootNode().host.restoreSource('${this.escapeJsString(id)}')">
                <ha-icon icon="mdi:star-plus-outline" style="--mdc-icon-size: 18px;"></ha-icon>
              </button>
            ` : `
              <button class="secondary-btn ${isDefault ? 'active' : ''}" style="padding:6px; border-radius:50%; width:34px; height:34px; display:flex; align-items:center; justify-content:center;" title="Set Default" onclick="this.getRootNode().host.setDefaultSourceId('${this.escapeJsString(id)}')">
                <ha-icon icon="${isDefault ? 'mdi:star' : 'mdi:star-outline'}" style="--mdc-icon-size: 18px;"></ha-icon>
              </button>
              <button class="secondary-btn icon-only-btn" title="Move up" ${rankIndex === 0 ? "disabled" : ""} onclick="this.getRootNode().host.moveSourceRank('${this.escapeJsString(id)}', -1)"><ha-icon icon="mdi:chevron-up"></ha-icon></button>
              <button class="secondary-btn icon-only-btn" title="Move down" ${rankIndex === rankedSourceIds.length - 1 ? "disabled" : ""} onclick="this.getRootNode().host.moveSourceRank('${this.escapeJsString(id)}', 1)"><ha-icon icon="mdi:chevron-down"></ha-icon></button>
              <button class="secondary-btn" style="padding:6px; border-radius:50%; width:34px; height:34px; display:flex; align-items:center; justify-content:center;" title="Hide from Source List" onclick="this.getRootNode().host.hideSource('${this.escapeJsString(id)}')">
                <ha-icon icon="mdi:eye-off" style="--mdc-icon-size: 18px;"></ha-icon>
              </button>
            `}
          </div>
        </div>
      `;
    };
    const sourceRows = (sources, hidden = false) => {
      if (!sources.length) {
        if (hidden && this.loadingSourceCatalog) {
          return '<div class="empty-state">Loading media browser sources...</div>';
        }
        return hidden
          ? '<div class="empty-state">No matching discovered sources outside Music Sources.</div>'
          : '<div class="empty-state">No matching music sources. Add one from Hidden Sources.</div>';
      }
      if (!this.sourcesFolderView) {
        return sources.map((source, index) => sourceRow(source, index, hidden)).join("");
      }
      let runningIndex = 0;
      return this.groupSourcesByFolder(sources).map((group) => `
        <div class="source-folder-group">
          <div class="source-folder-title">
            <ha-icon icon="mdi:folder-music-outline" style="--mdc-icon-size:16px;"></ha-icon>
            <span>${this.escapeHtml(group.label)}</span>
            <span class="source-count">${group.items.length}</span>
          </div>
          ${group.items.map((source) => sourceRow(source, runningIndex++, hidden)).join("")}
        </div>
      `).join("");
    };
    const visibleTotal = this.getVisibleSources().length;
    const hiddenTotal = this.getHiddenSources().length;
    const searchValue = this.escapeHtml(this.sourceSearch || "");

    return `
      <div class="source-toolbar panel-card">
        <div style="display:flex; align-items:center; gap:12px; min-width:0; flex:1;">
          <ha-icon icon="mdi:magnify" style="color:var(--ags-primary); flex-shrink:0;"></ha-icon>
          <input
            type="search"
            placeholder="Search sources"
            value="${searchValue}"
            onclick="event.stopPropagation()"
            onkeydown="event.stopPropagation()"
            onkeypress="event.stopPropagation()"
            onkeyup="event.stopPropagation()"
            oninput="this.getRootNode().host.updateSourceSearch(this.value)"
          />
        </div>
        <button class="secondary-btn ${this.sourcesFolderView ? 'active' : ''}" onclick="this.getRootNode().host.toggleSourcesFolderView()" title="Toggle folder grouping">
          <ha-icon icon="${this.sourcesFolderView ? 'mdi:folder-music' : 'mdi:format-list-bulleted'}" style="--mdc-icon-size:18px;"></ha-icon>
          <span>${this.sourcesFolderView ? 'Folder View' : 'Flat View'}</span>
        </button>
        <button class="secondary-btn" onclick="this.getRootNode().host.refreshSources()" ${this.refreshingSources ? 'disabled' : ''} title="Refresh media-browser sources">
          <ha-icon icon="${this.refreshingSources ? 'mdi:loading' : 'mdi:refresh'}" style="--mdc-icon-size:18px;"></ha-icon>
          <span>${this.refreshingSources ? 'Refreshing' : 'Refresh'}</span>
        </button>
      </div>

      <div class="grid cols-2 source-grid">
        <section class="panel-card source-panel">
          <div class="card-head">
            <div style="display:flex; align-items:center; gap:8px;">
               <ha-icon icon="mdi:library-music" style="color:var(--ags-primary);"></ha-icon>
               <div>
                 <div class="eyebrow">Library</div>
                 <h3>Music Sources</h3>
               </div>
            </div>
            <span class="source-count">${visibleSources.length}/${visibleTotal}</span>
          </div>
          <div class="source-list-scroll">
            ${sourceRows(visibleSources, false)}
          </div>
        </section>

        <section class="panel-card source-panel">
          <div class="card-head">
            <div style="display:flex; align-items:center; gap:8px;">
               <ha-icon icon="mdi:eye-off" style="color:var(--ags-warn);"></ha-icon>
               <div>
                 <div class="eyebrow">Visibility</div>
                 <h3>Hidden Sources</h3>
               </div>
            </div>
            <span class="source-count">${hiddenSources.length}/${hiddenTotal}</span>
          </div>
          <div class="source-list-scroll">
            ${sourceRows(hiddenSources, true)}
          </div>
        </section>
      </div>
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
                <span>Master Off Override (Playback forces ON)</span>
                <input type="checkbox" style="width:20px; height:20px;" ${this.config.off_override ? "checked" : ""} onchange="this.getRootNode().host.updateConfig('off_override', this.checked)" />
              </label>

              <label class="list-select" style="margin:0;">
                <span>Persistent TV source</span>
                <input type="checkbox" style="width:20px; height:20px;" ${this.config.disable_tv_source ? "checked" : ""} onchange="this.getRootNode().host.updateConfig('disable_tv_source', this.checked)" />
              </label>
            </div>

            <div style="margin-top:24px;">
               <label>Sync Interval (Seconds)</label>
               <input
                 type="number"
                 min="5"
                 max="3600"
                 value="${this.config.interval_sync}"
                 onchange="this.getRootNode().host.updateConfig('interval_sync', parseInt(this.value))"
               />
               <div class="section-help" style="margin-top:8px;">Frequency of background state synchronization. Lower values are more responsive but increase CPU usage.</div>
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
                  <button class="danger-btn" style="margin-top:12px;" onclick="this.getRootNode().host.clearConfigValue('schedule_entity')">Remove</button>
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
                      ${this.getVisibleSources().map(s => {
                        const label = this.getSourceDisplayName(s);
                        return `<option value="${this.escapeHtml(label)}" ${label === defaultSourceSchedule.source_name ? "selected" : ""}>${this.escapeHtml(label)}</option>`;
                      }).join("")}
                    </select>
                  </div>
                  <button class="danger-btn" style="margin-top:12px;" onclick="this.getRootNode().host.clearConfigValue('default_source_schedule')">Remove</button>
                </div>
              ` : ''}
            </div>
          </div>
        </section>
      </div>

    `;
  }

  renderView(agsState) {
    if (!this.config) {
      return '<div class="panel-card loading">Initializing configuration…</div>';
    }
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
    const scrollState = this.captureScrollState();
    const resetToTop = this._resetScrollAfterRender;
    this._resetScrollAfterRender = false;
    const agsState = this.getAgsState();
    const { headerInfo } = this.getHeaderSummary(agsState);
    const theme = this.getThemePalette();

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          min-height: 100vh;
          --ags-panel-stable-vh: 100vh;
          background: ${theme.shellBg};
          color: ${theme.text};
          font-family: var(--ha-font-family-body, Roboto, sans-serif);
          color-scheme: ${theme.colorScheme};
          --ags-primary: ${theme.primary};
          --ags-primary-soft: ${theme.primarySoft};
          --ags-primary-strong: ${theme.primaryStrong};
          --ags-on-primary: ${theme.onPrimary};
          --ags-panel-bg: ${theme.shellBg};
          --ags-top-chrome: ${theme.chromeBg};
          --ags-surface: ${theme.surface};
          --ags-surface-soft: ${theme.surfaceSoft};
          --ags-glass: ${theme.glass};
          --ags-border: ${theme.border};
          --ags-border-strong: ${theme.borderStrong};
          --ags-shadow: ${theme.shadow};
          --ags-muted: ${theme.muted};
          --ags-subtle: ${theme.subtle};
          --ags-subtle-strong: ${theme.subtleStrong};
          --ags-error-color: ${theme.errorSoft};
          --ags-error-bg: ${theme.errorBg};
          --ags-log-bg: ${theme.logBg};
          --ags-log-text: ${theme.logText};
          --ags-focus-ring: 0 0 0 3px var(--ags-primary-soft);
          -webkit-tap-highlight-color: transparent;
          touch-action: manipulation;
        }

        @supports (height: 100svh) {
          :host {
            --ags-panel-stable-vh: 100svh;
            min-height: 100svh;
          }
        }

        * {
          box-sizing: border-box;
        }

        button {
          font: inherit;
        }

        .shell {
          max-width: 1400px;
          margin: 0 auto;
          padding: 24px 32px 100px;
          min-height: var(--ags-panel-stable-vh);
        }

        .top-chrome {
          position: sticky;
          top: 0;
          z-index: 30;
          margin: -24px -32px 24px;
          padding: calc(env(safe-area-inset-top, 0px) + 24px) 32px 12px;
          background: var(--ags-top-chrome);
          backdrop-filter: blur(18px);
        }

        .page-header {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          align-items: center;
          gap: 14px;
          margin-bottom: 18px;
        }

        .menu-btn {
          display: none;
          align-items: center;
          justify-content: center;
          width: 46px;
          height: 46px;
          border-radius: 14px;
          border: 1px solid var(--ags-border);
          background: var(--ags-glass);
          color: var(--primary-text-color);
          cursor: pointer;
          transition: background 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
        }

        .menu-btn:hover {
          background: var(--ags-subtle-strong);
          border-color: var(--ags-border-strong);
          transform: translateY(-1px);
        }

        .menu-btn ha-icon {
          --mdc-icon-size: 24px;
        }

        .title-block {
          min-width: 0;
          display: flex;
          align-items: baseline;
          gap: 12px;
          flex-wrap: wrap;
        }

        .title-block h1 {
          margin: 0;
          font-size: 1.35rem;
          font-weight: 800;
          line-height: 1.1;
          letter-spacing: -0.02em;
          color: var(--primary-text-color);
        }

        .title-block p {
          margin: 0;
          color: var(--ags-muted);
          font-size: 0.95rem;
          font-weight: 700;
          max-width: 600px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .tabs {
          display: flex;
          gap: 8px;
          margin-bottom: 0;
          overflow-x: auto;
          padding-bottom: 8px;
          scroll-snap-type: x proximity;
          scrollbar-width: none;
          -webkit-overflow-scrolling: touch;
          touch-action: pan-x;
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
          min-height: 46px;
          font-weight: 700;
          white-space: nowrap;
          scroll-snap-align: start;
          transition: all 0.2s ease;
        }

        .tab-btn:hover {
          background: var(--ags-subtle-strong);
          border-color: var(--ags-border-strong);
        }

        .tab-btn.active {
          background: var(--ags-primary);
          color: var(--ags-on-primary);
          border-color: var(--ags-primary);
          box-shadow: 0 8px 20px var(--ags-primary-soft);
        }

        .primary-btn {
          background: var(--ags-primary);
          color: var(--ags-on-primary);
          border: none;
          padding: 12px 24px;
          border-radius: 12px;
          min-height: 46px;
          font-weight: 800;
          cursor: pointer;
          box-shadow: 0 8px 20px var(--ags-primary-soft);
          transition: all 0.2s ease;
        }

        .primary-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 25px var(--ags-primary-strong);
        }

        .secondary-btn, .danger-btn {
          padding: 10px 18px;
          border-radius: 10px;
          min-height: 44px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.2s ease;
          border: 1px solid var(--ags-border);
          background: var(--ags-glass);
          color: var(--primary-text-color);
        }

        .secondary-btn:hover {
          background: var(--ags-subtle-strong);
        }

        .secondary-btn:disabled,
        .danger-btn:disabled,
        .primary-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
          transform: none;
        }

        .danger-btn {
          color: var(--ags-error-color);
          border-color: var(--ags-error-bg);
        }

        .danger-btn:hover {
          background: var(--ags-error-bg);
        }

        .save-status {
          margin-left: auto;
          align-self: center;
          color: var(--ags-muted);
          font-size: 0.78rem;
          font-weight: 900;
          text-transform: uppercase;
          white-space: nowrap;
        }

        .panel-card {
          background: var(--ags-surface);
          backdrop-filter: blur(20px);
          border: 1px solid var(--ags-border);
          border-radius: 28px;
          padding: 32px;
          box-shadow: var(--ags-shadow);
          min-width: 0;
        }

        .source-toolbar {
          padding: 16px;
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          gap: 12px;
          position: sticky;
          top: calc(env(safe-area-inset-top, 0px) + 132px);
          z-index: 5;
        }

        .source-toolbar input {
          min-height: 42px;
        }

        .source-toolbar .secondary-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          white-space: nowrap;
        }

        .secondary-btn.active {
          background: var(--ags-primary-soft);
          border-color: var(--ags-primary);
        }

        .source-grid {
          align-items: start;
        }

        .source-panel {
          display: flex;
          flex-direction: column;
          min-height: 0;
          overflow: hidden;
          padding: 24px;
        }

        .source-panel .card-head {
          margin-bottom: 12px;
          flex-shrink: 0;
        }

        .source-list-scroll {
          overflow-y: auto;
          min-height: 240px;
          max-height: min(680px, calc(var(--ags-panel-stable-vh) - 360px));
          padding-right: 4px;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior: contain;
          touch-action: pan-y;
        }

        .source-folder-group {
          margin-bottom: 14px;
        }

        .source-folder-title {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 4px 10px;
          color: var(--ags-muted);
          font-size: 0.76rem;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          position: sticky;
          top: 0;
          background: var(--ags-surface);
          z-index: 1;
        }

        .source-count {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 28px;
          min-height: 24px;
          border-radius: 999px;
          padding: 2px 8px;
          background: var(--ags-subtle);
          border: 1px solid var(--ags-border);
          color: var(--ags-muted);
          font-size: 0.75rem;
          font-weight: 900;
          white-space: nowrap;
        }

        .grid {
          display: grid;
          gap: 24px;
        }

        .cols-2 {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .home-grid {
          grid-template-columns: minmax(360px, 440px) minmax(0, 1fr);
          align-items: start;
          max-width: 1240px;
          margin: 0 auto;
          min-height: min(860px, calc(var(--ags-panel-stable-vh) - 230px));
        }

        .home-dashboard-wrap {
          min-height: 0;
          min-width: 0;
          display: flex;
          flex-direction: column;
          align-self: start;
          position: sticky;
          top: calc(env(safe-area-inset-top, 0px) + 148px);
        }

        .embedded-dashboard {
          display: block;
          width: 100%;
          flex: 1 1 auto;
          min-width: 0;
          --ags-card-max-width: 100%;
          --ags-card-viewport-offset: 230px;
        }

        .home-entities-panel {
          padding: 20px;
          border-radius: 24px;
          display: flex;
          flex-direction: column;
          min-height: 0;
          overflow: hidden;
        }

        .home-entities-head {
          margin-bottom: 12px;
          flex-shrink: 0;
        }

        .home-entities-scroll {
          flex: 1;
          overflow-y: auto;
          padding-right: 4px;
          scroll-behavior: smooth;
          min-height: 0;
          max-height: min(760px, calc(var(--ags-panel-stable-vh) - 320px));
          -webkit-overflow-scrolling: touch;
          overscroll-behavior: contain;
          touch-action: pan-y;
        }

        .room-layout {
          display: grid;
          grid-template-columns: 320px 1fr;
          gap: 32px;
        }

        .section-tabs {
          display: flex;
          gap: 8px;
          margin-bottom: 18px;
          overflow-x: auto;
          scrollbar-width: none;
        }

        .section-tabs::-webkit-scrollbar { display: none; }

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

        .compact-head {
          margin-bottom: 16px;
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
          background: var(--ags-subtle);
          border: 1px solid var(--ags-border);
          border-radius: 20px;
          padding: 20px;
          min-width: 0;
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
          background: var(--ags-primary-soft);
          color: var(--primary-text-color);
          border: 1px solid var(--ags-primary-strong);
        }

        .status-off {
          background: var(--ags-subtle-strong);
          color: var(--ags-muted);
          border-color: var(--ags-border);
        }

        .tone-pill {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 28px;
          padding: 4px 10px;
          border-radius: 999px;
          border: 1px solid var(--ags-border);
          background: var(--ags-subtle);
          color: var(--primary-text-color);
          font-size: 0.72rem;
          font-weight: 900;
          text-transform: uppercase;
          white-space: nowrap;
        }

        .tone-good,
        .tone-info {
          background: var(--ags-primary-soft);
          border-color: var(--ags-border-strong);
        }

        .tone-warn {
          background: var(--ags-error-bg);
          color: var(--ags-error-color);
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
          background: var(--ags-subtle);
          border: 1px solid var(--ags-border);
          border-radius: 16px;
          transition: all 0.2s ease;
        }

        .table-row:hover {
          background: var(--ags-subtle-strong);
          transform: scale(1.01);
        }

        .entities-head {
          grid-template-columns: 1.5fr 1fr 80px;
          padding: 0 16px;
        }

        .entities-row {
          grid-template-columns: 1.5fr 1fr 80px;
          padding: 12px 16px;
          margin-bottom: 8px;
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
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .list-select {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          min-height: 52px;
          border-radius: 16px;
          text-align: left;
          background: var(--ags-subtle);
          border: 1px solid var(--ags-border);
          color: var(--primary-text-color);
          cursor: pointer;
          font-weight: 700;
          margin-bottom: 8px;
          transition: all 0.2s ease;
        }

        .list-select.active {
          background: var(--ags-primary-soft);
          border-color: var(--ags-primary);
          color: var(--primary-text-color);
        }

        .device-card, .source-card {
          background: var(--ags-subtle);
          border: 1px solid var(--ags-border);
          border-radius: 20px;
          padding: 24px;
          margin-bottom: 16px;
          min-width: 0;
        }

        .room-device-card {
          border-radius: 14px;
          background: var(--ags-subtle);
        }

        .device-title-row,
        .rank-row,
        .source-rank-row {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
        }

        .device-copy,
        .rank-copy {
          min-width: 0;
          flex: 1;
        }

        .device-icon,
        .rank-badge,
        .drag-handle {
          width: 38px;
          height: 38px;
          border-radius: 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .device-icon {
          background: var(--ags-primary);
          color: var(--ags-on-primary);
        }

        .rank-badge {
          background: var(--ags-surface-soft);
          border: 1px solid var(--ags-border);
          color: var(--ags-primary);
          font-weight: 900;
        }

        .drag-handle {
          color: var(--ags-muted);
          cursor: grab;
        }

        .device-editor {
          margin-top: 20px;
          padding-top: 20px;
          border-top: 1px solid var(--ags-border);
        }

        .rank-list {
          display: grid;
          gap: 10px;
        }

        .rank-row {
          padding: 14px;
          border-radius: 14px;
          border: 1px solid var(--ags-border);
          background: var(--ags-subtle);
        }

        .rank-actions,
        .header-meta {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
          flex-wrap: wrap;
        }

        .icon-only-btn {
          width: 42px;
          height: 42px;
          padding: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .icon-text-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }

        .ott-stack {
          padding: 14px;
          border-radius: 14px;
          background: var(--ags-surface-soft);
          border: 1px solid var(--ags-border);
        }

        .ott-card {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          gap: 12px;
          align-items: center;
          margin-top: 12px;
          padding: 12px;
          border-radius: 12px;
          background: var(--ags-subtle);
          border: 1px solid var(--ags-border);
        }

        .ott-fields {
          display: grid;
          grid-template-columns: minmax(0, 1.2fr) minmax(160px, 0.8fr);
          gap: 12px;
          min-width: 0;
        }

        .ott-icon {
          background: var(--ags-primary-soft);
          color: var(--primary-text-color);
        }

        .modal-backdrop {
          position: fixed;
          inset: 0;
          z-index: 200;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          background: rgba(0, 0, 0, 0.38);
        }

        .modal-card {
          width: min(720px, 100%);
          max-height: min(760px, calc(var(--ags-panel-stable-vh) - 40px));
          overflow: auto;
          background: var(--ags-surface);
          border: 1px solid var(--ags-border);
          border-radius: 20px;
          padding: 24px;
          box-shadow: var(--ags-shadow);
        }

        .area-import-row .section-help {
          display: block;
          max-width: 100%;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
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
          overflow-wrap: anywhere;
        }

        .section-line {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 14px;
          margin-bottom: 12px;
        }

        input, select {
          width: 100%;
          background: var(--ags-surface-soft);
          border: 1px solid var(--ags-border);
          border-radius: 12px;
          padding: 12px 16px;
          min-height: 46px;
          color: var(--primary-text-color);
          font: inherit;
          font-weight: 600;
          transition: all 0.2s ease;
        }

        input:focus, select:focus {
          outline: none;
          border-color: var(--ags-primary);
          background: var(--ags-subtle-strong);
        }

        button:focus-visible,
        input:focus-visible,
        select:focus-visible,
        .list-select:focus-visible,
        ha-switch:focus-visible {
          outline: none;
          box-shadow: var(--ags-focus-ring);
          border-color: var(--ags-border-strong);
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
          color: var(--ags-error-color);
          border-color: var(--ags-error-bg);
          background: var(--ags-error-bg);
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
          min-width: 0;
          text-align: left;
          font: inherit;
        }

        .browse-result-card:disabled {
          cursor: default;
          opacity: 0.74;
        }

        .grid > *,
        .inline-grid > * {
          min-width: 0;
        }

        .browse-result-card:hover {
          transform: translateY(-2px);
          border-color: var(--ags-border-strong);
        }

        .browse-result-card:focus-visible {
          outline: none;
          box-shadow: var(--ags-focus-ring);
          border-color: var(--ags-border-strong);
        }

        .browse-result-art {
          position: relative;
          aspect-ratio: 1.1 / 1;
          overflow: hidden;
          border-radius: 16px;
          background:
            linear-gradient(140deg, var(--ags-primary-soft), var(--ags-subtle)),
            var(--ags-subtle);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .browse-art-fallback {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .browse-result-art:not(.no-image):not(.image-failed) .browse-art-fallback {
          display: none;
        }

        .browse-result-copy {
          min-width: 0;
        }

        .log-view {
          background: var(--ags-log-bg);
          color: var(--ags-log-text);
          padding: 24px;
          border-radius: 20px;
          font-family: var(--code-font-family, monospace);
          font-size: 0.9rem;
          line-height: 1.6;
          max-height: 500px;
          overflow-y: auto;
          border: 1px solid var(--ags-border);
        }

        @media (max-width: 1180px) {
          .home-grid {
            grid-template-columns: minmax(0, 1fr);
            min-height: 0;
          }
          .home-dashboard-wrap {
            position: static;
            width: min(100%, 640px);
            margin: 0 auto;
          }
          .embedded-dashboard {
            --ags-card-max-width: min(100%, 640px);
            --ags-card-viewport-offset: 208px;
          }
          .home-entities-scroll { max-height: none; }
        }

        @media (max-width: 1024px) {
          .shell { padding: 24px 16px 100px; }
          .top-chrome {
            margin: -24px -16px 20px;
            padding: calc(env(safe-area-inset-top, 0px) + 20px) 16px 10px;
          }
          .page-header {
            grid-template-columns: auto minmax(0, 1fr);
          }
          .menu-btn {
            display: inline-flex;
          }
          .home-grid, .cols-2, .room-layout { grid-template-columns: 1fr; }
          .table-row { grid-template-columns: 1fr 1fr; }
          .entities-row,
          .entities-head { grid-template-columns: 1fr 1fr; }
          .table-head { display: none; }
          .home-grid { min-height: 0; }
          .home-dashboard-wrap { min-height: 0; position: static; width: min(100%, 620px); }
          .embedded-dashboard { --ags-card-viewport-offset: 196px; }
          .home-entities-scroll { max-height: none; }
        }

        @media (max-width: 720px) {
          .page-header,
          .card-head,
          .device-summary {
            flex-direction: column;
            align-items: stretch;
          }
          .page-header {
            display: grid;
            grid-template-columns: auto minmax(0, 1fr);
            gap: 12px;
            margin-bottom: 16px;
          }
          .panel-card {
            padding: 20px;
          }
          .title-block h1 {
            font-size: 1.2rem;
          }
          .tabs {
            padding-bottom: 6px;
          }
          .home-entities-panel {
            overflow: visible;
          }
          .home-dashboard-wrap {
            width: min(100%, 560px);
          }
          .embedded-dashboard {
            --ags-card-viewport-offset: 178px;
          }
          .home-entities-scroll {
            overflow: visible;
            padding-right: 0;
            max-height: none;
          }
          .source-toolbar {
            position: static;
            flex-direction: column;
            align-items: stretch;
          }
          .source-toolbar .secondary-btn {
            justify-content: center;
          }
          .source-list-scroll {
            max-height: min(560px, calc(var(--ags-panel-stable-vh) - 300px));
          }
          .rank-row,
          .device-summary,
          .ott-card {
            grid-template-columns: 1fr;
            align-items: stretch;
          }
          .rank-row,
          .device-title-row {
            flex-wrap: wrap;
          }
          .rank-actions,
          .header-meta {
            justify-content: flex-start;
          }
          .ott-fields {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 560px) {
          .shell {
            padding: 16px 12px 92px;
          }
          .top-chrome {
            margin: -16px -12px 16px;
            padding: calc(env(safe-area-inset-top, 0px) + 16px) 12px 8px;
          }
          .panel-card,
          .device-card,
          .source-card {
            padding: 16px;
            border-radius: 20px;
          }
          .inline-grid,
          .browse-results-grid {
            grid-template-columns: 1fr;
          }
          .tab-btn,
          .primary-btn,
          .secondary-btn,
          .danger-btn {
            width: 100%;
          }
          .tabs .tab-btn {
            width: auto;
            flex: 0 0 auto;
          }
          .title-block {
            gap: 6px;
            align-items: flex-start;
            flex-direction: column;
          }
          .home-dashboard-wrap,
          .embedded-dashboard {
            width: 100%;
          }
          .embedded-dashboard {
            --ags-card-viewport-offset: 162px;
          }
          .table-row {
            grid-template-columns: 1fr;
            gap: 8px;
          }
          .entities-row,
          .entities-head { grid-template-columns: 1fr; }
        }

        @media (hover: none), (pointer: coarse) {
          .menu-btn:hover,
          .tab-btn:hover,
          .primary-btn:hover,
          .secondary-btn:hover,
          .danger-btn:hover,
          .table-row:hover,
          .browse-result-card:hover {
            transform: none;
            box-shadow: none;
          }

          .table-row:hover,
          .browse-result-card:hover {
            background: inherit;
            border-color: inherit;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
            scroll-behavior: auto !important;
          }
        }
      </style>

      <div class="shell">
        <div class="top-chrome">
          <div class="page-header">
            <button class="menu-btn" aria-label="Toggle navigation menu" onclick="this.getRootNode().host.toggleMenu()">
              <ha-icon icon="mdi:menu"></ha-icon>
            </button>
            <div class="title-block">
              <h1>AGS Service</h1>
              <p class="live-header-info">${this.escapeHtml(headerInfo)}</p>
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
            ${this._saveStatus ? `<div class="save-status">${this.escapeHtml(this._saveStatus)}</div>` : ""}
          </div>
        </div>

        ${
          this.loading
            ? '<div class="panel-card loading">Loading AGS configuration…</div>'
            : this.error
              ? `<div class="panel-card error">${this.escapeHtml(this.error)}</div>`
              : this.renderView(agsState)
        }
      </div>
    `;

    this._hasRendered = true;
    this._lastAgsSignature = this.getAgsStateSignature();
    this.bindEntityPickers();
    this.bindEmbeddedDashboard();
    requestAnimationFrame(() => {
      this.restoreScrollState(scrollState, resetToTop);
      requestAnimationFrame(() => this.restoreScrollState(scrollState, resetToTop));
    });
  }
}

if (!customElements.get("ags-panel")) {
  customElements.define("ags-panel", AGSPanel);
}
