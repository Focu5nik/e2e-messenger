import uuid
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from app.auth.dependencies import CurrentPrincipal
from app.auth.schemas import UserResponse
from app.chats.dependencies import DatabaseSession, ReadService, Service
from app.chats.errors import ChatNotFoundError, SelfChatError, TargetUserNotFoundError
from app.chats.responses import chat_response, chat_states_response, user_response
from app.chats.schemas import ChatResponse, ChatStatesPageResponse


router = APIRouter()


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


@router.get("/chats/states", response_model=ChatStatesPageResponse)
async def chat_states(
    principal: CurrentPrincipal,
    session: DatabaseSession,
    service: ReadService,
    after_chat_id: uuid.UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
) -> ChatStatesPageResponse:
    page = await service.page(session, principal, after_chat_id, limit)
    return chat_states_response(page)


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
