# AGS Service (Auto Grouping Speaker Service)

AGS Service is a custom Home Assistant integration designed to manage and group audio devices in different rooms. It allows you to configure speakers and rooms, and it automatically updates the groups based on the state of the speakers and the rooms. This integration has been designed and tested with Sonos speakers and LG TVs but may work with other devices supported by Home Assistant.

## Features

The integration creates multiple sensors and switches for each room:

- Sensors:
  - `Configured Rooms`: This sensor lists all the rooms configured in the AGS Service.
  - `AGS Active Rooms`: This sensor lists the active rooms based on the state of the room switch and home audio status.
  - `AGS Active Speakers`: This sensor lists the speaker devices in the active rooms.
  - `AGS Inactive Speakers`: This sensor lists the speaker devices not in active rooms.
  - `AGS Status`: This sensor provides the status of the AGS Service based on different conditions like the state of the home zone, the state of the Media System switch, and the state of all devices with type "TV".
  - `AGS Primary Speaker`: This sensor provides the primary speaker based on the state of the AGS Status sensor and the state of devices in the active rooms.
  - `AGS Preferred Primary`: This sensor provides the preferred primary speaker based on the priority assigned to devices in the active speakers.
  - `AGS Source`: This sensor provides the source based on the state of the AGS Status sensor and the state of the source selector.
  - `AGS Inactive TV Speakers`: This sensor lists the speaker devices in inactive rooms where a TV is present.
  
- Switches:
  - `(Room Name) Media`: This switch allows you to manually control whether a room is active or not. A switch is automatically created for each room configured in the AGS Service.
  - `Media System`: This switch is used to manually control the overall status of the media system.

## Understanding the Source Selector

The source selector is a crucial part of the AGS Service. It is a user-defined input selector in Home Assistant that defines the media source for the AGS Service. The state of the source selector directly influences the `AGS Source` sensor. 

When the `AGS Status` sensor's state is `ON TV`, the `AGS Source` sensor's state will be `TV`. If the `AGS Status` sensor's state is `ON`, the `AGS Source` sensor's state will be set to the value of the source selector. 

In the AGS Service configuration, you specify the entity ID of the source selector and a list of possible sources. Each source has a 'Source' that must match a state of the source selector and a 'Source_Value' that defines the corresponding state for the `AGS Source` sensor.

The 'Source_Value' is important as it's used as the media source that is sent to the speaker to play.

The entity ID of the source selector and the 'Source' of each source must match the states of the input selector exactly. 

The source selector is not optional. It must be defined in the AGS Service configuration for the integration to work correctly.

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

In the example configuration below, Source_selector is the entity ID of the input selector that is used to control the source of the AGS Service. The Sources list contains two sources, Spotify and Radio. The Source of each source corresponds to a state of the input selector and the Source_Value is the corresponding state for the AGS Source sensor. The 'Source_Value' is the media source that is sent to the speaker to play.

Each room is configured with a list of devices. The device_id is the entity ID of the device in Home Assistant, the device_type is either 'tv' or 'speaker', and the priority is a numerical value that defines the order of the devices. The lower the number, the higher the priority. The priority is used to determine the preferred primary speaker.

The integration is configured via `configuration.yaml`. Here's an example configuration:

```yaml
ags_service:
  Source_selector: "input_select.music_source"
  Sources:
    - Source: "Spotify"
      Source_Value: "spotify"
    - Source: "Radio"
      Source_Value: "radio"
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


