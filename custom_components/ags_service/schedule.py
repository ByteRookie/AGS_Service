"""Schedule entity for AGS Service."""
from __future__ import annotations

import datetime as dt

# Import ScheduleEntity from the schedule component. In Home Assistant the
# entity class is defined in ``homeassistant.components.schedule.entity`` rather
# than being exported directly from the component package.
from homeassistant.components.schedule.entity import ScheduleEntity
from homeassistant.helpers.restore_state import RestoreEntity


async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    """Set up the AGS schedule entity."""
    async_add_entities([AGSScheduleEntity(hass)])


class AGSScheduleEntity(ScheduleEntity, RestoreEntity):
    """Simple schedule entity controlling AGS operation."""

    _attr_name = "AGS Schedule"
    _attr_unique_id = "ags_schedule"
    _attr_icon = "mdi:calendar-clock"

    def __init__(self, hass):
        self.hass = hass
        # default schedule: always on
        self._schedule = [
            {
                "from": dt.time(0, 0, 0),
                "to": dt.time(23, 59, 59),
            }
        ]
        self._is_on = True
        # initialize value in hass.data so other modules can read it
        self.hass.data[self._attr_unique_id] = self._is_on

    @property
    def schedule(self):
        return self._schedule

    @property
    def is_on(self):
        return self._is_on

    async def async_turn_on(self, **kwargs):
        self._is_on = True
        self.hass.data[self._attr_unique_id] = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs):
        self._is_on = False
        self.hass.data[self._attr_unique_id] = False
        self.async_write_ha_state()

    async def async_added_to_hass(self):
        await super().async_added_to_hass()
        last_state = await self.async_get_last_state()
        if last_state:
            self._is_on = last_state.state == "on"
        self.hass.data[self._attr_unique_id] = self._is_on
