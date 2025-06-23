"""Config flow for AGS Service."""
from __future__ import annotations

import json
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers.selector import selector

from .const import (
    DOMAIN,
    CONF_ROOMS,
    CONF_ROOM,
    CONF_DEVICE_ID,
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
)


class AGSServiceConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for AGS Service."""

    VERSION = 1

    def __init__(self) -> None:
        self.data: dict = {}
        self.rooms: list = []
        self.sources: list = []
        self._current_room: dict | None = None

    async def async_step_user(self, user_input=None):
        """Handle the initial step or YAML import."""
        if user_input is not None:
            # If called via YAML import the structure will already contain lists
            if isinstance(user_input.get(CONF_ROOMS), list):
                return self.async_create_entry(title="AGS Service", data=user_input)

            self.data = {
                CONF_DISABLE_ZONE: user_input.get(CONF_DISABLE_ZONE, False),
                CONF_PRIMARY_DELAY: user_input.get(CONF_PRIMARY_DELAY, 5),
                CONF_HOMEKIT_PLAYER: user_input.get(CONF_HOMEKIT_PLAYER),
                CONF_CREATE_SENSORS: user_input.get(CONF_CREATE_SENSORS, False),
                CONF_DEFAULT_ON: user_input.get(CONF_DEFAULT_ON, False),
                CONF_STATIC_NAME: user_input.get(CONF_STATIC_NAME),
                CONF_DISABLE_TV_SOURCE: user_input.get(CONF_DISABLE_TV_SOURCE, False),
            }
            return await self.async_step_add_room()

        data_schema = vol.Schema(
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
        return self.async_show_form(step_id="user", data_schema=data_schema)

    async def async_step_add_room(self, user_input=None):
        """Add a room to the configuration."""
        if user_input is not None:
            self._current_room = {CONF_ROOM: user_input[CONF_ROOM], "devices": []}
            return await self.async_step_add_device()

        schema = vol.Schema({vol.Required(CONF_ROOM): selector({"area": {}})})
        return self.async_show_form(step_id="add_room", data_schema=schema)

    async def async_step_add_device(self, user_input=None):
        """Add a device to the current room."""
        if user_input is not None and self._current_room is not None:
            add_more = user_input.pop(CONF_ADD_ANOTHER)
            device = {
                CONF_DEVICE_ID: user_input[CONF_DEVICE_ID],
                CONF_DEVICE_TYPE: user_input[CONF_DEVICE_TYPE],
                CONF_PRIORITY: user_input[CONF_PRIORITY],
            }
            if user_input.get(CONF_OVERRIDE_CONTENT):
                device[CONF_OVERRIDE_CONTENT] = user_input[CONF_OVERRIDE_CONTENT]
            self._current_room["devices"].append(device)
            if add_more:
                return await self.async_step_add_device()

            self.rooms.append(self._current_room)
            self._current_room = None
            return await self.async_step_more_rooms()

        schema = vol.Schema(
            {
                vol.Required(CONF_DEVICE_ID): selector({"entity": {"domain": "media_player"}}),
                vol.Required(CONF_DEVICE_TYPE): vol.In(["tv", "speaker"]),
                vol.Required(CONF_PRIORITY): int,
                vol.Optional(CONF_OVERRIDE_CONTENT): str,
                vol.Optional(CONF_ADD_ANOTHER, default=False): bool,
            }
        )
        return self.async_show_form(step_id="add_device", data_schema=schema)

    async def async_step_more_rooms(self, user_input=None):
        """Ask whether to add another room."""
        if user_input is not None:
            if user_input[CONF_ADD_ANOTHER]:
                return await self.async_step_add_room()
            return await self.async_step_add_source()

        schema = vol.Schema({vol.Required(CONF_ADD_ANOTHER, default=False): bool})
        return self.async_show_form(step_id="more_rooms", data_schema=schema)

    async def async_step_add_source(self, user_input=None):
        """Add playback sources."""
        if user_input is not None:
            add_more = user_input.pop(CONF_ADD_ANOTHER)
            source = {
                CONF_SOURCE: user_input[CONF_SOURCE],
                CONF_SOURCE_VALUE: user_input[CONF_SOURCE_VALUE],
                CONF_MEDIA_CONTENT_TYPE: user_input[CONF_MEDIA_CONTENT_TYPE],
                CONF_SOURCE_DEFAULT: user_input.get(CONF_SOURCE_DEFAULT, False),
            }
            self.sources.append(source)
            if add_more:
                return await self.async_step_add_source()

            data = {
                **self.data,
                CONF_ROOMS: self.rooms,
                CONF_SOURCES: self.sources,
            }
            return self.async_create_entry(title="AGS Service", data=data)

        schema = vol.Schema(
            {
                vol.Required(CONF_SOURCE): str,
                vol.Required(CONF_SOURCE_VALUE): str,
                vol.Required(CONF_MEDIA_CONTENT_TYPE): str,
                vol.Optional(CONF_SOURCE_DEFAULT, default=False): bool,
                vol.Optional(CONF_ADD_ANOTHER, default=False): bool,
            }
        )
        return self.async_show_form(step_id="add_source", data_schema=schema)

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

