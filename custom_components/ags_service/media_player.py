
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
)

from homeassistant.const import STATE_IDLE, STATE_PLAYING, STATE_PAUSED
from homeassistant.helpers.event import async_track_state_change

async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    ags_media_player = AGSPrimarySpeakerMediaPlayer(hass)
    async_add_entities([ags_media_player])
    
    # Set up a listener to monitor changes to sensor.ags_primary_speaker
    async_track_state_change(hass, "sensor.ags_primary_speaker", ags_media_player.async_primary_speaker_changed)

    # Set up a listener to monitor changes to the primary speaker (from hass.data)
    primary_speaker_entity_id = hass.data.get('primary_speaker')
    if primary_speaker_entity_id:
        async_track_state_change(hass, primary_speaker_entity_id, ags_media_player.async_primary_speaker_device_changed)


class AGSPrimarySpeakerMediaPlayer(MediaPlayerEntity):
    def __init__(self, hass):
        self.hass = hass
        self.update_primary_speaker_entity_id()

    def update_primary_speaker_entity_id(self):
        self.primary_speaker_entity_id = self.hass.data.get('primary_speaker')
        if isinstance(self.primary_speaker_entity_id, list):
            self.primary_speaker_entity_id = self.primary_speaker_entity_id[0]

    async def async_primary_speaker_changed(self, entity_id, old_state, new_state):
        # Update primary speaker entity ID when sensor.ags_primary_speaker changes
        self.update_primary_speaker_entity_id()
        self.async_schedule_update_ha_state(True)

    @property
    def unique_id(self):
        return "ags_media_player"

    @property
    def name(self):
        primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id) if self.primary_speaker_entity_id else None
        return primary_speaker_state.attributes.get('friendly_name') if primary_speaker_state else "AGS Media Player"

    @property
    def state(self):
        # Fetch the current state of the AGS Primary Speaker entity
        primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id) if self.primary_speaker_entity_id else None

        media_system_switch_entity_id = self.hass.data.get('ags_status')  # Get the entity_id of the switch from hass.data
        media_system_switch_obj = self.hass.states.get(media_system_switch_entity_id)  # Fetch the state object for the switch
        media_system_switch_state = media_system_switch_obj.state if media_system_switch_obj else None  # Get the state value

        if media_system_switch_state == 'off':
            return "off"
        return primary_speaker_state.state if primary_speaker_state else STATE_IDLE

    @property
    def media_title(self):
        primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id) if self.primary_speaker_entity_id else None
        return primary_speaker_state.attributes.get('media_title') if primary_speaker_state else None

    @property
    def media_artist(self):
        primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id) if self.primary_speaker_entity_id else None
        return primary_speaker_state.attributes.get('media_artist') if primary_speaker_state else None

    @property
    def entity_picture(self):
        primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id) if self.primary_speaker_entity_id else None
        return primary_speaker_state.attributes.get('entity_picture') if primary_speaker_state else None
    @property
    def is_volume_muted(self):
        primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id) if self.primary_speaker_entity_id else None
        return primary_speaker_state.attributes.get('is_volume_muted') if primary_speaker_state else None

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
        primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id) if self.primary_speaker_entity_id else None
        return primary_speaker_state.attributes.get('media_content_type') if primary_speaker_state else None
    @property
    def shuffle(self):
        primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id) if self.primary_speaker_entity_id else None
        return primary_speaker_state.attributes.get('shuffle') if primary_speaker_state else None
    @property
    def repeat(self):
        primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id) if self.primary_speaker_entity_id else None
        return primary_speaker_state.attributes.get('repeat') if primary_speaker_state else None

    @property
    def media_duration(self):
        primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id) if self.primary_speaker_entity_id else None
        return primary_speaker_state.attributes.get('media_duration') if primary_speaker_state else None
    @property
    def media_position(self):
        primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id) if self.primary_speaker_entity_id else None
        return primary_speaker_state.attributes.get('media_position') if primary_speaker_state else None
    @property
    def queue_size(self):
        primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id) if self.primary_speaker_entity_id else None
        return primary_speaker_state.attributes.get('queue_size') if primary_speaker_state else None




    @property
    def media_position_updated_at(self):
        primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id) if self.primary_speaker_entity_id else None
        return primary_speaker_state.attributes.get('media_position_updated_at') if primary_speaker_state else None
    @property
    def supported_features(self):
        return (SUPPORT_PLAY | SUPPORT_PAUSE | SUPPORT_STOP |
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
        return [source_dict["Source"] for source_dict in self.hass.data['ags_service']['Sources']]

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
        # Update the source in hass.data
        self.hass.data["ags_media_player_source"] = source
        
        # Fetch the corresponding source_value from the source list
        for src in self.hass.data['ags_service']['Sources']:
            if src["Source"] == source:
                source_value = src["Source_Value"]
                break
                
        # Append "FV:" to the source value
        media_content_id = "FV:" + source_value

        # Call the play_media service with the updated media_content_id
        self.hass.services.call('media_player', 'play_media', {
            'entity_id': self.hass.data['primary_speaker'],
            'media_content_id': media_content_id,
            'media_content_type': 'favorite_item_id'
        })



