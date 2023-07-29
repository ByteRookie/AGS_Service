# AGS Service (Auto Grouping Speaker Service)

AGS Service is a custom Home Assistant integration designed to manage and group audio devices in different rooms. It allows you to configure speakers and rooms, and it automatically updates the groups based on the state of the speakers and the rooms. This integration has been designed and tested with Sonos speakers and LG TVs but may work with other devices supported by Home Assistant.

## Features

The integration creates four sensors and a switch for each room:

- Sensors:
  - `AGS Service Configured Rooms`: This sensor lists all the rooms configured in the AGS Service.
  - `AGS Service Active Rooms`: This sensor lists the active rooms based on the state of the room switch and home audio status.
  - `AGS Service Active Speakers`: This sensor lists the speaker devices in the active rooms.
  - `AGS Service Inactive Speakers`: This sensor lists the speaker devices not in active rooms.

- Switches:
  - `(Room Name) Media`: This switch allows you to manually control whether a room is active or not. A switch is automatically created for each room configured in the AGS Service.

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
        - device_id: "media_player.device_4"
          device_type: "speaker"
          priority: 4
