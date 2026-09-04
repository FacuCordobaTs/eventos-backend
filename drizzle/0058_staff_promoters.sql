-- Un promotor pasa a ser un integrante operativo del staff con acceso propio.
-- Se conserva la tabla promoters previa para no perder atribuciones históricas.
ALTER TABLE `staff`
  MODIFY COLUMN `role` enum('ADMIN','MANAGER','BARTENDER','SECURITY','PROMOTER') NOT NULL;

ALTER TABLE `staff_invitations`
  MODIFY COLUMN `role` enum('ADMIN','MANAGER','BARTENDER','SECURITY','PROMOTER') NOT NULL;

ALTER TABLE `promoters`
  ADD COLUMN `staff_id` varchar(36) NULL,
  ADD CONSTRAINT `promoters_staff_id_staff_id_fk`
    FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX `promoters_staff_id_unique` ON `promoters` (`staff_id`);
