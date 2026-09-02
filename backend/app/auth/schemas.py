import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


def normalize_username(value: str) -> str:
    return value.strip().casefold()


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=128)

    @field_validator("username")
    @classmethod
    def normalized_username(cls, value: str) -> str:
        return normalize_username(value)


class RegisterRequest(Credentials):
    pass


class LoginRequest(Credentials):
    device_id: uuid.UUID
    device_name: str = Field(min_length=1, max_length=100)

    @field_validator("device_name")
    @classmethod
    def clean_device_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("device_name must not be blank")
        return cleaned


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    status: str
    created_at: datetime


class MeResponse(UserResponse):
    device_id: uuid.UUID
    session_id: uuid.UUID


class DeviceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    protocol_version: int
    created_at: datetime
    last_seen_at: datetime
    revoked_at: datetime | None
    is_current: bool
