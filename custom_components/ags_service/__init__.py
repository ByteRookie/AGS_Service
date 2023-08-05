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
    vol.Required("Source_selector"): cv.string,
    vol.Required("Sources"): vol.All(
        cv.ensure_list,
        [
            vol.Schema(
                {
                    vol.Required("Source"): cv.string,
                    vol.Required("Source_Value"): cv.string,
                }
            )
        ],
    ),
    vol.Optional(CONF_DISABLE_ZONE, default=False): cv.boolean,
})

async def async_setup(hass, config):
    """Set up the custom component."""
    
    ags_config = config[DOMAIN]

    hass.data[DOMAIN] = {
        'rooms': ags_config['rooms'],
        'Source_selector': ags_config['Source_selector'],
        'Sources': ags_config['Sources'],
        'disable_zone': ags_config.get(CONF_DISABLE_ZONE, False)
    }
    ...

    # Load the sensor and switch platforms and pass the configuration to them
    await async_load_platform(hass, 'sensor', DOMAIN, {}, config)
    await async_load_platform(hass, 'switch', DOMAIN, {}, config)

    return True
