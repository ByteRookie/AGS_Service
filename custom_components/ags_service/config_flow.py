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
)


class AGSServiceConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for AGS Service."""

    VERSION = 1

    def __init__(self) -> None:
        self.data: dict = {}
        self.rooms: list = []
        self.sources: list = []
        self._room_ids: list[str] = []
        self._current_room_id: str | None = None
        self._current_room: dict | None = None
        self._device_ids: list[str] = []
        self._device_index: int = 0

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
            self._room_ids = room_ids
            return await self.async_step_next_room()

        schema = vol.Schema({vol.Required(CONF_ROOMS): selector({"area": {"multiple": True}})})
        return self.async_show_form(step_id="select_rooms", data_schema=schema)

    async def async_step_next_room(self, user_input=None):
        """Configure the next room in the list."""
        if not self._room_ids:
            return await self.async_step_add_source()

        self._current_room_id = self._room_ids.pop(0)
        reg = area_registry.async_get(self.hass)
        area = reg.async_get_area(self._current_room_id)
        name = area.name if area else self._current_room_id
        self._current_room = {CONF_ROOM: name, "devices": []}
        return await self.async_step_select_devices()

    async def async_step_select_devices(self, user_input=None):
        """Select all devices for the current room."""
        if user_input is not None:
            device_ids = user_input.get(CONF_DEVICE_ID)
            if not isinstance(device_ids, list):
                device_ids = [device_ids]
            self._device_ids = device_ids
            self._device_index = 0
            return await self.async_step_device_details()

        schema = vol.Schema({vol.Required(CONF_DEVICE_ID): selector({"entity": {"domain": "media_player", "multiple": True}})})
        return self.async_show_form(step_id="select_devices", data_schema=schema, description_placeholders={"room": self._current_room[CONF_ROOM]})

    async def async_step_device_details(self, user_input=None):
        """Collect details for each selected device."""
        if user_input is not None:
            entity_id = self._device_ids[self._device_index]
            state = self.hass.states.get(entity_id)
            name = state.name if state else entity_id
            device = {
                CONF_DEVICE_ID: entity_id,
                CONF_DEVICE_NAME: name,
                CONF_DEVICE_TYPE: user_input[CONF_DEVICE_TYPE],
                CONF_PRIORITY: user_input[CONF_PRIORITY],
            }
            if user_input.get(CONF_OVERRIDE_CONTENT):
                device[CONF_OVERRIDE_CONTENT] = user_input[CONF_OVERRIDE_CONTENT]
            self._current_room["devices"].append(device)
            self._device_index += 1

        if self._device_index < len(self._device_ids):
            entity_id = self._device_ids[self._device_index]
            state = self.hass.states.get(entity_id)
            name = state.name if state else entity_id
            schema = vol.Schema(
                {
                    vol.Required(CONF_DEVICE_TYPE): vol.In(["tv", "speaker"]),
                    vol.Required(CONF_PRIORITY): int,
                    vol.Optional(CONF_OVERRIDE_CONTENT): str,
                }
            )
            return self.async_show_form(
                step_id="device_details",
                data_schema=schema,
                description_placeholders={"device": name, "room": self._current_room[CONF_ROOM]},
            )

        # all devices handled for this room
        self.rooms.append(self._current_room)
        self._current_room = None
        self._device_ids = []
        self._device_index = 0
        return await self.async_step_next_room()

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
            return await self.async_step_options()

        schema = vol.Schema(
            {
                vol.Required(CONF_SOURCE): str,
                vol.Required(CONF_SOURCE_VALUE): str,
                vol.Required(CONF_MEDIA_CONTENT_TYPE): str,
                vol.Optional(CONF_SOURCE_DEFAULT, default=False): bool,
                vol.Optional("add_another", default=False): bool,
            }
        )
        return self.async_show_form(step_id="add_source", data_schema=schema)

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
        return self.async_show_form(step_id="options", data_schema=schema)

    async def async_step_summary(self, user_input=None):
        """Show a summary before creating the entry."""
        if user_input is not None:
            data = {**self.data, CONF_ROOMS: self.rooms, CONF_SOURCES: self.sources}
            return self.async_create_entry(title="AGS Service", data=data)

        summary = json.dumps({"rooms": self.rooms, "sources": self.sources}, indent=2)
        return self.async_show_form(
            step_id="summary",
            description_placeholders={"summary": summary},
            data_schema=vol.Schema({}),
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
