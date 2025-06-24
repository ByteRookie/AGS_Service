


# AGS Service (Auto Grouping Speaker Service)

AGS Service is a custom Home Assistant integration that functions as an intelligent management and automation system for audio devices grouped in different rooms. With the ability to interface with various audio devices, it dynamically forms and re-forms groups based on the state of the rooms and speakers. Although it has been designed and tested primarily with Sonos speakers and LG TVs, it maintains the flexibility to work with other devices supported by Home Assistant.

The core of AGS Service is to enable seamless control over which speakers are active based on the occupancy of the rooms, thereby enhancing the audio experience in a smart home environment. It achieves this by maintaining real-time tracking of each room's status and the state of the speakers within, adjusting the active speaker groups as necessary. This makes the AGS Service particularly useful in scenarios where audio playback needs to follow the user's location or specific room activities.


# V1.1.0 Change Log

- Updated Primary speaker logic to include a default of 5 second delay before going to none. This can be adjuted from the default with the new Primary_delay value that can be added to confg.
- Updated Switches so state now stays after a reboot 
- New Automation File that improves preformace for AGS actions.

## Features

The integration creates a series of sensors and switches for each room:

- Sensors:
  - `AGS Service Configured Rooms`: Lists all the rooms configured within the AGS Service.
  - `AGS Service Active Rooms`: Provides a list of rooms currently considered 'active' based on the state of the room switch and home audio status.
  - `AGS Service Active Speakers`: Identifies the speaker devices in the active rooms.
  - `AGS Service Inactive Speakers`: Enumerates the speaker devices not currently in active rooms.
  - `AGS Service Status`: Gives the overall status of the AGS service.
  - `AGS Service Primary Speaker`: Indicates the primary speaker in each active room.
  - `AGS Service Preferred Primary Speaker`: Highlights the preferred primary speaker in each active room, which is selected based on the priority configured for each speaker.
  - `AGS Service Source`: Notes the source of the audio stream that is currently being played.
  - `AGS Service Inactive TV Speakers`: Lists the inactive speakers that are associated with a TV device.

- Switches:
  - `(Room Name) Media`: Manually controls whether a room is active or not. A switch is automatically created for each room configured within the AGS Service.

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

The integration can be configured entirely from Home Assistant's **Devices & Services** UI.
1. **Select rooms** – pick one or more areas using the built‑in area selector. Previously chosen rooms are listed for reference.
2. **Choose devices** – for each room, select all media player entities that belong to it. A small summary of rooms and devices entered so far is shown on every screen.
3. **Enter device details** – specify the type (`tv` or `speaker`), priority and optional **override** string for every selected device. The override value keeps AGS active whenever the device plays media whose identifier contains that string.
4. **Manage sources** – a table style form lets you add or remove as many playback sources as you like, each with a name, value, content type and optional default flag.
5. **Set global options** – configure items like `primary_delay`, `homekit_player` and sensor creation while reviewing the rooms and devices you've entered.
6. **Review the summary** – confirm the listed rooms, devices and sources. From here you can jump back to add more rooms or devices before saving.
Manual YAML configuration continues to work for advanced setups using the structure below.

Available options:
- `disable_zone` – if `True`, the service ignores the state of `zone.home`.
- `override_content` – optional string for a device entry. When the selected player is playing media whose identifier contains this string, AGS keeps the room active regardless of occupancy (for example `bluetooth`).
- `primary_delay` – seconds to wait before clearing the primary speaker (default `5`).
- `homekit_player` – media player entity used when exposing the player to HomeKit.
- `create_sensors` – create dedicated sensor entities.
- `default_on` – default system state after a restart.
- `static_name` – friendly name to use for the generated media player.
- `disable_Tv_Source` – skip audio switching when a TV is active.

Complete YAML example:

```yaml
ags_service:
  primary_delay: 5
  disable_zone: true
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
      media_content_type: "music"
      source_default: true
    - Source: "Chill"
      Source_Value: "2/12"
      media_content_type: "music"
    - Source: "Alternative"
      Source_Value: "2/13"
      media_content_type: "music"
  

```

rooms: A list of rooms. Each room contains a list of devices. A device entry has `device_id`, `device_type` (`tv` or `speaker`), `priority`, and an optional `override_content` string.
sources: Items that can be selected for playback. Each source has a `Source` name, a `Source_Value` used as the content ID, and a `media_content_type`. Set `source_default: true` on one entry to mark it as the default.


##Automation

A key aspect of the AGS Service is its automation capabilities. The AGS Service is primarily an orchestrator, managing the state of the speakers and rooms. However, to influence the physical state of your audio devices based on the sensor values provided by the AGS Service, you must set up the appropriate automations. Without these, the AGS Service would merely provide sensor readings.

An automation example is provided in the AGS Automation Example.yaml (https://github.com/ByteRookie/AGS_Service/blob/main/AGS%20Automation%20Exmaple.yaml). simply copy and past it into your new automation and it should work as is. 

##Sensor Logic

Each sensor uses a specific logic to determine its state:

AGS Service Configured Rooms: Lists all the rooms that are configured in the AGS Service. This is a straightforward enumeration of the rooms specified in your configuration.yaml file.

AGS Service Active Rooms: This sensor checks the state of each room's media switch and the home audio status. If the media switch is on and the home audio status is 'playing', the room is considered active and added to the list.

AGS Service Active Speakers: This sensor checks the list of active rooms and enumerates the speaker devices within these rooms. If a speaker device is found in an active room, it is added to the list.

AGS Service Inactive Speakers: This sensor is similar to the Active Speakers sensor, but it enumerates the speakers in inactive rooms. If a speaker device is found in a room that is not active, it is added to the list.

AGS Service Status: This sensor provides the overall status of the AGS service. It checks the override switch and the state of the source selector to determine the status.

AGS Service Primary Speaker: This sensor checks each active room to determine the primary speaker. The primary speaker is the speaker with the highest priority (lowest numerical value) in the room.

AGS Service Preferred Primary Speaker: This sensor is similar to the Primary Speaker sensor, but it allows for a preferred primary speaker to be
