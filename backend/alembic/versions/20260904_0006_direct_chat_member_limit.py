"""Enforce the direct-chat member limit.

Revision ID: 20260904_0006
Revises: 20260903_0005
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260904_0006"
down_revision: str | None = "20260903_0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM chats
                    JOIN chat_members ON chat_members.chat_id = chats.id
                    WHERE chats.type = 'DIRECT'
                    GROUP BY chats.id
                    HAVING count(*) > 2
                ) THEN
                    RAISE EXCEPTION USING
                        ERRCODE = '23514',
                        MESSAGE = 'A direct chat has more than two members';
                END IF;
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE FUNCTION enforce_direct_chat_member_limit()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            DECLARE
                chat_type text;
                old_chat_type text;
                member_count bigint;
            BEGIN
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.chat_id = NEW.chat_id AND OLD.user_id = NEW.user_id THEN
                        RETURN NEW;
                    END IF;

                    SELECT type
                    INTO old_chat_type
                    FROM chats
                    WHERE id = OLD.chat_id
                    FOR UPDATE;

                    IF old_chat_type = 'DIRECT' THEN
                        RAISE EXCEPTION USING
                            ERRCODE = '23514',
                            MESSAGE = 'Direct chat membership keys cannot be changed';
                    END IF;
                END IF;

                SELECT type
                INTO chat_type
                FROM chats
                WHERE id = NEW.chat_id
                FOR UPDATE;

                IF chat_type = 'DIRECT' THEN
                    SELECT count(*)
                    INTO member_count
                    FROM chat_members
                    WHERE chat_id = NEW.chat_id;

                    IF member_count >= 2 THEN
                        RAISE EXCEPTION USING
                            ERRCODE = '23514',
                            MESSAGE = 'A direct chat cannot have more than two members';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_enforce_direct_chat_member_limit
            BEFORE INSERT OR UPDATE OF chat_id, user_id ON chat_members
            FOR EACH ROW
            EXECUTE FUNCTION enforce_direct_chat_member_limit()
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            DROP TRIGGER trg_enforce_direct_chat_member_limit ON chat_members
            """
        )
    )
    op.execute(sa.text("DROP FUNCTION enforce_direct_chat_member_limit()"))
