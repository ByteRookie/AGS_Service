"""Config flow for AGS Service."""
from __future__ import annotations

import json
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import area_registry
from homeassistant.helpers.selector import selector

from .const import (
    DOMAIN,
    CONF_ROOMS,
    CONF_ROOM,
    CONF_DEVICE_ID,
    CONF_DEVICE_NAME,
    CONF_DEVICE_TYPE,
    CONF_PRIORITY,
    CONF_OVERRIDE_CONTENT,
    CONF_SOURCES,
    CONF_SOURCE,
    CONF_SOURCE_VALUE,
    CONF_MEDIA_CONTENT_TYPE,
    CONF_SOURCE_DEFAULT,
    CONF_DISABLE_ZONE,
    CONF_PRIMARY_DELAY,
    CONF_HOMEKIT_PLAYER,
    CONF_CREATE_SENSORS,
    CONF_DEFAULT_ON,
    CONF_STATIC_NAME,
    CONF_DISABLE_TV_SOURCE,
    CONF_ADD_ANOTHER,
    CONF_SORT_BY,
)


TOTAL_STEPS = 5


class AGSServiceConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for AGS Service."""

    VERSION = 1

    def __init__(self) -> None:
        self.data: dict = {}
        self.rooms: list = []
        self.sources: list = []
        self.sort_by: str = "priority"
        self._used_priorities: set[int] = set()

    def _resort_devices(self):
        """Sort stored device lists according to current sort order."""
        if self.sort_by == "priority":
            for room in self.rooms:
                room["devices"].sort(key=lambda d: d[CONF_PRIORITY])
        else:
            self.rooms.sort(key=lambda r: r[CONF_ROOM])

    def _all_devices(self):
        """Return list of (room, device) tuples."""
        return [(room, d) for room in self.rooms for d in room["devices"]]

    def _all_devices_sorted(self):
        devices = self._all_devices()
        if self.sort_by == "priority":
            devices.sort(key=lambda pair: pair[1][CONF_PRIORITY])
        else:
            devices.sort(key=lambda pair: pair[0][CONF_ROOM])
        return devices

    def _update_used_priorities(self):
        self._used_priorities = {
            d[CONF_PRIORITY] for _, d in self._all_devices()
        }

    def _summary(self) -> str:
        """Return formatted JSON summary of rooms and sources."""
        rooms = [
            {**room, "devices": sorted(room["devices"], key=lambda d: d[CONF_PRIORITY])}
            for room in self.rooms
        ]
        if self.sort_by == "room":
            rooms.sort(key=lambda r: r[CONF_ROOM])
        elif self.sort_by == "priority":
            rooms.sort(key=lambda r: r["devices"][0][CONF_PRIORITY] if r["devices"] else 0)
        summary = {"rooms": rooms, "sources": self.sources}
        return json.dumps(summary, indent=2)

    def _progress(self, step: int) -> str:
        return f"Step {step}/{TOTAL_STEPS}"

    async def async_step_user(self, user_input=None):
        """Start the flow or handle YAML import."""
        if user_input is not None and isinstance(user_input.get(CONF_ROOMS), list):
            return self.async_create_entry(title="AGS Service", data=user_input)

        return await self.async_step_select_rooms()

    async def async_step_select_rooms(self, user_input=None):
        """Select all rooms using area selector."""
        if user_input is not None:
            room_ids = user_input.get(CONF_ROOMS)
            if not isinstance(room_ids, list):
                room_ids = [room_ids]
            reg = area_registry.async_get(self.hass)
            self.rooms = []
            for rid in room_ids:
                area = reg.async_get_area(rid)
                name = area.name if area else rid
                self.rooms.append({CONF_ROOM: name, "devices": []})
            self._resort_devices()
            return await self.async_step_manage_devices()

        schema = vol.Schema({vol.Required(CONF_ROOMS): selector({"area": {"multiple": True}})})
        return self.async_show_form(
            step_id="select_rooms",
            data_schema=schema,
            description_placeholders={
                "summary": self._summary(),
                "progress": self._progress(1),
            },
        )

    async def async_step_manage_devices(self, user_input=None):
        """Manage the list of devices."""
        if user_input is not None:
            self.sort_by = user_input.get(CONF_SORT_BY, self.sort_by)
            self._resort_devices()
            action = user_input.get("action")
            if action == "add":
                return await self.async_step_add_device()
            if action == "remove":
                index = user_input.get("index", 0)
                devices = self._all_devices_sorted()
                if 0 <= index < len(devices):
                    room, device = devices[index]
                    room["devices"].remove(device)
                    self._update_used_priorities()
                    self._resort_devices()
                return await self.async_step_manage_devices()
            return await self.async_step_manage_sources()

        actions = ["add", "done"]
        total = sum(len(r["devices"]) for r in self.rooms)
        if total:
            actions.insert(1, "remove")
        schema = vol.Schema(
            {
                vol.Required("action"): vol.In(actions),
                vol.Optional("index", default=0): int,
                vol.Optional(CONF_SORT_BY, default=self.sort_by): vol.In(["priority", "room"]),
            }
        )
        return self.async_show_form(
            step_id="manage_devices",
            data_schema=schema,
            description_placeholders={
                "summary": self._summary(),
                "progress": self._progress(2),
            },
        )

    async def async_step_add_device(self, user_input=None):
        """Add a device entry."""
        errors = {}
        if user_input is not None:
            priority = user_input[CONF_PRIORITY]
            entity_id = user_input[CONF_DEVICE_ID]
            state = self.hass.states.get(entity_id)
            name = state.name if state else entity_id
            # Shift priorities if needed
            for r, dev in self._all_devices_sorted():
                if dev[CONF_PRIORITY] >= priority:
                    dev[CONF_PRIORITY] += 1
            device = {
                CONF_DEVICE_ID: entity_id,
                CONF_DEVICE_NAME: name,
                CONF_DEVICE_TYPE: user_input[CONF_DEVICE_TYPE],
                CONF_PRIORITY: priority,
            }
            if user_input.get(CONF_OVERRIDE_CONTENT):
                device[CONF_OVERRIDE_CONTENT] = user_input[CONF_OVERRIDE_CONTENT]
            room_name = user_input[CONF_ROOM]
            for room in self.rooms:
                if room[CONF_ROOM] == room_name:
                    room["devices"].append(device)
                    break
            self._update_used_priorities()
            self._resort_devices()
            if user_input.get(CONF_ADD_ANOTHER, False):
                return await self.async_step_add_device()
            return await self.async_step_manage_devices()

        room_names = [r[CONF_ROOM] for r in self.rooms]
        total_devices = len(self._all_devices())
        priority_options = list(range(1, total_devices + 2))
        schema = vol.Schema(
            {
                vol.Required(CONF_ROOM): vol.In(room_names),
                vol.Required(CONF_DEVICE_ID): selector({"entity": {"domain": "media_player"}}),
                vol.Required(CONF_DEVICE_TYPE): vol.In(["tv", "speaker"]),
                vol.Required(CONF_PRIORITY, default=total_devices + 1): vol.In(priority_options),
                vol.Optional(CONF_OVERRIDE_CONTENT): str,
                vol.Optional(CONF_ADD_ANOTHER, default=False): bool,
            }
        )
        return self.async_show_form(
            step_id="add_device",
            data_schema=schema,
            description_placeholders={
                "summary": self._summary(),
                "progress": self._progress(2),
            },
            errors=errors,
        )

    async def async_step_manage_sources(self, user_input=None):
        """Manage the list of sources."""
        if user_input is not None:
            action = user_input.get("action")
            if action == "add":
                return await self.async_step_add_source()
            if action == "remove":
                index = user_input.get("index", 0)
                if 0 <= index < len(self.sources):
                    self.sources.pop(index)
                return await self.async_step_manage_sources()
            return await self.async_step_options()

        actions = ["add", "done"]
        if self.sources:
            actions.insert(1, "remove")
        schema = vol.Schema(
            {
                vol.Required("action"): vol.In(actions),
                vol.Optional("index", default=0): int,
            }
        )
        return self.async_show_form(
            step_id="manage_sources",
            data_schema=schema,
            description_placeholders={
                "summary": self._summary(),
                "progress": self._progress(3),
            },
        )

    async def async_step_add_source(self, user_input=None):
        """Add playback sources."""
        if user_input is not None:
            add_more = user_input.pop(CONF_SOURCE_DEFAULT, False)
            source = {
                CONF_SOURCE: user_input[CONF_SOURCE],
                CONF_SOURCE_VALUE: user_input[CONF_SOURCE_VALUE],
                CONF_MEDIA_CONTENT_TYPE: user_input[CONF_MEDIA_CONTENT_TYPE],
                CONF_SOURCE_DEFAULT: add_more,
            }
            self.sources.append(source)
            if user_input.get("add_another"):
                return await self.async_step_add_source()
            return await self.async_step_manage_sources()

        schema = vol.Schema(
            {
                vol.Required(CONF_SOURCE): str,
                vol.Required(CONF_SOURCE_VALUE): str,
                vol.Required(CONF_MEDIA_CONTENT_TYPE): str,
                vol.Optional(CONF_SOURCE_DEFAULT, default=False): bool,
                vol.Optional("add_another", default=False): bool,
            }
        )
        return self.async_show_form(
            step_id="add_source",
            data_schema=schema,
            description_placeholders={
                "summary": self._summary(),
                "progress": self._progress(3),
            },
        )

    async def async_step_options(self, user_input=None):
        """Collect global options."""
        if user_input is not None:
            self.data = {
                CONF_DISABLE_ZONE: user_input.get(CONF_DISABLE_ZONE, False),
                CONF_PRIMARY_DELAY: user_input.get(CONF_PRIMARY_DELAY, 5),
                CONF_HOMEKIT_PLAYER: user_input.get(CONF_HOMEKIT_PLAYER),
                CONF_CREATE_SENSORS: user_input.get(CONF_CREATE_SENSORS, False),
                CONF_DEFAULT_ON: user_input.get(CONF_DEFAULT_ON, False),
                CONF_STATIC_NAME: user_input.get(CONF_STATIC_NAME),
                CONF_DISABLE_TV_SOURCE: user_input.get(CONF_DISABLE_TV_SOURCE, False),
            }
            return await self.async_step_summary()

        schema = vol.Schema(
            {
                vol.Optional(CONF_DISABLE_ZONE, default=False): bool,
                vol.Optional(CONF_PRIMARY_DELAY, default=5): int,
                vol.Optional(CONF_HOMEKIT_PLAYER): selector({"entity": {"domain": "media_player"}}),
                vol.Optional(CONF_CREATE_SENSORS, default=False): bool,
                vol.Optional(CONF_DEFAULT_ON, default=False): bool,
                vol.Optional(CONF_STATIC_NAME, default=""): str,
                vol.Optional(CONF_DISABLE_TV_SOURCE, default=False): bool,
            }
        )
        return self.async_show_form(
            step_id="options",
            data_schema=schema,
            description_placeholders={
                "summary": self._summary(),
                "progress": self._progress(4),
            },
        )

    async def async_step_summary(self, user_input=None):
        """Show a summary before creating the entry."""
        if user_input is not None:
            if user_input.get("add_room"):
                return await self.async_step_select_rooms()
            if user_input.get("add_device"):
                return await self.async_step_manage_devices()
            data = {**self.data, CONF_ROOMS: self.rooms, CONF_SOURCES: self.sources}
            return self.async_create_entry(title="AGS Service", data=data)

        summary = json.dumps({"rooms": self.rooms, "sources": self.sources}, indent=2)
        return self.async_show_form(
            step_id="summary",
            description_placeholders={
                "summary": summary,
                "progress": self._progress(5),
            },
            data_schema=vol.Schema(
                {
                    vol.Optional("add_room", default=False): bool,
                    vol.Optional("add_device", default=False): bool,
                }
            ),
        )


    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return AGSServiceOptionsFlowHandler(config_entry)


class AGSServiceOptionsFlowHandler(config_entries.OptionsFlow):
    """Handle options for config entry."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self.config_entry = config_entry

    async def async_step_init(self, user_input=None):
        errors = {}
        if user_input is not None:
            try:
                rooms = json.loads(user_input[CONF_ROOMS])
                sources = json.loads(user_input[CONF_SOURCES])
            except Exception:
                errors["base"] = "invalid_json"
            else:
                data = {
                    CONF_ROOMS: rooms,
                    CONF_SOURCES: sources,
                    CONF_DISABLE_ZONE: user_input.get(CONF_DISABLE_ZONE, False),
                    CONF_PRIMARY_DELAY: user_input.get(CONF_PRIMARY_DELAY, 5),
                    CONF_HOMEKIT_PLAYER: user_input.get(CONF_HOMEKIT_PLAYER),
                    CONF_CREATE_SENSORS: user_input.get(CONF_CREATE_SENSORS, False),
                    CONF_DEFAULT_ON: user_input.get(CONF_DEFAULT_ON, False),
                    CONF_STATIC_NAME: user_input.get(CONF_STATIC_NAME),
                    CONF_DISABLE_TV_SOURCE: user_input.get(CONF_DISABLE_TV_SOURCE, False),
                }
                return self.async_create_entry(title="", data=data)

        current = self.config_entry.data
        data_schema = vol.Schema(
            {
                vol.Required(CONF_ROOMS, default=current.get(CONF_ROOMS, [])): str,
                vol.Required(CONF_SOURCES, default=current.get(CONF_SOURCES, [])): str,
                vol.Optional(CONF_DISABLE_ZONE, default=current.get(CONF_DISABLE_ZONE, False)): bool,
                vol.Optional(CONF_PRIMARY_DELAY, default=current.get(CONF_PRIMARY_DELAY, 5)): int,
                vol.Optional(CONF_HOMEKIT_PLAYER, default=current.get(CONF_HOMEKIT_PLAYER, "")): selector({"entity": {"domain": "media_player"}}),
                vol.Optional(CONF_CREATE_SENSORS, default=current.get(CONF_CREATE_SENSORS, False)): bool,
                vol.Optional(CONF_DEFAULT_ON, default=current.get(CONF_DEFAULT_ON, False)): bool,
                vol.Optional(CONF_STATIC_NAME, default=current.get(CONF_STATIC_NAME, "")): str,
                vol.Optional(CONF_DISABLE_TV_SOURCE, default=current.get(CONF_DISABLE_TV_SOURCE, False)): bool,
            }
        )
        return self.async_show_form(step_id="init", data_schema=data_schema, errors=errors)
