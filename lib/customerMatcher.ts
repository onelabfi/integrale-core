/**
 * Customer Matching
 * Creates consistent customer IDs across HubSpot and Stripe
 * by normalizing company identifiers (email domain, company name, domain).
 */

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function emailToDomain(email: string): string {
  const parts = email.split("@");
  return (parts[1] || email).toLowerCase().replace(/^www\./, "");
}

/**
 * Generate a deterministic customer_id from company identifiers.
 * Both HubSpot and Stripe connectors use this so IDs match across systems.
 */
export function normalizeCustomerId(
  email?: string | null,
  companyName?: string | null,
  domain?: string | null
): string {
  // Priority: email domain > explicit domain > company name
  if (email) return `cust-${emailToDomain(email)}`;
  if (domain) return `cust-${domain.toLowerCase().replace(/^www\./, "")}`;
  if (companyName) return `cust-${slugify(companyName)}`;
  return `cust-unknown-${Date.now()}`;
}

/**
 * Build a lookup map from multiple identifiers for fuzzy matching.
 * Used to match Stripe customers to HubSpot companies.
 */
export function buildCustomerLookup(
  entries: Array<{
    customer_id: string;
    email?: string | null;
    company?: string | null;
    domain?: string | null;
  }>
): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const entry of entries) {
    if (entry.email) {
      lookup.set(emailToDomain(entry.email), entry.customer_id);
    }
    if (entry.domain) {
      lookup.set(entry.domain.toLowerCase().replace(/^www\./, ""), entry.customer_id);
    }
    if (entry.company) {
      lookup.set(slugify(entry.company), entry.customer_id);
    }
  }
  return lookup;
}
