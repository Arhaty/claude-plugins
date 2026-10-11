# Auth

**Status.** accepted in part (rate limits proposed)

**Covers.** sign-in, sessions, passwords, rate limiting, 429, Retry-After, account enumeration

**In one line.** Email and password sign-in with server sessions; failed attempts are rate-limited
per account and per IP.

## How it works

- **Sessions are server-side, in Redis, keyed by an opaque cookie.** Nothing about the user is in
  the cookie.
- **Passwords are hashed with argon2id at the library defaults.**
- **A sign-in response never says whether the account exists.** Wrong email and wrong password
  return the same body and status.
- **Failed sign-ins are limited to 5 per account and 20 per IP address per 15-minute fixed
  window.** The IP limit stops one address spraying guesses across many accounts.
- **A limited request gets `429` with `Retry-After` in seconds**, and the same body whether or not
  the account exists.
- **Only failures count; a success neither counts nor resets.** Resetting on success would let an
  attacker who owns one account clear the IP counter.
- **The limiter fails open when Redis is unavailable, and logs.** An outage must not stop every
  sign-in.
- **Rate-limit keys hold a SHA-256 of the normalised email, never the address.**

## Not decided

- **Lockout notification by email.** Blocks nothing; lands in a spec when support asks for it.

## Rejected

- Sliding window — fairer at the boundary, but needs a sorted set per key; the fixed window's
  worst case is acceptable.
- CAPTCHA after three failures — adds a third-party script to the sign-in page.

## Log

- 2026-10-02 — Added rate limits on failed sign-ins (spec 012).
- 2026-08-14 — Accepted sessions, hashing and enumeration rules.
