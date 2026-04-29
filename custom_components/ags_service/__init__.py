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
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.components import websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.panel_custom import async_register_panel
from homeassistant.components.frontend import add_extra_js_url
from .ags_service import ensure_action_queue, update_ags_sensors
from .source_utils import (
    CONF_DEFAULT_SOURCE_ID,
    CONF_HIDDEN_SOURCE_IDS,
    CONF_LAST_DISCOVERED_SOURCES,
    CONF_SOURCE_DISPLAY_NAMES,
    CONF_SOURCE_FAVORITES,
    normalize_source_list,
    normalize_source_storage,
)

_LOGGER = logging.getLogger(__name__)

# Define the domain for the integration
DOMAIN = "ags_service"
STORAGE_VERSION = 1
STORAGE_KEY = "ags_service.json"
BACKUP_STORAGE_KEY = "ags_service.backup.json"
FRONTEND_ASSET_VERSION = "2.1.0"

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
CONF_NATIVE_ROOM_POPUP = 'native_room_popup'
CONF_PORTAL_MEDIA_PLAYER = 'portal_media_player'
CONF_SOURCES = 'Sources'
CONF_FAVORITE_SOURCES = 'favorite_sources'
CONF_SOURCE = 'Source'
CONF_MEDIA_CONTENT_TYPE = 'media_content_type'
CONF_SOURCE_VALUE = 'Source_Value'
CONF_SOURCE_DEFAULT = 'source_default'
CONF_TV_MODE = 'tv_mode'
CONF_HA_AREA_ID = 'ha_area_id'
CONF_HA_AREA_NAME = 'ha_area_name'
CONF_HA_AREA_LINKED = 'ha_area_linked'

TV_MODE_TV_AUDIO = 'tv_audio'
TV_MODE_NO_MUSIC = 'no_music'


# Define the configuration schema for an OTT device mapping
OTT_DEVICE_SCHEMA = vol.Schema({
    vol.Required("ott_device"): cv.string,
    vol.Optional("tv_input"): cv.string,
}, extra=vol.ALLOW_EXTRA)

# Define the configuration schema for a device
DEVICE_SCHEMA = vol.Schema(
    {
        vol.Optional("device_id", default=""): cv.string,
        vol.Required("device_type"): vol.In(["speaker", "tv", "ott"]),
        vol.Required("priority"): cv.positive_int,
        vol.Optional("override_content"): cv.string,
        vol.Optional(CONF_OTT_DEVICE): cv.string,
        vol.Optional(CONF_OTT_DEVICES): vol.All(cv.ensure_list, [OTT_DEVICE_SCHEMA]),
        vol.Optional(CONF_TV_MODE): vol.In([TV_MODE_TV_AUDIO, TV_MODE_NO_MUSIC]),
        vol.Optional("volume_offset", default=0): vol.Coerce(int),
        vol.Optional("tv_speaker_mode"): cv.string,
        vol.Optional("election_toggle"): vol.In(["primary", "follower"]),
        vol.Optional("tv_input"): cv.string,
        vol.Optional("parent_tv"): cv.string,
        vol.Optional("unique_id"): cv.string,
        vol.Optional("disabled", default=False): cv.boolean,
    }, extra=vol.ALLOW_EXTRA
)

ROOM_SCHEMA = vol.Schema(
    {
        vol.Required("room"): cv.string,
        vol.Required("devices"): vol.All(cv.ensure_list, [DEVICE_SCHEMA]),
        vol.Optional(CONF_HA_AREA_ID): cv.string,
        vol.Optional(CONF_HA_AREA_NAME): cv.string,
        vol.Optional(CONF_HA_AREA_LINKED, default=False): cv.boolean,
    }, extra=vol.ALLOW_EXTRA
)

SOURCE_SCHEMA = vol.Schema(
    {
        vol.Optional("id"): cv.string,
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
        vol.Optional(CONF_SOURCE_FAVORITES): vol.All(cv.ensure_list, [SOURCE_SCHEMA]),
        vol.Optional(CONF_HIDDEN_SOURCE_IDS): vol.All(cv.ensure_list, [cv.string]),
        vol.Optional(CONF_SOURCE_DISPLAY_NAMES): dict,
        vol.Optional(CONF_DEFAULT_SOURCE_ID, default=None): vol.Any(None, cv.string),
        vol.Optional(CONF_LAST_DISCOVERED_SOURCES): vol.All(cv.ensure_list, [SOURCE_SCHEMA]),
        # Legacy source keys are accepted only for migration.
        vol.Optional(CONF_FAVORITE_SOURCES): vol.All(cv.ensure_list, [SOURCE_SCHEMA]),
        vol.Optional("Sources"): vol.All(cv.ensure_list, [SOURCE_SCHEMA]),
        vol.Optional("ExcludedSources"): vol.All(cv.ensure_list, [cv.string]),
        vol.Optional(CONF_OFF_OVERRIDE, default=False): cv.boolean,
        vol.Optional(CONF_HOMEKIT_PLAYER, default=None): vol.Any(None, cv.string),
        vol.Optional(CONF_CREATE_SENSORS, default=False): cv.boolean,
        vol.Optional(CONF_DEFAULT_ON, default=False): cv.boolean,
        vol.Optional(CONF_STATIC_NAME, default=""): vol.Any(cv.string, None),
        vol.Optional(CONF_DISABLE_TV_SOURCE, default=False): cv.boolean,
        vol.Optional(CONF_INTERVAL_SYNC, default=30): cv.positive_int,
        vol.Optional(CONF_SCHEDULE_ENTITY, default=None): vol.Any(None, vol.Schema({
            vol.Required('entity_id'): cv.string,
            vol.Optional('on_state', default='on'): cv.string,
            vol.Optional('off_state', default='off'): cv.string,
            vol.Optional('schedule_override', default=False): cv.boolean,
        }, extra=vol.ALLOW_EXTRA)),
        vol.Optional("default_source_schedule", default=None): vol.Any(None, vol.Schema({
            vol.Required("entity_id"): cv.string,
            vol.Required("source_name"): cv.string,
            vol.Optional("on_state", default="on"): cv.string,
        }, extra=vol.ALLOW_EXTRA)),
        vol.Optional(CONF_BATCH_UNJOIN, default=False): cv.boolean,
        vol.Optional(CONF_NATIVE_ROOM_POPUP, default=True): cv.boolean,
        vol.Optional(CONF_PORTAL_MEDIA_PLAYER, default="ha_default"): vol.In(["ha_default", "custom"]),
    }, extra=vol.ALLOW_EXTRA)
}, extra=vol.ALLOW_EXTRA)


def _config_has_user_data(cfg: dict | None) -> bool:
    """Return true when a config contains user-defined AGS setup."""
    if not isinstance(cfg, dict):
        return False
    return bool(
        cfg.get("rooms")
        or cfg.get(CONF_SOURCE_FAVORITES)
        or cfg.get(CONF_LAST_DISCOVERED_SOURCES)
        or cfg.get(CONF_FAVORITE_SOURCES)
        or cfg.get("Sources")
    )


def _merge_missing_config(primary: dict, fallback: dict | None) -> tuple[dict, bool]:
    """Fill missing or empty top-level config keys from a fallback config."""
    if not isinstance(fallback, dict) or not fallback:
        return primary, False

    merged = copy.deepcopy(primary or {})
    changed = False
    for key, value in fallback.items():
        if value is None:
            continue
        current = merged.get(key)
        if key not in merged or current in (None, "", []) or current == {}:
            merged[key] = copy.deepcopy(value)
            changed = True
    return merged, changed


def _remove_legacy_homekit_media_player(hass: HomeAssistant) -> None:
    """Remove the retired AGS HomeKit media-player entity from the registry."""
    try:
        registry = er.async_get(hass)
    except Exception:
        return

    entries = getattr(registry, "entities", {})
    iterable = list(entries.values()) if hasattr(entries, "values") else []
    for entry in iterable:
        if (
            getattr(entry, "platform", None) == DOMAIN
            and getattr(entry, "domain", None) == "media_player"
            and getattr(entry, "unique_id", None) == "ags_homekit_media_system"
        ):
            try:
                registry.async_remove(entry.entity_id)
                _LOGGER.info("Removed retired AGS HomeKit media player %s", entry.entity_id)
            except Exception as err:
                _LOGGER.debug("Unable to remove retired AGS media player %s: %s", entry.entity_id, err)


async def _async_save_config_with_backup(
    hass: HomeAssistant,
    config: dict,
    *,
    store: Store | None = None,
) -> None:
    """Save config and keep a last-known-good backup for storage recovery."""
    store = store or hass.data[DOMAIN]["store"]
    backup_store = hass.data[DOMAIN].get("backup_store")
    if backup_store is None:
        backup_store = Store(hass, STORAGE_VERSION, BACKUP_STORAGE_KEY)
        hass.data[DOMAIN]["backup_store"] = backup_store

    current_config = hass.data.get(DOMAIN, {}).get("_stored_config_cache")
    if _config_has_user_data(current_config):
        await backup_store.async_save(current_config)

    await store.async_save(config)

    if _config_has_user_data(config):
        await backup_store.async_save(config)


def _registry_values(registry, attr: str) -> list:
    """Return registry collection values across HA registry API variants."""
    values = getattr(registry, attr, {})
    if not values and attr == "areas" and hasattr(registry, "async_list_areas"):
        values = registry.async_list_areas()
    if callable(values):
        try:
            values = values()
        except TypeError:
            values = {}
    if hasattr(values, "values"):
        return list(values.values())
    return list(values or [])


def _area_name(area) -> str:
    return str(getattr(area, "name", "") or getattr(area, "id", "") or "Area")


def _device_is_tv_like(hass: HomeAssistant, entity_id: str, entity_entry=None) -> bool:
    state = hass.states.get(entity_id)
    attrs = getattr(state, "attributes", {}) or {}
    candidates = [
        attrs.get("device_class"),
        attrs.get("friendly_name"),
        entity_id,
        getattr(entity_entry, "original_name", None),
        getattr(entity_entry, "name", None),
    ]
    return any("tv" in str(candidate or "").lower() for candidate in candidates)


def _get_ha_areas_with_media_players(hass: HomeAssistant) -> list[dict]:
    """Return HA areas with media_player entities resolved through registries."""
    area_registry = ar.async_get(hass)
    entity_registry = er.async_get(hass)
    device_registry = dr.async_get(hass)

    areas = sorted(_registry_values(area_registry, "areas"), key=_area_name)
    entity_entries = _registry_values(entity_registry, "entities")
    devices = _registry_values(device_registry, "devices")
    devices_by_area: dict[str, set[str]] = {}
    for device in devices:
        area_id = getattr(device, "area_id", None)
        device_id = getattr(device, "id", None)
        if area_id and device_id:
            devices_by_area.setdefault(area_id, set()).add(device_id)

    result = []
    for area in areas:
        area_id = getattr(area, "id", "")
        if not area_id:
            continue

        entities = []
        seen: set[str] = set()
        for entry in entity_entries:
            if getattr(entry, "domain", None) != "media_player":
                continue
            entry_area_id = getattr(entry, "area_id", None)
            device_id = getattr(entry, "device_id", None)
            if entry_area_id != area_id and device_id not in devices_by_area.get(area_id, set()):
                continue
            entity_id = getattr(entry, "entity_id", "")
            if not entity_id or entity_id in seen:
                continue
            seen.add(entity_id)
            state = hass.states.get(entity_id)
            entities.append(
                {
                    "entity_id": entity_id,
                    "name": (
                        (getattr(state, "attributes", {}) or {}).get("friendly_name")
                        or getattr(entry, "original_name", None)
                        or getattr(entry, "name", None)
                        or entity_id
                    ),
                    "device_type": "tv" if _device_is_tv_like(hass, entity_id, entry) else "speaker",
                }
            )

        result.append(
            {
                "area_id": area_id,
                "name": _area_name(area),
                "media_players": sorted(entities, key=lambda item: item["name"].lower()),
            }
        )

    return result


def sync_linked_area_rooms(hass: HomeAssistant, raw_cfg: dict | None) -> dict:
    """Mirror linked AGS rooms to their HA area media players."""
    cfg = copy.deepcopy(raw_cfg or {})
    area_map = {
        area["area_id"]: area
        for area in _get_ha_areas_with_media_players(hass)
    }

    next_priority = 1
    for room in cfg.get("rooms", []) or []:
        for device in room.get("devices", []) or []:
            try:
                next_priority = max(next_priority, int(device.get("priority", 0) or 0) + 1)
            except (TypeError, ValueError):
                continue

    for room in cfg.get("rooms", []) or []:
        area_id = str(room.get(CONF_HA_AREA_ID) or "").strip()
        if not room.get(CONF_HA_AREA_LINKED) or not area_id or area_id not in area_map:
            continue

        area = area_map[area_id]
        existing_by_id = {
            str(device.get("device_id") or "").strip(): copy.deepcopy(device)
            for device in room.get("devices", []) or []
            if str(device.get("device_id") or "").strip()
        }

        synced_devices = []
        for entity in area["media_players"]:
            entity_id = entity["entity_id"]
            device = existing_by_id.get(entity_id)
            if device is None:
                device = {
                    "device_id": entity_id,
                    "device_type": entity["device_type"],
                    "priority": next_priority,
                    "override_content": "",
                    "disabled": False,
                }
                next_priority += 1
            else:
                device["device_id"] = entity_id
                device.setdefault("device_type", entity["device_type"])
                device.setdefault("priority", next_priority)
                device.setdefault("override_content", "")
                device.setdefault("disabled", False)
            synced_devices.append(device)

        room["devices"] = synced_devices
        room[CONF_HA_AREA_NAME] = area["name"]
        room[CONF_HA_AREA_LINKED] = True

    return cfg


def sanitize_runtime_config(raw_cfg: dict | None) -> dict:
    """Normalize runtime config and auto-fix safe conflicts."""
    cfg = copy.deepcopy(raw_cfg or {})

    normalized_rooms = []
    seen_devices: set[str] = set()

    for room in cfg.get("rooms", []) or []:
        room_name = str(room.get("room", "")).strip() or "Room"
        devices = room.get("devices", []) or []

        # Migration: Pull legacy nested ott_devices into top-level list
        legacy_otts = []
        for device in devices:
            d_type = str(device.get("device_type", "")).lower()
            if (d_type == "tv" or d_type == "television") and "ott_devices" in device:
                for mapping in device["ott_devices"] or []:
                    ott_id = mapping.get("ott_device")
                    if ott_id:
                        # Check if this OTT already exists at top level for this TV
                        exists = any(
                            d.get("device_id") == ott_id and 
                            str(d.get("device_type", "")).lower() == "ott" and 
                            d.get("parent_tv") == device.get("device_id")
                            for d in devices
                        )
                        if not exists:
                            import random, string
                            legacy_otts.append({
                                "device_id": ott_id,
                                "device_type": "ott",
                                "parent_tv": device.get("device_id"),
                                "tv_input": mapping.get("tv_input", ""),
                                "priority": device.get("priority", 999),
                                "unique_id": ''.join(random.choices(string.ascii_lowercase + string.digits, k=9))
                            })

        if legacy_otts:
            devices.extend(legacy_otts)
            room["devices"] = devices

        devices_with_order = []
        room_primary_entities: set[str] = set()

        for original_index, device in enumerate(room.get("devices", []) or []):
            device_id = str(device.get("device_id", "")).strip()
            if not device_id:
                continue

            d_type = device.get("device_type")
            if d_type in ["speaker", "tv"]:
                if device_id in room_primary_entities:
                    _LOGGER.warning("Duplicate primary device entity %s found in room %s, skipping", device_id, room_name)
                    continue
                room_primary_entities.add(device_id)

            # Global duplicate check (optional, but keep it if we want to ensure uniqueness across the whole system for speakers/tvs)
            # The requirement says 'per room', so let's stick to that.
            if d_type != "ott" and device_id in seen_devices:
                 _LOGGER.warning("Primary device entity %s already assigned to another room, skipping", device_id)
                 continue
            if d_type != "ott":
                seen_devices.add(device_id)

            normalized_device = copy.deepcopy(device)
            normalized_device["device_id"] = device_id
            if not normalized_device.get("unique_id"):
                import random, string
                normalized_device["unique_id"] = ''.join(random.choices(string.ascii_lowercase + string.digits, k=9))

            d_type = normalized_device.get("device_type")
            if d_type not in ["speaker", "tv", "ott"]:
                d_type = "speaker"
            normalized_device["device_type"] = d_type

            try:
                priority = int(normalized_device.get("priority", original_index + 1) or 1)
            except (TypeError, ValueError):
                priority = original_index + 1
            normalized_device["priority"] = max(1, priority)
            normalized_device.pop("source_overrides", None)

            if normalized_device["device_type"] == "tv":
                normalized_device.setdefault(CONF_TV_MODE, TV_MODE_TV_AUDIO)
                normalized_device[CONF_OTT_DEVICES] = [
                    mapping
                    for mapping in normalized_device.get(CONF_OTT_DEVICES, []) or []
                    if mapping.get("ott_device") or mapping.get("tv_input")
                ]
                normalized_device.pop("volume_offset", None)
                normalized_device.pop("tv_speaker_mode", None)
                normalized_device.pop("election_toggle", None)
                normalized_device.pop("tv_input", None)
                normalized_device.pop("parent_tv", None)
            elif normalized_device["device_type"] == "speaker":
                normalized_device.setdefault("volume_offset", 0)
                normalized_device.setdefault("election_toggle", "primary")
                normalized_device.pop(CONF_OTT_DEVICE, None)
                normalized_device.pop(CONF_OTT_DEVICES, None)
                normalized_device.pop(CONF_TV_MODE, None)
                normalized_device.pop("tv_input", None)
                normalized_device.pop("parent_tv", None)
            elif normalized_device["device_type"] == "ott":
                normalized_device.pop(CONF_OTT_DEVICE, None)
                normalized_device.pop(CONF_OTT_DEVICES, None)
                normalized_device.pop(CONF_TV_MODE, None)
                normalized_device.pop("volume_offset", None)
                normalized_device.pop("tv_speaker_mode", None)
                normalized_device.pop("election_toggle", None)

            devices_with_order.append((original_index, normalized_device))

        ordered_devices = [
            device
            for _, device in sorted(
                devices_with_order,
                key=lambda pair: (pair[1].get("priority", 999), pair[0]),
            )
        ]

        normalized_rooms.append(
            {
                **copy.deepcopy(room),
                "room": room_name,
                "devices": ordered_devices,
                CONF_HA_AREA_ID: str(room.get(CONF_HA_AREA_ID) or "").strip(),
                CONF_HA_AREA_NAME: str(room.get(CONF_HA_AREA_NAME) or "").strip(),
                CONF_HA_AREA_LINKED: bool(room.get(CONF_HA_AREA_LINKED)),
            }
        )

    all_devices = [
        (room_index, device_index, device)
        for room_index, room in enumerate(normalized_rooms)
        for device_index, device in enumerate(room.get("devices", []) or [])
    ]
    for rank, (_, _, device) in enumerate(
        sorted(
            all_devices,
            key=lambda item: (item[2].get("priority", 999), item[0], item[1]),
        ),
        start=1,
    ):
        device["priority"] = rank

    source_cfg = normalize_source_storage(cfg)
    normalized_sources = normalize_source_list(source_cfg.get(CONF_SOURCE_FAVORITES, []))
    discovered_sources = normalize_source_list(source_cfg.get(CONF_LAST_DISCOVERED_SOURCES, []))
    known_source_ids = {source["id"] for source in normalized_sources + discovered_sources}
    hidden_source_ids = [
        str(item).strip()
        for item in source_cfg.get(CONF_HIDDEN_SOURCE_IDS, []) or []
        if str(item).strip()
    ]
    source_display_names = {
        str(key).strip(): str(value).strip()
        for key, value in (source_cfg.get(CONF_SOURCE_DISPLAY_NAMES, {}) or {}).items()
        if str(key).strip() and str(value).strip()
    }
    default_source_id = str(source_cfg.get(CONF_DEFAULT_SOURCE_ID) or "").strip()
    if default_source_id and default_source_id not in known_source_ids:
        default_source_id = ""

    valid_source_names = {source["Source"] for source in normalized_sources + discovered_sources}
    default_source_schedule = cfg.get("default_source_schedule")
    if default_source_schedule and default_source_schedule.get("source_name") not in valid_source_names:
        default_source_schedule = None

    normalized_cfg = {
        **cfg,
        "rooms": normalized_rooms,
        CONF_SOURCE_FAVORITES: normalized_sources,
        CONF_HIDDEN_SOURCE_IDS: hidden_source_ids,
        CONF_SOURCE_DISPLAY_NAMES: source_display_names,
        CONF_DEFAULT_SOURCE_ID: default_source_id or None,
        CONF_LAST_DISCOVERED_SOURCES: discovered_sources,
        "default_source_schedule": default_source_schedule,
    }
    normalized_cfg.pop("Sources", None)
    normalized_cfg.pop(CONF_FAVORITE_SOURCES, None)
    normalized_cfg.pop("ExcludedSources", None)
    normalized_cfg.pop(CONF_HOMEKIT_PLAYER, None)
    return normalized_cfg

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
    # YAML config is passed as the full config dict
    await _async_initialize_runtime(hass, config.get(DOMAIN, {}), is_yaml=True)

    if not hass.config_entries.async_entries(DOMAIN):
        # Legacy YAML mode: discover platforms directly.
        await async_load_platform(hass, 'sensor', DOMAIN, {}, config)
        await async_load_platform(hass, 'switch', DOMAIN, {}, config)
        await async_load_platform(hass, 'media_player', DOMAIN, {}, config)

    return True

def apply_config(hass: HomeAssistant, cfg: dict):
    """Apply validated configuration to hass.data."""
    try:
        cfg = sanitize_runtime_config(cfg)
    except vol.Invalid as err:
        _LOGGER.error("Configuration validation failed: %s", err)

    if DOMAIN not in hass.data:
        hass.data[DOMAIN] = {}

    rooms = cfg.get('rooms', [])

    hass.data[DOMAIN].update({
        'rooms': rooms,
        CONF_SOURCE_FAVORITES: cfg.get(CONF_SOURCE_FAVORITES, []),
        CONF_HIDDEN_SOURCE_IDS: cfg.get(CONF_HIDDEN_SOURCE_IDS, []),
        CONF_SOURCE_DISPLAY_NAMES: cfg.get(CONF_SOURCE_DISPLAY_NAMES, {}),
        CONF_DEFAULT_SOURCE_ID: cfg.get(CONF_DEFAULT_SOURCE_ID),
        CONF_LAST_DISCOVERED_SOURCES: cfg.get(CONF_LAST_DISCOVERED_SOURCES, []),
        'off_override': cfg.get(CONF_OFF_OVERRIDE, False),
        'create_sensors': cfg.get(CONF_CREATE_SENSORS, False),
        'default_on': cfg.get(CONF_DEFAULT_ON, False),
        'static_name': cfg.get(CONF_STATIC_NAME, ""),
        'disable_tv_source': cfg.get(CONF_DISABLE_TV_SOURCE, False),
        'interval_sync': cfg.get(CONF_INTERVAL_SYNC, 30),
        'schedule_entity': cfg.get(CONF_SCHEDULE_ENTITY),
        'default_source_schedule': cfg.get("default_source_schedule"),
        'batch_unjoin': cfg.get(CONF_BATCH_UNJOIN, False),
        'native_room_popup': cfg.get(CONF_NATIVE_ROOM_POPUP, True),
        'portal_media_player': cfg.get(CONF_PORTAL_MEDIA_PLAYER, "ha_default"),
    })
    hass.data['configured_rooms'] = [room.get('room') for room in rooms if room.get('room')]

async def _async_initialize_runtime(hass: HomeAssistant, config: dict, is_yaml: bool = False):
    """Initialize shared runtime state, storage, websocket endpoints, and panel."""
    # Ensure domain data exists
    if DOMAIN not in hass.data:
        hass.data[DOMAIN] = {}

    is_init = hass.data[DOMAIN].get("_runtime_initialized")

    # Track YAML config for migration/merging
    if is_yaml:
        hass.data[DOMAIN]["_yaml_config"] = config

    store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
    stored_config = await store.async_load()
    hass.data[DOMAIN]["store"] = store
    backup_store = Store(hass, STORAGE_VERSION, BACKUP_STORAGE_KEY)
    backup_config = await backup_store.async_load()
    hass.data[DOMAIN]["backup_store"] = backup_store

    if is_init:
        legacy_config = hass.data[DOMAIN].get("_yaml_config", {})
        entry_config = config if not is_yaml else {}
        active_config = stored_config if isinstance(stored_config, dict) else {}
        if not _config_has_user_data(active_config):
            if _config_has_user_data(legacy_config):
                _LOGGER.warning(
                    "AGS stored config is empty; restoring runtime config from YAML"
                )
                active_config = copy.deepcopy(legacy_config)
                await _async_save_config_with_backup(hass, active_config, store=store)
            elif _config_has_user_data(entry_config):
                _LOGGER.warning(
                    "AGS stored config is empty; restoring runtime config from config entry"
                )
                active_config = copy.deepcopy(entry_config)
                await _async_save_config_with_backup(hass, active_config, store=store)
            elif _config_has_user_data(backup_config):
                _LOGGER.warning(
                    "AGS stored config is empty; restoring runtime config from backup"
                )
                active_config = copy.deepcopy(backup_config)
                await _async_save_config_with_backup(hass, active_config, store=store)
        else:
            for fallback_name, fallback_config in (
                ("YAML", legacy_config),
                ("config entry", entry_config),
            ):
                if not _config_has_user_data(fallback_config):
                    continue
                active_config, merged = _merge_missing_config(
                    active_config,
                    fallback_config,
                )
                if merged:
                    _LOGGER.info(
                        "AGS: Merged missing %s settings into storage",
                        fallback_name,
                    )
                    await _async_save_config_with_backup(hass, active_config, store=store)

        active_config = sanitize_runtime_config(sync_linked_area_rooms(hass, active_config))
        await _async_save_config_with_backup(hass, active_config, store=store)
        hass.data[DOMAIN]["_stored_config_cache"] = copy.deepcopy(active_config)
        apply_config(hass, active_config)
        _remove_legacy_homekit_media_player(hass)
        return True

    legacy_config = hass.data[DOMAIN].get("_yaml_config", {})
    entry_config = config if not is_yaml else {}

    if not isinstance(stored_config, dict):
        if legacy_config:
            _LOGGER.info("Migrating legacy AGS configuration to JSON storage")
            stored_config = copy.deepcopy(legacy_config)
            await _async_save_config_with_backup(hass, stored_config, store=store)
        elif _config_has_user_data(entry_config):
            _LOGGER.info("Migrating AGS config entry data to JSON storage")
            stored_config = copy.deepcopy(entry_config)
            await _async_save_config_with_backup(hass, stored_config, store=store)
        elif _config_has_user_data(backup_config):
            _LOGGER.warning("Recovering AGS configuration from backup storage")
            stored_config = copy.deepcopy(backup_config)
            await _async_save_config_with_backup(hass, stored_config, store=store)
        else:
            # Entry data might have something if it's not a fresh install
            stored_config = config if not is_yaml else {}
            if not stored_config:
                stored_config = {
                    "rooms": [],
                    CONF_SOURCE_FAVORITES: [],
                    "off_override": False,
                    "create_sensors": True,
                }
    else:
        if not _config_has_user_data(stored_config):
            if _config_has_user_data(legacy_config):
                _LOGGER.warning(
                    "AGS stored config is empty; restoring from YAML instead of loading blank settings"
                )
                stored_config = copy.deepcopy(legacy_config)
                await _async_save_config_with_backup(hass, stored_config, store=store)
            elif _config_has_user_data(entry_config):
                _LOGGER.warning(
                    "AGS stored config is empty; restoring from config entry instead of loading blank settings"
                )
                stored_config = copy.deepcopy(entry_config)
                await _async_save_config_with_backup(hass, stored_config, store=store)
            elif _config_has_user_data(backup_config):
                _LOGGER.warning(
                    "AGS stored config is empty; restoring from backup instead of loading blank settings"
                )
                stored_config = copy.deepcopy(backup_config)
                await _async_save_config_with_backup(hass, stored_config, store=store)
        else:
            for fallback_config in (legacy_config, entry_config):
                if not _config_has_user_data(fallback_config):
                    continue
                stored_config, merged = _merge_missing_config(
                    stored_config,
                    fallback_config,
                )
                if merged:
                    await _async_save_config_with_backup(hass, stored_config, store=store)

    stored_config = sanitize_runtime_config(sync_linked_area_rooms(hass, stored_config))
    await _async_save_config_with_backup(hass, stored_config, store=store)
    apply_config(hass, stored_config)
    hass.data[DOMAIN]["_stored_config_cache"] = copy.deepcopy(stored_config)
    hass.data[DOMAIN]['apply_config'] = lambda cfg: apply_config(hass, cfg)
    _remove_legacy_homekit_media_player(hass)

    # Cancel existing action worker if it's already running (from a previous setup)
    if "action_worker" in hass.data[DOMAIN]:
        hass.data[DOMAIN]["action_worker"].cancel()

    # Initialize shared media action queue
    await ensure_action_queue(hass)

    # Initialize synchronization primitives used for sensor updates
    if "sensor_lock" not in hass.data[DOMAIN]:
        hass.data[DOMAIN]["sensor_lock"] = asyncio.Lock()
    if "status_handler_lock" not in hass.data[DOMAIN]:
        hass.data[DOMAIN]["status_handler_lock"] = asyncio.Lock()

    if not hass.data[DOMAIN].get("_frontend_registered"):
        # Register WebSocket API endpoints
        websocket_api.async_register_command(hass, ws_get_config)
        websocket_api.async_register_command(hass, ws_save_config)
        websocket_api.async_register_command(hass, ws_list_areas)
        websocket_api.async_register_command(hass, ws_get_logs)
        websocket_api.async_register_command(hass, ws_refresh_sources)

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
        add_extra_js_url(hass, f"/ags-static/ags-native-room-popup.js?v={FRONTEND_ASSET_VERSION}")
        hass.data[DOMAIN]["_frontend_registered"] = True

    hass.data[DOMAIN]["_runtime_initialized"] = True

    return True


async def async_setup_entry(hass: HomeAssistant, entry):
    """Set up AGS Service from a config entry."""
    await _async_initialize_runtime(hass, entry.data or {}, is_yaml=False)
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
    live_config = hass.data[DOMAIN]
    config_source = live_config.get("_stored_config_cache") or {
        "rooms": live_config.get("rooms", []),
        CONF_SOURCE_FAVORITES: live_config.get(CONF_SOURCE_FAVORITES, []),
        CONF_HIDDEN_SOURCE_IDS: live_config.get(CONF_HIDDEN_SOURCE_IDS, []),
        CONF_SOURCE_DISPLAY_NAMES: live_config.get(CONF_SOURCE_DISPLAY_NAMES, {}),
        CONF_DEFAULT_SOURCE_ID: live_config.get(CONF_DEFAULT_SOURCE_ID),
        CONF_LAST_DISCOVERED_SOURCES: live_config.get(CONF_LAST_DISCOVERED_SOURCES, []),
        "off_override": live_config.get("off_override", False),
        "create_sensors": live_config.get("create_sensors", False),
        "default_on": live_config.get("default_on", False),
        "static_name": live_config.get("static_name", ""),
        "disable_tv_source": live_config.get("disable_tv_source", False),
        "interval_sync": live_config.get("interval_sync", 30),
        "schedule_entity": live_config.get("schedule_entity", None),
        "default_source_schedule": live_config.get("default_source_schedule", None),
        "batch_unjoin": live_config.get("batch_unjoin", False),
        "native_room_popup": live_config.get("native_room_popup", True),
        "portal_media_player": live_config.get("portal_media_player", "ha_default"),
    }
    config = sync_linked_area_rooms(hass, config_source)
    config = sanitize_runtime_config(config)
    data = {
        "rooms": config.get("rooms", []),
        CONF_SOURCE_FAVORITES: config.get(CONF_SOURCE_FAVORITES, []),
        CONF_HIDDEN_SOURCE_IDS: config.get(CONF_HIDDEN_SOURCE_IDS, []),
        CONF_SOURCE_DISPLAY_NAMES: config.get(CONF_SOURCE_DISPLAY_NAMES, {}),
        CONF_DEFAULT_SOURCE_ID: config.get(CONF_DEFAULT_SOURCE_ID),
        CONF_LAST_DISCOVERED_SOURCES: config.get(CONF_LAST_DISCOVERED_SOURCES, []),
        "off_override": config.get("off_override", False),
        "create_sensors": config.get("create_sensors", False),
        "default_on": config.get("default_on", False),
        "static_name": config.get("static_name", ""),
        "disable_tv_source": config.get("disable_tv_source", False),
        "interval_sync": config.get("interval_sync", 30),
        "schedule_entity": config.get("schedule_entity", None),
        "default_source_schedule": config.get("default_source_schedule", None),
        "batch_unjoin": config.get("batch_unjoin", False),
        "native_room_popup": config.get("native_room_popup", True),
        "portal_media_player": config.get("portal_media_player", "ha_default"),
    }
    connection.send_result(msg["id"], data)

@websocket_api.websocket_command({
    vol.Required("type"): "ags_service/areas/list",
})
@callback
def ws_list_areas(hass, connection, msg):
    """Expose HA areas and media players for room import."""
    connection.send_result(msg["id"], {"areas": _get_ha_areas_with_media_players(hass)})

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
        validated_config = sync_linked_area_rooms(hass, validated_config)
        validated_config = sanitize_runtime_config(validated_config)
    except vol.Invalid as err:
        connection.send_error(msg["id"], "invalid_config", str(err))
        return

    existing_config = hass.data[DOMAIN].get("_stored_config_cache")
    yaml_config = hass.data[DOMAIN].get("_yaml_config")
    if (
        not _config_has_user_data(validated_config)
        and (
            _config_has_user_data(existing_config)
            or _config_has_user_data(yaml_config)
        )
        and not new_config.get("_allow_empty_config")
    ):
        connection.send_error(
            msg["id"],
            "empty_config_blocked",
            "Refusing to overwrite existing AGS rooms or sources with an empty config.",
        )
        return

    # Update live memory
    hass.data[DOMAIN]['apply_config'](validated_config)
    hass.data[DOMAIN]["source_list_revision"] = int(
        hass.data[DOMAIN].get("source_list_revision", 0) or 0
    ) + 1

    # Phase 2: Hot-Reload Engine
    # Signal entities to refresh themselves based on new config
    async_dispatcher_send(hass, SIGNAL_AGS_RELOAD)

    # Trigger storage save
    store = hass.data[DOMAIN]["store"]
    hass.async_create_task(
        _async_save_config_with_backup(hass, validated_config, store=store)
    )
    hass.data[DOMAIN]["_stored_config_cache"] = copy.deepcopy(validated_config)
    hass.async_create_task(update_ags_sensors(validated_config, hass))

    connection.send_result(msg["id"])

@websocket_api.websocket_command({
    vol.Required("type"): "ags_service/get_logs",
})
@callback
def ws_get_logs(hass, connection, msg):
    """Expose AGS specific logs via WebSocket."""
    connection.send_result(msg["id"], ags_log_handler.logs)

@websocket_api.websocket_command({
    vol.Required("type"): "ags_service/sources/refresh",
})
@callback
def ws_refresh_sources(hass, connection, msg):
    """Trigger AGS media-browser source discovery on demand."""
    media_player_entity = hass.data.get(DOMAIN, {}).get("media_player_entity")
    if media_player_entity is None or not hasattr(media_player_entity, "_async_refresh_source_inventory"):
        connection.send_error(
            msg["id"],
            "media_player_missing",
            "AGS media player entity is not ready.",
        )
        return

    async def _refresh():
        try:
            media_player_entity._source_inventory_enabled = True
            await media_player_entity._async_refresh_source_inventory(force=True)
            config = hass.data.get(DOMAIN, {})
            connection.send_result(
                msg["id"],
                {
                    "source_favorites": len(config.get(CONF_SOURCE_FAVORITES, []) or []),
                    "last_discovered_sources": len(config.get(CONF_LAST_DISCOVERED_SOURCES, []) or []),
                    "default_source_id": config.get(CONF_DEFAULT_SOURCE_ID),
                },
            )
        except Exception as err:
            connection.send_error(msg["id"], "refresh_failed", str(err))

    hass.async_create_task(_refresh())

async def async_unload_entry(hass, entry):
    """Unload a config entry and cancel background tasks."""
    # Unload platforms (sensor, switch, media_player)
    unload_ok = await hass.config_entries.async_unload_platforms(entry, ["sensor", "switch", "media_player"])
    return unload_ok
