from typing import Annotated, TypeAlias

from fastapi import Depends
from starlette.requests import HTTPConnection

from app.messages.service import MessageService


def message_service(connection: HTTPConnection) -> MessageService:
    return MessageService(event_bus=connection.app.state.event_bus)


Service: TypeAlias = Annotated[MessageService, Depends(message_service)]
