import pytest


def test_import_homeassistant():
    pytest.importorskip("homeassistant")
