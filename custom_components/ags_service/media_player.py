from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.components.media_player import (
    MediaPlayerEntity,
    MediaPlayerDeviceClass,
    MediaPlayerEntityFeature,
)
from homeassistant.const import STATE_IDLE
from homeassistant.helpers.event import async_call_later, async_track_state_change_event
from homeassistant.helpers.dispatcher import async_dispatcher_connect

import asyncio
from . import DOMAIN, SIGNAL_AGS_RELOAD
from .ags_service import (
    update_ags_sensors,
    ags_select_source,
    resolve_music_source_name,
    has_active_music_playback,
    TV_MODE_TV_AUDIO,
    TV_MODE_NO_MUSIC,
    TV_IGNORE_STATES,
    is_tv_mode_state,
)

import logging
_LOGGER = logging.getLogger(__name__)

STATE_REFRESH_DEBOUNCE = 0.15

async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    """Set up the media player platform."""
    ags_config = hass.data[DOMAIN]

    # Create and add the AGS media player
    ags_media_player = AGSPrimarySpeakerMediaPlayer(hass, ags_config)
    async_add_entities([ags_media_player], True)
    
    # Ensure the media player is properly registered
    async def reload_handler(_):
        await ags_media_player.async_update()
    
    async_dispatcher_connect(hass, SIGNAL_AGS_RELOAD, reload_handler)
    
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
                hass, list(tracked_entities), ags_media_player.async_primary_speaker_changed
            ))

    # Initial tracking
    update_tracked_entities()

    # Listen for hot reload to update tracking
    async_dispatcher_connect(hass, SIGNAL_AGS_RELOAD, update_tracked_entities)


async def async_setup_entry(hass, entry, async_add_entities):
    """Set up the media player platform from a config entry."""
    await async_setup_platform(hass, {}, async_add_entities)

class AGSPrimarySpeakerMediaPlayer(MediaPlayerEntity, RestoreEntity):
    _attr_device_class = MediaPlayerDeviceClass.TV

    async def async_added_to_hass(self):
        """When entity is added to hass."""
        await super().async_added_to_hass()
        restored_source = None
        last_state = await self.async_get_last_state()
        if last_state:
            restored_source = last_state.attributes.get("selected_source_name")
            if restored_source in (None, "", "TV", "Unknown"):
                restored_source = last_state.attributes.get("source")
            if restored_source not in (None, "", "TV", "Unknown"):
                self.hass.data["ags_media_player_source"] = restored_source
        await self.async_update()
        if (
            restored_source not in (None, "", "TV", "Unknown")
            and self.hass.data.get("ags_status") == "ON"
            and self.hass.data.get("active_rooms")
            and not has_active_music_playback(
                self.hass,
                self.hass.data.get("active_speakers", []),
            )
        ):
            await ags_select_source(
                self.ags_config,
                self.hass,
                ignore_playing=True,
            )

    def __init__(self, hass, ags_config):
        """Initialize the media player."""
        self._hass = hass
        self.ags_config = ags_config
        self._name = "Whole Home Audio"
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
        self.browsing_fallback_speaker = None
        self.ags_source = None
        self.ags_inactive_tv_speakers = None
        self.primary_speaker_room = None
        self._pending_refresh_unsub = None

    async def async_will_remove_from_hass(self):
        """Cancel scheduled refresh callbacks."""
        if self._pending_refresh_unsub:
            self._pending_refresh_unsub()
            self._pending_refresh_unsub = None
        await super().async_will_remove_from_hass()

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





    async def async_update(self):
        """Fetch latest state."""
        ### Move logic here for sensor to remove sensor.py ##

        await update_ags_sensors(self.ags_config, self._hass)

        self._refresh_from_data()

    def _refresh_from_data(self) -> None:
        """Update cached attributes from ``hass.data`` after sensors refresh."""
        self.configured_rooms = self.hass.data.get('configured_rooms', None)
        self.active_rooms = self.hass.data.get('active_rooms', None)
        self.active_speakers = self.hass.data.get('active_speakers', None)
        self.inactive_speakers = self.hass.data.get('inactive_speakers', None)
        self.primary_speaker = self.hass.data.get('primary_speaker', "")
        self.preferred_primary_speaker = self.hass.data.get('preferred_primary_speaker', None)
        self.browsing_fallback_speaker = self.hass.data.get('browsing_fallback_speaker', None)
        self.primary_speaker_room = None
        self.primary_speaker_state = None

        selected_source = resolve_music_source_name(self.ags_config, self.hass)
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
                tv_device = sorted_devices[0]
                ott_devices = tv_device.get('ott_devices')
                
                if ott_devices:
                    # Fetch the TV's current state to see what input is active
                    tv_state = self.hass.states.get(tv_device['device_id'])
                    current_input = tv_state.attributes.get('source') if tv_state else None
                    
                    # Try to find a matching input
                    found_ott = None
                    for ott in ott_devices:
                        if ott.get('tv_input') == current_input:
                            found_ott = ott['ott_device']
                            break
                    
                    # Fallback to the first device in the list if no match
                    selected_device_id = found_ott if found_ott else ott_devices[0]['ott_device']
                else:
                    selected_device_id = tv_device.get('ott_device', tv_device["device_id"])
            else:
                selected_device_id = self.hass.data.get('primary_speaker', None)

            self.primary_speaker_entity_id = selected_device_id
        else:
            self.primary_speaker_entity_id = self.hass.data.get('primary_speaker', None)

        if self.primary_speaker_entity_id:
            self.primary_speaker_state = self.hass.states.get(self.primary_speaker_entity_id)

    def _get_homekit_player_entity_id(self):
        """Return the configured HomeKit bridge player when available."""
        entity_id = self.hass.data.get(DOMAIN, {}).get("homekit_player")
        if not entity_id:
            return None
        return entity_id if self.hass.states.get(entity_id) is not None else None

    def _get_homekit_player_state(self):
        """Return the configured HomeKit bridge entity state."""
        entity_id = self._get_homekit_player_entity_id()
        return self.hass.states.get(entity_id) if entity_id else None

    def _get_reference_player_state(self):
        """Return the best state object for metadata and command fallbacks."""
        return self.primary_speaker_state or self._get_homekit_player_state()

    def _get_command_target_entity_id(self):
        """Return the entity that should receive direct transport commands."""
        if self.primary_speaker_entity_id and self.hass.states.get(self.primary_speaker_entity_id):
            return self.primary_speaker_entity_id
        return self._get_homekit_player_entity_id()

    def _derive_app_name_from_id(self, app_id):
        """Turn raw app IDs into a readable fallback label."""
        raw = str(app_id or "").strip()
        if not raw:
            return None
        tail = raw.split(".")[-1].replace("_", " ").replace("-", " ").strip()
        if not tail:
            return None
        return " ".join(part.capitalize() for part in tail.split())

    def _get_state_source_label(self, state):
        """Return the most useful active source/app label for a player state."""
        if state is None:
            return None

        attrs = state.attributes
        source = attrs.get("source")
        app_name = attrs.get("app_name")
        media_channel = attrs.get("media_channel")
        app_id = attrs.get("app_id")
        media_content_type = attrs.get("media_content_type")

        if app_name:
            return app_name
        if source:
            return source
        if media_channel:
            return media_channel
        derived_app = self._derive_app_name_from_id(app_id)
        if derived_app:
            return derived_app
        if media_content_type and state.state in ("playing", "paused", "buffering"):
            return str(media_content_type).replace("_", " ").title()
        return None



    async def async_primary_speaker_changed(self, event):
        """Handle state change events for tracked entities."""
        old_state = event.data.get("old_state")
        new_state = event.data.get("new_state")
        
        if old_state is not None and new_state is not None:
            # Filter out spam: Only trigger if the actual state, group, or source changed
            state_changed = old_state.state != new_state.state
            group_changed = old_state.attributes.get("group_members") != new_state.attributes.get("group_members")
            source_changed = self._get_state_source_label(old_state) != self._get_state_source_label(new_state)
            
            if not (state_changed or group_changed or source_changed):
                return  # Ignore media_position clock ticks

            # Second level check: avoid updates if only state is same and group is same
            if old_state.state == new_state.state and not group_changed:
                # Still check source to be sure
                if not source_changed:
                    return

        if self._pending_refresh_unsub:
            self._pending_refresh_unsub()

        async def _refresh(_now):
            self._pending_refresh_unsub = None
            await update_ags_sensors(self.ags_config, self.hass)
            self._refresh_from_data()
            self.async_schedule_update_ha_state(True)

        self._pending_refresh_unsub = async_call_later(
            self.hass, STATE_REFRESH_DEBOUNCE, _refresh
        )

    def _build_source_details(self):
        """Expose AGS-configured sources for richer frontend rendering."""
        return [
            {
                "name": source.get("Source"),
                "value": source.get("Source_Value"),
                "media_content_type": source.get("media_content_type"),
                "default": source.get("source_default", False),
            }
            for source in self.hass.data[DOMAIN].get("Sources", [])
            if source.get("Source")
        ]

    def _get_room_switch_entity_id(self, room_name: str) -> str | None:
        safe_room_id = "".join(
            c for c in room_name.lower().replace(" ", "_") if c.isalnum() or c == "_"
        )
        while "__" in safe_room_id:
            safe_room_id = safe_room_id.replace("__", "_")
        return f"switch.{safe_room_id}_media" if safe_room_id else None

    def _get_global_block_reason(self) -> str | None:
        """Return the global reason AGS is not actively including rooms."""
        if self.ags_status != "OFF":
            return None

        zone_state = self.hass.states.get("zone.home")
        if (
            not self.ags_config.get("off_override", False)
            and zone_state is not None
            and zone_state.state == "0"
        ):
            return "Zone check is pausing AGS because nobody is home"

        schedule_cfg = self.hass.data[DOMAIN].get("schedule_entity")
        if schedule_cfg and self.hass.data.get("schedule_state") is False:
            return "Schedule is currently outside its active window"

        if self.hass.data.get("switch_media_system_state") is False:
            return "AGS system switch is turned off"

        return "AGS is idle"

    def _build_logic_flags(self):
        """Summarize the control conditions behind AGS decisions."""
        actions_switch = self.hass.states.get("switch.ags_actions")
        zone_state = self.hass.states.get("zone.home")
        schedule_cfg = self.hass.data[DOMAIN].get("schedule_entity")
        schedule_entity = (
            self.hass.states.get(schedule_cfg["entity_id"])
            if schedule_cfg and schedule_cfg.get("entity_id")
            else None
        )
        selected_source = self.hass.data.get("ags_media_player_source")

        return [
            {
                "label": "Actions",
                "value": "Enabled" if actions_switch is None or actions_switch.state == "on" else "Paused",
                "tone": "good" if actions_switch is None or actions_switch.state == "on" else "warn",
                "detail": "Join and source actions follow the AGS Actions switch",
            },
            {
                "label": "Off Override",
                "value": (
                    "Enabled"
                    if self.ags_config.get("off_override", False)
                    else (
                        f"Home: {zone_state.state}"
                        if zone_state is not None
                        else "zone.home missing"
                    )
                ),
                "tone": "neutral" if self.ags_config.get("off_override", False) else "info",
                "detail": "Playback can force the system ON when Off Override is enabled",
            },
            {
                "label": "Schedule",
                "value": (
                    "Not configured"
                    if schedule_entity is None
                    else f"{schedule_entity.entity_id}: {schedule_entity.state}"
                ),
                "tone": "neutral" if schedule_entity is None else "info",
                "detail": "Home Assistant schedules can disable or re-enable AGS",
            },
            {
                "label": "TV Mode",
                "value": self.hass.data.get("current_tv_mode") or "None",
                "tone": "info" if self.ags_status == "ON TV" else "neutral",
                "detail": "TV mode can include rooms or intentionally isolate them",
            },
            {
                "label": "Source",
                "value": selected_source or "None selected",
                "tone": "good" if selected_source else "neutral",
                "detail": "The AGS source picker feeds the dashboard card and fallback routing",
            },
        ]

    def _build_room_diagnostics(self):
        """Explain why each room is included, skipped, or idle."""
        active_rooms = set(self.active_rooms or [])
        global_block_reason = self._get_global_block_reason()
        room_diagnostics = []

        for room in self.ags_config.get("rooms", []):
            room_name = room.get("room", "")
            switch_entity_id = self._get_room_switch_entity_id(room_name)
            switch_on = bool(self.hass.data.get(switch_entity_id))
            speaker_states = []
            active_tv_names = []
            no_music_tv = False

            for device in room.get("devices", []):
                state = self.hass.states.get(device["device_id"])
                if device.get("device_type") == "speaker":
                    speaker_states.append(state)
                if (
                    device.get("device_type") == "tv"
                    and is_tv_mode_state(state)
                ):
                    active_tv_names.append(
                        state.attributes.get("friendly_name", device["device_id"])
                    )
                    if device.get("tv_mode", TV_MODE_TV_AUDIO) == TV_MODE_NO_MUSIC:
                        no_music_tv = True

            available_speakers = [
                state
                for state in speaker_states
                if state and state.state.lower() not in TV_IGNORE_STATES
            ]

            if room_name in active_rooms:
                state_label = "included"
                reason = (
                    f"Included with {len(available_speakers) or len(speaker_states)} speaker(s)"
                )
                tone = "good"
            elif switch_on and no_music_tv:
                state_label = "skipped"
                reason = (
                    f"Skipped because {', '.join(active_tv_names)} is active in No Music mode"
                )
                tone = "warn"
            elif switch_on and global_block_reason:
                state_label = "blocked"
                reason = global_block_reason
                tone = "neutral"
            elif switch_on and not speaker_states:
                state_label = "skipped"
                reason = "Room switch is on, but no speaker devices are configured"
                tone = "warn"
            elif switch_on and not available_speakers:
                state_label = "waiting"
                reason = "Room switch is on, but no speaker is currently available"
                tone = "warn"
            elif switch_on:
                state_label = "waiting"
                reason = "Room switch is on and waiting for grouping logic"
                tone = "info"
            else:
                state_label = "off"
                reason = "Room switch is off"
                tone = "neutral"

            room_diagnostics.append(
                {
                    "name": room_name,
                    "switch_entity_id": switch_entity_id,
                    "switch_on": switch_on,
                    "included": room_name in active_rooms,
                    "state": state_label,
                    "tone": tone,
                    "reason": reason,
                    "active_tv_names": active_tv_names,
                    "speaker_count": len(
                        [device for device in room.get("devices", []) if device.get("device_type") == "speaker"]
                    ),
                    "device_count": len(room.get("devices", [])),
                }
            )

        return room_diagnostics

    def _build_speaker_candidates(self):
        """Expose the ranking behind speaker election."""
        candidates = []
        active_rooms = set(self.active_rooms or [])
        preferred = self.preferred_primary_speaker
        selected = self.primary_speaker
        index = 1

        for room in self.ags_config.get("rooms", []):
            if room.get("room") not in active_rooms:
                continue

            tv_active = any(
                (
                    device.get("device_type") == "tv"
                    and is_tv_mode_state(self.hass.states.get(device["device_id"]))
                )
                for device in room.get("devices", [])
            )

            speakers = sorted(
                [
                    device
                    for device in room.get("devices", [])
                    if device.get("device_type") == "speaker"
                ],
                key=lambda item: item.get("priority", 999),
            )

            for device in speakers:
                state = self.hass.states.get(device["device_id"])
                speaker_state = state.state if state else "missing"
                source = state.attributes.get("source") if state else None
                available = (
                    state is not None
                    and speaker_state.lower() not in TV_IGNORE_STATES
                )

                reason_parts = []
                if device["device_id"] == selected:
                    reason_parts.append("Selected as current primary")
                if device["device_id"] == preferred:
                    reason_parts.append("Best priority in active rooms")
                if (
                    device["device_id"] == selected
                    and selected not in (None, "none")
                    and preferred not in (None, "none")
                    and selected != preferred
                ):
                    reason_parts.append("Sticky master kept playing")
                if tv_active:
                    reason_parts.append("TV present in this room")
                if not reason_parts:
                    reason_parts.append("Available for election")

                candidates.append(
                    {
                        "rank": index,
                        "entity_id": device["device_id"],
                        "friendly_name": (
                            state.attributes.get("friendly_name")
                            if state
                            else device["device_id"]
                        ),
                        "room": room.get("room"),
                        "priority": device.get("priority"),
                        "state": speaker_state,
                        "source": self._get_state_source_label(state),
                        "available": available,
                        "selected": device["device_id"] == selected,
                        "preferred": device["device_id"] == preferred,
                        "reason": "; ".join(reason_parts),
                    }
                )
                index += 1

        return candidates

    def _build_room_details(self):
        """Return room and device metadata used by the custom dashboard card."""
        active_rooms = set(self.active_rooms or [])
        active_speakers = set(self.active_speakers or [])
        room_details = []

        for room in self.ags_config.get("rooms", []):
            safe_room_id = "".join(
                c
                for c in room.get("room", "").lower().replace(" ", "_")
                if c.isalnum() or c == "_"
            )
            switch_entity_id = f"switch.{safe_room_id}_media" if safe_room_id else None
            switch_state = self.hass.states.get(switch_entity_id) if switch_entity_id else None

            devices = []
            tv_active = False
            for device in room.get("devices", []):
                state = self.hass.states.get(device["device_id"])
                device_type = device.get("device_type", "speaker")
                if (
                    device_type == "tv"
                    and is_tv_mode_state(state)
                ):
                    tv_active = True

                devices.append(
                    {
                        "entity_id": device["device_id"],
                        "friendly_name": (
                            state.attributes.get("friendly_name")
                            if state
                            else device["device_id"]
                        ),
                        "device_type": device_type,
                        "priority": device.get("priority"),
                        "state": state.state if state else None,
                        "source": self._get_state_source_label(state),
                        "active": device["device_id"] in active_speakers,
                        "tv_mode": device.get("tv_mode"),
                    }
                )

            room_details.append(
                {
                    "name": room.get("room"),
                    "switch_entity_id": switch_entity_id,
                    "switch_state": switch_state.state if switch_state else "off",
                    "active": room.get("room") in active_rooms,
                    "tv_active": tv_active,
                    "devices": devices,
                }
            )

        return room_details

    
    @property
    def extra_state_attributes(self):
        """Return entity specific state attributes."""

        room_count = len(self.hass.data.get('active_rooms', []))
        if self.primary_speaker_room is None and self.ags_status != "OFF":
            dynamic_title = "All Rooms are Off"
        else:
            rooms_text = self.primary_speaker_room
            if self.ags_status == "OFF":
                dynamic_title = "AGS Media System"
            elif room_count == 1:
                dynamic_title = f"{rooms_text} is Active"
            elif room_count > 1:
                dynamic_title = f"{rooms_text} + {room_count-1} Active"
            else:
                dynamic_title = "All Rooms are Off"

        attributes = {
            "dynamic_title": dynamic_title,
            "configured_rooms": self.configured_rooms or [],
            "active_rooms": self.active_rooms or [],
            "active_speakers": self.active_speakers or [],
            "inactive_speakers": self.inactive_speakers or [],
            "ags_status": self.ags_status or "OFF",
            "primary_speaker": self.primary_speaker,
            "preferred_primary_speaker": self.preferred_primary_speaker,
            # ags_source now contains the numeric favorite ID. If no source is
            # selected the value will be ``None`` which allows automations to
            # skip calling ``play_media`` rather than passing an invalid
            # favourite reference.
            "ags_source": self.ags_source,
            "selected_source_name": self.hass.data.get("ags_media_player_source"),
            "ags_inactive_tv_speakers": self.ags_inactive_tv_speakers or [],
            "primary_speaker_room": self.primary_speaker_room,
            "control_device_id": self._get_command_target_entity_id(),
            "homekit_player_id": self._get_homekit_player_entity_id(),
            "browse_entity_id": self.primary_speaker if self.primary_speaker and self.primary_speaker != "none" else (self.preferred_primary_speaker if self.preferred_primary_speaker and self.preferred_primary_speaker != "none" else self.browsing_fallback_speaker),
            "current_tv_mode": self.hass.data.get("current_tv_mode"),
            "ags_sources": self._build_source_details(),
            "logic_flags": self._build_logic_flags(),
            "room_diagnostics": self._build_room_diagnostics(),
            "speaker_candidates": self._build_speaker_candidates(),
            "room_details": self._build_room_details(),
        }
        return attributes



    @property
    def unique_id(self):
        return "ags_media_player"

    @property
    def name(self):
        ags_config = self.hass.data['ags_service']
        static_name = ags_config.get('static_name')
        if static_name: 
            return static_name 
        return "Whole Home Audio"

    @property
    def group_members(self):
        """Return list of members in the same group."""
        active = self.hass.data.get('active_speakers', [])
        if not active:
            return []
        
        # Home Assistant typically expects the entity itself to be part of the group_members list
        if self.entity_id and self.entity_id not in active:
            return [self.entity_id] + active
        return active

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

        reference_state = self._get_homekit_player_state()
        if reference_state is not None:
            return reference_state.state

        return STATE_IDLE

    @property
    def media_title(self):
        reference_state = self._get_reference_player_state()
        if not reference_state:
            return None
        attrs = reference_state.attributes
        return (
            attrs.get('media_title')
            or attrs.get('app_name')
            or self._derive_app_name_from_id(attrs.get('app_id'))
        )

    @property
    def media_artist(self):
        reference_state = self._get_reference_player_state()
        if not reference_state:
            return None
        attrs = reference_state.attributes
        return (
            attrs.get('media_artist')
            or attrs.get('media_channel')
            or attrs.get('friendly_name')
        )

    @property
    def entity_picture(self):
        reference_state = self._get_reference_player_state()
        return reference_state.attributes.get('entity_picture') if reference_state else None
    @property
    def is_volume_muted(self):
        reference_state = self._get_reference_player_state()
        return reference_state.attributes.get('is_volume_muted') if reference_state else None

    async def async_set_volume_level(self, volume):
        """Set the volume level for all active speakers."""
        active_speakers = self.hass.data.get('active_speakers', [])
        if active_speakers:
            await self.hass.services.async_call('media_player', 'volume_set', {
                'entity_id': active_speakers,
                'volume_level': volume,
            })
            await self.async_update()

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
        reference_state = self._get_reference_player_state()
        return reference_state.attributes.get('media_content_type') if reference_state else None
    @property
    def media_duration(self):
        reference_state = self._get_reference_player_state()
        return reference_state.attributes.get('media_duration') if reference_state else None
    @property
    def media_position(self):
        reference_state = self._get_reference_player_state()
        return reference_state.attributes.get('media_position') if reference_state else None
    @property
    def queue_size(self):
        reference_state = self._get_reference_player_state()
        return reference_state.attributes.get('queue_size') if reference_state else None




    @property
    def media_position_updated_at(self):
        reference_state = self._get_reference_player_state()
        return reference_state.attributes.get('media_position_updated_at') if reference_state else None
    @property
    def supported_features(self) -> MediaPlayerEntityFeature:
        return (
            MediaPlayerEntityFeature.SEEK
            | MediaPlayerEntityFeature.PLAY
            | MediaPlayerEntityFeature.PAUSE
            | MediaPlayerEntityFeature.STOP
            | MediaPlayerEntityFeature.SHUFFLE_SET
            | MediaPlayerEntityFeature.REPEAT_SET
            | MediaPlayerEntityFeature.NEXT_TRACK
            | MediaPlayerEntityFeature.PREVIOUS_TRACK
            | MediaPlayerEntityFeature.SELECT_SOURCE
            | MediaPlayerEntityFeature.VOLUME_SET
            | MediaPlayerEntityFeature.VOLUME_STEP
            | MediaPlayerEntityFeature.TURN_ON
            | MediaPlayerEntityFeature.TURN_OFF
            | MediaPlayerEntityFeature.GROUPING
            | MediaPlayerEntityFeature.BROWSE_MEDIA
            | MediaPlayerEntityFeature.PLAY_MEDIA
        )

    async def async_play_media(self, media_content_type, media_content_id, **kwargs):
        """Play media on the primary speaker."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'play_media', {
                'entity_id': target_entity_id,
                'media_content_id': media_content_id,
                'media_content_type': media_content_type,
                **kwargs
            })
            await self.async_update()

    async def async_join_media(self, group_members):
        """Join speakers to the primary speaker's group."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'join', {
                'entity_id': target_entity_id,
                'group_members': group_members
            })
            await self.async_update()

    async def async_unjoin_media(self):
        """Unjoin this player from any group."""
        # When unjoin is called on the AGS player, we unjoin all active speakers
        # because the AGS player represents the whole group.
        active_speakers = self.hass.data.get('active_speakers', [])
        if active_speakers:
            await self.hass.services.async_call('media_player', 'unjoin', {
                'entity_id': active_speakers
            })
            await self.async_update()

    async def async_browse_media(self, media_content_type=None, media_content_id=None):
        """Proxy media browsing through the current AGS control speaker."""
        target_entity_id = self.primary_speaker if self.primary_speaker and self.primary_speaker != "none" else (self.preferred_primary_speaker if self.preferred_primary_speaker and self.preferred_primary_speaker != "none" else self.browsing_fallback_speaker)

        if target_entity_id and target_entity_id != self.entity_id and target_entity_id != "none":
            try:
                # browse_media is not a HA service — call the entity method directly
                # via the entity component so integrations like Sonos/Spotify work correctly.
                component = self.hass.data.get("entity_components", {}).get("media_player")
                if component:
                    target_entity = component.get_entity(target_entity_id)
                    if target_entity and hasattr(target_entity, "async_browse_media"):
                        return await target_entity.async_browse_media(
                            media_content_type, media_content_id
                        )
            except Exception as err:
                _LOGGER.error("Error proxying browse_media to %s: %s", target_entity_id, err)

        from homeassistant.components import media_source
        return await media_source.async_browse_media(
            self.hass,
            media_content_type,
            media_content_id,
        )

    # Implement methods to control the AGS Primary Speaker

    async def async_media_play(self):
        """Play media."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'media_play', {
                'entity_id': target_entity_id
            })
            await self.async_update()

    async def async_media_pause(self):
        """Pause media."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'media_pause', {
                'entity_id': target_entity_id
            })
            await self.async_update()

    async def async_media_stop(self):
        """Stop media."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'media_stop', {
                'entity_id': target_entity_id
            })
            await self.async_update()

    async def async_media_next_track(self):
        """Next track."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'media_next_track', {
                'entity_id': target_entity_id
            })
            await self.async_update()

    async def async_turn_on(self):
        """Turn on."""
        self.hass.data['switch_media_system_state'] = True
        await self.async_update()

    async def async_turn_off(self):
        """Turn off."""
        self.hass.data['switch_media_system_state'] = False
        await self.async_update()

    async def async_media_previous_track(self):
        """Previous track."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'media_previous_track', {
                'entity_id': target_entity_id
            })
            await self.async_update()
  
    async def async_media_seek(self, position):
        """Seek to a specific point in the media on the primary speaker."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'media_seek', {
                'entity_id': target_entity_id,
                'seek_position': position
            })
            await self.async_update()
    @property
    def source_list(self):
        """List of available sources."""
        sources = [source_dict["Source"] for source_dict in self.hass.data['ags_service']['Sources']]

        # Merge sources from the primary speaker if available
        reference_state = self._get_reference_player_state()
        if reference_state and reference_state.attributes.get('source_list'):
            speaker_sources = reference_state.attributes.get('source_list')
            for src in speaker_sources:
                if src not in sources:
                    sources.append(src)

        return sources

    @property
    def source(self):
        """Return the current input source."""
        reference_state = self._get_reference_player_state()
        active_source = self._get_state_source_label(reference_state)
        if self.ags_status == "ON TV":
            return active_source or "TV"
        else:
            ags_source = self.hass.data.get("ags_media_player_source")
            current_spk_source = active_source
            # Once AGS has left TV mode, prefer the remembered AGS source over
            # a stale speaker-reported "TV" source so the UI reflects the
            # source AGS is actually trying to restore.
            if ags_source and current_spk_source == "TV":
                return ags_source
            # If the primary speaker is playing a source not in our
            # ags_media_player_source, reflect it.
            if current_spk_source and current_spk_source != ags_source:
                 # Check if the speaker source is one of our globals. If not, just show the speaker source.
                 is_global = any(s["Source"] == current_spk_source for s in self.hass.data['ags_service']['Sources'])
                 if not is_global and current_spk_source in self.source_list:
                      return current_spk_source
            return ags_source

    def get_source_value_by_name(self, source_name):
        for source_dict in self.hass.data['ags_service']['Sources']:
            if source_dict["Source"] == source_name:
                return source_dict["Source_Value"]
        return None  # if not found

    async def async_select_source(self, source):
        """Select the desired source and play it on the primary speaker."""
        # Check if source is one of our configured global sources
        is_global_source = any(source_dict["Source"] == source for source_dict in self.hass.data['ags_service']['Sources'])

        if is_global_source:
            self.hass.data["ags_media_player_source"] = source
            state_obj = self.hass.states.get("switch.ags_actions")
            actions_enabled = state_obj.state == "on" if state_obj else True
            if actions_enabled:
                await ags_select_source(
                    self.ags_config,
                    self.hass,
                    ignore_playing=True,
                )
        else:
            # It must be a source from the primary speaker itself
            target_entity_id = self._get_command_target_entity_id()
            if target_entity_id:
                await self.hass.services.async_call('media_player', 'select_source', {
                    'entity_id': target_entity_id,
                    'source': source
                })

        await self.async_update()           

    @property
    def shuffle(self):
        """Return the shuffle state of the primary speaker."""
        reference_state = self._get_reference_player_state()
        if reference_state:
            return reference_state.attributes.get('shuffle', False)
        return False

    @property
    def repeat(self):
        """Return the repeat state of the primary speaker."""
        reference_state = self._get_reference_player_state()
        if reference_state:
            return reference_state.attributes.get('repeat', 'off')
        return 'off'

    async def async_set_shuffle(self, shuffle):
        """Enable/Disable shuffle mode."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'shuffle_set', {
                'entity_id': target_entity_id,
                'shuffle': shuffle
            })
            await self.async_update()

    async def async_set_repeat(self, repeat):
        """Set repeat mode."""
        target_entity_id = self._get_command_target_entity_id()
        if target_entity_id:
            await self.hass.services.async_call('media_player', 'repeat_set', {
                'entity_id': target_entity_id,
                'repeat':  repeat
            })
            await self.async_update()
