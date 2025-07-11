"""Main module for the AGS Service integration."""
import asyncio
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType
from homeassistant.config_entries import ConfigEntry
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
CONF_OTT_DEVICES = 'ott_devices'
CONF_TV_INPUT = 'tv_input'
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
                                    vol.Optional(CONF_OTT_DEVICES): vol.All(
                                        cv.ensure_list,
                                        [
                                            vol.Schema(
                                                {
                                                    vol.Required(CONF_OTT_DEVICE): cv.string,
                                                    vol.Required(CONF_TV_INPUT): cv.string,
                                                    vol.Optional("default", default=False): cv.boolean,
                                                }
                                            )
                                        ],
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

async def async_setup(hass: ConfigType, config: ConfigType) -> bool:
    """Handle YAML configuration."""

    if DOMAIN not in config:
        return True

    ags_config = DEVICE_SCHEMA(config[DOMAIN])

    for room in ags_config["rooms"]:
        for device in room["devices"]:
            if CONF_OTT_DEVICES in device and device["device_type"] != "tv":
                raise vol.Invalid(
                    "ott_devices is only allowed for devices with device_type 'tv'"
                )

    hass.async_create_task(
        hass.config_entries.flow.async_init(
            DOMAIN,
            context={"source": config_entries.SOURCE_IMPORT},
            data=ags_config,
        )
    )
    return True


PLATFORMS = ["switch", "media_player", "sensor"]


async def async_setup_entry(hass: ConfigType, entry: ConfigEntry) -> bool:
    """Set up AGS Service from a config entry."""

    data = DEVICE_SCHEMA(dict(entry.data))

    hass.data.setdefault(DOMAIN, {})

    entry_data = {
        "rooms": data["rooms"],
        "Sources": data["Sources"],
        "disable_zone": data.get(CONF_DISABLE_ZONE, False),
        "homekit_player": data.get(CONF_HOMEKIT_PLAYER, None),
        "create_sensors": data.get(CONF_CREATE_SENSORS, False),
        "default_on": data.get(CONF_DEFAULT_ON, False),
        "static_name": data.get(CONF_STATIC_NAME, None),
        "disable_Tv_Source": data.get(CONF_DISABLE_TV_SOURCE, False),
        "schedule_entity": data.get(CONF_SCHEDULE_ENTITY),
        "sensor_lock": asyncio.Lock(),
        "update_event": asyncio.Event(),
    }

    hass.data[DOMAIN][entry.entry_id] = entry_data

    await ensure_action_queue(hass)

    platforms = ["switch", "media_player"]
    if entry_data["create_sensors"]:
        platforms.append("sensor")
    entry_data["platforms"] = platforms

    await hass.config_entries.async_forward_entry_setups(entry, platforms)

    return True


async def async_unload_entry(hass: ConfigType, entry: ConfigEntry) -> bool:
    """Unload a config entry."""

    entry_data = hass.data[DOMAIN].get(entry.entry_id, {})
    platforms = entry_data.get("platforms", PLATFORMS)

    unload_ok = await hass.config_entries.async_unload_platforms(entry, platforms)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok


async def async_reload_entry(hass: ConfigType, entry: ConfigEntry) -> None:
    """Reload an existing entry."""

    await async_unload_entry(hass, entry)
    await async_setup_entry(hass, entry)
