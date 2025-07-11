"""Main module for the AGS Service integration."""
import asyncio
import voluptuous as vol

from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.discovery import async_load_platform

# Define the domain for the integration
DOMAIN = "ags_service"

# Define the configuration keys
CONF_ROOM = 'room'
CONF_ROOMS = 'rooms'
CONF_DEVICE_ID = 'device_id'
CONF_DEVICE_TYPE = 'device_type'
CONF_PRIORITY = 'priority'
CONF_OVERRIDE_CONTENT = 'override_content'
CONF_DISABLE_ZONE = 'disable_zone'
CONF_HOMEKIT_PLAYER = 'homekit_player'
CONF_CREATE_SENSORS = 'create_sensors'
CONF_DEFAULT_ON = 'default_on'
CONF_STATIC_NAME = 'static_name'
CONF_DISABLE_TV_SOURCE = 'disable_Tv_Source'
CONF_INTERVAL_SYNC = 'interval_sync'
CONF_SCHEDULE_ENTITY = 'schedule_entity'
CONF_OTT_DEVICE = 'ott_device'
CONF_TV_MODE = 'tv_mode'
TV_MODE_TV_AUDIO = 'tv_audio'
TV_MODE_NO_MUSIC = 'no_music'
CONF_SOURCES = 'Sources'
CONF_SOURCE = 'Source'
CONF_MEDIA_CONTENT_TYPE = 'media_content_type'
CONF_SOURCE_VALUE = 'Source_Value'
CONF_SOURCE_DEFAULT = 'source_default'


# Define the configuration schema for a device
DEVICE_SCHEMA = vol.Schema({
    vol.Required("rooms"): vol.All(
        cv.ensure_list,
        [
            vol.Schema(
                {
                    vol.Required("room"): cv.string,
                    vol.Required("devices"): vol.All(
                        cv.ensure_list,
                        [
                            vol.Schema(
                                {
                                    vol.Required("device_id"): cv.string,
                                    vol.Required("device_type"): cv.string,
                                    vol.Required("priority"): cv.positive_int,
                                    vol.Optional("override_content"): cv.string,
                                    vol.Optional(CONF_OTT_DEVICE): cv.string,
                                    vol.Optional(CONF_TV_MODE): vol.In(
                                        [TV_MODE_TV_AUDIO, TV_MODE_NO_MUSIC]
                                    ),
                                }
                            )
                        ],
                    ),
                }
            )
        ],
    ),
    vol.Required("Sources"): vol.All(
        cv.ensure_list,
        [
            vol.Schema(
                {
                    vol.Required("Source"): cv.string,
                    vol.Required("Source_Value"): cv.string,
                    vol.Required(CONF_MEDIA_CONTENT_TYPE): cv.string,
                    vol.Optional(CONF_SOURCE_DEFAULT, default=False): cv.boolean,
                }
            )
        ],
    ),
    vol.Optional(CONF_DISABLE_ZONE, default=False): cv.boolean,
    vol.Optional(CONF_HOMEKIT_PLAYER, default=None): cv.string,
    vol.Optional(CONF_CREATE_SENSORS, default=False): cv.boolean,
    vol.Optional(CONF_DEFAULT_ON, default=False): cv.boolean,
    vol.Optional(CONF_STATIC_NAME, default=None): cv.string,
    vol.Optional(CONF_DISABLE_TV_SOURCE, default=False): cv.boolean,
    vol.Optional(CONF_INTERVAL_SYNC, default=30): cv.positive_int,
    vol.Optional(CONF_SCHEDULE_ENTITY): vol.Schema({
        vol.Required('entity_id'): cv.string,
        vol.Optional('on_state', default='on'): cv.string,
        vol.Optional('off_state', default='off'): cv.string,
        vol.Optional('schedule_override', default=False): cv.boolean,
    }),
})

async def async_setup(hass, config):
    """Set up the custom component."""

    ags_config = config[DOMAIN]

    # Validate ott_device and tv_mode usage
    for room in ags_config['rooms']:
        for device in room['devices']:
            if CONF_OTT_DEVICE in device and device['device_type'] != 'tv':
                raise vol.Invalid(
                    "ott_device is only allowed for devices with device_type 'tv'"
                )
            if CONF_TV_MODE in device and device['device_type'] != 'tv':
                raise vol.Invalid(
                    "tv_mode is only allowed for devices with device_type 'tv'"
                )
            if device['device_type'] == 'tv' and CONF_TV_MODE not in device:
                device[CONF_TV_MODE] = TV_MODE_TV_AUDIO

    hass.data[DOMAIN] = {
        'rooms': ags_config['rooms'],
        'Sources': ags_config['Sources'],
        'disable_zone': ags_config.get(CONF_DISABLE_ZONE, False),
        'homekit_player': ags_config.get(CONF_HOMEKIT_PLAYER, None),
        'create_sensors': ags_config.get(CONF_CREATE_SENSORS, False),
        'default_on': ags_config.get(CONF_DEFAULT_ON, False),
        'static_name': ags_config.get(CONF_STATIC_NAME, None),
        'disable_Tv_Source': ags_config.get(CONF_DISABLE_TV_SOURCE, False),
        'schedule_entity': ags_config.get(CONF_SCHEDULE_ENTITY),
    }

    # Initialize shared media action queue
    from .ags_service import ensure_action_queue
    await ensure_action_queue(hass)

    # Initialize synchronization primitives used for sensor updates
    hass.data[DOMAIN]["sensor_lock"] = asyncio.Lock()
    hass.data[DOMAIN]["update_event"] = asyncio.Event()


    # Load the sensor and switch platforms and pass the configuration to them
    create_sensors = ags_config.get('create_sensors', False)
    if create_sensors:
        await async_load_platform(hass, 'sensor', DOMAIN, {}, config)
    
    await async_load_platform(hass, 'switch', DOMAIN, {}, config)
    await async_load_platform(hass, 'media_player', DOMAIN, {}, config)

    return True
