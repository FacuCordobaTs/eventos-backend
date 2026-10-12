-- NULL keeps existing accounts on their current role. New/edited accounts store their full set.
ALTER TABLE staff ADD COLUMN roles JSON NULL;
