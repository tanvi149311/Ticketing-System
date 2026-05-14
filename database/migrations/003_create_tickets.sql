-- ============================================================
-- Migration: 003_create_tickets.sql
-- Description: Creates tickets table for Kanban board
--              with full workflow state management
-- Author: Tanvi Pawale
-- ============================================================

-- ── Tickets Table ─────────────────────────────────────────────
CREATE TABLE tickets (
    ticket_id       NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Auto-generated human-readable ticket number
    ticket_number   VARCHAR2(20)                         NOT NULL,
    title           VARCHAR2(255)                        NOT NULL,
    description     CLOB,

    -- Kanban workflow status
    -- Backlog: unassigned | In Progress: assigned & active
    -- On Hold: paused | Complete: asset released & done
    status          VARCHAR2(20)   DEFAULT 'BACKLOG'     NOT NULL,

    priority        VARCHAR2(10)   DEFAULT 'MEDIUM'      NOT NULL,

    -- Assignment — can be individual or team
    assigned_to     NUMBER,        -- FK to users
    assigned_team   NUMBER,        -- FK to teams
    asset_id        NUMBER,        -- FK to assets

    -- Dates
    due_date        DATE,
    started_at      TIMESTAMP,
    completed_at    TIMESTAMP,
    on_hold_at      TIMESTAMP,

    -- Location context
    site_name       VARCHAR2(100),
    location        VARCHAR2(255),

    -- Ownership
    created_by      NUMBER                               NOT NULL,
    updated_by      NUMBER,

    created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,

    -- Constraints
    CONSTRAINT uq_tickets_number      UNIQUE (ticket_number),
    CONSTRAINT chk_tickets_status     CHECK  (status IN (
        'BACKLOG',
        'IN_PROGRESS',
        'ON_HOLD',
        'COMPLETE'
    )),
    CONSTRAINT chk_tickets_priority   CHECK  (priority IN (
        'LOW',
        'MEDIUM',
        'HIGH',
        'CRITICAL'
    )),
    CONSTRAINT fk_tickets_assigned_to   FOREIGN KEY (assigned_to)
                                        REFERENCES users (user_id),
    CONSTRAINT fk_tickets_assigned_team FOREIGN KEY (assigned_team)
                                        REFERENCES teams (team_id),
    CONSTRAINT fk_tickets_asset         FOREIGN KEY (asset_id)
                                        REFERENCES assets (asset_id),
    CONSTRAINT fk_tickets_created_by    FOREIGN KEY (created_by)
                                        REFERENCES users (user_id),
    CONSTRAINT fk_tickets_updated_by    FOREIGN KEY (updated_by)
                                        REFERENCES users (user_id)
);

-- ── Ticket Number Sequence ────────────────────────────────────
-- Generates TKT-000001, TKT-000002 etc.
CREATE SEQUENCE seq_ticket_number START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE OR REPLACE TRIGGER trg_ticket_number
    BEFORE INSERT ON tickets
    FOR EACH ROW
BEGIN
    :NEW.ticket_number := 'TKT-' || LPAD(seq_ticket_number.NEXTVAL, 6, '0');
END;
/

-- ── Ticket Status History ─────────────────────────────────────
-- Every status change is recorded for full audit trail
CREATE TABLE ticket_status_history (
    history_id      NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id       NUMBER                               NOT NULL,
    old_status      VARCHAR2(20),
    new_status      VARCHAR2(20)                         NOT NULL,
    changed_by      NUMBER                               NOT NULL,
    change_reason   VARCHAR2(500),
    changed_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,

    CONSTRAINT fk_tsh_ticket     FOREIGN KEY (ticket_id)
                                 REFERENCES tickets (ticket_id),
    CONSTRAINT fk_tsh_changed_by FOREIGN KEY (changed_by)
                                 REFERENCES users (user_id)
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX idx_tickets_status       ON tickets (status);
CREATE INDEX idx_tickets_assigned_to  ON tickets (assigned_to);
CREATE INDEX idx_tickets_assigned_team ON tickets (assigned_team);
CREATE INDEX idx_tickets_asset_id     ON tickets (asset_id);
CREATE INDEX idx_tickets_priority     ON tickets (priority);
CREATE INDEX idx_tickets_created_by   ON tickets (created_by);
CREATE INDEX idx_tsh_ticket_id        ON ticket_status_history (ticket_id);

-- ── Audit Trigger ─────────────────────────────────────────────
CREATE OR REPLACE TRIGGER trg_tickets_updated_at
    BEFORE UPDATE ON tickets
    FOR EACH ROW
BEGIN
    :NEW.updated_at := CURRENT_TIMESTAMP;
    :NEW.updated_by := :NEW.updated_by;
END;
/

-- ── Comments ──────────────────────────────────────────────────
COMMENT ON TABLE  tickets             IS 'Kanban tickets for asset deployment workflows';
COMMENT ON COLUMN tickets.status      IS 'BACKLOG | IN_PROGRESS | ON_HOLD | COMPLETE';
COMMENT ON COLUMN tickets.priority    IS 'LOW | MEDIUM | HIGH | CRITICAL';
COMMENT ON COLUMN tickets.ticket_number IS 'Auto-generated: TKT-000001 format';
COMMENT ON TABLE  ticket_status_history IS 'Full audit trail of every ticket status change';
