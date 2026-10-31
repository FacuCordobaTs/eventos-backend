-- Depósito del evento y rol encargado de stock.
-- Aditiva: amplía los enums existentes sin renombrar valores y crea el libro de movimientos.
-- El stock disponible en depósito no se materializa: se deriva de
-- event_inventory.stock_allocated menos la suma de bar_inventory.current_stock.

ALTER TABLE `staff`
  MODIFY COLUMN `role` ENUM(
    'ADMIN',
    'MANAGER',
    'BARTENDER',
    'SECURITY',
    'PROMOTER',
    'GENERAL_PROMOTER',
    'TRANSPORTER',
    'DEPOSIT'
  ) NOT NULL;

ALTER TABLE `staff_invitations`
  MODIFY COLUMN `role` ENUM(
    'ADMIN',
    'MANAGER',
    'BARTENDER',
    'SECURITY',
    'PROMOTER',
    'GENERAL_PROMOTER',
    'TRANSPORTER',
    'DEPOSIT'
  ) NOT NULL;

CREATE TABLE IF NOT EXISTS `event_stock_movements` (
  `id` VARCHAR(36) NOT NULL,
  `tenant_id` VARCHAR(36) NOT NULL,
  `event_id` VARCHAR(36) NOT NULL,
  `inventory_item_id` VARCHAR(36) NOT NULL,
  `bar_id` VARCHAR(36) NULL,
  `type` ENUM('DEPOSIT_IN', 'DEPOSIT_COUNT', 'SEND_TO_BAR') NOT NULL,
  `quantity` DECIMAL(16, 6) NOT NULL,
  `deposit_after` DECIMAL(16, 6) NOT NULL,
  `bar_after` DECIMAL(16, 6) NULL,
  `note` VARCHAR(255) NULL,
  `created_by` VARCHAR(36) NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `event_stock_movements_event_created_idx` (`event_id`, `created_at`),
  KEY `event_stock_movements_tenant_idx` (`tenant_id`),
  KEY `event_stock_movements_bar_idx` (`bar_id`),
  CONSTRAINT `event_stock_movements_tenant_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `event_stock_movements_event_fk` FOREIGN KEY (`event_id`) REFERENCES `events` (`id`),
  CONSTRAINT `event_stock_movements_item_fk` FOREIGN KEY (`inventory_item_id`) REFERENCES `inventory_items` (`id`),
  CONSTRAINT `event_stock_movements_bar_fk` FOREIGN KEY (`bar_id`) REFERENCES `bars` (`id`),
  CONSTRAINT `event_stock_movements_staff_fk` FOREIGN KEY (`created_by`) REFERENCES `staff` (`id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
