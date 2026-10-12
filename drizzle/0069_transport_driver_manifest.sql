-- Private shareable passenger manifest, created only when an admin requests a link.
ALTER TABLE event_transports
  ADD COLUMN driver_manifest_token varchar(64) NULL,
  ADD UNIQUE INDEX event_transports_driver_manifest_token_unique (driver_manifest_token);
