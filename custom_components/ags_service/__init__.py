"""Main module for the AGS Service integration."""
import logging
import voluptuous as vol

from homeassistant.const import CONF_DEVICES
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
CONF_PRIMARY_DELAY = 'primary_delay'  
CONF_HOMEKIT_PLAYER = 'homekit_player'
CONF_CREATE_SENSORS = 'create_sensors'
CONF_DEFAULT_ON = 'default_on'
CONF_STATIC_NAME = 'static_name'
CONF_DISABLE_TV_SOURCE = 'disable_Tv_Source'
CONF_INTERVAL_SYNC = 'interval_sync'
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
    vol.Optional(CONF_PRIMARY_DELAY, default=5): cv.positive_int,  
    vol.Optional(CONF_HOMEKIT_PLAYER, default=None): cv.string,
    vol.Optional(CONF_CREATE_SENSORS, default=False): cv.boolean,
    vol.Optional(CONF_DEFAULT_ON, default=False): cv.boolean,
    vol.Optional(CONF_STATIC_NAME, default=None): cv.string,
    vol.Optional(CONF_DISABLE_TV_SOURCE, default=False): cv.boolean,
    vol.Optional(CONF_INTERVAL_SYNC, default=30): cv.positive_int,
})

async def async_setup(hass, config):
    """Set up the custom component."""
    
    ags_config = config[DOMAIN]

    hass.data[DOMAIN] = {
        'rooms': ags_config['rooms'],
        'Sources': ags_config['Sources'], 
        'disable_zone': ags_config.get(CONF_DISABLE_ZONE, False),
        'primary_delay': ags_config.get(CONF_PRIMARY_DELAY, 5), ## Not Done ###
        'homekit_player': ags_config.get(CONF_HOMEKIT_PLAYER, None),
        'create_sensors': ags_config.get(CONF_CREATE_SENSORS, False),
        'default_on': ags_config.get(CONF_DEFAULT_ON, False),
        'static_name': ags_config.get(CONF_STATIC_NAME, None),
        'disable_Tv_Source': ags_config.get(CONF_DISABLE_TV_SOURCE, False),
        'interval_sync': ags_config.get(CONF_INTERVAL_SYNC, 30)
    }
    ...

    # Load the sensor and switch platforms and pass the configuration to them
    create_sensors = ags_config.get('create_sensors', False)
    if create_sensors:
        await async_load_platform(hass, 'sensor', DOMAIN, {}, config)
    
    await async_load_platform(hass, 'switch', DOMAIN, {}, config)
    await async_load_platform(hass, 'media_player', DOMAIN, {}, config)

    return True
