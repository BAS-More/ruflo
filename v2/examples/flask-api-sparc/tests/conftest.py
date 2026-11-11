from unittest.mock import patch

import pytest

# Tests own their configuration and never load developer .env files.
with patch("dotenv.load_dotenv"):
    from src.app import create_app
from src.models import db


@pytest.fixture
def app():
    app = create_app("testing")
    with app.app_context():
        db.create_all()
        yield app
        db.session.remove()
        db.drop_all()


@pytest.fixture
def client(app):
    return app.test_client()
