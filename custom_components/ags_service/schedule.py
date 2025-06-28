"""Schedule entity for AGS Service."""

from __future__ import annotations

import datetime as dt
from typing import Any

# Import the native Schedule helper from Home Assistant.  The class is simply
# called ``Schedule`` and lives directly in ``homeassistant.components.schedule``.
# Home Assistant exposes a ``Schedule`` entity type via the ``schedule`` helper
# integration. The base class handles all on/off transitions based on defined
# time blocks. Importing it directly allows us to subclass it for AGS.
# Import the native Schedule helper.  Depending on the Home Assistant release
# the class may be exposed as ``Schedule`` directly or via ``ScheduleEntity``.
try:
    # Newer versions expose ``Schedule``
    from homeassistant.components.schedule import Schedule
except ImportError:  # pragma: no cover - older core releases
    # Older versions expose ``ScheduleEntity`` which is functionally
    # equivalent.  Alias it so the rest of the code can remain the same.
    from homeassistant.components.schedule import ScheduleEntity as Schedule
from homeassistant.helpers.restore_state import RestoreEntity


def ags_schedule_enabled(hass) -> bool:
    """Return True if the AGS schedule allows playback."""
    # When the schedule entity hasn't been configured with any time blocks we
    # treat it as always on.  The state of the entity is cached in ``hass.data``
    # under its unique ID.
    configured = hass.data.get("ags_schedule_configured", False)
    state = hass.data.get("ags_schedule", True)
    if not configured:
        return True
    return state


async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    """Set up the AGS schedule entity."""
    async_add_entities([AGSSchedule(hass)])


class AGSSchedule(Schedule, RestoreEntity):
    """Schedule controlling AGS operation."""

    _attr_name = "AGS Schedule"
    _attr_unique_id = "ags_schedule"
    _attr_icon = "mdi:calendar-clock"

    def __init__(self, hass) -> None:
        """Initialize with an empty schedule."""
        self.hass = hass
        # The default configuration has no time blocks. ``Schedule`` treats an
        # empty schedule as always off, but AGS interprets an empty schedule as
        # "no schedule" meaning AGS is always allowed to run. We therefore
        # generate a dictionary for each weekday with an empty list of time
        # blocks.  The schedule integration expects keys named after the days of
        # the week.
        days = [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
        ]
        default_schedule = {day: [] for day in days}

        # Build the configuration dictionary expected by ``Schedule``. The
        # helper's schema requires a name and icon along with entries for each
        # weekday, even if those lists are empty.
        config = {"name": self._attr_name, "icon": self._attr_icon, **default_schedule}

        # Initialise the base ``Schedule`` class.  The constructor signature
        # changed in different Home Assistant versions, so try both patterns
        # for maximum compatibility.
        try:
            Schedule.__init__(self, hass, config)
        except TypeError:
            # Older/newer releases only expect the configuration dictionary
            # without the ``hass`` parameter.
            Schedule.__init__(self, config)

        # RestoreEntity also needs initialisation so its state can be recovered
        # after Home Assistant restarts.
        RestoreEntity.__init__(self)

        # Track whether the schedule actually has any blocks defined. This flag
        # allows the rest of the integration to treat an empty schedule as
        # "always on" rather than always off.
        self.hass.data[f"{self._attr_unique_id}_configured"] = any(
            default_schedule.values()
        )

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

    async def async_write_ha_state(self) -> None:  # type: ignore[override]
        """Extend to mirror state in ``hass.data`` for other modules."""
        self.hass.data[self._attr_unique_id] = self.is_on
        await super().async_write_ha_state()

    async def async_added_to_hass(self) -> None:
        """Restore the previous state and share it via ``hass.data``."""
        await super().async_added_to_hass()
        self.hass.data[self._attr_unique_id] = self.is_on
