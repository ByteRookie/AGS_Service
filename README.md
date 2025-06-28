


# AGS Service (Auto Grouping Speaker Service)

AGS Service is a custom Home Assistant integration that automatically manages speakers across your home.  It creates a virtual **AGS Media Player** that always points to the best speaker for the active rooms and keeps groups in sync as you move around.  Designed around Sonos and LG TVs but compatible with any media player Home Assistant supports, AGS makes whole‑home audio effortless.

The integration continuously tracks room occupancy and speaker states, regrouping devices on the fly so your music or TV audio follows you.  With sensors, switches and automations built in, AGS can react to schedules, manual overrides and even HomeKit.  Whether you want music in every room or sound that follows you from place to place, AGS handles the heavy lifting.


# V1.3.0 Change Log

- Updated Primary speaker logic to include a default of 5 second delay before going to none. This can be adjusted from the default with the new Primary_delay value that can be added to config.
- Updated Switches so state now stays after a reboot 
- New Automation File that improves performance for AGS actions.

## Features

**Virtual AGS Media Player**

* Acts as the master player for the entire system. It automatically points to the best speaker based on room activity and exposes normal media controls (play, pause, volume, source, next/previous). Optionally a second HomeKit‑friendly player can mirror these controls for Apple users.

HomeKit can struggle with the AGS player's dynamic name and its automatic switch to a TV source. If you're using Apple's ecosystem either set up the optional `homekit_player` entity, which keeps a stable name and source, or enable both `static_name` and `disable_Tv_Source` in your configuration.

**Sensors**

* `AGS Service Configured Rooms` – lists every room defined in the configuration.
* `AGS Service Active Rooms` – shows which rooms are currently active according to their media switch and overall status.
* `AGS Service Active Speakers` – the speakers playing in the active rooms.
* `AGS Service Inactive Speakers` – speakers in rooms that are currently inactive.
* `AGS Service Status` – overall system state (`ON`, `ON TV`, `Override`, or `OFF`).
* `AGS Service Primary Speaker` – the speaker chosen as the primary output.
* `AGS Service Preferred Primary Speaker` – backup speaker that will take over if the primary stops playing.
* `AGS Service Source` – name of the media source that will be played when AGS starts playback.
* `AGS Service Inactive TV Speakers` – TV‑related speakers that are currently inactive.

**Switches**

* `(Room Name) Media` – toggle a room on or off manually. One switch is created for every room in your configuration.

## File Structure

The integration consists of four Python files and a manifest:

- `__init__.py`: The primary file for the integration, handling its setup and configuration.
- `sensor.py`: Defines the sensor entities for configured rooms, active rooms, active speakers, and inactive speakers.
- `switch.py`: Defines the switch entities for each room.
- `manifest.json`: Offers metadata about the integration, such as its domain, name, and version.
- `README.md`: Provides documentation for the integration (the file you're currently reading).

## Installation

To install the AGS Service integration, follow these steps:

1. Download the `ags_service` folder.
2. Place it in your `custom_components` directory. If you don't have a `custom_components` directory in your Home Assistant configuration directory, you'll need to create one.
3. Add the configuration details to your `configuration.yaml` file (see the Configuration section below for more information).
4. Restart Home Assistant.

## Configuration

The integration is configured via `configuration.yaml`.

Key options include:

* **disable_zone** – When `true`, AGS ignores the `zone.home` entity so the system can operate when you are away.
* **override_content** – If a device's `media_content_id` contains this value it will force AGS into `Override` mode and keep playback active for that source.
* **primary_delay** – Seconds to wait before clearing the primary speaker when no audio is playing. Default is `5`.
* **interval_sync** – How often the sensors refresh, in seconds. Default is `30`.
* **schedule_entity** – Optional schedule entity that turns the system on or off automatically.
* **homekit_player** – Name for an extra HomeKit media player entity that mirrors the AGS Media Player.
* **create_sensors**, **default_on**, **static_name**, **disable_Tv_Source** – Additional settings for advanced behaviour (see **Advanced Configuration** below).

A complete example configuration looks like this:

```yaml
ags_service:
  primary_delay: 5
  interval_sync: 30
  disable_zone: true
  homekit_player: "My HomeKit Player"
  create_sensors: true
  default_on: false
  static_name: "AGS Media Player"
  disable_Tv_Source: false
  schedule_entity:
    entity_id: schedule.my_music
    on_state: "on"  # optional
    off_state: "off"  # optional
    schedule_override: true  # optional
  rooms:
    - room: "Room 1"
      devices:
        - device_id: "media_player.device_1"
          device_type: "tv"
          priority: 1
        - device_id: "media_player.device_2"
          device_type: "speaker"
          priority: 2
    - room: "Room 2"
      devices:
        - device_id: "media_player.device_3"
          device_type: "tv"
          priority: 3
          override_content: "bluetooth"
        - device_id: "media_player.device_4"
          device_type: "speaker"
          priority: 4
  Sources:
    - Source: "Top Hit"
      Source_Value: "2/11"
      media_content_type: "favorite_item_id"
      source_default: true
    - Source: "Chill"
      Source_Value: "2/12"
      media_content_type: "favorite_item_id"
    - Source: "Alternative"
      Source_Value: "2/13"
      media_content_type: "favorite_item_id"

```

* **rooms** – A list of rooms and the devices in each room. Every device entry defines a `device_id`, `device_type` (`speaker` or `tv`) and `priority`.
* **sources** – Predefined media sources that AGS can start. Add `source_default: true` to the entry that should be used when no other source has been chosen.
* **schedule_entity** – When configured, AGS follows this entity's state. `on_state` and `off_state` default to `on` and `off`.
* **homekit_player**, **create_sensors**, **default_on**, **static_name**, **disable_Tv_Source**, and **interval_sync** provide further control over behaviour (see **Advanced Configuration** below).
* If `schedule_override` is enabled, AGS turns off once whenever the schedule switches to its off state but may be manually re-enabled until the schedule turns on again.

### Advanced Configuration

* **homekit_player** – Adds a second media player with a stable name for HomeKit.
* **static_name** – Forces a fixed name for the main AGS Media Player.
* **disable_Tv_Source** – Prevents automatically selecting a TV source.
* **create_sensors** – Set to `true` if you want the sensor entities enabled.
* **default_on** – Starts the system enabled after a reboot.
* **interval_sync** – Sensor refresh interval in seconds.
* **override_content** – Keeps playback active when this value is found in a device's content ID.
* **schedule_override** – With a schedule entity, turns the system off once when the schedule goes to its off state but allows manual re‑enable.


## Automation

AGS ships with an example automation that performs the heavy lifting—joining active speakers, dropping inactive ones and resetting TV speakers when necessary.  Copy `AGS Automation Example.yaml` into Home Assistant and all the logic is ready to go.  You can of course customise it further to fit your own flows.

## Sensor Logic

Each sensor uses specific logic to report the state of the system:

* **AGS Service Configured Rooms** – all rooms defined in the configuration.
* **AGS Service Active Rooms** – rooms whose media switch is on and where audio is playing.
* **AGS Service Active Speakers** – speakers located in those active rooms.
* **AGS Service Inactive Speakers** – speakers that are currently not active.
* **AGS Service Status** – overall status of the media system and schedule.
* **AGS Service Primary Speaker** – highest‑priority speaker currently playing.
* **AGS Service Preferred Primary Speaker** – fallback speaker that will start if the primary stops.
* **AGS Service Source** – the currently selected source that will play when AGS starts playback.
* **AGS Service Inactive TV Speakers** – TV speakers that are not part of the active room list.

## License

This project is released under a Non-Commercial License. See the [LICENSE](LICENSE) file for details.
