


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
  - `AGS Schedule`: Defines when AGS should be active. When this schedule is off the service will not start playback unless an override is detected. This schedule entity uses the native Home Assistant schedule helper.

- Switches:
  - `(Room Name) Media`: Manually controls whether a room is active or not. A switch is automatically created for each room configured within the AGS Service.
  - `AGS Schedule`: Exposes a schedule entity (`schedule.ags_schedule`) controlling when AGS is allowed to operate.

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

The integration is configured via `configuration.yaml`. Here's an example configuration:

New optional Value of disable_zone and override_content.
disable_zone If set to True it will disable logic looking at zone.home 
override_content can be used to override media status if a device content ID contents value of override_content. Example use case is if speaker has bluetooth in content ID override media status and turn it on. It will only play  that content in the other rooms and go back to off once that device plays other content. 

primary_delay is a number in second. default is 5 seconds. this will effect how long the sesnor will wait before primary speaker is set to none . Setting to low will result in songs being reset often when changing rooms. Setting it longer will result in longer waits between system auto start new music after there is no active speaker.
interval_sync determines how frequently the sensors refresh their state. It defaults to 30 seconds.
An always-on `AGS Schedule` entity is created automatically. Turning this schedule off will force the AGS status to `OFF` unless an override is detected.

this has all features:

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

rooms: A list of rooms. Each room is an object that has a room name and a list of devices. Each device is an object that has a device_id, device_type, and priority.
sources: The sources of audio that can be selected. Add ``source_default: true`` to mark the entry that should be used when no source has been chosen. If no entry is marked, the first source in the list will be used by default.
homekit_player, create_sensors, default_on, static_name, disable_Tv_Source, and interval_sync are optional settings that provide extra capabilities.


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
