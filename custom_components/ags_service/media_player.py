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
    SUPPORT_VOLUME_SET,
    SUPPORT_SEEK,
    SUPPORT_SHUFFLE_SET,
    SUPPORT_REPEAT_SET,
)
from homeassistant.const import STATE_IDLE, STATE_PLAYING, STATE_PAUSED
from homeassistant.helpers.event import async_track_state_change

async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    
    ags_media_player = AGSPrimarySpeakerMediaPlayer(hass)
    async_add_entities([ags_media_player])
    
    # Set up a listener to monitor changes to sensor.ags_primary_speaker
    async_track_state_change(hass, "switch.media_system", ags_media_player.async_primary_speaker_changed)


    # Set up a listener to monitor changes to the primary speaker (from hass.data)
    keys_to_check = ['primary_speaker', 'ags_status', 'active_rooms', 'active_speakers', 'ags_media_player_source' ]

    for key in keys_to_check:
        entity_id = hass.data.get(key)
        if entity_id:
            async_track_state_change(hass, entity_id, ags_media_player.async_primary_speaker_changed)

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
        self.primary_speaker_room = None

    def update(self):
        """Fetch latest state."""


        self.ags_status = self.hass.data.get('ags_status', 'OFF')


        found_room = False
        for room in self.hass.data['ags_service']['rooms']:
            for device in room["devices"]:
                if device["device_id"] == self.hass.data.get('primary_speaker'):
                    self.primary_speaker_room = room["room"]
                    found_room = True
                    break
            if found_room:
                break


        if self.ags_status == "ON TV" and self.primary_speaker_room:
            selected_device_id = None
            
            # Filter out speaker devices and sort remaining devices by priority
            sorted_devices = sorted(
                [device for device in room["devices"] if device["device_type"] != "speaker"],
                key=lambda x: x['priority']
            )
            
            # If there's a device in the sorted list, use its ID. Otherwise, default to primary speaker.
            selected_device_id = sorted_devices[0]["device_id"] if sorted_devices else self.hass.data.get('primary_speaker', None)
            
            self.primary_speaker_entity_id = selected_device_id
        else:
            self.primary_speaker_entity_id = self.hass.data.get('primary_speaker', None)

        if self.primary_speaker_entity_id:
            self.primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id)



    async def async_primary_speaker_changed(self, entity_id, old_state, new_state):
        # Update primary speaker entity ID when sensor.ags_primary_speaker changes
        self.update()
        self.async_schedule_update_ha_state(True)

    ### put extra here 



    @property
    def unique_id(self):
        return "ags_media_player"

    @property
    def name(self):
        """Return the name of the sensor."""
        room_count = len(self.hass.data.get('active_rooms', []))
        
        if self.primary_speaker_room is None:
            rooms_text = "System Starting"
        else:
            rooms_text = self.primary_speaker_room

        if self.ags_status == "OFF":
            return "Media System is off"
        elif room_count == 1 :
            return rooms_text + " is Active"
        elif room_count > 1:
            return rooms_text + " + " + str(room_count-1) + " Active"
        else: 
            return "All Rooms are off"

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
        return ( SUPPORT_SEEK |SUPPORT_PLAY | SUPPORT_PAUSE | SUPPORT_STOP | SUPPORT_SHUFFLE_SET | SUPPORT_REPEAT_SET |
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
  
    def media_seek(self, position):
        """Seek to a specific point in the media on the primary speaker."""
        self._hass.services.call(
            'media_player', 'media_seek',
            {
                'entity_id': self.primary_speaker_entity_id,
                'seek_position': position
            }
        )    
    @property
    def source_list(self):
        """List of available sources."""
        if self.ags_status == "ON TV":
            sources = self.primary_speaker_state.attributes.get('source_list') if self.primary_speaker_state else None 

        else:
            sources = [source_dict["Source"] for source_dict in self.hass.data['ags_service']['Sources']]
            # Check if any device has a type of TV and add "TV" to the source list
            if any(device.get("device_type") == "tv" for room in self.hass.data['ags_service']['rooms'] for device in room["devices"]):
                sources.append("TV")

        return sources

    @property
    def source(self):
        """Return the current input source."""
        if self.ags_status == "ON TV":
            return self.primary_speaker_state.attributes.get('source') if self.primary_speaker_state else None 
        else:
            return self.hass.data.get("ags_media_player_source")

    def get_source_value_by_name(self, source_name):
        for source_dict in self.hass.data['ags_service']['Sources']:
            if source_dict["Source"] == source_name:
                return source_dict["Source_Value"]
        return None  # if not found

    def select_source(self, source):
        """Select input source."""
        if source == "TV" or self.ags_status == "ON TV":
            # If the source is TV, call the media_player.select_source service
            self.hass.services.call("media_player", "select_source", {
                "source": source,
                "entity_id": self.primary_speaker_entity_id
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

    @property
    def shuffle(self):
        """Return the shuffle state of the primary speaker."""
        
        if self.primary_speaker_state:
            return self.primary_speaker_state.attributes.get('shuffle', False)
        return False

    @property
    def repeat(self):
        """Return the repeat state of the primary speaker."""
        if self.primary_speaker_state:
            return self.primary_speaker_state.attributes.get('repeat', 'off')
        return 'off'

    def set_shuffle(self, shuffle):
        """Enable/Disable shuffle mode."""
        self.hass.services.call('media_player', 'shuffle_set', {
            'entity_id': self.primary_speaker_entity_id,
            'shuffle': not self.shuffle
        })

    def set_repeat(self, repeat):
        """Set repeat mode."""
        if self.repeat == "off":
            repeat_value = "one"
        elif self.repeat=="one":
            repeat_value = "all"
        else:
            repeat_value = "off"

        self.hass.services.call('media_player', 'repeat_set', {
            'entity_id': self.primary_speaker_entity_id,
            'repeat':  repeat_value
        })



