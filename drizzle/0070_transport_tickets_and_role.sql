ALTER TABLE staff MODIFY COLUMN role enum('ADMIN','MANAGER','BARTENDER','SECURITY','PROMOTER','GENERAL_PROMOTER','TRANSPORTER') NOT NULL;
ALTER TABLE staff_invitations MODIFY COLUMN role enum('ADMIN','MANAGER','BARTENDER','SECURITY','PROMOTER','GENERAL_PROMOTER','TRANSPORTER') NOT NULL;

CREATE TABLE transport_tickets (
  id varchar(36) PRIMARY KEY,
  booking_id varchar(36) NOT NULL,
  unit_index int NOT NULL,
  tenant_id varchar(36) NOT NULL,
  event_id varchar(36) NOT NULL,
  customer_id varchar(36) NOT NULL,
  ticket_id varchar(36) NULL,
  buyer_name varchar(255) NOT NULL,
  buyer_dni varchar(20) NULL,
  buyer_phone varchar(255) NULL,
  qr_hash varchar(64) NOT NULL,
  status enum('PENDING','USED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  boarded_at timestamp NULL,
  boarded_by varchar(36) NULL,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  UNIQUE INDEX transport_tickets_booking_unit_unique (booking_id, unit_index),
  UNIQUE INDEX transport_tickets_ticket_unique (ticket_id),
  UNIQUE INDEX transport_tickets_qr_hash_unique (qr_hash),
  INDEX transport_tickets_owner_event_idx (customer_id, event_id),
  INDEX transport_tickets_event_tenant_idx (event_id, tenant_id),
  FOREIGN KEY (booking_id) REFERENCES sale_transports(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (boarded_by) REFERENCES staff(id)
);

ALTER TABLE ticket_transfers
  ADD COLUMN transport_ticket_id varchar(36) NULL,
  ADD INDEX ticket_transfers_transport_status_idx (transport_ticket_id, status),
  ADD FOREIGN KEY (transport_ticket_id) REFERENCES transport_tickets(id);
-- Existing completed bookings are materialized idempotently by the transport ticket helper.
-- Neither pending payments nor old localStorage check marks are treated as boarding proof.

CREATE TABLE transport_shares (
  id varchar(36) PRIMARY KEY, tenant_id varchar(36) NOT NULL, event_id varchar(36) NOT NULL,
  transport_id varchar(36) NOT NULL, owner_customer_id varchar(36) NOT NULL,
  token varchar(64) NOT NULL UNIQUE, cancelled_at timestamp NULL, created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  INDEX transport_shares_owner_event_idx (owner_customer_id, event_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id), FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (transport_id) REFERENCES event_transports(id), FOREIGN KEY (owner_customer_id) REFERENCES customers(id)
);
CREATE TABLE transport_transfers (
  id varchar(36) PRIMARY KEY, share_id varchar(36) NOT NULL, transport_ticket_id varchar(36) NOT NULL,
  from_customer_id varchar(36) NOT NULL, to_customer_id varchar(36) NULL, to_name varchar(255) NULL,
  position int NOT NULL, status enum('PENDING','CLAIMED','VOID') NOT NULL DEFAULT 'PENDING', claimed_at timestamp NULL,
  INDEX transport_transfers_share_status_idx (share_id, status),
  INDEX transport_transfers_ticket_status_idx (transport_ticket_id, status),
  UNIQUE INDEX transport_transfers_claimant_unique (share_id, to_customer_id),
  FOREIGN KEY (share_id) REFERENCES transport_shares(id), FOREIGN KEY (transport_ticket_id) REFERENCES transport_tickets(id),
  FOREIGN KEY (from_customer_id) REFERENCES customers(id), FOREIGN KEY (to_customer_id) REFERENCES customers(id)
);
