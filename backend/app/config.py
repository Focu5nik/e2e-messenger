from functools import lru_cache

from pydantic import AnyHttpUrl, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://messenger:messenger@localhost:5433/messenger"
    frontend_origin: AnyHttpUrl = "http://localhost:5173"
    jwt_secret: SecretStr = Field(min_length=32)
    access_token_ttl_minutes: int = Field(default=15, ge=1, le=60)
    refresh_token_ttl_days: int = Field(default=30, ge=1, le=365)

    @field_validator("frontend_origin")
    @classmethod
    def validate_frontend_origin(cls, value: AnyHttpUrl) -> AnyHttpUrl:
        if (
            value.username is not None
            or value.password is not None
            or value.path not in (None, "", "/")
            or value.query is not None
            or value.fragment is not None
        ):
            raise ValueError("frontend_origin must contain only scheme, host, and port")
        return value

    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
