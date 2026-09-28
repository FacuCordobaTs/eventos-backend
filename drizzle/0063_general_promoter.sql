-- Promotor general: un staff que coordina promotores dentro de un evento.
--
-- Entra por su link de invitación como cualquier empleado y su superficie queda acotada a los
-- eventos a los que fue asignado (`event_staff`) y, adentro de cada uno, a los promotores que él
-- mismo dio de alta: crea (por invitación) y elimina (baja lógica) únicamente promotores.
--
-- `promoters.owner_staff_id` es esa pertenencia: la cuenta del promotor general que invitó al
-- promotor. NULL = promotor de la productora (lo creó un admin), que ningún promotor general ve
-- ni administra. No es un permiso por sí sola: cada endpoint valida rol + tenant + pertenencia.
--
-- El enum se extiende agregando el valor AL FINAL para que los ordinales existentes (1..5) no
-- cambien y las filas actuales conserven su rol.
-- Aplicar antes de desplegar el backend.
ALTER TABLE `staff`
  MODIFY COLUMN `role` enum('ADMIN','MANAGER','BARTENDER','SECURITY','PROMOTER','GENERAL_PROMOTER') NOT NULL;

ALTER TABLE `staff_invitations`
  MODIFY COLUMN `role` enum('ADMIN','MANAGER','BARTENDER','SECURITY','PROMOTER','GENERAL_PROMOTER') NOT NULL;

ALTER TABLE `promoters`
  ADD COLUMN `owner_staff_id` varchar(36) NULL,
  ADD CONSTRAINT `promoters_owner_staff_id_staff_id_fk`
    FOREIGN KEY (`owner_staff_id`) REFERENCES `staff`(`id`) ON DELETE no action ON UPDATE no action;

CREATE INDEX `promoters_owner_staff_id_idx` ON `promoters` (`owner_staff_id`);
