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
    this._showQuickVolume = false;
    this._sectionScrollTop = 0;
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
    this._lastRenderSignature = "";
    this._progressFrame = null;
    this._progressStateSignature = "";
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
    this.stopProgressLoop();
  }

  setConfig(config) {
    const normalizedConfig =
      config && typeof config === "object"
        ? { ...config }
        : {};
    const entity =
      typeof normalizedConfig.entity === "string" && normalizedConfig.entity.trim()
        ? normalizedConfig.entity.trim()
        : "media_player.ags_media_player";

    this._config = {
      ...normalizedConfig,
      entity,
    };

    const configuredStart = typeof normalizedConfig.start_section === "string" ? normalizedConfig.start_section : "player";
    this._section = this.getSavedSection(configuredStart);
    this.render(true);
  }

  getCardSize() { return 6; }

  getSectionStorageKey() {
    const entityId = this._config?.entity || "ags-media-card";
    return `ags-media-card:section:${entityId}`;
  }

  getSavedSection(fallback = "player") {
    const valid = new Set(["player", "browse", "rooms", "sources"]);
    const normalizedFallback = fallback === "volumes" ? "rooms" : fallback;
    const preferred = valid.has(normalizedFallback) ? normalizedFallback : "player";
    try {
      const saved = window.localStorage?.getItem(this.getSectionStorageKey());
      if (saved === "volumes") return "rooms";
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

  getOuterScrollTargets() {
    const targets = [];
    const seen = new Set();
    let node = this;

    while (node) {
      node = node.parentNode || node.host || null;

      if (node instanceof HTMLElement) {
        const style = window.getComputedStyle(node);
        const overflowY = `${style.overflowY} ${style.overflow}`;
        const overflowX = `${style.overflowX} ${style.overflow}`;
        const canScrollY = /(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight;
        const canScrollX = /(auto|scroll|overlay)/.test(overflowX) && node.scrollWidth > node.clientWidth;

        if ((canScrollY || canScrollX || node.scrollTop || node.scrollLeft) && !seen.has(node)) {
          targets.push(node);
          seen.add(node);
        }
        continue;
      }

      if (node instanceof Document) {
        const scrollRoot = node.scrollingElement || node.documentElement;
        if (scrollRoot && !seen.has(scrollRoot)) {
          targets.push(scrollRoot);
        }
        break;
      }
    }

    return targets;
  }

  captureOuterScrollState() {
    return {
      targets: this.getOuterScrollTargets().map((node) => ({
        node,
        top: node.scrollTop,
        left: node.scrollLeft,
      })),
      windowX: window.scrollX,
      windowY: window.scrollY,
    };
  }

  restoreOuterScrollState(state) {
    if (!state) return;

    state.targets.forEach(({ node, top, left }) => {
      if (!node || node.isConnected === false) return;
      node.scrollTop = top;
      node.scrollLeft = left;
    });

    window.scrollTo({
      left: state.windowX,
      top: state.windowY,
      behavior: "auto",
    });
  }

  set hass(hass) {
    const hadBrowseItems = this._browseItems.length > 0;
    this._hass = hass;
    this._syncPendingVolumes();
    this._syncPendingRoomToggles();
    if (this._config) {
      this.render();
      this.syncLiveProgressUi();
      if (this._section === "browse" && !hadBrowseItems && !this._loadingBrowse) {
        this.browseMedia();
      }
    }
  }

  getAgsPlayer() {
    if (!this._hass) return null;
    const configuredEntity = this._config?.entity;
    if (configuredEntity && this._hass.states?.[configuredEntity]) {
      return this._hass.states[configuredEntity];
    }
    return Object.values(this._hass.states).find(s => s?.attributes?.ags_status !== undefined) || null;
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
      .replace(/'/g, "&#39;")
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

  getThemePalette(artworkUrl = "", fallbackAccent = "") {
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
    const fallbackAccentColor = fallbackAccent
      ? this.normalizeAccentColor(this.toOpaque(this.parseColor(fallbackAccent, [37, 99, 235, 1]), surface), isDark)
      : null;
    const accentSource = artPalette ? "artwork" : (fallbackAccentColor ? "source" : "theme");
    const artAccent = artPalette
      ? this.normalizeAccentColor(artPalette.accent, isDark)
      : fallbackAccentColor;
    const artAverage = artPalette?.average || artAccent || primary;
    const tunedPrimary = artAccent
      ? this.mixColors(primary, artAccent, accentSource === "source" ? 0.86 : 0.72)
      : primary;
    const shellBase = artAccent
      ? this.mixColors(background, artAccent, accentSource === "source" ? (isDark ? 0.22 : 0.12) : (isDark ? 0.18 : 0.08))
      : this.mixColors(background, primary, isDark ? 0.08 : 0.03);
    const surfaceStrong = artAccent
      ? this.mixColors(surface, artAverage, accentSource === "source" ? (isDark ? 0.22 : 0.16) : (isDark ? 0.16 : 0.1))
      : this.mixColors(surface, background, isDark ? 0.08 : 0.28);
    const surfaceSoft = artAccent
      ? this.mixColors(surface, artAverage, accentSource === "source" ? (isDark ? 0.3 : 0.22) : (isDark ? 0.24 : 0.16))
      : this.mixColors(surface, background, isDark ? 0.16 : 0.42);
    const glassSurface = artAccent
      ? this.mixColors(surface, artAverage, accentSource === "source" ? (isDark ? 0.24 : 0.16) : (isDark ? 0.18 : 0.12))
      : surface;
    const glassHeavySurface = artAccent
      ? this.mixColors(surfaceStrong, artAccent, accentSource === "source" ? (isDark ? 0.3 : 0.18) : (isDark ? 0.24 : 0.14))
      : surfaceStrong;
    const artGlow = artAccent ? this.mixColors(artAccent, [255, 255, 255], isDark ? 0.08 : 0.22) : tunedPrimary;
    const onPrimary = this.getReadableTextColor(primary, text);
    const sourceAccentSoft = this.rgba(artAccent || tunedPrimary, isDark ? 0.26 : 0.16);
    const playerBaseColor = artAccent
      ? this.mixColors(surfaceStrong, artAverage, accentSource === "source" ? (isDark ? 0.28 : 0.2) : (isDark ? 0.2 : 0.14))
      : surfaceStrong;
    const playerMidColor = artAccent
      ? this.mixColors(surfaceSoft, artAverage, accentSource === "source" ? (isDark ? 0.3 : 0.22) : (isDark ? 0.22 : 0.16))
      : surfaceSoft;
    const playerInk = this.getReadableTextColor(playerBaseColor, text);
    const playerMuted = this.mixColors(playerInk, playerBaseColor, isDark ? 0.34 : 0.46);
    const playerLineColor = this.rgba(playerInk, isDark ? 0.24 : 0.18);
    const playerChipBg = this.rgba(this.mixColors(playerBaseColor, background, isDark ? 0.04 : 0.02), isDark ? 0.9 : 0.92);
    const playerChipBgStrong = this.rgba(this.mixColors(playerBaseColor, background, isDark ? 0.02 : 0), isDark ? 0.96 : 0.97);
    const playerFadeBase = this.rgba(playerBaseColor, isDark ? 0.98 : 0.96);
    const playerFadeMid = this.rgba(playerMidColor, isDark ? 0.82 : 0.72);
    const playerPanelBg = this.rgba(this.mixColors(playerBaseColor, background, isDark ? 0.08 : 0.04), isDark ? 0.42 : 0.32);
    const playerPanelBgStrong = this.rgba(this.mixColors(playerMidColor, background, isDark ? 0.06 : 0.03), isDark ? 0.58 : 0.46);
    const playerPanelBorder = this.rgba(this.mixColors(playerInk, playerBaseColor, isDark ? 0.74 : 0.84), isDark ? 0.34 : 0.18);
    const sectionOverlay = this.rgba(this.mixColors(playerBaseColor, background, isDark ? 0.06 : 0.03), isDark ? 0.24 : 0.14);

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
      sourceAccentSoft,
      playerFadeBase,
      playerFadeMid,
      playerInk: this.rgb(playerInk),
      playerMuted: this.rgb(playerMuted),
      playerLine: playerLineColor,
      playerChipBg,
      playerChipBgStrong,
      playerPanelBg,
      playerPanelBgStrong,
      playerPanelBorder,
      sectionOverlay,
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
    if (/^data:/i.test(raw)) return raw;
    let resolved = raw;
    if (raw.startsWith("//")) {
      resolved = `${window.location.protocol}${raw}`;
    } else if (!/^https?:/i.test(raw) && typeof this._hass?.hassUrl === "function") {
      resolved = this._hass.hassUrl(raw.startsWith("/") ? raw : `/${raw}`);
    }
    const auth = this._hass?.auth || {};
    const token = auth.data?.access_token || auth.accessToken;
    if (!token) return resolved;
    try {
      const url = new URL(resolved, window.location.origin);
      if (url.origin === window.location.origin) {
        url.searchParams.set("authSig", token);
        return url.toString();
      }
    } catch (error) {
      // Fall back to the raw value when the URL cannot be normalized.
    }
    return resolved;
  }

  getArtworkUrl(ctrl, ags) {
    const url = this.getEntityPicture(ctrl) || this.getEntityPicture(ags);
    return this.resolveMediaUrl(url);
  }

  getBrowseCandidates(ags) {
    const candidates = [
      ags?.entity_id,
      ags?.attributes?.browse_entity_id,
      ags?.attributes?.primary_speaker,
      ags?.attributes?.preferred_primary_speaker,
      ags?.attributes?.control_device_id,
    ];
    const seen = new Set();
    return candidates.filter((entityId) => {
      const normalized = String(entityId || "").trim();
      if (!normalized || normalized === "none" || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  humanizeBrowseLabel(value, fallback = "Media") {
    const normalized = String(value || "").trim();
    if (!normalized) return fallback;
    return normalized
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\b\w/g, (match) => match.toUpperCase());
  }

  normalizeBrowseItem(item) {
    if (!item || typeof item !== "object") return null;
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

  normalizeBrowseResponse(response) {
    const children = Array.isArray(response?.children)
      ? response.children.map((child) => this.normalizeBrowseItem(child)).filter(Boolean)
      : [];
    return { ...response, children };
  }

  getBrowseNodeKey(node) {
    if (!node || typeof node !== "object") return "";
    return [
      String(node.media_content_type || "").trim(),
      String(node.media_content_id || "").trim(),
      String(node.title || node.name || "").trim(),
      String(node.media_class || "").trim(),
    ].join("::");
  }

  hasCompleteBrowseTarget(node) {
    if (!node || typeof node !== "object") return false;
    return Boolean(String(node.media_content_type || "").trim() && String(node.media_content_id || "").trim());
  }

  applyBrowsePayloadNode(payload, node) {
    if (!node || typeof node !== "object") return payload;
    if (!this.hasCompleteBrowseTarget(node)) return payload;
    payload.media_content_type = String(node.media_content_type || "").trim();
    payload.media_content_id = String(node.media_content_id || "").trim();
    return payload;
  }

  setBrowseNodeResults(node) {
    const normalized = this.normalizeBrowseItem(node);
    this._browseItems = Array.isArray(normalized?.children) ? normalized.children : [];
    this._browseError = this._browseItems.length
      ? ""
      : "This media folder does not expose any child items in the custom browser.";
  }

  rememberBrowseNode(node) {
    const nodeKey = this.getBrowseNodeKey(node);
    const currentKey = this.getBrowseNodeKey(this._browseStack[this._browseStack.length - 1]);
    if (!nodeKey || currentKey === nodeKey) return;
    this._browseStack.push({
      title: node.title,
      media_content_id: node.media_content_id,
      media_content_type: node.media_content_type,
      media_class: node.media_class,
      children: Array.isArray(node.children) ? node.children : [],
    });
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
    return item?.can_play ? "mdi:play-circle" : "mdi:music";
  }

  getBrowseItemMeta(item) {
    const kind = this.humanizeBrowseLabel(item?.media_class || item?.media_content_type, item?.can_expand ? "Folder" : "Media");
    if (item?.can_expand && item?.can_play) return `${kind} • Open or play`;
    if (item?.can_expand) return `${kind} • Open`;
    if (item?.can_play) return `${kind} • Play`;
    return `${kind} • Unavailable`;
  }

  renderBrowseArtwork(item, className = "browse-art") {
    const thumbnail = item?.thumbnail ? this.resolveMediaUrl(item.thumbnail) : "";
    const icon = this.getBrowseItemIcon(item);
    return `
      <div class="${className}${thumbnail ? "" : " no-image"}" data-browse-art>
        ${thumbnail
          ? `<img src="${this.escapeAttribute(thumbnail)}" alt="" loading="lazy" onerror="const host=this.closest('[data-browse-art]'); if (host) host.classList.add('image-failed'); this.remove();" />`
          : ""}
        <span class="browse-art-fallback" aria-hidden="true">
          <ha-icon icon="${icon}"></ha-icon>
        </span>
      </div>
    `;
  }

  getBrowseErrorMessage(error) {
    const detail = String(error?.message || error || "").trim();
    if (!detail) return "Could not load media library. Make sure your speaker is reachable.";
    if (/media_content_type.*media_content_id.*provided together/i.test(detail)) {
      return "Could not open that media folder because the speaker returned an incomplete browse target.";
    }
    if (/browse media/i.test(detail) || /entity not found/i.test(detail)) {
      return "Could not load media library from AGS or the active speaker.";
    }
    return `Could not load media library. ${detail}`;
  }

  getLiveMediaPosition(entity) {
    if (!entity || entity.state !== "playing" || !entity.attributes.media_position_updated_at) return entity?.attributes?.media_position || 0;
    const now = Date.now() / 1000;
    const update = new Date(entity.attributes.media_position_updated_at).getTime() / 1000;
    return (entity.attributes.media_position || 0) + (now - update);
  }

  stopProgressLoop() {
    if (this._progressFrame) {
      window.cancelAnimationFrame(this._progressFrame);
      this._progressFrame = null;
    }
    this._progressStateSignature = "";
  }

  getProgressStateSignature(entity, snapshot) {
    return JSON.stringify({
      entity_id: entity?.entity_id || "",
      section: this._section,
      duration: Number(snapshot?.duration || 0),
      state: entity?.state || "",
      media_position: Number(entity?.attributes?.media_position || 0),
      media_position_updated_at: entity?.attributes?.media_position_updated_at || "",
      pendingSeekPosition: this._pendingSeekPosition == null ? null : Math.round(this._pendingSeekPosition),
    });
  }

  syncLiveProgressUi() {
    if (!this.shadowRoot) {
      this.stopProgressLoop();
      return;
    }

    const ags = this.getAgsPlayer();
    const control = this.getControlPlayer();
    const entity = control || ags;
    const snapshot = ags ? this.getPlayerSnapshot(ags, control) : null;

    if (!entity || !snapshot?.duration) {
      this.stopProgressLoop();
      return;
    }

    const signature = this.getProgressStateSignature(entity, snapshot);
    const updateFrame = () => {
      const latestAgs = this.getAgsPlayer();
      const latestControl = this.getControlPlayer();
      const latestEntity = latestControl || latestAgs;
      const latestSnapshot = latestAgs ? this.getPlayerSnapshot(latestAgs, latestControl) : null;

      if (!latestEntity || !latestSnapshot?.duration) {
        this.stopProgressLoop();
        return;
      }

      const liveSignature = this.getProgressStateSignature(latestEntity, latestSnapshot);
      if (liveSignature !== this._progressStateSignature) {
        this._progressStateSignature = liveSignature;
      }

      const displayPosition = this.getDisplayedPosition(latestSnapshot);
      const displayProgress = this.getDisplayedProgress(latestSnapshot);
      const progress = `${displayProgress}%`;

      this.shadowRoot.querySelectorAll(".progress-fill").forEach((node) => {
        node.style.width = progress;
      });
      this.shadowRoot.querySelectorAll(".progress-glow").forEach((node) => {
        node.style.width = progress;
      });
      this.shadowRoot.querySelectorAll(".seek-slider").forEach((node) => {
        node.value = String(displayPosition);
      });
      this.shadowRoot.querySelectorAll(".time-current").forEach((node) => {
        node.textContent = this.formatTime(displayPosition);
      });

      if (latestEntity.state === "playing" || latestEntity.state === "buffering") {
        this._progressFrame = window.requestAnimationFrame(updateFrame);
      } else {
        this._progressFrame = null;
      }
    };

    this.stopProgressLoop();
    this._progressStateSignature = signature;
    updateFrame();
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
      <div id="${sourceMenuId}" class="source-menu" role="dialog" aria-modal="true" aria-label="Select source">
        <button
          type="button"
          class="source-menu-backdrop"
          aria-label="Close source selector"
          onclick="this.getRootNode().host.toggleSourceMenu()"
        ></button>
        <div class="source-sheet">
          <div class="source-menu-header">
            <div class="source-menu-title-wrap">
              <span>Select Source</span>
              <span class="source-menu-current">${this.escapeHtml(currentSrc)}</span>
            </div>
            <button
              type="button"
              class="icon-btn source-sheet-close"
              aria-label="Close source selector"
              onclick="this.getRootNode().host.toggleSourceMenu()"
            >
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          <div class="source-sheet-list" role="listbox" aria-label="Available sources" onclick="event.stopPropagation()">
            ${sourceOptions.length
              ? sourceOptions.map((source) => {
                const selected = source === currentSrc;
                const sourcePresentation = this.getSourcePresentation(source, ags?.attributes?.ags_status === "ON TV");
                return `
                  <button
                    type="button"
                    role="option"
                    aria-selected="${selected ? "true" : "false"}"
                    class="source-menu-item ${selected ? "selected" : ""}"
                    onclick="this.getRootNode().host.callService('media_player', 'select_source', {entity_id: '${ags.entity_id}', source: '${this.escapeJsString(source)}'})"
                  >
                    <span class="source-menu-item-leading" style="--source-item-accent:${sourcePresentation.color};">
                      <ha-icon icon="${sourcePresentation.icon}"></ha-icon>
                    </span>
                    <span class="source-menu-item-label">${this.escapeHtml(source)}</span>
                    ${selected ? '<ha-icon class="source-menu-check" icon="mdi:check"></ha-icon>' : ""}
                  </button>
                `;
              }).join("")
              : '<div class="source-menu-empty">No sources available</div>'}
          </div>
        </div>
      </div>
    `;
  }

  renderQuickVolumeMenu(ags, quickVolumeMenuId) {
    if (!this._showQuickVolume) return "";
    const groupVol = this.getDisplayedVolume(ags);
    const groupMuted = this.isGroupMuted(ags);
    const activeSpeakers = this.toArray(ags?.attributes?.active_speakers);
    const activeRooms = this.toArray(ags?.attributes?.active_rooms);
    const roomSummary = activeRooms.length
      ? `${activeRooms.length} active room${activeRooms.length === 1 ? "" : "s"}`
      : `${activeSpeakers.length || 0} active speaker${activeSpeakers.length === 1 ? "" : "s"}`;
    return `
      <div id="${quickVolumeMenuId}" class="quick-volume-menu" role="dialog" aria-modal="true" aria-label="Adjust master volume">
        <button
          type="button"
          class="source-menu-backdrop"
          aria-label="Close master volume"
          onclick="this.getRootNode().host.toggleQuickVolume()"
        ></button>
        <div class="quick-volume-sheet">
          <div class="source-menu-header quick-volume-header">
            <div class="source-menu-title-wrap">
              <span>Master Volume</span>
              <span class="source-menu-current">${groupVol}%${roomSummary ? ` • ${this.escapeHtml(roomSummary)}` : ""}</span>
            </div>
            <button
              type="button"
              class="icon-btn source-sheet-close"
              aria-label="Close master volume"
              onclick="this.getRootNode().host.toggleQuickVolume()"
            >
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>
          <div class="quick-volume-body" onclick="event.stopPropagation()">
            <div class="quick-volume-readout">
              <div class="quick-volume-value" data-volume-id="${ags.entity_id}">${groupVol}%</div>
              <div class="quick-volume-subtitle">Master output for the whole group</div>
            </div>
            <div class="quick-volume-slider-row">
              <button type="button" class="slider-icon-btn slider-icon-btn-master" aria-label="Lower master volume" onclick="this.getRootNode().host.nudgeVolume('${ags.entity_id}', -6)">
                <ha-icon icon="mdi:minus"></ha-icon>
              </button>
              <input
                class="volume-slider volume-slider-master quick-volume-slider"
                type="range"
                min="0"
                max="100"
                value="${groupVol}"
                aria-label="Master volume"
                oninput="this.getRootNode().host.queueVolumeSet('${ags.entity_id}', this.value)"
                onchange="this.getRootNode().host.commitVolumeSet('${ags.entity_id}', this.value)"
              />
              <button type="button" class="slider-icon-btn slider-icon-btn-master" aria-label="Raise master volume" onclick="this.getRootNode().host.nudgeVolume('${ags.entity_id}', 6)">
                <ha-icon icon="mdi:plus"></ha-icon>
              </button>
            </div>
            <div class="quick-volume-actions">
              <button
                type="button"
                class="quick-volume-action ${groupMuted ? "active" : ""}"
                aria-label="${groupMuted ? "Unmute group" : "Mute group"}"
                onclick="this.getRootNode().host.toggleMuteTargets([${activeSpeakers.map((entityId) => `'${entityId}'`).join(", ")}], ${groupMuted ? "true" : "false"})"
              >
                <ha-icon icon="${groupMuted ? "mdi:volume-off" : "mdi:volume-mute"}"></ha-icon>
                <span>${groupMuted ? "Unmute" : "Mute"}</span>
              </button>
              <button
                type="button"
                class="quick-volume-action quick-volume-full"
                aria-label="Set master volume to 100 percent"
                onclick="this.getRootNode().host.commitVolumeSet('${ags.entity_id}', 100)"
              >
                <ha-icon icon="mdi:volume-high"></ha-icon>
                <span>Full Volume</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  setSection(s) {
    if (this._section === s) return;
    const previous = this._section;
    const sectionOrder = ["player", "sources", "browse", "rooms"];
    const normalizedPrevious = previous === "volumes" ? "rooms" : previous;
    const normalizedNext = s === "volumes" ? "rooms" : s;
    if (previous === "player" || s === "player") {
      this._transitionPreset = s === "player" ? "expand-player" : "collapse-player";
    } else {
      this._transitionPreset = sectionOrder.indexOf(normalizedNext) > sectionOrder.indexOf(normalizedPrevious)
        ? "slide-forward"
        : "slide-back";
    }
    this._section = normalizedNext;
    this.saveSection(normalizedNext);
    this._showSourceMenu = false;
    this._showQuickVolume = false;
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
    if (this._showSourceMenu) this._showQuickVolume = false;
    this.render(true);
  }

  toggleQuickVolume() {
    this._showQuickVolume = !this._showQuickVolume;
    if (this._showQuickVolume) this._showSourceMenu = false;
    this.render(true);
  }

  callService(domain, service, data) { 
    this._hass.callService(domain, service, data); 
    if (service === 'select_source') this._showSourceMenu = false;
    this.render(true);
  }

  _handleOutsideClick(event) {
    if (!this._showSourceMenu && !this._showQuickVolume) return;
    // The source sheet has its own backdrop and close button, so
    // document-level outside click handling only causes accidental closes.
  }

  _handleKeydown(event) {
    if (event.key === "Escape" && (this._showSourceMenu || this._showQuickVolume)) {
      this._showSourceMenu = false;
      this._showQuickVolume = false;
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
      showQuickVolume: this._showQuickVolume,
      pendingSeekPosition: this._pendingSeekPosition,
      loadingBrowse: this._loadingBrowse,
      browseError: this._browseError,
      pendingRoomToggles: Array.from(this._pendingRoomToggles.entries()),
      transitionPreset: this._transitionPreset,
      browseStack: this._browseStack.map((item) => `${item.media_content_type}:${item.media_content_id}`),
      browseItems: this._browseItems.map((item) => `${item.title}:${item.media_content_type}:${item.media_content_id}:${item.media_class}:${item.can_expand}:${item.can_play}:${item.thumbnail}`),
      theme: this.getThemeSignature(),
      ags: ags
        ? {
            entity_id: ags.entity_id,
            state: ags.state,
            ags_status: agsAttrs.ags_status,
            source: agsAttrs.source,
            selected_source_name: agsAttrs.selected_source_name,
            volume_level: agsAttrs.volume_level,
            is_volume_muted: agsAttrs.is_volume_muted,
            primary_speaker_room: agsAttrs.primary_speaker_room,
            active_rooms: agsAttrs.active_rooms || [],
            active_speakers: agsAttrs.active_speakers || [],
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
            media_album_name: controlAttrs.media_album_name,
            media_content_type: controlAttrs.media_content_type,
            media_series_title: controlAttrs.media_series_title,
            media_season: controlAttrs.media_season,
            media_episode: controlAttrs.media_episode,
            media_duration: controlAttrs.media_duration,
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

    if (node && !this.hasCompleteBrowseTarget(node) && Array.isArray(node.children) && node.children.length) {
      this.setBrowseNodeResults(node);
      this.rememberBrowseNode(node);
      this._loadingBrowse = false;
      this.render(true);
      return;
    }

    const candidates = this.getBrowseCandidates(ags);
    if (!candidates.length) {
      this._browseItems = [];
      this._browseError = "No speaker configured for browsing. Add a speaker in AGS settings.";
      this.render(true);
      return;
    }
    this._loadingBrowse = true;
    this.render(true);

    try {
      let response = null;
      let lastError = null;

      for (const entityId of candidates) {
        const payload = this.applyBrowsePayloadNode(
          { type: "media_player/browse_media", entity_id: entityId },
          node,
        );
        try {
          response = await this._hass.callWS(payload);
          break;
        } catch (error) {
          lastError = error;
          console.warn("AGS media browse failed for", entityId, error);
        }
      }

      if (!response) {
        throw lastError || new Error("Browse media request failed");
      }

      const normalized = this.normalizeBrowseResponse(response);
      this._browseItems = normalized.children || [];
      if (node) {
        this.rememberBrowseNode(node);
      } else { this._browseStack = []; }
    } catch (e) {
      console.error("AGS browseMedia failed", e);
      this._browseItems = [];
      this._browseError = this.getBrowseErrorMessage(e);
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

  getSourcePresentation(source, isTv = false) {
    const raw = String(source || "").trim();
    const normalized = raw.toLowerCase();

    if (normalized.includes("youtube tv")) {
      return { icon: "mdi:youtube", color: "#ff0000", label: "YouTube TV" };
    }
    if (normalized.includes("youtube")) {
      return { icon: "mdi:youtube", color: "#ff0000", label: "YouTube" };
    }
    if (normalized.includes("spotify")) {
      return { icon: "mdi:spotify", color: "#1db954", label: "Spotify" };
    }
    if (normalized.includes("apple music")) {
      return { icon: "mdi:music-circle", color: "#fa243c", label: "Apple Music" };
    }
    if (normalized.includes("pandora")) {
      return { icon: "mdi:music-circle", color: "#3668ff", label: "Pandora" };
    }
    if (normalized.includes("netflix")) {
      return { icon: "mdi:netflix", color: "#e50914", label: "Netflix" };
    }
    if (normalized.includes("plex")) {
      return { icon: "mdi:plex", color: "#f9be03", label: "Plex" };
    }
    if (normalized.includes("prime")) {
      return { icon: "mdi:amazon", color: "#00a8e1", label: raw || "Prime Video" };
    }
    if (normalized.includes("hulu")) {
      return { icon: "mdi:hulu", color: "#1ce783", label: "Hulu" };
    }
    if (normalized.includes("disney")) {
      return { icon: "mdi:movie-open", color: "#113ccf", label: raw || "Disney+" };
    }
    if (normalized.includes("podcast")) {
      return { icon: "mdi:podcast", color: "#8f5cff", label: raw || "Podcasts" };
    }
    if (normalized.includes("photos")) {
      return { icon: "mdi:image-album", color: "#f59e0b", label: raw || "Photos" };
    }
    if (normalized.includes("twitch")) {
      return { icon: "mdi:twitch", color: "#9146ff", label: "Twitch" };
    }
    if (normalized.includes("app store")) {
      return { icon: "mdi:apps", color: "#3b82f6", label: "App Store" };
    }
    if (normalized.includes("fitness")) {
      return { icon: "mdi:dumbbell", color: "#84cc16", label: raw || "Fitness" };
    }
    if (normalized.includes("settings")) {
      return { icon: "mdi:cog", color: "#94a3b8", label: "Settings" };
    }
    if (normalized.includes("search")) {
      return { icon: "mdi:magnify", color: "#38bdf8", label: raw || "Search" };
    }
    if (normalized.includes("music")) {
      return { icon: "mdi:music", color: "#ff6b81", label: raw || "Music" };
    }
    if (normalized.includes("tv")) {
      return { icon: "mdi:television-play", color: isTv ? "#38bdf8" : "#94a3b8", label: raw || "TV" };
    }

    return {
      icon: isTv ? "mdi:television-classic" : (raw ? "mdi:radio" : "mdi:play-network-outline"),
      color: isTv ? "#38bdf8" : "#64748b",
      label: raw || (isTv ? "TV" : "Media"),
    };
  }

  getSourceIcon(source, isTv = false) {
    return this.getSourcePresentation(source, isTv).icon;
  }

  getSourceAccentColor(source, isTv = false) {
    return this.getSourcePresentation(source, isTv).color;
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
    if (item.can_expand) {
      if (!this.hasCompleteBrowseTarget(item) && (!Array.isArray(item.children) || !item.children.length)) {
        this._browseError = "This media folder cannot be opened because the speaker did not provide a complete media target.";
        this.render(true);
        return;
      }
      this.browseMedia(item);
    } else if (item.can_play) {
      if (!item.media_content_id || !item.media_content_type) {
        console.warn("Cannot play media: missing content ID or type", item);
        return;
      }
      const ags = this.getAgsPlayer();
      this.callService('media_player', 'play_media', { entity_id: ags.entity_id, media_content_id: item.media_content_id, media_content_type: item.media_content_type });
      this.setSection('player');
    }
  }

  renderSourceBadge(snapshot, variant = "full") {
    const label = snapshot?.sourceLabel || snapshot?.currentSource || (snapshot?.isTv ? "TV" : "Media");
    return `
      <button
        type="button"
        class="source-badge source-badge-${variant}"
        style="--badge-accent:${snapshot?.sourceColor || "var(--primary)"};"
        aria-label="Select source. Current source: ${this.escapeAttribute(label)}"
        title="${this.escapeAttribute(label)}"
        onclick="this.getRootNode().host.setSection('sources')"
      >
        <ha-icon icon="${snapshot?.sourceIcon || "mdi:music-note"}"></ha-icon>
        <span>${this.escapeHtml(label)}</span>
      </button>
    `;
  }

  renderRoomShortcut(snapshot) {
    const label = snapshot?.roomSummary || "System Idle";
    return `
      <button
        type="button"
        class="source-badge track-action-pill"
        aria-label="Open rooms and volume controls. Current rooms: ${this.escapeAttribute(label)}"
        title="${this.escapeAttribute(label)}"
        onclick="this.getRootNode().host.setSection('rooms')"
      >
        <span class="mode-badge" aria-hidden="true">
          <ha-icon icon="${snapshot?.isTv ? "mdi:television-play" : "mdi:music-note"}"></ha-icon>
        </span>
        <span>${this.escapeHtml(label)}</span>
      </button>
    `;
  }

  getMiniSectionShortcut(snapshot) {
    if (this._section === "sources") {
      return {
        icon: "mdi:folder-music",
        target: "browse",
        label: "Open browse media",
        title: "Browse media",
      };
    }
    if (this._section === "browse" || this._section === "rooms") {
      return {
        icon: snapshot?.sourceIcon || "mdi:playlist-play",
        target: "sources",
        label: `Open sources. Current source: ${snapshot?.sourceLabel || snapshot?.currentSource || "Media"}`,
        title: "Sources",
      };
    }
    return {
      icon: "mdi:volume-high",
      target: "rooms",
      label: "Open rooms",
      title: "Rooms",
    };
  }

  renderModeBadge(snapshot) {
    const icon = snapshot?.isTv ? "mdi:television-play" : "mdi:music-note";
    const label = snapshot?.isTv ? "TV mode" : "Music mode";
    return `
      <span class="mode-badge" aria-label="${label}" title="${label}">
        <ha-icon icon="${icon}"></ha-icon>
      </span>
    `;
  }

  renderArtworkFallback(snapshot, variant = "full") {
    const label = snapshot?.sourceLabel || snapshot?.currentSource || (snapshot?.isTv ? "TV" : "Media");
    const showText = !snapshot?.hasMedia;
    const isFocal = variant === "focal";
    return `
      <div class="fallback-art fallback-art-${variant} ${snapshot?.hasMedia ? "" : "fallback-art-missing"}">
        ${!isFocal ? '<div class="fallback-art-orb"></div>' : ""}
        <div class="fallback-art-glyph">
          <ha-icon icon="${snapshot?.sourceIcon || "mdi:music-note"}"></ha-icon>
        </div>
        ${showText ? `
          <div class="fallback-art-copy">
            <div class="fallback-art-title">${this.escapeHtml(label)}</div>
          </div>
        ` : ""}
      </div>
    `;
  }

  getPlayerSnapshot(ags, control) {
    const status = ags.attributes.ags_status || (ags.state === "off" ? "OFF" : "ON");
    const isTv = status === "ON TV";
    const isPlaying = ["playing", "buffering"].includes(control?.state || ags.state);
    const pic = this.getArtworkUrl(control, ags);
    const currentSource = this.getSelectedSourceName(ags);
    const sourcePresentation = this.getSourcePresentation(currentSource, isTv);
    const mediaTitle = control?.attributes?.media_title || "";
    const mediaArtist = control?.attributes?.media_artist || "";
    const mediaAlbum = control?.attributes?.media_album_name || "";
    const mediaType = control?.attributes?.media_content_type || "";
    const mediaSeries = control?.attributes?.media_series_title || "";
    const mediaSeason = control?.attributes?.media_season;
    const mediaEpisode = control?.attributes?.media_episode;
    const hasMedia = Boolean(mediaTitle || mediaArtist || pic);
    const title = mediaTitle || (currentSource && currentSource !== "Idle" ? currentSource : (isTv ? "Television Audio" : "Nothing Playing"));
    const activeRooms = this.toArray(ags.attributes.active_rooms);
    const mainRoom = ags.attributes.primary_speaker_room || (activeRooms.length > 0 ? activeRooms[0] : "");
    const roomSummary = activeRooms.length > 0
      ? `${mainRoom}${activeRooms.length > 1 ? ` + ${activeRooms.length - 1}` : ""}`
      : "System Idle";
    const seriesDetails = [
      mediaSeries,
      mediaSeason ? `Season ${mediaSeason}` : "",
      mediaEpisode ? `Episode ${mediaEpisode}` : "",
    ].filter(Boolean).join(" • ");
    const primaryMeta = [mediaArtist, mediaAlbum, seriesDetails]
      .map((value) => String(value || "").trim())
      .find(Boolean) || "";
    const subtitle = hasMedia
      ? (primaryMeta || roomSummary)
      : `${isTv ? "Open app" : "Select source"}${currentSource && currentSource !== "Idle" ? ` • ${currentSource}` : ""}`;
    const detailLines = [mediaAlbum, seriesDetails]
      .map((value) => String(value || "").trim())
      .filter((value, index, array) => value && value !== subtitle && array.indexOf(value) === index);
    const detailChips = [roomSummary, mediaType]
      .map((value) => String(value || "").trim())
      .filter((value, index, array) => value && value.toLowerCase() !== "idle" && array.findIndex((entry) => entry.toLowerCase() === value.toLowerCase()) === index);
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
      roomSummary,
      artistLine: mediaArtist || primaryMeta || roomSummary,
      currentSource,
      hasMedia,
      sourceIcon: sourcePresentation.icon,
      sourceColor: sourcePresentation.color,
      sourceLabel: sourcePresentation.label,
      detailLines,
      detailChips,
      duration,
      pos,
      prog,
    };
  }

  renderMiniPlayer(ags, snapshot, currentSrc, quickVolumeMenuId) {
    const isSystemOn = ags.state !== "off";
    const displayPos = this.getDisplayedPosition(snapshot);
    const displayProg = this.getDisplayedProgress(snapshot);
    const canSeek = snapshot.duration > 0;
    const miniShortcut = this.getMiniSectionShortcut(snapshot);
    return `
      <div class="mini-player mini-player-clickback ${this._transitionPreset === "collapse-player" ? "animate-up" : this._transitionPreset === "expand-player" ? "animate-down" : ""}">
        <div class="mini-player-main">
          <button
            type="button"
            class="mini-art-button"
            aria-label="Return to full player"
            onclick="this.getRootNode().host.setSection('player')"
          >
            <div class="mini-art ${snapshot.isTv && !snapshot.pic ? "tv-gradient" : ""} ${!snapshot.pic ? "mini-art-empty" : ""}" style="--fallback-accent:${snapshot.sourceColor};">
              ${snapshot.pic
                ? `<img class="mini-art-image" src="${snapshot.pic}" />`
                : this.renderArtworkFallback(snapshot, "mini")}
            </div>
          </button>
          <button
            type="button"
            class="mini-meta"
            aria-label="Return to full player"
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
                class="icon-btn source-toggle mini-source-btn ${miniShortcut.target === this._section ? "active" : ""}"
                aria-label="${this.escapeAttribute(miniShortcut.label)}"
                title="${this.escapeAttribute(miniShortcut.title)}"
                onclick="this.getRootNode().host.setSection('${miniShortcut.target}')"
              >
                <ha-icon icon="${miniShortcut.icon}"></ha-icon>
              </button>
            </div>
          </div>
        </div>
        <div class="seek-shell mini-progress-seam ${canSeek ? "is-seekable" : "is-static"}">
          <div class="progress-bar progress-bar-mini">
            <div class="progress-fill" style="width:${displayProg}%;"></div>
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
        <div class="mini-footer">
          <div class="time-meta mini-time-meta">
            <span class="time-current">${this.formatTime(displayPos)}</span>
            <span>${snapshot.duration > 0 ? this.formatTime(snapshot.duration) : ""}</span>
          </div>
        </div>
      </div>
    `;
  }

  renderPlayerSection(ags, control, quickVolumeMenuId) {
    if (ags.state === "off") {
      return `
        <div class="system-off-view">
          <div class="off-icon-wrap"><ha-icon icon="mdi:power-sleep"></ha-icon></div>
          <div class="off-copy">
            <div class="off-kicker">AGS standby</div>
            <div class="off-text">System is Offline</div>
            <div class="off-subtext">Power it on to restore your speaker group and controls.</div>
          </div>
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
      <div class="player-view ${this._transitionPreset === "expand-player" ? "animate-player-open" : this._transitionPreset === "collapse-player" ? "animate-player-close" : ""}" style="--fallback-accent:${snapshot.sourceColor};">
        <div class="player-art-background ${snapshot.isTv && !snapshot.pic ? 'tv-gradient' : ''} ${!snapshot.pic ? 'player-art-background-empty' : ''}">
          ${snapshot.pic ? `<img class="player-art-image" src="${snapshot.pic}" />` : ''}
          <div class="player-art-scrim"></div>
        </div>
        <div class="player-main">
          <div class="art-focal">
            <div class="art-stack">
              <div class="player-top-bar">
                <div class="track-source-row player-top-chips">
                  ${this.renderRoomShortcut(snapshot)}
                  ${this.renderSourceBadge(snapshot, "full")}
                </div>
              </div>
              ${!snapshot.pic ? this.renderArtworkFallback(snapshot, "focal") : ''}
              <div class="art-aura"></div>
            </div>
          </div>
        </div>
        <div class="player-bottom-panel">
          <div class="track-info">
            <div class="track-row">
              <div class="track-title">${this.escapeHtml(snapshot.title)}</div>
            </div>
            <div class="track-row">
              <div class="track-subtitle">${this.escapeHtml(snapshot.artistLine || snapshot.subtitle)}</div>
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
                  class="icon-btn source-toggle player-source-btn ${this._section === "rooms" ? "active" : ""}"
                  aria-label="Open rooms"
                  title="Rooms"
                  onclick="this.getRootNode().host.setSection('rooms')"
                >
                  <ha-icon icon="mdi:volume-high"></ha-icon>
                </button>
              </div>
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
        <div class="view-title">Rooms</div>
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
          ${rooms.map(r => {
            const spkId = r.devices?.find(d => d.device_type === "speaker")?.entity_id;
            const spkState = spkId ? this._hass.states[spkId] : null;
            const v = this.getDisplayedVolume(spkId || spkState);
            const muted = this.isMuted(spkState);
            const switchOn = this.getRoomDesiredState(
              r.switch_entity_id,
              (r.switch_state || "").toLowerCase() === "on",
            );
            const pending = this.isRoomTogglePending(r.switch_entity_id);
            const roomMeta = r.active
              ? "Included in group"
              : switchOn
                ? "On, waiting for AGS"
                : "Excluded from group";
            return `
              <div class="list-card volume-room-card">
                <div class="room-volume-top">
                  <div class="room-volume-copy">
                    <span class="room-volume-title">${this.escapeHtml(r.name)}</span>
                    <span class="room-volume-meta">${roomMeta}</span>
                  </div>
                  <button
                    type="button"
                    class="room-toggle-btn ${switchOn ? "on" : "off"} ${pending ? "pending" : ""}"
                    aria-pressed="${switchOn ? "true" : "false"}"
                    aria-label="${switchOn ? "Turn off" : "Turn on"} ${this.escapeHtml(r.name)}"
                    ${pending ? "disabled" : ""}
                    onclick="this.getRootNode().host.toggleRoom('${r.switch_entity_id}', ${((r.switch_state || "").toLowerCase() === "on") ? "true" : "false"})"
                  >
                    ${pending ? '<ha-circular-progress active indeterminate></ha-circular-progress>' : `<ha-icon icon="${switchOn ? "mdi:power-plug" : "mdi:power-plug-off"}"></ha-icon>`}
                    <span>${pending ? "Updating" : switchOn ? "On" : "Off"}</span>
                  </button>
                </div>
                <div class="room-volume-controls">
                  <input class="volume-slider room-volume-slider" type="range" min="0" max="100" value="${v}" ${!spkId ? 'disabled' : ''} aria-label="${this.escapeHtml(r.name)} volume" oninput="this.getRootNode().host.queueVolumeSet('${spkId}', this.value)" onchange="this.getRootNode().host.commitVolumeSet('${spkId}', this.value)" />
                  <div class="room-volume-actions">
                    <span class="room-volume-value" data-volume-id="${spkId || `room-${this.escapeHtml(r.name)}`}">${v}%</span>
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
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  renderSourcesSection(ags) {
    const currentSrc = this.getSelectedSourceName(ags);
    const sourceOptions = this.getSourceOptions(ags);
    return `
      <div class="sources-view">
        <div class="view-title">Sources</div>
        <div class="sources-list">
          ${sourceOptions.length
            ? sourceOptions.map((source) => {
              const selected = source === currentSrc;
              const sourcePresentation = this.getSourcePresentation(source, ags?.attributes?.ags_status === "ON TV");
              return `
                <button
                  type="button"
                  class="list-card source-page-item ${selected ? "selected" : ""}"
                  aria-pressed="${selected ? "true" : "false"}"
                  onclick="this.getRootNode().host.callService('media_player', 'select_source', {entity_id: '${ags.entity_id}', source: '${this.escapeJsString(source)}'})"
                >
                  <span class="source-menu-item-leading" style="--source-item-accent:${sourcePresentation.color};">
                    <ha-icon icon="${sourcePresentation.icon}"></ha-icon>
                  </span>
                  <span class="source-page-item-copy">
                    <span class="source-page-item-title">${this.escapeHtml(sourcePresentation.label || source)}</span>
                    <span class="source-page-item-meta">${selected ? "Current source" : "Tap to switch"}</span>
                  </span>
                  ${selected ? '<ha-icon class="source-menu-check" icon="mdi:check"></ha-icon>' : ""}
                </button>
              `;
            }).join("")
            : '<div class="list-card source-page-empty">No sources available</div>'}
        </div>
      </div>
    `;
  }

  render(force = false) {
    const existingBody = this.shadowRoot?.querySelector(".section-body");
    if (existingBody) {
      this._sectionScrollTop = existingBody.scrollTop;
    }
    const outerScrollState = this.captureOuterScrollState();
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
    const sourceMenuId = "ags-source-menu";
    const quickVolumeMenuId = "ags-quick-volume-menu";
    const snapshot = this.getPlayerSnapshot(ags, control);
    const theme = this.getThemePalette(pic, snapshot.sourceColor);
    const isPlayerSection = this._section === "player";
    const isSystemOff = ags.state === "off";
    const cardClass = this._section === "browse" ? "card-browse" : isPlayerSection ? "card-player" : "";
    const sectionBodyClass = isSystemOff
      ? "section-body section-player system-off-shell"
      : this._section === "player"
        ? "section-body section-player"
        : "section-body";
    const surfaceClass = isSystemOff ? "surface system-off-surface" : isPlayerSection ? "surface surface-player" : "surface";

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          min-width: 0;
          color-scheme: ${theme.colorScheme};
          --ags-card-stable-vh: 100vh;
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
          --source-accent-soft: ${theme.sourceAccentSoft};
          --player-fade-mid: ${theme.playerFadeMid};
          --player-fade-base: ${theme.playerFadeBase};
          --player-ink: ${theme.playerInk};
          --player-muted: ${theme.playerMuted};
          --player-line: ${theme.playerLine};
          --player-chip-bg: ${theme.playerChipBg};
          --player-chip-bg-strong: ${theme.playerChipBgStrong};
          --player-panel-bg: ${theme.playerPanelBg};
          --player-panel-bg-strong: ${theme.playerPanelBgStrong};
          --player-panel-border: ${theme.playerPanelBorder};
          --section-surface: linear-gradient(180deg, var(--backdrop-overlay) 0%, var(--card-bg-strong) 78%);
          --section-overlay: ${theme.sectionOverlay};
          --focus-ring: 0 0 0 3px var(--primary-soft);
          -webkit-tap-highlight-color: transparent;
          touch-action: manipulation;
        }
        @supports (height: 100svh) {
          :host {
            --ags-card-stable-vh: 100svh;
          }
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
        
        ha-card { position: relative; overflow: hidden; border-radius: 28px; background: linear-gradient(180deg, var(--art-tint), transparent 24%), linear-gradient(180deg, var(--primary-soft), transparent 38%), var(--card-bg-strong); color: var(--text); max-width: var(--ags-card-max-width, 420px); width: 100%; margin: 0 auto; height: min(382px, max(272px, calc(var(--ags-card-stable-vh) - var(--ags-card-viewport-offset, 338px)))); min-height: min(272px, calc(var(--ags-card-stable-vh) - 124px)); max-height: calc(var(--ags-card-stable-vh) - 130px); display: flex; flex-direction: column; border: 1px solid var(--outline); box-shadow: var(--ha-card-box-shadow, var(--shadow)); transition: background 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease; }
        .surface { position: relative; z-index: 1; display: flex; flex-direction: column; height: 100%; overflow: visible; background: linear-gradient(180deg, var(--glass) 0%, var(--backdrop-overlay) 34%, var(--card-bg-strong) 82%); backdrop-filter: blur(24px) saturate(1.08); }
        .surface-player { background: transparent; backdrop-filter: none; }
        .card-header { position: relative; z-index: 6; overflow: visible; padding: 16px 20px 14px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; border-bottom: 1px solid var(--divider); background: linear-gradient(180deg, var(--glass-heavy), rgba(0, 0, 0, 0)); backdrop-filter: blur(22px) saturate(1.1); }
        .header-picker-wrap { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; position: relative; overflow: visible; z-index: 7; }
        .header-meta-row { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; width: 100%; min-width: 0; position: relative; z-index: 8; }
        .header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .section-body { flex: 1; min-height: 0; padding: 8px 18px calc(18px + env(safe-area-inset-bottom, 0px)); overflow-y: auto; scrollbar-width: none; scroll-behavior: auto; position: relative; z-index: 1; -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain; touch-action: pan-y; background: var(--section-surface); }
        .section-body::-webkit-scrollbar { display: none; }
        .section-player { overflow: hidden; padding: 0; display: flex; min-width: 0; }
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
          transform: none;
        }
        .hero-pill.subtle { background: var(--glass); color: var(--text-sec); border-color: var(--outline); }
        .transition-shell { position: relative; overflow: hidden; min-height: 0; width: 100%; flex: 1 1 auto; will-change: transform, opacity; }
        .transition-shell.slide-forward { animation: page-slide-in-left 0.22s cubic-bezier(0.22, 1, 0.36, 1); }
        .transition-shell.slide-back { animation: page-slide-in-right 0.22s cubic-bezier(0.22, 1, 0.36, 1); }
        .player-view { position: relative; width: 100%; height: 100%; display: grid; grid-template-rows: minmax(150px, 1fr) auto; gap: 0; align-items: stretch; will-change: transform, opacity; transform-origin: center top; overflow: hidden; border-radius: 0; background: var(--player-fade-base); }
        .player-view.animate-player-open { animation: player-drop-open 0.26s cubic-bezier(0.22, 1, 0.36, 1); }
        .player-view.animate-player-close { animation: player-lift-close 0.22s cubic-bezier(0.22, 1, 0.36, 1); }
        .player-art-background {
          position: absolute;
          inset: 0;
          z-index: 0;
          overflow: hidden;
          background: var(--player-fade-base);
        }
        .player-art-background .fallback-art {
          position: absolute;
          inset: 0;
          z-index: 0;
        }
        .player-art-background-empty {
          background:
            radial-gradient(circle at 26% 22%, rgba(255, 255, 255, 0.18), transparent 38%),
            linear-gradient(160deg, var(--fallback-accent, var(--primary)), rgba(15, 23, 42, 0.92));
        }
        .fallback-art-focal {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          z-index: 2;
          color: #fff;
          text-align: center;
          background: none;
          width: auto;
          height: auto;
          padding: 0;
        }
        .fallback-art-focal .fallback-art-glyph {
          width: 88px;
          height: 88px;
          border-radius: 28px;
          background: rgba(255, 255, 255, 0.18);
          border: 1px solid rgba(255, 255, 255, 0.28);
          box-shadow: 0 16px 40px rgba(15, 23, 42, 0.32);
          backdrop-filter: blur(16px);
        }
        .fallback-art-focal .fallback-art-glyph ha-icon { --mdc-icon-size: 52px; }
        .fallback-art-focal .fallback-art-copy { color: rgba(255, 255, 255, 0.88); }
        .fallback-art-focal .fallback-art-title { font-size: 0.88rem; font-weight: 800; letter-spacing: 0.04em; text-shadow: 0 1px 4px rgba(15, 23, 42, 0.5); }
        .player-art-image {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center 28%;
          transform: scale(1.02);
          transform-origin: center center;
          z-index: 0;
          opacity: 1;
          filter: none;
        }
        .player-art-scrim {
          position: absolute;
          inset: 0;
          z-index: 1;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0) 64%, rgba(15, 23, 42, 0.04) 78%, rgba(15, 23, 42, 0.12) 100%);
        }
        .player-main { position: relative; z-index: 1; min-height: clamp(164px, 25vh, 228px); display: block; }
        .art-focal { display: block; width: 100%; height: 100%; min-height: inherit; margin-bottom: 0; }
        .art-stack {
          position: relative;
          width: 100%;
          height: 100%;
          min-height: inherit;
          display: flex;
          align-items: stretch;
        }
        .player-top-bar {
          position: absolute;
          top: 12px;
          left: 14px;
          right: 14px;
          z-index: 3;
          display: flex;
          justify-content: flex-start;
          pointer-events: none;
        }
        .player-top-chips {
          pointer-events: auto;
        }
        .art-aura { position: absolute; inset: auto -6% -10% -6%; height: 24%; background: radial-gradient(circle at center, var(--art-glow), transparent 74%); opacity: 0.45; pointer-events: none; z-index: 1; }
        .player-bottom-panel {
          position: relative;
          z-index: 3;
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 5px;
          margin-top: -28px;
          padding: 10px 14px 10px;
          background: linear-gradient(180deg, var(--player-panel-bg) 0%, var(--player-panel-bg-strong) 100%);
          border-radius: 24px 24px 0 0;
          box-shadow: 0 -18px 36px rgba(15, 23, 42, 0.1);
          backdrop-filter: blur(20px) saturate(1.08);
          -webkit-backdrop-filter: blur(20px) saturate(1.08);
          border-top: 1px solid var(--player-panel-border);
        }
        .tv-gradient { background: linear-gradient(135deg, #1a237e, #4a148c); display: flex; align-items: center; justify-content: center; }
        .main-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center top; z-index: 0; }
        .fallback-art {
          position: relative;
          z-index: 1;
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 10px;
          padding: 14px;
          color: #fff;
          text-align: center;
          overflow: hidden;
          background:
            radial-gradient(circle at 24% 18%, rgba(255, 255, 255, 0.28), transparent 34%),
            linear-gradient(180deg, rgba(15, 23, 42, 0.08), rgba(15, 23, 42, 0.56)),
            linear-gradient(160deg, var(--fallback-accent, var(--primary)), rgba(15, 23, 42, 0.94));
        }
        .fallback-art-missing {
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16);
        }
        .fallback-art-mini {
          padding: 10px 8px 8px;
          gap: 6px;
        }
        .fallback-art-orb {
          position: absolute;
          width: 68%;
          aspect-ratio: 1 / 1;
          top: -18%;
          right: -18%;
          border-radius: 999px;
          background: radial-gradient(circle, rgba(255, 255, 255, 0.26), transparent 66%);
          pointer-events: none;
        }
        .fallback-art-glyph {
          color: #fff;
          opacity: 1;
        }
        .fallback-art-glyph {
          position: relative;
          width: 56px;
          height: 56px;
          border-radius: 18px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: rgba(255, 255, 255, 0.14);
          border: 1px solid rgba(255, 255, 255, 0.18);
          box-shadow: 0 10px 24px rgba(15, 23, 42, 0.22);
          backdrop-filter: blur(12px);
        }
        .fallback-art-full .fallback-art-glyph ha-icon { --mdc-icon-size: 34px; }
        .fallback-art-mini .fallback-art-glyph {
          width: 34px;
          height: 34px;
          border-radius: 12px;
        }
        .fallback-art-mini .fallback-art-glyph ha-icon { --mdc-icon-size: 20px; }
        .fallback-art-copy {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0;
          min-width: 0;
        }
        .fallback-art-title {
          font-size: 0.95rem;
          font-weight: 900;
          line-height: 1.1;
          color: #fff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .fallback-art-mini .fallback-art-title {
          max-width: 100%;
          font-size: 0.66rem;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .source-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          width: auto;
          min-width: 0;
          max-width: min(100%, 220px);
          flex: 0 1 auto;
          min-height: 32px;
          padding: 4px 8px;
          border-radius: 999px;
          font-size: 0.59rem;
          font-weight: 900;
          letter-spacing: 0.035em;
          text-transform: uppercase;
          background: linear-gradient(180deg, var(--primary-soft), var(--player-chip-bg-strong));
          color: var(--player-ink);
          border: 1px solid var(--primary-strong);
          backdrop-filter: blur(10px);
          box-shadow: 0 10px 24px rgba(15, 23, 42, 0.16);
          cursor: pointer;
        }
        .source-badge ha-icon { --mdc-icon-size: 14px; flex-shrink: 0; color: var(--badge-accent, var(--player-ink)); }
        .source-badge span {
          min-width: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .source-badge-full {
          background: linear-gradient(180deg, var(--primary-soft), var(--player-chip-bg-strong));
          color: var(--player-ink);
          border-color: var(--primary-strong);
        }
        .mode-badge { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; flex: 0 0 20px; color: var(--player-ink); line-height: 1; }
        .mode-badge ha-icon { --mdc-icon-size: 18px; display: block; }
        .track-action-pill {
          min-height: 32px;
          padding-inline: 8px;
          background: linear-gradient(180deg, var(--primary-soft), var(--player-chip-bg-strong));
          border-color: var(--primary-strong);
          box-shadow: 0 10px 24px rgba(15, 23, 42, 0.16);
        }
        .track-action-pill:hover { transform: none; }
        .track-action-pill:focus-visible {
          outline: none;
          box-shadow: var(--control-shadow), var(--focus-ring);
        }
        .track-action-pill ha-icon { --mdc-icon-size: 16px; }
        .track-info {
          position: relative;
          z-index: 3;
          isolation: isolate;
          width: 100%;
          min-width: 0;
          text-align: left;
          margin: 0;
          min-height: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          justify-content: flex-start;
          gap: 3px;
        }
        .track-row { min-width: 0; display: flex; align-items: center; }
        .track-row-actions { margin-top: 2px; }
        .track-room-line { min-width: 0; display: flex; align-items: center; gap: 8px; }
        .track-room-label { min-width: 0; font-size: 0.82rem; font-weight: 900; letter-spacing: 0.04em; text-transform: uppercase; color: var(--player-ink); line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .track-source-row { min-width: 0; width: 100%; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-start; gap: 8px; }
        .status-display { text-transform: uppercase; }
        .track-title { font-size: clamp(1.08rem, 2.1vw, 1.42rem); font-weight: 900; letter-spacing: -0.04em; margin: 0; color: var(--player-ink); line-height: 1.02; min-height: 1.02em; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; max-width: 100%; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.22); }
        .track-subtitle { font-size: 0.88rem; color: var(--player-ink); opacity: 0.92; font-weight: 800; margin: 0; line-height: 1.18; min-height: 1.18em; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; max-width: 100%; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.16); }
        .track-detail-stack {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
        }
        .track-detail-line {
          font-size: 0.78rem;
          line-height: 1.25;
          color: var(--text-sec);
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .track-chip-row { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 2px; }
        .track-chip {
          display: inline-flex;
          align-items: center;
          min-height: 28px;
          padding: 0 10px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.08);
          color: var(--text);
          font-size: 0.7rem;
          font-weight: 800;
          letter-spacing: 0.03em;
          text-transform: uppercase;
        }
        .playback-controls { position: relative; z-index: 2; width: 100%; align-self: stretch; display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; padding: 0; background: transparent; border-radius: 0; border: none; backdrop-filter: none; }
        .playback-controls::before { display: none; }
        .progress-shell { position: relative; padding: 1px 2px 0; }
        .seek-shell { position: relative; }
        .seek-shell.is-seekable { cursor: pointer; }
        .progress-bar { height: 7px; background: linear-gradient(90deg, var(--player-line), var(--scrubber)); border-radius: 999px; overflow: hidden; position: relative; }
        .progress-bar-hero { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12); }
        .progress-bar-mini { border-radius: 999px; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, var(--primary), var(--primary-halo)); transition: width 0.12s linear; border-radius: inherit; }
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
        .time-meta { display: flex; justify-content: space-between; font-size: 0.58rem; margin-top: 1px; color: var(--player-muted); font-weight: 800; }
        .buttons-row { display: flex; justify-content: center; align-items: center; gap: 10px; margin: 6px 0 0; }
        .buttons-row-full { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); align-items: stretch; gap: 10px; width: 100%; }
        .buttons-row-full > .power-icon-btn { width: 100%; min-width: 0; height: 48px; min-height: 48px; border-radius: 16px; }
        .buttons-row-full .source-anchor-full { width: 100%; justify-self: stretch; }
        .buttons-row-full .source-toggle { width: 100%; height: 48px; min-height: 48px; border-radius: 16px; }
        .transport-cluster { display: contents; }
        .play-btn { width: 56px; height: 56px; border-radius: 18px; background: var(--primary); color: var(--on-primary); border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: var(--control-shadow); }
        .play-btn ha-icon { --mdc-icon-size: 24px; }
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
          transition: border-color 0.14s ease-out, background 0.14s ease-out, color 0.14s ease-out, box-shadow 0.14s ease-out;
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
          transform: none;
        }
        .transport-btn {
          width: 48px;
          height: 48px;
          border-radius: 16px;
          box-shadow: var(--control-shadow);
        }
        .buttons-row-full .transport-btn,
        .transport-cluster .play-btn {
          width: 100%;
          max-width: 100%;
        }
        .buttons-row-full .transport-btn,
        .buttons-row-full .play-btn {
          height: 48px;
          min-height: 48px;
          min-width: 0;
          border-radius: 16px;
        }
        .buttons-row-full .transport-btn,
        .buttons-row-full > .power-icon-btn {
          background: var(--player-chip-bg-strong);
          color: var(--player-ink);
          border-color: var(--player-line);
        }
        .icon-btn { padding: 10px; border-radius: 14px; }
        .settings-btn { width: 44px; height: 44px; flex: 0 0 44px; }
        .view-title { font-size: 1.1rem; font-weight: 900; margin-bottom: 12px; color: var(--primary); text-transform: uppercase; letter-spacing: 0.05em; }
        .vol-label-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-weight: 800; }
        .volume-inline { display: flex; align-items: center; gap: 8px; }
        .control-eyebrow { color: var(--text-sec); font-size: 0.74rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
        .volume-card-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 8px; }
        .volume-head-actions { display: inline-flex; align-items: center; gap: 10px; }
        .volume-chip { padding: 6px 9px; border-radius: 999px; border: 1px solid var(--outline); background: var(--glass-heavy); color: var(--text-sec); font-size: 0.66rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; }
        .volume-figure { margin-top: 2px; font-size: 1.38rem; font-weight: 900; line-height: 1; color: var(--text); }
        .room-levels-stack { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
        .volume-room-card { margin-bottom: 0; padding: 10px 12px; }
        .room-volume-head { margin-bottom: 10px; font-size: 0.92rem; }
        .room-volume-top {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 7px;
          align-items: center;
          margin-bottom: 8px;
        }
        .room-volume-copy {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 1px;
        }
        .room-volume-title {
          font-size: 0.86rem;
          font-weight: 800;
          color: var(--text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .room-volume-meta {
          font-size: 0.6rem;
          color: var(--text-sec);
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .room-volume-controls {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 6px;
          align-items: center;
        }
        .room-volume-slider {
          width: 100%;
        }
        .room-volume-actions {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          flex-shrink: 0;
        }
        .room-volume-value {
          min-width: 34px;
          text-align: right;
          font-size: 0.72rem;
          font-weight: 800;
          color: var(--text);
        }
        .slider-shell { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; }
        .slider-shell-master { gap: 12px; }
        .slider-icon-btn { width: 30px; height: 30px; border-radius: 10px; box-shadow: var(--control-shadow); }
        .slider-icon-btn-master { background: var(--card-bg-soft); }
        .mute-btn.active { background: var(--primary); color: var(--on-primary); border-color: transparent; }
        .slider-icon-btn[disabled] { opacity: 0.45; cursor: not-allowed; transform: none; }
        input[type=range] { flex: 1; accent-color: var(--primary); height: 8px; cursor: pointer; background: transparent; }
        input[type=range]::-webkit-slider-runnable-track { height: 8px; border-radius: 999px; background: var(--scrubber); }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 20px; height: 20px; margin-top: -6px; border-radius: 50%; border: 3px solid var(--card-bg-strong); background: var(--primary); box-shadow: var(--control-shadow); }
        input[type=range]::-moz-range-track { height: 8px; border-radius: 999px; background: var(--scrubber); }
        input[type=range]::-moz-range-thumb { width: 20px; height: 20px; border-radius: 50%; border: 3px solid var(--card-bg-strong); background: var(--primary); box-shadow: var(--control-shadow); }
        .browse-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; }
        .browse-item { display: flex; flex-direction: column; gap: 8px; padding: 12px; margin-bottom: 0; cursor: pointer; border-radius: 18px; touch-action: pan-y; }
        .browse-item:hover { background: var(--glass-heavy); }
        .action-card { width: 100%; text-align: left; }
        .browse-art { position: relative; aspect-ratio: 1.55 / 1; border-radius: 18px; overflow: hidden; border: 1px solid var(--outline); background: linear-gradient(160deg, var(--primary-soft), var(--subdued)); display:flex; align-items:center; justify-content:center; }
        .browse-art img { width: 100%; height: 100%; object-fit: cover; }
        .browse-art-fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text); }
        .browse-art:not(.no-image):not(.image-failed) .browse-art-fallback { display: none; }
        .browse-label { font-weight: 800; font-size: 0.9rem; line-height: 1.18; min-height: 2.1em; color: var(--text); }
        .browse-meta { font-size: 0.74rem; color: var(--text-sec); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
        .browse-item:disabled { cursor: default; opacity: 0.74; }
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
        .mini-player-clickback { cursor: pointer; }
        .mini-player {
          position: relative;
          z-index: 5;
          padding: 0;
          display: grid;
          grid-template-rows: auto 5px auto;
          border-bottom: none;
          overflow: hidden;
          background: transparent;
          backdrop-filter: blur(18px) saturate(1.08);
          will-change: transform, opacity;
          transform-origin: center top;
        }
        .mini-player.animate-up { animation: mini-player-rise 0.28s cubic-bezier(0.22, 1, 0.36, 1); }
        .mini-player.animate-down { animation: mini-player-drop 0.32s cubic-bezier(0.22, 1, 0.36, 1); }
        .mini-player-main {
          position: relative;
          z-index: 1;
          min-height: 92px;
          display: grid;
          grid-template-columns: 84px minmax(0, 1fr) auto;
          gap: 0;
          align-items: stretch;
          background: linear-gradient(180deg, var(--source-accent-soft), var(--glass-heavy) 44%);
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
        .mini-progress-seam {
          position: relative;
          z-index: 2;
          width: 100%;
          height: 5px;
          background: var(--section-overlay);
          backdrop-filter: blur(8px) saturate(1.01);
        }
        .mini-footer {
          position: relative;
          z-index: 1;
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 6px 12px 8px;
          background: var(--section-overlay);
          backdrop-filter: blur(8px) saturate(1.01);
        }
        .mini-progress-seam .progress-bar {
          height: 5px;
          border-radius: 0;
          background: var(--scrubber);
          box-shadow: none;
        }
        .mini-progress-seam .progress-fill { background: linear-gradient(90deg, rgba(255, 255, 255, 0.98), var(--primary)); box-shadow: 0 0 10px var(--primary-halo); }
        .mini-progress-seam .seek-slider-mini {
          inset: -8px 0;
          width: 100%;
          height: calc(100% + 16px);
          min-height: 18px;
          transform: none;
        }
        .mini-time-meta {
          margin: 0;
          padding: 0;
          font-size: 0.68rem;
          line-height: 1.1;
        }
        .loading-spin { text-align: center; padding: 40px; }
        .browse-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 40px 20px; color: var(--text-sec); font-size: 0.9rem; font-weight: 600; text-align: center; }
        .browse-empty ha-icon { --mdc-icon-size: 40px; opacity: 0.4; }
        .system-off-view { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: clamp(14px, 2.6vh, 20px); width: 100%; max-width: 100%; padding: clamp(18px, 4vw, 28px); text-align: center; }
        .system-off-surface {
          justify-content: center;
          background: linear-gradient(180deg, var(--glass-heavy), var(--card-bg-strong));
        }
        .system-off-shell {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: clamp(16px, 3vw, 24px);
        }
        .off-icon-wrap { width: clamp(72px, 19vw, 88px); height: clamp(72px, 19vw, 88px); border-radius: 50%; background: var(--glass-heavy); display: flex; align-items: center; justify-content: center; color: var(--text-sec); opacity: 0.56; border: 1px solid var(--outline); }
        .off-icon-wrap ha-icon { --mdc-icon-size: clamp(32px, 8vw, 40px); }
        .off-copy { display: grid; gap: 8px; width: min(100%, 280px); }
        .off-kicker { font-size: 0.72rem; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; color: var(--primary); }
        .off-text { font-size: clamp(1rem, 2.5vw, 1.18rem); font-weight: 900; color: var(--text); line-height: 1.08; }
        .off-subtext { font-size: 0.85rem; line-height: 1.4; color: var(--text-sec); }
        .turn-on-btn { width: auto; max-width: 100%; min-height: 46px; height: auto; padding: 12px 24px; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center; gap: 10px; font-weight: 800; background: var(--primary); color: var(--on-primary); }
        .source-menu { position: absolute; inset: 0; z-index: 60; display: flex; align-items: stretch; justify-content: stretch; padding: 12px; }
        .source-menu-backdrop { position: absolute; inset: 0; border: none; background: rgba(2, 6, 23, 0.48); cursor: pointer; }
        .source-sheet { position: relative; z-index: 1; width: 100%; height: 100%; max-height: none; display: flex; flex-direction: column; border-radius: 22px; border: 1px solid var(--primary-strong); background: linear-gradient(180deg, var(--glass-heavy), var(--card-bg-strong)); box-shadow: var(--shadow); overflow: hidden; backdrop-filter: blur(20px) saturate(1.08); }
        .quick-volume-menu { position: absolute; inset: 0; z-index: 61; display: flex; align-items: stretch; justify-content: stretch; padding: 12px; }
        .quick-volume-sheet {
          position: relative;
          z-index: 1;
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          border-radius: 22px;
          border: 1px solid var(--primary-strong);
          background: linear-gradient(180deg, var(--glass-heavy), var(--card-bg-strong));
          box-shadow: var(--shadow);
          overflow: hidden;
          backdrop-filter: blur(20px) saturate(1.08);
        }
        .source-menu-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 14px 12px; color: var(--text-sec); font-size: 0.7rem; font-weight: 900; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--divider); }
        .source-menu-title-wrap { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
        .source-menu-current { min-width: 0; color: var(--text); font-size: 0.92rem; letter-spacing: 0; text-transform: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .source-sheet-close { width: 42px; height: 42px; flex: 0 0 42px; }
        .source-sheet-list { display: flex; flex-direction: column; gap: 4px; padding: 8px; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; scroll-behavior: smooth; }
        .source-menu-item { width: 100%; text-align: left; padding: 12px 14px; border-radius: 14px; cursor: pointer; font-weight: 700; font-size: 0.9rem; transition: 0.2s; border: 1px solid transparent; justify-content: flex-start; gap: 12px; }
        .source-menu-item:hover { background: var(--primary-soft); color: var(--text); }
        .source-menu-item.selected { background: var(--primary-soft); border-color: var(--primary-strong); }
        .source-menu-item-leading { width: 34px; height: 34px; flex: 0 0 34px; display: inline-flex; align-items: center; justify-content: center; border-radius: 12px; background: var(--source-accent-soft); color: var(--source-item-accent, var(--primary)); }
        .source-menu-item-leading ha-icon { --mdc-icon-size: 18px; }
        .source-menu-item-label { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .source-menu-check { --mdc-icon-size: 18px; flex-shrink: 0; color: var(--primary); }
        .source-menu-empty { padding: 14px 16px; color: var(--text-sec); font-size: 0.85rem; font-weight: 700; }
        .sources-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .source-page-item {
          width: 100%;
          padding: 14px 16px;
          display: grid;
          grid-template-columns: 34px minmax(0, 1fr) auto;
          align-items: center;
          gap: 12px;
          text-align: left;
          cursor: pointer;
          touch-action: pan-y;
        }
        .source-page-item.selected {
          background: linear-gradient(180deg, var(--primary-soft), var(--glass));
          border-color: var(--primary-strong);
        }
        .source-page-item-copy {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .source-page-item-title {
          font-size: 0.96rem;
          font-weight: 800;
          color: var(--text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .source-page-item-meta,
        .source-page-empty {
          font-size: 0.76rem;
          color: var(--text-sec);
          font-weight: 700;
        }
        .source-page-empty {
          padding: 16px;
          border-radius: 18px;
        }
        .quick-volume-body {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 20px;
          padding: 24px 20px;
        }
        .quick-volume-readout {
          display: flex;
          flex-direction: column;
          gap: 8px;
          align-items: flex-start;
        }
        .quick-volume-value {
          font-size: clamp(2.2rem, 10vw, 3.6rem);
          line-height: 0.95;
          font-weight: 900;
          letter-spacing: -0.04em;
          color: var(--text);
        }
        .quick-volume-subtitle {
          font-size: 0.86rem;
          font-weight: 700;
          color: var(--text-sec);
        }
        .quick-volume-slider-row {
          display: grid;
          grid-template-columns: 44px minmax(0, 1fr) 44px;
          gap: 10px;
          align-items: center;
          padding: 14px;
          border-radius: 18px;
          border: 1px solid var(--outline);
          background: linear-gradient(180deg, var(--glass-heavy), var(--glass));
        }
        .quick-volume-slider {
          width: 100%;
        }
        .quick-volume-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }
        .quick-volume-action {
          min-height: 48px;
          padding: 0 16px;
          border-radius: 16px;
          border: 1px solid var(--outline);
          background: var(--glass);
          color: var(--text);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          font-weight: 800;
          box-shadow: var(--control-shadow);
          transition: transform 0.16s ease-out, background 0.16s ease-out, border-color 0.16s ease-out, color 0.16s ease-out;
        }
        .quick-volume-action:hover {
          transform: translateY(-1px);
          background: var(--primary-soft);
          border-color: var(--primary-strong);
        }
        .quick-volume-action.active {
          background: var(--primary-soft);
          border-color: var(--primary-strong);
        }
        .quick-volume-full {
          background: var(--primary);
          color: var(--on-primary);
          border-color: transparent;
        }
        .quick-volume-full:hover {
          background: var(--primary);
          color: var(--on-primary);
        }
        .rooms-view { display: flex; flex-direction: column; gap: 10px; }
        .room-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 14px 16px; margin-bottom: 0; }
        .room-copy { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
        .room-title { font-weight: 800; font-size: 1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .room-meta { font-size: 0.76rem; color: var(--text-sec); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
        .room-toggle-btn { min-width: 64px; min-height: 30px; padding: 5px 8px; border-radius: 10px; justify-content: center; gap: 4px; font-weight: 800; font-size: 0.66rem; box-shadow: var(--control-shadow); }
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
          ha-card { max-width: 100%; height: min(358px, max(258px, calc(var(--ags-card-stable-vh) - var(--ags-card-viewport-offset, 170px)))); min-height: min(258px, calc(var(--ags-card-stable-vh) - 80px)); }
          .card-header { padding: 14px 14px 12px; }
          .section-body { padding: 8px 14px calc(16px + env(safe-area-inset-bottom, 0px)); }
          .section-player { padding: 0; }
          .player-view { border-radius: 0; }
          .player-art-image { height: 100%; object-position: center 24%; }
          .player-main { min-height: clamp(150px, 23vh, 200px); }
          .player-top-bar { top: 10px; left: 12px; right: 12px; }
          .player-bottom-panel { margin-top: -22px; padding: 9px 12px 10px; border-radius: 22px 22px 0 0; }
          .art-stack { min-height: inherit; }
          .buttons-row { gap: 7px; }
          .buttons-row-full { grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 7px; }
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
          .play-btn { width: 50px; height: 50px; }
          .player-view { border-radius: 0; }
          .player-art-image { height: 100%; object-position: center 22%; }
          .player-main { min-height: 142px; }
          .player-top-bar { top: 9px; left: 10px; right: 10px; }
          .player-bottom-panel { margin-top: -20px; padding: 8px 10px 9px; border-radius: 20px 20px 0 0; }
          .art-stack { min-height: inherit; }
          .track-info { align-items: stretch; text-align: left; }
          .track-source-row { gap: 6px; }
          .source-badge { min-height: 30px; max-width: min(100%, 180px); padding: 4px 7px; font-size: 0.56rem; }
          .source-badge ha-icon { --mdc-icon-size: 13px; }
          .track-action-pill { min-height: 30px; padding-inline: 7px; }
          .track-chip-row { justify-content: flex-start; }
          .buttons-row-full { grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; }
          .buttons-row-full .transport-btn,
          .buttons-row-full .play-btn,
          .buttons-row-full .source-toggle,
          .buttons-row-full > .power-icon-btn { height: 44px; min-height: 44px; border-radius: 14px; }
          .mini-player-main { min-height: 84px; grid-template-columns: 76px minmax(0, 1fr) auto; }
          .mini-meta { padding: 12px 10px 12px 12px; }
          .mini-actions { padding-right: 12px; gap: 6px; }
          .source-menu { padding: 8px; }
          .source-sheet { border-radius: 18px; }
          .quick-volume-menu { padding: 8px; }
          .quick-volume-sheet { border-radius: 18px; }
          .quick-volume-body { padding: 20px 16px; }
          .quick-volume-slider-row { grid-template-columns: 40px minmax(0, 1fr) 40px; gap: 8px; padding: 12px; }
          .slider-shell,
          .slider-shell-master { grid-template-columns: 36px minmax(0, 1fr) 36px; gap: 8px; }
          .slider-icon-btn { width: 36px; height: 36px; }
          .section-body { padding: 8px 12px calc(16px + env(safe-area-inset-bottom, 0px)); }
          .room-row { grid-template-columns: 1fr; }
          .room-volume-top { grid-template-columns: 1fr; }
          .room-toggle-btn { width: 100%; }
          .system-off-shell { padding: 14px; }
          .system-off-view { padding: 14px; }
          .off-copy { width: min(100%, 240px); }
          .turn-on-btn { width: 100%; }
        }
        @media (hover: none), (pointer: coarse) {
          .hero-pill.clickable:hover,
          .browse-item:hover,
          .source-menu-item:hover,
          .quick-volume-action:hover,
          .transport-btn:hover,
          .icon-btn:hover,
          .slider-icon-btn:hover,
          .footer-btn:hover,
          .room-toggle-btn:hover,
          .play-btn:hover,
          .power-toggle:hover,
          .action-card:hover {
            transform: none;
            background: inherit;
            color: inherit;
            border-color: inherit;
          }
          .transition-shell.slide-forward,
          .transition-shell.slide-back {
            animation-duration: 0.24s;
          }
          .player-view.animate-player-open,
          .player-view.animate-player-close,
          .mini-player.animate-up,
          .mini-player.animate-down {
            animation-duration: 0.28s;
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
      <ha-card class="${cardClass}">
        <div class="backdrop"></div>
        <div class="${surfaceClass}">
          ${!isSystemOff && !isPlayerSection ? this.renderMiniPlayer(ags, snapshot, currentSrc, quickVolumeMenuId) : ""}
          <div class="${sectionBodyClass}">
            <div class="transition-shell ${!isSystemOff && !isPlayerSection ? this._transitionPreset : ""}">
              ${isSystemOff
                ? this.renderPlayerSection(ags, control, quickVolumeMenuId)
                : this._section === "sources" ? this.renderSourcesSection(ags) :
                  this._section === "browse" ? this.renderBrowse() :
                  this._section === "rooms" || this._section === "volumes" ? this.renderVolumesSection(ags) :
                  this.renderPlayerSection(ags, control, quickVolumeMenuId)}
            </div>
          </div>
        </div>
      </ha-card>
    `;

    const restoreScrollTop = this._section === "player" ? 0 : this._sectionScrollTop;
    requestAnimationFrame(() => {
      this.restoreOuterScrollState(outerScrollState);
      const body = this.shadowRoot?.querySelector(".section-body");
      if (body && typeof restoreScrollTop === "number") {
        body.scrollTop = restoreScrollTop;
      }
      this.syncLiveProgressUi();
      requestAnimationFrame(() => this.restoreOuterScrollState(outerScrollState));
    });
  }

  renderRooms(ags) {
    return this.renderVolumesSection(ags);
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
        <button
          type="button"
          class="list-card browse-item action-card"
          aria-label="${this.escapeAttribute(i.can_expand ? `Open ${i.title}` : i.can_play ? `Play ${i.title}` : `View ${i.title}`)}"
          onclick="this.getRootNode().host._handleBrowseClick(${idx})"
          ${!i.can_expand && !i.can_play ? "disabled" : ""}
        >
          ${this.renderBrowseArtwork(i)}
          <div class="browse-label">${this.escapeHtml(i.title)}</div>
          <div class="browse-meta">${this.escapeHtml(this.getBrowseItemMeta(i))}</div>
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
