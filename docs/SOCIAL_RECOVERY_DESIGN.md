# Social recovery: redesign

Status: **implemented** (backend, web; mobile screens pending). Decisions: 48-hour time lock, AWS SES for email. Proof: `npm run drill:social-recovery`.

The previous implementation was disabled
(`ENABLE_SOCIAL_RECOVERY`) because the account owner could verify and
approve their own guardians, recovery required the very session a
locked-out user has lost, and "completing" recovery restored nothing.

## What recovery means here

OpenPrivy is custodial: the server holds each user's keys, bound to their
account. A user who loses their sign-in (email account gone, SSO removed,
phone lost) has not lost their keys; they have lost the account the keys
are bound to. **Recovery moves the custodial wallets from the old account
to a new account the user controls**, once enough trusted people vouch for
it and the old account had time to object.

## Roles

- **Owner**: the signed-in user who sets up recovery in advance.
- **Guardian**: someone the owner trusts, identified by email. Guardians do
  not need an OpenPrivy account; they act through single-use email links.
- **Requester**: the person claiming to be the owner, signed in with a
  new account.

## Flow

### 1. Setup (owner, signed in)
1. Owner adds 3–5 guardians by name and email. Threshold: a majority
   (2 of 3, 3 of 4 or 5).
2. Each guardian gets an email with a single-use link (expires in 7 days)
   and confirms by opening it. **The owner never sees the link or its
   token**; only the guardian's inbox does. The API never returns tokens.
3. Recovery becomes available once enough guardians to meet the threshold
   have confirmed.

### 2. Request (requester, signed in with a new account)
1. Requester enters the old account's email and starts a request.
   The response is the same whether or not that account exists or has
   recovery set up, so the endpoint can't be used to probe accounts.
2. Each confirmed guardian of the old account gets an email: who is asking
   (the new account's email), when, and approve / decline links.
3. The old account's email and any open sessions are notified at once,
   with a one-click **cancel** link.

### 3. Approval (guardians)
- Each guardian approves or declines through their own single-use link.
- Any decline cancels the request.
- Approvals cannot come from the requester's own email.

### 4. Time lock
- When the threshold is met, a **waiting period** starts. The old account
  is notified again and can cancel with one click, or by signing in.
- Signing in to the old account during the wait cancels the request
  automatically: a person with access is not locked out.

### 5. Completion
- After the wait, the request completes automatically. Each wallet moves
  to the new account in one database transaction:
  - software wallets: decrypted under the old account's per-user key,
    re-encrypted under the new one (same machinery as key rotation), and
    each verified to still derive its address before saving;
  - HSM wallets: ownership reassigned; the key never moves.
- The old account is locked, its sessions revoked, and its guardians
  cleared (the new owner sets up their own).
- Every step is recorded in the audit log.

## Abuse limits
- One open request per old account; a cancelled or declined request blocks
  new ones for 24 hours.
- Rate limits on starting requests (per IP and per requester).
- Guardian changes need the guardian's own confirmation; removing a
  guardian is immediate.
- Tokens are random 256-bit values, stored hashed, single use, and
  compared in constant time.
- Sanctions screening is unchanged: recovered wallets send under the same
  checks.

## Email
A small notifier interface with two implementations: the production email
provider, and an in-memory outbox for tests (refuses to start in
production). Links and tokens are never logged.

## Testing
- Unit tests for each state transition and every refusal above.
- A recovery drill over real HTTP and Postgres, in CI: owner sets up
  guardians, loses access, requester recovers, wallets sign from the new
  account with their original addresses; plus negative runs (owner cancels,
  guardian declines, insufficient approvals, requester tries to self-approve).
