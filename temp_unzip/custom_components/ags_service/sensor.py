"""Platform for sensor integration."""
from __future__ import annotations
from datetime import timedelta

from homeassistant.components.sensor import SensorEntity, SensorDeviceClass
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from . import DOMAIN, SIGNAL_AGS_RELOAD

# Sensors mostly update via the state change listener below, so heavy polling
# isn't required. 30 seconds keeps them responsive without excessive work.
SCAN_INTERVAL = timedelta(seconds=30)

async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    # Create your sensors
    ags_config = hass.data[DOMAIN]
    global SCAN_INTERVAL
    interval = ags_config.get('interval_sync', 30)
    SCAN_INTERVAL = timedelta(seconds=interval)

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
        old_state = event.data.get("old_state")
        new_state = event.data.get("new_state")
        
        if old_state is None or new_state is None:
            return
            
        # Filter out spam: Only trigger if the actual state, group, or source changed
        state_changed = old_state.state != new_state.state
        group_changed = old_state.attributes.get("group_members") != new_state.attributes.get("group_members")
        source_changed = old_state.attributes.get("source") != new_state.attributes.get("source")
        
        if not (state_changed or group_changed or source_changed):
            return  # Ignore media_position clock ticks

        # Second level check: avoid updates if only state is same and group is same
        if old_state.state == new_state.state and not group_changed:
            # Still check source to be sure
            if not source_changed:
                return
            
        for sensor in sensors:
            await sensor.async_update_ha_state(True)

    # Register sensors so other modules can refresh them immediately
    hass.data['ags_sensors'] = sensors

    tracked_entities = set()
    unsubs = []

    def update_tracked_entities():
        nonlocal unsubs, tracked_entities
        
        # Unsubscribe old trackers
        for unsub in unsubs:
            unsub()
        unsubs = []
        tracked_entities = set(['zone.home'])
        
        cfg = hass.data[DOMAIN]
        rooms = cfg.get('rooms', [])
        
        schedule_cfg = cfg.get('schedule_entity')
        if schedule_cfg and schedule_cfg.get('entity_id'):
            tracked_entities.add(schedule_cfg['entity_id'])
            
        if cfg.get("create_sensors"):
            tracked_entities.add("switch.ags_actions")
            
        for room in rooms:
            safe_room_id = "".join(c for c in room.get('room', '').lower().replace(' ', '_') if c.isalnum() or c == '_')
            if safe_room_id:
                tracked_entities.add(f"switch.{safe_room_id}_media")
            for device in room.get("devices", []):
                tracked_entities.add(device["device_id"])
                
        # Create new trackers
        if tracked_entities:
            unsubs.append(async_track_state_change_event(
                hass, list(tracked_entities), state_changed_listener
            ))

    # Initial tracking
    update_tracked_entities()

    # Listen for hot reload to update tracking
    async_dispatcher_connect(hass, SIGNAL_AGS_RELOAD, update_tracked_entities)

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
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = ["ON", "ON TV", "Override", "OFF"]

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
   


