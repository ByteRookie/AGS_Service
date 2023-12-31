"""Platform for sensor integration."""
from __future__ import annotations
from datetime import timedelta

SCAN_INTERVAL = timedelta(seconds=1)


from homeassistant.components.sensor import SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType

import asyncio
# Setup platform function
from homeassistant.helpers.event import async_track_state_change

async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    # Create your sensors
    ags_config = hass.data['ags_service']
    rooms = ags_config['rooms']

    sensors = [
        ConfiguredRoomsSensor(hass), 
        ActiveRoomsSensor(hass), 
        ActiveSpeakersSensor(hass),
        InactiveSpeakersSensor(hass),
        AGSStatusSensor(hass),
        PrimarySpeakerSensor(hass),
        PreferredPrimarySpeakerSensor(hass),
        AGSSourceSensor( hass),
        AGSInactiveTVSpeakersSensor(hass)
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
    "sensor.ags_status"
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
    def __init__(self, hass):
        """Initialize the sensor."""
        self.hass = hass
    @property
    def unique_id(self):
        return "configured_rooms"

    @property
    def name(self):
        return "Configured Rooms"
    @property
    def state(self):
        """Return the state of the sensor."""
        configured_rooms = self.hass.data.get('configured_rooms', None)
        return configured_rooms


# Sensor for active rooms
class ActiveRoomsSensor(SensorEntity):
    """Representation of a Sensor for Active Rooms."""
    def __init__(self, hass):
        """Initialize the sensor."""
        self.hass = hass

    @property
    def unique_id(self):
        return "active_rooms"

    @property
    def name(self):
        return "AGS Active Rooms"

    @property
    def state(self):
        ags_status = self.hass.data.get('active_rooms', None)
        return ags_status


# Sensor for active speakers
class ActiveSpeakersSensor(SensorEntity):
    """Representation of a Sensor for Active Speakers."""
    def __init__(self, hass):
        """Initialize the sensor."""
        self.hass = hass

    @property

    def unique_id(self):
        return "ags_active_speakers"


    @property
    def name(self):
        return "AGS Active Speakers"

    @property
    def state(self):
        active_speakers = self.hass.data.get('active_speakers', None)
        return active_speakers

# Sensor for inactive speakers
class InactiveSpeakersSensor(SensorEntity):
    """Representation of a Sensor for Inactive Speakers."""

    def __init__(self, hass):
        """Initialize the sensor."""
        self.hass = hass

    @property

    def unique_id(self):
        return "ags_inactive_speakers"


    @property
    def name(self):
        return "AGS Inactive Speakers"

    @property
    def state(self):
        inactive_speakers = self.hass.data.get('inactive_speakers', None)
        return inactive_speakers


    
## Sensor for Status 
class AGSStatusSensor(SensorEntity):
    def __init__(self, hass):
        """Initialize the sensor."""

        self.hass = hass


    @property
    def unique_id(self):
        return "ags_status"

    @property
    def name(self):
        return "AGS Status"

    @property

    def state(self):

        ags_status = self.hass.data.get('ags_status', "OFF")

        return ags_status

    



# sensor for primary speaker #
class PrimarySpeakerSensor(SensorEntity):
    """Representation of a Sensor."""

    def __init__(self, hass):
        """Initialize the sensor."""
        self.hass = hass

    @property
    def unique_id(self):
        return "ags_primary_speaker"

    @property
    def name(self):
        return "AGS Primary Speaker"

    @property
    def state(self):
        primary_speaker = self.hass.data.get('primary_speaker', None)
        return primary_speaker

    
# sensor for back up speaker if primary is none #
class PreferredPrimarySpeakerSensor(SensorEntity):
    """Representation of a Sensor."""

    def __init__(self, hass):
        """Initialize the sensor."""
        self.hass = hass

    @property
    def unique_id(self):
        return "ags_preferred_primary"

    @property
    def name(self):
        return "AGS Preferred Primary"

    @property
    def state(self):
        preferred_primary_speaker = self.hass.data.get('preferred_primary_speaker', None)
        return preferred_primary_speaker

   
#sensor to see selected source #
class AGSSourceSensor(SensorEntity):
    """Representation of a Sensor."""
    def __init__(self, hass):
        """Initialize the sensor."""
        self.hass = hass

    @property
    def unique_id(self):
        return "ags_source"

    @property
    def name(self):
        return "AGS Source"

    @property
    def state(self):
        ags_source = self.hass.data.get('ags_media_player_source', None)
        return ags_source

# sensor to see speakers for tv's that are inactive #
class AGSInactiveTVSpeakersSensor(SensorEntity):
    """Representation of a Sensor."""
    def __init__(self, hass):
        """Initialize the sensor."""
        self.hass = hass

    @property
    def unique_id(self):
        return "ags_inactive_tv_speakers"

    @property
    def name(self):
        return "AGS Inactive TV Speakers"

    @property
    def state(self):
        ags_inactive_tv_speakers = self.hass.data.get('ags_inactive_tv_speakers', None)
        return ags_inactive_tv_speakers
   


