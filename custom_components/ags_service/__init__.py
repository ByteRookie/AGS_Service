"""Main module for the AGS Service integration."""
import logging
import voluptuous as vol

from homeassistant.const import CONF_DEVICES
from homeassistant.config_entries import ConfigEntry, SOURCE_IMPORT
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.discovery import async_load_platform

from .const import (
    DOMAIN,
    CONF_ROOM,
    CONF_ROOMS,
    CONF_DEVICE_ID,
    CONF_DEVICE_TYPE,
    CONF_PRIORITY,
    CONF_OVERRIDE_CONTENT,
    CONF_DISABLE_ZONE,
    CONF_PRIMARY_DELAY,
    CONF_HOMEKIT_PLAYER,
    CONF_CREATE_SENSORS,
    CONF_DEFAULT_ON,
    CONF_STATIC_NAME,
    CONF_DISABLE_TV_SOURCE,
    CONF_SOURCES,
    CONF_SOURCE,
    CONF_MEDIA_CONTENT_TYPE,
    CONF_SOURCE_VALUE,
    CONF_SOURCE_DEFAULT,
)


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
})

CONFIG_SCHEMA = vol.Schema({DOMAIN: DEVICE_SCHEMA}, extra=vol.ALLOW_EXTRA)


async def async_setup(hass: HomeAssistant, config: dict):
    """Set up the integration from YAML."""
    if DOMAIN not in config:
        return True

    hass.async_create_task(
        hass.config_entries.flow.async_init(
            DOMAIN, context={"source": SOURCE_IMPORT}, data=config[DOMAIN]
        )
    )

    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up AGS Service from a config entry."""
    ags_config = entry.data

    hass.data[DOMAIN] = {
        "rooms": ags_config["rooms"],
        "Sources": ags_config["Sources"],
        "disable_zone": ags_config.get(CONF_DISABLE_ZONE, False),
        "primary_delay": ags_config.get(CONF_PRIMARY_DELAY, 5),
        "homekit_player": ags_config.get(CONF_HOMEKIT_PLAYER, None),
        "create_sensors": ags_config.get(CONF_CREATE_SENSORS, False),
        "default_on": ags_config.get(CONF_DEFAULT_ON, False),
        "static_name": ags_config.get(CONF_STATIC_NAME, None),
        "disable_Tv_Source": ags_config.get(CONF_DISABLE_TV_SOURCE, False),
    }

    create_sensors = ags_config.get(CONF_CREATE_SENSORS, False)
    if create_sensors:
        await async_load_platform(hass, "sensor", DOMAIN, {}, entry)

    await async_load_platform(hass, "switch", DOMAIN, {}, entry)
    await async_load_platform(hass, "media_player", DOMAIN, {}, entry)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload AGS Service config entry."""
    unload_ok = True
    if entry.data.get(CONF_CREATE_SENSORS, False):
        unload_ok &= await hass.config_entries.async_forward_entry_unload(
            entry, "sensor"
        )
    unload_ok &= await hass.config_entries.async_forward_entry_unload(entry, "switch")
    unload_ok &= await hass.config_entries.async_forward_entry_unload(entry, "media_player")
    if unload_ok:
        hass.data.pop(DOMAIN, None)
    return unload_ok
