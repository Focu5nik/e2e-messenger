import uuid
from typing import Annotated, TypeAlias

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentPrincipal
from app.auth.models import User
from app.auth.schemas import UserResponse
from app.chats.schemas import ChatResponse
from app.chats.service import (
    ChatNotFoundError,
    ChatService,
    DirectChatView,
    SelfChatError,
    TargetUserNotFoundError,
)
from app.database import get_session


router = APIRouter()
DatabaseSession: TypeAlias = Annotated[AsyncSession, Depends(get_session)]


def chat_service() -> ChatService:
    return ChatService()


Service: TypeAlias = Annotated[ChatService, Depends(chat_service)]


def user_response(user: User) -> UserResponse:
    return UserResponse.model_validate(user)


def chat_response(view: DirectChatView) -> ChatResponse:
    return ChatResponse(
        id=view.chat.id,
        type="DIRECT",
        created_at=view.chat.created_at,
        other_user=user_response(view.other_user),
    )


@router.get("/users", response_model=list[UserResponse])
async def search_users(
    principal: CurrentPrincipal,
    session: DatabaseSession,
    service: Service,
    search: Annotated[str, Query(max_length=64)] = "",
) -> list[UserResponse]:
    users = await service.search_users(session, principal.user_id, search)
    return [user_response(user) for user in users]


@router.post("/chats/direct/{user_id}", response_model=ChatResponse)
async def open_direct_chat(
    user_id: uuid.UUID,
    principal: CurrentPrincipal,
    session: DatabaseSession,
    service: Service,
) -> ChatResponse:
    try:
        view = await service.open_direct_chat(session, principal.user_id, user_id)
    except SelfChatError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="cannot create a direct chat with yourself",
        ) from exc
    except TargetUserNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="user not found",
        ) from exc
    except ChatNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="chat not found",
        ) from exc
    return chat_response(view)


@router.get("/chats", response_model=list[ChatResponse])
async def list_chats(
    principal: CurrentPrincipal,
    session: DatabaseSession,
    service: Service,
) -> list[ChatResponse]:
    views = await service.list_direct_chats(session, principal.user_id)
    return [chat_response(view) for view in views]


@router.get("/chats/{chat_id}", response_model=ChatResponse)
async def get_chat(
    chat_id: uuid.UUID,
    principal: CurrentPrincipal,
    session: DatabaseSession,
    service: Service,
) -> ChatResponse:
    try:
        view = await service.get_direct_chat(session, principal.user_id, chat_id)
    except ChatNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="chat not found",
        ) from exc
    return chat_response(view)
