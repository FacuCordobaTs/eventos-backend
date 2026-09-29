-- Descripción pública del evento: texto libre y opcional que la página de venta de entradas
-- muestra debajo del nombre. Columna aditiva y nullable; los eventos existentes quedan sin
-- descripción (NULL) hasta que se edite desde la sección "Página" del admin.
ALTER TABLE `events` ADD `description` varchar(500);
