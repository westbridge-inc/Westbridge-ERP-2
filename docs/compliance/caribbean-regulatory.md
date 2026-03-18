# Caribbean Regulatory Compliance

**Document ID:** CRC-001
**Version:** 1.0
**Effective Date:** 2026-03-18
**Owner:** CISO
**Classification:** Internal

---

## 1. GRA (Guyana Revenue Authority) Compliance

### 1.1 Tax Requirements

| Obligation           | Requirement                              | Platform Implementation                                                             |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| **VAT Registration** | Businesses above threshold must register | Account model supports TIN storage; validation via `src/lib/caribbean/constants.ts` |
| **VAT Rate**         | 14% standard rate                        | Implemented in `GUYANA_VAT_RATE = 0.14` (`src/lib/caribbean/constants.ts`)          |
| **VAT Filing**       | Monthly/quarterly returns                | Invoice and expense tracking in ERPNext with VAT calculation                        |
| **Record Retention** | 7 years minimum                          | `GRA_RETENTION_YEARS = 7` in constants; audit log retention configured accordingly  |
| **Digital Invoices** | Must contain TIN, date, itemization, VAT | ERPNext Sales Invoice doctype enforces required fields                              |

### 1.2 TIN Validation

GRA Taxpayer Identification Numbers are validated using the check-digit algorithm implemented in `src/lib/caribbean/constants.ts`. The platform validates TIN format on input but does not verify against GRA's live database.

### 1.3 Record Retention

Per GRA requirements, all financial records are retained for a minimum of 7 years:

- Audit logs: hash-chained (`src/lib/services/audit.service.ts`) with `onDelete: Restrict` to prevent accidental deletion
- ERPNext documents: retained in ERPNext database with backup per `docs/runbooks/database-backup.md`
- Billing invoices: stored in PostgreSQL with soft-delete protection

---

## 2. NIS (National Insurance Scheme) Compliance

### 2.1 Contribution Rates

| Parameter                      | Value             | Source               |
| ------------------------------ | ----------------- | -------------------- |
| **Employer Rate**              | 8.8%              | NIS Act              |
| **Employee Rate**              | 5.6%              | NIS Act              |
| **Insurable Earnings Ceiling** | GYD 280,000/month | NIS current schedule |
| **Minimum Insurable Earnings** | GYD 20,000/month  | NIS current schedule |

All rates are codified in `src/lib/caribbean/constants.ts` and used by the NIS calculation engine in `src/lib/caribbean/nis.ts`.

### 2.2 Employer Obligations

- Monthly contribution remittance within 14 days of month end
- Employee registration within 7 days of hiring
- Record retention: 6 years (`NIS_RETENTION_YEARS = 6`)

### 2.3 Platform Implementation

- Payroll module calculates NIS contributions with ceiling cap
- Employee records in ERPNext HR module
- NIS contribution reports via reporting engine

---

## 3. PAYE (Pay-As-You-Earn) Compliance

### 3.1 Tax Brackets

| Income Band             | Rate           | Implementation                            |
| ----------------------- | -------------- | ----------------------------------------- |
| Up to GYD 780,000/year  | 0% (threshold) | `PAYE_THRESHOLD = 780_000`                |
| GYD 780,001 - 1,560,000 | 28%            | First bracket in progressive calculation  |
| Above GYD 1,560,000     | 40%            | Second bracket in progressive calculation |

### 3.2 Platform Implementation

- PAYE calculation engine: `src/lib/caribbean/paye.ts`
- Progressive tax calculation with proper bracket handling
- Monthly withholding = annual liability / 12
- Full test coverage in `src/lib/caribbean/__tests__/`

---

## 4. CARICOM Data Protection

### 4.1 Applicable Regulations

| Jurisdiction      | Legislation              | Status |
| ----------------- | ------------------------ | ------ |
| Guyana            | Data Protection Act 2023 | Active |
| Trinidad & Tobago | Data Protection Act 2011 | Active |
| Jamaica           | Data Protection Act 2020 | Active |
| Barbados          | Data Protection Act 2019 | Active |

### 4.2 Key Requirements

1. **Lawful Basis for Processing**: The platform processes personal data under contractual necessity (service delivery) and legitimate interest (security monitoring)
2. **Data Minimization**: Only necessary PII collected; fields annotated with `/// @pii` in Prisma schema
3. **Breach Notification**: 72-hour notification requirement; covered by incident response runbook (`docs/runbooks/incident-response.md`)
4. **Data Subject Rights**: GDPR-style data export endpoint (`/api/v1/admin/gdpr-export/:userId`)
5. **Cross-Border Transfer**: Data processed in AWS/Railway infrastructure; DPA agreements with vendors

### 4.3 Platform Mitigations

| Requirement        | Implementation                                                         |
| ------------------ | ---------------------------------------------------------------------- |
| PII identification | `/// @pii` annotations in Prisma schema                                |
| PII encryption     | AES-256-GCM for sensitive fields (`src/lib/encryption.ts`)             |
| Access control     | RBAC with 34 permissions (`src/lib/rbac.ts`)                           |
| Audit trail        | Hash-chained audit logs with IP anonymization                          |
| Data retention     | Configurable per data type (`src/lib/data-retention.ts`)               |
| Breach detection   | Security monitoring with Sentry alerts (`src/lib/security-monitor.ts`) |
| Consent management | Cookie consent (partial — tracked for completion)                      |

---

## 5. Compliance Matrix

| Regulation             | Requirement                          | Status   | Evidence                                         |
| ---------------------- | ------------------------------------ | -------- | ------------------------------------------------ |
| GRA VAT 14%            | Correct rate applied                 | In Place | `src/lib/caribbean/constants.ts`, test coverage  |
| GRA 7-year retention   | Financial records preserved          | In Place | `onDelete: Restrict` on AuditLog, backup runbook |
| GRA TIN validation     | Valid TIN format enforced            | In Place | Validation function in caribbean module          |
| NIS contribution rates | Correct employer/employee rates      | In Place | Constants + calculation engine + tests           |
| NIS ceiling cap        | Ceiling applied to contributions     | In Place | `src/lib/caribbean/nis.ts` with tests            |
| PAYE brackets          | Progressive tax correctly calculated | In Place | `src/lib/caribbean/paye.ts` with tests           |
| Data protection        | PII encrypted, access controlled     | In Place | AES-256-GCM, RBAC, audit logging                 |
| Breach notification    | 72-hour process documented           | In Place | Incident response runbook                        |

---

## 6. Review Schedule

- **Quarterly**: Review GRA/NIS rate updates
- **Annually**: Full compliance review against current legislation
- **On change**: Update whenever tax rates or regulations change

| Role | Name          | Date       |
| ---- | ------------- | ---------- |
| CISO | Mayur Goswami | 2026-03-18 |
| CTO  | Mayur Goswami | 2026-03-18 |
