-- ============================================================
-- Migration: 005_create_audit_log.sql
-- Description: System-wide audit log for all asset movements
--              and critical actions
-- Author: Tanvi Pawale
-- ============================================================

-- ── Asset Audit Log ───────────────────────────────────────────
-- Records every asset status change and movement
CREATE TABLE asset_audit_log (
    log_id          NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    asset_id        NUMBER                               NOT NULL,
    ticket_id       NUMBER,
    action          VARCHAR2(50)                         NOT NULL,
    old_status      VARCHAR2(30),
    new_status      VARCHAR2(30),
    old_assigned_to NUMBER,
    new_assigned_to NUMBER,
    changed_by      NUMBER                               NOT NULL,
    notes           VARCHAR2(500),
    changed_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,

    CONSTRAINT fk_aal_asset          FOREIGN KEY (asset_id)
                                     REFERENCES assets (asset_id),
    CONSTRAINT fk_aal_ticket         FOREIGN KEY (ticket_id)
                                     REFERENCES tickets (ticket_id),
    CONSTRAINT fk_aal_changed_by     FOREIGN KEY (changed_by)
                                     REFERENCES users (user_id),
    CONSTRAINT fk_aal_old_assigned   FOREIGN KEY (old_assigned_to)
                                     REFERENCES users (user_id),
    CONSTRAINT fk_aal_new_assigned   FOREIGN KEY (new_assigned_to)
                                     REFERENCES users (user_id),
    CONSTRAINT chk_aal_action        CHECK (action IN (
        'STATUS_CHANGE',
        'ASSIGNMENT_CHANGE',
        'LOCATION_CHANGE',
        'CREATED',
        'RETIRED',
        'MAINTENANCE_START',
        'MAINTENANCE_END'
    ))
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX idx_aal_asset_id    ON asset_audit_log (asset_id);
CREATE INDEX idx_aal_ticket_id   ON asset_audit_log (ticket_id);
CREATE INDEX idx_aal_changed_by  ON asset_audit_log (changed_by);
CREATE INDEX idx_aal_changed_at  ON asset_audit_log (changed_at);

-- ── Comments ──────────────────────────────────────────────────
COMMENT ON TABLE  asset_audit_log         IS 'Full audit trail of all asset movements and changes';
COMMENT ON COLUMN asset_audit_log.action  IS 'STATUS_CHANGE | ASSIGNMENT_CHANGE | LOCATION_CHANGE | CREATED | RETIRED';
