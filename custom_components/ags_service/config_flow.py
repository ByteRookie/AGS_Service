import json
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback

from .const import (
    DOMAIN,
    CONF_ROOMS,
    CONF_SOURCES,
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

    async def async_step_user(self, user_input=None):
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
                return self.async_create_entry(title="AGS Service", data=data)

        data_schema = vol.Schema(
            {
                vol.Required(CONF_ROOMS): str,
                vol.Required(CONF_SOURCES): str,
                vol.Optional(CONF_DISABLE_ZONE, default=False): bool,
                vol.Optional(CONF_PRIMARY_DELAY, default=5): int,
                vol.Optional(CONF_HOMEKIT_PLAYER, default=""): str,
                vol.Optional(CONF_CREATE_SENSORS, default=False): bool,
                vol.Optional(CONF_DEFAULT_ON, default=False): bool,
                vol.Optional(CONF_STATIC_NAME, default=""): str,
                vol.Optional(CONF_DISABLE_TV_SOURCE, default=False): bool,
            }
        )
        return self.async_show_form(step_id="user", data_schema=data_schema, errors=errors)

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
                vol.Required(CONF_ROOMS, default=json.dumps(current.get(CONF_ROOMS, []))): str,
                vol.Required(CONF_SOURCES, default=json.dumps(current.get(CONF_SOURCES, []))): str,
                vol.Optional(CONF_DISABLE_ZONE, default=current.get(CONF_DISABLE_ZONE, False)): bool,
                vol.Optional(CONF_PRIMARY_DELAY, default=current.get(CONF_PRIMARY_DELAY, 5)): int,
                vol.Optional(CONF_HOMEKIT_PLAYER, default=current.get(CONF_HOMEKIT_PLAYER, "")): str,
                vol.Optional(CONF_CREATE_SENSORS, default=current.get(CONF_CREATE_SENSORS, False)): bool,
                vol.Optional(CONF_DEFAULT_ON, default=current.get(CONF_DEFAULT_ON, False)): bool,
                vol.Optional(CONF_STATIC_NAME, default=current.get(CONF_STATIC_NAME, "")): str,
                vol.Optional(CONF_DISABLE_TV_SOURCE, default=current.get(CONF_DISABLE_TV_SOURCE, False)): bool,
            }
        )
        return self.async_show_form(step_id="init", data_schema=data_schema, errors=errors)
