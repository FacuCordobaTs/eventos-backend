-- Aplicar antes de desplegar el backend/POS con cola offline.
-- Aditiva: conserva la respuesta de cada operación junto con la venta en la misma transacción.
CREATE TABLE `pos_sale_requests` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `staff_id` varchar(36) NOT NULL,
  `payload_hash` varchar(64) NOT NULL,
  `response` json DEFAULT NULL,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `pos_sale_requests_tenant_idx` (`tenant_id`),
  CONSTRAINT `pos_sale_requests_tenant_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
);
