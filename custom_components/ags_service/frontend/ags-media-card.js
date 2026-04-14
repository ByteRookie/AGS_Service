class AgsMediaCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._section = 'player';
    this._browseStack = [];
    this._browseItems = [];
    this._loadingBrowse = false;
    this._browseError = "";
    this._showSourceMenu = false;
    this._pendingVolume = new Map();
    this._volumeTimers = new Map();
    this._handleOutsideClick = this._handleOutsideClick.bind(this);
    this._handleKeydown = this._handleKeydown.bind(this);
  }

  connectedCallback() {
    document.addEventListener("click", this._handleOutsideClick, true);
    document.addEventListener("keydown", this._handleKeydown, true);
  }

  disconnectedCallback() {
    document.removeEventListener("click", this._handleOutsideClick, true);
    document.removeEventListener("keydown", this._handleKeydown, true);
    for (const timer of this._volumeTimers.values()) {
      window.clearTimeout(timer);
    }
    this._volumeTimers.clear();
  }

  setConfig(config) {
    this._config = config;
    this.render(true);
  }

  getCardSize() { return 6; }

  set hass(hass) {
    const hadBrowseItems = this._browseItems.length > 0;
    this._hass = hass;
    this._syncPendingVolumes();
    if (this._config) {
      this.render();
      if (this._section === "browse" && !hadBrowseItems && !this._loadingBrowse) {
        this.browseMedia();
      }
    }
  }

  getAgsPlayer() {
    if (!this._hass) return null;
    return this._hass.states[this._config.entity] || 
           Object.values(this._hass.states).find(s => s?.attributes?.ags_status !== undefined) || null;
  }

  getControlPlayer() {
    const ags = this.getAgsPlayer();
    const id = ags?.attributes?.control_device_id || ags?.attributes?.primary_speaker;
    return id && this._hass?.states?.[id] ? this._hass.states[id] : null;
  }

  escapeHtml(v) { return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  toArray(v) { return Array.isArray(v) ? v : []; }
  clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

  getThemeSignature() {
    return JSON.stringify({
      darkMode: Boolean(this._hass?.themes?.darkMode),
      selectedTheme: this._hass?.selectedTheme?.theme || this._hass?.themes?.default_theme || "",
    });
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
    const surfaceStrong = this.mixColors(surface, background, isDark ? 0.08 : 0.28);
    const surfaceSoft = this.mixColors(surface, background, isDark ? 0.16 : 0.42);
    const onPrimary = this.getReadableTextColor(primary, text);

    return {
      colorScheme: isDark ? "dark" : "light",
      shellBg: this.rgb(this.mixColors(background, primary, isDark ? 0.08 : 0.03)),
      surface: this.rgb(surface),
      surfaceStrong: this.rgb(surfaceStrong),
      surfaceSoft: this.rgb(surfaceSoft),
      glass: this.rgba(surface, isDark ? 0.84 : 0.94),
      glassHeavy: this.rgba(surfaceStrong, isDark ? 0.94 : 0.98),
      text: this.rgb(text),
      muted: this.rgb(muted),
      primary: this.rgb(primary),
      primarySoft: this.rgba(primary, isDark ? 0.18 : 0.12),
      primaryStrong: this.rgba(primary, isDark ? 0.28 : 0.18),
      primaryHalo: this.rgba(primary, isDark ? 0.34 : 0.22),
      onPrimary: this.rgb(onPrimary),
      outline: this.rgba(text, isDark ? 0.18 : 0.12),
      divider: this.rgba(text, isDark ? 0.12 : 0.1),
      subdued: this.rgba(text, isDark ? 0.08 : 0.05),
      scrubber: this.rgba(text, isDark ? 0.16 : 0.12),
      shadow: isDark ? "0 24px 48px rgba(2, 6, 23, 0.42)" : "0 24px 48px rgba(15, 23, 42, 0.12)",
      controlShadow: isDark ? "0 10px 20px rgba(2, 6, 23, 0.3)" : "0 10px 18px rgba(15, 23, 42, 0.14)",
    };
  }

  resolveMediaUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.startsWith("/") || raw.startsWith("http")) return raw;
    if (this._hass) {
      const auth = this._hass.auth || {};
      const token = auth.data?.access_token || auth.accessToken;
      if (token) return `${raw}?authSig=${token}`;
    }
    return raw;
  }

  getArtworkUrl(ctrl, ags) {
    const url = ctrl?.attributes?.entity_picture || ags?.attributes?.entity_picture;
    return this.resolveMediaUrl(url);
  }

  getLiveMediaPosition(entity) {
    if (!entity || entity.state !== "playing" || !entity.attributes.media_position_updated_at) return entity?.attributes?.media_position || 0;
    const now = Date.now() / 1000;
    const update = new Date(entity.attributes.media_position_updated_at).getTime() / 1000;
    return (entity.attributes.media_position || 0) + (now - update);
  }

  formatTime(s) {
    if (!s || isNaN(s)) return "0:00";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = Math.floor(s % 60);
    return `${h > 0 ? h + ':' : ''}${m}:${r < 10 ? '0' + r : r}`;
  }

  setSection(s) {
    if (this._section === s) return;
    this._section = s;
    if (s === "browse" && !this._browseItems.length) this.browseMedia();
    this.render(true);
  }

  toggleSourceMenu() {
    this._showSourceMenu = !this._showSourceMenu;
    this.render(true);
  }

  callService(domain, service, data) { 
    this._hass.callService(domain, service, data); 
    if (service === 'select_source') this._showSourceMenu = false;
    this.render(true);
  }

  _handleOutsideClick(event) {
    if (!this._showSourceMenu) return;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (!path.includes(this)) {
      this._showSourceMenu = false;
      this.render(true);
    }
  }

  _handleKeydown(event) {
    if (event.key === "Escape" && this._showSourceMenu) {
      this._showSourceMenu = false;
      this.render(true);
    }
  }

  getRenderSignature() {
    const ags = this.getAgsPlayer();
    const control = this.getControlPlayer();
    const agsAttrs = ags?.attributes || {};
    const controlAttrs = control?.attributes || {};

    return JSON.stringify({
      section: this._section,
      showSourceMenu: this._showSourceMenu,
      loadingBrowse: this._loadingBrowse,
      browseError: this._browseError,
      browseStack: this._browseStack.map((item) => `${item.media_content_type}:${item.media_content_id}`),
      browseItems: this._browseItems.map((item) => `${item.title}:${item.media_content_type}:${item.media_content_id}:${item.can_expand}:${item.can_play}`),
      theme: this.getThemeSignature(),
      ags: ags
        ? {
            entity_id: ags.entity_id,
            state: ags.state,
            ags_status: agsAttrs.ags_status,
            source: agsAttrs.source,
            selected_source_name: agsAttrs.selected_source_name,
            primary_speaker_room: agsAttrs.primary_speaker_room,
            active_rooms: agsAttrs.active_rooms || [],
            room_details: agsAttrs.room_details || [],
            ags_sources: agsAttrs.ags_sources || [],
            browse_entity_id: agsAttrs.browse_entity_id,
            control_device_id: agsAttrs.control_device_id,
          }
        : null,
      control: control
        ? {
            entity_id: control.entity_id,
            state: control.state,
            media_title: controlAttrs.media_title,
            media_artist: controlAttrs.media_artist,
            media_duration: controlAttrs.media_duration,
            media_position_updated_at: controlAttrs.media_position_updated_at,
            source: controlAttrs.source,
            entity_picture: controlAttrs.entity_picture,
            group_members: controlAttrs.group_members,
          }
        : null,
    });
  }

  async browseMedia(node = null) {
    const ags = this.getAgsPlayer();
    if (!ags) return;
    this._browseError = "";

    if (node && (!node.media_content_type || !node.media_content_id)) {
      this._browseError = "Media content type and ID must be provided together";
      this.render(true);
      return;
    }

    const browseEid = ags.attributes.browse_entity_id;
    const fallbackEid = ags.attributes.primary_speaker;
    const targetEid = (browseEid && browseEid !== "none") ? browseEid : (fallbackEid && fallbackEid !== "none" ? fallbackEid : null);
    if (!targetEid) {
      this._browseItems = [];
      this._browseError = "No speaker configured for browsing. Add a speaker in AGS settings.";
      this.render(true);
      return;
    }
    this._loadingBrowse = true;
    this.render(true);

    try {
      const payload = { type: "media_player/browse_media", entity_id: targetEid };
      if (node) {
        payload.media_content_id = node.media_content_id;
        payload.media_content_type = node.media_content_type;
      }
      const res = await this._hass.callWS(payload);
      this._browseItems = res.children || [];
      if (node) {
        if (!this._browseStack.length || this._browseStack[this._browseStack.length-1].media_content_id !== node.media_content_id) {
          this._browseStack.push(node);
        }
      } else { this._browseStack = []; }
    } catch (e) {
      console.error(e);
      this._browseError = "Could not load media library. Make sure your speaker is reachable.";
    }
    this._loadingBrowse = false;
    this.render(true);
  }

  async browseBack() {
    this._browseStack.pop();
    const prev = this._browseStack[this._browseStack.length - 1] || null;
    await this.browseMedia(prev);
  }

  _syncPendingVolumes() {
    if (!this._hass || !this._pendingVolume.size) return;
    for (const [entityId, pending] of this._pendingVolume.entries()) {
      const actual = this.getVolumePercent(entityId);
      if (Math.abs(actual - pending) <= 1) {
        this._pendingVolume.delete(entityId);
        const timer = this._volumeTimers.get(entityId);
        if (timer) {
          window.clearTimeout(timer);
          this._volumeTimers.delete(entityId);
        }
      }
    }
  }

  getVolumePercent(entityOrState) {
    const state = typeof entityOrState === "string" ? this._hass?.states?.[entityOrState] : entityOrState;
    return Math.round(this.clamp(Number(state?.attributes?.volume_level || 0), 0, 1) * 100);
  }

  getDisplayedVolume(entityOrState) {
    const entityId = typeof entityOrState === "string" ? entityOrState : entityOrState?.entity_id;
    if (entityId && this._pendingVolume.has(entityId)) {
      return this._pendingVolume.get(entityId);
    }
    return this.getVolumePercent(entityOrState);
  }

  _updateVolumeLabel(entityId, value) {
    if (!this.shadowRoot) return;
    this.shadowRoot.querySelectorAll(`[data-volume-id="${entityId}"]`).forEach((node) => {
      node.textContent = `${value}%`;
    });
  }

  _flushVolumeSet(entityId) {
    if (!entityId || !this._hass) return;
    this._volumeTimers.delete(entityId);
    const percent = this._pendingVolume.get(entityId);
    if (percent === undefined) return;
    this._hass.callService("media_player", "volume_set", {
      entity_id: entityId,
      volume_level: this.clamp(Number(percent || 0), 0, 100) / 100,
    });
  }

  queueVolumeSet(entityId, percent) {
    if (!entityId) return;
    const nextValue = Math.round(this.clamp(Number(percent || 0), 0, 100));
    this._pendingVolume.set(entityId, nextValue);
    this._updateVolumeLabel(entityId, nextValue);

    const existingTimer = this._volumeTimers.get(entityId);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }
    const timer = window.setTimeout(() => this._flushVolumeSet(entityId), 120);
    this._volumeTimers.set(entityId, timer);
  }

  commitVolumeSet(entityId, percent) {
    if (!entityId) return;
    const nextValue = Math.round(this.clamp(Number(percent || 0), 0, 100));
    this._pendingVolume.set(entityId, nextValue);
    this._updateVolumeLabel(entityId, nextValue);
    const existingTimer = this._volumeTimers.get(entityId);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }
    this._flushVolumeSet(entityId);
  }

  setVolume(entityId, percent) {
    this.commitVolumeSet(entityId, percent);
  }

  nudgeVolume(entityId, delta) {
    if (!entityId) return;
    this.setVolume(entityId, this.getDisplayedVolume(entityId) + Number(delta || 0));
  }

  _handleBrowseClick(index) {
    const item = this._browseItems[index];
    if (!item) return;
    if (item.can_expand) { this.browseMedia(item); } 
    else if (item.can_play) {
      if (!item.media_content_id || !item.media_content_type) {
        console.warn("Cannot play media: missing content ID or type", item);
        return;
      }
      const ags = this.getAgsPlayer();
      this.callService('media_player', 'play_media', { entity_id: ags.entity_id, media_content_id: item.media_content_id, media_content_type: item.media_content_type });
      this.setSection('player');
    }
  }

  renderPlayerSection(ags, control) {
    if (ags.state === "off") {
      return `
        <div class="system-off-view">
          <div class="off-icon-wrap"><ha-icon icon="mdi:power-sleep"></ha-icon></div>
          <div class="off-text">System is Offline</div>
          <button class="play-btn turn-on-btn" onclick="this.getRootNode().host.callService('media_player', 'turn_on', {entity_id: '${ags.entity_id}'})">
            <ha-icon icon="mdi:power"></ha-icon><span>Activate System</span>
          </button>
        </div>
      `;
    }

    const status = ags.attributes.ags_status;
    const isTv = status === "ON TV";
    const isPlaying = ["playing", "buffering"].includes(control?.state || ags.state);
    const pic = this.getArtworkUrl(control, ags);
    const title = isTv ? "Television Audio" : (control?.attributes?.media_title || "Nothing Playing");
    const subtitle = isTv ? (control?.attributes?.friendly_name || "TV Mode") : (control?.attributes?.media_artist || "Ready to Play");
    const duration = Number(control?.attributes?.media_duration || 0);
    const pos = this.getLiveMediaPosition(control || ags);
    const prog = duration > 0 ? (pos / duration) * 100 : 0;
    const sourceLabel = ags.attributes.selected_source_name || ags.attributes.source || "Ready";
    const sourceMenuId = "ags-source-menu";

    const agsSources = this.toArray(ags.attributes.ags_sources);
    const nativeSources = this.toArray(ags.attributes.source_list);

    return `
      <div class="player-view">
        <div class="hero-strip" style="position: relative;">
          <button
            type="button"
            class="hero-pill hero-trigger clickable"
            aria-haspopup="menu"
            aria-expanded="${this._showSourceMenu ? "true" : "false"}"
            aria-controls="${sourceMenuId}"
            onclick="this.getRootNode().host.toggleSourceMenu()"
          >
            ${this.escapeHtml(sourceLabel)}
            <ha-icon icon="mdi:chevron-down" style="--mdc-icon-size: 14px; margin-left: 4px;"></ha-icon>
          </button>
          ${this._showSourceMenu ? `
            <div id="${sourceMenuId}" class="source-menu card-glass" role="menu" aria-label="Select Source" style="position: absolute; top: 48px; left: 0; z-index: 100; min-width: 200px;">
              <div style="font-size:0.7rem; font-weight:900; padding:8px 16px; color:var(--text-sec); text-transform:uppercase;">Select Source</div>
              ${agsSources.map(s => `<button type="button" role="menuitem" class="source-menu-item" onclick="this.getRootNode().host.callService('media_player', 'select_source', {entity_id: '${ags.entity_id}', source: '${s.name}'})">${this.escapeHtml(s.name)}</button>`).join("")}
              ${nativeSources.filter(s => !agsSources.find(as => as.name === s)).map(s => `<button type="button" role="menuitem" class="source-menu-item" onclick="this.getRootNode().host.callService('media_player', 'select_source', {entity_id: '${ags.entity_id}', source: '${s}'})">${this.escapeHtml(s)}</button>`).join("")}
            </div>
          ` : ""}
          <span class="hero-pill subtle">${this.escapeHtml(isTv ? "TV Session" : isPlaying ? "Live Playback" : "Standby")}</span>
        </div>
        <div class="art-focal">
          <div class="art-stack ${isTv ? 'tv-gradient' : ''}">
            <div class="art-aura"></div>
            ${pic && !isTv ? `<img class="main-art" src="${pic}" />` : `
              <div class="idle-art">
                <ha-icon icon="${isTv ? 'mdi:television-classic' : 'mdi:music-note-plus'}"></ha-icon>
              </div>
            `}
          </div>
        </div>
        <div class="track-info">
          <div class="track-title">${this.escapeHtml(title)}</div>
          <div class="track-subtitle">${this.escapeHtml(subtitle)}</div>
        </div>
        <div class="playback-controls">
          <div class="progress-bar"><div class="progress-fill" style="width:${prog}%;"></div></div>
          <div class="time-meta"><span>${this.formatTime(pos)}</span><span>${duration > 0 ? this.formatTime(duration) : ""}</span></div>
          <div class="buttons-row">
            <button class="transport-btn" aria-label="Previous track" onclick="this.getRootNode().host.callService('media_player', 'media_previous_track', {entity_id: '${ags.entity_id}'})"><ha-icon icon="mdi:skip-previous"></ha-icon></button>
            <button class="play-btn" aria-label="${isPlaying ? "Pause" : "Play"}" onclick="this.getRootNode().host.callService('media_player', 'media_play_pause', {entity_id: '${ags.entity_id}'})"><ha-icon icon="${isPlaying ? 'mdi:pause' : 'mdi:play'}"></ha-icon></button>
            <button class="transport-btn" aria-label="Next track" onclick="this.getRootNode().host.callService('media_player', 'media_next_track', {entity_id: '${ags.entity_id}'})"><ha-icon icon="mdi:skip-next"></ha-icon></button>
          </div>
        </div>
      </div>
    `;
  }

  renderVolumesSection(ags) {
    const groupVol = this.getDisplayedVolume(ags);
    const rooms = this.toArray(ags.attributes.room_details);
    return `
      <div class="volumes-view">
        <div class="view-title">Volume</div>
        <div class="list-card master-vol-card">
          <div class="volume-card-head">
            <div>
              <div class="control-eyebrow">Group Master</div>
              <div class="volume-figure" data-volume-id="${ags.entity_id}">${groupVol}%</div>
            </div>
            <div class="volume-chip">All Active Rooms</div>
          </div>
          <div class="slider-shell slider-shell-master">
            <button type="button" class="slider-icon-btn slider-icon-btn-master" aria-label="Lower master volume" onclick="this.getRootNode().host.nudgeVolume('${ags.entity_id}', -6)">
              <ha-icon icon="mdi:minus"></ha-icon>
            </button>
            <input class="volume-slider volume-slider-master" type="range" min="0" max="100" value="${groupVol}" aria-label="Group master volume" oninput="this.getRootNode().host.queueVolumeSet('${ags.entity_id}', this.value)" onchange="this.getRootNode().host.commitVolumeSet('${ags.entity_id}', this.value)" />
            <button type="button" class="slider-icon-btn slider-icon-btn-master" aria-label="Raise master volume" onclick="this.getRootNode().host.nudgeVolume('${ags.entity_id}', 6)">
              <ha-icon icon="mdi:plus"></ha-icon>
            </button>
          </div>
        </div>
        <div class="room-levels-stack">
          ${rooms.filter(r => r.active).map(r => {
            const spkId = r.devices?.find(d => d.device_type === "speaker")?.entity_id;
            const spkState = spkId ? this._hass.states[spkId] : null;
            const v = this.getDisplayedVolume(spkId || spkState);
            return `
              <div class="list-card volume-room-card">
                <div class="vol-label-row room-volume-head"><span>${this.escapeHtml(r.name)}</span><span data-volume-id="${spkId || `room-${this.escapeHtml(r.name)}`}">${v}%</span></div>
                <div class="slider-shell">
                  <button type="button" class="slider-icon-btn" aria-label="Lower ${this.escapeHtml(r.name)} volume" ${!spkId ? 'disabled' : ''} onclick="this.getRootNode().host.nudgeVolume('${spkId}', -6)">
                    <ha-icon icon="mdi:minus"></ha-icon>
                  </button>
                  <input class="volume-slider" type="range" min="0" max="100" value="${v}" ${!spkId ? 'disabled' : ''} aria-label="${this.escapeHtml(r.name)} volume" oninput="this.getRootNode().host.queueVolumeSet('${spkId}', this.value)" onchange="this.getRootNode().host.commitVolumeSet('${spkId}', this.value)" />
                  <button type="button" class="slider-icon-btn" aria-label="Raise ${this.escapeHtml(r.name)} volume" ${!spkId ? 'disabled' : ''} onclick="this.getRootNode().host.nudgeVolume('${spkId}', 6)">
                    <ha-icon icon="mdi:plus"></ha-icon>
                  </button>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  render(force = false) {
    const signature = this.getRenderSignature();
    if (!force && this.shadowRoot.innerHTML && signature === this._lastRenderSignature) {
      return;
    }
    this._lastRenderSignature = signature;

    const ags = this.getAgsPlayer();
    if (!ags) {
      this.shadowRoot.innerHTML = `
        <ha-card style="padding:24px; border-radius:24px;">
          <div style="font-weight:700;">AGS media player is unavailable.</div>
        </ha-card>
      `;
      return;
    }
    const control = this.getControlPlayer();
    const pic = this.getArtworkUrl(control, ags);
    const active = this.toArray(ags.attributes.active_rooms);
    const currentSrc = ags.attributes.source || ags.attributes.selected_source_name || "Idle";
    const isSystemOn = ags.state !== "off";
    const theme = this.getThemePalette();
    
    const main = ags.attributes.primary_speaker_room || (active.length > 0 ? active[0] : "");
    const others = active.length > 1 ? ` + ${active.length - 1}` : "";
    const headerInfo = active.length > 0 ? `${main}${others}` : "System Idle";

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          color-scheme: ${theme.colorScheme};
          --primary: ${theme.primary};
          --primary-soft: ${theme.primarySoft};
          --primary-strong: ${theme.primaryStrong};
          --primary-halo: ${theme.primaryHalo};
          --on-primary: ${theme.onPrimary};
          --card-bg: ${theme.surface};
          --card-bg-strong: ${theme.surfaceStrong};
          --card-bg-soft: ${theme.surfaceSoft};
          --panel-bg: ${theme.shellBg};
          --text: ${theme.text};
          --text-sec: ${theme.muted};
          --divider: ${theme.divider};
          --glass: ${theme.glass};
          --glass-heavy: ${theme.glassHeavy};
          --outline: ${theme.outline};
          --shadow: ${theme.shadow};
          --control-shadow: ${theme.controlShadow};
          --subdued: ${theme.subdued};
          --scrubber: ${theme.scrubber};
          --focus-ring: 0 0 0 3px var(--primary-soft);
        }
        * { box-sizing: border-box; }
        button { font: inherit; }
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        .backdrop {
          position: absolute; inset: -20px; background-image: ${pic ? `url(${pic})` : 'none'}; background-size: cover; background-position: center; z-index: 0; transition: 0.8s;
          filter: blur(40px) saturate(1.4);
          opacity: 0.22;
        }
        
        ha-card { position: relative; overflow: hidden; border-radius: 28px; background: linear-gradient(180deg, var(--primary-soft), transparent 28%), var(--card-bg-strong); color: var(--text); max-width: 420px; width: 100%; margin: 0 auto; aspect-ratio: 0.72 / 1; min-height: 640px; display: flex; flex-direction: column; border: 1px solid var(--outline); box-shadow: var(--ha-card-box-shadow, var(--shadow)); transition: all 0.3s; }
        .surface { position: relative; z-index: 1; display: flex; flex-direction: column; height: 100%; background: linear-gradient(180deg, var(--glass) 0%, var(--card-bg-strong) 78%); }
        .card-header { padding: 16px 20px 0; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
        .header-picker-wrap { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; position: relative; }
        .header-rooms { font-size: 0.82rem; font-weight: 800; color: var(--text-sec); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
        .header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .section-body { flex: 1; padding: 12px 20px 20px; overflow-y: auto; scrollbar-width: none; position: relative; }
        .section-body::-webkit-scrollbar { display: none; }
        .list-card { background: var(--glass); backdrop-filter: blur(10px); border: 1px solid var(--outline); border-radius: 18px; transition: 0.2s; }
        .master-vol-card { padding: 18px; background: linear-gradient(145deg, var(--primary-strong), var(--card-bg-soft)); color: var(--text); box-shadow: var(--control-shadow); }
        .hero-strip { display: flex; justify-content: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
        .hero-pill { padding: 7px 12px; border-radius: 999px; font-size: 0.72rem; font-weight: 900; letter-spacing: 0.02em; background: var(--primary-soft); color: var(--text); border: 1px solid var(--primary-strong); }
        .hero-trigger { display: inline-flex; align-items: center; gap: 4px; }
        .hero-pill.clickable {
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .hero-pill.clickable:hover {
          background: var(--primary-strong);
          color: var(--text);
          transform: translateY(-1px);
        }
        .hero-pill.subtle { background: var(--glass); color: var(--text-sec); border-color: var(--outline); }
        .art-focal { display: flex; justify-content: center; margin-bottom: 16px; }
        .art-stack { position: relative; width: 188px; height: 188px; border-radius: 28px; overflow: hidden; box-shadow: var(--shadow); border: 1px solid var(--outline); background: linear-gradient(160deg, var(--primary-soft), var(--subdued)); }
        .art-aura { position: absolute; inset: auto -10% -30% -10%; height: 55%; background: radial-gradient(circle at center, var(--primary-halo), transparent 70%); pointer-events: none; z-index: 0; }
        .tv-gradient { background: linear-gradient(135deg, #1a237e, #4a148c); display: flex; align-items: center; justify-content: center; }
        .main-art { position: relative; z-index: 1; width: 100%; height: 100%; object-fit: cover; }
        .idle-art { position: relative; z-index: 1; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text); opacity: 0.42; }
        .idle-art ha-icon { --mdc-icon-size: 64px; }
        .track-info { text-align: center; margin-bottom: 14px; padding: 0 10px; }
        .track-title { font-size: 1.35rem; font-weight: 900; letter-spacing: -0.03em; margin-bottom: 4px; color: var(--text); }
        .track-subtitle { font-size: 0.9rem; color: var(--text-sec); font-weight: 700; }
        .playback-controls { padding: 16px; background: var(--glass); border-radius: 24px; border: 1px solid var(--outline); }
        .progress-bar { height: 6px; background: var(--scrubber); border-radius: 999px; overflow: hidden; }
        .progress-fill { height: 100%; background: var(--primary); transition: width 0.3s; }
        .time-meta { display: flex; justify-content: space-between; font-size: 0.65rem; margin-top: 4px; color: var(--text-sec); font-weight: 700; }
        .buttons-row { display: flex; justify-content: center; align-items: center; gap: 12px; margin: 14px 0 4px; }
        .play-btn { width: 64px; height: 64px; border-radius: 22px; background: var(--primary); color: var(--on-primary); border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: var(--control-shadow); }
        .play-btn ha-icon { --mdc-icon-size: 28px; }
        .transport-btn,
        .icon-btn,
        .slider-icon-btn,
        .footer-btn,
        .hero-trigger,
        .source-menu-item,
        .action-card {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid var(--outline);
          background: var(--glass-heavy);
          color: var(--text);
          cursor: pointer;
          transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease, color 0.2s ease;
        }
        .transport-btn:focus-visible,
        .icon-btn:focus-visible,
        .slider-icon-btn:focus-visible,
        .footer-btn:focus-visible,
        .play-btn:focus-visible,
        .power-toggle:focus-visible,
        .hero-trigger:focus-visible,
        .source-menu-item:focus-visible,
        .action-card:focus-visible,
        .volume-slider:focus-visible,
        ha-switch:focus-visible {
          outline: none;
          box-shadow: var(--control-shadow), var(--focus-ring);
        }
        .transport-btn:hover,
        .icon-btn:hover,
        .slider-icon-btn:hover,
        .footer-btn:hover,
        .play-btn:hover,
        .power-toggle:hover,
        .action-card:hover {
          transform: translateY(-1px);
        }
        .transport-btn {
          width: 52px;
          height: 52px;
          border-radius: 18px;
          box-shadow: var(--control-shadow);
        }
        .icon-btn { padding: 10px; border-radius: 14px; }
        .settings-btn { width: 44px; height: 44px; }
        .view-title { font-size: 1.1rem; font-weight: 900; margin-bottom: 12px; color: var(--primary); text-transform: uppercase; letter-spacing: 0.05em; }
        .vol-label-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-weight: 800; }
        .volume-inline { display: flex; align-items: center; gap: 8px; }
        .control-eyebrow { color: var(--text-sec); font-size: 0.74rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
        .volume-card-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 14px; }
        .volume-chip { padding: 7px 10px; border-radius: 999px; border: 1px solid var(--outline); background: var(--glass-heavy); color: var(--text-sec); font-size: 0.72rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; }
        .volume-figure { margin-top: 4px; font-size: 1.8rem; font-weight: 900; line-height: 1; color: var(--text); }
        .room-levels-stack { display: flex; flex-direction: column; gap: 10px; }
        .volume-room-card { margin-bottom: 0; padding: 14px 16px; }
        .room-volume-head { margin-bottom: 10px; font-size: 0.92rem; }
        .slider-shell { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; }
        .slider-shell-master { gap: 12px; }
        .slider-icon-btn { width: 40px; height: 40px; border-radius: 14px; box-shadow: var(--control-shadow); }
        .slider-icon-btn-master { background: var(--card-bg-soft); }
        .slider-icon-btn[disabled] { opacity: 0.45; cursor: not-allowed; transform: none; }
        input[type=range] { flex: 1; accent-color: var(--primary); height: 8px; cursor: pointer; background: transparent; }
        input[type=range]::-webkit-slider-runnable-track { height: 8px; border-radius: 999px; background: var(--scrubber); }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 20px; height: 20px; margin-top: -6px; border-radius: 50%; border: 3px solid var(--card-bg-strong); background: var(--primary); box-shadow: var(--control-shadow); }
        input[type=range]::-moz-range-track { height: 8px; border-radius: 999px; background: var(--scrubber); }
        input[type=range]::-moz-range-thumb { width: 20px; height: 20px; border-radius: 50%; border: 3px solid var(--card-bg-strong); background: var(--primary); box-shadow: var(--control-shadow); }
        .footer { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; padding: 12px 16px 24px; background: var(--glass); border-top: 1px solid var(--outline); }
        .footer-btn { border-radius: 16px; padding: 12px 0; color: var(--text-sec); min-height: 48px; }
        .footer-btn.active { background: var(--primary-soft); color: var(--text); border-color: var(--primary-strong); }
        .browse-grid, .fav-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; }
        .browse-item { display: flex; flex-direction: column; gap: 10px; padding: 12px; margin-bottom: 0; cursor: pointer; border-radius: 18px; }
        .browse-item:hover { background: var(--glass-heavy); }
        .action-card { width: 100%; text-align: left; }
        .browse-art, .fav-art-shell { position: relative; aspect-ratio: 1 / 1; border-radius: 18px; overflow: hidden; border: 1px solid var(--outline); background: linear-gradient(160deg, var(--primary-soft), var(--subdued)); display:flex; align-items:center; justify-content:center; }
        .browse-art img, .fav-art-shell img { width: 100%; height: 100%; object-fit: cover; }
        .browse-label { font-weight: 800; font-size: 0.92rem; line-height: 1.2; min-height: 2.2em; color: var(--text); }
        .browse-meta { font-size: 0.74rem; color: var(--text-sec); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
        .power-toggle {
          gap: 8px;
          padding: 10px 14px;
          border-radius: 999px;
          font-weight: 800;
          font-size: 0.82rem;
          box-shadow: var(--control-shadow);
        }
        .power-toggle.on {
          background: var(--primary);
          color: var(--on-primary);
          border-color: transparent;
        }
        .power-toggle.off {
          color: var(--text);
        }
        .loading-spin { text-align: center; padding: 40px; }
        .browse-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 40px 20px; color: var(--text-sec); font-size: 0.9rem; font-weight: 600; text-align: center; }
        .browse-empty ha-icon { --mdc-icon-size: 40px; opacity: 0.4; }
        .system-off-view { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; }
        .off-icon-wrap { width: 80px; height: 80px; border-radius: 50%; background: var(--glass-heavy); display: flex; align-items: center; justify-content: center; color: var(--text-sec); opacity: 0.5; }
        .off-text { font-size: 1.1rem; font-weight: 800; color: var(--text-sec); }
        .turn-on-btn { width: auto; height: auto; padding: 12px 24px; border-radius: 14px; display: flex; align-items: center; gap: 10px; font-weight: 800; background: var(--primary); color: var(--on-primary); }
        .source-menu { position: absolute; background: var(--glass-heavy); border: 1px solid var(--primary-strong); border-radius: 16px; z-index: 100; box-shadow: var(--shadow); padding: 8px; max-height: 250px; overflow-y: auto; width: min(100%, 280px); }
        .source-menu-item { width: 100%; text-align: left; padding: 12px 16px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 0.9rem; transition: 0.2s; border-bottom: 1px solid var(--divider); border-left: none; border-right: none; border-top: none; }
        .source-menu-item:hover { background: var(--primary-soft); color: var(--text); }
        .source-menu-item:last-child { border-bottom: none; }
        @media (max-width: 768px) {
          ha-card { max-width: 100%; min-height: 0; aspect-ratio: auto; }
          .card-header { padding: 14px 14px 0; }
          .section-body { padding: 10px 14px 16px; }
          .art-stack { width: 160px; height: 160px; border-radius: 24px; }
          .track-title { font-size: 1.15rem; }
          .buttons-row { gap: 8px; }
          .source-menu { left: 0 !important; right: 0; min-width: 0 !important; width: auto; }
          .footer { padding: 8px 10px 18px; }
          .volume-card-head { flex-direction: column; align-items: flex-start; }
        }
        @media (max-width: 420px) {
          .browse-grid, .fav-grid { grid-template-columns: 1fr; }
          ha-card { max-width: 100%; }
          .hero-strip { justify-content: stretch; }
          .hero-pill { width: 100%; text-align: center; }
          .play-btn { width: 58px; height: 58px; }
          .footer { grid-template-columns: repeat(5, minmax(48px, 1fr)); }
          .footer-btn { padding: 10px 0; }
          .header-actions { width: 100%; justify-content: space-between; }
          .power-toggle { flex: 1; justify-content: center; }
          .slider-shell,
          .slider-shell-master { grid-template-columns: 36px minmax(0, 1fr) 36px; gap: 8px; }
          .slider-icon-btn { width: 36px; height: 36px; }
          .section-body { padding-inline: 12px; }
        }
      </style>
      <ha-card>
        <div class="backdrop"></div>
        <div class="surface">
          <div class="card-header">
            <div class="header-picker-wrap">
              <div class="header-rooms">${this.escapeHtml(headerInfo)}</div>
            </div>
            <div class="header-actions">
              <button type="button" class="power-toggle ${isSystemOn ? 'on' : 'off'}" aria-pressed="${isSystemOn ? "true" : "false"}" onclick="this.getRootNode().host.callService('media_player', '${isSystemOn ? 'turn_off' : 'turn_on'}', {entity_id: '${ags.entity_id}'})">
                <ha-icon icon="mdi:power"></ha-icon>
                <span>${isSystemOn ? 'Turn Off' : 'Turn On'}</span>
              </button>
              <button type="button" class="icon-btn settings-btn" aria-label="Open AGS settings" onclick="this.getRootNode().host.openPortal()"><ha-icon icon="mdi:cog"></ha-icon></button>
            </div>
          </div>
          <div class="section-body">
            ${this._section === "favorites" ? this.renderFavorites(ags) :
              this._section === "rooms" ? this.renderRooms(ags) :
              this._section === "browse" ? this.renderBrowse() :
              this._section === "volumes" ? this.renderVolumesSection(ags) :
              this.renderPlayerSection(ags, control)}
          </div>
          <div class="footer">
            <button type="button" class="footer-btn ${this._section==='player'?'active':''}" aria-label="Player" onclick="this.getRootNode().host.setSection('player')"><ha-icon icon="mdi:play-circle"></ha-icon><span class="sr-only">Player</span></button>
            <button type="button" class="footer-btn ${this._section==='favorites'?'active':''}" aria-label="Favorites" onclick="this.getRootNode().host.setSection('favorites')"><ha-icon icon="mdi:star"></ha-icon><span class="sr-only">Favorites</span></button>
            <button type="button" class="footer-btn ${this._section==='browse'?'active':''}" aria-label="Browse" onclick="this.getRootNode().host.setSection('browse')"><ha-icon icon="mdi:folder-music"></ha-icon><span class="sr-only">Browse</span></button>
            <button type="button" class="footer-btn ${this._section==='rooms'?'active':''}" aria-label="Groups" onclick="this.getRootNode().host.setSection('rooms')"><ha-icon icon="mdi:speaker-multiple"></ha-icon><span class="sr-only">Groups</span></button>
            <button type="button" class="footer-btn ${this._section==='volumes'?'active':''}" aria-label="Volume" onclick="this.getRootNode().host.setSection('volumes')"><ha-icon icon="mdi:tune-vertical"></ha-icon><span class="sr-only">Volume</span></button>
          </div>
        </div>
      </ha-card>
    `;
  }

  renderFavorites(ags) {
    const s = this.toArray(ags.attributes.ags_sources);
    const activeSource = ags.attributes.selected_source_name || ags.attributes.source;
    const currentArt = this.getArtworkUrl(this.getControlPlayer(), ags);
    return `<div class="favorites-view"><div class="view-title">Favorites</div><div class="fav-grid">${s.map(f => `
      <button type="button" class="browse-item list-card action-card" aria-label="Play ${this.escapeHtml(f.name)}" onclick="this.getRootNode().host.callService('media_player', 'select_source', {entity_id: '${ags.entity_id}', source: '${f.name}'})">
        <div class="fav-art-shell">
          ${currentArt && f.name === activeSource ? `<img src="${currentArt}" />` : `<ha-icon icon="${f.default ? "mdi:star-four-points" : "mdi:music-circle"}" style="color:var(--primary); --mdc-icon-size: 44px;"></ha-icon>`}
        </div>
        <div class="browse-label">${this.escapeHtml(f.name)}</div>
        <div class="browse-meta">${f.default ? "Default source" : this.escapeHtml((f.media_content_type || "media").replace(/_/g, " "))}</div>
      </button>`).join("")}</div></div>`;
  }

  renderRooms(ags) {
    const r = this.toArray(ags.attributes.room_details);
    return `<div class="rooms-view"><div class="view-title">Groups</div>${r.map(room => `
      <div class="list-card browse-item" style="padding:12px 16px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; border-radius:12px;">
        <div style="overflow:hidden; flex:1;"><div style="font-weight:800; font-size:1rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(room.name)}</div><div style="font-size:0.7rem; color:var(--text-sec);">${room.active?'Active':'Idle'}</div></div>
        <ha-switch aria-label="Toggle ${this.escapeHtml(room.name)}" ${room.active?'checked':''} onclick="this.getRootNode().host.callService('switch', 'toggle', {entity_id: '${room.switch_entity_id}'})"></ha-switch>
      </div>`).join("")}</div>`;
  }

  renderBrowse() {
    let content;
    if (this._loadingBrowse) {
      content = '<div class="loading-spin"><ha-circular-progress active></ha-circular-progress></div>';
    } else if (this._browseError) {
      content = `<div class="browse-empty"><ha-icon icon="mdi:speaker-off"></ha-icon><div>${this.escapeHtml(this._browseError)}</div></div>`;
    } else if (!this._browseItems.length) {
      content = '<div class="browse-empty"><ha-icon icon="mdi:music-off"></ha-icon><div>No items found</div></div>';
    } else {
      content = `<div class="browse-grid">${this._browseItems.map((i, idx) => `
        <button type="button" class="list-card browse-item action-card" aria-label="${i.can_expand ? `Open ${this.escapeHtml(i.title)}` : `Play ${this.escapeHtml(i.title)}`}" onclick="this.getRootNode().host._handleBrowseClick(${idx})">
          <div class="browse-art">
            ${i.thumbnail ? `<img src="${this.resolveMediaUrl(i.thumbnail)}" />` : `<ha-icon icon="${i.can_expand ? 'mdi:folder' : 'mdi:music'}"></ha-icon>`}
          </div>
          <div class="browse-label">${this.escapeHtml(i.title)}</div>
          <div class="browse-meta">${this.escapeHtml(i.media_class)}</div>
        </button>`).join("")}</div>`;
    }
    return `
      <div class="browse-view">
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
          ${this._browseStack.length ? `<button class="icon-btn" onclick="this.getRootNode().host.browseBack()"><ha-icon icon="mdi:arrow-left"></ha-icon></button>` : ''}
          <div class="view-title" style="margin:0;">Library</div>
        </div>
        ${content}
      </div>`;
  }

  openPortal() {
    window.history.pushState(null, "", "/ags-service");
    window.dispatchEvent(new Event("location-changed", { bubbles: true, composed: true }));
  }
}
if (!customElements.get("ags-media-card")) {
  customElements.define("ags-media-card", AgsMediaCard);
}
window.customCards = window.customCards || [];
if (!window.customCards.find((card) => card.type === "ags-media-card")) {
  window.customCards.push({ type: "ags-media-card", name: "AGS Media Card", preview: true });
}
