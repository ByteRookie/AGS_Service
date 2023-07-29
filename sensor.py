"""Platform for sensor integration."""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType

# Setup platform function
def setup_platform(
    hass: HomeAssistant,
    config: ConfigType,
    add_entities: AddEntitiesCallback,
    discovery_info: DiscoveryInfoType | None = None
) -> None:
    """Set up the sensor platform."""
    # Retrieve the room information from the shared data
    rooms = hass.data['ags_service']
    # Add the sensor entities
    add_entities([
        ConfiguredRoomsSensor(rooms), 
        ActiveRoomsSensor(rooms, hass), 
        ActiveSpeakersSensor(rooms, hass),
        InactiveSpeakersSensor(rooms, hass)
    ])

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

    _attr_name = "AGS Service Active Rooms"

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
        home_audio_status = self.hass.states.get('sensor.home_audio_status')
        if home_audio_status.state == 'off':
            self._state = []
            return

        for room in self.rooms:
            room_switch = self.hass.states.get(f"switch.{room['room'].lower().replace(' ', '_')}_media")
            if room_switch.state == 'on':
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

    _attr_name = "AGS Service Active Speakers"

    def __init__(self, rooms, hass):
        """Initialize the sensor."""
        self.rooms = rooms
        self.hass = hass
        self._state = None

    @property
    def state(self):
        """Return the state of the sensor."""
        # The state is a list of speaker devices in active rooms
        active_rooms = self.hass.states.get('sensor.ags_service_active_rooms').state
        active_speakers = [device['device_id'] for room in self.rooms for device in room['devices'] if room['room'] in active_rooms and device['device_type'] == 'speaker']
        self._state = active_speakers
        return self._state

# Sensor for inactive speakers
class InactiveSpeakersSensor(SensorEntity):
    """Representation of a Sensor for Inactive Speakers."""

    _attr_name = "AGS Service Inactive Speakers"

    def __init__(self, rooms, hass):
        """Initialize the sensor."""
        self.rooms = rooms
        self.hass = hass
        self._state = None

    @property
    def state(self):
        """Return the state of the sensor."""
        # The state is a list of speaker devices not in active rooms
        active_rooms = self.hass.states.get('sensor.ags_service_active_rooms').state
        inactive_speakers = [device['device_id'] for room in self.rooms for device in room['devices'] if room['room'] not in active_rooms and device['device_type'] == 'speaker' and self.hass.states.get(device['device_id']) and self.hass.states.get(device['device_id']).state != 'on']
        self._state = inactive_speakers
        return self._state
