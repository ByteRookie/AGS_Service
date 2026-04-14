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

        return self.async_create_entry(title="AGS Service", data={})
