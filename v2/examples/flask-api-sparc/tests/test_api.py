from datetime import datetime

from src.models import db, User


def test_health_and_empty_lists(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json["status"] == "healthy"
    assert client.get("/api/users").json["users"] == []
    assert client.get("/api/products").json == []


def test_user_crud_with_persistence(client):
    response = client.post(
        "/api/users",
        json={
            "username": "alice",
            "email": "alice@example.com",
            "password": "test-only-password",
        },
    )
    assert response.status_code == 201
    user_id = response.json["id"]
    datetime.fromisoformat(response.json["created_at"])
    datetime.fromisoformat(response.json["updated_at"])
    assert "password_hash" not in response.json
    assert "password" not in response.json
    db.session.expire_all()
    assert db.session.get(User, user_id).check_password("test-only-password")
    assert client.get(f"/api/users/{user_id}").json["username"] == "alice"
    assert client.get("/api/users?page=1&per_page=1").json["total"] == 1

    response = client.put(
        f"/api/users/{user_id}",
        json={
            "username": "alice-updated",
            "email": "new@example.com",
            "password": "new-test-password",
        },
    )
    assert response.status_code == 200
    assert response.json["username"] == "alice-updated"
    db.session.expire_all()
    assert db.session.get(User, user_id).check_password("new-test-password")
    assert client.delete(f"/api/users/{user_id}").status_code == 204
    assert client.get(f"/api/users/{user_id}").status_code == 404


def test_invalid_and_duplicate_users(client):
    assert client.post("/api/users", json={}).status_code == 400
    assert (
        client.post(
            "/api/users", json={"username": "alice", "email": "invalid"}
        ).status_code
        == 400
    )
    valid = {"username": "alice", "email": "alice@example.com"}
    response = client.post("/api/users", json=valid)
    user_id = response.json["id"]
    assert client.post("/api/users", json=valid).status_code == 409
    response = client.put(
        f"/api/users/{user_id}", json={"username": "changed", "email": "invalid"}
    )
    assert response.status_code == 400
    # A failed update must not leave a partially modified ORM object behind.
    assert client.get(f"/api/users/{user_id}").json["username"] == "alice"


def test_products_and_service_update(client):
    from src.models import Product
    from src.services import ProductService

    response = client.post("/api/products", json={"name": "Widget", "price": 12.5})
    assert response.status_code == 201
    assert response.json["stock"] == 0
    datetime.fromisoformat(response.json["created_at"])
    product = db.session.get(Product, response.json["id"])
    ProductService().update_product(
        product,
        {"name": "Updated", "description": "Description", "price": 10.0, "stock": 5},
    )
    listed = client.get("/api/products").json
    assert len(listed) == 1
    assert listed[0]["name"] == "Updated"
    assert listed[0]["stock"] == 5
    assert listed[0]["price"] == 10.0
