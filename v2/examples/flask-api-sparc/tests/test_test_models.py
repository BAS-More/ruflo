import pytest
from src.models import User, Product


class TestUserModel:
    def test_create_user(self):
        """Test user creation with valid data"""
        user = User(username="testuser", email="test@example.com")
        assert user.username == "testuser"
        assert user.email == "test@example.com"
        assert user.id is None  # Not saved yet

    def test_user_validation(self):
        """Test user validation rules"""
        with pytest.raises(ValueError):
            User(username="", email="invalid-email")

    def test_user_serialization(self):
        """Test user to dict conversion"""
        user = User(username="testuser", email="test@example.com")
        data = user.to_dict()
        assert data["username"] == "testuser"
        assert "password" not in data  # Should not expose password
        assert "password_hash" not in data
        assert data["created_at"] is None
        assert data["updated_at"] is None

    @pytest.mark.parametrize("username", ["", "   ", None, "x" * 81])
    def test_invalid_username(self, username):
        with pytest.raises(ValueError):
            User(username=username, email="test@example.com")

    @pytest.mark.parametrize(
        "email", ["invalid-email", "@example.com", "test@", "a@@b", "a @b", None]
    )
    def test_invalid_email(self, email):
        with pytest.raises(ValueError):
            User(username="testuser", email=email)

    def test_password_hash(self):
        user = User(username="testuser", email="test@example.com")
        user.set_password("test-only-password")
        assert user.check_password("test-only-password")
        assert not user.check_password("wrong")
        assert len(user.password_hash) <= User.password_hash.type.length
        assert "password_hash" not in user.to_dict()


class TestProductModel:
    def test_create_product(self):
        """Test product creation"""
        product = Product(name="Test Product", price=99.99)
        assert product.name == "Test Product"
        assert product.price == 99.99
        assert product.to_dict()["created_at"] is None
