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
    this._pendingRoomToggles = new Map();
    this._artPaletteCache = new Map();
    this._artPaletteKey = "";
    this._artPalette = null;
    this._artPalettePendingKey = "";
    this._transitionPreset = "";
    this._transitionTimer = null;
    this._pendingSeekPosition = null;
    this._seekResetTimer = null;
    this._lastSeekCommit = null;
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
    if (this._transitionTimer) {
      window.clearTimeout(this._transitionTimer);
      this._transitionTimer = null;
    }
    if (this._seekResetTimer) {
      window.clearTimeout(this._seekResetTimer);
      this._seekResetTimer = null;
    }
  }

  setConfig(config) {
    this._config = config;
    const configuredStart = typeof config?.start_section === "string" ? config.start_section : "player";
    this._section = this.getSavedSection(configuredStart);
    this.render(true);
  }

  getCardSize() { return 6; }

  getSectionStorageKey() {
    const entityId = this._config?.entity || "ags-media-card";
    return `ags-media-card:section:${entityId}`;
  }

  getSavedSection(fallback = "player") {
    const valid = new Set(["player", "browse", "rooms", "volumes"]);
    const preferred = valid.has(fallback) ? fallback : "player";
    try {
      const saved = window.localStorage?.getItem(this.getSectionStorageKey());
      return valid.has(saved) ? saved : preferred;
    } catch (error) {
      return preferred;
    }
  }

  saveSection(section) {
    try {
      window.localStorage?.setItem(this.getSectionStorageKey(), section);
    } catch (error) {
      // Ignore storage failures in restricted browser contexts.
    }
  }

  set hass(hass) {
    const hadBrowseItems = this._browseItems.length > 0;
    this._hass = hass;
    this._syncPendingVolumes();
    this._syncPendingRoomToggles();
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
  escapeAttribute(v) {
    return String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  escapeJsString(v) { return String(v ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
  toArray(v) { return Array.isArray(v) ? v : []; }
  clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

  getThemeSignature() {
    return JSON.stringify({
      darkMode: Boolean(this._hass?.themes?.darkMode),
      selectedTheme: this._hass?.selectedTheme?.theme || this._hass?.themes?.default_theme || "",
      artPaletteKey: this._artPaletteKey,
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

  getArtworkPalette(artworkUrl) {
    if (!artworkUrl) return null;
    if (this._artPaletteKey === artworkUrl && this._artPalette) {
      return this._artPalette;
    }
    return this._artPaletteCache.has(artworkUrl)
      ? this._artPaletteCache.get(artworkUrl)
      : null;
  }

  normalizeAccentColor(color, isDark) {
    const base = color || [37, 99, 235];
    const luminance = this.getLuminance(base);
    if (isDark) {
      if (luminance < 0.28) return this.mixColors(base, [255, 255, 255], 0.26);
      if (luminance > 0.8) return this.mixColors(base, [17, 24, 39], 0.18);
      return base;
    }
    if (luminance < 0.18) return this.mixColors(base, [255, 255, 255], 0.3);
    if (luminance > 0.72) return this.mixColors(base, [15, 23, 42], 0.22);
    return base;
  }

  async ensureArtworkPalette(artworkUrl) {
    const targetUrl = artworkUrl || "";
    if (!targetUrl) {
      if (this._artPaletteKey || this._artPalette) {
        this._artPaletteKey = "";
        this._artPalette = null;
        this._artPalettePendingKey = "";
        this.render(true);
      }
      return;
    }

    if (this._artPaletteKey === targetUrl && this._artPalette) return;

    if (this._artPaletteCache.has(targetUrl)) {
      const cached = this._artPaletteCache.get(targetUrl) || null;
      this._artPaletteKey = targetUrl;
      this._artPalette = cached;
      return;
    }

    if (this._artPalettePendingKey === targetUrl) return;
    this._artPalettePendingKey = targetUrl;

    try {
      const palette = await this.extractArtworkPalette(targetUrl);
      if (this._artPalettePendingKey !== targetUrl) return;
      this._artPalettePendingKey = "";
      this._artPaletteKey = targetUrl;
      this._artPalette = palette || null;
      this._artPaletteCache.set(targetUrl, this._artPalette);
      this.render(true);
    } catch (error) {
      this._artPalettePendingKey = "";
      this._artPaletteKey = targetUrl;
      this._artPalette = null;
      this._artPaletteCache.set(targetUrl, null);
    }
  }

  extractArtworkPalette(artworkUrl) {
    return new Promise((resolve) => {
      if (!artworkUrl) {
        resolve(null);
        return;
      }

      const image = new Image();
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 28;
          canvas.height = 28;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) {
            resolve(null);
            return;
          }
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          let totalWeight = 0;
          let accentWeight = 0;
          const average = [0, 0, 0];
          const accent = [0, 0, 0];

          for (let index = 0; index < data.length; index += 4) {
            const alpha = data[index + 3] / 255;
            if (alpha < 0.1) continue;
            const sample = [data[index], data[index + 1], data[index + 2]];
            const max = Math.max(...sample);
            const min = Math.min(...sample);
            const saturation = (max - min) / 255;
            const luminance = this.getLuminance(sample);
            const balance = this.clamp(1 - (Math.abs(luminance - 0.56) * 1.6), 0.18, 1);
            const avgWeight = alpha * (0.45 + saturation);
            const accentSampleWeight = alpha * (0.18 + (saturation * 1.9)) * balance;

            totalWeight += avgWeight;
            accentWeight += accentSampleWeight;
            for (let channel = 0; channel < 3; channel += 1) {
              average[channel] += sample[channel] * avgWeight;
              accent[channel] += sample[channel] * accentSampleWeight;
            }
          }

          if (!totalWeight) {
            resolve(null);
            return;
          }

          const averageColor = average.map((channel) => Math.round(channel / totalWeight));
          const accentColor = (accentWeight > 0
            ? accent.map((channel) => Math.round(channel / accentWeight))
            : averageColor);

          resolve({
            average: averageColor,
            accent: accentColor,
          });
        } catch (error) {
          resolve(null);
        }
      };
      image.onerror = () => resolve(null);
      image.src = artworkUrl;
    });
  }

  getThemePalette(artworkUrl = "") {
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
    const artPalette = this.getArtworkPalette(artworkUrl);
    const artAccent = artPalette ? this.normalizeAccentColor(artPalette.accent, isDark) : null;
    const artAverage = artPalette?.average || artAccent || primary;
    const tunedPrimary = artAccent ? this.mixColors(primary, artAccent, 0.72) : primary;
    const shellBase = artAccent ? this.mixColors(background, artAccent, isDark ? 0.18 : 0.08) : this.mixColors(background, primary, isDark ? 0.08 : 0.03);
    const surfaceStrong = artAccent
      ? this.mixColors(surface, artAverage, isDark ? 0.16 : 0.1)
      : this.mixColors(surface, background, isDark ? 0.08 : 0.28);
    const surfaceSoft = artAccent
      ? this.mixColors(surface, artAverage, isDark ? 0.24 : 0.16)
      : this.mixColors(surface, background, isDark ? 0.16 : 0.42);
    const glassSurface = artAccent
      ? this.mixColors(surface, artAverage, isDark ? 0.18 : 0.12)
      : surface;
    const glassHeavySurface = artAccent
      ? this.mixColors(surfaceStrong, artAccent, isDark ? 0.24 : 0.14)
      : surfaceStrong;
    const artGlow = artAccent ? this.mixColors(artAccent, [255, 255, 255], isDark ? 0.08 : 0.22) : tunedPrimary;
    const onPrimary = this.getReadableTextColor(primary, text);

    return {
      colorScheme: isDark ? "dark" : "light",
      shellBg: this.rgb(shellBase),
      surface: this.rgb(surface),
      surfaceStrong: this.rgb(surfaceStrong),
      surfaceSoft: this.rgb(surfaceSoft),
      glass: this.rgba(glassSurface, isDark ? 0.78 : 0.88),
      glassHeavy: this.rgba(glassHeavySurface, isDark ? 0.9 : 0.95),
      text: this.rgb(text),
      muted: this.rgb(muted),
      primary: this.rgb(tunedPrimary),
      primarySoft: this.rgba(tunedPrimary, isDark ? 0.22 : 0.14),
      primaryStrong: this.rgba(tunedPrimary, isDark ? 0.34 : 0.22),
      primaryHalo: this.rgba(artGlow, isDark ? 0.38 : 0.24),
      artTint: this.rgba(artAverage, isDark ? 0.2 : 0.1),
      artGlow: this.rgba(artGlow, isDark ? 0.28 : 0.18),
      backdropOverlay: this.rgba(this.mixColors(background, artAverage, isDark ? 0.14 : 0.08), isDark ? 0.58 : 0.42),
      onPrimary: this.rgb(this.getReadableTextColor(tunedPrimary, onPrimary)),
      outline: this.rgba(text, isDark ? 0.18 : 0.12),
      divider: this.rgba(text, isDark ? 0.12 : 0.1),
      subdued: this.rgba(text, isDark ? 0.08 : 0.05),
      scrubber: this.rgba(text, isDark ? 0.16 : 0.12),
      shadow: isDark ? "0 24px 48px rgba(2, 6, 23, 0.42)" : "0 24px 48px rgba(15, 23, 42, 0.12)",
      controlShadow: isDark ? "0 10px 20px rgba(2, 6, 23, 0.3)" : "0 10px 18px rgba(15, 23, 42, 0.14)",
    };
  }

  getEntityPicture(entity) {
    if (!entity?.attributes) return "";
    return entity.attributes.entity_picture
      || entity.attributes.entity_picture_local
      || entity.attributes.media_image_url
      || "";
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
    const url = this.getEntityPicture(ctrl) || this.getEntityPicture(ags);
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

  getSelectedSourceName(ags) {
    const isTvMode = ags?.attributes?.ags_status === "ON TV";
    if (isTvMode) {
      return ags?.attributes?.source || "TV";
    }
    return ags?.attributes?.selected_source_name || ags?.attributes?.source || "Idle";
  }

  getSourceOptions(ags) {
    const isTvMode = ags?.attributes?.ags_status === "ON TV";
    const currentSource = this.getSelectedSourceName(ags);
    const agsSources = this.toArray(ags?.attributes?.ags_sources)
      .map((source) => source?.name)
      .filter(Boolean);
    const nativeSources = this.toArray(ags?.attributes?.source_list)
      .map((source) => String(source || "").trim())
      .filter(Boolean);
    const options = isTvMode
      ? nativeSources.filter((source) => !agsSources.includes(source) || source === currentSource)
      : agsSources.filter((source) => source !== "TV" && source !== "Unknown");
    const seen = new Set();
    const deduped = options.filter((source) => {
      const key = source.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (currentSource && !deduped.some((source) => source.toLowerCase() === currentSource.toLowerCase())) {
      deduped.unshift(currentSource);
    }
    return deduped;
  }

  getDisplayedPosition(snapshot) {
    if (this._pendingSeekPosition == null || !snapshot?.duration) return snapshot?.pos || 0;
    return this.clamp(this._pendingSeekPosition, 0, snapshot.duration);
  }

  getDisplayedProgress(snapshot) {
    const duration = Number(snapshot?.duration || 0);
    if (duration <= 0) return 0;
    return (this.getDisplayedPosition(snapshot) / duration) * 100;
  }

  previewSeek(position, duration) {
    const max = Number(duration || 0);
    if (max <= 0) return;
    this._pendingSeekPosition = this.clamp(Number(position || 0), 0, max);
    this.updateSeekPreviewUi(max);
  }

  commitSeek(entityId, position, duration) {
    const max = Number(duration || 0);
    if (!entityId || max <= 0) return;
    const target = this.clamp(Number(position || 0), 0, max);
    const commitSignature = `${entityId}:${Math.round(target)}`;
    if (this._lastSeekCommit?.signature === commitSignature && (Date.now() - this._lastSeekCommit.at) < 300) {
      return;
    }
    this._lastSeekCommit = { signature: commitSignature, at: Date.now() };
    this._pendingSeekPosition = target;
    if (this._seekResetTimer) {
      window.clearTimeout(this._seekResetTimer);
    }
    this._hass.callService("media_player", "media_seek", {
      entity_id: entityId,
      seek_position: target,
    });
    this.updateSeekPreviewUi(max);
    this._seekResetTimer = window.setTimeout(() => {
      this._pendingSeekPosition = null;
      this._seekResetTimer = null;
      this.render(true);
    }, 1500);
  }

  releaseSeek(event, entityId, duration) {
    const value = event?.target?.value;
    if (value == null) return;
    this.commitSeek(entityId, value, duration);
  }

  updateSeekPreviewUi(duration) {
    if (!this.shadowRoot || !duration || this._pendingSeekPosition == null) return;
    const progress = `${(this._pendingSeekPosition / duration) * 100}%`;
    this.shadowRoot.querySelectorAll(".progress-fill").forEach((node) => {
      node.style.width = progress;
    });
    this.shadowRoot.querySelectorAll(".progress-glow").forEach((node) => {
      node.style.width = progress;
    });
    this.shadowRoot.querySelectorAll(".seek-slider").forEach((node) => {
      node.value = String(this._pendingSeekPosition);
    });
    this.shadowRoot.querySelectorAll(".time-current").forEach((node) => {
      node.textContent = this.formatTime(this._pendingSeekPosition);
    });
  }

  renderSourceMenu(ags, currentSrc, sourceMenuId, variant = "full") {
    if (!this._showSourceMenu) return "";
    const sourceOptions = this.getSourceOptions(ags);
    return `
      <div id="${sourceMenuId}" class="source-menu source-menu-${variant}" role="menu" aria-label="Select Source">
        <div class="source-menu-header">
          <span>Select Source</span>
          <span class="source-menu-current">${this.escapeHtml(currentSrc)}</span>
        </div>
        ${sourceOptions.length
          ? sourceOptions.map((source) => {
            const selected = source === currentSrc;
            return `
              <button
                type="button"
                role="menuitemradio"
                aria-checked="${selected ? "true" : "false"}"
                class="source-menu-item ${selected ? "selected" : ""}"
                onclick="this.getRootNode().host.callService('media_player', 'select_source', {entity_id: '${ags.entity_id}', source: '${this.escapeJsString(source)}'})"
              >
                <span class="source-menu-item-label">${this.escapeHtml(source)}</span>
                ${selected ? '<ha-icon class="source-menu-check" icon="mdi:check"></ha-icon>' : ""}
              </button>
            `;
          }).join("")
          : '<div class="source-menu-empty">No sources available</div>'}
      </div>
    `;
  }

  setSection(s) {
    if (this._section === s) return;
    const previous = this._section;
    const sectionOrder = ["player", "browse", "rooms", "volumes"];
    if (previous === "player" || s === "player") {
      this._transitionPreset = s === "player" ? "expand-player" : "collapse-player";
    } else {
      this._transitionPreset = sectionOrder.indexOf(s) > sectionOrder.indexOf(previous)
        ? "slide-forward"
        : "slide-back";
    }
    this._section = s;
    this.saveSection(s);
    this._showSourceMenu = false;
    if (s === "browse" && !this._browseItems.length) this.browseMedia();
    this.render(true);
    if (this._transitionTimer) {
      window.clearTimeout(this._transitionTimer);
    }
    this._transitionTimer = window.setTimeout(() => {
      if (!this._transitionPreset) return;
      this._transitionPreset = "";
      this.render(true);
    }, 420);
    requestAnimationFrame(() => {
      const body = this.shadowRoot?.querySelector(".section-body");
      if (body) body.scrollTop = 0;
    });
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
      pendingSeekPosition: this._pendingSeekPosition,
      loadingBrowse: this._loadingBrowse,
      browseError: this._browseError,
      pendingRoomToggles: Array.from(this._pendingRoomToggles.entries()),
      transitionPreset: this._transitionPreset,
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
            source_list: agsAttrs.source_list || [],
            browse_entity_id: agsAttrs.browse_entity_id,
            control_device_id: agsAttrs.control_device_id,
            entity_picture: agsAttrs.entity_picture,
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

  _syncPendingRoomToggles() {
    if (!this._hass || !this._pendingRoomToggles.size) return;
    for (const [entityId, desiredState] of this._pendingRoomToggles.entries()) {
      const actualState = this._hass.states?.[entityId]?.state === "on";
      if (actualState === desiredState) {
        this._pendingRoomToggles.delete(entityId);
      }
    }
  }

  getRoomDesiredState(entityId, active) {
    if (entityId && this._pendingRoomToggles.has(entityId)) {
      return this._pendingRoomToggles.get(entityId);
    }
    return Boolean(active);
  }

  isRoomTogglePending(entityId) {
    return entityId ? this._pendingRoomToggles.has(entityId) : false;
  }

  async toggleRoom(entityId, active) {
    if (!this._hass || !entityId || this.isRoomTogglePending(entityId)) return;
    const nextState = !Boolean(active);
    this._pendingRoomToggles.set(entityId, nextState);
    this.render(true);
    try {
      await this._hass.callService("switch", nextState ? "turn_on" : "turn_off", {
        entity_id: entityId,
      });
    } finally {
      window.setTimeout(() => {
        if (this._pendingRoomToggles.get(entityId) === nextState) {
          const actualState = this._hass?.states?.[entityId]?.state === "on";
          if (actualState === nextState) {
            this._pendingRoomToggles.delete(entityId);
          }
          this.render(true);
        }
      }, 3200);
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

  isMuted(entityOrState) {
    const state = typeof entityOrState === "string" ? this._hass?.states?.[entityOrState] : entityOrState;
    return Boolean(state?.attributes?.is_volume_muted);
  }

  isGroupMuted(ags) {
    const activeSpeakers = this.toArray(ags?.attributes?.active_speakers);
    if (!activeSpeakers.length) return false;
    const resolvedStates = activeSpeakers
      .map((entityId) => this._hass?.states?.[entityId])
      .filter(Boolean);
    if (!resolvedStates.length) return false;
    return resolvedStates.every((state) => this.isMuted(state));
  }

  toggleMuteTargets(targets, muted) {
    const entityIds = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
    if (!entityIds.length) return;
    this._hass.callService("media_player", "volume_mute", {
      entity_id: entityIds.length === 1 ? entityIds[0] : entityIds,
      is_volume_muted: !muted,
    });
    window.setTimeout(() => this.render(true), 180);
    window.setTimeout(() => this.render(true), 900);
  }

  getSourceIcon(source, isTv = false) {
    const normalized = String(source || "").toLowerCase();
    if (normalized.includes("youtube")) return "mdi:youtube";
    if (normalized.includes("spotify")) return "mdi:spotify";
    if (normalized.includes("pandora")) return "mdi:music-circle";
    if (normalized.includes("netflix")) return "mdi:netflix";
    if (normalized.includes("plex")) return "mdi:plex";
    if (normalized.includes("prime")) return "mdi:amazon";
    if (normalized.includes("hulu")) return "mdi:hulu";
    if (normalized.includes("music")) return "mdi:music";
    if (normalized.includes("podcast")) return "mdi:podcast";
    if (normalized.includes("tv")) return "mdi:television-play";
    return isTv ? "mdi:television-classic" : "mdi:music-note";
  }

  getSourceAccentColor(source, isTv = false) {
    const normalized = String(source || "").toLowerCase();
    if (normalized.includes("youtube tv")) return "#ff0000";
    if (normalized.includes("youtube")) return "#ff0000";
    if (normalized.includes("spotify")) return "#1db954";
    if (normalized.includes("netflix")) return "#e50914";
    if (normalized.includes("plex")) return "#f9be03";
    if (normalized.includes("prime")) return "#00a8e1";
    if (normalized.includes("hulu")) return "#1ce783";
    if (normalized.includes("disney")) return "#113ccf";
    if (normalized.includes("podcast")) return "#8f5cff";
    if (normalized.includes("music")) return "#ff6b81";
    if (normalized.includes("photos")) return "#f59e0b";
    if (normalized.includes("twitch")) return "#9146ff";
    if (normalized.includes("settings")) return "#94a3b8";
    if (normalized.includes("app store")) return "#3b82f6";
    if (normalized.includes("search")) return "#38bdf8";
    if (normalized.includes("face")) return "#22c55e";
    if (normalized.includes("fitness")) return "#84cc16";
    if (normalized.includes("tv")) return isTv ? "#38bdf8" : "#94a3b8";
    return isTv ? "var(--primary)" : "var(--text)";
  }

  getSubtitleText(mediaArtist, currentSource, roomSummary) {
    const primary = String(mediaArtist || "").trim();
    const secondary = String(currentSource || "").trim();
    if (primary && secondary && primary.toLowerCase() !== secondary.toLowerCase()) {
      return `${primary} • ${secondary}`;
    }
    return primary || secondary || roomSummary;
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

  getPlayerSnapshot(ags, control) {
    const status = ags.attributes.ags_status || (ags.state === "off" ? "OFF" : "ON");
    const isTv = status === "ON TV";
    const isPlaying = ["playing", "buffering"].includes(control?.state || ags.state);
    const pic = this.getArtworkUrl(control, ags);
    const currentSource = this.getSelectedSourceName(ags);
    const mediaTitle = control?.attributes?.media_title || "";
    const mediaArtist = control?.attributes?.media_artist || "";
    const hasMedia = Boolean(mediaTitle || mediaArtist || pic);
    const title = mediaTitle || (currentSource && currentSource !== "Idle" ? currentSource : (isTv ? "Television Audio" : "Nothing Playing"));
    const activeRooms = this.toArray(ags.attributes.active_rooms);
    const mainRoom = ags.attributes.primary_speaker_room || (activeRooms.length > 0 ? activeRooms[0] : "");
    const roomSummary = activeRooms.length > 0
      ? `${mainRoom}${activeRooms.length > 1 ? ` + ${activeRooms.length - 1}` : ""}`
      : "System Idle";
    const subtitle = hasMedia
      ? this.getSubtitleText(mediaArtist, currentSource, roomSummary)
      : `${isTv ? "Open app" : "Select source"}${currentSource && currentSource !== "Idle" ? ` • ${currentSource}` : ""}`;
    const duration = Number(control?.attributes?.media_duration || 0);
    const pos = this.getLiveMediaPosition(control || ags);
    const prog = duration > 0 ? (pos / duration) * 100 : 0;
    return {
      status,
      isTv,
      isPlaying,
      pic,
      title,
      subtitle,
      currentSource,
      hasMedia,
      sourceIcon: this.getSourceIcon(currentSource, isTv),
      sourceColor: this.getSourceAccentColor(currentSource, isTv),
      duration,
      pos,
      prog,
    };
  }

  renderMiniPlayer(ags, snapshot, currentSrc, sourceMenuId) {
    const isSystemOn = ags.state !== "off";
    const displayPos = this.getDisplayedPosition(snapshot);
    const displayProg = this.getDisplayedProgress(snapshot);
    const canSeek = snapshot.duration > 0;
    return `
      <div class="mini-player ${this._transitionPreset === "collapse-player" ? "animate-up" : this._transitionPreset === "expand-player" ? "animate-down" : ""}">
        <div class="mini-player-main">
          <button
            type="button"
            class="mini-art-button"
            aria-label="Open full player"
            onclick="this.getRootNode().host.setSection('player')"
          >
            <div class="mini-art ${snapshot.isTv && !snapshot.pic ? "tv-gradient" : ""} ${!snapshot.pic ? "mini-art-empty" : ""}" style="--fallback-accent:${snapshot.sourceColor};">
              ${snapshot.pic
                ? `<img class="mini-art-image" src="${snapshot.pic}" />`
                : `<div class="mini-art-fallback ${!snapshot.hasMedia ? "missing-media-fallback" : ""}">
                    <ha-icon icon="${snapshot.sourceIcon}"></ha-icon>
                    ${!snapshot.hasMedia ? `<span class="mini-art-label">${this.escapeHtml(snapshot.currentSource || (snapshot.isTv ? "TV" : "Music"))}</span>` : ""}
                  </div>`}
            </div>
          </button>
          <button
            type="button"
            class="mini-meta"
            aria-label="Open full player"
            onclick="this.getRootNode().host.setSection('player')"
          >
            <span class="mini-title">${this.escapeHtml(snapshot.title)}</span>
            <span class="mini-subtitle">${this.escapeHtml(snapshot.subtitle)}</span>
          </button>
          <div class="mini-actions">
            <button
              type="button"
              class="icon-btn mini-action-btn"
              aria-label="${snapshot.isPlaying ? "Pause" : "Play"}"
              onclick="this.getRootNode().host.callService('media_player', 'media_play_pause', {entity_id: '${ags.entity_id}'})"
            >
              <ha-icon icon="${snapshot.isPlaying ? "mdi:pause" : "mdi:play"}"></ha-icon>
            </button>
            <button
              type="button"
              class="power-toggle icon-btn power-icon-btn mini-power ${isSystemOn ? "on" : "off"}"
              aria-pressed="${isSystemOn ? "true" : "false"}"
              aria-label="${isSystemOn ? "Turn system off" : "Turn system on"}"
              title="${isSystemOn ? "Turn system off" : "Turn system on"}"
              onclick="this.getRootNode().host.callService('media_player', '${isSystemOn ? "turn_off" : "turn_on"}', {entity_id: '${ags.entity_id}'})"
            >
              <ha-icon icon="mdi:power"></ha-icon>
            </button>
            <div class="source-anchor source-anchor-mini">
              <button
                type="button"
                class="icon-btn source-toggle mini-source-btn ${this._showSourceMenu ? "active" : ""}"
                aria-haspopup="menu"
                aria-expanded="${this._showSourceMenu ? "true" : "false"}"
                aria-controls="${sourceMenuId}"
                aria-label="Select source. Current source: ${this.escapeAttribute(currentSrc)}"
                title="${this.escapeAttribute(currentSrc)}"
                onclick="this.getRootNode().host.toggleSourceMenu()"
              >
                <ha-icon icon="mdi:audio-input-stereo-minijack"></ha-icon>
              </button>
              ${this.renderSourceMenu(ags, currentSrc, sourceMenuId, "mini")}
            </div>
          </div>
        </div>
        <div class="seek-shell mini-progress ${canSeek ? "is-seekable" : "is-static"}">
          <div class="progress-bar progress-bar-mini">
            <div class="progress-fill" style="width:${displayProg}%;"></div>
          </div>
          <div class="time-meta mini-time-meta">
            <span class="time-current">${this.formatTime(displayPos)}</span>
            <span>${snapshot.duration > 0 ? this.formatTime(snapshot.duration) : ""}</span>
          </div>
          ${canSeek ? `
            <input
              class="seek-slider seek-slider-mini"
              type="range"
              min="0"
              max="${snapshot.duration}"
              step="1"
              value="${displayPos}"
              aria-label="Seek playback position"
              oninput="this.getRootNode().host.previewSeek(this.value, ${snapshot.duration})"
              onpointerup="this.getRootNode().host.releaseSeek(event, '${ags.entity_id}', ${snapshot.duration})"
              onmouseup="this.getRootNode().host.releaseSeek(event, '${ags.entity_id}', ${snapshot.duration})"
              ontouchend="this.getRootNode().host.releaseSeek(event, '${ags.entity_id}', ${snapshot.duration})"
              onchange="this.getRootNode().host.commitSeek('${ags.entity_id}', this.value, ${snapshot.duration})"
            />
          ` : ""}
        </div>
      </div>
    `;
  }

  renderPlayerSection(ags, control, sourceMenuId) {
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

    const snapshot = this.getPlayerSnapshot(ags, control);
    const currentSrc = this.getSelectedSourceName(ags);
    const isSystemOn = ags.state !== "off";
    const displayPos = this.getDisplayedPosition(snapshot);
    const displayProg = this.getDisplayedProgress(snapshot);
    const canSeek = snapshot.duration > 0;
    return `
      <div class="player-view ${this._transitionPreset === "expand-player" ? "animate-player-open" : this._transitionPreset === "collapse-player" ? "animate-player-close" : ""}">
        <div class="player-main">
          <div class="art-focal">
            <div class="art-stack ${snapshot.isTv && !snapshot.pic ? 'tv-gradient' : ''} ${!snapshot.pic ? 'art-stack-empty' : ''}" style="--fallback-accent:${snapshot.sourceColor};">
              <div class="art-aura"></div>
              ${snapshot.pic ? `<img class="main-art" src="${snapshot.pic}" />` : `
                <div class="idle-art ${!snapshot.hasMedia ? 'idle-art-missing' : ''}">
                  <ha-icon icon="${snapshot.sourceIcon}"></ha-icon>
                  ${!snapshot.hasMedia ? `
                    <div class="idle-art-copy">
                      <div class="idle-art-eyebrow">${snapshot.isTv ? 'Active App' : 'Current Source'}</div>
                      <div class="idle-art-source">${this.escapeHtml(snapshot.currentSource || (snapshot.isTv ? "TV" : "Music"))}</div>
                      <div class="idle-art-detail">${this.escapeHtml(snapshot.subtitle)}</div>
                    </div>
                  ` : ""}
                </div>
              `}
            </div>
          </div>
          <div class="track-info">
            <div class="track-flags">
              <span class="hero-pill subtle status-display">${this.escapeHtml(snapshot.status)}</span>
            </div>
            <div class="track-title">${this.escapeHtml(snapshot.title)}</div>
            <div class="track-subtitle">${this.escapeHtml(snapshot.subtitle)}</div>
          </div>
        </div>
        <div class="playback-controls">
          <div class="progress-shell seek-shell ${canSeek ? "is-seekable" : "is-static"}">
            <div class="progress-bar progress-bar-hero">
              <div class="progress-fill" style="width:${displayProg}%;"></div>
            </div>
            <div class="progress-glow" style="width:${displayProg}%;"></div>
            ${canSeek ? `
              <input
                class="seek-slider seek-slider-full"
                type="range"
                min="0"
                max="${snapshot.duration}"
                step="1"
                value="${displayPos}"
                aria-label="Seek playback position"
                oninput="this.getRootNode().host.previewSeek(this.value, ${snapshot.duration})"
                onpointerup="this.getRootNode().host.releaseSeek(event, '${ags.entity_id}', ${snapshot.duration})"
                onmouseup="this.getRootNode().host.releaseSeek(event, '${ags.entity_id}', ${snapshot.duration})"
                ontouchend="this.getRootNode().host.releaseSeek(event, '${ags.entity_id}', ${snapshot.duration})"
                onchange="this.getRootNode().host.commitSeek('${ags.entity_id}', this.value, ${snapshot.duration})"
              />
            ` : ""}
          </div>
          <div class="time-meta"><span class="time-current">${this.formatTime(displayPos)}</span><span>${snapshot.duration > 0 ? this.formatTime(snapshot.duration) : ""}</span></div>
          <div class="buttons-row buttons-row-full">
            <button
              type="button"
              class="power-toggle icon-btn power-icon-btn ${isSystemOn ? 'on' : 'off'}"
              aria-pressed="${isSystemOn ? "true" : "false"}"
              aria-label="${isSystemOn ? "Turn system off" : "Turn system on"}"
              title="${isSystemOn ? "Turn system off" : "Turn system on"}"
              onclick="this.getRootNode().host.callService('media_player', '${isSystemOn ? 'turn_off' : 'turn_on'}', {entity_id: '${ags.entity_id}'})"
            >
              <ha-icon icon="mdi:power"></ha-icon>
            </button>
            <div class="transport-cluster">
              <button class="transport-btn" aria-label="Previous track" onclick="this.getRootNode().host.callService('media_player', 'media_previous_track', {entity_id: '${ags.entity_id}'})"><ha-icon icon="mdi:skip-previous"></ha-icon></button>
              <button class="play-btn" aria-label="${snapshot.isPlaying ? "Pause" : "Play"}" onclick="this.getRootNode().host.callService('media_player', 'media_play_pause', {entity_id: '${ags.entity_id}'})"><ha-icon icon="${snapshot.isPlaying ? 'mdi:pause' : 'mdi:play'}"></ha-icon></button>
              <button class="transport-btn" aria-label="Next track" onclick="this.getRootNode().host.callService('media_player', 'media_next_track', {entity_id: '${ags.entity_id}'})"><ha-icon icon="mdi:skip-next"></ha-icon></button>
            </div>
            <div class="source-anchor source-anchor-full">
              <button
                type="button"
                class="icon-btn source-toggle player-source-btn ${this._showSourceMenu ? "active" : ""}"
                aria-haspopup="menu"
                aria-expanded="${this._showSourceMenu ? "true" : "false"}"
                aria-controls="${sourceMenuId}"
                aria-label="Select source. Current source: ${this.escapeAttribute(currentSrc)}"
                title="${this.escapeAttribute(currentSrc)}"
                onclick="this.getRootNode().host.toggleSourceMenu()"
              >
                <ha-icon icon="mdi:audio-input-stereo-minijack"></ha-icon>
              </button>
              ${this.renderSourceMenu(ags, currentSrc, sourceMenuId, "full")}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderVolumesSection(ags) {
    const groupVol = this.getDisplayedVolume(ags);
    const groupMuted = this.isGroupMuted(ags);
    const activeSpeakers = this.toArray(ags.attributes.active_speakers);
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
            <div class="volume-head-actions">
              <div class="volume-chip">All Active Rooms</div>
              <button
                type="button"
                class="slider-icon-btn slider-icon-btn-master mute-btn ${groupMuted ? "active" : ""}"
                aria-label="${groupMuted ? "Unmute group" : "Mute group"}"
                onclick="this.getRootNode().host.toggleMuteTargets([${activeSpeakers.map((entityId) => `'${entityId}'`).join(", ")}], ${groupMuted ? "true" : "false"})"
              >
                <ha-icon icon="${groupMuted ? "mdi:volume-off" : "mdi:volume-high"}"></ha-icon>
              </button>
            </div>
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
            const muted = this.isMuted(spkState);
            return `
              <div class="list-card volume-room-card">
                <div class="vol-label-row room-volume-head">
                  <span>${this.escapeHtml(r.name)}</span>
                  <div class="volume-head-actions">
                    <span data-volume-id="${spkId || `room-${this.escapeHtml(r.name)}`}">${v}%</span>
                    <button
                      type="button"
                      class="slider-icon-btn mute-btn ${muted ? "active" : ""}"
                      aria-label="${muted ? `Unmute ${this.escapeAttribute(r.name)}` : `Mute ${this.escapeAttribute(r.name)}`}"
                      ${!spkId ? 'disabled' : ''}
                      onclick="this.getRootNode().host.toggleMuteTargets('${spkId}', ${muted ? "true" : "false"})"
                    >
                      <ha-icon icon="${muted ? "mdi:volume-off" : "mdi:volume-high"}"></ha-icon>
                    </button>
                  </div>
                </div>
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
    this.ensureArtworkPalette(pic);
    const currentSrc = this.getSelectedSourceName(ags);
    const theme = this.getThemePalette(pic);
    const sourceMenuId = "ags-source-menu";
    const snapshot = this.getPlayerSnapshot(ags, control);
    const isPlayerSection = this._section === "player";
    const isSystemOff = ags.state === "off";
    const sectionBodyClass = isSystemOff
      ? "section-body section-player system-off-shell"
      : this._section === "player"
        ? "section-body section-player"
        : "section-body";
    const surfaceClass = isSystemOff ? "surface system-off-surface" : "surface";

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
          --art-tint: ${theme.artTint};
          --art-glow: ${theme.artGlow};
          --backdrop-overlay: ${theme.backdropOverlay};
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
          filter: blur(48px) saturate(1.15);
          opacity: 0.32;
          transform: scale(1.06);
        }
        
        ha-card { position: relative; overflow: hidden; border-radius: 28px; background: linear-gradient(180deg, var(--art-tint), transparent 24%), linear-gradient(180deg, var(--primary-soft), transparent 38%), var(--card-bg-strong); color: var(--text); max-width: var(--ags-card-max-width, 420px); width: 100%; margin: 0 auto; height: min(468px, max(296px, calc(100dvh - var(--ags-card-viewport-offset, 252px)))); min-height: min(296px, calc(100dvh - 112px)); max-height: calc(100dvh - 64px); display: flex; flex-direction: column; border: 1px solid var(--outline); box-shadow: var(--ha-card-box-shadow, var(--shadow)); transition: background 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease; }
        .surface { position: relative; z-index: 1; display: flex; flex-direction: column; height: 100%; overflow: visible; background: linear-gradient(180deg, var(--glass) 0%, var(--backdrop-overlay) 34%, var(--card-bg-strong) 82%); backdrop-filter: blur(24px) saturate(1.08); }
        .card-header { position: relative; z-index: 6; overflow: visible; padding: 16px 20px 14px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; border-bottom: 1px solid var(--divider); background: linear-gradient(180deg, var(--glass-heavy), rgba(0, 0, 0, 0)); backdrop-filter: blur(22px) saturate(1.1); }
        .header-picker-wrap { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; position: relative; overflow: visible; z-index: 7; }
        .header-meta-row { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; width: 100%; min-width: 0; position: relative; z-index: 8; }
        .header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .section-body { flex: 1; min-height: 0; padding: 14px 18px calc(92px + env(safe-area-inset-bottom, 0px)); overflow-y: auto; scrollbar-width: none; position: relative; z-index: 1; }
        .section-body::-webkit-scrollbar { display: none; }
        .section-player { overflow: hidden; padding-bottom: 14px; display: flex; }
        .list-card { background: var(--glass); backdrop-filter: blur(10px); border: 1px solid var(--outline); border-radius: 18px; transition: 0.2s; }
        .master-vol-card { padding: 18px; background: linear-gradient(145deg, var(--primary-strong), var(--card-bg-soft)); color: var(--text); box-shadow: var(--control-shadow); }
        .hero-pill { min-height: 44px; padding: 0 14px; border-radius: 999px; font-size: 0.72rem; font-weight: 900; letter-spacing: 0.02em; background: var(--primary-soft); color: var(--text); border: 1px solid var(--primary-strong); display: inline-flex; align-items: center; justify-content: center; }
        .hero-trigger { display: inline-flex; align-items: center; gap: 4px; }
        .status-chip { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; }
        .status-chip::before { content: ""; width: 8px; height: 8px; border-radius: 999px; background: currentColor; opacity: 0.9; flex-shrink: 0; }
        .status-live { background: var(--primary-soft); color: var(--text); border-color: var(--primary-strong); }
        .status-ready { background: var(--subdued); color: var(--text); border-color: var(--outline); }
        .status-offline { background: var(--glass); color: var(--text-sec); border-color: var(--outline); }
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
        .transition-shell { position: relative; overflow: hidden; min-height: 0; will-change: transform, opacity; }
        .transition-shell.slide-forward { animation: page-slide-in-left 0.24s ease-out; }
        .transition-shell.slide-back { animation: page-slide-in-right 0.24s ease-out; }
        .player-view { width: 100%; height: 100%; display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 10px; will-change: transform, opacity; transform-origin: center top; }
        .player-view.animate-player-open { animation: player-drop-open 0.38s ease-out; }
        .player-view.animate-player-close { animation: player-lift-close 0.28s ease-out; }
        .player-main { min-height: 0; display: grid; grid-template-columns: minmax(112px, 136px) minmax(0, 1fr); gap: 12px; align-items: center; }
        .art-focal { display: flex; justify-content: center; margin-bottom: 0; }
        .art-stack { position: relative; width: min(100%, 136px); aspect-ratio: 1 / 1; border-radius: 24px; overflow: hidden; box-shadow: var(--shadow); border: 1px solid var(--outline); background: linear-gradient(160deg, var(--art-tint), var(--subdued)); }
        .art-stack-empty { background: linear-gradient(160deg, var(--art-tint), var(--primary-soft) 58%, var(--subdued)); }
        .art-aura { position: absolute; inset: auto -10% -30% -10%; height: 55%; background: radial-gradient(circle at center, var(--art-glow), transparent 70%); pointer-events: none; z-index: 0; }
        .tv-gradient { background: linear-gradient(135deg, #1a237e, #4a148c); display: flex; align-items: center; justify-content: center; }
        .main-art { position: relative; z-index: 1; width: 100%; height: 100%; object-fit: cover; }
        .idle-art { position: relative; z-index: 1; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text); opacity: 0.42; }
        .idle-art-missing {
          flex-direction: column;
          gap: 10px;
          padding: 16px;
          opacity: 1;
          text-align: center;
          background:
            linear-gradient(180deg, rgba(15, 23, 42, 0.18), rgba(15, 23, 42, 0.62)),
            linear-gradient(160deg, var(--fallback-accent, var(--primary)), rgba(15, 23, 42, 0.94));
        }
        .idle-art ha-icon { --mdc-icon-size: 64px; }
        .idle-art-missing ha-icon,
        .missing-media-fallback ha-icon { color: #fff; opacity: 1; }
        .idle-art-copy { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
        .idle-art-eyebrow {
          font-size: 0.66rem;
          font-weight: 900;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.76);
        }
        .idle-art-source {
          font-size: 0.9rem;
          font-weight: 900;
          line-height: 1.1;
          color: #fff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .idle-art-detail {
          font-size: 0.72rem;
          font-weight: 700;
          line-height: 1.25;
          color: rgba(255, 255, 255, 0.82);
        }
        .track-info { min-width: 0; text-align: left; margin: 0; padding: 0; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
        .track-flags { display: flex; flex-wrap: wrap; gap: 8px; }
        .status-display { text-transform: uppercase; }
        .track-title { font-size: clamp(1.02rem, 1.75vw, 1.32rem); font-weight: 900; letter-spacing: -0.03em; margin: 0; color: var(--text); line-height: 1.08; min-height: calc(1.08em * 3); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .track-subtitle { font-size: 0.84rem; color: var(--text-sec); font-weight: 700; margin: 0; line-height: 1.25; min-height: calc(1.25em * 2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .playback-controls { padding: 12px 14px; background: linear-gradient(180deg, var(--glass-heavy), var(--glass)); border-radius: 24px; border: 1px solid var(--outline); backdrop-filter: blur(18px) saturate(1.08); }
        .progress-shell { position: relative; padding: 6px 2px 0; }
        .seek-shell { position: relative; }
        .seek-shell.is-seekable { cursor: pointer; }
        .progress-bar { height: 7px; background: linear-gradient(90deg, var(--subdued), var(--scrubber)); border-radius: 999px; overflow: hidden; position: relative; }
        .progress-bar-hero { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12); }
        .progress-bar-mini { border-radius: 999px; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, var(--primary), var(--primary-halo)); transition: width 0.3s; border-radius: inherit; }
        .progress-glow { position: absolute; left: 2px; top: 8px; height: 7px; border-radius: 999px; background: linear-gradient(90deg, var(--primary-halo), transparent); filter: blur(8px); opacity: 0.8; pointer-events: none; }
        .seek-slider {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          margin: 0;
          opacity: 0;
          cursor: pointer;
          z-index: 2;
        }
        .seek-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 18px;
          height: 18px;
        }
        .seek-slider::-moz-range-thumb {
          width: 18px;
          height: 18px;
          border: none;
        }
        .seek-slider-mini { min-height: 12px; }
        .seek-slider-full { min-height: 20px; }
        .time-meta { display: flex; justify-content: space-between; font-size: 0.63rem; margin-top: 4px; color: var(--text-sec); font-weight: 700; }
        .mini-time-meta {
          margin: 6px 12px 0;
          font-size: 0.6rem;
          line-height: 1;
        }
        .buttons-row { display: flex; justify-content: center; align-items: center; gap: 12px; margin: 10px 0 2px; }
        .buttons-row-full { display: grid; grid-template-columns: 46px minmax(0, 1fr) 46px; align-items: center; gap: 10px; }
        .transport-cluster { display: inline-flex; justify-content: center; align-items: center; gap: 12px; flex: 1 1 auto; min-width: 0; }
        .play-btn { width: 64px; height: 64px; border-radius: 22px; background: var(--primary); color: var(--on-primary); border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: var(--control-shadow); }
        .play-btn ha-icon { --mdc-icon-size: 28px; }
        .transport-btn,
        .icon-btn,
        .slider-icon-btn,
        .footer-btn,
        .room-toggle-btn,
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
        .room-toggle-btn:focus-visible,
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
        .room-toggle-btn:hover,
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
        .settings-btn { width: 44px; height: 44px; flex: 0 0 44px; }
        .view-title { font-size: 1.1rem; font-weight: 900; margin-bottom: 12px; color: var(--primary); text-transform: uppercase; letter-spacing: 0.05em; }
        .vol-label-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-weight: 800; }
        .volume-inline { display: flex; align-items: center; gap: 8px; }
        .control-eyebrow { color: var(--text-sec); font-size: 0.74rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
        .volume-card-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 14px; }
        .volume-head-actions { display: inline-flex; align-items: center; gap: 10px; }
        .volume-chip { padding: 7px 10px; border-radius: 999px; border: 1px solid var(--outline); background: var(--glass-heavy); color: var(--text-sec); font-size: 0.72rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; }
        .volume-figure { margin-top: 4px; font-size: 1.8rem; font-weight: 900; line-height: 1; color: var(--text); }
        .room-levels-stack { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
        .volume-room-card { margin-bottom: 0; padding: 14px 16px; }
        .room-volume-head { margin-bottom: 10px; font-size: 0.92rem; }
        .slider-shell { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; }
        .slider-shell-master { gap: 12px; }
        .slider-icon-btn { width: 40px; height: 40px; border-radius: 14px; box-shadow: var(--control-shadow); }
        .slider-icon-btn-master { background: var(--card-bg-soft); }
        .mute-btn.active { background: var(--primary); color: var(--on-primary); border-color: transparent; }
        .slider-icon-btn[disabled] { opacity: 0.45; cursor: not-allowed; transform: none; }
        input[type=range] { flex: 1; accent-color: var(--primary); height: 8px; cursor: pointer; background: transparent; }
        input[type=range]::-webkit-slider-runnable-track { height: 8px; border-radius: 999px; background: var(--scrubber); }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 20px; height: 20px; margin-top: -6px; border-radius: 50%; border: 3px solid var(--card-bg-strong); background: var(--primary); box-shadow: var(--control-shadow); }
        input[type=range]::-moz-range-track { height: 8px; border-radius: 999px; background: var(--scrubber); }
        input[type=range]::-moz-range-thumb { width: 20px; height: 20px; border-radius: 50%; border: 3px solid var(--card-bg-strong); background: var(--primary); box-shadow: var(--control-shadow); }
        .footer { position: sticky; bottom: 0; z-index: 3; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; padding: 10px 14px calc(14px + env(safe-area-inset-bottom, 0px)); background: linear-gradient(180deg, rgba(0, 0, 0, 0), var(--glass-heavy) 18%); border-top: 1px solid var(--outline); backdrop-filter: blur(18px); }
        .footer-btn { border-radius: 16px; padding: 10px 0; color: var(--text-sec); min-height: 48px; flex-direction: column; gap: 4px; font-size: 0.7rem; font-weight: 800; }
        .footer-btn ha-icon { --mdc-icon-size: 22px; }
        .footer-btn.active { background: var(--primary-soft); color: var(--text); border-color: var(--primary-strong); }
        .browse-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; }
        .browse-item { display: flex; flex-direction: column; gap: 10px; padding: 12px; margin-bottom: 0; cursor: pointer; border-radius: 18px; }
        .browse-item:hover { background: var(--glass-heavy); }
        .action-card { width: 100%; text-align: left; }
        .browse-art { position: relative; aspect-ratio: 1 / 1; border-radius: 18px; overflow: hidden; border: 1px solid var(--outline); background: linear-gradient(160deg, var(--primary-soft), var(--subdued)); display:flex; align-items:center; justify-content:center; }
        .browse-art img { width: 100%; height: 100%; object-fit: cover; }
        .browse-label { font-weight: 800; font-size: 0.92rem; line-height: 1.2; min-height: 2.2em; color: var(--text); }
        .browse-meta { font-size: 0.74rem; color: var(--text-sec); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
        .power-toggle {
          gap: 8px;
          min-height: 46px;
          width: 100%;
          padding: 0 16px;
          border-radius: 999px;
          font-weight: 800;
          font-size: 0.82rem;
          box-shadow: var(--control-shadow);
          justify-content: center;
        }
        .power-toggle.on {
          background: var(--primary);
          color: var(--on-primary);
          border-color: transparent;
        }
        .power-toggle.off {
          color: var(--text);
        }
        .power-icon-btn {
          width: 46px;
          min-width: 46px;
          min-height: 46px;
          padding: 0;
          border-radius: 16px;
        }
        .mini-player {
          position: relative;
          z-index: 5;
          padding: 0;
          border-bottom: 1px solid var(--divider);
          overflow: hidden;
          background: var(--glass-heavy);
          backdrop-filter: blur(18px) saturate(1.08);
          will-change: transform, opacity;
          transform-origin: center top;
        }
        .mini-player.animate-up { animation: mini-player-rise 0.28s ease-out; }
        .mini-player.animate-down { animation: mini-player-drop 0.38s ease-out; }
        .mini-player-main {
          position: relative;
          z-index: 1;
          min-height: 92px;
          display: grid;
          grid-template-columns: 84px minmax(0, 1fr) auto;
          gap: 0;
          align-items: stretch;
        }
        .mini-art-button,
        .mini-meta { border: none; background: transparent; padding: 0; color: inherit; text-align: left; cursor: pointer; }
        .mini-art-button {
          display: flex;
          align-items: stretch;
          height: 100%;
          min-height: 100%;
        }
        .mini-art {
          position: relative;
          width: 100%;
          height: 100%;
          border-radius: 0;
          overflow: hidden;
          border: none;
          background: linear-gradient(160deg, var(--art-tint), var(--subdued));
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: inset -1px 0 0 rgba(255,255,255,0.08);
        }
        .mini-art-empty {
          background:
            linear-gradient(180deg, rgba(15, 23, 42, 0.14), rgba(15, 23, 42, 0.5)),
            linear-gradient(160deg, var(--fallback-accent, var(--primary)), rgba(15, 23, 42, 0.92));
        }
        .mini-art-image { width: 100%; height: 100%; object-fit: cover; }
        .mini-art-fallback { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
        .mini-art-fallback ha-icon { --mdc-icon-size: 24px; }
        .missing-media-fallback {
          position: relative;
          z-index: 1;
          flex-direction: column;
          gap: 6px;
          padding: 8px;
          text-align: center;
        }
        .mini-art-label {
          display: block;
          max-width: 100%;
          font-size: 0.62rem;
          font-weight: 900;
          line-height: 1.1;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.92);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mini-meta {
          min-width: 0;
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 4px;
          padding: 14px 12px 14px 14px;
        }
        .mini-title { display: block; font-size: 0.92rem; font-weight: 900; color: var(--text); line-height: 1.2; min-height: 1.2em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mini-subtitle { display: block; font-size: 0.78rem; font-weight: 700; color: var(--text-sec); line-height: 1.2; min-height: 1.2em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mini-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 14px 0 0;
        }
        .mini-action-btn { width: 42px; height: 42px; border-radius: 14px; }
        .mini-power { width: 42px; min-width: 42px; min-height: 42px; border-radius: 14px; }
        .source-anchor { position: relative; display: flex; align-items: center; justify-content: flex-end; }
        .source-anchor-full { justify-self: end; }
        .source-anchor-mini { flex: 0 0 auto; }
        .source-toggle { width: 46px; height: 46px; padding: 0; border-radius: 16px; box-shadow: var(--control-shadow); }
        .source-toggle.active { background: var(--primary-soft); border-color: var(--primary-strong); }
        .mini-source-btn { width: 42px; height: 42px; border-radius: 14px; }
        .mini-progress {
          position: relative;
          z-index: 1;
          margin-top: 0;
          width: 100%;
          padding-bottom: 8px;
        }
        .mini-progress .progress-bar {
          height: 4px;
          border-radius: 0;
        }
        .mini-progress .seek-slider-mini {
          min-height: 22px;
          transform: translateY(-2px);
        }
        .loading-spin { text-align: center; padding: 40px; }
        .browse-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 40px 20px; color: var(--text-sec); font-size: 0.9rem; font-weight: 600; text-align: center; }
        .browse-empty ha-icon { --mdc-icon-size: 40px; opacity: 0.4; }
        .system-off-view { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; }
        .system-off-surface {
          justify-content: center;
          background: linear-gradient(180deg, var(--glass-heavy), var(--card-bg-strong));
        }
        .system-off-shell {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
        }
        .off-icon-wrap { width: 80px; height: 80px; border-radius: 50%; background: var(--glass-heavy); display: flex; align-items: center; justify-content: center; color: var(--text-sec); opacity: 0.5; }
        .off-text { font-size: 1.1rem; font-weight: 800; color: var(--text-sec); }
        .turn-on-btn { width: auto; height: auto; padding: 12px 24px; border-radius: 14px; display: flex; align-items: center; gap: 10px; font-weight: 800; background: var(--primary); color: var(--on-primary); }
        .source-menu { position: absolute; top: calc(100% + 10px); right: 0; background: var(--glass-heavy); border: 1px solid var(--primary-strong); border-radius: 16px; z-index: 40; box-shadow: var(--shadow); padding: 8px; max-height: min(280px, calc(100dvh - 220px)); overflow-y: auto; min-width: 220px; width: min(280px, calc(100vw - 48px)); backdrop-filter: blur(18px) saturate(1.08); }
        .source-menu-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px 10px; color: var(--text-sec); font-size: 0.7rem; font-weight: 900; text-transform: uppercase; letter-spacing: 0.05em; }
        .source-menu-current { min-width: 0; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .source-menu-item { width: 100%; text-align: left; padding: 12px 16px; border-radius: 10px; cursor: pointer; font-weight: 700; font-size: 0.9rem; transition: 0.2s; border-bottom: 1px solid var(--divider); border-left: none; border-right: none; border-top: none; justify-content: space-between; }
        .source-menu-item:hover { background: var(--primary-soft); color: var(--text); }
        .source-menu-item:last-child { border-bottom: none; }
        .source-menu-item.selected { background: var(--primary-soft); border-color: transparent; }
        .source-menu-item-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .source-menu-check { --mdc-icon-size: 18px; flex-shrink: 0; color: var(--primary); }
        .source-menu-empty { padding: 14px 16px; color: var(--text-sec); font-size: 0.85rem; font-weight: 700; }
        .rooms-view { display: flex; flex-direction: column; gap: 10px; }
        .room-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 14px 16px; margin-bottom: 0; }
        .room-copy { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
        .room-title { font-weight: 800; font-size: 1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .room-meta { font-size: 0.76rem; color: var(--text-sec); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
        .room-toggle-btn { min-width: 112px; min-height: 46px; padding: 10px 14px; border-radius: 14px; justify-content: center; gap: 8px; font-weight: 800; box-shadow: var(--control-shadow); }
        .room-toggle-btn.on { background: var(--primary); color: var(--on-primary); border-color: transparent; }
        .room-toggle-btn.off { background: var(--glass-heavy); color: var(--text); }
        .room-toggle-btn.pending { opacity: 0.72; pointer-events: none; }
        .room-toggle-btn ha-circular-progress { --mdc-circular-progress-size: 18px; }
        @keyframes player-drop-open {
          from { opacity: 0.72; transform: translateY(26px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes player-lift-close {
          from { opacity: 0.94; transform: translateY(0) scale(1); }
          to { opacity: 1; transform: translateY(-12px) scale(0.992); }
        }
        @keyframes mini-player-rise {
          from { opacity: 0.72; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes mini-player-drop {
          from { opacity: 0.82; transform: translateY(-14px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes page-slide-in-left {
          from { opacity: 0.9; transform: translateX(14px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes page-slide-in-right {
          from { opacity: 0.9; transform: translateX(-14px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @media (max-width: 768px) {
          ha-card { max-width: 100%; height: min(424px, max(292px, calc(100dvh - var(--ags-card-viewport-offset, 162px)))); min-height: min(292px, calc(100dvh - 72px)); }
          .card-header { padding: 14px 14px 12px; }
          .section-body { padding: 14px 14px calc(92px + env(safe-area-inset-bottom, 0px)); }
          .section-player { padding-bottom: 12px; }
          .player-main { grid-template-columns: 104px minmax(0, 1fr); gap: 10px; }
          .art-stack { width: min(100%, 104px); border-radius: 20px; }
          .buttons-row { gap: 8px; }
          .buttons-row-full { grid-template-columns: 46px minmax(0, 1fr) 46px; gap: 8px; }
          .footer { padding: 8px 10px calc(12px + env(safe-area-inset-bottom, 0px)); }
          .volume-card-head { flex-direction: column; align-items: flex-start; }
          .room-toggle-btn { min-width: 104px; }
        }
        @media (max-width: 420px) {
          .browse-grid { grid-template-columns: 1fr; }
          ha-card { max-width: 100%; }
          .card-header { grid-template-columns: 1fr; }
          .header-picker-wrap,
          .header-actions { width: 100%; justify-content: stretch; }
          .header-meta-row { gap: 6px; width: 100%; }
          .header-meta-row > * { flex: 1 1 0; min-width: 0; }
          .hero-pill { max-width: 100%; text-align: center; }
          .play-btn { width: 58px; height: 58px; }
          .footer { grid-template-columns: repeat(4, minmax(48px, 1fr)); }
          .footer-btn { padding: 10px 0; }
          .player-main { grid-template-columns: 1fr; justify-items: center; }
          .track-info { align-items: center; text-align: center; }
          .track-flags { justify-content: center; }
          .buttons-row-full { grid-template-columns: 42px minmax(0, 1fr) 42px; }
          .transport-cluster { width: 100%; justify-content: center; }
          .mini-player-main { min-height: 84px; grid-template-columns: 76px minmax(0, 1fr) auto; }
          .mini-meta { padding: 12px 10px 12px 12px; }
          .mini-actions { padding-right: 12px; gap: 6px; }
          .source-menu { width: min(280px, calc(100vw - 32px)); }
          .slider-shell,
          .slider-shell-master { grid-template-columns: 36px minmax(0, 1fr) 36px; gap: 8px; }
          .slider-icon-btn { width: 36px; height: 36px; }
          .section-body { padding-inline: 12px; }
          .room-row { grid-template-columns: 1fr; }
          .room-toggle-btn { width: 100%; }
        }
      </style>
      <ha-card>
        <div class="backdrop"></div>
        <div class="${surfaceClass}">
          ${!isSystemOff && !isPlayerSection ? this.renderMiniPlayer(ags, snapshot, currentSrc, sourceMenuId) : ""}
          <div class="${sectionBodyClass}">
            <div class="transition-shell ${!isSystemOff && !isPlayerSection ? this._transitionPreset : ""}">
              ${isSystemOff
                ? this.renderPlayerSection(ags, control, sourceMenuId)
                : this._section === "rooms" ? this.renderRooms(ags) :
                  this._section === "browse" ? this.renderBrowse() :
                  this._section === "volumes" ? this.renderVolumesSection(ags) :
                  this.renderPlayerSection(ags, control, sourceMenuId)}
            </div>
          </div>
          ${!isSystemOff ? `
            <div class="footer">
              <button type="button" class="footer-btn ${this._section==='player'?'active':''}" aria-label="Player" onclick="this.getRootNode().host.setSection('player')"><ha-icon icon="mdi:play-circle"></ha-icon><span>Player</span></button>
              <button type="button" class="footer-btn ${this._section==='browse'?'active':''}" aria-label="Browse" onclick="this.getRootNode().host.setSection('browse')"><ha-icon icon="mdi:folder-music"></ha-icon><span>Browse</span></button>
              <button type="button" class="footer-btn ${this._section==='rooms'?'active':''}" aria-label="Rooms" onclick="this.getRootNode().host.setSection('rooms')"><ha-icon icon="mdi:speaker-multiple"></ha-icon><span>Rooms</span></button>
              <button type="button" class="footer-btn ${this._section==='volumes'?'active':''}" aria-label="Volume" onclick="this.getRootNode().host.setSection('volumes')"><ha-icon icon="mdi:tune-vertical"></ha-icon><span>Volume</span></button>
            </div>
          ` : ""}
        </div>
      </ha-card>
    `;
  }

  renderRooms(ags) {
    const r = this.toArray(ags.attributes.room_details);
    return `<div class="rooms-view"><div class="view-title">Rooms</div>${r.map(room => {
      const switchOn = this.getRoomDesiredState(
        room.switch_entity_id,
        (room.switch_state || "").toLowerCase() === "on",
      );
      const pending = this.isRoomTogglePending(room.switch_entity_id);
      const roomMeta = room.active
        ? "Included in group"
        : switchOn
          ? "On, waiting for AGS"
          : "Excluded from group";
      return `
      <div class="list-card room-row">
        <div class="room-copy">
          <div class="room-title">${this.escapeHtml(room.name)}</div>
          <div class="room-meta">${roomMeta}</div>
        </div>
        <button
          type="button"
          class="room-toggle-btn ${switchOn ? "on" : "off"} ${pending ? "pending" : ""}"
          aria-pressed="${switchOn ? "true" : "false"}"
          aria-label="${switchOn ? "Turn off" : "Turn on"} ${this.escapeHtml(room.name)}"
          ${pending ? "disabled" : ""}
          onclick="this.getRootNode().host.toggleRoom('${room.switch_entity_id}', ${((room.switch_state || "").toLowerCase() === "on") ? "true" : "false"})"
        >
          ${pending ? '<ha-circular-progress active indeterminate></ha-circular-progress>' : `<ha-icon icon="${switchOn ? "mdi:power-plug" : "mdi:power-plug-off"}"></ha-icon>`}
          <span>${pending ? "Updating" : switchOn ? "On" : "Off"}</span>
        </button>
      </div>`;
    }).join("")}</div>`;
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
