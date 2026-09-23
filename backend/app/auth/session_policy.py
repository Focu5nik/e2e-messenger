from datetime import UTC, datetime

from app.auth.models import AuthSession, Device, User


def is_expired(value: datetime) -> bool:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value <= datetime.now(UTC)


def is_session_active(
    user: User, device: Device, auth_session: AuthSession
) -> bool:
    return (
        user.status == "active"
        and device.revoked_at is None
        and auth_session.revoked_at is None
        and auth_session.refresh_cookie_bound
        and not is_expired(auth_session.refresh_expires_at)
    )
