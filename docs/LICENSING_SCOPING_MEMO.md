# OpenPrivy — Licensing & Regulatory Scoping Memo

**For:** outside counsel, as a starting brief — not a substitute for legal
advice. Everything below states facts about the system as built and open
questions for counsel to answer; it does not draw legal conclusions.

## 1. What the platform does, in plain terms

OpenPrivy issues each user a blockchain wallet (Ethereum, Polygon, Solana)
without the user ever holding their own private key. Specifically:

- The **platform generates the private key**, encrypts it, and stores the
  ciphertext in its own database.
- The **platform decrypts the key and signs transactions on the user's
  behalf** when the user authorizes an action (e.g., "send funds").
- The user authenticates via WorkOS (SSO/email/MFA) or Supabase, not via
  possession of a key.
- There is an **account-abstraction layer** (ERC-4337) intended to let the
  platform sponsor gas fees, so users can transact without holding native gas
  tokens.
- There is a **social-recovery feature**: a user nominates guardians who can,
  collectively, help restore account access.
- **As currently built, there is no fiat on-ramp or off-ramp** — no path from
  a bank account or card to crypto, or back. This may change; flag if adding
  one is on the roadmap, since it materially changes the analysis (see §4).

## 2. The specific fact pattern that needs a legal answer

The platform **holds sole custody of user private keys** and **executes
transactions on the user's instruction**. This is functionally closer to a
custodial wallet provider / exchange than to a self-custody wallet app, even
though no fiat is involved yet.

Questions for counsel:

1. **Does this constitute "money transmission" or equivalent** in the
   jurisdiction(s) where we operate or plan to operate, given that the assets
   transmitted are cryptocurrency rather than fiat?
2. **Is a VASP/CASP (virtual asset / crypto-asset service provider)
   registration required**, and in which jurisdictions specifically? (Regimes
   worth confirming status in: FATF Travel-Rule-implementing jurisdictions
   generally; the EU's MiCA CASP authorization; U.S. state money-transmitter
   licenses plus FinCEN MSB registration; South Africa's FSCA crypto-asset
   service provider licensing regime, which became mandatory for CASPs in
   2023 — **flagging this one specifically because the project's own README
   originally described a South African target market; please confirm current
   go-to-market jurisdictions, since I'm inferring from repo history, not a
   current business decision**.)
3. **What KYC/AML/CDD obligations attach**, and at what onboarding or
   transaction-volume thresholds? Does wallet creation alone trigger them, or
   only a transaction of a certain size/type?
4. **Does the gas-sponsorship (paymaster) mechanism** — the platform paying
   gas on the user's behalf — have any independent regulatory characterization
   (e.g., as a form of value transfer by the platform itself)?
5. **How should the social-recovery guardian mechanism be characterized**?
   Guardians can collectively help restore access to funds they don't own —
   does this create any obligations toward guardians themselves, or does it
   affect the custody characterization of the primary account?
6. **Data residency / sovereignty**: infrastructure is AWS us-east-1 by
   default; does serving users in a given jurisdiction require in-region data
   storage, and does that affect the RDS/Secrets Manager region choice?
7. **Required disclosures and Terms of Service**: what must be disclosed to
   users about custodial risk (platform insolvency, key-compromise scenarios,
   no self-custody recourse) before onboarding?
8. **If a fiat on/off-ramp is added later** (not built yet, but plausible —
   see §1): confirm the PCI DSS posture separately. The technical plan is to
   route card data through a tokenizing processor (Stripe/Adyen-style) and
   never touch raw card data directly, to stay in SAQ-A PCI scope — but the
   money-transmission analysis above would need to be redone for fiat legs
   specifically.

## 3. What's already in place, for context (not a substitute for review)

- Private keys are encrypted at rest (AES-256-GCM, per-user derived keys) with
  the master key in AWS Secrets Manager — relevant to any "reasonable
  safeguards" or "commercially reasonable security" standard that applies.
- No independent security audit has been completed yet (see
  `docs/SECURITY_AUDIT_BRIEF.md` — in progress).
- SOC 2 is not yet certified; a realistic Type II timeline is 4–6 months once
  controls are formalized.

## 4. What we need back from counsel

- A jurisdiction-by-jurisdiction read on whether current or near-term
  operations require licensing/registration, and the realistic timeline/cost
  for each if so.
- Whether launching in a narrower initial jurisdiction (to reduce licensing
  surface) is advisable before a broader rollout.
- Draft or reviewed Terms of Service / custodial-risk disclosures before any
  public launch with real user funds.

---

*Confirm current target launch jurisdictions before sending this to counsel —
§2.2 above notes an assumption inferred from the repository's original README,
not a confirmed business decision.*
