-- P0: Convert BillingInvoice.amount from double precision (Float) to numeric(10,2) (Decimal)
-- Financial data must never use floating-point storage (IEEE 754: 0.1 + 0.2 !== 0.3)
ALTER TABLE billing_invoices ALTER COLUMN amount TYPE NUMERIC(10,2);
