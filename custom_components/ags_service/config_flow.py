"""Config flow for AGS Service."""

from homeassistant import config_entries

from . import DOMAIN


class AGSServiceConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Minimal config flow so existing AGS config entries load cleanly."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Handle the initial step."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        # Try to import from YAML if available to pre-populate the UI entry
        yaml_config = self.hass.data.get(DOMAIN, {})
        entry_data = {}
        if yaml_config and "rooms" in yaml_config:
            # We can't easily extract the exact raw YAML here,
            # but __init__.py will handle the migration if entry data is empty.
            pass

        return self.async_create_entry(title="AGS Service", data=entry_data)
