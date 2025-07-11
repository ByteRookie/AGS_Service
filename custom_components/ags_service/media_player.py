from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.components.media_player import MediaPlayerEntity
from homeassistant.components.media_player.const import (
    MediaPlayerEntityFeature as MPFeature,
)
from homeassistant.const import STATE_IDLE
from homeassistant.helpers.event import async_track_state_change_event

import asyncio
from .ags_service import (
    update_ags_sensors,
    ags_select_source,
    TV_MODE_TV_AUDIO,
    TV_MODE_NO_MUSIC,
)

import logging
_LOGGER = logging.getLogger(__name__)

async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    ags_config = hass.data['ags_service']
    rooms = ags_config['rooms']
    

    ags_media_player = AGSPrimarySpeakerMediaPlayer(hass, ags_config)
    async_add_entities([ags_media_player])
    
    # Set up a listener to monitor changes to sensor.ags_primary_speaker
    async_track_state_change_event(hass, "switch.media_system", ags_media_player.async_primary_speaker_changed)

    # Set up a listener to monitor changes to the primary speaker (from hass.data)
    keys_to_check = ['primary_speaker', 'ags_status', 'switch_media_system_state', 'active_rooms', 'active_speakers', 'ags_media_player_source' ]

    for key in keys_to_check:
        entity_id = hass.data.get(key)
        if entity_id:
            async_track_state_change_event(hass, entity_id, ags_media_player.async_primary_speaker_changed)

    # Add switches for rooms and zone.home
    entities_to_track = ['zone.home']
    schedule_cfg = ags_config.get('schedule_entity')
    if schedule_cfg and schedule_cfg.get('entity_id'):
        entities_to_track.append(schedule_cfg['entity_id'])
    for room in rooms:
        room_switch = f"switch.{room['room'].lower().replace(' ', '_')}_media"
        entities_to_track.append(room_switch)

    for entity in entities_to_track:
        async_track_state_change_event(hass, entity, ags_media_player.async_primary_speaker_changed)

    # Also track state changes for all configured media player devices so the
    # AGS entity updates immediately when a device reports new state. Without
    # this the UI lags until the next poll when the primary speaker changes.
    for room in rooms:
        for device in room["devices"]:
            async_track_state_change_event(
                hass, device["device_id"], ags_media_player.async_primary_speaker_changed
            )



    # Create and add the secondary "Media System" media player only if SHOW_MEDIA_SYSTEM is True
    if ags_config['homekit_player']:
        media_system_player = MediaSystemMediaPlayer(ags_media_player)
        #entities.append(media_system_player)
        entities = [media_system_player]

        async_add_entities(entities, True)

    



class AGSPrimarySpeakerMediaPlayer(MediaPlayerEntity, RestoreEntity):
    async def async_added_to_hass(self):
        """When entity is added to hass."""
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state:
            self.hass.data["ags_media_player_source"] = last_state.attributes.get("source")

    def __init__(self, hass, ags_config):
        """Initialize the media player."""
        self._hass = hass
        self.ags_config = ags_config
        self._name = "AGS Media Player"
        self._state = STATE_IDLE
        self.primary_speaker_entity_id = None
        self.primary_speaker_state = None   # Initialize the attribute
        self.configured_rooms = None
        self.active_rooms = None
        self.active_speakers = None
        self.inactive_speakers = None
        self.ags_status = None
        self.primary_speaker = None
        self.preferred_primary_speaker = None
        self.ags_source = None
        self.ags_inactive_tv_speakers = None
        self.primary_speaker_room = None

    def _schedule_media_call(self, service: str, data: dict) -> None:
        """Safely fire a media_player service from any thread."""
        self.hass.loop.call_soon_threadsafe(
            lambda: self.hass.async_create_task(
                self.hass.services.async_call("media_player", service, data)
            )
        )

    def _schedule_ags_update(self) -> None:
        """Refresh AGS sensor data without waiting for polling."""
        async def _update() -> None:
            await update_ags_sensors(self.ags_config, self.hass)
            self._refresh_from_data()
            self.async_schedule_update_ha_state(True)

        self.hass.loop.call_soon_threadsafe(
            lambda: self.hass.async_create_task(_update())
        )





    def update(self):
        """Fetch latest state."""
        ### Move logic here for sensor to remove sensor.py ##

        asyncio.run_coroutine_threadsafe(
            update_ags_sensors(self.ags_config, self._hass), self.hass.loop
        ).result()

        self._refresh_from_data()

    def _refresh_from_data(self) -> None:
        """Update cached attributes from ``hass.data`` after sensors refresh."""
        self.configured_rooms = self.hass.data.get('configured_rooms', None)
        self.active_rooms = self.hass.data.get('active_rooms', None)
        self.active_speakers = self.hass.data.get('active_speakers', None)
        self.inactive_speakers = self.hass.data.get('inactive_speakers', None)
        self.primary_speaker = self.hass.data.get('primary_speaker', "")
        self.preferred_primary_speaker = self.hass.data.get('preferred_primary_speaker', None)

        selected_source = self.hass.data.get('ags_media_player_source')
        if selected_source is None:
            sources = self.hass.data['ags_service']['Sources']
            default = next(
                (
                    src["Source"]
                    for src in sources
                    if src.get("source_default") is True
                ),
                None,
            )
            if default:
                selected_source = default
            elif sources:
                selected_source = sources[0]["Source"]
            if selected_source is not None:
                self.hass.data['ags_media_player_source'] = selected_source
        self.ags_source = self.get_source_value_by_name(selected_source)
        self.ags_inactive_tv_speakers = self.hass.data.get('ags_inactive_tv_speakers', None)
        self.ags_status = self.hass.data.get('ags_status', 'OFF')

        found_room = False
        for room in self.ags_config['rooms']:
            for device in room["devices"]:
                if device["device_id"] == self.hass.data.get('primary_speaker'):
                    self.primary_speaker_room = room["room"]
                    found_room = True
                    break
            if found_room:
                break

        tv_mode = self.hass.data.get("current_tv_mode", TV_MODE_TV_AUDIO)

        if (
            self.ags_status == "ON TV"
            and tv_mode != TV_MODE_NO_MUSIC
            and self.primary_speaker_room
        ):
            selected_device_id = None

            sorted_devices = sorted(
                [device for device in room["devices"] if device["device_type"] != "speaker"],
                key=lambda x: x['priority']
            )

            if sorted_devices:
                first_device = sorted_devices[0]
                selected_device_id = first_device.get('ott_device', first_device["device_id"])
            else:
                selected_device_id = self.hass.data.get('primary_speaker', None)

            self.primary_speaker_entity_id = selected_device_id
        else:
            self.primary_speaker_entity_id = self.hass.data.get('primary_speaker', None)

        if self.primary_speaker_entity_id:
            self.primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id)



    async def async_primary_speaker_changed(self, event):
        """Handle state change events for tracked entities."""
        await update_ags_sensors(self.ags_config, self.hass)
        self._refresh_from_data()
        self.async_schedule_update_ha_state(True)

    
    @property
    def extra_state_attributes(self):
        """Return entity specific state attributes."""


        attributes = {
            "configured_rooms": self.configured_rooms or "Not available",
            "active_rooms": self.active_rooms or "Not available",
            "active_speakers": self.active_speakers or "Not available",
            "inactive_speakers": self.inactive_speakers or "Not available",
            "ags_status": self.ags_status or "Not available",
            "primary_speaker": self.primary_speaker or "Not available",
            "preferred_primary_speaker": self.preferred_primary_speaker or "Not available",
            # ags_source now contains the numeric favorite ID. If no source is
            # selected the value will be ``None`` which allows automations to
            # skip calling ``play_media`` rather than passing an invalid
            # favourite reference.
            "ags_source": self.ags_source,
            "ags_inactive_tv_speakers": self.ags_inactive_tv_speakers or "Not available",
        }
        return attributes



    @property
    def unique_id(self):
        return "ags_media_player"

    @property
    def name(self):
        ags_config = self.hass.data['ags_service']
        static_name = ags_config['static_name']
        if static_name: 
            return static_name 
        else:
            """Return the name of the sensor."""
            room_count = len(self.hass.data.get('active_rooms', []))
            
            if self.primary_speaker_room is None and self.ags_status != "OFF":
                return "All Rooms are Off"
            else:
                rooms_text = self.primary_speaker_room

            if self.ags_status == "OFF":
                return "AGS Media System"
            elif room_count == 1 :
                return rooms_text + " is Active"
            elif room_count > 1:
                return rooms_text + " + " + str(room_count-1) + " Active"
            else: 
                return "All Rooms are Off"

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
                return STATE_IDLE
            
            # Return the state of the primary speaker
            return self.primary_speaker_state.state
        else:
            return STATE_IDLE

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
        # Use async_call to avoid blocking when changing multiple speakers
        self._schedule_media_call('volume_set', {
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
        return (
            MPFeature.SEEK
            | MPFeature.PLAY
            | MPFeature.PAUSE
            | MPFeature.STOP
            | MPFeature.SHUFFLE_SET
            | MPFeature.REPEAT_SET
            | MPFeature.NEXT_TRACK
            | MPFeature.PREVIOUS_TRACK
            | MPFeature.SELECT_SOURCE
            | MPFeature.VOLUME_SET
            | MPFeature.TURN_ON
            | MPFeature.TURN_OFF
        )

    # Implement methods to control the AGS Primary Speaker

    def media_play(self):
        # Fire and forget the service call so the UI stays responsive
        self._schedule_media_call('media_play', {
            'entity_id': self.primary_speaker_entity_id
        })
        self._schedule_ags_update()

    def media_pause(self):
        self._schedule_media_call('media_pause', {
            'entity_id': self.primary_speaker_entity_id
        })
        self._schedule_ags_update()

    def media_stop(self):
        self._schedule_media_call('media_stop', {
            'entity_id': self.primary_speaker_entity_id
        })
        self._schedule_ags_update()

    def media_next_track(self):
        self._schedule_media_call('media_next_track', {
            'entity_id': self.primary_speaker_entity_id
        })
        self._schedule_ags_update()

    def turn_on(self):
        self.hass.data['switch_media_system_state'] = True
        self._schedule_ags_update()

    def turn_off(self):
        self.hass.data['switch_media_system_state'] = False
        self._schedule_ags_update()

    def media_previous_track(self):
        self._schedule_media_call('media_previous_track', {
            'entity_id': self.primary_speaker_entity_id
        })
        self._schedule_ags_update()
  
    def media_seek(self, position):
        """Seek to a specific point in the media on the primary speaker."""
        self._schedule_media_call('media_seek', {
            'entity_id': self.primary_speaker_entity_id,
            'seek_position': position
        })
        self._schedule_ags_update()
    @property
    def source_list(self):
        """List of available sources."""
        ags_config = self.hass.data['ags_service']
        disable_Tv_Source = ags_config['disable_Tv_Source']

        tv_mode = self.hass.data.get("current_tv_mode", TV_MODE_TV_AUDIO)
        if (
            self.ags_status == "ON TV"
            and disable_Tv_Source == False
            and tv_mode != TV_MODE_NO_MUSIC
        ):
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
        """Select the desired source and play it on the primary speaker."""
        self.hass.data["ags_media_player_source"] = source

        actions_enabled = self.hass.data.get("switch.ags_actions", True)
        if actions_enabled:
            self.hass.loop.call_soon_threadsafe(
                lambda: self.hass.async_create_task(
                    ags_select_source(
                        self.ags_config,
                        self.hass,
                        ignore_playing=True,
                    )
                )
            )
        self._schedule_ags_update()
           

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
        self._schedule_media_call('shuffle_set', {
            'entity_id': self.primary_speaker_entity_id,
            'shuffle': not self.shuffle
        })
        self._schedule_ags_update()

    def set_repeat(self, repeat):
        """Set repeat mode."""
        if self.repeat == "off":
            repeat_value = "one"
        elif self.repeat=="one":
            repeat_value = "all"
        else:
            repeat_value = "off"

        self._schedule_media_call('repeat_set', {
            'entity_id': self.primary_speaker_entity_id,
            'repeat':  repeat_value
        })
        self._schedule_ags_update()


# Define the secondary "Media System" media player class for homekit
class MediaSystemMediaPlayer(MediaPlayerEntity):
    def __init__(self, ags_media_player):
        """Initialize the media system player."""
        self._primary_player = ags_media_player

    @property
    def unique_id(self):
        """Return a unique ID."""
        return "ags_homekit_media_system"

    @property
    def name(self):
        """Return the name of the media system player."""
        ags_config = self.hass.data['ags_service']
        return ags_config['homekit_player']

    @property
    def state(self):
        """Return the state of the primary player."""
        return self._primary_player.state

    @property
    def supported_features(self):
        """Flag media player features that are supported."""
        return (
            MPFeature.PLAY
            | MPFeature.PAUSE
            | MPFeature.SELECT_SOURCE
            | MPFeature.TURN_ON
            | MPFeature.TURN_OFF
            | MPFeature.VOLUME_SET
        )

    @property
    def source(self):
        """Return the current input source of the device."""
        return self._primary_player.source

    @property
    def source_list(self):
        sources = [source_dict["Source"] for source_dict in self.hass.data['ags_service']['Sources']]
        # Check if any device has a type of TV and add "TV" to the source list
        if any(device.get("device_type") == "tv" for room in self.hass.data['ags_service']['rooms'] for device in room["devices"]):
            sources.append("TV")

        return sources

    @property
    def volume_level(self):
        """Volume level of the media player (0..1)."""
        return self._primary_player.volume_level

    @property
    def is_volume_muted(self):
        """Return True if the media player is muted."""
        return self._primary_player.is_volume_muted

    def turn_on(self):
        """Turn the media player on."""
        self._primary_player.turn_on()

    def turn_off(self):
        """Turn the media player off."""
        self._primary_player.turn_off()

    def set_volume_level(self, volume):
        """Set the volume level."""
        self._primary_player.set_volume_level(volume)

    def mute_volume(self, mute):
        """Mute the volume."""
        self._primary_player.mute_volume(mute)

    def select_source(self, source):
        """Select the input source."""
        self._primary_player.select_source(source)

    def media_play(self):
        """Play the media."""
        self._primary_player.media_play()

    def media_pause(self):
        """Pause the media."""
        self._primary_player.media_pause()

    @property
    def device_class(self):
        return "tv"

