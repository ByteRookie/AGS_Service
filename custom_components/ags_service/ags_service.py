# ags_service .py
import logging
import time



_LOGGER = logging.getLogger(__name__)
# Global flag to indicate whether the update_sensors function is currently running
AGS_SENSOR_RUNNING = False
AGS_LOGIC_RUNNING = False
ags_select_source_running = False

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
        get_configured_rooms(rooms, hass)
        get_active_rooms(rooms, hass)
        update_ags_status(ags_config, hass)
        get_preferred_primary_speaker(rooms, hass)
        determine_primary_speaker(ags_config, hass)
        update_speaker_states(rooms, hass)
        get_inactive_tv_speakers(rooms, hass)
        ## Use in Future release ###
        ### Call and execute the Control System for AGS #### 
        #if hass.data.get('primary_speaker') == "none" and hass.data.get('active_speakers') != [] and hass.data.get('preferred_primary_speaker') != "none":
         #   _LOGGER.error("ags source change has been called")
          #  ags_select_source(ags_config, hass)    
       # if  hass.data.get('active_speakers') != "OFF" and ( hass.data.get('active_speakers') != [] or hass.data.get('inactive_tv_speakers') != [] or hass.data.get('inactive_speakers') != []):
        #    execute_ags_logic(hass)

    finally:
        # Ensure that the AGS_SENSOR_RUNNING flag is reset to False once the function completes,
        # regardless of whether it completes successfully or due to an
        AGS_SENSOR_RUNNING = False 

## Get Configured Rooms ##
def get_configured_rooms(rooms, hass):
    """Get the list of configured rooms and store it in hass.data."""
    
    # Extract the list of configured rooms
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

    media_system_state = hass.data.get('switch_media_system_state')
    if media_system_state is None:
        if  ags_config['default_on']: 
            ags_status = "ON"
        else:
            ags_status = "OFF"

        hass.data['ags_status'] = ags_status
        hass.data['media_system_state'] = ags_config['default_on']
        return ags_status

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
                        group_members = device_state.attributes.get('group_members')

                        if (
                            device['device_type'] == 'speaker' and
                            device_state is not None and
                            device_state.state not in ['off', 'idle', 'paused'] and
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
    # First check
    primary_speaker = check_primary_speaker_logic(ags_config, hass)

    if primary_speaker == "none":
        # Introduce a delay of 5 seconds
        time.sleep(5)
        # Recheck the logic
        primary_speaker = check_primary_speaker_logic(ags_config, hass)

    # Store the primary speaker's state to hass.data
    hass.data['primary_speaker'] = primary_speaker

    # Return the primary speaker's state
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
    if active_speakers != []  and status != 'off' and primary_speaker != 'none':
        try:
            hass.services.call('media_player', 'join', {
                'entity_id': primary_speaker,
                'group_members': active_speakers,
            })
        except Exception as e:
            # Log the exception for diagnosis
            _LOGGER.warning(f'Error in execute_ags_logic: {str(e)}')

    # Logic for remove action
    if inactive_speakers != []:
        try:
            hass.services.call('media_player', 'unjoin', {'entity_id': inactive_speakers })
            hass.services.call('media_player', 'media_pause', {'entity_id': inactive_speakers })
            hass.services.call('media_player', 'clear_playlist', {'entity_id': inactive_speakers })
        except Exception as e:
            # Log the exception for diagnosis
            _LOGGER.warning(f'Error in execute_ags_logic: {str(e)}')

    # Logic for resetting TV speakers
    if inactive_tv_speakers != []:
        try:
            hass.services.call('media_player', 'select_source', {
                'source': 'TV',
                'entity_id': inactive_tv_speakers,
            })
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
        source = hass.data.get('ags_media_player_source', "Chill")
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


        if source == "TV" or status == "ON TV":
            hass.services.call('media_player', 'select_source', {
                "source": source,
                "entity_id": primary_speaker_entity_id
            })

        elif source != "Unknown" and status != "OFF":
            source_info = source_dict.get(source)

            if source_info:
                hass.services.call('media_player', 'play_media', {
                    'entity_id': primary_speaker_entity_id,
                    'media_content_id': source_info["value"],
                    'media_content_type': source_info["type"]
                })

    except Exception as e:
        _LOGGER.error("Error in ags_select_source: %s", str(e))

    finally:
        # Reset the flag to indicate that the logic has finished
        ags_select_source_running = False



