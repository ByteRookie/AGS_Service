# Auto Grouping Speaker Service (AGS)

AGS is a Home Assistant integration that automatically manages groups of speakers spread across multiple rooms.  
It monitors which rooms are active and keeps a single **AGS Media Player** entity in sync with the currently selected speakers.  
When a room becomes active, the speakers in that room join the group; inactive rooms are removed.  
The integration also exposes sensors so automations can react to the current audio configuration.

## Features

- **Room switches** – Each room gets a `<Room Name> Media` switch to indicate if audio should play there.
- **Sensors** – Track configured rooms, active rooms, active/inactive speakers, the current source and more.
- **AGS Media Player** – A unified media player that follows the highest priority active speaker. Optional HomeKit player support is available.

## Installation

1. Copy the `ags_service` folder from this repository into your Home Assistant `custom_components` directory.
2. Restart Home Assistant to load the integration.

## Configuration

Add an `ags_service` block to `configuration.yaml`. A minimal example is shown below. A more complete version can be found in [`AGS Example Config.yaml`](AGS%20Example%20Config.yaml):

```yaml
ags_service:
  rooms:
    - room: "Living Room"
      devices:
        - device_id: "media_player.tv_living"
          device_type: "tv"
          priority: 1
        - device_id: "media_player.sonos_living"
          device_type: "speaker"
          priority: 2
    - room: "Kitchen"
      devices:
        - device_id: "media_player.sonos_kitchen"
          device_type: "speaker"
          priority: 3
  Sources:
    - Source: "Chill"
      Source_Value: "2/12"
      media_content_type: "favorite_item_id"
      source_default: true
    - Source: "Top Hit"
      Source_Value: "2/11"
      media_content_type: "favorite_item_id"
  primary_delay: 5          # seconds before the primary speaker resets
  disable_zone: false       # ignore zone.home state when true
  homekit_player: null      # name of optional secondary player
  create_sensors: true      # create sensor entities
  default_on: false         # start AGS in ON state after restart
  static_name: null         # fixed name for AGS Media Player
  disable_Tv_Source: false  # hide TV from source list when true
```

Each room lists the devices involved.  `device_type` should be `tv` or `speaker`.  
`priority` controls which device becomes the primary speaker when multiple are active.  
`override_content` may be added to a device entry to force AGS on when that media content is detected (e.g. Bluetooth).

## Automation

AGS orchestrates speakers but relies on Home Assistant automations for playback control.  
An example automation is provided in [`AGS Automation Exmaple.yaml`](AGS%20Automation%20Exmaple.yaml).

## How It Works

On every update the integration:
1. Reads the room switches to determine **active rooms**.
2. Chooses a **primary speaker** based on priority and device state.
3. Updates the `media_player.ags_media_system` entity so it always represents the current primary speaker.
4. Maintains sensor entities with lists of active speakers, inactive speakers and overall AGS status.

These sensors allow you to build automations that follow you from room to room or start playing your preferred source whenever the system turns on.

