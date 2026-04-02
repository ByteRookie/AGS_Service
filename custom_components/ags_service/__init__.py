"""Main module for the AGS Service integration."""
import asyncio
import logging
import voluptuous as vol

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.discovery import async_load_platform
from homeassistant.helpers.storage import Store
from homeassistant.components import websocket_api
from .ags_service import ensure_action_queue

_LOGGER = logging.getLogger(__name__)

# Define the domain for the integration
DOMAIN = "ags_service"
STORAGE_VERSION = 1
STORAGE_KEY = "ags_service.json"

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
CONF_BATCH_UNJOIN = 'batch_unjoin'
CONF_SOURCES = 'Sources'
CONF_SOURCE = 'Source'
CONF_MEDIA_CONTENT_TYPE = 'media_content_type'
CONF_SOURCE_VALUE = 'Source_Value'
CONF_SOURCE_DEFAULT = 'source_default'
CONF_TV_MODE = 'tv_mode'

TV_MODE_TV_AUDIO = 'tv_audio'
TV_MODE_NO_MUSIC = 'no_music'


# Define the configuration schema for an OTT device mapping
OTT_DEVICE_SCHEMA = vol.Schema({
    vol.Required("ott_device"): cv.entity_id,
    vol.Optional("tv_input"): cv.string,
})

# Define the configuration schema for a device
DEVICE_SCHEMA = vol.Schema(
    {
        vol.Required("device_id"): cv.entity_id,
        vol.Required("device_type"): cv.string,
        vol.Required("priority"): cv.positive_int,
        vol.Optional("override_content"): cv.string,
        vol.Optional(CONF_OTT_DEVICE): cv.entity_id,
        vol.Optional(CONF_OTT_DEVICES): vol.All(cv.ensure_list, [OTT_DEVICE_SCHEMA]),
        vol.Optional(CONF_TV_MODE): vol.In([TV_MODE_TV_AUDIO, TV_MODE_NO_MUSIC]),
        vol.Optional("source_overrides"): vol.All(cv.ensure_list, [vol.Schema({
            vol.Required("mode"): vol.In(["source", "script"]),
            vol.Required("source_name"): cv.string,
            vol.Optional("script_entity"): cv.entity_id,
            vol.Optional("source_value"): cv.string,
            vol.Optional("run_when_tv_off", default=False): cv.boolean,
        })]),
    }
)

ROOM_SCHEMA = vol.Schema(
    {
        vol.Required("room"): cv.string,
        vol.Required("devices"): vol.All(cv.ensure_list, [DEVICE_SCHEMA]),
    }
)

SOURCE_SCHEMA = vol.Schema(
    {
        vol.Required("Source"): cv.string,
        vol.Required("Source_Value"): cv.string,
        vol.Required(CONF_MEDIA_CONTENT_TYPE): cv.string,
        vol.Optional(CONF_SOURCE_DEFAULT, default=False): cv.boolean,
    }
)

CONFIG_SCHEMA = vol.Schema({
    DOMAIN: vol.Schema({
        vol.Optional("rooms"): vol.All(cv.ensure_list, [ROOM_SCHEMA]),
        vol.Optional("Sources"): vol.All(cv.ensure_list, [SOURCE_SCHEMA]),
        vol.Optional(CONF_DISABLE_ZONE, default=False): cv.boolean,
        vol.Optional(CONF_HOMEKIT_PLAYER, default=None): cv.string,
        vol.Optional(CONF_CREATE_SENSORS, default=False): cv.boolean,
        vol.Optional(CONF_DEFAULT_ON, default=False): cv.boolean,
        vol.Optional(CONF_STATIC_NAME, default=""): vol.Any(cv.string, None),
        vol.Optional(CONF_DISABLE_TV_SOURCE, default=False): cv.boolean,
        vol.Optional(CONF_INTERVAL_SYNC, default=30): cv.positive_int,
        vol.Optional(CONF_SCHEDULE_ENTITY): vol.Schema({
            vol.Required('entity_id'): cv.entity_id,
            vol.Optional('on_state', default='on'): cv.string,
            vol.Optional('off_state', default='off'): cv.string,
            vol.Optional('schedule_override', default=False): cv.boolean,
        }),
        vol.Optional(CONF_BATCH_UNJOIN, default=False): cv.boolean,
    })
}, extra=vol.ALLOW_EXTRA)

async def async_setup(hass: HomeAssistant, config: dict):
    """Set up the custom component."""
    
    store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
    stored_config = await store.async_load()

    legacy_config = config.get(DOMAIN, {})
    
    if stored_config is None:
        if legacy_config:
            # Migration from legacy YAML
            _LOGGER.info("Migrating legacy AGS configuration to JSON storage")
            stored_config = legacy_config
            await store.async_save(stored_config)
            
            hass.components.persistent_notification.async_create(
                "AGS has migrated to a UI-driven configuration. Please remove the `ags_service:` block from your `configuration.yaml` and restart.",
                title="AGS Configuration Migrated",
                notification_id="ags_migration"
            )
        else:
            # New installation
            stored_config = {
                "rooms": [],
                "Sources": [],
                "disable_zone": False,
                "create_sensors": True,
                "interval_sync": 30
            }

    ags_config = stored_config

    # Validate ott_device and tv_mode usage
    for room in ags_config.get('rooms', []):
        for device in room.get('devices', []):
            if (CONF_OTT_DEVICE in device or CONF_OTT_DEVICES in device) and device.get('device_type') != 'tv':
                raise vol.Invalid(
                    "ott_device is only allowed for devices with device_type 'tv'"
                )
            if CONF_TV_MODE in device and device.get('device_type') != 'tv':
                raise vol.Invalid(
                    "tv_mode is only allowed for devices with device_type 'tv'"
                )
            if device.get('device_type') == 'tv' and CONF_TV_MODE not in device:
                device[CONF_TV_MODE] = TV_MODE_TV_AUDIO

    hass.data[DOMAIN] = {
        'rooms': ags_config.get('rooms', []),
        'Sources': ags_config.get('Sources', []),
        'disable_zone': ags_config.get(CONF_DISABLE_ZONE, False),
        'homekit_player': ags_config.get(CONF_HOMEKIT_PLAYER, None),
        'create_sensors': ags_config.get(CONF_CREATE_SENSORS, False),
        'default_on': ags_config.get(CONF_DEFAULT_ON, False),
        'static_name': ags_config.get(CONF_STATIC_NAME, ""),
        'disable_Tv_Source': ags_config.get(CONF_DISABLE_TV_SOURCE, False),
        'schedule_entity': ags_config.get(CONF_SCHEDULE_ENTITY),
        'batch_unjoin': ags_config.get(CONF_BATCH_UNJOIN, False),
        'store': store
    }

    # Cancel existing action worker if it's already running (from a previous setup)
    if "action_worker" in hass.data[DOMAIN]:
        hass.data[DOMAIN]["action_worker"].cancel()

    # Initialize shared media action queue
    await ensure_action_queue(hass)

    # Initialize synchronization primitives used for sensor updates
    hass.data[DOMAIN]["sensor_lock"] = asyncio.Lock()


    # Load the sensor and switch platforms and pass the configuration to them
    create_sensors = ags_config.get('create_sensors', False)
    if create_sensors:
        await async_load_platform(hass, 'sensor', DOMAIN, {}, config)
    
    await async_load_platform(hass, 'switch', DOMAIN, {}, config)
    await async_load_platform(hass, 'media_player', DOMAIN, {}, config)

    # Register WebSocket API endpoints
    websocket_api.async_register_command(hass, ws_get_config)
    websocket_api.async_register_command(hass, ws_save_config)

    # Register static path for panel
    import os
    panel_path = os.path.join(os.path.dirname(__file__), "frontend")
    hass.http.register_static_path("/ags-static", panel_path)

    # Register custom panel
    hass.components.frontend.async_register_built_in_panel(
        "custom",
        "AGS Service",
        "mdi:account-group",
        "ags-service",
        {"module_url": "/ags-static/ags-panel.js"},
    )
    # The actual panel registration usually requires more boilerplate for serving static files
    # For now, I'll stick to the logic requested.

    return True

@websocket_api.websocket_command({
    vol.Required("type"): "ags_service/config/get",
})
@callback
def ws_get_config(hass, connection, msg):
    """Handle get config command."""
    config = hass.data[DOMAIN]
    data = {
        "rooms": config["rooms"],
        "Sources": config["Sources"],
        "disable_zone": config["disable_zone"],
        "homekit_player": config["homekit_player"],
        "create_sensors": config["create_sensors"],
        "default_on": config["default_on"],
        "static_name": config["static_name"],
        "disable_Tv_Source": config["disable_Tv_Source"],
        "schedule_entity": config["schedule_entity"],
        "batch_unjoin": config["batch_unjoin"],
    }
    connection.send_result(msg["id"], data)

@websocket_api.websocket_command({
    vol.Required("type"): "ags_service/config/save",
    vol.Required("config"): dict,
})
@callback
def ws_save_config(hass, connection, msg):
    """Handle save config command."""
    new_config = msg["config"]
    hass.data[DOMAIN].update(new_config)
    
    # Trigger storage save
    store = hass.data[DOMAIN]["store"]
    hass.async_create_task(store.async_save(new_config))
    
    # Trigger reload/sync
    # (In a real implementation, we might want to reload the integration or re-initialize sensors)
    # For now, we update hass.data which sensors/players read from.
    
    connection.send_result(msg["id"])

async def async_unload_entry(hass, entry):
    """Unload a config entry and cancel background tasks."""
    # Cancel the action queue worker
    if DOMAIN in hass.data and "action_worker" in hass.data[DOMAIN]:
        hass.data[DOMAIN]["action_worker"].cancel()
    
    # Unload platforms (sensor, switch, media_player)
    unload_ok = await hass.config_entries.async_unload_platforms(entry, ["sensor", "switch", "media_player"])
    return unload_ok
