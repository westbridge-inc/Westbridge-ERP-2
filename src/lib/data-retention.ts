export const DATA_RETENTION = {
  AUDIT_LOGS_DAYS: 365, // 1 year minimum for SOC 2
  SESSIONS_EXPIRED_DAYS: 30, // Clean up expired sessions after 30 days
  // Hard-delete soft-deleted accounts after 30 days. Aligned with the
  // published Privacy Policy promise: "After the 30-day period, Customer
  // Data is permanently deleted from our production systems and purged
  // from backups within 90 days." (compliance review)
  SOFT_DELETED_DAYS: 30,
} as const;
