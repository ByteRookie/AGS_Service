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
    this._handleOutsideClick = this._handleOutsideClick.bind(this);
  }

  connectedCallback() {
    document.addEventListener("click", this._handleOutsideClick, true);
  }

  disconnectedCallback() {
    document.removeEventListener("click", this._handleOutsideClick, true);
  }

  setConfig(config) {
    this._config = config;
    this.render(true);
  }

  getCardSize() { return 6; }

  set hass(hass) {
    const hadBrowseItems = this._browseItems.length > 0;
    this._hass = hass;
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

    const agsSources = this.toArray(ags.attributes.ags_sources);
    const nativeSources = this.toArray(ags.attributes.source_list);

    return `
      <div class="player-view">
        <div class="hero-strip" style="position: relative;">
          <span class="hero-pill clickable" onclick="this.getRootNode().host.toggleSourceMenu()">
            ${this.escapeHtml(sourceLabel)}
            <ha-icon icon="mdi:chevron-down" style="--mdc-icon-size: 14px; margin-left: 4px;"></ha-icon>
          </span>
          ${this._showSourceMenu ? `
            <div class="source-menu card-glass" style="position: absolute; top: 40px; left: 0; z-index: 100; min-width: 200px;">
              <div style="font-size:0.7rem; font-weight:900; padding:8px 16px; opacity:0.5; text-transform:uppercase;">Select Source</div>
              ${agsSources.map(s => `<div class="source-menu-item" onclick="this.getRootNode().host.callService('media_player', 'select_source', {entity_id: '${ags.entity_id}', source: '${s.name}'})">${this.escapeHtml(s.name)}</div>`).join("")}
              ${nativeSources.filter(s => !agsSources.find(as => as.name === s)).map(s => `<div class="source-menu-item" onclick="this.getRootNode().host.callService('media_player', 'select_source', {entity_id: '${ags.entity_id}', source: '${s}'})">${this.escapeHtml(s)}</div>`).join("")}
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
            <button class="icon-btn" onclick="this.getRootNode().host.callService('media_player', 'media_previous_track', {entity_id: '${ags.entity_id}'})"><ha-icon icon="mdi:skip-previous"></ha-icon></button>
            <button class="play-btn" onclick="this.getRootNode().host.callService('media_player', 'media_play_pause', {entity_id: '${ags.entity_id}'})"><ha-icon icon="${isPlaying ? 'mdi:pause' : 'mdi:play'}"></ha-icon></button>
            <button class="icon-btn" onclick="this.getRootNode().host.callService('media_player', 'media_next_track', {entity_id: '${ags.entity_id}'})"><ha-icon icon="mdi:skip-next"></ha-icon></button>
          </div>
        </div>
      </div>
    `;
  }

  renderVolumesSection(ags) {
    const groupVol = Math.round((Number(ags.attributes.volume_level || 0)) * 100);
    const rooms = this.toArray(ags.attributes.room_details);
    return `
      <div class="volumes-view">
        <div class="view-title">Volume</div>
        <div class="list-card master-vol-card">
          <div class="vol-label-row"><span>Group Master</span><span>${groupVol}%</span></div>
          <div class="volume-inline"><ha-icon icon="mdi:volume-high"></ha-icon><input type="range" min="0" max="100" value="${groupVol}" onchange="this.getRootNode().host.callService('media_player', 'volume_set', {entity_id: '${ags.entity_id}', volume_level: this.value/100})" /></div>
        </div>
        <div class="room-levels-stack">
          ${rooms.filter(r => r.active).map(r => {
            const spkId = r.devices?.find(d => d.device_type === "speaker")?.entity_id;
            const spkState = spkId ? this._hass.states[spkId] : null;
            const v = Math.round((spkState?.attributes?.volume_level || 0) * 100);
            return `
              <div class="list-card" style="margin-bottom:8px; padding:12px 16px;">
                <div class="vol-label-row" style="font-size:0.85rem; margin-bottom:4px;"><span>${this.escapeHtml(r.name)}</span><span>${v}%</span></div>
                <div class="volume-inline"><input class="volume-slider" type="range" min="0" max="100" value="${v}" ${!spkId ? 'disabled' : ''} onchange="this.getRootNode().host.callService('media_player', 'volume_set', {entity_id: '${spkId}', volume_level: this.value/100})" /></div>
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
    
    const main = ags.attributes.primary_speaker_room || (active.length > 0 ? active[0] : "");
    const others = active.length > 1 ? ` + ${active.length - 1}` : "";
    const headerInfo = active.length > 0 ? `${main}${others}` : "System Idle";

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          --primary: var(--primary-color, #ff9800);
          --card-bg: rgba(17, 24, 39, 0.95);
          --card-bg-strong: rgba(17, 24, 39, 1);
          --text: var(--primary-text-color, #212121);
          --text-sec: var(--secondary-text-color, #6b6b6b);
          --divider: var(--divider-color, rgba(0,0,0,0.12));
          --glass: rgba(var(--rgb-card-background-color, 255, 255, 255), 0.44);
          --glass-heavy: rgba(var(--rgb-card-background-color, 255, 255, 255), 0.66);
          --outline: rgba(var(--rgb-primary-text-color, 0, 0, 0), 0.12);
          --shadow: 0 24px 48px rgba(15, 23, 42, 0.22);
        }
        .backdrop {
          position: absolute; inset: -20px; background-image: ${pic ? `url(${pic})` : 'none'}; background-size: cover; background-position: center; z-index: 0; transition: 0.8s;
          filter: blur(40px) saturate(1.4);
          opacity: 0.22;
        }
        
        ha-card { position: relative; overflow: hidden; border-radius: 28px; background: linear-gradient(180deg, rgba(var(--rgb-primary-color), 0.08), transparent 28%), var(--card-bg-strong); color: var(--text); max-width: 420px; width: 100%; margin: 0 auto; aspect-ratio: 0.72 / 1; min-height: 640px; display: flex; flex-direction: column; border: 1px solid var(--outline); box-shadow: var(--ha-card-box-shadow, var(--shadow)); transition: all 0.3s; }
        .surface { position: relative; z-index: 1; display: flex; flex-direction: column; height: 100%; background: linear-gradient(180deg, rgba(var(--rgb-card-background-color, 255, 255, 255), 0.18) 0%, var(--card-bg-strong) 78%); }
        .card-header { padding: 16px 20px 0; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
        .header-picker-wrap { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; position: relative; }
        .header-rooms { font-size: 0.8rem; font-weight: 800; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
        .header-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .section-body { flex: 1; padding: 12px 20px 20px; overflow-y: auto; scrollbar-width: none; position: relative; }
        .section-body::-webkit-scrollbar { display: none; }
        .list-card { background: var(--glass); backdrop-filter: blur(10px); border: 1px solid var(--outline); border-radius: 18px; transition: 0.2s; }
        .master-vol-card { padding: 16px; background: var(--primary); color: #fff; border: none; box-shadow: 0 8px 16px rgba(var(--rgb-primary-color), 0.3); }
        .master-vol-card ha-icon { color: #fff; }
        .master-vol-card input[type=range] { accent-color: #fff; }
        .hero-strip { display: flex; justify-content: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
        .hero-pill { padding: 6px 12px; border-radius: 999px; font-size: 0.72rem; font-weight: 900; letter-spacing: 0.02em; background: rgba(var(--rgb-primary-color), 0.12); color: var(--primary); border: 1px solid rgba(var(--rgb-primary-color), 0.18); }
        .hero-pill.clickable {
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .hero-pill.clickable:hover {
          background: var(--primary);
          color: white;
          transform: translateY(-1px);
        }
        .hero-pill.subtle { background: var(--glass); color: var(--text-sec); border-color: var(--outline); }
        .art-focal { display: flex; justify-content: center; margin-bottom: 16px; }
        .art-stack { position: relative; width: 188px; height: 188px; border-radius: 28px; overflow: hidden; box-shadow: 0 18px 40px rgba(15, 23, 42, 0.26); border: 1px solid var(--outline); background: linear-gradient(160deg, rgba(var(--rgb-primary-color), 0.16), rgba(var(--rgb-primary-text-color, 0, 0, 0), 0.06)); }
        .art-aura { position: absolute; inset: auto -10% -30% -10%; height: 55%; background: radial-gradient(circle at center, rgba(var(--rgb-primary-color), 0.34), transparent 70%); pointer-events: none; z-index: 0; }
        .tv-gradient { background: linear-gradient(135deg, #1a237e, #4a148c); display: flex; align-items: center; justify-content: center; }
        .main-art { position: relative; z-index: 1; width: 100%; height: 100%; object-fit: cover; }
        .idle-art { position: relative; z-index: 1; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text); opacity: 0.22; }
        .idle-art ha-icon { --mdc-icon-size: 64px; }
        .track-info { text-align: center; margin-bottom: 14px; padding: 0 10px; }
        .track-title { font-size: 1.35rem; font-weight: 900; letter-spacing: -0.03em; margin-bottom: 4px; color: var(--text); }
        .track-subtitle { font-size: 0.9rem; color: var(--text-sec); font-weight: 700; }
        .playback-controls { padding: 16px; background: var(--glass); border-radius: 24px; border: 1px solid var(--outline); }
        .progress-bar { height: 4px; background: rgba(var(--rgb-primary-text-color, 0,0,0), 0.1); border-radius: 2px; overflow: hidden; }
        .progress-fill { height: 100%; background: var(--primary); transition: width 0.3s; }
        .time-meta { display: flex; justify-content: space-between; font-size: 0.65rem; margin-top: 4px; color: var(--text-sec); font-weight: 700; }
        .buttons-row { display: flex; justify-content: space-around; align-items: center; margin: 10px 0; }
        .play-btn { width: 56px; height: 56px; border-radius: 50%; background: var(--primary); color: #fff; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 4px 12px rgba(var(--rgb-primary-color), 0.3); }
        .play-btn ha-icon { --mdc-icon-size: 28px; }
        .icon-btn { background: none; border: none; color: var(--text); cursor: pointer; opacity: 0.6; padding: 8px; }
        .view-title { font-size: 1.1rem; font-weight: 900; margin-bottom: 12px; color: var(--primary); text-transform: uppercase; letter-spacing: 0.05em; }
        .vol-label-row { display: flex; justify-content: space-between; margin-bottom: 6px; font-weight: 800; }
        .volume-inline { display: flex; align-items: center; gap: 8px; }
        input[type=range] { flex: 1; accent-color: var(--primary); height: 4px; cursor: pointer; }
        .footer { display: flex; justify-content: space-around; padding: 10px 16px 24px; background: var(--glass); border-top: 1px solid var(--outline); }
        .footer-btn { background: none; border: none; color: var(--text); opacity: 0.3; cursor: pointer; transition: 0.2s; padding: 10px; }
        .footer-btn.active { opacity: 1; color: var(--primary); transform: translateY(-2px); }
        .browse-grid, .fav-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; }
        .browse-item { display: flex; flex-direction: column; gap: 10px; padding: 12px; margin-bottom: 0; cursor: pointer; border-radius: 18px; }
        .browse-item:hover { background: var(--glass-heavy); }
        .browse-art, .fav-art-shell { position: relative; aspect-ratio: 1 / 1; border-radius: 18px; overflow: hidden; border: 1px solid var(--outline); background: linear-gradient(160deg, rgba(var(--rgb-primary-color), 0.18), rgba(var(--rgb-primary-text-color, 0, 0, 0), 0.05)); display:flex; align-items:center; justify-content:center; }
        .browse-art img, .fav-art-shell img { width: 100%; height: 100%; object-fit: cover; }
        .browse-label { font-weight: 800; font-size: 0.92rem; line-height: 1.2; min-height: 2.2em; color: var(--text); }
        .browse-meta { font-size: 0.74rem; color: var(--text-sec); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
        .power-btn.on { color: var(--primary); opacity: 1; }
        .loading-spin { text-align: center; padding: 40px; }
        .browse-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 40px 20px; color: var(--text-sec); font-size: 0.9rem; font-weight: 600; text-align: center; }
        .browse-empty ha-icon { --mdc-icon-size: 40px; opacity: 0.4; }
        .system-off-view { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; }
        .off-icon-wrap { width: 80px; height: 80px; border-radius: 50%; background: var(--glass-heavy); display: flex; align-items: center; justify-content: center; color: var(--text-sec); opacity: 0.5; }
        .off-text { font-size: 1.1rem; font-weight: 800; color: var(--text-sec); }
        .turn-on-btn { width: auto; height: auto; padding: 12px 24px; border-radius: 12px; display: flex; align-items: center; gap: 10px; font-weight: 800; }
        .source-menu { position: absolute; background: var(--card-bg-strong); border: 1px solid var(--primary); border-radius: 16px; z-index: 100; box-shadow: 0 10px 40px rgba(0,0,0,0.24); padding: 8px; max-height: 250px; overflow-y: auto; }
        .source-menu-item { padding: 12px 16px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 0.9rem; transition: 0.2s; border-bottom: 1px solid var(--divider); }
        .source-menu-item:hover { background: var(--glass-heavy); color: var(--primary); }
        .source-menu-item:last-child { border-bottom: none; }
        @media (max-width: 768px) {
          ha-card { max-width: 100%; min-height: 0; aspect-ratio: auto; }
          .card-header { padding: 14px 14px 0; }
          .section-body { padding: 10px 14px 16px; }
          .art-stack { width: 160px; height: 160px; border-radius: 24px; }
          .track-title { font-size: 1.15rem; }
          .buttons-row { gap: 8px; }
          .source-menu { left: 0 !important; right: 0; min-width: 0 !important; }
          .footer { padding: 8px 10px 18px; }
        }
        @media (max-width: 420px) {
          .browse-grid, .fav-grid { grid-template-columns: 1fr; }
          ha-card { max-width: 100%; }
          .hero-strip { justify-content: stretch; }
          .hero-pill { width: 100%; text-align: center; }
          .play-btn { width: 52px; height: 52px; }
          .footer { justify-content: space-between; }
          .footer-btn { padding: 8px 6px; }
        }
      </style>
      <ha-card>
        <div class="backdrop"></div>
        <div class="surface">
          <div class="card-header">
            <div class="header-picker-wrap">
              <div class="header-rooms" style="font-size: 0.8rem; opacity: 0.7;">${this.escapeHtml(headerInfo)}</div>
            </div>
            <div class="header-actions">
              <button class="icon-btn power-btn ${isSystemOn?'on':''}" onclick="this.getRootNode().host.callService('media_player', '${isSystemOn?'turn_off':'turn_on'}', {entity_id: '${ags.entity_id}'})"><ha-icon icon="mdi:power"></ha-icon></button>
              <button class="icon-btn" onclick="this.getRootNode().host.openPortal()"><ha-icon icon="mdi:cog"></ha-icon></button>
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
            <button class="footer-btn ${this._section==='player'?'active':''}" onclick="this.getRootNode().host.setSection('player')"><ha-icon icon="mdi:play-circle"></ha-icon></button>
            <button class="footer-btn ${this._section==='favorites'?'active':''}" onclick="this.getRootNode().host.setSection('favorites')"><ha-icon icon="mdi:star"></ha-icon></button>
            <button class="footer-btn ${this._section==='browse'?'active':''}" onclick="this.getRootNode().host.setSection('browse')"><ha-icon icon="mdi:folder-music"></ha-icon></button>
            <button class="footer-btn ${this._section==='rooms'?'active':''}" onclick="this.getRootNode().host.setSection('rooms')"><ha-icon icon="mdi:speaker-multiple"></ha-icon></button>
            <button class="footer-btn ${this._section==='volumes'?'active':''}" onclick="this.getRootNode().host.setSection('volumes')"><ha-icon icon="mdi:tune-vertical"></ha-icon></button>
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
      <div class="browse-item list-card" onclick="this.getRootNode().host.callService('media_player', 'select_source', {entity_id: '${ags.entity_id}', source: '${f.name}'})">
        <div class="fav-art-shell">
          ${currentArt && f.name === activeSource ? `<img src="${currentArt}" />` : `<ha-icon icon="${f.default ? "mdi:star-four-points" : "mdi:music-circle"}" style="color:var(--primary); --mdc-icon-size: 44px;"></ha-icon>`}
        </div>
        <div class="browse-label">${this.escapeHtml(f.name)}</div>
        <div class="browse-meta">${f.default ? "Default source" : this.escapeHtml((f.media_content_type || "media").replace(/_/g, " "))}</div>
      </div>`).join("")}</div></div>`;
  }

  renderRooms(ags) {
    const r = this.toArray(ags.attributes.room_details);
    return `<div class="rooms-view"><div class="view-title">Groups</div>${r.map(room => `
      <div class="list-card browse-item" style="padding:12px 16px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; border-radius:12px;">
        <div style="overflow:hidden; flex:1;"><div style="font-weight:800; font-size:1rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(room.name)}</div><div style="font-size:0.7rem; color:var(--text-sec);">${room.active?'Active':'Idle'}</div></div>
        <ha-switch ${room.active?'checked':''} onclick="this.getRootNode().host.callService('switch', 'toggle', {entity_id: '${room.switch_entity_id}'})"></ha-switch>
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
        <div class="list-card browse-item" onclick="this.getRootNode().host._handleBrowseClick(${idx})">
          <div class="browse-art">
            ${i.thumbnail ? `<img src="${this.resolveMediaUrl(i.thumbnail)}" />` : `<ha-icon icon="${i.can_expand ? 'mdi:folder' : 'mdi:music'}"></ha-icon>`}
          </div>
          <div class="browse-label">${this.escapeHtml(i.title)}</div>
          <div class="browse-meta">${this.escapeHtml(i.media_class)}</div>
        </div>`).join("")}</div>`;
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
