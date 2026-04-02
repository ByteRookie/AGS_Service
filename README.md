# 🎵 AGS Service: Auto Grouping Speaker Logic (v2.0)

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FByteRookie%2FAGS_Service%2Fblob%2Fmain%2Fblueprints%2Fscript%2Fags_news_mode.yaml)

## The Problem: Manual Grouping is a Chore
If you have multiple Sonos or smart speakers, you know the routine: you move rooms and have to open an app to "join" the new speaker, or you turn on the TV and have to manually ungroup the soundbar.

## The Solution: Automation that Just Works
AGS Service is a utility that handles the "handshakes" between your speakers. It treats your home as a singular, intelligent audio organism that follows you, understanding the context of each room.

## Why You Want This Utility:

*   **Music Follows You**: Automatically regroups speakers based on room toggles or motion triggers.
*   **Intelligent TV Sync**: Detects active TVs and switches soundbars to TV audio instantly. Allows other rooms to "listen in" or stay isolated via **TV Mode: No Music**.
*   **News Mode (Cascading Overrides)**: Triggers specific behaviors for sources. Selecting "News" can run a script on your Apple TV if the TV is on, or fallback to a Sonos radio station if it's off.
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
1. Go to **Settings** → **Dashboards** → click the three dots (⋮) in the top right → **Resources**.
2. Click **Add Resource** in the bottom right corner.
3. Enter the URL: `/ags-static/ags-media-card.js`
4. Ensure the Resource type is set to **JavaScript Module**, and click Create.
5. Go to your Lovelace dashboard, click Edit, Add Card, search for "Manual", and paste the following:
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
