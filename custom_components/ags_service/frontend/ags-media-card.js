class AgsMediaCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._section = "player";
    this._browseStack = [];
    this._browseItems = [];
    this._loadingBrowse = false;
    this._showSourceMenu = false;
  }

  setConfig(config) {
    this._config = { entity: "media_player.ags_media_player", ...config };
    this._section = this._config.start_section || "player";
  }

  getCardSize() { return 6; }

  set hass(hass) {
    this._hass = hass;
    if (this._config) this.render();
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

  formatTime(s) {
    const v = Math.max(0, Math.floor(Number(s) || 0));
    return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
  }

  getLiveMediaPosition(player) {
    if (!player) return 0;
    const base = Number(player.attributes.media_position || 0);
    const updatedAt = player.attributes.media_position_updated_at;
    if (!updatedAt || !["playing", "buffering"].includes(player.state)) return base;
    return base + (Date.now() - new Date(updatedAt).getTime()) / 1000;
  }

  setSection(s) {
    this._section = s;
    this._showSourceMenu = false;
    if (s === "browse") this.browseMedia();
    this.render();
  }

  toggleSourceMenu() {
    this._showSourceMenu = !this._showSourceMenu;
    this.render();
  }

  callService(domain, service, data) { 
    this._hass.callService(domain, service, data); 
    if (service === 'select_source') this._showSourceMenu = false;
  }

  async browseMedia(node = null) {
    const ags = this.getAgsPlayer();
    if (!ags) return;
    const browseEid = ags.attributes.browse_entity_id || ags.attributes.primary_speaker;
    if (!browseEid || browseEid === "none") { this._browseItems = []; this.render(); return; }
    this._loadingBrowse = true;
    this.render();
    try {
      const payload = { type: "media_player/browse_media", entity_id: browseEid };
      if (node) { payload.media_content_type = node.media_content_type; payload.media_content_id = node.media_content_id; }
      const res = await this._hass.callWS(payload);
      this._browseItems = res.children || [];
      if (node) {
        if (!this._browseStack.length || this._browseStack[this._browseStack.length-1].media_content_id !== node.media_content_id) {
          this._browseStack.push(node);
        }
      } else { this._browseStack = []; }
    } catch (e) { console.error(e); }
    this._loadingBrowse = false;
    this.render();
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
    const pic = control?.attributes?.entity_picture || ags.attributes?.entity_picture || "";
    const title = isTv ? "Television Audio" : (control?.attributes?.media_title || "Nothing Playing");
    const subtitle = isTv ? (control?.attributes?.friendly_name || "TV Mode") : (control?.attributes?.media_artist || "Ready to Play");
    const duration = Number(control?.attributes?.media_duration || 0);
    const pos = this.getLiveMediaPosition(control || ags);
    const prog = duration > 0 ? (pos / duration) * 100 : 0;

    return `
      <div class="player-view">
        <div class="art-focal">
          <div class="art-stack ${isTv ? 'tv-gradient' : ''}">
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

  renderBrowse() {
    return `
      <div class="browse-view">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
          ${this._browseStack.length>0?`<button class="icon-btn" onclick="this.getRootNode().host.browseBack()"><ha-icon icon="mdi:chevron-left"></ha-icon></button>`:''}
          <div class="view-title" style="margin:0;">${this._browseStack.length>0?this.escapeHtml(this._browseStack[this._browseStack.length-1].title):'Library'}</div>
        </div>
        ${this._loadingBrowse?'<div class="loading-spin"><ha-circular-progress active></ha-circular-progress></div>':`
          <div class="browse-list" style="display:flex; flex-direction:column; gap:6px;">${this._browseItems.map((i, idx) => `
            <div class="list-card browse-item" onclick="this.getRootNode().host._handleBrowseClick(${idx})">
              ${i.thumbnail?`<img src="${i.thumbnail}" onerror="this.style.display='none'"/>` : ''}
              ${!i.thumbnail ? `<ha-icon icon="${i.can_expand?'mdi:folder':'mdi:music-note'}" style="opacity:0.4;"></ha-icon>` : ''}
              <div class="browse-label">${this.escapeHtml(i.title)}</div>
              ${i.can_expand ? `<ha-icon icon="mdi:chevron-right" style="opacity:0.2; --mdc-icon-size: 18px;"></ha-icon>` : ''}
            </div>`).join("")}</div>
        `}
      </div>
    `;
  }

  render() {
    const ags = this.getAgsPlayer();
    if (!ags) return;
    const ctrl = this.getControlPlayer();
    const pic = ctrl?.attributes?.entity_picture || ags.attributes?.entity_picture || "";
    const active = this.toArray(ags.attributes.active_rooms);
    const agsSources = this.toArray(ags.attributes.ags_sources);
    const nativeSources = this.toArray(ags.attributes.source_list);
    const currentSrc = ags.attributes.source || ags.attributes.selected_source_name || "Idle";
    const isSystemOn = ags.state !== "off";
    const status = ags.attributes.ags_status;
    
    const main = ags.attributes.primary_speaker_room || (active.length > 0 ? active[0] : "");
    const others = active.length > 1 ? ` + ${active.length - 1}` : "";
    const headerInfo = active.length > 0 ? `${main}${others}` : "System Idle";

    this.shadowRoot.innerHTML = `
      <style>
        :host { 
          --primary: var(--primary-color, #ff9800); 
          --card-bg: var(--ha-card-background, var(--card-background-color, #fff));
          --text: var(--primary-text-color, #212121);
          --text-sec: var(--secondary-text-color, #727272);
          --divider: var(--divider-color, rgba(0,0,0,0.1));
          --glass: rgba(var(--rgb-primary-text-color, 0,0,0), 0.05);
          --glass-heavy: rgba(var(--rgb-primary-text-color, 0,0,0), 0.08);
        }
        @media (prefers-color-scheme: dark) { 
          :host { --text: #b0b0b0; --text-sec: #808080; --divider: rgba(255,255,255,0.1); }
          ha-card { --glass: rgba(255,255,255,0.08); --glass-heavy: rgba(255,255,255,0.12); }
          .backdrop { filter: blur(40px) saturate(1.4) brightness(0.3); opacity: 0.6; } 
        }
        @media (prefers-color-scheme: light) { .backdrop { filter: blur(40px) saturate(1.4) brightness(1.1); opacity: 0.2; } }
        
        ha-card { position: relative; overflow: hidden; border-radius: 28px; background: var(--card-bg); color: var(--text); max-width: 400px; margin: 0 auto; aspect-ratio: 0.7 / 1; display: flex; flex-direction: column; border: 1px solid var(--divider); box-shadow: var(--ha-card-box-shadow, 0 4px 20px rgba(0,0,0,0.1)); transition: all 0.3s; }
        .backdrop { position: absolute; inset: -20px; background-image: ${pic ? `url(${pic})` : 'none'}; background-size: cover; background-position: center; z-index: 0; transition: 0.8s; }
        .surface { position: relative; z-index: 1; display: flex; flex-direction: column; height: 100%; background: linear-gradient(180deg, transparent 0%, var(--card-bg) 85%); }
        .card-header { padding: 16px 20px 0; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
        .header-picker-wrap { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; position: relative; }
        .source-mini-btn { display: flex; align-items:center; gap:6px; height: 28px; padding: 0 10px; border-radius: 8px; background: var(--glass-heavy); border: 1px solid var(--divider); color: var(--primary); font-weight: 900; font-size: 0.75rem; cursor: pointer; max-width: 130px; overflow: hidden; }
        .source-mini-btn span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .header-rooms { font-size: 0.8rem; font-weight: 800; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
        .header-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .section-body { flex: 1; padding: 12px 20px; overflow-y: auto; scrollbar-width: none; position: relative; }
        .section-body::-webkit-scrollbar { display: none; }
        .list-card { background: var(--glass); backdrop-filter: blur(10px); border: 1px solid var(--divider); border-radius: 16px; transition: 0.2s; }
        .master-vol-card { padding: 16px; background: var(--primary); color: #fff; border: none; box-shadow: 0 8px 16px rgba(var(--rgb-primary-color), 0.3); }
        .master-vol-card ha-icon { color: #fff; }
        .master-vol-card input[type=range] { accent-color: #fff; }
        .art-focal { display: flex; justify-content: center; margin-bottom: 12px; }
        .art-stack { width: 160px; height: 160px; border-radius: 20px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.3); border: 1px solid var(--divider); background: var(--glass-heavy); }
        .tv-gradient { background: linear-gradient(135deg, #1a237e, #4a148c); display: flex; align-items: center; justify-content: center; }
        .main-art { width: 100%; height: 100%; object-fit: cover; }
        .idle-art { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text); opacity: 0.2; }
        .idle-art ha-icon { --mdc-icon-size: 64px; }
        .track-info { text-align: center; margin-bottom: 12px; padding: 0 10px; }
        .track-title { font-size: 1.25rem; font-weight: 900; letter-spacing: -0.02em; margin-bottom: 2px; color: var(--text); }
        .track-subtitle { font-size: 0.85rem; color: var(--text-sec); font-weight: 600; }
        .playback-controls { padding: 16px; background: var(--glass); border-radius: 20px; }
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
        .footer { display: flex; justify-content: space-around; padding: 8px 16px 24px; background: var(--glass); border-top: 1px solid var(--divider); }
        .footer-btn { background: none; border: none; color: var(--text); opacity: 0.3; cursor: pointer; transition: 0.2s; padding: 10px; }
        .footer-btn.active { opacity: 1; color: var(--primary); transform: translateY(-2px); }
        .browse-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 6px; cursor: pointer; border-radius: 12px; }
        .browse-item:hover { background: var(--glass-heavy); }
        .browse-item img { width: 36px; height: 36px; border-radius: 6px; object-fit: cover; }
        .browse-label { font-weight: 700; font-size: 0.9rem; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
        .power-btn.on { color: var(--primary); opacity: 1; }
        .loading-spin { text-align: center; padding: 40px; }
        .system-off-view { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; }
        .off-icon-wrap { width: 80px; height: 80px; border-radius: 50%; background: var(--glass-heavy); display: flex; align-items: center; justify-content: center; color: var(--text-sec); opacity: 0.5; }
        .off-text { font-size: 1.1rem; font-weight: 800; color: var(--text-sec); }
        .turn-on-btn { width: auto; height: auto; padding: 12px 24px; border-radius: 12px; display: flex; align-items: center; gap: 10px; font-weight: 800; }
        .source-menu { position: absolute; top: 50px; left: 20px; right: 20px; background: var(--card-bg); border: 1px solid var(--primary); border-radius: 16px; z-index: 100; box-shadow: 0 10px 40px rgba(0,0,0,0.4); padding: 8px; max-height: 250px; overflow-y: auto; }
        .source-menu-item { padding: 12px 16px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 0.9rem; transition: 0.2s; border-bottom: 1px solid var(--divider); }
        .source-menu-item:hover { background: var(--glass-heavy); color: var(--primary); }
        .source-menu-item:last-child { border-bottom: none; }
      </style>
      <ha-card>
        <div class="backdrop"></div>
        <div class="surface">
          <div class="card-header">
            <div class="header-picker-wrap">
              <button class="source-mini-btn" onclick="this.getRootNode().host.toggleSourceMenu()">
                <ha-icon icon="mdi:playlist-music"></ha-icon>
                <span>${this.escapeHtml(currentSrc)}</span>
              </button>
              <div class="header-rooms">${this.escapeHtml(headerInfo)}</div>
            </div>
            <div class="header-actions">
              <button class="icon-btn power-btn ${isSystemOn?'on':''}" onclick="this.getRootNode().host.callService('media_player', '${isSystemOn?'turn_off':'turn_on'}', {entity_id: '${ags.entity_id}'})"><ha-icon icon="mdi:power"></ha-icon></button>
              <button class="icon-btn" onclick="this.getRootNode().host.openPortal()"><ha-icon icon="mdi:cog"></ha-icon></button>
            </div>
          </div>
          <div class="section-body">
            ${this._showSourceMenu ? `
              <div class="source-menu card-glass">
                <div style="font-size:0.7rem; font-weight:900; padding:8px 16px; opacity:0.5; text-transform:uppercase;">Select Source</div>
                ${agsSources.map(s => `<div class="source-menu-item" onclick="this.getRootNode().host.callService('media_player', 'select_source', {entity_id: '${ags.entity_id}', source: '${s.name}'})">${this.escapeHtml(s.name)}</div>`).join("")}
                ${nativeSources.filter(s => !agsSources.find(as => as.name === s)).map(s => `<div class="source-menu-item" onclick="this.getRootNode().host.callService('media_player', 'select_source', {entity_id: '${ags.entity_id}', source: '${s}'})">${this.escapeHtml(s)}</div>`).join("")}
              </div>
            ` : ""}
            ${this._section === "favorites" ? this.renderFavorites(ags) :
              this._section === "rooms" ? this.renderRooms(ags) :
              this._section === "browse" ? this.renderBrowse() :
              this._section === "volumes" ? this.renderVolumesSection(ags) :
              this.renderPlayerSection(ags, ctrl)}
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
    return `<div class="favorites-view"><div class="view-title">Favorites</div><div class="fav-grid" style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px;">${s.map(f => `
      <div class="fav-item" style="text-align:center; cursor:pointer;" onclick="this.getRootNode().host.callService('media_player', 'select_source', {entity_id: '${ags.entity_id}', source: '${f.name}'})">
        <div class="fav-art-shell" style="aspect-ratio:1; border-radius:12px; background:var(--glass-heavy); display:flex; align-items:center; justify-content:center; margin-bottom:4px; border:1px solid var(--divider);"><ha-icon icon="mdi:star" style="color:var(--primary);"></ha-icon></div>
        <div style="font-size:0.65rem; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--text-sec);">${this.escapeHtml(f.name)}</div>
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
    return `<div class="browse-view"><div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
      ${this._browseStack.length>0?`<button class="icon-btn" onclick="this.getRootNode().host.browseBack()"><ha-icon icon="mdi:chevron-left"></ha-icon></button>`:''}
      <div class="view-title" style="margin:0;">${this._browseStack.length>0?this.escapeHtml(this._browseStack[this._browseStack.length-1].title):'Library'}</div>
    </div>${this._loadingBrowse?'<div class="loading-spin"><ha-circular-progress active></ha-circular-progress></div>':`
      <div class="browse-list" style="display:flex; flex-direction:column; gap:6px;">${this._browseItems.map((i, idx) => `
        <div class="list-card browse-item" onclick="this.getRootNode().host._handleBrowseClick(${idx})">
          ${i.thumbnail?`<img src="${i.thumbnail}" onerror="this.style.display='none'"/>` : ''}
          ${!i.thumbnail ? `<ha-icon icon="${i.can_expand?'mdi:folder':'mdi:music-note'}" style="opacity:0.4;"></ha-icon>` : ''}
          <div class="browse-label">${this.escapeHtml(i.title)}</div>
          ${i.can_expand ? `<ha-icon icon="mdi:chevron-right" style="opacity:0.2; --mdc-icon-size: 18px;"></ha-icon>` : ''}
        </div>`).join("")}</div>`}</div>`;
  }

  openPortal() {
    window.history.pushState(null, "", "/ags-service");
    window.dispatchEvent(new Event("location-changed", { bubbles: true, composed: true }));
  }
}
customElements.define("ags-media-card", AgsMediaCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "ags-media-card", name: "AGS Media Card", preview: true });
