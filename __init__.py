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

# Define the configuration schema for a device
DEVICE_SCHEMA = vol.Schema({
    vol.Required(CONF_DEVICE_ID): cv.string,
    vol.Required(CONF_DEVICE_TYPE): cv.string,
    vol.Required(CONF_PRIORITY): cv.positive_int,
    vol.Optional(CONF_OVERRIDE_CONTENT): cv.string,
})

# Define the configuration schema for a room
ROOM_SCHEMA = vol.Schema({
    vol.Required(CONF_ROOM): cv.string,
    vol.Required(CONF_DEVICES): vol.All(cv.ensure_list, [DEVICE_SCHEMA]),
})

# Define the configuration schema for the integration
CONFIG_SCHEMA = vol.Schema({
    DOMAIN: vol.Schema({
        vol.Required(CONF_ROOMS): vol.All(cv.ensure_list, [ROOM_SCHEMA]),
    })
}, extra=vol.ALLOW_EXTRA)

_LOGGER = logging.getLogger(__name__)

async def async_setup(hass, config):
    """Set up the custom component."""
    # Retrieve the room information from the configuration
    rooms = config[DOMAIN][CONF_ROOMS]

    # Store the room information in hass.data, which is a shared dictionary for storing data
    hass.data[DOMAIN] = rooms

    # Load the sensor and switch platforms and pass the configuration to them
    await async_load_platform(hass, 'sensor', DOMAIN, {}, config)
    await async_load_platform(hass, 'switch', DOMAIN, {}, config)

    return True
