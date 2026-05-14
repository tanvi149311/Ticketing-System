-- ============================================================
-- Migration: 004_create_comments.sql
-- Description: Creates ticket comments and attachments tables
-- Author: Tanvi Pawale
-- ============================================================

-- ── Ticket Comments ───────────────────────────────────────────
CREATE TABLE ticket_comments (
    comment_id      NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id       NUMBER                               NOT NULL,
    user_id         NUMBER                               NOT NULL,
    comment         CLOB                                 NOT NULL,
    is_edited       NUMBER(1)      DEFAULT 0             NOT NULL,
    edited_at       TIMESTAMP,
    created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,

    CONSTRAINT fk_tc_ticket    FOREIGN KEY (ticket_id)
                               REFERENCES tickets (ticket_id),
    CONSTRAINT fk_tc_user      FOREIGN KEY (user_id)
                               REFERENCES users (user_id),
    CONSTRAINT chk_tc_edited   CHECK (is_edited IN (0, 1))
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX idx_tc_ticket_id ON ticket_comments (ticket_id);
CREATE INDEX idx_tc_user_id   ON ticket_comments (user_id);

-- ── Comments ──────────────────────────────────────────────────
COMMENT ON TABLE ticket_comments IS 'Comments and activity on tickets';
