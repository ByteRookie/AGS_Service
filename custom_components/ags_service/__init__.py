"""Main module for the AGS Service integration."""
import asyncio
import copy
import logging
import voluptuous as vol

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.discovery import async_load_platform
from homeassistant.helpers.storage import Store
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.components import websocket_api, persistent_notification
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.panel_custom import async_register_panel
from homeassistant.components.frontend import add_extra_js_url
from .ags_service import ensure_action_queue

_LOGGER = logging.getLogger(__name__)

# Define the domain for the integration
DOMAIN = "ags_service"
STORAGE_VERSION = 1
STORAGE_KEY = "ags_service.json"
FRONTEND_ASSET_VERSION = "2.0.6"

# Signal for dynamic entity updates
SIGNAL_AGS_RELOAD = "ags_service_reload"

# Define the configuration keys
CONF_ROOM = 'room'
CONF_ROOMS = 'rooms'
CONF_DEVICE_ID = 'device_id'
CONF_DEVICE_TYPE = 'device_type'
CONF_PRIORITY = 'priority'
CONF_OVERRIDE_CONTENT = 'override_content'
CONF_OFF_OVERRIDE = 'off_override'
CONF_HOMEKIT_PLAYER = 'homekit_player'
CONF_CREATE_SENSORS = 'create_sensors'
CONF_DEFAULT_ON = 'default_on'
CONF_STATIC_NAME = 'static_name'
CONF_DISABLE_TV_SOURCE = 'disable_tv_source'
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
}, extra=vol.ALLOW_EXTRA)

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
        }, extra=vol.ALLOW_EXTRA)]),
    }, extra=vol.ALLOW_EXTRA
)

ROOM_SCHEMA = vol.Schema(
    {
        vol.Required("room"): cv.string,
        vol.Required("devices"): vol.All(cv.ensure_list, [DEVICE_SCHEMA]),
    }, extra=vol.ALLOW_EXTRA
)

SOURCE_SCHEMA = vol.Schema(
    {
        vol.Required("Source"): cv.string,
        vol.Required("Source_Value"): cv.string,
        vol.Required(CONF_MEDIA_CONTENT_TYPE): cv.string,
        vol.Optional(CONF_SOURCE_DEFAULT, default=False): cv.boolean,
        vol.Optional("priority"): cv.positive_int,
    }, extra=vol.ALLOW_EXTRA
)

CONFIG_SCHEMA = vol.Schema({
    DOMAIN: vol.Schema({
        vol.Optional("rooms"): vol.All(cv.ensure_list, [ROOM_SCHEMA]),
        vol.Optional("Sources"): vol.All(cv.ensure_list, [SOURCE_SCHEMA]),
        vol.Optional(CONF_OFF_OVERRIDE, default=False): cv.boolean,
        vol.Optional(CONF_HOMEKIT_PLAYER, default=None): vol.Any(None, cv.string),
        vol.Optional(CONF_CREATE_SENSORS, default=False): cv.boolean,
        vol.Optional(CONF_DEFAULT_ON, default=False): cv.boolean,
        vol.Optional(CONF_STATIC_NAME, default=""): vol.Any(cv.string, None),
        vol.Optional(CONF_DISABLE_TV_SOURCE, default=False): cv.boolean,
        vol.Optional(CONF_INTERVAL_SYNC, default=30): cv.positive_int,
        vol.Optional(CONF_SCHEDULE_ENTITY, default=None): vol.Any(None, vol.Schema({
            vol.Required('entity_id'): cv.entity_id,
            vol.Optional('on_state', default='on'): cv.string,
            vol.Optional('off_state', default='off'): cv.string,
            vol.Optional('schedule_override', default=False): cv.boolean,
        }, extra=vol.ALLOW_EXTRA)),
        vol.Optional("default_source_schedule", default=None): vol.Any(None, vol.Schema({
            vol.Required("entity_id"): cv.entity_id,
            vol.Required("source_name"): cv.string,
            vol.Optional("on_state", default="on"): cv.string,
        }, extra=vol.ALLOW_EXTRA)),
        vol.Optional(CONF_BATCH_UNJOIN, default=False): cv.boolean,
    }, extra=vol.ALLOW_EXTRA)
}, extra=vol.ALLOW_EXTRA)


def sanitize_runtime_config(raw_cfg: dict | None) -> dict:
    """Normalize runtime config and auto-fix safe conflicts."""
    cfg = copy.deepcopy(raw_cfg or {})

    normalized_rooms = []
    seen_devices: set[str] = set()

    for room in cfg.get("rooms", []) or []:
        room_name = str(room.get("room", "")).strip() or "Room"
        devices_with_order = []

        for original_index, device in enumerate(room.get("devices", []) or []):
            device_id = str(device.get("device_id", "")).strip()
            if not device_id:
                continue
            if device_id in seen_devices:
                raise vol.Invalid(f"Duplicate device entity configured: {device_id}")
            seen_devices.add(device_id)

            normalized_device = copy.deepcopy(device)
            normalized_device["device_id"] = device_id
            normalized_device["device_type"] = (
                "tv" if normalized_device.get("device_type") == "tv" else "speaker"
            )
            try:
                priority = int(normalized_device.get("priority", original_index + 1) or 1)
            except (TypeError, ValueError):
                priority = original_index + 1
            normalized_device["priority"] = max(1, priority)

            if normalized_device["device_type"] == "tv":
                normalized_device.setdefault(CONF_TV_MODE, TV_MODE_TV_AUDIO)
                normalized_device[CONF_OTT_DEVICES] = [
                    mapping
                    for mapping in normalized_device.get(CONF_OTT_DEVICES, []) or []
                    if mapping.get("ott_device") or mapping.get("tv_input")
                ]
            else:
                normalized_device.pop(CONF_OTT_DEVICE, None)
                normalized_device.pop(CONF_OTT_DEVICES, None)
                normalized_device.pop(CONF_TV_MODE, None)

            devices_with_order.append((original_index, normalized_device))

        ordered_devices = [
            device
            for _, device in sorted(
                devices_with_order,
                key=lambda pair: (pair[1].get("priority", 999), pair[0]),
            )
        ]
        for index, device in enumerate(ordered_devices, start=1):
            device["priority"] = index

        normalized_rooms.append(
            {
                **copy.deepcopy(room),
                "room": room_name,
                "devices": ordered_devices,
            }
        )

    normalized_sources = []
    seen_source_names: set[str] = set()
    default_assigned = False

    for source in cfg.get("Sources", []) or []:
        source_name = str(source.get("Source", "")).strip()
        source_value = str(source.get("Source_Value", "")).strip()

        if not source_name or not source_value:
            continue

        normalized_key = source_name.casefold()
        if normalized_key in seen_source_names:
            raise vol.Invalid(f"Duplicate source name configured: {source_name}")
        seen_source_names.add(normalized_key)

        normalized_source = copy.deepcopy(source)
        normalized_source["Source"] = source_name
        normalized_source["Source_Value"] = source_value
        is_default = bool(normalized_source.get(CONF_SOURCE_DEFAULT)) and not default_assigned
        normalized_source[CONF_SOURCE_DEFAULT] = is_default
        default_assigned = default_assigned or is_default
        normalized_sources.append(normalized_source)

    valid_source_names = {source["Source"] for source in normalized_sources}
    default_source_schedule = cfg.get("default_source_schedule")
    if default_source_schedule and default_source_schedule.get("source_name") not in valid_source_names:
        default_source_schedule = None

    homekit_player = cfg.get(CONF_HOMEKIT_PLAYER)
    if homekit_player == "":
        homekit_player = None

    return {
        **cfg,
        "rooms": normalized_rooms,
        "Sources": normalized_sources,
        CONF_HOMEKIT_PLAYER: homekit_player,
        "default_source_schedule": default_source_schedule,
    }

# Add a custom logging handler to capture AGS specific logs
class AGSLogHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.logs = []

    def emit(self, record):
        log_entry = self.format(record)
        self.logs.append(log_entry)
        if len(self.logs) > 50:
            self.logs.pop(0)

ags_log_handler = AGSLogHandler()
ags_log_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))

ags_logger = logging.getLogger("custom_components.ags_service")
ags_logger.addHandler(ags_log_handler)
ags_logger.setLevel(logging.INFO)

logging.getLogger(__name__).addHandler(ags_log_handler)
logging.getLogger(__name__).setLevel(logging.INFO)

async def async_setup(hass: HomeAssistant, config: dict):
    """Set up the custom component."""
    await _async_initialize_runtime(hass, config)

    if not hass.config_entries.async_entries(DOMAIN):
        # Legacy YAML mode: discover platforms directly.
        await async_load_platform(hass, 'sensor', DOMAIN, {}, config)
        await async_load_platform(hass, 'switch', DOMAIN, {}, config)
        await async_load_platform(hass, 'media_player', DOMAIN, {}, config)

    return True


async def _async_initialize_runtime(hass: HomeAssistant, config: dict):
    """Initialize shared runtime state, storage, websocket endpoints, and panel."""
    if DOMAIN in hass.data and hass.data[DOMAIN].get("_runtime_initialized"):
        return True

    store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
    stored_config = await store.async_load()

    legacy_config = config.get(DOMAIN, {})
    
    if stored_config is None:
        if legacy_config:
            # Migration from legacy YAML
            _LOGGER.info("Migrating legacy AGS configuration to JSON storage")
            stored_config = legacy_config
            await store.async_save(stored_config)
            
            persistent_notification.async_create(
                hass,
                "AGS has migrated to a UI-driven configuration. Please remove the `ags_service:` block from your `configuration.yaml` and restart.",
                title="AGS Configuration Migrated",
                notification_id="ags_migration"
            )
        else:
            # New installation
            stored_config = {
                "rooms": [],
                "Sources": [],
                "off_override": False,
                "create_sensors": True,
                "interval_sync": 30
            }

    # Internal helper to apply config to hass.data
    def apply_config(cfg):
        cfg = sanitize_runtime_config(cfg)
        # Validate device-specific constraints
        for room in cfg.get('rooms', []):
            for device in room.get('devices', []):
                if (CONF_OTT_DEVICE in device or CONF_OTT_DEVICES in device) and device.get('device_type') != 'tv':
                    raise vol.Invalid("ott_device is only allowed for devices with device_type 'tv'")
                if CONF_TV_MODE in device and device.get('device_type') != 'tv':
                    raise vol.Invalid("tv_mode is only allowed for devices with device_type 'tv'")
                if device.get('device_type') == 'tv' and CONF_TV_MODE not in device:
                    device[CONF_TV_MODE] = TV_MODE_TV_AUDIO

        hass.data[DOMAIN].update({
            'rooms': cfg.get('rooms', []),
            'Sources': cfg.get('Sources', []),
            'off_override': cfg.get(CONF_OFF_OVERRIDE, False),
            'homekit_player': cfg.get(CONF_HOMEKIT_PLAYER, None),
            'create_sensors': cfg.get(CONF_CREATE_SENSORS, False),
            'default_on': cfg.get(CONF_DEFAULT_ON, False),
            'static_name': cfg.get(CONF_STATIC_NAME, ""),
            'disable_tv_source': cfg.get(CONF_DISABLE_TV_SOURCE, False),
            'disable_Tv_Source': cfg.get(CONF_DISABLE_TV_SOURCE, False),
            'schedule_entity': cfg.get(CONF_SCHEDULE_ENTITY),
            'default_source_schedule': cfg.get("default_source_schedule"),
            'batch_unjoin': cfg.get(CONF_BATCH_UNJOIN, False),
        })

    existing = hass.data.get(DOMAIN, {})
    hass.data[DOMAIN] = {**existing, 'store': store}
    apply_config(stored_config)
    hass.data[DOMAIN]['apply_config'] = apply_config

    # Cancel existing action worker if it's already running (from a previous setup)
    if "action_worker" in hass.data[DOMAIN]:
        hass.data[DOMAIN]["action_worker"].cancel()

    # Initialize shared media action queue
    await ensure_action_queue(hass)

    # Initialize synchronization primitives used for sensor updates
    hass.data[DOMAIN]["sensor_lock"] = asyncio.Lock()


    # Register WebSocket API endpoints
    websocket_api.async_register_command(hass, ws_get_config)
    websocket_api.async_register_command(hass, ws_save_config)
    websocket_api.async_register_command(hass, ws_get_logs)

    # Register static path for panel
    import os
    panel_path = os.path.join(os.path.dirname(__file__), "frontend")
    await hass.http.async_register_static_paths([
        StaticPathConfig("/ags-static", panel_path, True)
    ])

    # Register custom panel
    await async_register_panel(
        hass,
        frontend_url_path="ags-service",
        webcomponent_name="ags-panel",
        sidebar_title="AGS Service",
        sidebar_icon="mdi:account-group",
        module_url=f"/ags-static/ags-panel.js?v={FRONTEND_ASSET_VERSION}",
        embed_iframe=False,
        trust_external=False,
    )

    # Register Lovelace Custom Card
    add_extra_js_url(hass, f"/ags-static/ags-media-card.js?v={FRONTEND_ASSET_VERSION}")

    hass.data[DOMAIN]["_runtime_initialized"] = True

    return True


async def async_setup_entry(hass: HomeAssistant, entry):
    """Set up AGS Service from a config entry."""
    await _async_initialize_runtime(hass, {DOMAIN: entry.data or {}})
    await hass.config_entries.async_forward_entry_setups(
        entry, ["sensor", "switch", "media_player"]
    )
    return True

@websocket_api.websocket_command({
    vol.Required("type"): "ags_service/config/get",
})
@callback
def ws_get_config(hass, connection, msg):
    """Handle get config command."""
    config = hass.data[DOMAIN]
    data = {
        "rooms": config.get("rooms", []),
        "Sources": config.get("Sources", []),
        "off_override": config.get("off_override", False),
        "homekit_player": config.get("homekit_player", None),
        "create_sensors": config.get("create_sensors", False),
        "default_on": config.get("default_on", False),
        "static_name": config.get("static_name", ""),
        "disable_tv_source": config.get("disable_tv_source", False),
        "schedule_entity": config.get("schedule_entity", None),
        "default_source_schedule": config.get("default_source_schedule", None),
        "batch_unjoin": config.get("batch_unjoin", False),
    }
    connection.send_result(msg["id"], data)

@websocket_api.websocket_command({
    vol.Required("type"): "ags_service/config/save",
    vol.Required("config"): dict,
})
@callback
def ws_save_config(hass, connection, msg):
    """Handle save config command with validation and hot-reload."""
    new_config = msg["config"]
    
    # Phase 2: Configuration Validation
    try:
        validated_config = CONFIG_SCHEMA({DOMAIN: new_config})[DOMAIN]
        validated_config = sanitize_runtime_config(validated_config)
    except vol.Invalid as err:
        connection.send_error(msg["id"], "invalid_config", str(err))
        return

    # Update live memory
    hass.data[DOMAIN]['apply_config'](validated_config)
    
    # Phase 2: Hot-Reload Engine
    # Signal entities to refresh themselves based on new config
    async_dispatcher_send(hass, SIGNAL_AGS_RELOAD)
    
    # Trigger storage save
    store = hass.data[DOMAIN]["store"]
    hass.async_create_task(store.async_save(validated_config))
    
    connection.send_result(msg["id"])

@websocket_api.websocket_command({
    vol.Required("type"): "ags_service/get_logs",
})
@callback
def ws_get_logs(hass, connection, msg):
    """Expose AGS specific logs via WebSocket."""
    connection.send_result(msg["id"], ags_log_handler.logs)

async def async_unload_entry(hass, entry):
    """Unload a config entry and cancel background tasks."""
    # Cancel the action queue worker
    if DOMAIN in hass.data and "action_worker" in hass.data[DOMAIN]:
        hass.data[DOMAIN]["action_worker"].cancel()
        hass.data[DOMAIN].pop("action_worker", None)
        hass.data[DOMAIN].pop("action_queue", None)
        hass.data[DOMAIN].pop("_runtime_initialized", None)
    
    # Unload platforms (sensor, switch, media_player)
    unload_ok = await hass.config_entries.async_unload_platforms(entry, ["sensor", "switch", "media_player"])
    return unload_ok
