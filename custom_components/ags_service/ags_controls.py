# ags_controls.py

from homeassistant.components.media_player import (
    SERVICE_SELECT_SOURCE,
    SERVICE_PLAY_MEDIA,
    SERVICE_JOIN,
    SERVICE_UNJOIN,
    SERVICE_MEDIA_PAUSE,
    SERVICE_CLEAR_PLAYLIST,
)


# Define a global variable to control the execution
AGS_LOGIC_RUNNING = False

def execute_ags_logic(hass):
    global AGS_LOGIC_RUNNING

    # If the logic is already running, exit the function
    if AGS_LOGIC_RUNNING:
        return

    # Set the flag to indicate that the logic is running
    AGS_LOGIC_RUNNING = True

    # Main logic with conditions and sequences
    if hass.states.get('sensor.ags_primary_speaker') == 'none' and hass.states.get('sensor.ags_status') == 'ON TV':
        select_source_on_tv(hass)
    elif hass.states.get('sensor.ags_primary_speaker') == 'none' and hass.states.get('input_boolean.news') == 'off':
        play_media_favorite_item(hass)
    elif hass.states.get('input_boolean.news') == 'off' and hass.states.get('trigger.id') == 'Station change':
        play_media_station_change(hass)
    elif hass.states.get('sensor.ags_primary_speaker') == 'none' and hass.states.get('input_boolean.news') == 'on':
        play_media_cbs_news(hass)

    join_action(hass)
    remove_action(hass)
    reset_tv_speakers(hass)

    # Reset the flag to indicate that the logic has finished
    AGS_LOGIC_RUNNING = False

# Definitions for the individual functions handling each logic block
# ...


def select_source_on_tv(hass):
    # Logic for ON TV state
    hass.services.call('media_player', SERVICE_SELECT_SOURCE, {
        'source': 'TV',
        'entity_id': hass.states.get('sensor.ags_preferred_primary'),
    })

def play_media_favorite_item(hass):
    # Logic for playing favorite item
    hass.services.call('media_player', SERVICE_PLAY_MEDIA, {
        'media_content_id': f"FV:{hass.states.get('sensor.ags_source')}",
        'media_content_type': 'favorite_item_id',
        'entity_id': hass.states.get('sensor.ags_preferred_primary'),
    })

def play_media_station_change(hass):
    # Logic for station change
    hass.services.call('media_player', SERVICE_PLAY_MEDIA, {
        'media_content_id': f"FV:{hass.states.get('sensor.ags_source')}",
        'media_content_type': 'favorite_item_id',
        'entity_id': hass.states.get('sensor.ags_preferred_primary'),
    })

def play_media_cbs_news(hass):
    # Logic for CBS News
    hass.services.call('media_player', SERVICE_PLAY_MEDIA, {
        'media_content_id': 'FV:2/8',
        'media_content_type': 'favorite_item_id',
        'entity_id': hass.states.get('sensor.ags_primary_speaker'),
        'metadata': {
            'title': 'CBS News',
            'thumbnail': 'https://sali.sonos.radio/image?w=60&image=https%3A%2F%2Fcdn-profiles.tunein.com%2Fs309330%2Fimages%2Flogog.png%3Ft%3D164248&partnerId=tunein',
            'media_class': 'genre',
            'children_media_class': 'null',
            'navigateIds': [{}, {'media_content_type': 'favorites', 'media_content_id': ''}, {'media_content_type': 'favorites_folder', 'media_content_id': 'object.item.audioItem.audioBroadcast'}],
        },
    })

def join_action(hass):
    # Logic for join action
    if not (
        hass.states.get('sensor.ags_active_speakers') == '[]'
        or hass.states.get('sensor.ags_status') == 'off'
        or hass.states.get('sensor.ags_primary_speaker') == 'none'
    ):
        hass.services.call('media_player', SERVICE_JOIN, {
            'entity_id': hass.states.get('sensor.ags_primary_speaker'),
            'group_members': hass.states.get('sensor.ags_active_speakers'),
        })

def remove_action(hass):
    # Logic for remove action
    if hass.states.get('sensor.ags_inactive_speakers') != '[]':
        hass.services.call('media_player', SERVICE_UNJOIN, {'entity_id': hass.states.get('sensor.ags_inactive_speakers')})
        hass.services.call('media_player', SERVICE_MEDIA_PAUSE, {'entity_id': hass.states.get('sensor.ags_inactive_speakers')})
        hass.services.call('media_player', SERVICE_CLEAR_PLAYLIST, {'entity_id': hass.states.get('sensor.ags_inactive_speakers')})

def reset_tv_speakers(hass):
    # Logic for resetting TV speakers
    if hass.states.get('sensor.ags_inactive_tv_speakers') != '[]':
        hass.services.call('media_player', SERVICE_SELECT_SOURCE, {
            'source': 'TV',
            'entity_id': hass.states.get('sensor.ags_inactive_tv_speakers'),
        })


