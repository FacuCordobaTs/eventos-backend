-- Barra fijada a una computadora desde el QR de vinculación de equipo.
--
-- Sobre un vínculo de POS (`requested_access = 'pos'`), quien lo aprueba desde el teléfono puede
-- además decir cuál barra ES esa computadora. El POS la trata como un turno fijado: la guarda en el
-- dispositivo y la conserva hasta que se reasigne con otro QR.
--
-- `assigned_bar_id` no lleva FK a `bars` a propósito: las barras se borran físicamente junto con su
-- evento (DELETE /events/:id) y agregar una FK obligaría a limpiar esta tabla dentro de esa
-- transacción. El puntero sólo importa durante el handshake (5 minutos): el claim re-resuelve la
-- barra contra el tenant de quien aprobó y, si ya no existe, la computadora se libera sola.
--
-- `assignment_decided` separa "quien aprobó decidió el destino de la barra" (aunque fuera no
-- asignar) de "no tenía potestad o no la eligió". Default FALSE: las filas y los clientes previos
-- conservan exactamente el comportamiento anterior (no tocar la fijación del equipo).
-- Aplicar antes de desplegar el backend.
ALTER TABLE `staff_device_links`
  ADD COLUMN `assigned_bar_id` varchar(36) NULL,
  ADD COLUMN `assignment_decided` boolean NOT NULL DEFAULT FALSE;
