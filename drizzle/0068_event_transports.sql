CREATE TABLE event_transports (
  id varchar(36) PRIMARY KEY,
  tenant_id varchar(36) NOT NULL,
  event_id varchar(36) NOT NULL,
  name varchar(255) NOT NULL,
  address varchar(500) NOT NULL,
  latitude decimal(10,7) NOT NULL,
  longitude decimal(10,7) NOT NULL,
  price decimal(10,2) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  INDEX event_transports_event_tenant_idx (event_id, tenant_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE sale_transports (
  id varchar(36) PRIMARY KEY,
  sale_id varchar(36) NOT NULL,
  transport_id varchar(36) NOT NULL,
  tenant_id varchar(36) NOT NULL,
  event_id varchar(36) NOT NULL,
  name varchar(255) NOT NULL,
  address varchar(500) NOT NULL,
  latitude decimal(10,7) NOT NULL,
  longitude decimal(10,7) NOT NULL,
  quantity int NOT NULL,
  price_at_time decimal(10,2) NOT NULL,
  UNIQUE INDEX sale_transports_sale_transport_unique (sale_id, transport_id),
  INDEX sale_transports_event_tenant_idx (event_id, tenant_id),
  FOREIGN KEY (sale_id) REFERENCES sales(id),
  FOREIGN KEY (transport_id) REFERENCES event_transports(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (event_id) REFERENCES events(id)
);
