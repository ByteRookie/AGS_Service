"""Platform for sensor integration."""
from __future__ import annotations
from datetime import timedelta

SCAN_INTERVAL = timedelta(seconds=10)

from homeassistant.components.sensor import SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType

# Setup platform function
from homeassistant.helpers.event import async_track_state_change

async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    # Create your sensors
    ags_config = hass.data['ags_service']
    rooms = ags_config['rooms']
    sensors = [
        ConfiguredRoomsSensor(rooms), 
        ActiveRoomsSensor(rooms, hass), 
        ActiveSpeakersSensor(rooms, hass),
        InactiveSpeakersSensor(rooms, hass),
        AGSStatusSensor(hass, rooms),
        PrimarySpeakerSensor(rooms, hass),
        PreferredPrimarySpeakerSensor(rooms, hass),
        AGSSourceSensor(ags_config, hass),
        AGSInactiveTVSpeakersSensor(rooms, hass)
    ]

    # Define a function to be called when a tracked entity changes its state
    def state_changed_listener(entity_id, old_state, new_state):
        # Make sure the new state is not None
        if new_state is None:
            return
        # Trigger an update of your sensor
        for sensor in sensors:
            hass.async_create_task(sensor.async_update_ha_state(True))

    # List of entity ids to track
    sensor_entity_ids = [
    "sensor.configured_rooms",
    "sensor.active_rooms",
    "sensor.active_speakers",
    "sensor.inactive_speakers",
    "sensor.ags_status",
    "sensor.primary_speaker",
    "sensor.preferred_primary_speaker",
    "sensor.ags_source",
    "sensor.ags_inactive_tv_speakers",
    ]
    entities_to_track = ['zone.home']
    entities_to_track.extend(sensor_entity_ids)
    for room in rooms:
        entities_to_track.append(f"switch.{room['room'].lower().replace(' ', '_')}_media")
        for device in room['devices']:
            entities_to_track.append(device['device_id'])

    # Register the state change listener
    async_track_state_change(hass, entities_to_track, state_changed_listener)

    # Add the sensors to Home Assistant
    async_add_entities(sensors, True)



# Sensor for configured rooms
class ConfiguredRoomsSensor(SensorEntity):
    """Representation of a Sensor for Configured Rooms."""

    _attr_name = "Configured Rooms"

    def __init__(self, rooms):
        """Initialize the sensor."""
        self.rooms = rooms

    @property
    def state(self):
        """Return the state of the sensor."""
        # The state is a list of all configured rooms
        return [room['room'] for room in self.rooms]



# Sensor for active rooms
class ActiveRoomsSensor(SensorEntity):
    """Representation of a Sensor for Active Rooms."""

    _attr_name = "AGS Active Rooms"

    def __init__(self, rooms, hass):
        """Initialize the sensor."""
        self.rooms = rooms
        self.hass = hass
        self._state = None

    @property
    def state(self):
        """Return the state of the sensor."""
        return self._state

    async def async_update(self):
        """Fetch new state data for the sensor."""
        # The state is a list of active rooms
        active_rooms = []
        home_audio_status = self.hass.states.get('sensor.ags_status')
        if home_audio_status is not None and home_audio_status.state == 'OFF':

            self._state = []
            return

        for room in self.rooms:
            room_switch = self.hass.states.get(f"switch.{room['room'].lower().replace(' ', '_')}_media")
            if room_switch is not None and room_switch.state == 'on':
                active_rooms.append(room['room'])
            else:
                for device in room['devices']:
                    if device['device_type'] == 'tv':
                        device_state = self.hass.states.get(device['device_id'])
                        if device_state and device_state.state != 'off':
                            active_rooms.append(room['room'])
                            break

        self._state = active_rooms


# Sensor for active speakers
class ActiveSpeakersSensor(SensorEntity):
    """Representation of a Sensor for Active Speakers."""

    _attr_name = "AGS Active Speakers"

    def __init__(self, rooms, hass):
        """Initialize the sensor."""
        self.rooms = rooms
        self.hass = hass
        self._state = None

    @property
    def state(self):
           ags_status_entity = self.hass.states.get('sensor.ags_status')
        if ags_status_entity is not None and ags_status_entity.state == 'off':
            active_speakers = []
        else:
            active_rooms_entity = self.hass.states.get('sensor.ags_active_rooms')
            active_rooms = active_rooms_entity.state if active_rooms_entity is not None else None
            active_speakers = [] if active_rooms is None else [device['device_id'] for room in self.rooms for device in room['devices'] if room['room'] in active_rooms and device['device_type'] == 'speaker']
        self._state = active_speakers
        return self._state


# Sensor for inactive speakers
class InactiveSpeakersSensor(SensorEntity):
    """Representation of a Sensor for Inactive Speakers."""

    _attr_name = "AGS Inactive Speakers"

    def __init__(self, rooms, hass):
        """Initialize the sensor."""
        self.rooms = rooms
        self.hass = hass
        self._state = None

    @property
    def state(self):
        """Return the state of the sensor."""
        # The state is a list of speaker devices not in active rooms
        ags_status_entity = self.hass.states.get('sensor.ags_status')
        if ags_status_entity is not None and ags_status_entity.state == 'off':
            all_speakers = [device['device_id'] for room in self.rooms for device in room['devices'] if device['device_type'] == 'speaker']
            self._state = all_speakers
        else:
            active_rooms_entity = self.hass.states.get('sensor.ags_active_rooms')
            active_rooms = active_rooms_entity.state if active_rooms_entity is not None else None
            inactive_speakers = [] if active_rooms is None else [device['device_id'] for room in self.rooms for device in room['devices'] if room['room'] not in active_rooms and device['device_type'] == 'speaker' and self.hass.states.get(device['device_id']) and self.hass.states.get(device['device_id']).state != 'on']
            self._state = inactive_speakers
        return self._state

class AGSStatusSensor(SensorEntity):
    def __init__(self, hass, rooms):
        self.rooms = rooms
        self.hass = hass

    @property
    def unique_id(self):
        return "ags_status"

    @property
    def name(self):
        return "AGS Status"

    @property
    def state(self):
        # Check if the state of 'zone.home' is '0'
        if self.hass.states.get('zone.home').state == '0':
            return "OFF"

        # Check the state of the Media System switch
        media_system_state = self.hass.states.get('switch.media_system')
        if media_system_state is None:
            return "Waiting"
        elif media_system_state.state == 'on':
            # Check the state of all devices with type "TV"
            for room in self.rooms:
                for device in room['devices']:
                    if device['device_type'] == 'tv' and self.hass.states.get(device['device_id']) is not None and self.hass.states.get(device['device_id']).state != 'off':
                        return "ON TV"

            return "ON"

        elif media_system_state.state == 'off':
            override_devices = sorted([device for room in self.rooms for device in room['devices'] if 'override_content' in device], key=lambda x: x['priority'])
            for device in override_devices:
                device_state = self.hass.states.get(device['device_id'])
                if device_state is not None and device_state.attributes.get('media_content_id') == device['override_content']:
                    return "Override"

        return "OFF"




class PrimarySpeakerSensor(SensorEntity):
    """Representation of a Sensor."""

    def __init__(self, rooms, hass):
        """Initialize the sensor."""
        self._state = None
        self.rooms = rooms
        self.hass = hass
        self._attr_name = "AGS Primary Speaker"
        self._attr_unique_id = "ags_primary_speaker"

    @property
    def state(self):
        """Return the state of the sensor."""
        ags_status = self.hass.states.get('sensor.ags_status')
        active_rooms_entity = self.hass.states.get('sensor.ags_active_rooms')
        active_rooms = active_rooms_entity.state if active_rooms_entity is not None else None
        if ags_status is None:
            return None
        if ags_status.state == 'off':
            # If AGS status is 'off', primary speaker is blank
            return ""
        elif ags_status.state == 'Override':
            # Master audio status is 'Override'
            override_devices = sorted([device for room in self.rooms for device in room['devices'] if 'override_content' in device], key=lambda x: x['priority'])
            for device in override_devices:
                device_state = self.hass.states.get(device['device_id'])
                if device_state is not None and device_state.attributes.get('media_content_id') == device['override_content']:
                    return device['device_id']
        else:
            # AGS status is not 'off' or 'Override'
            for room in self.rooms:
                if active_rooms is not None and room['room'] in active_rooms:
                    sorted_devices = sorted(room["devices"], key=lambda x: x['priority'])
                    for device in sorted_devices:
                        device_state = self.hass.states.get(device['device_id'])
                        if device['device_type'] == 'tv' and device_state is not None and device_state.state != 'off':
                            speaker_in_same_room = next((d for d in sorted_devices if d['device_type'] == 'speaker'), None)
                            if speaker_in_same_room is not None:
                                speaker_state = self.hass.states.get(speaker_in_same_room['device_id'])
                                if speaker_state is not None and speaker_state.attributes.get('source') == 'TV' and speaker_state.attributes.get('group_members')[0] == speaker_in_same_room['device_id']:
                                    return speaker_in_same_room['device_id']
                            return device['device_id']
                        elif device['device_type'] == 'speaker' and device_state is not None and device_state.state != 'off' and device_state.attributes.get('group_members')[0] == device['device_id']:
                            return device['device_id']
        # If none of the conditions are met, the primary speaker is 'none'
        return "none"

class PreferredPrimarySpeakerSensor(SensorEntity):
    """Representation of a Sensor."""

    def __init__(self, rooms, hass):
        """Initialize the sensor."""
        self._state = None
        self.rooms = rooms
        self.hass = hass
        self._attr_name = "AGS Preferred Primary"
        self._attr_unique_id = "ags_preferred_primary"

    @property
    def state(self):
        """Return the state of the sensor."""
        active_speakers_entity = self.hass.states.get('sensor.ags_active_speakers')
        active_speakers = active_speakers_entity.state if active_speakers_entity is not None else None

        if not active_speakers:
            return "none"
        
        # Generate a list of all devices in active speakers
        all_devices = [device for room in self.rooms for device in room['devices'] if device['device_id'] in active_speakers]

        # Sort the devices by priority (lowest number first)
        sorted_devices = sorted(all_devices, key=lambda x: x['priority'])

        # Return the device_id of the highest priority device
        return sorted_devices[0]['device_id'] if sorted_devices else "none"

class AGSSourceSensor(SensorEntity):
    """Representation of a Sensor."""

    def __init__(self, hass, config):
        """Initialize the sensor."""
        self._state = None
        self.config = config
        self.hass = hass
        self._attr_name = "AGS Source"

    @property
    def state(self):
        """Return the state of the sensor."""
        ags_status_state = self.hass.states.get('sensor.ags_status')
        if ags_status_state is not None:
            if ags_status_state.state == 'ON TV':
                return "TV"
            elif ags_status_state.state == 'ON':
                source_selector_state = self.hass.states.get(self.config['Source_selector'])
                if source_selector_state is not None:
                    for source in self.config['Sources']:
                        if source['Source'] == source_selector_state.state:
                            return source['Source_Value']
        return ""


class AGSInactiveTVSpeakersSensor(SensorEntity):
    """Representation of a Sensor."""

    def __init__(self, rooms, hass):
        """Initialize the sensor."""
        self._state = None
        self.rooms = rooms
        self.hass = hass
        self._attr_name = "AGS Inactive TV Speakers"
        self._attr_unique_id = "ags_inactive_tv_speakers"

    @property
    def state(self):
        """Return the state of the sensor."""
        active_rooms_state = self.hass.states.get('sensor.ags_active_rooms')
        inactive_rooms = [room for room in self.rooms if active_rooms_state is not None and room['room'] not in active_rooms_state.state]
        inactive_tv_speakers = [device['device_id'] for room in inactive_rooms for device in room['devices'] if device['device_type'] == 'speaker' and any(d['device_type'] == 'tv' for d in room['devices'])]
        self._state = inactive_tv_speakers
        return self._state

