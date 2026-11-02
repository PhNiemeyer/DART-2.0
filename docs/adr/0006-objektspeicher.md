# ADR-0006: S3-kompatibler Objektspeicher (SeaweedFS lokal)

Status: angenommen · Datum: 02.11.2026

Der Vault speichert Dokumente über die AWS-S3-API. Lokal wird **SeaweedFS 3.97** verwendet, weil das MinIO-Image in der Entwicklungsumgebung
nicht bezogen werden konnte; SeaweedFS ist S3-kompatibel und quelloffen. Der Speicher ist privat (keine öffentlichen URLs, unauthentisches
Listen liefert 403). Dateien werden **vor** dem Speichern mit AES-256-GCM verschlüsselt (Schlüssel im Vault, nicht im Speicher).
Downloads erfolgen nur über autorisierte API-Endpunkte (Rechteprüfung, Audit, `Cache-Control: no-store`).
Für die Entwicklung ohne Docker gibt es einen lokalen Dateispeicher-Adapter; in Produktion wird dieser verweigert.
Produktiv: EU/EWR-Speicher mit serverseitiger Verschlüsselung, Versionierung und Backup (Entscheidung E-08).
