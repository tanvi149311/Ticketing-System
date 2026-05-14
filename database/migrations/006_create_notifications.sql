-- ============================================================
-- Migration: 006_create_notifications.sql
-- Description: Creates notifications table for email
--              and in-app alerts
-- Author: Tanvi Pawale
-- ============================================================

-- ── Notifications Table ───────────────────────────────────────
CREATE TABLE notifications (
    notification_id  NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id          NUMBER                               NOT NULL,
    type             VARCHAR2(50)                         NOT NULL,
    title            VARCHAR2(255)                        NOT NULL,
    message          VARCHAR2(1000)                       NOT NULL,

    -- Links notification back to the relevant record
    reference_type   VARCHAR2(20),   -- 'TICKET' or 'ASSET'
    reference_id     NUMBER,

    is_read          NUMBER(1)       DEFAULT 0            NOT NULL,
    read_at          TIMESTAMP,

    -- Email delivery tracking
    email_sent       NUMBER(1)       DEFAULT 0            NOT NULL,
    email_sent_at    TIMESTAMP,

    created_at       TIMESTAMP       DEFAULT CURRENT_TIMESTAMP NOT NULL,

    CONSTRAINT fk_notif_user      FOREIGN KEY (user_id)
                                  REFERENCES users (user_id),
    CONSTRAINT chk_notif_is_read  CHECK (is_read IN (0, 1)),
    CONSTRAINT chk_notif_email    CHECK (email_sent IN (0, 1)),
    CONSTRAINT chk_notif_ref_type CHECK (reference_type IN (
        'TICKET',
        'ASSET',
        'USER',
        'SYSTEM'
    )),
    CONSTRAINT chk_notif_type     CHECK (type IN (
        'TICKET_ASSIGNED',
        'TICKET_STATUS_CHANGED',
        'TICKET_COMMENTED',
        'ASSET_ASSIGNED',
        'ASSET_STATUS_CHANGED',
        'ASSET_REQUESTED',
        'ASSET_DEPLOYED',
        'ASSET_RELEASED',
        'SYSTEM_ALERT'
    ))
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX idx_notif_user_id   ON notifications (user_id);
CREATE INDEX idx_notif_is_read   ON notifications (is_read);
CREATE INDEX idx_notif_type      ON notifications (type);
CREATE INDEX idx_notif_ref       ON notifications (reference_type, reference_id);

-- ── Comments ──────────────────────────────────────────────────
COMMENT ON TABLE  notifications              IS 'In-app and email notifications';
COMMENT ON COLUMN notifications.type         IS 'Type of notification event';
COMMENT ON COLUMN notifications.reference_id IS 'ID of the related ticket or asset';
