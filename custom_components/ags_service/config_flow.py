from __future__ import annotations

import yaml
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback

from .const import DOMAIN, DEVICE_SCHEMA


class AGSServiceConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for AGS Service."""

    VERSION = 1

    def __init__(self) -> None:
        self._errors: dict[str, str] = {}

    async def async_step_user(self, user_input: dict | None = None):
        """Handle the initial step."""
        if user_input is not None:
            try:
                data = yaml.safe_load(user_input["configuration"])
                DEVICE_SCHEMA(data)
            except Exception:
                self._errors["base"] = "invalid_yaml"
            else:
                return self.async_create_entry(title="AGS Service", data=data)
        data_schema = vol.Schema({vol.Required("configuration"): str})
        return self.async_show_form(
            step_id="user", data_schema=data_schema, errors=self._errors
        )

    async def async_step_import(self, user_input: dict):
        """Import from YAML."""
        try:
            DEVICE_SCHEMA(user_input)
        except Exception:
            return self.async_abort(reason="invalid_import")
        return self.async_create_entry(title="AGS Service", data=user_input)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: config_entries.ConfigEntry):
        return AGSServiceOptionsFlow(config_entry)


class AGSServiceOptionsFlow(config_entries.OptionsFlow):
    """Handle options."""

    def __init__(self, entry: config_entries.ConfigEntry) -> None:
        self.config_entry = entry
        self._errors: dict[str, str] = {}

    async def async_step_init(self, user_input: dict | None = None):
        if user_input is not None:
            try:
                data = yaml.safe_load(user_input["configuration"])
                DEVICE_SCHEMA(data)
            except Exception:
                self._errors["base"] = "invalid_yaml"
            else:
                return self.async_create_entry(data=data)
        current = yaml.safe_dump(dict(self.config_entry.data))
        data_schema = vol.Schema({vol.Required("configuration", default=current): str})
        return self.async_show_form(
            step_id="init", data_schema=data_schema, errors=self._errors
        )
