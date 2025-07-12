"""Main module for the AGS Service integration."""
import asyncio

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .ags_service import ensure_action_queue
from .const import (
    DOMAIN,
    DEVICE_SCHEMA,
    CONF_DISABLE_TV_SOURCE,
    CONF_CREATE_SENSORS,
    CONF_DEFAULT_ON,
    CONF_DISABLE_ZONE,
    CONF_HOMEKIT_PLAYER,
    CONF_STATIC_NAME,
    CONF_SCHEDULE_ENTITY,
    CONF_OTT_DEVICES,
)



async def async_setup(hass, config):
    """Import YAML config and start a config entry."""
    if DOMAIN not in config:
        return True

    hass.async_create_task(
        hass.config_entries.flow.async_init(
            DOMAIN, context={"source": "import"}, data=config[DOMAIN]
        )
    )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up AGS Service from a config entry."""
    data = entry.data | entry.options
    DEVICE_SCHEMA(data)
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {
        'rooms': data['rooms'],
        'Sources': data['Sources'],
        'disable_zone': data.get(CONF_DISABLE_ZONE, False),
        'homekit_player': data.get(CONF_HOMEKIT_PLAYER, None),
        'create_sensors': data.get(CONF_CREATE_SENSORS, False),
        'default_on': data.get(CONF_DEFAULT_ON, False),
        'static_name': data.get(CONF_STATIC_NAME, None),
        'disable_Tv_Source': data.get(CONF_DISABLE_TV_SOURCE, False),
        'schedule_entity': data.get(CONF_SCHEDULE_ENTITY),
    }

    await ensure_action_queue(hass)
    hass.data[DOMAIN][entry.entry_id]["sensor_lock"] = asyncio.Lock()
    hass.data[DOMAIN][entry.entry_id]["update_event"] = asyncio.Event()

    create_sensors = data.get(CONF_CREATE_SENSORS, False)
    platforms = ["switch", "media_player"]
    if create_sensors:
        platforms.append("sensor")
    await hass.config_entries.async_forward_entry_setups(entry, platforms)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload AGS Service config entry."""
    platforms = ["switch", "media_player", "sensor"]
    await hass.config_entries.async_unload_platforms(entry, platforms)
    hass.data[DOMAIN].pop(entry.entry_id, None)
    return True


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Handle entry reload."""
    await async_unload_entry(hass, entry)
    await async_setup_entry(hass, entry)
