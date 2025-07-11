"""Configuration flow for AGS Service."""

from __future__ import annotations

import yaml
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback

from . import (
    DOMAIN,
    DEVICE_SCHEMA,
    CONF_ROOMS,
    CONF_SOURCES,
)


class AGSServiceConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for AGS Service."""

    VERSION = 1

    def _validate(self, data: dict) -> dict:
        """Validate configuration using the same schema as YAML."""

        validated = DEVICE_SCHEMA(data)
        return validated

    async def async_step_user(self, user_input: dict | None = None):
        errors = {}

        if user_input is not None:
            try:
                rooms = yaml.safe_load(user_input[CONF_ROOMS])
                sources = yaml.safe_load(user_input[CONF_SOURCES])

                data = {CONF_ROOMS: rooms, CONF_SOURCES: sources}

                if user_input.get("username"):
                    data["username"] = user_input["username"]
                if user_input.get("password"):
                    data["password"] = user_input["password"]

                self._validate(data)
            except Exception:  # pragma: no cover - validation
                errors["base"] = "invalid_config"
            else:
                return self.async_create_entry(title="AGS Service", data=data)

        data_schema = vol.Schema(
            {
                vol.Required(CONF_ROOMS): str,
                vol.Required(CONF_SOURCES): str,
                vol.Optional("username"): str,
                vol.Optional("password"): str,
            }
        )

        return self.async_show_form(step_id="user", data_schema=data_schema, errors=errors)

    @callback
    def async_step_import(self, data: dict):
        """Handle import from configuration.yaml."""

        return self.async_create_entry(title="AGS Service", data=data)

