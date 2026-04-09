# Vendor Management Policy

**Document ID:** VMP-001
**Version:** 1.0
**Effective Date:** 2026-04-09
**Owner:** CISO
**Classification:** Internal

> SOC 2 Trust Service Criteria mapped: CC9.2

---

## 1. Purpose

This policy defines how Westbridge selects, onboards, monitors, and offboards vendors and sub-processors that have access to Westbridge customer data or production infrastructure.

## 2. Scope

Applies to any third party that:

- Stores, processes, or transmits Westbridge customer data
- Has API or console access to Westbridge production infrastructure
- Provides software, libraries, or services that run inside the Westbridge production environment

The current vendor inventory is maintained in `subprocessor-list.md`.

## 3. Vendor Selection Criteria

Before selecting a new vendor, the CISO and engineering lead jointly evaluate:

| Criterion                 | Minimum requirement                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Security certifications   | SOC 2 Type 2, ISO 27001, or equivalent — preferred but not always required (e.g., for early-stage tooling)        |
| Data Processing Agreement | Vendor must offer a DPA OR be willing to sign Westbridge's DPA                                                    |
| Sub-processor disclosure  | Vendor publishes a current list of its own sub-processors                                                         |
| Breach notification       | Contractual commitment to notify within ≤72 hours                                                                 |
| Encryption                | Data in transit (TLS 1.2+) and at rest (AES-256 or equivalent)                                                    |
| Authentication            | MFA available for all vendor console accounts                                                                     |
| Geographic data residency | If processing EU customer data, the vendor must have an EU region or have signed SCCs Module 2 + UK IDTA addendum |
| Operational maturity      | Public status page, documented incident response                                                                  |

Vendors that fail one or more criteria can still be selected if a compensating control is documented in writing by the CISO.

## 4. Onboarding Procedure

For each new vendor:

1. **Threat model.** Document what data the vendor will see, what access they will have, and what the worst-case breach impact is. Store in `docs/compliance/vendor-onboarding/<vendor>-<YYYY>.md`.
2. **Contract.** Sign the vendor's MSA + DPA. Store countersigned PDFs in a secure location (NOT in the git repo).
3. **Add to sub-processor list.** Update `docs/policies/subprocessor-list.md` and announce the change to customers via the changelog and trust page (per the Privacy Policy commitment to advance notice of sub-processor changes).
4. **Provision MFA.** Create the Westbridge account on the vendor console with MFA enabled.
5. **Scope credentials.** Use the most-restricted API key the vendor offers. Store the key as a Fly.io secret with a name that includes the vendor name (e.g., `RESEND_API_KEY`).
6. **Test the integration.** End-to-end test in staging before production rollout.
7. **Document the integration.** Where in the codebase does it live? Which env vars does it consume? Who owns the relationship?

## 5. Ongoing Monitoring

| Activity                                        | Frequency                               | Owner            |
| ----------------------------------------------- | --------------------------------------- | ---------------- |
| Review vendor's status page for incidents       | Weekly                                  | On-call engineer |
| Review vendor's security advisories / changelog | Monthly                                 | Engineering Lead |
| Review the sub-processor list for accuracy      | Quarterly                               | CISO             |
| Review vendor MFA enforcement                   | Quarterly                               | Engineering Lead |
| Renew vendor agreements                         | At contract expiry (typically annually) | CISO             |
| Re-assess vendor against §3 criteria            | Annually                                | CISO             |

Findings from each review go in `docs/compliance/vendor-reviews/<vendor>-<YYYY-Q>.md`.

## 6. Vendor Incident Response

If a vendor reports a security incident that may affect Westbridge customer data:

1. Within 1 business day of receiving the notification, the CISO triages the impact.
2. If customer data may have been exposed, Westbridge notifies affected customers within 72 hours (the contractual commitment in the DPA).
3. The incident is recorded in `docs/compliance/incidents/<YYYY-MM-DD>-<vendor>-<short>.md` and a post-mortem is published to affected customers.
4. The CISO evaluates whether to continue using the vendor; if not, an offboarding plan is created.

## 7. Offboarding Procedure

When a vendor relationship ends:

1. **Stop sending data.** Disable the integration in code and verify no traffic flows to the vendor (logs, metrics).
2. **Revoke credentials.** Delete API keys on the vendor console. Unset Fly.io secrets.
3. **Request data deletion.** Issue a written deletion request per the DPA. Document the response.
4. **Verify deletion.** Confirm via the vendor's deletion confirmation mechanism. Store the confirmation in `docs/compliance/vendor-offboarding/<vendor>-<YYYY-MM-DD>.md`.
5. **Update the sub-processor list.** Remove the vendor and announce the change to customers per the Privacy Policy.
6. **Final review.** Engineering lead reviews the codebase for any leftover references and removes them.

## 8. Open-source dependencies

Open-source libraries are not vendors per the strict definition (no contract, no human relationship), but they are subject to:

- Automated CVE scanning in CI (Snyk, npm audit, Dependabot)
- License compliance check (MIT, Apache 2.0, BSD, ISC, Unlicense allowed; GPL/AGPL evaluated case-by-case)
- Manual review before adding any new dependency that wraps cryptography, payment processing, or PII handling
- Pinning major versions to avoid surprise breaking changes

The current list of dependencies is in `package.json` for both repos. Dependency updates flow through Dependabot PRs.

## 9. Related

- Information Security Policy (`information-security-policy.md`)
- Sub-processor List (`subprocessor-list.md`)
- Data Classification Policy (`data-classification-policy.md`)
- DPA (`/dpa` on the marketing site)
- Privacy Policy (`/privacy` on the marketing site)
