"""Main module for the AGS Service integration."""
import voluptuous as vol
import asyncio
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED

from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.discovery import async_load_platform
from .ags_service import ensure_action_queue

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

    # Validate ott_device usage
    for room in ags_config['rooms']:
        for device in room['devices']:
            if CONF_OTT_DEVICE in device and device['device_type'] != 'tv':
                raise vol.Invalid(
                    "ott_device is only allowed for devices with device_type 'tv'"
                )

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
        'startup_pending': True,
    }

    # Initialize shared media action queue
    await ensure_action_queue(hass)

    async def _clear_startup(_event):
        async def _delayed_clear():
            await asyncio.sleep(5)
            hass.data[DOMAIN]['startup_pending'] = False

        hass.async_create_task(_delayed_clear())

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _clear_startup)

    # Load the sensor and switch platforms and pass the configuration to them
    create_sensors = ags_config.get('create_sensors', False)
    if create_sensors:
        await async_load_platform(hass, 'sensor', DOMAIN, {}, config)
    
    await async_load_platform(hass, 'switch', DOMAIN, {}, config)
    await async_load_platform(hass, 'media_player', DOMAIN, {}, config)

    return True
