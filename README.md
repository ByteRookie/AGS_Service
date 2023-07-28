# AGS Service (Auto Grouping Speaker Service)

AGS Service is a custom Home Assistant integration designed to manage and group audio devices in different rooms. It allows you to configure speakers and rooms, and it automatically updates the groups based on the state of the speakers and the rooms. This integration has been designed and tested with Sonos speakers and LG TVs but may work with other devices supported by Home Assistant.

## Features

The integration creates four sensors and a switch for each room:

- Sensors:
  - `<name> Configured Rooms`: This sensor lists all the rooms configured in the AGS Service.
  - `<name> Active Rooms`: This sensor lists the active rooms based on the state of the room switch and home audio status.
  - `<name> Active Speakers`: This sensor lists the speaker devices in the active rooms.
  - `<name> Inactive Speakers`: This sensor lists the speaker devices not in active rooms.

- Switches:
  - `Room Name <name>`: This switch allows you to manually control whether a room is active or not.

In these names, `<name>` is replaced by the value of the `name` configuration option, if it's provided. If it's not provided, it defaults to "AGS Service".

## File Structure

The integration consists of four Python files and a manifest:

- `__init__.py`: This is the main file for the integration, handling the setup and configuration of the integration.
- `sensor.py`: This file defines the sensor entities for configured rooms, active rooms, active speakers, and inactive speakers.
- `switch.py`: This file defines the switch entities for each room.
- `manifest.json`: This file provides metadata about the integration, such as its domain, name, and version.
- `README.md`: This file (the one you're reading) provides documentation for the integration.

## Installation

To install the AGS Service integration, follow these steps:

1. Download the `ags_service` folder.
2. Place it in your `custom_components` directory. If you don't have a `custom_components` directory in your Home Assistant configuration directory, you'll need to create one.
3. Add the configuration details to your `configuration.yaml` file (see the Configuration section below for more information).
4. Restart Home Assistant.

## Configuration

The integration is configured via `configuration.yaml`. Here's an example configuration:

```yaml
ags_service:
  name: "My Custom Name"  
  rooms:
    - room: "Room 1"
      devices:
        - device_id: "media_player.room1_tv"
          device_type: "tv"
          priority: 1
        - device_id: "media_player.room1_speaker"
          device_type: "speaker"
          priority: 2
          override_content: "x-sonos-vli:RINCON_12345678901234500:3,bluetooth"
    - room: "Room 2"
      devices:
        - device_id: "media_player.room2_tv"
          device_type: "tv"
          priority: 3
        - device_id: "media_player.room2_speaker"
          device_type: "speaker"
          priority: 4
```

Each configuration entry has an optional `name` which is used in the names of the sensors and switches. Each `room` has a name and a list of `devices`. A `device` is identified by its `device_id`, `device_type` (either 'tv' or 'speaker'), and `priority` (an integer to specify the priority of the device). Optionally, a device can have an `override_content` which is a string.

## Note

Please replace `"media_player.room1_tv"`, `"media_player.room1_speaker"`, `"media_player.room2_tv"`, and `"media_player.room2_speaker"` with the actual entity IDs of your devices in Home Assistant.
