"""Main module for the AGS Service integration."""

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.discovery import async_load_platform

from .const import (
    DOMAIN,
    CONF_ROOM,
    CONF_ROOMS,
    CONF_DEVICE_ID,
    CONF_DEVICE_NAME,
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
                                    vol.Optional(CONF_DEVICE_NAME): cv.string,
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
    vol.Optional(CONF_HOMEKIT_PLAYER): vol.Any(None, cv.string),
    vol.Optional(CONF_CREATE_SENSORS, default=False): cv.boolean,
    vol.Optional(CONF_DEFAULT_ON, default=False): cv.boolean,
    vol.Optional(CONF_STATIC_NAME): vol.Any(None, cv.string),
    vol.Optional(CONF_DISABLE_TV_SOURCE, default=False): cv.boolean,
}, extra=vol.ALLOW_EXTRA)

CONFIG_SCHEMA = vol.Schema({DOMAIN: DEVICE_SCHEMA}, extra=vol.ALLOW_EXTRA)


def _store_config(hass: HomeAssistant, ags_config: dict) -> None:
    """Persist configuration values in hass.data."""
    data = hass.data.setdefault(
        DOMAIN,
        {
            "rooms": [],
            "Sources": [],
            "disable_zone": False,
            "primary_delay": 5,
            "homekit_player": None,
            "create_sensors": False,
            "default_on": False,
            "static_name": None,
            "disable_Tv_Source": False,
            "platforms_loaded": False,
        },
    )
    data["rooms"].extend(ags_config.get("rooms", []))
    data["Sources"].extend(ags_config.get("Sources", []))
    for key, default in [
        (CONF_DISABLE_ZONE, False),
        (CONF_PRIMARY_DELAY, 5),
        (CONF_HOMEKIT_PLAYER, None),
        (CONF_CREATE_SENSORS, False),
        (CONF_DEFAULT_ON, False),
        (CONF_STATIC_NAME, None),
        (CONF_DISABLE_TV_SOURCE, False),
    ]:
        value = ags_config.get(key)
        if value is not None:
            data[key] = value


async def _load_platforms(hass: HomeAssistant, ags_config: dict, source) -> None:
    """Load platforms if not already loaded."""
    data = hass.data[DOMAIN]
    if data.get("platforms_loaded"):
        return
    create_sensors = ags_config.get(CONF_CREATE_SENSORS, False)
    if create_sensors:
        await async_load_platform(hass, "sensor", DOMAIN, {}, source)
    await async_load_platform(hass, "switch", DOMAIN, {}, source)
    await async_load_platform(hass, "media_player", DOMAIN, {}, source)
    data["platforms_loaded"] = True


async def async_setup(hass: HomeAssistant, config: dict):
    """Set up the integration from YAML."""
    if DOMAIN not in config:
        return True

    ags_config = config[DOMAIN]
    _store_config(hass, ags_config)
    await _load_platforms(hass, ags_config, config)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up AGS Service from a config entry."""
    ags_config = entry.data
    _store_config(hass, ags_config)
    await _load_platforms(hass, ags_config, entry)
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
    return unload_ok
