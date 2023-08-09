from homeassistant.helpers.restore_state import RestoreEntity

from homeassistant.components.media_player import MediaPlayerEntity
from homeassistant.components.media_player.const import (
    SUPPORT_TURN_ON as _SUPPORT_TURN_ON, 
    SUPPORT_TURN_OFF as _SUPPORT_TURN_OFF, 
    SUPPORT_PLAY,
    SUPPORT_PAUSE,
    SUPPORT_STOP,
    SUPPORT_NEXT_TRACK,
    SUPPORT_PREVIOUS_TRACK,
    SUPPORT_SELECT_SOURCE,
    MEDIA_TYPE_MUSIC,
    SUPPORT_BROWSE_MEDIA,
    SUPPORT_VOLUME_SET,
)

from homeassistant.const import STATE_IDLE, STATE_PLAYING, STATE_PAUSED
from homeassistant.helpers.event import async_track_state_change

async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    
    ags_media_player = AGSPrimarySpeakerMediaPlayer(hass)
    async_add_entities([ags_media_player])
    
    # Set up a listener to monitor changes to sensor.ags_primary_speaker
    async_track_state_change(hass, "sensor.ags_primary_speaker",'sensor.ags_status', ags_media_player.async_primary_speaker_changed)

    # Set up a listener to monitor changes to the primary speaker (from hass.data)
    primary_speaker_entity_id = hass.data.get('primary_speaker')
    if primary_speaker_entity_id:
        async_track_state_change(hass, primary_speaker_entity_id, ags_media_player.async_primary_speaker_device_changed)


class AGSPrimarySpeakerMediaPlayer(MediaPlayerEntity, RestoreEntity):
    async def async_added_to_hass(self):
        """When entity is added to hass."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state:
            self.hass.data["ags_media_player_source"] = last_state.attributes.get("source")

    def __init__(self, hass):
        """Initialize the media player."""
        self._hass = hass
        self._name = "AGS Media Player"
        self._state = STATE_IDLE
        self.primary_speaker_entity_id = None
        self.primary_speaker_state = None   # Initialize the attribute
        self.ags_status = None

    def update(self):
        """Fetch latest state."""

        ags_status = self.hass.states.get('sensor.ags_status').state

        found_room = False
        for room in self.hass.data['ags_service']['rooms']:
            for device in room["devices"]:
                if device["device_id"] == self.hass.data.get('primary_speaker'):
                    primary_speaker_room = room["room"]
                    found_room = True
                    break
            if found_room:
                break


        if ags_status == "ON TV" and primary_speaker_room:
            streaming_device_in_room = None
            tv_device_in_room = None

            for device in room["devices"]:
                if device["device_type"] == "streaming_device":
                    streaming_device_in_room = device["device_id"]
                    break
                elif device["device_type"] == "tv":
                    tv_device_in_room = device["device_id"]

            if streaming_device_in_room:
                self.primary_speaker_entity_id = streaming_device_in_room
            elif tv_device_in_room:
                self.primary_speaker_entity_id = tv_device_in_room
            else:
                self.primary_speaker_entity_id = self.hass.data.get('primary_speaker', None)
        else:
            self.primary_speaker_entity_id = self.hass.data.get('primary_speaker', None)

        if self.primary_speaker_entity_id:
            self.primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id)


    async def async_primary_speaker_changed(self, entity_id, old_state, new_state):
        # Update primary speaker entity ID when sensor.ags_primary_speaker changes
        self.update_primary_speaker_entity_id()
        self.async_schedule_update_ha_state(True)

    @property
    def unique_id(self):
        return "ags_media_player"

    @property
    def name(self):
        return self.primary_speaker_state.attributes.get('friendly_name') if self.primary_speaker_state else "AGS Media Player"

    @property
    def state(self):
        # Check the status in hass.data
        if self.ags_status == 'OFF':
            return "off"
        
        # Fetch the current state of the AGS Primary Speaker entity
        if self.primary_speaker_entity_id:
            self.primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id)
            
            # If self.primary_speaker_state is None, then the entity ID might be incorrect
            if self.primary_speaker_state is None:
                return "Error no state"
            
            # Return the state of the primary speaker
            return self.primary_speaker_state.state
        else:
            return "Error no state 2"

    @property
    def media_title(self):
        
        return self.primary_speaker_state.attributes.get('media_title') if self.primary_speaker_state else None

    @property
    def media_artist(self):
        
        return self.primary_speaker_state.attributes.get('media_artist') if self.primary_speaker_state else None

    @property
    def entity_picture(self):
        
        return self.primary_speaker_state.attributes.get('entity_picture') if self.primary_speaker_state else None
    @property
    def is_volume_muted(self):
        
        return self.primary_speaker_state.attributes.get('is_volume_muted') if self.primary_speaker_state else None

    def set_volume_level(self, volume):
        """Set the volume level for all active speakers."""
        active_speakers = self.hass.data.get('active_speakers', [])
        self.hass.services.call('media_player', 'volume_set', {
            'entity_id': active_speakers,
            'volume_level': volume,
        })

    @property
    def volume_level(self):
        """Return the volume level of the media player."""
        active_speakers = self.hass.data.get('active_speakers', [])
        total_volume = 0
        count = 0

        for speaker in active_speakers:
            state = self.hass.states.get(speaker)
            if state and 'volume_level' in state.attributes:
                total_volume += state.attributes['volume_level']
                count += 1

        if count == 0:
            return 0
        return total_volume / count

    @property
    def media_content_type(self):
        
        return self.primary_speaker_state.attributes.get('media_content_type') if self.primary_speaker_state else None
    @property
    def shuffle(self):
        
        return self.primary_speaker_state.attributes.get('shuffle') if self.primary_speaker_state else None
    @property
    def repeat(self):
        
        return self.primary_speaker_state.attributes.get('repeat') if self.primary_speaker_state else None

    @property
    def media_duration(self):
        
        return self.primary_speaker_state.attributes.get('media_duration') if self.primary_speaker_state else None
    @property
    def media_position(self):
        
        return self.primary_speaker_state.attributes.get('media_position') if self.primary_speaker_state else None
    @property
    def queue_size(self):
        
        return self.primary_speaker_state.attributes.get('queue_size') if self.primary_speaker_state else None




    @property
    def media_position_updated_at(self):
        
        return self.primary_speaker_state.attributes.get('media_position_updated_at') if self.primary_speaker_state else None
    @property
    def supported_features(self):
        return (SUPPORT_BROWSE_MEDIA | SUPPORT_PLAY | SUPPORT_PAUSE | SUPPORT_STOP |
                SUPPORT_NEXT_TRACK | SUPPORT_PREVIOUS_TRACK | SUPPORT_SELECT_SOURCE | SUPPORT_VOLUME_SET | _SUPPORT_TURN_ON | _SUPPORT_TURN_OFF)

    # Implement methods to control the AGS Primary Speaker

    def media_play(self):
        self.hass.services.call('media_player', 'media_play', {'entity_id': self.primary_speaker_entity_id})

    def media_pause(self):
        self.hass.services.call('media_player', 'media_pause', {'entity_id': self.primary_speaker_entity_id})

    def media_stop(self):
        self.hass.services.call('media_player', 'media_stop', {'entity_id': self.primary_speaker_entity_id})

    def media_next_track(self):
        self.hass.services.call('media_player', 'media_next_track', {'entity_id': self.primary_speaker_entity_id})

    def turn_on(self):
        self.hass.services.call('switch', 'turn_on', {'entity_id': 'switch.media_system'})

    def turn_off(self):
        self.hass.services.call('switch', 'turn_off', {'entity_id': 'switch.media_system'})

    def media_previous_track(self):
        self.hass.services.call('media_player', 'media_previous_track', {'entity_id': self.primary_speaker_entity_id})
    
    @property
    def source_list(self):
        """List of available sources."""
        sources = [source_dict["Source"] for source_dict in self.hass.data['ags_service']['Sources']]
        # Check if any device has a type of TV and add "TV" to the source list
        if any(device.get("device_type") == "tv" for room in self.hass.data['ags_service']['rooms'] for device in room["devices"]):
            sources.append("TV")
        return sources

    @property
    def source(self):
        """Return the current input source."""
        return self.hass.data.get("ags_media_player_source")


    def get_source_value_by_name(self, source_name):
        for source_dict in self.hass.data['ags_service']['Sources']:
            if source_dict["Source"] == source_name:
                return source_dict["Source_Value"]
        return None  # if not found

    def select_source(self, source):
        """Select input source."""
        if source == "TV":
            # If the source is TV, call the media_player.select_source service
            self.hass.services.call("media_player", "select_source", {
                "source": "TV",
                "entity_id": self.hass.data['primary_speaker']
            })
        else:
            # Update the source in hass.data
            self.hass.data["ags_media_player_source"] = source
            
            # Fetch the corresponding source_value from the source list
            for src in self.hass.data['ags_service']['Sources']:
                if src["Source"] == source:
                    source_value = src["Source_Value"]
                    break

            # Call the play_media service with the updated media_content_id
            self.hass.services.call('media_player', 'play_media', {
                'entity_id': self.hass.data['primary_speaker'],
                'media_content_id': source_value,
                'media_content_type': 'favorite_item_id'
            })
    async def async_browse_media(self, media_content_type=None, media_content_id=None):
        """Implement the media browsing helper."""
        if media_content_type in [None, "library"]:
            # Return the root media directory
            return await self._browse_root()

        # Handle other media_content_type cases if necessary

    async def _browse_root(self):
        """Return the root media directory."""
        self.primary_speaker_state = self.hass.states.get(self.hass.data['primary_speaker'])
        
        if not self.primary_speaker_state:
            raise ValueError(f"Entity {self.hass.data['primary_speaker']} not found")

        media_content_type = self.primary_speaker_state.attributes.get('media_content_type')
        media_content_id = self.primary_speaker_state.attributes.get('media_content_id')
        media_title = self.primary_speaker_state.attributes.get('media_title')

        # Return root directory
        return {
            "title": "Root",
            "media_content_type": "library",
            "media_content_id": "root",
            "can_play": True,
            "can_expand": True,
            "children": [
                {
                    "title": media_title,
                    "media_content_type": media_content_type,
                    "media_content_id": media_content_id,
                    "can_play": True,
                    "can_expand": False,
                }
            ],
        }

