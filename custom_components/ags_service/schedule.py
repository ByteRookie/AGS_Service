"""Schedule entity for AGS Service."""
from __future__ import annotations

import datetime as dt
from typing import Any

# Import the native Schedule helper from Home Assistant.  The class is simply
# called ``Schedule`` and lives directly in ``homeassistant.components.schedule``.
from homeassistant.components.schedule import Schedule
from homeassistant.helpers.restore_state import RestoreEntity


async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    """Set up the AGS schedule entity."""
    async_add_entities([AGSSchedule(hass)])


class AGSSchedule(Schedule, RestoreEntity):
    """Schedule controlling AGS operation."""

    _attr_name = "AGS Schedule"
    _attr_unique_id = "ags_schedule"
    _attr_icon = "mdi:calendar-clock"

    def __init__(self, hass) -> None:
        """Initialize with a default always-on schedule."""
        self.hass = hass
        # Default schedule covers the entire day so AGS is enabled unless the
        # user turns this entity off.  The built-in ``Schedule`` helper will
        # handle toggling the entity state based on these blocks.
        default_schedule = [{"from": dt.time(0, 0, 0), "to": dt.time(23, 59, 59)}]

        # Initialise the base ``Schedule`` with our default blocks
        super().__init__(hass, default_schedule)

        # Expose the current state via hass.data for use in update_ags_status
        self.hass.data[self._attr_unique_id] = self.is_on

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Enable AGS operation."""
        await super().async_turn_on(**kwargs)
        self.hass.data[self._attr_unique_id] = True

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Disable AGS operation except for overrides."""
        await super().async_turn_off(**kwargs)
        self.hass.data[self._attr_unique_id] = False

    async def async_added_to_hass(self) -> None:
        """Restore the previous state and share it via ``hass.data``."""
        await super().async_added_to_hass()
        self.hass.data[self._attr_unique_id] = self.is_on
