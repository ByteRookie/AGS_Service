# ags_service .py
import logging
import asyncio
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from .source_utils import (
    CONF_DEFAULT_SOURCE_ID,
    combine_source_inventory,
    find_source_by_name_or_id,
)

DOMAIN = "ags_service"

CONF_TV_MODE = 'tv_mode'
TV_MODE_TV_AUDIO = 'tv_audio'
TV_MODE_NO_MUSIC = 'no_music'

SONOS_FAVORITE_PREFIX = "FV:"

# Ghost TV ignore list
TV_IGNORE_STATES = ['off', 'unavailable', 'unknown', 'standby', 'none', 'power_off', 'sleeping']
TV_ACTIVE_IGNORE_STATES = TV_IGNORE_STATES + ['idle', 'paused']

SHORT_ACTION_DELAY = 0.15
GROUP_SETTLE_DELAY = 0.35
UNGROUP_TIMEOUT = 3
GROUP_TIMEOUT = 2.5


_LOGGER = logging.getLogger(__name__)

def is_active_tv_state(state_obj) -> bool:
    """Return True when a TV media_player should count as actively driving TV mode."""
    return state_obj is not None and state_obj.state.lower() not in TV_ACTIVE_IGNORE_STATES


def is_tv_mode_state(state_obj) -> bool:
    """Return True when a TV should participate in the core AGS TV/music logic."""
    return state_obj is not None and state_obj.state.lower() not in TV_IGNORE_STATES


def is_active_music_state(state_obj) -> bool:
    """Return True when a speaker is actively outputting non-TV audio."""
    if state_obj is None:
        return False
    if state_obj.state.lower() not in {"playing", "buffering"}:
        return False
    return state_obj.attributes.get("source") != "TV"


def has_active_music_playback(hass: HomeAssistant, speaker_ids: list[str] | None) -> bool:
    """Return True when any active speaker is already playing music."""
    for speaker_id in speaker_ids or []:
        if is_active_music_state(hass.states.get(speaker_id)):
            return True
    return False


def get_active_tv_primary_speaker(rooms, hass):
    """Return the highest-priority speaker in an active room with an active TV."""
    active_rooms = set(hass.data.get("active_rooms", []) or [])
    candidates = []

    for room in rooms:
        if room.get("room") not in active_rooms:
            continue

        tv_active = any(
            device.get("device_type") == "tv"
            and is_tv_mode_state(hass.states.get(device["device_id"]))
            and device.get("tv_mode", TV_MODE_TV_AUDIO) == TV_MODE_TV_AUDIO
            for device in room.get("devices", [])
        )
        if not tv_active:
            continue

        for device in room.get("devices", []):
            if device.get("device_type") != "speaker":
                continue
            state = hass.states.get(device["device_id"])
            if state is None or state.state.lower() in TV_IGNORE_STATES:
                continue
            candidates.append(device)

    if not candidates:
        return None

    candidates.sort(key=lambda item: item.get("priority", 999))
    return candidates[0]["device_id"]


def get_ranked_speaker_entity_ids(rooms) -> list[str]:
    """Return configured speakers by priority across the whole AGS setup."""
    speakers = []
    for room in rooms or []:
        for device in room.get("devices", []) or []:
            if device.get("device_type") == "speaker" and device.get("device_id"):
                speakers.append(device)
    speakers.sort(key=lambda item: item.get("priority", 999))
    return [speaker["device_id"] for speaker in speakers]


def get_first_available_speaker(rooms, hass) -> str | None:
    """Return the highest-ranked configured speaker that exists in HA."""
    ranked_speakers = get_ranked_speaker_entity_ids(rooms)
    if not ranked_speakers:
        return None
    for entity_id in ranked_speakers:
        state = hass.states.get(entity_id)
        if state is not None and state.state.lower() not in TV_IGNORE_STATES:
            return entity_id
    return ranked_speakers[0]

async def _action_worker(hass: HomeAssistant) -> None:
    """Process queued media_player actions sequentially."""
    queue = hass.data["ags_service"]["action_queue"]
    while True:
        try:
            service, data = await queue.get()
            try:
                if service == "delay":
                    await asyncio.sleep(data.get("seconds", 1))
                elif service == "wait_ungrouped":
                    await _wait_until_ungrouped(
                        hass,
                        data.get("entity_id"),
                        data.get("timeout", 3),
                    )
                else:
                    await hass.services.async_call("media_player", service, data)
            except HomeAssistantError as exc:
                _LOGGER.warning("Failed media action %s: %s", service, exc)
            except Exception as exc:  # pragma: no cover - safety net
                _LOGGER.warning("Unexpected error in media action %s: %s", service, exc)
            finally:
                queue.task_done()
        except asyncio.CancelledError:
            break
        except Exception as exc:
            _LOGGER.exception("Action worker encountered an unexpected error: %s", exc)
            await asyncio.sleep(1)


async def ensure_action_queue(hass: HomeAssistant) -> None:
    """Initialize the media action queue in hass.data if needed."""
    if "ags_service" not in hass.data:
        hass.data["ags_service"] = {}

    if "action_queue" not in hass.data["ags_service"]:
        hass.data["ags_service"]["action_queue"] = asyncio.Queue()

    if "action_worker" not in hass.data["ags_service"]:
        worker = hass.loop.create_task(_action_worker(hass))
        hass.data["ags_service"]["action_worker"] = worker


async def enqueue_media_action(hass: HomeAssistant, service: str, data: dict) -> None:
    """Add a media_player service call to the action queue."""
    await ensure_action_queue(hass)
    await hass.data["ags_service"]["action_queue"].put((service, data))


async def wait_for_actions(hass: HomeAssistant) -> None:
    """Pause until the action queue has been processed."""
    await ensure_action_queue(hass)
    await hass.data["ags_service"]["action_queue"].join()


async def restore_speaker_to_tv_input(
    hass: HomeAssistant,
    entity_id: str,
    *,
    stop_first: bool = True,
) -> None:
    """Ungrouped TV-room speakers should end on their TV input, not stopped music."""
    state = hass.states.get(entity_id)
    if state is None or state.state == "unavailable":
        return

    if stop_first:
        await enqueue_media_action(hass, "media_stop", {"entity_id": entity_id})
        await enqueue_media_action(hass, "delay", {"seconds": SHORT_ACTION_DELAY})

    await enqueue_media_action(
        hass,
        "select_source",
        {"entity_id": entity_id, "source": "TV"},
    )
    await enqueue_media_action(hass, "delay", {"seconds": SHORT_ACTION_DELAY})


async def _wait_until_ungrouped(
    hass: HomeAssistant, entity_ids: list[str] | str, timeout: float = 3.0
) -> None:
    """Pause until the given speakers report no grouping."""
    if isinstance(entity_ids, str):
        entity_ids = [entity_ids]

    end = hass.loop.time() + timeout
    unavailable: set[str] = set()
    while hass.loop.time() < end:
        all_clear = True
        for ent in entity_ids:
            state = hass.states.get(ent)
            if state is None or state.state.lower() in {"unavailable", "unknown"}:
                unavailable.add(ent)
                all_clear = False
                break
            members = state.attributes.get("group_members")
            if not isinstance(members, list):
                members = [] if members is None else [members]
            if members not in ([], [ent]):
                all_clear = False
                break
        if all_clear:
            return
        await asyncio.sleep(0.1)

    if unavailable:
        _LOGGER.warning(
            "Timed out waiting for unavailable speakers to ungroup: %s",
            sorted(unavailable),
        )


async def _wait_until_grouped(
    hass: HomeAssistant,
    entity_id: str,
    members: list[str] | str,
    timeout: float = 3.0,
) -> None:
    """Pause until ``entity_id`` shows the expected grouping."""
    if isinstance(members, str):
        members = [members]
    expected = set(members)
    end = hass.loop.time() + timeout
    while hass.loop.time() < end:
        state = hass.states.get(entity_id)
        if state is not None:
            group_members = state.attributes.get("group_members")
            if not isinstance(group_members, list):
                group_members = [] if group_members is None else [group_members]
            if (
                group_members
                and group_members[0] == entity_id
                and set(group_members) == expected
            ):
                return
        await asyncio.sleep(0.1)




def _handle_status_transition(prev_status, new_status, hass):
    """Store and restore the AGS source when toggling TV mode."""
    if new_status == "ON TV" and prev_status != "ON TV":
        hass.data["ags_source_before_tv"] = hass.data.get("ags_media_player_source")
    elif new_status == "ON" and prev_status == "ON TV":
        prev_source = hass.data.pop("ags_source_before_tv", None)
        if prev_source not in (None, "", "TV", "Unknown"):
            hass.data["ags_media_player_source"] = prev_source
        elif hass.data.get("ags_media_player_source") in ("TV", "Unknown", ""):
            hass.data.pop("ags_media_player_source", None)


def resolve_music_source_name(ags_config, hass, preferred_source=None):
    """Return the best configured non-TV source for music playback."""
    ags_data = hass.data.get("ags_service", {})
    configured_sources = combine_source_inventory(ags_data)

    source = preferred_source

    if source in (None, "", "TV", "Unknown"):
        selected_id = hass.data.get("ags_media_player_source_id")
        selected_source = find_source_by_name_or_id(ags_data, selected_id)
        if selected_source:
            source = selected_source["Source"]

    if source in (None, "", "TV", "Unknown"):
        selected_source = find_source_by_name_or_id(
            ags_data,
            hass.data.get("ags_media_player_source"),
        )
        source = selected_source["Source"] if selected_source else hass.data.get("ags_media_player_source")

    # If no preferred or current source, check the single AGS default source.
    if source in (None, "", "TV", "Unknown"):
        default_source = find_source_by_name_or_id(
            ags_data,
            ags_data.get(CONF_DEFAULT_SOURCE_ID),
        )
        if default_source:
            source = default_source["Source"]

    # If still nothing, use the first available generated source.
    if source in (None, "", "TV", "Unknown") and configured_sources:
        source = configured_sources[0]["Source"]

    return source


def _ranked_available_speakers_for_source(ags_config, hass):
    """Return active speakers first, then configured speakers, in AGS rank order."""
    ranked = get_ranked_speaker_entity_ids(ags_config.get("rooms", []))
    active = set(hass.data.get("active_speakers", []) or [])
    ordered = [entity_id for entity_id in ranked if entity_id in active] or ranked
    available = []
    for entity_id in ordered:
        state = hass.states.get(entity_id)
        if state is not None and state.state.lower() not in TV_IGNORE_STATES:
            available.append(entity_id)
    return available


def _source_available_on_speaker(source, speaker_entity_id):
    """Return true when source discovery knows a source is available on a speaker."""
    available_on = source.get("available_on") or []
    if not available_on:
        return True
    return speaker_entity_id in available_on


def _pick_source_and_speaker(configured_sources, source_entry, primary_speaker, ags_config, hass):
    """Fail over source playback using per-speaker browser discovery metadata."""
    if not source_entry or not primary_speaker:
        return source_entry, primary_speaker

    if _source_available_on_speaker(source_entry, primary_speaker):
        return source_entry, primary_speaker

    ranked_speakers = _ranked_available_speakers_for_source(ags_config, hass)
    for entity_id in ranked_speakers:
        if _source_available_on_speaker(source_entry, entity_id):
            hass.data["primary_speaker"] = entity_id
            return source_entry, entity_id

    for fallback_source in configured_sources:
        if fallback_source.get("id") == source_entry.get("id"):
            continue
        if _source_available_on_speaker(fallback_source, primary_speaker):
            return fallback_source, primary_speaker

    return source_entry, primary_speaker


def _browse_attr(node, name, default=None):
    if isinstance(node, dict):
        return node.get(name, default)
    return getattr(node, name, default)


def _browse_children(node):
    children = _browse_attr(node, "children", []) or []
    return list(children) if isinstance(children, (list, tuple)) else []


def _extract_browse_response(response, entity_id):
    if isinstance(response, dict):
        if entity_id in response:
            return response[entity_id]
        if len(response) == 1:
            return next(iter(response.values()))
    return response


async def _browse_media_node(hass, entity_id, media_type, media_id):
    payload = {"entity_id": entity_id}
    if media_type:
        payload["media_content_type"] = media_type
    if media_id:
        payload["media_content_id"] = media_id
    response = await hass.services.async_call(
        "media_player",
        "browse_media",
        payload,
        blocking=True,
        return_response=True,
    )
    return _extract_browse_response(response, entity_id)


async def _find_first_playable_in_browse_node(
    hass,
    entity_id,
    node,
    *,
    max_depth=3,
    depth=0,
    seen=None,
):
    """Return the first playable child in a bounded media-browser folder walk."""
    if node is None or depth > max_depth:
        return None
    if seen is None:
        seen = set()

    for child in _browse_children(node):
        child_id = str(_browse_attr(child, "media_content_id", "") or "").strip()
        child_type = str(_browse_attr(child, "media_content_type", "") or "").strip()
        can_play = bool(_browse_attr(child, "can_play", False))
        can_expand = bool(_browse_attr(child, "can_expand", False) or _browse_children(child))

        if can_play and child_id and child_type:
            return {
                "media_content_id": child_id,
                "media_content_type": child_type,
            }

        if not can_expand or not child_id:
            continue

        node_key = (child_type, child_id)
        if node_key in seen:
            continue
        seen.add(node_key)

        nested = child
        if not _browse_children(child):
            try:
                nested = await _browse_media_node(hass, entity_id, child_type, child_id)
            except Exception as err:
                _LOGGER.debug("Unable to expand favorited source folder %s: %s", child_id, err)
                continue
        playable = await _find_first_playable_in_browse_node(
            hass,
            entity_id,
            nested,
            max_depth=max_depth,
            depth=depth + 1,
            seen=seen,
        )
        if playable:
            return playable
    return None


async def _resolve_folder_source_to_playable(hass, entity_id, source_info):
    """Resolve a favorited folder source to its first playable child."""
    try:
        root = await _browse_media_node(
            hass,
            entity_id,
            source_info.get("type"),
            source_info.get("value"),
        )
    except Exception as err:
        _LOGGER.warning("Unable to browse favorited folder source %s: %s", source_info.get("value"), err)
        return None
    return await _find_first_playable_in_browse_node(hass, entity_id, root)

### Sensor Functions ###

## update all Sensors Function ##
async def update_ags_sensors(ags_config, hass):
    """Refresh sensor data and trigger the status handler when needed."""

    # Safety check for domain data during unload or failed setup
    if 'ags_service' not in hass.data:
        _LOGGER.debug("AGS service data not found during sensor update")
        return None, None

    rooms = ags_config.get('rooms', [])
    # We allow the update to proceed even without rooms so that the global
    # system state (switch_media_system_state) can still be managed.

    lock = hass.data.setdefault('ags_service', {}).setdefault(
        'sensor_lock', asyncio.Lock()
    )

    should_handle_status = False
    prev_status = None
    new_status = None
    sensors = []

    async with lock:
        # Call and execute the functions to set sensor values for all of AGS
        get_configured_rooms(rooms, hass)
        prev_rooms = list(hass.data.get('active_rooms', []) or [])
        get_active_rooms(rooms, hass)
        new_rooms = list(hass.data.get('active_rooms', []) or [])
        prev_status = hass.data.get('ags_status')
        update_ags_status(ags_config, hass)
        update_speaker_states(rooms, hass)
        get_preferred_primary_speaker(rooms, hass)
        determine_primary_speaker(ags_config, hass)
        get_inactive_tv_speakers(rooms, hass)
        get_browsing_fallback_speaker(rooms, hass)
        new_status = hass.data.get('ags_status')

        # FIX 7: Startup "Resume" Trigger
        should_handle_status = (
            new_status != prev_status
            or new_rooms != prev_rooms
            or prev_status is None
        )
        ## Use in Future release ###
        #if hass.data.get('primary_speaker') == "none" and hass.data.get('active_speakers') != [] and hass.data.get('preferred_primary_speaker') != "none":
        #    _LOGGER.error("ags source change has been called")
        #    ags_select_source(ags_config, hass)

        sensors = list(hass.data.get('ags_sensors', []) or [])
        for sensor in sensors:
            try:
                hass.loop.call_soon_threadsafe(
                    sensor.async_schedule_update_ha_state, True
                )
            except Exception as exc:
                _LOGGER.error("Failed to update sensor %s: %s", sensor.entity_id, exc)

    if should_handle_status:
        await handle_ags_status_change(
            hass, ags_config, new_status, prev_status
        )

    for sensor in sensors:
        try:
            hass.loop.call_soon_threadsafe(
                sensor.async_schedule_update_ha_state, True
            )
        except Exception as exc:
            _LOGGER.debug(
                'Error scheduling update for %s: %s',
                getattr(sensor, 'entity_id', 'unknown'),
                exc,
            )

    return prev_status, new_status

## Get Configured Rooms ##
def get_configured_rooms(rooms, hass):
    """Get the list of configured rooms and store it in hass.data."""

    configured_rooms = [room.get('room') for room in rooms if room.get('room')]

    hass.data['configured_rooms'] = configured_rooms

    return configured_rooms

## Function for Active room ###
def get_active_rooms(rooms, hass):
    """Fetch the list of active rooms based on switches in hass.data."""

    active_rooms = []

    for room in rooms:
        safe_room_id = "".join(c for c in room['room'].lower().replace(' ', '_') if c.isalnum() or c == '_')
        while "__" in safe_room_id:
            safe_room_id = safe_room_id.replace("__", "_")
        room_key = f"switch.{safe_room_id}_media"
        if not hass.data.get(room_key):
            continue

        skip_room = False
        for device in room['devices']:
            if device.get('device_type') != 'tv':
                continue
            state = hass.states.get(device['device_id'])
            # FIX 6: Ghost TV expansion
            if is_tv_mode_state(state):
                if device.get('tv_mode', TV_MODE_TV_AUDIO) == TV_MODE_TV_AUDIO:
                    skip_room = False
                    break
                else:
                    skip_room = True
        if skip_room:
            continue

        active_rooms.append(room['room'])

    # Store the list of active rooms in hass.data
    hass.data['active_rooms'] = active_rooms
    return active_rooms

### Function to Update Status ###
def update_ags_status(ags_config, hass):
    rooms = ags_config.get('rooms', [])
    active_rooms = hass.data.get('active_rooms', [])
    prev_status = hass.data.get('ags_status')

    # Default status to OFF
    ags_status = "OFF"

    # If the off_override is disabled (standard behavior) and the state of 'zone.home' is '0', set status to "OFF"
    zone_state = hass.states.get('zone.home')
    if not ags_config.get('off_override', False):
        if zone_state is None:
            _LOGGER.warning("zone.home entity not found; skipping zone check")
        elif str(zone_state.state) == '0' or (zone_state.state.isdigit() and int(zone_state.state) == 0):
            ags_status = "OFF"
            hass.data['ags_status'] = ags_status
            return ags_status

    # Prepare a dictionary of device states
    device_states = {device['device_id']: hass.states.get(device['device_id']) for room in rooms for device in room['devices']}

    # OFF OVERRIDE LOGIC: If off_override is enabled AND any speaker is playing, force system ON
    if ags_config.get('off_override', False):
        any_playing = False
        for room in rooms:
            for device in room['devices']:
                if device.get('device_type') == 'speaker':
                    state = device_states.get(device['device_id'])
                    if state and state.state.lower() not in TV_IGNORE_STATES:
                        any_playing = True
                        break
            if any_playing:
                break

        if any_playing:
            hass.data['switch_media_system_state'] = True

    # Check for override on any device
    all_devices = [device for room in rooms for device in room['devices']]
    sorted_devices = sorted(all_devices, key=lambda x: x.get('priority', 0))

    for device in sorted_devices:
        device_state = device_states.get(device['device_id'])
        if device_state:
            attrs = device_state.attributes
            media_content_id = attrs.get('media_content_id', '')
            source = attrs.get('source', '')
            media_title = attrs.get('media_title', '')

            # FIX 4: Expand override check
            override_val = device.get('override_content')
            if override_val:
                if (override_val in str(media_content_id) or
                    override_val in str(source) or
                    override_val in str(media_title)):
                    # Force the media system switch ON if an override is actively playing
                    hass.data['switch_media_system_state'] = True
                    ags_status = "Override"
                    _handle_status_transition(prev_status, ags_status, hass)
                    hass.data['ags_status'] = ags_status
                    return ags_status


    # Determine schedule entity state if configured
    schedule_cfg = hass.data['ags_service'].get('schedule_entity')
    schedule_on = True
    prev_schedule_state = hass.data.get('schedule_prev_state')
    if schedule_cfg:
        state_obj = hass.states.get(schedule_cfg['entity_id'])
        if state_obj is not None:
            if state_obj.state == schedule_cfg.get('on_state', 'on'):
                schedule_on = True
            elif state_obj.state == schedule_cfg.get('off_state', 'off'):
                schedule_on = False
            else:
                schedule_on = False
        else:
            schedule_on = False

    # Automatically enable the media system when the schedule switches
    # from the off state to the on state
    if (
        schedule_cfg
        and prev_schedule_state is not None
        and not prev_schedule_state
        and schedule_on
    ):
        hass.data['switch_media_system_state'] = True

    media_system_state = hass.data.get('switch_media_system_state')
    if media_system_state is None:
        media_system_state = ags_config.get('default_on', False)
        hass.data['switch_media_system_state'] = media_system_state

    if schedule_cfg:

        if schedule_cfg.get('schedule_override'):
            if prev_schedule_state is None:
                prev_schedule_state = schedule_on

            # Only force the system off when the schedule transitions
            # from "on" to "off" so manual re-enablement is possible
            if not schedule_on and prev_schedule_state:
                media_system_state = False
                hass.data['switch_media_system_state'] = False

            hass.data['schedule_prev_state'] = schedule_on
            hass.data['schedule_state'] = schedule_on

        else:
            # If schedule is OFF and we are not in override mode, the system defaults to OFF
            # but we still allow manual media_system_state to override this if it's explicitly True.
            if not schedule_on and not media_system_state:
                ags_status = "OFF"
                _handle_status_transition(prev_status, ags_status, hass)
                hass.data['ags_status'] = ags_status
                hass.data['schedule_prev_state'] = schedule_on
                hass.data['schedule_state'] = schedule_on
                return ags_status

            hass.data['schedule_prev_state'] = schedule_on
            hass.data['schedule_state'] = schedule_on

    if not media_system_state:
        ags_status = "OFF"
        _handle_status_transition(prev_status, ags_status, hass)
        hass.data['ags_status'] = ags_status
        return ags_status


    # Check switched-on rooms for TV and determine global tv_mode.
    # This intentionally matches the broader V2.0.1 behavior so TV mode
    # continues to hold when the room itself is enabled.
    tv_found = False
    active_tv_mode = None
    for room in rooms:
        safe_room_id = "".join(c for c in room['room'].lower().replace(' ', '_') if c.isalnum() or c == '_')
        while "__" in safe_room_id:
            safe_room_id = safe_room_id.replace("__", "_")
        room_key = f"switch.{safe_room_id}_media"
        if not hass.data.get(room_key):
            continue

        room_tv_on = False
        room_tv_audio = False
        for device in room['devices']:
            device_state = device_states.get(device['device_id'])
            # FIX 6: Ghost TV expansion
            if (
                device.get('device_type') == 'tv'
                and is_tv_mode_state(device_state)
            ):
                room_tv_on = True
                if device.get('tv_mode', TV_MODE_TV_AUDIO) == TV_MODE_TV_AUDIO:
                    room_tv_audio = True

        if room_tv_on:
            tv_found = True
            if room_tv_audio:
                active_tv_mode = TV_MODE_TV_AUDIO
            elif active_tv_mode != TV_MODE_TV_AUDIO and active_tv_mode is None:
                active_tv_mode = TV_MODE_NO_MUSIC

    hass.data['current_tv_mode'] = active_tv_mode if tv_found else None

    if tv_found:
        if active_tv_mode != TV_MODE_NO_MUSIC:
            ags_status = "ON TV"
            _handle_status_transition(prev_status, ags_status, hass)
            hass.data['ags_status'] = ags_status
            return ags_status

    ags_status = "ON"
    _handle_status_transition(prev_status, ags_status, hass)
    hass.data['ags_status'] = ags_status
    return ags_status

def check_primary_speaker_logic(ags_config, hass):
    rooms = ags_config.get('rooms', [])
    ags_status = hass.data.get('ags_status')
    active_rooms_entity = hass.data.get('active_rooms')
    active_rooms = active_rooms_entity if active_rooms_entity is not None else None

    # Get the current primary speaker to check for stickiness
    current_primary = hass.data.get('primary_speaker')
    active_speakers = hass.data.get('active_speakers', [])

    if ags_status == 'Override':
        # ... (keep override logic as is)
        override_devices = []
        for room in rooms:
            for device in room['devices']:
                override_val = device.get('override_content')
                if override_val:
                    state = hass.states.get(device['device_id'])
                    if state:
                        attrs = state.attributes
                        if (override_val in str(attrs.get('media_content_id', '')) or
                            override_val in str(attrs.get('source', '')) or
                            override_val in str(attrs.get('media_title', ''))):
                            override_devices.append(device)

        override_devices = sorted(override_devices, key=lambda x: x['priority'])
        if override_devices:
            return override_devices[0]['device_id']

    elif ags_status == 'ON TV':
        tv_primary = get_active_tv_primary_speaker(rooms, hass)
        if tv_primary:
            return tv_primary

    elif ags_status == 'OFF':
        return ""

    elif ags_status is not None:
        # STICKY MASTER LOGIC:
        # If we already have a primary speaker, and it's still playing in an active room,
        # keep it. This prevents Sonos from cutting music when a higher priority
        # room is turned on but the current music is already playing fine.
        if current_primary and current_primary != "none":
            state = hass.states.get(current_primary)
            # FIX 5/6: Ghost TV / Idle lockout expansion
            if state and state.state.lower() not in ['off', 'unavailable', 'unknown', 'standby']:

                # Verify it's not playing a "rogue" source (like a manual YouTube cast)
                # If ags_status is "ON", we expect music. If "ON TV", we expect "TV" source.
                current_source = state.attributes.get("source")
                is_rogue = False
                if ags_status == "ON TV" and current_source != "TV":
                    is_rogue = True
                elif ags_status == "ON" and current_source == "TV":
                    # Only rogue if an actual TV in this room is ACTIVE
                    is_rogue = False
                    for room in rooms:
                        if any(d['device_id'] == current_primary for d in room['devices']):
                            # FIX 6: Ghost TV
                            if any(
                                d['device_type'] == 'tv'
                                and is_tv_mode_state(hass.states.get(d['device_id']))
                                for d in room['devices']
                            ):
                                is_rogue = True
                            break

                if not is_rogue:
                    # Check if this speaker is in an active room
                    is_active = False
                    for room in rooms:
                        if room['room'] in (active_rooms or []):
                            if any(d['device_id'] == current_primary for d in room['devices']):
                                is_active = True
                                break
                    if is_active:
                        return current_primary

        # If no sticky master, find the best playing speaker
        for room in rooms:
            if active_rooms is not None and room['room'] in active_rooms:
                sorted_devices = sorted(room["devices"], key=lambda x: x['priority'])
                tv_on = False
                for device in sorted_devices:
                    device_state = hass.states.get(device['device_id'])
                    # FIX 6: Ghost TV
                    if device['device_type'] == 'tv' and is_tv_mode_state(device_state):
                        tv_on = True
                        break

                for device in sorted_devices:
                    device_state = hass.states.get(device['device_id'])
                    if device_state is None:
                        continue

                    # FIX 5: Allow idle states for initial music from dead stop
                    if (
                        device['device_type'] == 'speaker' and
                        device_state.state.lower() not in ['off', 'unavailable', 'unknown', 'standby']
                    ):
                        source = device_state.attributes.get('source')
                        if tv_on or (not tv_on and (source is None or source != 'TV')):
                            return device['device_id']

        # FIX 5: Standalone Room Fallback
        preferred_primary = hass.data.get('preferred_primary_speaker')
        if preferred_primary and preferred_primary != "none":
            return preferred_primary

    return "none"

### Function to get primary speaker ##
def determine_primary_speaker(ags_config, hass):
    """Determine the primary speaker without blocking Home Assistant."""

    # First pass through the logic
    primary_speaker = check_primary_speaker_logic(ags_config, hass)


    # Store the immediate result
    hass.data['primary_speaker'] = primary_speaker

    return primary_speaker

### Function for Active and Inactive list ###
def update_speaker_states(rooms, hass):
    # Retrieve the AGS status and media system state
    ags_status = hass.data.get('ags_status', 'OFF')

    # Fetch the list of active rooms from hass.data
    active_rooms = hass.data.get('active_rooms', [])

    # Initialize empty lists for active and inactive speakers
    active_speakers = []
    inactive_speakers = []

    # All speakers list
    all_speakers = [device['device_id'] for room in rooms for device in room['devices'] if device['device_type'] == 'speaker']

    # If AGS system status is 'OFF' or the media system state is 'off', all speakers are inactive
    if ags_status == 'OFF':
        inactive_speakers = all_speakers
    else:
        for room in rooms:
            for device in room['devices']:
                if device['device_type'] == 'speaker':
                    if room['room'] in active_rooms:
                        active_speakers.append(device['device_id'])
                    elif not hass.states.get(device['device_id']) or hass.states.get(device['device_id']).state != 'on':
                        inactive_speakers.append(device['device_id'])

    # Store the lists in hass.data
    hass.data['active_speakers'] = active_speakers
    hass.data['inactive_speakers'] = inactive_speakers

    return active_speakers, inactive_speakers




### Function for Preferred primary speaker ###
def get_preferred_primary_speaker(rooms, hass):
    active_speakers = hass.data.get('active_speakers')

    if not active_speakers:
        preferred_primary_speaker = "none"
    else:
        # Generate a list of all devices in active speakers
        all_devices = [device for room in rooms for device in room['devices'] if device['device_id'] in active_speakers]

        # Sort the devices by priority (lowest number first)
        sorted_devices = sorted(all_devices, key=lambda x: x['priority'])

        # Return the device_id of the highest priority device
        preferred_primary_speaker = sorted_devices[0]['device_id'] if sorted_devices else "none"

    # Write the preferred primary speaker's state to hass.data
    hass.data['preferred_primary_speaker'] = preferred_primary_speaker

    return preferred_primary_speaker

### Function for Inactive tv Speakers ###
def get_inactive_tv_speakers(rooms, hass):
    ags_status = hass.data.get('ags_status')

    # If ags_status is OFF, consider all rooms as inactive
    if ags_status == "OFF":
        inactive_rooms = rooms
    else:
        active_rooms = hass.data.get('active_rooms')
        inactive_rooms = [room for room in rooms if active_rooms is not None and room['room'] not in active_rooms]

    inactive_tv_speakers = [device['device_id'] for room in inactive_rooms for device in room['devices'] if device['device_type'] == 'speaker' and any(d['device_type'] == 'tv' for d in room['devices'])]

    # Write the inactive TV speakers' state to hass.data
    hass.data['ags_inactive_tv_speakers'] = inactive_tv_speakers

    return inactive_tv_speakers


def get_control_device_id(ags_config, hass):
    """Return the device that should receive control commands."""
    ags_status = hass.data.get('ags_status')
    primary_speaker = hass.data.get('primary_speaker')

    if not primary_speaker or primary_speaker == 'none':
        primary_speaker = hass.data.get('preferred_primary_speaker')
        if not primary_speaker or primary_speaker == 'none':
            primary_speaker = get_first_available_speaker(ags_config.get("rooms", []), hass)
        if primary_speaker:
            hass.data['primary_speaker'] = primary_speaker

    if not primary_speaker or primary_speaker == 'none':
        return None

    primary_room = None
    primary_room_devices = None
    for room in ags_config.get('rooms', []):
        for device in room['devices']:
            if device['device_id'] == primary_speaker:
                primary_room = room
                primary_room_devices = room['devices']
                break
        if primary_room:
            break

    if ags_status == 'ON TV' and primary_room_devices:
        sorted_devices = sorted(
            [d for d in primary_room_devices if d['device_type'] != 'speaker'],
            key=lambda x: x['priority'],
        )
        if sorted_devices:
            tv_device = sorted_devices[0]
            ott_devices = tv_device.get('ott_devices')

            if ott_devices:
                # Fetch the TV's current state to see what input is active
                tv_state = hass.states.get(tv_device['device_id'])
                current_input = tv_state.attributes.get('source') if tv_state else None

                # Try to find a matching input
                for ott in ott_devices:
                    if ott.get('tv_input') == current_input:
                        return ott['ott_device']

                # Fallback to the first device in the list if no match
                return ott_devices[0]['ott_device']

            return tv_device.get('ott_device', tv_device['device_id'])

    primary_state = hass.states.get(primary_speaker) if primary_speaker else None
    if primary_state is not None and primary_state.state.lower() not in TV_IGNORE_STATES:
        return primary_speaker

    return get_first_available_speaker(ags_config.get("rooms", []), hass) or primary_speaker









async def ags_select_source(ags_config, hass, ignore_playing: bool = False):
    """Select the configured music source on the primary speaker.

    When ``ignore_playing`` is ``True`` the source changes even if the device
    is already playing.  Otherwise the function returns early whenever a music
    source is selected while playback is active.
    """

    try:
        actions_switch = hass.states.get("switch.ags_actions")
        actions_enabled = actions_switch.state == "on" if actions_switch else True
        if not actions_enabled:
            return

        ags_data = hass.data.get("ags_service", {})
        configured_sources = combine_source_inventory(ags_data)
        source = resolve_music_source_name(
            ags_config,
            hass,
            preferred_source=hass.data.get("ags_media_player_source"),
        )

        if not source:
            return

        source_entry = find_source_by_name_or_id(ags_data, source)
        if source_entry:
            source = source_entry["Source"]
            hass.data["ags_media_player_source_id"] = source_entry["id"]
        hass.data["ags_media_player_source"] = source
        status = hass.data.get("ags_status", "OFF")

        primary_speaker_entity_id = get_control_device_id(ags_config, hass)
        if not primary_speaker_entity_id or primary_speaker_entity_id == "none":
            primary_speaker_entity_id = hass.data.get("preferred_primary_speaker", "")

        state = hass.states.get(primary_speaker_entity_id)
        if state is None or state.state == "unavailable":
            _LOGGER.warning(
                "Primary master %s is unavailable, searching for failover",
                primary_speaker_entity_id,
            )
            for spk in hass.data.get("active_speakers", []):
                speaker_state = hass.states.get(spk)
                if speaker_state and speaker_state.state != "unavailable":
                    primary_speaker_entity_id = spk
                    hass.data["primary_speaker"] = spk
                    state = speaker_state
                    _LOGGER.info("Failover elected: %s", spk)
                    break

        if (
            not primary_speaker_entity_id
            or primary_speaker_entity_id == "none"
            or state is None
            or state.state == "unavailable"
        ):
            _LOGGER.error("No available speakers found for source selection")
            return

        disable_tv_source = ags_config.get("disable_tv_source", False)

        if source == "TV":
            if disable_tv_source:
                return
            await enqueue_media_action(
                hass,
                "select_source",
                {"source": source, "entity_id": primary_speaker_entity_id},
            )
            return

        if status == "ON TV" and not disable_tv_source and source != "Unknown":
            await enqueue_media_action(
                hass,
                "select_source",
                {"source": source, "entity_id": primary_speaker_entity_id},
            )
            return

        if source == "Unknown" or status != "ON":
            return

        if source_entry:
            source_entry, primary_speaker_entity_id = _pick_source_and_speaker(
                configured_sources,
                source_entry,
                primary_speaker_entity_id,
                ags_config,
                hass,
            )
            source = source_entry["Source"]
            hass.data["ags_media_player_source_id"] = source_entry["id"]
            hass.data["ags_media_player_source"] = source
            state = hass.states.get(primary_speaker_entity_id)

        source_dict = {
            src["Source"]: {
                "id": src.get("id"),
                "value": src["Source_Value"],
                "type": src.get("media_content_type") or "music",
                "can_play": src.get("can_play", True),
                "can_expand": src.get("can_expand", False),
            }
            for src in configured_sources
        }

        # When coming back from TV mode, some speakers can stay logically stuck
        # on the TV input unless we explicitly push them off it before starting
        # music again.
        current_source = state.attributes.get("source")
        if current_source == "TV":
            available_sources = state.attributes.get("source_list") or []
            if source in available_sources and source != "TV":
                await enqueue_media_action(
                    hass,
                    "select_source",
                    {"source": source, "entity_id": primary_speaker_entity_id},
                )
                await enqueue_media_action(
                    hass, "delay", {"seconds": SHORT_ACTION_DELAY}
                )

        if (
            not ignore_playing
            and state.state == "playing"
            and state.attributes.get("source") != "TV"
        ):
            return

        source_info = source_dict.get(source)
        if not source_info:
            _LOGGER.warning("Source %s was selected but is not available in AGS sources", source)
            return
        if source_info.get("can_play") is False:
            if not source_info.get("can_expand"):
                _LOGGER.warning("Source %s is not playable", source)
                return
            playable = await _resolve_folder_source_to_playable(
                hass,
                primary_speaker_entity_id,
                source_info,
            )
            if not playable:
                _LOGGER.warning("Source %s folder did not contain a playable item", source)
                return
            source_info = {
                **source_info,
                "value": playable["media_content_id"],
                "type": playable["media_content_type"],
                "can_play": True,
                "can_expand": False,
            }

        media_id = str(source_info["value"])
        media_type = source_info["type"]

        if not media_id or not media_type:
            _LOGGER.warning("Source %s is missing media_id or media_type", source)
            return

        if media_type == "source":
            await enqueue_media_action(
                hass,
                "select_source",
                {"source": media_id, "entity_id": primary_speaker_entity_id},
            )
            return

        if (
            media_type == "favorite_item_id"
            and media_id
            and not media_id.startswith(SONOS_FAVORITE_PREFIX)
        ):
            registry = er.async_get(hass)
            entry = registry.async_get(primary_speaker_entity_id)
            if entry and entry.platform == "sonos":
                media_id = f"{SONOS_FAVORITE_PREFIX}{media_id}"

        await enqueue_media_action(
            hass,
            "play_media",
            {
                "entity_id": primary_speaker_entity_id,
                "media_content_id": media_id,
                "media_content_type": media_type,
            },
        )

    except Exception as exc:  # pragma: no cover - safety net
        _LOGGER.exception("Error in ags_select_source: %s", exc)
        return






async def handle_ags_status_change(hass, ags_config, new_status, old_status):
    """React to status changes and room switch events.

    Every path that changes the AGS state calls this helper so the speaker
    grouping and source logic executes in one place.  ``new_status`` is the
    desired service state (``ON``, ``ON TV`` or ``OFF``).  The flow is:

    1. Wait for any previously queued actions to finish so sensor data is
       accurate.
    2. Determine the *calculated primary speaker* using the current
       ``primary_speaker`` and ``preferred_primary_speaker`` values.
       When ``ON TV`` the preferred device is chosen if it differs from the
       primary.
    3. Compare the speaker's group members with ``active_speakers`` and issue
       join or unjoin commands only when necessary.
    4. Select the correct playback source (music or TV) based on the final
       status.  If the devices are already grouped and playing the right
       source nothing is sent.
    """
    handler_lock = hass.data.get(DOMAIN, {}).get("status_handler_lock")
    if handler_lock is None:
        handler_lock = asyncio.Lock()
        hass.data.setdefault(DOMAIN, {})["status_handler_lock"] = handler_lock

    async with handler_lock:
        try:
            await _handle_ags_status_change(hass, ags_config, new_status, old_status)
        except Exception as exc:  # pragma: no cover - safety net
            _LOGGER.exception("Error handling AGS status change: %s", exc)


async def _handle_ags_status_change(hass, ags_config, new_status, old_status):
    """Internal implementation for ``handle_ags_status_change``."""
    try:
        _LOGGER.debug("AGS status transition: %s -> %s", old_status, new_status)
        # Ensure any prior media actions have finished before evaluating the
        # new state.
        await wait_for_actions(hass)

        current_status = hass.data.get("ags_status")
        if current_status != new_status:
            _LOGGER.debug(
                "Skipping stale AGS transition %s -> %s; current status is %s",
                old_status,
                new_status,
                current_status,
            )
            return

        # Skip repeated "OFF" handling once the system is fully stopped
        if new_status == "OFF" and old_status == "OFF":
            return

        rooms = ags_config.get("rooms", [])

        # Performance optimization: Only fetch states for configured devices
        # instead of the entire HA state machine.
        configured_entities = {d["device_id"] for r in rooms for d in r["devices"]}
        device_states = {
            eid: hass.states.get(eid)
            for eid in configured_entities
            if hass.states.get(eid) is not None
        }

        tv_map = {
            d["device_id"]: any(dev.get("device_type") == "tv" for dev in room["devices"])
            for room in rooms
            for d in room["devices"]
            if d.get("device_type") == "speaker"
        }

        # FIX 9: Direct Killswitch Fetching
        state_obj = hass.states.get("switch.ags_actions")
        actions_enabled = state_obj.state == "on" if state_obj else True

        if new_status == "OFF":
            _LOGGER.info("AGS System turning OFF - stopping all playback and ungrouping")
            # When turning off simply ungroup everything and stop playback. The
            # actions can be disabled globally via the AGS Actions switch.
            if not actions_enabled:
                return

            # Unjoin every speaker first so the group resets to a clean state
            all_speakers = [
                d["device_id"]
                for r in rooms
                for d in r["devices"]
                if d.get("device_type") == "speaker"
                and (state := device_states.get(d["device_id"])) is not None
                and state.state != "unavailable"
            ]

            if all_speakers:
                if ags_config.get("batch_unjoin"):
                    await enqueue_media_action(hass, "unjoin", {"entity_id": all_speakers})
                else:
                    for spk in all_speakers:
                        await enqueue_media_action(hass, "unjoin", {"entity_id": spk})
                await enqueue_media_action(
                    hass, "wait_ungrouped", {"entity_id": all_speakers, "timeout": UNGROUP_TIMEOUT}
                )
                await enqueue_media_action(hass, "delay", {"seconds": SHORT_ACTION_DELAY})

            tv_speakers: list[str] = []
            regular_speakers: list[str] = []

            for room in rooms:
                for d in room["devices"]:
                    if d.get("device_type") == "speaker":
                        if any(dev.get("device_type") == "tv" for dev in room["devices"]):
                            tv_speakers.append(d["device_id"])
                        else:
                            regular_speakers.append(d["device_id"])

            for spk in tv_speakers:
                state = hass.states.get(spk)
                if state and state.state != "unavailable" and not ags_config.get("disable_tv_source"):
                    await restore_speaker_to_tv_input(
                        hass,
                        spk,
                        stop_first=True,
                    )

            for spk in regular_speakers:
                state = device_states.get(spk)
                if state and state.state != "unavailable":
                    await enqueue_media_action(
                        hass, "media_stop", {"entity_id": spk}
                    )

            return

        # For ON/ON TV decide which speaker should lead the group. Start with
        # the current primary speaker but fall back to the preferred speaker
        # when needed.
        primary = hass.data.get("primary_speaker")
        preferred = hass.data.get("preferred_primary_speaker")

        if new_status == "ON TV":
            calculated = get_active_tv_primary_speaker(rooms, hass)
            if not calculated:
                calculated = primary if primary not in (None, "none") else preferred
        else:
            calculated = primary if primary not in (None, "none") else preferred

        if not calculated or calculated == "none":
            # FIX 1: Fix "TV_MODE_NO_MUSIC" cleanup loop
            extras = []
            active_rooms = hass.data.get("active_rooms", [])
            for room in rooms:
                room_tv_no_music = False
                for device in room['devices']:
                    if device.get('device_type') == 'tv' and device.get('tv_mode') == TV_MODE_NO_MUSIC:
                        s = hass.states.get(device['device_id'])
                        # FIX 6: Ghost TV
                        if is_tv_mode_state(s):
                            room_tv_no_music = True
                            break

                if room["room"] not in active_rooms:
                    for d in room["devices"]:
                        if d.get("device_type") == "speaker":
                            # If room is inactive but it's a TV room in NO_MUSIC mode, skip shutdown
                            if room_tv_no_music:
                                continue

                            spk = d["device_id"]
                            state = hass.states.get(spk)
                            if state and state.state.lower() not in ['off', 'idle', 'paused', 'standby', 'unavailable']:
                                if spk not in extras:
                                    extras.append(spk)

            if extras and actions_enabled:
                await enqueue_media_action(hass, "unjoin", {"entity_id": extras})
                await enqueue_media_action(
                    hass, "wait_ungrouped", {"entity_id": extras, "timeout": UNGROUP_TIMEOUT}
                )
                await enqueue_media_action(hass, "delay", {"seconds": SHORT_ACTION_DELAY})
                for spk in extras:
                    state = hass.states.get(spk)
                    if not state or state.state == "unavailable":
                        _LOGGER.debug(
                            "Skipped media_stop for %s – state unavailable", spk
                        )
                        continue
                    if tv_map.get(spk) and not ags_config.get("disable_tv_source"):
                        await restore_speaker_to_tv_input(
                            hass,
                            spk,
                            stop_first=True,
                        )
                    else:
                        await enqueue_media_action(
                            hass, "media_stop", {"entity_id": spk}
                        )
                        await enqueue_media_action(hass, "delay", {"seconds": SHORT_ACTION_DELAY})
            return

        state = hass.states.get(calculated)
        if state is None or state.state == "unavailable":
            return

        # Compare the speaker's current group members with the active speaker
        # list to determine any join or unjoin operations.
        group_members = state.attributes.get("group_members")
        if not isinstance(group_members, list):
            group_members = [] if group_members is None else [group_members]

        active_speakers = [
            spk
            for spk in hass.data.get("active_speakers", [])
            if (spk_state := hass.states.get(spk)) is not None
            and spk_state.state != "unavailable"
        ]

        group_set = set(group_members)
        active_set = set(active_speakers)

        missing = sorted(active_set - group_set - {calculated})
        extra = sorted(group_set - active_set - {calculated})

        if not missing and not extra:
            _LOGGER.debug("AGS group for %s is already synchronized", calculated)

        if missing and actions_enabled:
            _LOGGER.info("AGS joining speakers to %s: %s", calculated, missing)

            # OPTIMIZATION: Sync volume of joining speakers with the master
            # before joining for a seamless audio transition.
            master_state = hass.states.get(calculated)
            if master_state and "volume_level" in master_state.attributes:
                await enqueue_media_action(
                    hass,
                    "volume_set",
                    {
                        "entity_id": missing,
                        "volume_level": master_state.attributes["volume_level"]
                    }
                )
                await enqueue_media_action(hass, "delay", {"seconds": SHORT_ACTION_DELAY})

            # Join using only the followers (exclude the master from group_members)
            followers = [spk for spk in active_speakers if spk != calculated]
            if followers:
                await enqueue_media_action(
                    hass,
                    "join",
                    {"entity_id": calculated, "group_members": followers},
                )
                # Short delay to let Sonos settle the group
                await enqueue_media_action(hass, "delay", {"seconds": GROUP_SETTLE_DELAY})
            else:
                _LOGGER.debug("No followers to join to %s", calculated)

        if extra and actions_enabled:
            _LOGGER.info("AGS unjoining extra speakers from %s: %s", calculated, extra)
            await enqueue_media_action(hass, "unjoin", {"entity_id": extra})
            await enqueue_media_action(
                hass, "wait_ungrouped", {"entity_id": extra, "timeout": UNGROUP_TIMEOUT}
            )
            await enqueue_media_action(hass, "delay", {"seconds": SHORT_ACTION_DELAY})
            for spk in extra:
                state = hass.states.get(spk)
                if not state or state.state == "unavailable":
                    _LOGGER.debug("Skipped media_stop for %s – state unavailable", spk)
                    continue
                if tv_map.get(spk) and not ags_config.get("disable_tv_source"):
                    await restore_speaker_to_tv_input(
                        hass,
                        spk,
                        stop_first=True,
                    )
                else:
                    await enqueue_media_action(
                        hass, "media_stop", {"entity_id": spk}
                    )
                    await enqueue_media_action(hass, "delay", {"seconds": SHORT_ACTION_DELAY})

        if (missing or extra) and actions_enabled:
            await wait_for_actions(hass)
            await _wait_until_grouped(
                hass,
                calculated,
                active_speakers,
                timeout=GROUP_TIMEOUT,
            )
            # Refresh the speaker state after grouping changes so the playback
            # check below evaluates the latest status.
            state = hass.states.get(calculated)
            if state is None or state.state == "unavailable":
                return

        # Source selection depends on the current status. Browser playback
        # queues its own play_media action after grouping, so avoid racing it
        # with the saved/default AGS source.
        if hass.data.get("ags_browser_play_pending"):
            _LOGGER.debug(
                "Skipping automatic source selection while browser playback is pending"
            )
        elif new_status == "ON TV":
            if hass.data.get("current_tv_mode", TV_MODE_TV_AUDIO) != TV_MODE_NO_MUSIC:
                if "TV" in (state.attributes.get("source_list") or []) and actions_enabled:
                    if state.attributes.get("source") != "TV":
                        _LOGGER.info("Switching %s to TV source", calculated)
                        await enqueue_media_action(
                            hass, "select_source", {"entity_id": calculated, "source": "TV"}
                        )
            else:
                _LOGGER.debug("tv_mode set to no_music - skipping TV commands")
        elif new_status == "ON":
            if actions_enabled:
                music_is_active = has_active_music_playback(
                    hass,
                    hass.data.get("active_speakers", []),
                )
                current_source = state.attributes.get("source")
                should_restore_music = (
                    old_status != "ON"
                    or current_source == "TV"
                    or not music_is_active
                )
                if should_restore_music:
                    _LOGGER.info(
                        "Restoring music source on %s (old_status=%s, source=%s, music_active=%s)",
                        calculated,
                        old_status,
                        current_source,
                        music_is_active,
                    )
                    await ags_select_source(ags_config, hass, ignore_playing=True)
                else:
                    _LOGGER.debug(
                        "Skipping source restore for %s because AGS stayed in music mode",
                        calculated,
                    )

    except Exception as exc:  # pragma: no cover - safety net
        _LOGGER.warning("Error handling AGS status change: %s", exc)

def get_browsing_fallback_speaker(rooms, hass):
    """Pick the highest priority speaker across all rooms for browsing when idle."""
    all_speakers = []
    for room in rooms:
        for device in room['devices']:
            if device.get('device_type') == 'speaker':
                all_speakers.append(device)

    if not all_speakers:
        hass.data['browsing_fallback_speaker'] = "none"
        return "none"

    sorted_spks = sorted(all_speakers, key=lambda x: x.get('priority', 999))
    res = sorted_spks[0]['device_id']
    hass.data['browsing_fallback_speaker'] = res
    return res
