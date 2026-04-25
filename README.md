# 🎵 AGS Service: Auto Grouping Speaker Logic (v2.0.5)

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FByteRookie%2FAGS_Service%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fags_entity_context_actions.yaml)

## The Problem: Manual Grouping is a Chore
If you have multiple Sonos or smart speakers, you know the routine: you move rooms and have to open an app to "join" the new speaker, or you turn on the TV and have to manually ungroup the soundbar.

## The Solution: Automation that Just Works
AGS Service is a utility that handles the "handshakes" between your speakers. It treats your home as a singular, intelligent audio organism that follows you, understanding the context of each room.

## Why You Want This Utility:

*   **Music Follows You**: Automatically regroups speakers based on room toggles or motion triggers.
*   **Intelligent TV Sync**: Detects active TVs and switches soundbars to TV audio instantly. Allows other rooms to "listen in" or stay isolated via **TV Mode: No Music**.
*   **Entity-Based Context Actions**: Use the blueprint to react to AGS source changes or room switches with the current source, primary speaker, TV device, and room devices available as action variables.
*   **Sticky Master Logic**: Prevents audio cutouts by maintaining the lead speaker as long as it's active, even if a higher-priority room joins.
*   **No More YAML**: Manage everything through a dedicated Sidebar Panel.

## Quick Start

1. **Install**: Install via HACS (recommended) or place the `ags_service` folder in `custom_components`.
2. **Restart**: Restart Home Assistant.
3. **Configure**: Open the **AGS Service** icon in your Home Assistant sidebar.
4. **Migration**: If you have an existing YAML configuration, AGS will automatically import it into the UI on the first run. You can then safely remove the `ags_service:` block from your `configuration.yaml`.

## 📸 UI Showcase

### 1. Orchestration Overview
The Overview tab provides a real-time visualization of the AGS engine. See the `dynamic_title` in action and track the animated stepper as it elects masters and syncs groups.
![AGS Overview Tab](overview.png)

### 2. Nested Device Management
Manage your home's complexity with ease. Expand any room to configure device priorities, types, and specific entity IDs using native Home Assistant pickers.
![AGS Settings Tab](settings.png)

### 3. News Mode (Source Overrides)
Configure cascading logic per device. This example shows a "News" override that triggers an Apple TV script but falls back to standard behavior when the TV is off.
![AGS Override UI](overrides.png)

## Features (New in V2)

**UI-Driven Configuration**
* Stop editing YAML. AGS now features a dedicated **Custom Panel** in the Home Assistant sidebar for real-time orchestration visualization and settings management.

**Cascading Source Overrides (News Mode)**
* Define device-specific behavior for any source. Want "Morning News" to play on the TV if it's on, but fall back to the speaker if it's off? V2 handles this with prioritized execution logic.

**Lovelace Custom Card (`ags-media-card`)**
* V2 includes a beautiful, premium Lovelace dashboard card specifically built for AGS. It provides a rich player with dynamic blurred backgrounds, live room volume grouping, and a grid of your global music sources. 

### How to add the Custom Card to your Dashboard:
1. Restart Home Assistant after installing or updating AGS so the integration can register the latest frontend assets.
2. If you previously added `/ags-static/ags-media-card.js` manually in **Settings** → **Dashboards** → **Resources**, remove that old unversioned resource. AGS now injects the versioned card asset automatically, and stale manual resources can cause dashboard-only configuration errors.
3. Go to your Lovelace dashboard, click Edit, Add Card, search for "Manual", and paste the following:
```yaml
type: custom:ags-media-card
```

**Native Group Spoofing**
* The virtual AGS player now spoofs native Sonos grouping. This means standard Home Assistant dashboards and HomeKit see the entire group as a single, controllable unit with accurate member tracking.

**One-Click Migration**
* Existing YAML configurations are automatically migrated to the new JSON-based storage system upon first startup.

## Installation

### Install with HACS

1. Open **HACS → Integrations → ⋮ → Custom repositories**.
2. Add `https://github.com/ByteRookie/AGS_Service` as a new **Integration** repository.
3. Search for **AGS Service** in HACS and install it.
4. Restart Home Assistant.

## Changelog

### v2.0.5
- **Startup Reliability**: Forced AGS to recompute state immediately on boot, restored switch state, and direct room/action toggles so playback and grouping logic no longer wait on delayed entity churn.
- **Faster Room Control Feedback**: Room and action switches now trigger immediate AGS refreshes, and the media player performs an initial update when added so the system becomes usable sooner after restart.
- **Portal Navigation Polish**: Tightened portal tab behavior, added scroll-to-top on section changes, and made the custom menu button appear only on responsive layouts where Home Assistant actually needs it.
- **Embedded Media Card Cleanup**: Brought Browse into the embedded card, improved section switching, and aligned the room toggle UI with actual switch state for clearer On/Off behavior.
- **Artwork-Driven Player Styling**: The media card now continues using artwork from the active control player and derives a modern translucent color treatment from that art while still respecting the Home Assistant theme.

### v2.0.4
- **HA-Style Portal Header**: Reworked the AGS sidebar header to use a Home Assistant-style menu button, cleaner title bar, and a single live status line instead of separate portal header controls.
- **Home Layout Cleanup**: Tightened the Home page composition so the embedded media player aligns better with the entity/status panel and behaves more consistently across screen sizes.
- **Embedded Card Fit Fixes**: Reworked the media card shell so the top controls fit on the first row, the player avoids unnecessary vertical scrolling, and Favorites/Browse content scrolls under the bottom nav instead of pushing it off-screen on mobile.
- **Better Room Controls**: Replaced the awkward room switch interaction with larger right-aligned action buttons and a short pending state so room on/off changes feel cleaner and easier to use.

### v2.0.3
- **Core Logic Stability**: Restored the broader `v2.0.1` TV/music decision behavior for switched-on rooms while keeping the faster grouping timing improvements from `v2.0.2`.
- **Less Input Thrash**: Reduced unnecessary `TV` source resets when speakers leave or rejoin groups, helping music and TV inputs stay stable as you move through rooms.
- **Theme-Aware UI**: Updated the panel and Lovelace media card to properly follow Home Assistant light/dark theme settings instead of forcing a dark shell.
- **Accessibility Improvements**: Improved contrast across both modes, added visible keyboard focus states, better touch target sizing, screen-reader labels, and proper button/menu semantics for interactive controls.
- **Media Card Polish**: Modernized the power, transport, source, browse, and volume controls for smoother mobile use and a cleaner responsive layout.
- **Live Volume Feedback**: Volume sliders now update live while dragging with short debounced service calls for better responsiveness without excessive churn.

### v2.0.2
- **Performance Improvements**: Reduced startup lag for source playback and tightened room add/remove grouping responsiveness.
- **Smoother Media Card UX**: Fixed jumpy tab/dropdown behavior by preserving card state instead of re-rendering on every Home Assistant tick.
- **Responsive Panel Fixes**: Improved mobile and tablet layouts for the AGS panel and embedded media card.
- **State Refresh Optimization**: Debounced AGS media-player refreshes to avoid redundant full sensor recomputation during rapid device updates.
- **Playback Stability**: Prevented unnecessary music restarts when room grouping changes while AGS is already in music mode.
- **HomeKit Bridge Fixes**: Wired the configured `homekit_player` into metadata and transport fallbacks so Apple Home has a stable bridge entity.
- **Release Hygiene**: Fixed `disable_tv_source` config consistency and refreshed frontend asset versions for reliable cache busting.

### v2.0.0
- **Architectural Overhaul**: Transitioned to UI-driven configuration via `hass.helpers.storage`.
- **Cascading Source Overrides**: Added "News Mode" cascading logic (TV -> Speaker -> Global).
- **HomeKit & Spoofing**: Consolidated entities and added native group spoofing for better HomeKit stability.
- **Custom Panel**: Introduced a LitElement-based dashboard for real-time orchestration tracking and nested config editing.
- **Hot-Reload**: Changes in the UI take effect instantly without a restart.
- **Bug Fixes**:
  - Fixed "TV_MODE_NO_MUSIC" cleanup loops.
  - Resolved "TV Hijack" routing errors.
  - Patched Sonos Favorites bug with Entity Registry verification.
  - Enhanced Bluetooth/Line-In detection.
  - Improved Idle Lockout and Standalone Room fallbacks.
  - Fixed "Ghost TV" state detection across all core logic.
  - Added safety nets for dead master failovers.

## License

This project is released under a Non-Commercial License. See the [LICENSE](LICENSE) file for details.
