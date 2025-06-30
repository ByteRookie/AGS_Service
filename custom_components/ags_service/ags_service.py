# ags_service .py
import logging
import asyncio
from homeassistant.core import HomeAssistant



_LOGGER = logging.getLogger(__name__)
# Global flag to indicate whether the update_sensors function is currently running
AGS_SENSOR_RUNNING = False
AGS_LOGIC_RUNNING = False
ags_select_source_running = False

_ACTION_QUEUE: asyncio.Queue | None = None
_ACTION_WORKER: asyncio.Task | None = None


async def _action_worker(hass: HomeAssistant) -> None:
    """Process queued media_player actions sequentially."""
    while True:
        service, data = await _ACTION_QUEUE.get()
        try:
            if service == "delay":
                await asyncio.sleep(data.get("seconds", 1))
            else:
                await hass.services.async_call("media_player", service, data)
        except Exception as exc:  # pragma: no cover - safety net
            _LOGGER.warning("Failed media action %s: %s", service, exc)
        _ACTION_QUEUE.task_done()


async def ensure_action_queue(hass: HomeAssistant) -> None:
    """Initialize the global media action queue if needed."""
    global _ACTION_QUEUE, _ACTION_WORKER
    if _ACTION_QUEUE is None:
        _ACTION_QUEUE = asyncio.Queue()
        _ACTION_WORKER = hass.loop.create_task(_action_worker(hass))


async def enqueue_media_action(hass: HomeAssistant, service: str, data: dict) -> None:
    """Add a media_player service call to the action queue."""
    await ensure_action_queue(hass)
    await _ACTION_QUEUE.put((service, data))

### Sensor Functions ###

## update all Sensors Function ##
def update_ags_sensors(ags_config, hass):
    # Use the global flag
    global AGS_SENSOR_RUNNING
    rooms = ags_config['rooms']
    # If the function is already running, exit immediately to prevent concurrent runs
    if AGS_SENSOR_RUNNING:
        return

    # Set the flag to True to indicate that the update_sensors function has started its execution
    AGS_SENSOR_RUNNING = True
    
    try:
    
        # Call and execute the functions to set sensor values for all of AGS
        # Configured rooms rarely change, only compute once
        if 'configured_rooms' not in hass.data:
            get_configured_rooms(rooms, hass)
        get_active_rooms(rooms, hass)
        update_ags_status(ags_config, hass)
        get_preferred_primary_speaker(rooms, hass)
        determine_primary_speaker(ags_config, hass)
        update_speaker_states(rooms, hass)
        get_inactive_tv_speakers(rooms, hass)

        status = hass.data.get('ags_status')
        prev_status = hass.data.get('prev_ags_status')
        if status != prev_status:
            hass.loop.call_soon_threadsafe(
                lambda: hass.async_create_task(process_ags_status(hass))
            )
        ## Use in Future release ###
        ### Call and execute the Control System for AGS #### 
        #if hass.data.get('primary_speaker') == "none" and hass.data.get('active_speakers') != [] and hass.data.get('preferred_primary_speaker') != "none":
         #   _LOGGER.error("ags source change has been called")
          #  ags_select_source(ags_config, hass)    
       # if  hass.data.get('active_speakers') != "OFF" and ( hass.data.get('active_speakers') != [] or hass.data.get('inactive_tv_speakers') != [] or hass.data.get('inactive_speakers') != []):
        #    execute_ags_logic(hass)

    finally:
        # Ensure that the AGS_SENSOR_RUNNING flag is reset to False once the function completes,
        # regardless of whether it completes successfully or due to an error
        AGS_SENSOR_RUNNING = False

        # Immediately refresh any registered sensors so new values appear without delay
        sensors = hass.data.get('ags_sensors', [])
        for sensor in sensors:
            try:
                hass.loop.call_soon_threadsafe(sensor.async_schedule_update_ha_state, True)
            except Exception as exc:
                _LOGGER.debug('Error scheduling update for %s: %s', getattr(sensor, 'entity_id', 'unknown'), exc)

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
        room_key = f"switch.{room['room'].lower().replace(' ', '_')}_media"
        
        # If the room switch is found in hass.data, add the room to the active list
        if hass.data.get(room_key):
            active_rooms.append(room['room'])
    
    # Store the list of active rooms in hass.data
    hass.data['active_rooms'] = active_rooms
    return active_rooms

### Function to Update Status ### 
def update_ags_status(ags_config, hass):
    rooms = ags_config['rooms']
    active_rooms = hass.data.get('active_rooms', [])
    default_source_name = None
    sources_list = hass.data['ags_service']['Sources'] 
    for src in sources_list:
        if src.get("source_default") == True:
            default_source_name = src["Source"]
            break
        
    if default_source_name:
        ags_status = default_source_name
    else:
        ags_status = "Unknown"

    # If the zone is disabled and the state of 'zone.home' is '0', set status to "OFF"
    if not ags_config.get('disable_zone', False)  and hass.states.get('zone.home').state == '0':
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
        if device_state and 'override_content' in device and device['override_content'] in device_state.attributes.get('media_content_id', ''):
            ags_status = "Override"
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
                hass.data['ags_status'] = ags_status
                hass.data['schedule_prev_state'] = schedule_on
                hass.data['schedule_state'] = schedule_on
                return ags_status

            hass.data['schedule_prev_state'] = schedule_on
            hass.data['schedule_state'] = schedule_on

    if not media_system_state:
        ags_status = "OFF"
        hass.data['ags_status'] = ags_status
        return ags_status


    # Check for TV in active rooms
    for room in rooms:
        if room['room'] in active_rooms:
            for device in room['devices']:
                device_state = device_states.get(device['device_id'])
                if device['device_type'] == 'tv' and device_state and device_state.state != 'off':
                    ags_status = "ON TV"
                    hass.data['ags_status'] = ags_status
                    return ags_status

    ags_status = "ON"
    hass.data['ags_status'] = ags_status
    return ags_status

def check_primary_speaker_logic(ags_config, hass):
    rooms = ags_config['rooms']
    ags_status = hass.data.get('ags_status')
    active_rooms_entity = hass.data.get('active_rooms')
    active_rooms = active_rooms_entity if active_rooms_entity is not None else None
    primary_speaker = "none"

    if ags_status == 'Override':
        # Filter devices that also have the override_content in the media_content_id
        override_devices = [device for room in rooms for device in room['devices']
                            if 'override_content' in device and 
                            device['override_content'] in hass.states.get(device['device_id'], {}).attributes.get('media_content_id', '')]

        # Sort the list from lowest to highest priority device
        override_devices = sorted(override_devices, key=lambda x: x['priority'])

        if override_devices:
            # Set primary_speaker to the device_id of the highest priority override device
            primary_speaker = override_devices[0]['device_id']

    elif ags_status == 'OFF':
        primary_speaker = ""

    elif ags_status is not None:
        for room in rooms:
            sorted_devices = []  
            if active_rooms is not None and room['room'] in active_rooms:
                sorted_devices = sorted(room["devices"], key=lambda x: x['priority'])
                tv_on = False
                for device in sorted_devices:
                    device_state = hass.states.get(device['device_id'])
                    if device['device_type'] == 'tv' and device_state is not None and device_state.state != 'off':
                        tv_on = True
                        break

                if sorted_devices:
                    for device in sorted_devices:
                        device_state = hass.states.get(device['device_id'])
                       
                        if device_state is None:
                            continue
                        group_members = device_state.attributes.get('group_members')


                        if (
                            device['device_type'] == 'speaker' and
                            device_state.state not in ['off', 'idle'] and
                            group_members and  # Check that group_members exists and is not None
                            group_members[0] == device['device_id']  # Now safe to index
                        ):
                            source = device_state.attributes.get('source')
                            if tv_on or (not tv_on and (source is None or source != 'TV')):
                                primary_speaker = device['device_id']
                                break
    return primary_speaker

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








### Controls from this point ###
def execute_ags_logic(hass):
    import logging
    global AGS_LOGIC_RUNNING

    # If the logic is already running, exit the function
    if AGS_LOGIC_RUNNING:
        return

    # Set the flag to indicate that the logic is running
    AGS_LOGIC_RUNNING = True

    # Fetch data from hass.data
    active_speakers = hass.data.get('active_speakers', [])
    status = hass.data.get('ags_status', "OFF")
    inactive_speakers = hass.data.get('inactive_speakers', [])
    primary_speaker = hass.data.get('primary_speaker', "None")
    inactive_tv_speakers = hass.data.get('ags_inactive_tv_speakers', [])
    
    # Logic for join action
    if active_speakers != [] and status != 'off' and primary_speaker != 'none':
        try:
            hass.loop.call_soon_threadsafe(
                lambda: hass.async_create_task(
                    enqueue_media_action(
                        hass,
                        'join',
                        {
                            'entity_id': primary_speaker,
                            'group_members': active_speakers,
                        },
                    )
                )
            )
        except Exception as e:
            # Log the exception for diagnosis
            _LOGGER.warning(f'Error in execute_ags_logic: {str(e)}')

    # Logic for remove action
    if inactive_speakers != []:
        try:
            hass.loop.call_soon_threadsafe(
                lambda: hass.async_create_task(
                    enqueue_media_action(
                        hass, 'unjoin', {'entity_id': inactive_speakers}
                    )
                )
            )
            hass.loop.call_soon_threadsafe(
                lambda: hass.async_create_task(
                    enqueue_media_action(
                        hass, 'media_pause', {'entity_id': inactive_speakers}
                    )
                )
            )
            hass.loop.call_soon_threadsafe(
                lambda: hass.async_create_task(
                    enqueue_media_action(
                        hass, 'clear_playlist', {'entity_id': inactive_speakers}
                    )
                )
            )
        except Exception as e:
            # Log the exception for diagnosis
            _LOGGER.warning(f'Error in execute_ags_logic: {str(e)}')

    # Logic for resetting TV speakers
    if inactive_tv_speakers != []:
        try:
            hass.loop.call_soon_threadsafe(
                lambda: hass.async_create_task(
                    enqueue_media_action(
                        hass,
                        'select_source',
                        {
                            'source': 'TV',
                            'entity_id': inactive_tv_speakers,
                        },
                    )
                )
            )
        except Exception as e:
            # Log the exception for diagnosis
            _LOGGER.warning(f'Error in execute_ags_logic: {str(e)}')

    # Reset the flag to indicate that the logic has finished
    AGS_LOGIC_RUNNING = False
    return

def ags_select_source(ags_config, hass):
    global ags_select_source_running

    # Check if the logic is already running
    if ags_select_source_running:


        _LOGGER.warning("ags_select_source is already running!")
        return

    # Mark the logic as running
    ags_select_source_running = True

    try:
        source = hass.data.get('ags_media_player_source')
        if source is None:
            sources_list = hass.data['ags_service']['Sources']
            source = next(
                (
                    src["Source"]
                    for src in sources_list
                    if src.get("source_default") is True
                ),
                None,
            )
            if source is None and sources_list:
                source = sources_list[0]["Source"]
            if source is not None:
                hass.data['ags_media_player_source'] = source
        status = hass.data.get('ags_status', "OFF")
        primary_speaker_entity_id_raw = hass.data.get('primary_speaker', "none")

        if not primary_speaker_entity_id_raw or primary_speaker_entity_id_raw == "none":
            primary_speaker_entity_id = hass.data.get('preferred_primary_speaker', "")
            hass.data['primary_speaker'] = primary_speaker_entity_id
        else:
            primary_speaker_entity_id = primary_speaker_entity_id_raw
        
        if not primary_speaker_entity_id or primary_speaker_entity_id == "none":
            ags_select_source_running = False  # Reset the global flag
            return

        # Convert the list of sources to a dictionary for faster lookups
        sources_list = hass.data['ags_service']['Sources'] 
        source_dict = {src["Source"]: {"value": src["Source_Value"], "type": src.get("media_content_type")} for src in sources_list}


        if source == "TV":
            hass.loop.call_soon_threadsafe(
                lambda: hass.async_create_task(
                    enqueue_media_action(
                        hass,
                        'select_source',
                        {
                            "source": source,
                            "entity_id": primary_speaker_entity_id,
                        },
                    )
                )
            )

        elif source != "Unknown" and status != "OFF":
            source_info = source_dict.get(source)

            if source_info:
                media_id = source_info["value"]
                media_type = source_info["type"]

                if media_type == "favorite_item_id" and not media_id.startswith("FV:"):
                    media_id = f"FV:{media_id}"

                hass.loop.call_soon_threadsafe(
                    lambda: hass.async_create_task(
                        enqueue_media_action(
                            hass,
                            'play_media',
                            {
                                'entity_id': primary_speaker_entity_id,
                                'media_content_id': media_id,
                                'media_content_type': media_type,
                            },
                        )
                    )
                )

    except Exception as e:
        _LOGGER.error("Error in ags_select_source: %s", str(e))

    finally:
        # Reset the flag to indicate that the logic has finished
        ags_select_source_running = False


async def process_ags_status(hass: HomeAssistant) -> None:
    """React to AGS status transitions and trigger speaker actions."""
    ags_config = hass.data.get("ags_service")
    if not ags_config:
        return

    await ensure_action_queue(hass)

    prev_status = hass.data.get("prev_ags_status")
    status = hass.data.get("ags_status", "OFF")
    rooms = ags_config["rooms"]

    all_speakers = [
        d["device_id"]
        for room in rooms
        for d in room["devices"]
        if d.get("device_type") == "speaker"
    ]

    if status == "OFF" and prev_status != "OFF":
        await enqueue_media_action(hass, "unjoin", {"entity_id": all_speakers})
        for room in rooms:
            speakers = [
                d["device_id"]
                for d in room["devices"]
                if d.get("device_type") == "speaker"
            ]
            has_tv = any(d.get("device_type") == "tv" for d in room["devices"])
            if has_tv:
                for speaker in speakers:
                    await enqueue_media_action(
                        hass,
                        "select_source",
                        {"entity_id": speaker, "source": "TV"},
                    )
            else:
                if speakers:
                    await enqueue_media_action(
                        hass, "media_stop", {"entity_id": speakers}
                    )

    elif status != "OFF" and prev_status == "OFF":
        active_speakers = hass.data.get("active_speakers", [])
        primary = hass.data.get("primary_speaker")
        preferred = hass.data.get("preferred_primary_speaker")
        target = primary if primary and primary != "none" else preferred

        if target and active_speakers:
            await enqueue_media_action(
                hass,
                "join",
                {"entity_id": target, "group_members": active_speakers},
            )

        if preferred and preferred != "none":
            if status == "ON TV":
                await enqueue_media_action(
                    hass,
                    "select_source",
                    {"entity_id": preferred, "source": "TV"},
                )
            else:
                source_name = hass.data.get("ags_media_player_source")
                sources = hass.data["ags_service"]["Sources"]
                if not source_name and sources:
                    source_name = next(
                        (
                            s["Source"]
                            for s in sources
                            if s.get("source_default") is True
                        ),
                        sources[0]["Source"],
                    )
                source_dict = {
                    s["Source"]: {
                        "value": s["Source_Value"],
                        "type": s.get("media_content_type"),
                    }
                    for s in sources
                }
                info = source_dict.get(source_name)
                if info:
                    media_id = info["value"]
                    m_type = info["type"]
                    if m_type == "favorite_item_id" and not media_id.startswith("FV:"):
                        media_id = f"FV:{media_id}"
                    await enqueue_media_action(
                        hass,
                        "play_media",
                        {
                            "entity_id": preferred,
                            "media_content_id": media_id,
                            "media_content_type": m_type,
                        },
                    )

    hass.data["prev_ags_status"] = status



