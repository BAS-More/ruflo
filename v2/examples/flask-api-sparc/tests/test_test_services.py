import pytest
from unittest.mock import patch
from src.services import UserService, ProductService
from src.models import db, User


class TestUserService:
    @pytest.fixture
    def user_service(self):
        return UserService()

    def test_create_user_success(self, user_service):
        """Test successful user creation"""
        user_data = {"username": "newuser", "email": "new@example.com"}
        with patch("src.services.db") as mock_db:
            user = user_service.create_user(user_data)
            assert user.username == "newuser"
            mock_db.session.add.assert_called_once()

    def test_get_user_by_id(self, user_service, app):
        """Test retrieving user by ID"""
        saved = user_service.create_user(
            {"username": "testuser", "email": "test@example.com"}
        )
        saved_id = saved.id
        db.session.expire_all()
        user = user_service.get_user(saved_id)
        assert user.id == saved_id
        assert user.username == "testuser"
        assert user_service.get_user(saved_id + 1) is None
