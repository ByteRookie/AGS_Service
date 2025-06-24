


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

The integration is configured via `configuration.yaml`. Here's an example configuration:

New optional Value of disable_zone and override_content.
disable_zone If set to True it will disable logic looking at zone.home 
override_content can be used to override media status if a device content ID contents value of override_content. Example use case is if speaker has bluetooth in content ID override media status and turn it on. It will only play  that content in the other rooms and go back to off once that device plays other content. 

primary_delay is a number in second. default is 5 seconds. this will effect how long the sesnor will wait before primary speaker is set to none . Setting to low will result in songs being reset often when changing rooms. Setting it longer will result in longer waits between system auto start new music after there is no active speaker. 

this has all features: 

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
  Source_selector: "input_select.station"
  Sources:
    - Source: "Top Hit"
      Source_Value: "2/11"
    - Source: "Chill"
      Source_Value: "2/12"
    - Source: "Alternative"
  

```

rooms: A list of rooms. Each room is an object that has a room name and a list of devices. Each device is an object that has a device_id, device_type, and priority.
source_selector: The entity ID of the input selector that is used to select the audio source. This is a required value.
sources: The sources of audio that can be selected. The keys in this object should match the options in the source selector, and the values are the corresponding human-readable names.


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

AGS Service Preferred Primary Speaker: This sensor is similar to the Primary Speaker sensor, but it allows for a preferred primary speaker to be selected based on device priority.

## Testing

Unit tests for this integration are located in `tests/test_ags_service.py`. The
suite verifies the following helper functions and behaviors:

- `get_configured_rooms`
- `get_active_rooms`
- `update_ags_status`
- `check_primary_speaker_logic`
- `determine_primary_speaker`
- `update_speaker_states`
- `get_preferred_primary_speaker`
- `get_inactive_tv_speakers`
- `execute_ags_logic`
- `ags_select_source`

The individual test cases are grouped by the type of behavior they validate:

**Configuration**
- `test_get_configured_rooms` – verifies configured rooms are stored in
  `hass.data`.
- `test_get_active_rooms` – ensures room switches determine the active room
  list.
- `test_update_ags_status_disable_zone_true` – setting `disable_zone` prevents
  `zone.home` from forcing the service off.
- `test_default_on_behavior` – the service starts `ON` only when
  `default_on` is `True`.
- `test_default_source_used_when_blank` – the first configured source is used
  when no selection exists.
- `test_disable_tv_sources_behavior` – TV sources are excluded when
  `disable_Tv_Source` is enabled.
- `test_update_ags_status_override_when_off` – override content forces the
  status to `Override` even if the system switch is off.
- `test_async_setup_creates_sensors` – sensors load when `create_sensors` is
  `True`.
- `test_async_setup_skips_sensors` – sensors are skipped when the option is
  `False`.

**Status and Overrides**
- `test_update_ags_status_zone_off` – sets `zone.home` to `0` and expects the
  system status to become `OFF`.
- `test_update_ags_status_override` – status becomes `Override` when a device
  plays matching content.
- `test_update_ags_status_tv_mode` – a TV playing in an active room sets the
  status to `ON TV`.

**Primary Speaker Logic**
- `test_check_primary_speaker_logic_override` – override content chooses that
  speaker as primary.
- `test_determine_primary_speaker` – exercises the delayed recheck logic.
- `test_determine_primary_speaker_priority_order` – the lowest priority number
  speaker is selected when multiple are active.
- `test_determine_primary_speaker_delay_default` – confirms the default
  `primary_delay` of five seconds is used.
- `test_determine_primary_speaker_delay_custom` – verifies a custom
  `primary_delay` value is honored.
- `test_get_preferred_primary_speaker` – selects the highest priority active
  speaker.

**Speaker States**
- `test_update_speaker_states_on` – updates active speakers when AGS is `ON`.
- `test_update_speaker_states_off` – all speakers are inactive when AGS is
  `OFF`.
- `test_get_inactive_tv_speakers` – detects TVs in inactive rooms.

**Sources and HomeKit**
- `test_execute_ags_logic_calls_services` – speaker join actions trigger a
  service call.
- `test_ags_select_source_tv` – selecting the `TV` source issues the correct
  service request.
- `test_homekit_player_creation_and_sync` – creates the HomeKit media player
  when configured and keeps it in sync with the primary player.
- `test_homekit_player_absent` – no HomeKit player entity is created when the
  option is omitted.

Run the tests from the repository root with:

```bash
pytest -q
```

### Triggering Tests from Home Assistant

The service `ags_service.run_tests` executes the same test suite directly on your Home Assistant instance. Create a script that calls this service and expose it as a button to run the tests from the UI:

```yaml
script:
  ags_run_tests:
    sequence:
      - service: ags_service.run_tests
      # Optional: read the result out loud using TTS
      - delay: '00:00:01'
      - service: tts.google_translate_say
        data:
          entity_id: media_player.your_speaker
          message: >-
            {{ state_attr('persistent_notification.ags_service_tests', 'message') }}
```

Invoking the script runs the tests and posts a persistent notification with ID
`ags_service_tests`. The message begins with an overall summary line and then
lists each test result. A green check mark (✅) indicates success while a red X
(❌) indicates failure. After every icon is a brief explanation describing what
behavior the test verifies so you can see exactly why each case is included.
You can view the result from the Notifications panel (bell icon) or, as shown
above, have a TTS service announce the outcome.

Example output:

```
✅ AGS Service Tests Passed
Configuration:
  ✅ verifies configured rooms are stored in hass.data
  ✅ ensures room switches determine active rooms
  ✅ disable_zone=True ignores zone.home
  ✅ service starts ON only if default_on
  ✅ first source used when none selected
  ✅ TV sources skipped when disabled
  ✅ override works even when service off
  ✅ sensors created when enabled
  ✅ sensors skipped when disabled

Status and Overrides:
  ✅ zone.home=0 forces the system OFF
  ✅ override playback sets status
  ✅ TV playing sets status to ON TV

Primary Speaker Logic:
  ✅ override content selects that speaker as primary
  ✅ delayed recheck sets the primary speaker
  ✅ primary speaker follows priority order
  ✅ uses default primary_delay of 5s
  ✅ uses custom primary_delay value
  ✅ highest priority active speaker chosen

Speaker States:
  ✅ updates active speakers when AGS is ON
  ✅ all speakers inactive when AGS OFF
  ✅ detects TVs in inactive rooms

Sources and HomeKit:
  ✅ join service called for speaker groups
  ✅ selecting TV source issues service request
  ✅ HomeKit player created and synced
  ✅ no HomeKit player when not configured
```
