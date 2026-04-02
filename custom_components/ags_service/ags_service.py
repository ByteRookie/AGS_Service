# ags_service .py
import logging
import asyncio
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

CONF_TV_MODE = 'tv_mode'
TV_MODE_TV_AUDIO = 'tv_audio'
TV_MODE_NO_MUSIC = 'no_music'

SONOS_FAVORITE_PREFIX = "FV:"

# Ghost TV ignore list
TV_IGNORE_STATES = ['off', 'unavailable', 'unknown', 'standby', 'idle', 'paused', 'buffering', 'none', 'power_off', 'sleeping']


_LOGGER = logging.getLogger(__name__)

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


async def _wait_until_ungrouped(
    hass: HomeAssistant, entity_ids: list[str] | str, timeout: float = 3.0
) -> None:
    """Pause until the given speakers report no grouping."""
    if isinstance(entity_ids, str):
        entity_ids = [entity_ids]

    end = hass.loop.time() + timeout
    while hass.loop.time() < end:
        all_clear = True
        for ent in entity_ids:
            state = hass.states.get(ent)
            if state is None:
                continue
            members = state.attributes.get("group_members")
            if not isinstance(members, list):
                members = [] if members is None else [members]
            if members not in ([], [ent]):
                all_clear = False
                break
        if all_clear:
            return
        await asyncio.sleep(0.1)


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
        if prev_source is not None:
            hass.data["ags_media_player_source"] = prev_source

### Sensor Functions ###

## update all Sensors Function ##
async def update_ags_sensors(ags_config, hass):
    """Refresh sensor data and trigger the status handler when needed.

    The function returns ``(prev_status, new_status)``.  When the status
    changes ``handle_ags_status_change`` is scheduled automatically so every
    update path (sensors, schedules and switches) funnels through the same
    logic.
    """
    rooms = ags_config['rooms']
    
    # Safety check for domain data during unload or failed setup
    if 'ags_service' not in hass.data:
        _LOGGER.debug("AGS service data not found during sensor update")
        return None, None

    lock = hass.data['ags_service']['sensor_lock']

    async with lock:
        # Call and execute the functions to set sensor values for all of AGS
        # Configured rooms rarely change, only compute once
        if 'configured_rooms' not in hass.data:
            get_configured_rooms(rooms, hass)
        prev_rooms = hass.data.get('active_rooms', [])
        get_active_rooms(rooms, hass)
        new_rooms = hass.data.get('active_rooms', [])
        prev_status = hass.data.get('ags_status')
        update_ags_status(ags_config, hass)
        update_speaker_states(rooms, hass)
        get_preferred_primary_speaker(rooms, hass)
        determine_primary_speaker(ags_config, hass)
        get_inactive_tv_speakers(rooms, hass)
        new_status = hass.data.get('ags_status')
        
        # FIX 7: Startup "Resume" Trigger
        if new_status != prev_status or new_rooms != prev_rooms or prev_status is None:
            await handle_ags_status_change(
                hass, ags_config, new_status, prev_status
            )
        ## Use in Future release ###
        #if hass.data.get('primary_speaker') == "none" and hass.data.get('active_speakers') != [] and hass.data.get('preferred_primary_speaker') != "none":
        #    _LOGGER.error("ags source change has been called")
        #    ags_select_source(ags_config, hass)

        sensors = hass.data.get('ags_sensors', [])
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

    # If we've already computed this list return the cached value
    if 'configured_rooms' in hass.data:
        return hass.data['configured_rooms']

    # Extract the list of configured rooms once at startup
    configured_rooms = [room['room'] for room in rooms]

    # Store the list in hass.data
    hass.data['configured_rooms'] = configured_rooms

    return configured_rooms

## Function for Active room ###
def get_active_rooms(rooms, hass):
    """Fetch the list of active rooms based on switches in hass.data."""
    
    active_rooms = []

    for room in rooms:
        safe_room_id = "".join(c for c in room['room'].lower().replace(' ', '_') if c.isalnum() or c == '_')
        room_key = f"switch.{safe_room_id}_media"
        if not hass.data.get(room_key):
            continue

        skip_room = False
        for device in room['devices']:
            if device.get('device_type') != 'tv':
                continue
            state = hass.states.get(device['device_id'])
            # FIX 6: Ghost TV expansion
            if state and state.state.lower() not in TV_IGNORE_STATES:
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
    rooms = ags_config['rooms']
    active_rooms = hass.data.get('active_rooms', [])
    prev_status = hass.data.get('ags_status')
    
    # Default status to OFF
    ags_status = "OFF"

    # If the zone is disabled and the state of 'zone.home' is '0', set status to "OFF"
    zone_state = hass.states.get('zone.home')
    if not ags_config.get('disable_zone', False):
        if zone_state is None:
            _LOGGER.warning("zone.home entity not found; skipping zone check")
        elif zone_state.state == '0':
            ags_status = "OFF"
            hass.data['ags_status'] = ags_status
            return ags_status

    # Prepare a dictionary of device states
    device_states = {device['device_id']: hass.states.get(device['device_id']) for room in rooms for device in room['devices']}

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
        if schedule_cfg and schedule_cfg.get('schedule_override') and not schedule_on:
            media_system_state = False
        else:
            media_system_state = ags_config['default_on']
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
            if not schedule_on:
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


    # Check for TV in active rooms and determine global tv_mode
    tv_found = False
    active_tv_mode = None
    for room in rooms:
        safe_room_id = "".join(c for c in room['room'].lower().replace(' ', '_') if c.isalnum() or c == '_')
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
                and device_state
                and device_state.state.lower() not in TV_IGNORE_STATES
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

    if tv_found:
        hass.data['current_tv_mode'] = active_tv_mode
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
    rooms = ags_config['rooms']
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
                            if any(d['device_type'] == 'tv' and (s := hass.states.get(d['device_id'])) and s.state.lower() not in TV_IGNORE_STATES for d in room['devices']):
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
                    if device['device_type'] == 'tv' and device_state is not None and device_state.state.lower() not in TV_IGNORE_STATES:
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
        hass.data['primary_speaker'] = primary_speaker

    if not primary_speaker or primary_speaker == 'none':
        return None

    primary_room = None
    primary_room_devices = None
    for room in ags_config['rooms']:
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

    return primary_speaker









async def ags_select_source(ags_config, hass, ignore_playing: bool = False):
    """Select the configured music source on the primary speaker.

    When ``ignore_playing`` is ``True`` the source changes even if the device
    is already playing.  Otherwise the function returns early whenever a music
    source is selected while playback is active.
    """

    try:
        # FIX 9: Direct Killswitch Fetching
        state_obj = hass.states.get("switch.ags_actions")
        actions_enabled = state_obj.state == "on" if state_obj else True
        if not actions_enabled:
            return

        source = hass.data.get('ags_media_player_source')
        
        if source is None:
            sources_list = hass.data['ags_service']['Sources']
            
            # Check default source schedule override
            sched_cfg = ags_config.get("default_source_schedule")
            if sched_cfg and sched_cfg.get("entity_id") and sched_cfg.get("source_name"):
                state_obj = hass.states.get(sched_cfg["entity_id"])
                if state_obj and state_obj.state == sched_cfg.get("on_state", "on"):
                    source = sched_cfg["source_name"]
            
            # Normal default
            if source is None:
                source = next((src["Source"] for src in sources_list if src.get("source_default") is True), None)
            if source is None and sources_list:
                source = sources_list[0]["Source"]
                
            if source is not None:
                hass.data['ags_media_player_source'] = source
        status = hass.data.get('ags_status', "OFF")
        primary_speaker_entity_id_raw = get_control_device_id(ags_config, hass)

        # Phase 3: Dead Master Failsafe Refinement
        # Ensure we have a functional device BEFORE evaluating overrides
        primary_speaker_entity_id = primary_speaker_entity_id_raw
        if not primary_speaker_entity_id or primary_speaker_entity_id == "none":
            primary_speaker_entity_id = hass.data.get('preferred_primary_speaker', "")
        
        state = hass.states.get(primary_speaker_entity_id)
        if state is None or state.state == "unavailable":
             _LOGGER.warning("Primary master %s is unavailable, searching for failover", primary_speaker_entity_id)
             active_speakers = hass.data.get('active_speakers', [])
             failover_found = False
             for spk in active_speakers:
                 s = hass.states.get(spk)
                 if s and s.state != "unavailable":
                     primary_speaker_entity_id = spk
                     hass.data['primary_speaker'] = spk
                     failover_found = True
                     _LOGGER.info("Failover elected: %s", spk)
                     break
             if not failover_found:
                 _LOGGER.error("No available speakers found for source selection")
                 return

        # Re-fetch state for the elected (or failover) device
        state = hass.states.get(primary_speaker_entity_id)
        if state is None or state.state == "unavailable":
            return

        # Phase 3: Cascading Source Overrides
        # Find the device entry in the config to check for overrides
        target_device_entry = None
        target_room = None
        for room in ags_config['rooms']:
            for device in room['devices']:
                if device['device_id'] == primary_speaker_entity_id:
                    target_device_entry = device
                    target_room = room
                    break
            if target_device_entry:
                break
        
        tv_is_on = False
        active_tvs = []
        for room in ags_config['rooms']:
            for device in room['devices']:
                if device['device_type'] == 'tv':
                    s = hass.states.get(device['device_id'])
                    if s and s.state.lower() not in TV_IGNORE_STATES:
                        active_tvs.append(device['device_id'])
                        tv_is_on = True
        
        script_vars = {
            "target_device": primary_speaker_entity_id,
            "tv_is_on": tv_is_on,
            "active_tvs": active_tvs,
            "active_speakers": hass.data.get('active_speakers', []),
        }

        async def execute_override(override):
            if override['mode'] == 'script':
                await hass.services.async_call("script", override['script_entity'].split('.')[-1], script_vars)
                return True
            elif override['mode'] == 'source':
                await enqueue_media_action(hass, 'select_source', {"source": override['source_value'], "entity_id": primary_speaker_entity_id})
                return True
            return False

        # Step A (TV Override)
        if tv_is_on:
            for tv_id in active_tvs:
                # Find TV device config
                tv_cfg = None
                for room in ags_config['rooms']:
                    for device in room['devices']:
                        if device['device_id'] == tv_id:
                            tv_cfg = device
                            break
                    if tv_cfg: break
                
                if tv_cfg and 'source_overrides' in tv_cfg:
                    for override in tv_cfg['source_overrides']:
                        if override['source_name'] == source:
                            if await execute_override(override): return

        # Step B (Speaker Fallback)
        if target_device_entry and 'source_overrides' in target_device_entry:
            for override in target_device_entry['source_overrides']:
                if override['source_name'] == source:
                    if not tv_is_on or override.get('run_when_tv_off', False) is False:
                         if await execute_override(override): return

        # Step C (Global Fallback)
        # Convert the list of sources to a dictionary for faster lookups
        sources_list = hass.data['ags_service']['Sources'] 
        source_dict = {src["Source"]: {"value": src["Source_Value"], "type": src.get("media_content_type")} for src in sources_list}


        disable_tv_source = ags_config.get('disable_Tv_Source', False)

        if source == "TV":
            await enqueue_media_action(
                hass,
                'select_source',
                {"source": source, "entity_id": primary_speaker_entity_id},
            )
        elif status == "ON TV" and disable_tv_source is False and source != "Unknown":
            await enqueue_media_action(
                hass,
                'select_source',
                {"source": source, "entity_id": primary_speaker_entity_id},
            )

        elif source != "Unknown" and status == "ON":
            if (
                not ignore_playing
                and state.state == "playing"
                and state.attributes.get("source") != "TV"
            ):
                return

            source_info = source_dict.get(source)

            if source_info:
                media_id = source_info["value"]
                media_type = source_info["type"]

                # FIX 3: Sonos Favorites Bug (Entity Registry)
                if media_type == "favorite_item_id" and not media_id.startswith(SONOS_FAVORITE_PREFIX):
                    registry = hass.helpers.entity_registry.async_get(hass)
                    entry = registry.async_get(primary_speaker_entity_id)
                    if entry and entry.platform == "sonos":
                         media_id = f"{SONOS_FAVORITE_PREFIX}{media_id}"

                await enqueue_media_action(
                    hass,
                    'play_media',
                    {
                        'entity_id': primary_speaker_entity_id,
                        'media_content_id': media_id,
                        'media_content_type': media_type,
                    },
                )

    except Exception as e:
        _LOGGER.error("Error in ags_select_source: %s", str(e))

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
    try:
        _LOGGER.debug("AGS status transition: %s -> %s", old_status, new_status)
        # Ensure any prior media actions have finished before evaluating the
        # new state.
        await wait_for_actions(hass)

        # Skip repeated "OFF" handling once the system is fully stopped
        if new_status == "OFF" and old_status == "OFF":
            return

        rooms = ags_config["rooms"]
        
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
                    hass, "wait_ungrouped", {"entity_id": all_speakers, "timeout": 5}
                )
                await enqueue_media_action(hass, "delay", {"seconds": 0.5})

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
                state = device_states.get(spk)
                if state and state.state != "unavailable" and not ags_config.get("disable_Tv_Source"):
                    await enqueue_media_action(
                        hass, "select_source", {"entity_id": spk, "source": "TV"}
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

        calculated = primary if primary not in (None, "none") else preferred
        
        # FIX 2: Delete ON TV override condition to respect primary TV election
        # if new_status == "ON TV" and preferred and preferred != primary:
        #    calculated = preferred

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
                        if s and s.state.lower() not in TV_IGNORE_STATES:
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
                    hass, "wait_ungrouped", {"entity_id": extras, "timeout": 3}
                )
                await enqueue_media_action(hass, "delay", {"seconds": 0.5})
                for spk in extras:
                    state = hass.states.get(spk)
                    if not state or state.state == "unavailable":
                        _LOGGER.debug(
                            "Skipped media_stop for %s – state unavailable", spk
                        )
                        continue
                    if tv_map.get(spk) and not ags_config.get("disable_Tv_Source"):
                        await enqueue_media_action(
                            hass, "select_source", {"entity_id": spk, "source": "TV"}
                        )
                    else:
                        await enqueue_media_action(
                            hass, "media_stop", {"entity_id": spk}
                        )
                    await enqueue_media_action(hass, "delay", {"seconds": 0.5})
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
                await enqueue_media_action(hass, "delay", {"seconds": 0.5})

            # Join using only the followers (exclude the master from group_members)
            followers = [spk for spk in active_speakers if spk != calculated]
            if followers:
                await enqueue_media_action(
                    hass,
                    "join",
                    {"entity_id": calculated, "group_members": followers},
                )
                # Short delay to let Sonos settle the group
                await enqueue_media_action(hass, "delay", {"seconds": 1.0})
            else:
                _LOGGER.debug("No followers to join to %s", calculated)

        if extra and actions_enabled:
            _LOGGER.info("AGS unjoining extra speakers from %s: %s", calculated, extra)
            await enqueue_media_action(hass, "unjoin", {"entity_id": extra})
            await enqueue_media_action(
                hass, "wait_ungrouped", {"entity_id": extra, "timeout": 3}
            )
            await enqueue_media_action(hass, "delay", {"seconds": 0.5})
            for spk in extra:
                state = hass.states.get(spk)
                if not state or state.state == "unavailable":
                    _LOGGER.debug("Skipped media_stop for %s – state unavailable", spk)
                    continue
                if tv_map.get(spk) and not ags_config.get("disable_Tv_Source"):
                    await enqueue_media_action(
                        hass, "select_source", {"entity_id": spk, "source": "TV"}
                    )
                else:
                    await enqueue_media_action(
                        hass, "media_stop", {"entity_id": spk}
                    )
                await enqueue_media_action(hass, "delay", {"seconds": 0.5})

        if (missing or extra) and actions_enabled:
            await wait_for_actions(hass)
            await _wait_until_grouped(
                hass,
                calculated,
                active_speakers,
            )
            # Refresh the speaker state after grouping changes so the playback
            # check below evaluates the latest status.
            state = hass.states.get(calculated)
            if state is None or state.state == "unavailable":
                return

        # Source selection depends on the current status
        if new_status == "ON TV":
            if hass.data.get("current_tv_mode", TV_MODE_TV_AUDIO) != TV_MODE_NO_MUSIC:
                if "TV" in (state.attributes.get("source_list") or []) and actions_enabled:
                    if state.attributes.get("source") != "TV":
                        _LOGGER.info("Switching %s to TV source", calculated)
                        await enqueue_media_action(
                            hass, "select_source", {"entity_id": calculated, "source": "TV"}
                        )
            else:
                _LOGGER.debug("tv_mode set to no_music - skipping TV commands")
        else:
            if actions_enabled and (
                state.state != "playing" or state.attributes.get("source") == "TV"
            ):
                _LOGGER.info("Initiating music source selection on %s", calculated)
                # Only select the configured music source when the speaker is
                # idle or currently set to the TV source.
                await ags_select_source(ags_config, hass)

    except Exception as exc:  # pragma: no cover - safety net
        _LOGGER.warning("Error handling AGS status change: %s", exc)



