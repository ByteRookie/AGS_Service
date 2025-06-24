"""Platform for sensor integration."""
from __future__ import annotations
from datetime import timedelta

# Sensors mostly update via the state change listener below, so heavy polling
# isn't required. 30 seconds keeps them responsive without excessive work.
SCAN_INTERVAL = timedelta(seconds=30)


from homeassistant.components.sensor import SensorEntity
from homeassistant.helpers.event import async_track_state_change_event

async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    # Create your sensors
    ags_config = hass.data['ags_service']
    global SCAN_INTERVAL
    interval = ags_config.get('interval_sync', 30)
    SCAN_INTERVAL = timedelta(seconds=interval)
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
    async def state_changed_listener(event):
        """Refresh sensors when a tracked entity changes state."""
        new_state = event.data.get("new_state")
        if new_state is None:
            return
        for sensor in sensors:
            await sensor.async_update_ha_state(True)

    # Register sensors so other modules can refresh them immediately
    hass.data['ags_sensors'] = sensors

    entities_to_track = ['zone.home']
    
  

    for room in rooms:
        entities_to_track.append(f"switch.{room['room'].lower().replace(' ', '_')}_media")
        for device in room['devices']:
            entities_to_track.append(device['device_id'])

    # Register the state change listener
    async_track_state_change_event(hass, entities_to_track, state_changed_listener)

    # Add the sensors to Home Assistant
    
    async_add_entities(sensors, True)



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
   


